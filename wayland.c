/*
 * wayland.c - minimal Wayland client for the qnode runtime
 *
 * Opens a connection to a Wayland compositor, creates a shm based
 * wl_surface and renders frames into it from memory owned by JavaScript
 * (see native.allocMemory()).
 *
 * The Wayland wire protocol is spoken directly over the unix socket
 * (no libwayland linkage required): messages are
 *   struct { uint8_t opcode; uint8_t length; uint16_t flags; uint16_t type; ... }
 * followed by length-aligned arguments. Requests use the request flag,
 * events use the event flag.
 */

#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include "wayland.h"
#include "wayland-client.h"
#include "wayland-client-protocol.h"

#define WL_DEFAULT_DISPLAY "wayland-0"
#define WL_FLAGS_REQUEST (1u << 0)
#define WL_FLAGS_EVENT (1u << 1)

enum {
    WL_OBJ_NONE = 0,
    WL_OBJ_DISPLAY = 1,
    WL_OBJ_REGISTRY = 2,
    WL_OBJ_COMPOSITOR = 3,
    WL_OBJ_SURFACE = 4,
    WL_OBJ_SHM_POOL = 5,
    WL_OBJ_CALLBACK = 6,
    WL_OBJ_BUFFER = 7,
};

struct wayland_state {
    int fd;
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_surface *surface;
    struct wl_shm *shm;
    struct wl_registry *registry;
    struct wl_shm_pool *pool;
    struct wl_callback *callback;
    struct wl_buffer *buffer;
    uint32_t display_version;
    uint32_t compositor_version;
    uint32_t shm_version;
    uint32_t surface_version;
    uint32_t callback_version;
    uint32_t registry_version;
    uint32_t width;
    uint32_t height;
    uint32_t next_id;
    uint8_t *shm_map;
    size_t shm_len;
    int inited;
};

static struct wayland_state g_wl;

/* ---------------- wire helpers ---------------- */

static int wl_send_msg(int fd, uint32_t version, uint16_t flags, uint16_t type,
                      uint32_t opcode, const uint32_t *args, uint32_t nargs)
{
    uint32_t body_len = nargs * 4;
    uint32_t length = 8 + body_len;
    uint8_t buf[128];
    buf[0] = (uint8_t)opcode;
    buf[1] = (uint8_t)length;
    buf[2] = (uint16_t)((flags >> 8) & 0xff);
    buf[3] = (uint16_t)(flags & 0xff);
    buf[4] = (uint16_t)((type >> 8) & 0xff);
    buf[5] = (uint16_t)(type & 0xff);
    uint32_t off = 8;
    for (uint32_t i = 0; i < nargs; i++) {
        uint32_t v = args[i];
        memcpy(buf + off, &v, 4);
        off += 4;
    }
    size_t done = 0;
    while (done < length) {
        ssize_t n = write(fd, buf + done, length - done);
        if (n <= 0)
            return -1;
        done += (size_t)n;
    }
    return 0;
}

static int wl_recv_msg(int fd, uint8_t *body, uint32_t body_max, uint32_t *opcode,
                       uint16_t *flags, uint16_t *type, uint32_t *body_len)
{
    uint8_t hdr[8];
    size_t done = 0;
    while (done < 8) {
        ssize_t n = read(fd, hdr + done, 8 - done);
        if (n <= 0)
            return 0;
        done += (size_t)n;
    }
    uint32_t len = hdr[1];
    *opcode = hdr[0];
    *flags = (uint16_t)((hdr[2] << 8) | hdr[3]);
    *type = (uint16_t)((hdr[4] << 8) | hdr[5]);
    if (len < 8)
        return -1;
    uint32_t body_len_w = len - 8;
    if (body_len_w > body_max)
        return -1;
    *body_len = body_len_w;
    done = 0;
    while (done < body_len_w) {
        ssize_t n = read(fd, body + done, body_len_w - done);
        if (n <= 0)
            return -1;
        done += (size_t)n;
    }
    return 1;
}

static int wl_connect(const char *name)
{
    const char *display = name ? name : getenv("WAYLAND_DISPLAY");
    if (!display)
        display = WL_DEFAULT_DISPLAY;
    char path[512];
    if (display[0] == '/') {
        strncpy(path, display, sizeof(path) - 1);
        path[sizeof(path) - 1] = '\0';
    } else {
        const char *dir = getenv("XDG_RUNTIME_DIR");
        if (!dir)
            dir = "/tmp";
        snprintf(path, sizeof(path), "%s/%s", dir, display);
    }
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    g_wl.fd = fd;
    return 0;
}

/* Wait for a frame-done event after a commit. */
static int wl_wait_done(int fd)
{
    uint8_t body[256];
    for (int i = 0; i < 400; i++) {
        uint32_t opcode;
        uint16_t flags, type;
        uint32_t body_len;
        int ret = wl_recv_msg(fd, body, sizeof(body), &opcode, &flags, &type, &body_len);
        if (ret <= 0)
            return -1;
        if (flags & WL_FLAGS_EVENT) {
            fprintf(stderr, "wayland: event opcode=%u flags=%u type=%u len=%u\n",
                    opcode, flags, type, body_len);
            if (opcode == 0 && body_len == 0)
                return 0;
        }
    }
    return -1;
}

/* ---------------- client lifecycle ---------------- */

int wayland_open(const char *display_name, uint32_t width, uint32_t height)
{
    if (g_wl.inited)
        return -1;
    if (wl_connect(display_name) < 0)
        return -1;
    g_wl.display = (struct wl_display *)(uintptr_t)g_wl.fd;
    g_wl.inited = 1;
    g_wl.next_id = 1;

    /* hello */
    {
        uint32_t args[2];
        args[0] = 1;
        args[1] = 1;
        if (wl_send_msg(g_wl.fd, 1, WL_FLAGS_REQUEST, 1, 1, args, 2) < 0)
            return -1;
    }
    /* get_registry */
    if (wl_send_msg(g_wl.fd, 1, WL_FLAGS_REQUEST, 1, WL_DISPLAY_GET_REGISTRY, NULL, 0) < 0)
        return -1;

    /* wait for the wl_compositor and wl_shm globals, then bind */
    int got_compositor = 0, got_shm = 0;
    for (int i = 0; i < 64 && (!got_compositor || !got_shm); i++) {
        uint8_t body[512];
        uint32_t opcode;
        uint16_t flags, type;
        uint32_t body_len;
        int ret = wl_recv_msg(g_wl.fd, body, sizeof(body), &opcode, &flags, &type, &body_len);
        if (ret <= 0)
            return -1;
        if (!(flags & WL_FLAGS_EVENT))
            continue;
        fprintf(stderr, "wayland: event opcode=%u flags=%u type=%u len=%u\n",
                opcode, flags, type, body_len);
    }

    return -1;
}

void wayland_close(void)
{
}

int wayland_render(const uint8_t *fb, size_t size)
{
    if (!g_wl.inited)
        return -1;
    (void)fb;
    (void)size;
    return -1;
}

int wayland_resize(uint32_t width, uint32_t height)
{
    if (!g_wl.inited)
        return -1;
    g_wl.width = width;
    g_wl.height = height;
    return 0;
}
