/*
 * wayland.c - minimal Wayland client for the qnode runtime
 *
 * Opens a connection to a Wayland compositor, creates an xdg-shell toplevel
 * window backed by a wl_shm buffer, and lets JavaScript paint straight into
 * the mapped buffer (see native.allocMemory()).
 *
 * The wire protocol is spoken directly over the unix socket: no libwayland
 * headers or linkage are used. Messages are laid out as
 *
 *   uint32_t object_id;
 *   uint16_t size;              // total bytes, header included
 *   uint16_t opcode;
 *   ... arguments ...
 *
 * with little-endian integers, strings stored as a uint32 length (including
 * the terminating NUL), the bytes, and padding to a multiple of four.
 */

#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>

#include "wayland.h"

#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif
#ifndef MAP_FAILED
#define MAP_FAILED ((void *)-1)
#endif

#define WL_DEFAULT_DISPLAY "wayland-0"

static int wl_debug_on(void)
{
    static int on = -1;
    if (on < 0)
        on = getenv("WAYLAND_DEBUG") ? 1 : 0;
    return on;
}

#define WL_DBG(...) do { if (wl_debug_on()) fprintf(stderr, "wayland: " __VA_ARGS__); } while (0)

#define WL_FLAG_REQUEST (1u << 0)
#define WL_FLAG_EVENT   (1u << 1)

/* wl_display */
#define WL_DISPLAY_SYNC         0
#define WL_DISPLAY_GET_REGISTRY 1
#define WL_DISPLAY_ERROR        0
#define WL_DISPLAY_DELETE_ID    1

/* wl_registry */
#define WL_REGISTRY_BIND        0
#define WL_REGISTRY_GLOBAL      0
#define WL_REGISTRY_GLOBAL_REMOVE 1

/* wl_compositor */
#define WL_COMPOSITOR_CREATE_SURFACE 0

/* wl_surface */
#define WL_SURFACE_ATTACH           1
#define WL_SURFACE_DAMAGE           2
#define WL_SURFACE_FRAME            3
#define WL_SURFACE_COMMIT           6
#define WL_SURFACE_SET_BUFFER_SCALE 8

/* wl_shm */
#define WL_SHM_CREATE_POOL 0
#define WL_SHM_FORMAT      0
#define WL_SHM_FORMAT_XRGB8888 1
#define WL_SHM_FORMAT_ARGB8888 0

/* wl_shm_pool */
#define WL_SHM_POOL_CREATE_BUFFER 0

/* wl_buffer */
#define WL_BUFFER_DESTROY 0
#define WL_BUFFER_RELEASE 0

/* xdg_wm_base */
#define XDG_WM_BASE_DESTROY          0
#define XDG_WM_BASE_GET_XDG_SURFACE  2
#define XDG_WM_BASE_PONG             3
#define XDG_WM_BASE_PING             0

/* xdg_surface */
#define XDG_SURFACE_GET_TOPLEVEL      1
#define XDG_SURFACE_SET_WIN_GEOMETRY  3
#define XDG_SURFACE_ACK_CONFIGURE     4
#define XDG_SURFACE_CONFIGURE         0

/* xdg_toplevel */
#define XDG_TOPLEVEL_SET_TITLE        2
#define XDG_TOPLEVEL_SET_APP_ID       3
#define XDG_TOPLEVEL_SET_MAX_SIZE     7
#define XDG_TOPLEVEL_SET_MIN_SIZE     8
#define XDG_TOPLEVEL_CONFIGURE        0
#define XDG_TOPLEVEL_CLOSE            1

/* wl_output */
#define WL_OUTPUT_GEOMETRY 0
#define WL_OUTPUT_MODE     1
#define WL_OUTPUT_DONE     2
#define WL_OUTPUT_SCALE    3
#define WL_OUTPUT_NAME     4

/* wl_callback */
#define WL_CALLBACK_DONE 0

#define MAX_OBJECT_ID 64

struct wl_state {
    int fd;
    uint32_t next_id;

    uint32_t registry_id;
    uint32_t compositor_id;
    uint32_t shm_id;
    uint32_t wm_base_id;
    uint32_t surface_id;
    uint32_t xdg_surface_id;
    uint32_t toplevel_id;
    uint32_t pool_id;
    uint32_t buffer_id;
    uint32_t output_id;

    uint32_t width;
    uint32_t height;
    uint32_t stride;

    uint8_t *shm;
    size_t shm_size;
    int shm_fd;

    int inited;
    int configured;
    int closed;
    int frame_done;
    int exposed;

    uint32_t pending_width;
    uint32_t pending_height;

    /* Cached monitor description, filled from wl_output events. */
    int have_output;
    int out_x, out_y;
    int out_physical_width, out_physical_height;
    int out_width, out_height;
    int out_refresh;
    int out_scale;
    int out_transform;
    char out_make[64];
    char out_model[64];

    /* Receive buffer for partially read messages. */
    uint8_t rx[4096];
    size_t rx_len;
};

static struct wl_state g_wl;

/* ---------------- wire encoding ---------------- */

struct wl_msg {
    uint8_t *data;
    size_t len;
    size_t cap;
};

static void msg_init(struct wl_msg *m, uint32_t object, uint16_t opcode)
{
    m->cap = 64;
    m->len = 8;
    m->data = malloc(m->cap);
    memset(m->data, 0, 8);
    /* The object id goes out immediately; size and opcode are filled in by
     * msg_send() once all arguments are known. */
    memcpy(m->data, &object, 4);
}

static void msg_reserve(struct wl_msg *m, size_t extra)
{
    if (m->len + extra <= m->cap)
        return;
    while (m->len + extra > m->cap)
        m->cap *= 2;
    m->data = realloc(m->data, m->cap);
}

static void msg_u32(struct wl_msg *m, uint32_t v)
{
    msg_reserve(m, 4);
    memcpy(m->data + m->len, &v, 4);
    m->len += 4;
}

static void msg_i32(struct wl_msg *m, int32_t v)
{
    msg_u32(m, (uint32_t)v);
}

static void msg_str(struct wl_msg *m, const char *s)
{
    if (!s)
        s = "";
    uint32_t len = (uint32_t)strlen(s) + 1;
    msg_u32(m, len);
    size_t padded = (len + 3) & ~3u;
    msg_reserve(m, padded);
    memset(m->data + m->len, 0, padded);
    memcpy(m->data + m->len, s, len - 1);
    m->len += padded;
}

static void msg_new_id(struct wl_msg *m, uint32_t id)
{
    msg_u32(m, id);
}

/* Send one message, optionally passing a file descriptor (wl_shm pool). */
static int msg_send_fd(struct wl_msg *m, uint32_t object, uint16_t opcode,
                       int passed_fd)
{
    (void)object;
    m->data[4] = (uint8_t)(opcode & 0xff);
    m->data[5] = (uint8_t)((opcode >> 8) & 0xff);
    m->data[6] = (uint8_t)(m->len & 0xff);
    m->data[7] = (uint8_t)((m->len >> 8) & 0xff);

    if (wl_debug_on()) {
        fprintf(stderr, "wayland: send obj=%u op=%u len=%zu:", object, opcode, m->len);
        for (size_t i = 0; i < m->len; i++)
            fprintf(stderr, " %02x", m->data[i]);
        fprintf(stderr, "\n");
    }
    if (passed_fd < 0) {
        size_t done = 0;
        while (done < m->len) {
            ssize_t n = write(g_wl.fd, m->data + done, m->len - done);
            if (n <= 0) {
                free(m->data);
                return -1;
            }
            done += (size_t)n;
        }
    } else {
        struct msghdr msg;
        struct iovec iov;
        char cbuf[CMSG_SPACE(sizeof(int))];
        memset(&msg, 0, sizeof(msg));
        memset(cbuf, 0, sizeof(cbuf));
        iov.iov_base = m->data;
        iov.iov_len = m->len;
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf;
        msg.msg_controllen = sizeof(cbuf);
        struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
        cmsg->cmsg_level = SOL_SOCKET;
        cmsg->cmsg_type = SCM_RIGHTS;
        cmsg->cmsg_len = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(cmsg), &passed_fd, sizeof(int));
        ssize_t n = sendmsg(g_wl.fd, &msg, 0);
        if (n < 0 || (size_t)n != m->len) {
            free(m->data);
            return -1;
        }
    }
    free(m->data);
    m->data = NULL;
    m->len = 0;
    m->cap = 0;
    return 0;
}

static int msg_send(struct wl_msg *m, uint32_t object, uint16_t opcode)
{
    return msg_send_fd(m, object, opcode, -1);
}

/* ---------------- object id allocation ---------------- */

static uint32_t new_id(void)
{
    return g_wl.next_id++;
}

/* ---------------- argument decoding ---------------- */

struct wl_reader {
    const uint8_t *p;
    size_t len;
    size_t off;
};

static uint32_t rd_u32(struct wl_reader *r)
{
    uint32_t v = 0;
    if (r->off + 4 <= r->len)
        memcpy(&v, r->p + r->off, 4);
    r->off += 4;
    return v;
}

static int32_t rd_i32(struct wl_reader *r)
{
    return (int32_t)rd_u32(r);
}

/* Copy a wire string into out (always NUL terminated) and return its length. */
static size_t rd_str(struct wl_reader *r, char *out, size_t cap)
{
    uint32_t len = rd_u32(r);
    size_t n = 0;
    if (len > 0 && r->off < r->len) {
        n = len - 1;
        if (n >= cap)
            n = cap - 1;
        memcpy(out, r->p + r->off, n);
        if (n < cap)
            out[n] = '\0';
    } else if (cap > 0) {
        out[0] = '\0';
    }
    r->off += (len + 3) & ~3u;
    return n;
}

/* ---------------- binding ---------------- */

static void bind_global(uint32_t name, const char *interface, uint32_t version)
{
    uint32_t id;
    uint32_t want;
    uint32_t *slot = NULL;

    if (strcmp(interface, "wl_compositor") == 0) {
        if (g_wl.compositor_id)
            return;
        want = version < 4 ? version : 4;
        id = new_id();
        slot = &g_wl.compositor_id;
    } else if (strcmp(interface, "wl_shm") == 0) {
        if (g_wl.shm_id)
            return;
        want = 1;
        id = new_id();
        slot = &g_wl.shm_id;
    } else if (strcmp(interface, "xdg_wm_base") == 0) {
        if (g_wl.wm_base_id)
            return;
        want = version < 6 ? version : 6;
        id = new_id();
        slot = &g_wl.wm_base_id;
    } else if (strcmp(interface, "wl_output") == 0) {
        if (g_wl.output_id)
            return;
        want = version < 2 ? version : 2;
        id = new_id();
        slot = &g_wl.output_id;
    } else {
        return;
    }

    struct wl_msg m;
    msg_init(&m, g_wl.registry_id, WL_REGISTRY_BIND);
    msg_u32(&m, name);
    msg_str(&m, interface);
    msg_u32(&m, want);
    msg_new_id(&m, id);
    msg_send(&m, g_wl.registry_id, WL_REGISTRY_BIND);
    WL_DBG("bind %s name=%u version=%u id=%u\n", interface, name, want, id);
    *slot = id;
}

/* ---------------- event dispatch ---------------- */

static void handle_xdg_toplevel(struct wl_reader *r, uint16_t opcode)
{
    if (opcode == XDG_TOPLEVEL_CONFIGURE) {
        int32_t w = rd_i32(r);
        int32_t h = rd_i32(r);
        uint32_t nstates = rd_u32(r);
        for (uint32_t i = 0; i < nstates; i++)
            rd_u32(r);
        if (w > 0)
            g_wl.pending_width = (uint32_t)w;
        if (h > 0)
            g_wl.pending_height = (uint32_t)h;
    } else if (opcode == XDG_TOPLEVEL_CLOSE) {
        g_wl.closed = 1;
    }
}

static void handle_event(uint32_t object, uint16_t opcode, struct wl_reader *r)
{
    WL_DBG("event object=%u opcode=%u len=%zu\n", object, opcode, r->len);
    if (object == 1) { /* wl_display */
        if (opcode == WL_DISPLAY_ERROR) {
            uint32_t bad = rd_u32(r);
            uint32_t code = rd_u32(r);
            char text[256];
            rd_str(r, text, sizeof(text));
            fprintf(stderr, "wayland: protocol error object=%u code=%u: %s\n",
                    bad, code, text);
            g_wl.closed = 1;
        } else if (opcode == WL_DISPLAY_DELETE_ID) {
            rd_u32(r);
        }
    } else if (object == g_wl.registry_id) {
        if (opcode == WL_REGISTRY_GLOBAL) {
            uint32_t name = rd_u32(r);
            char iface[128];
            rd_str(r, iface, sizeof(iface));
            uint32_t version = rd_u32(r);
            bind_global(name, iface, version);
        }
    } else if (object == g_wl.shm_id) {
        if (opcode == WL_SHM_FORMAT)
            rd_u32(r);
    } else if (object == g_wl.wm_base_id) {
        if (opcode == XDG_WM_BASE_PING) {
            uint32_t serial = rd_u32(r);
            struct wl_msg m;
            msg_init(&m, g_wl.wm_base_id, XDG_WM_BASE_PONG);
            msg_u32(&m, serial);
            msg_send(&m, g_wl.wm_base_id, XDG_WM_BASE_PONG);
        }
    } else if (object == g_wl.xdg_surface_id) {
        if (opcode == XDG_SURFACE_CONFIGURE) {
            uint32_t serial = rd_u32(r);
            struct wl_msg m;
            msg_init(&m, g_wl.xdg_surface_id, XDG_SURFACE_ACK_CONFIGURE);
            msg_u32(&m, serial);
            msg_send(&m, g_wl.xdg_surface_id, XDG_SURFACE_ACK_CONFIGURE);
            g_wl.configured = 1;
        }
    } else if (object == g_wl.toplevel_id) {
        handle_xdg_toplevel(r, opcode);
    } else if (object == g_wl.output_id) {
        if (opcode == WL_OUTPUT_GEOMETRY) {
            g_wl.out_x = rd_i32(r);
            g_wl.out_y = rd_i32(r);
            g_wl.out_physical_width = rd_i32(r);
            g_wl.out_physical_height = rd_i32(r);
            rd_i32(r); /* subpixel */
            rd_str(r, g_wl.out_make, sizeof(g_wl.out_make));
            rd_str(r, g_wl.out_model, sizeof(g_wl.out_model));
            g_wl.out_transform = rd_i32(r);
            g_wl.have_output = 1;
        } else if (opcode == WL_OUTPUT_MODE) {
            rd_u32(r); /* flags */
            g_wl.out_width = (int)rd_u32(r);
            g_wl.out_height = (int)rd_u32(r);
            g_wl.out_refresh = (int)rd_u32(r);
        } else if (opcode == WL_OUTPUT_SCALE) {
            g_wl.out_scale = (int)rd_u32(r);
        } else if (opcode == WL_OUTPUT_NAME) {
            char name[64];
            rd_str(r, name, sizeof(name));
        }
    } else if (object != 0) {
        /* Frame callbacks (and other one-shot objects) only report done. */
        if (opcode == WL_CALLBACK_DONE && object != g_wl.buffer_id) {
            rd_u32(r);
            g_wl.frame_done = 1;
        }
    }
    (void)WL_FLAG_EVENT;
}

/* Parse every complete message in the receive buffer. */
static void drain_rx(void)
{
    size_t off = 0;
    while (g_wl.rx_len - off >= 8) {
        uint32_t object;
        uint16_t size, opcode;
        memcpy(&object, g_wl.rx + off, 4);
        memcpy(&opcode, g_wl.rx + off + 4, 2);
        memcpy(&size, g_wl.rx + off + 6, 2);
        if (size < 8 || off + size > g_wl.rx_len)
            break;
        struct wl_reader r;
        r.p = g_wl.rx + off + 8;
        r.len = (size_t)size - 8;
        r.off = 0;
        handle_event(object, opcode, &r);
        off += size;
    }
    if (off > 0) {
        memmove(g_wl.rx, g_wl.rx + off, g_wl.rx_len - off);
        g_wl.rx_len -= off;
    }
}

/*
 * Read and dispatch events. When block_ms < 0 this waits for at least one
 * message; otherwise it waits up to block_ms milliseconds. Returns the number
 * of bytes read, 0 on timeout, -1 when the connection is gone.
 */
static int dispatch(int block_ms)
{
    if (g_wl.fd < 0)
        return -1;
    if (block_ms >= 0) {
        struct pollfd pfd;
        pfd.fd = g_wl.fd;
        pfd.events = POLLIN;
        pfd.revents = 0;
        int pr = poll(&pfd, 1, block_ms);
        if (pr < 0) {
            if (errno == EINTR)
                return 0;
            return -1;
        }
        if (pr == 0)
            return 0;
    }
    for (;;) {
        if (g_wl.rx_len == sizeof(g_wl.rx))
            return -1;
        ssize_t n = read(g_wl.fd, g_wl.rx + g_wl.rx_len,
                         sizeof(g_wl.rx) - g_wl.rx_len);
        if (n < 0) {
            WL_DBG("read failed: %s\n", strerror(errno));
            if (errno == EINTR)
                continue;
            if (errno == EAGAIN)
                return 0;
            return -1;
        }
        if (n == 0) {
            WL_DBG("connection closed by compositor\n");
            return -1;
        }
        if (wl_debug_on()) {
            fprintf(stderr, "wayland: recv %zd bytes:", n);
            for (ssize_t i = 0; i < n && i < 32; i++)
                fprintf(stderr, " %02x", g_wl.rx[g_wl.rx_len + (size_t)i]);
            fprintf(stderr, "\n");
        }
        g_wl.rx_len += (size_t)n;
        drain_rx();
        return (int)n;
    }
}

/* ---------------- client lifecycle ---------------- */

static int wl_connect(const char *name)
{
    const char *display = name ? name : getenv("WAYLAND_DISPLAY");
    if (!display || !display[0])
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
    WL_DBG("connecting to %s\n", path);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        WL_DBG("connect failed: %s\n", strerror(errno));
        close(fd);
        return -1;
    }
    g_wl.fd = fd;
    return 0;
}

/* One full round trip: send a sync request and wait for its callback. */
static int roundtrip(void)
{
    uint32_t cb = new_id();
    struct wl_msg m;
    msg_init(&m, 1, WL_DISPLAY_SYNC);
    msg_new_id(&m, cb);
    if (msg_send(&m, 1, WL_DISPLAY_SYNC) < 0)
        return -1;
    for (int i = 0; i < 10000; i++) {
        int r = dispatch(1000);
        if (r < 0)
            return -1;
        if (g_wl.frame_done) {
            g_wl.frame_done = 0;
            return 0;
        }
    }
    return -1;
}

static int create_shm_buffer(uint32_t width, uint32_t height)
{
    if (g_wl.buffer_id) {
        struct wl_msg d;
        msg_init(&d, g_wl.buffer_id, WL_BUFFER_DESTROY);
        msg_send(&d, g_wl.buffer_id, WL_BUFFER_DESTROY);
        g_wl.buffer_id = 0;
    }
    if (g_wl.pool_id) {
        /* wl_shm_pool.destroy */
        struct wl_msg d;
        msg_init(&d, g_wl.pool_id, 1);
        msg_send(&d, g_wl.pool_id, 1);
        g_wl.pool_id = 0;
    }
    if (g_wl.shm) {
        munmap(g_wl.shm, g_wl.shm_size);
        g_wl.shm = NULL;
        g_wl.shm_size = 0;
    }
    if (g_wl.shm_fd >= 0) {
        close(g_wl.shm_fd);
        g_wl.shm_fd = -1;
    }

    g_wl.width = width;
    g_wl.height = height;
    g_wl.stride = width * 4;
    g_wl.shm_size = (size_t)g_wl.stride * height;

    int fd = memfd_create("qnode-shm", MFD_CLOEXEC);
    if (fd < 0)
        return -1;
    if (ftruncate(fd, (off_t)g_wl.shm_size) < 0) {
        close(fd);
        return -1;
    }
    void *map = mmap(NULL, g_wl.shm_size, PROT_READ | PROT_WRITE,
                     MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) {
        close(fd);
        return -1;
    }
    g_wl.shm_fd = fd;
    g_wl.shm = map;

    g_wl.pool_id = new_id();
    struct wl_msg m;
    msg_init(&m, g_wl.shm_id, WL_SHM_CREATE_POOL);
    msg_new_id(&m, g_wl.pool_id);
    msg_u32(&m, (uint32_t)g_wl.shm_size);
    if (msg_send_fd(&m, g_wl.shm_id, WL_SHM_CREATE_POOL, fd) < 0)
        return -1;

    g_wl.buffer_id = new_id();
    struct wl_msg b;
    msg_init(&b, g_wl.pool_id, WL_SHM_POOL_CREATE_BUFFER);
    msg_new_id(&b, g_wl.buffer_id);
    msg_u32(&b, 0); /* offset */
    msg_u32(&b, width);
    msg_u32(&b, height);
    msg_u32(&b, g_wl.stride);
    msg_u32(&b, WL_SHM_FORMAT_XRGB8888);
    return msg_send(&b, g_wl.pool_id, WL_SHM_POOL_CREATE_BUFFER);
}

int wayland_open(const char *display_name, uint32_t width, uint32_t height)
{
    if (g_wl.inited)
        return -1;
    if (width == 0 || height == 0)
        return -1;
    memset(&g_wl, 0, sizeof(g_wl));
    g_wl.fd = -1;
    g_wl.shm_fd = -1;
    g_wl.width = width;
    g_wl.height = height;
    g_wl.out_scale = 1;

    if (wl_connect(display_name) < 0)
        return -1;
    g_wl.inited = 1;
    g_wl.next_id = 2;

    g_wl.registry_id = new_id();
    struct wl_msg m;
    msg_init(&m, 1, WL_DISPLAY_GET_REGISTRY);
    msg_new_id(&m, g_wl.registry_id);
    if (msg_send(&m, 1, WL_DISPLAY_GET_REGISTRY) < 0)
        goto fail;

    if (roundtrip() < 0) {
        WL_DBG("first roundtrip failed\n");
        goto fail;
    }
    WL_DBG("globals compositor=%u shm=%u wm_base=%u output=%u\n",
           g_wl.compositor_id, g_wl.shm_id, g_wl.wm_base_id, g_wl.output_id);
    if (!g_wl.compositor_id || !g_wl.shm_id || !g_wl.wm_base_id) {
        fprintf(stderr, "wayland: missing compositor/shm/xdg_wm_base globals\n");
        goto fail;
    }

    /* Wait for the first output description to arrive. */
    for (int i = 0; i < 5 && !g_wl.have_output; i++) {
        if (dispatch(50) < 0)
            break;
    }

    g_wl.surface_id = new_id();
    struct wl_msg c;
    msg_init(&c, g_wl.compositor_id, WL_COMPOSITOR_CREATE_SURFACE);
    msg_new_id(&c, g_wl.surface_id);
    if (msg_send(&c, g_wl.compositor_id, WL_COMPOSITOR_CREATE_SURFACE) < 0)
        goto fail;

    g_wl.xdg_surface_id = new_id();
    struct wl_msg xs;
    msg_init(&xs, g_wl.wm_base_id, XDG_WM_BASE_GET_XDG_SURFACE);
    msg_new_id(&xs, g_wl.xdg_surface_id);
    msg_u32(&xs, g_wl.surface_id);
    if (msg_send(&xs, g_wl.wm_base_id, XDG_WM_BASE_GET_XDG_SURFACE) < 0)
        goto fail;

    g_wl.toplevel_id = new_id();
    struct wl_msg tl;
    msg_init(&tl, g_wl.xdg_surface_id, XDG_SURFACE_GET_TOPLEVEL);
    msg_new_id(&tl, g_wl.toplevel_id);
    if (msg_send(&tl, g_wl.xdg_surface_id, XDG_SURFACE_GET_TOPLEVEL) < 0)
        goto fail;

    struct wl_msg t;
    msg_init(&t, g_wl.toplevel_id, XDG_TOPLEVEL_SET_TITLE);
    msg_str(&t, "qnode");
    if (msg_send(&t, g_wl.toplevel_id, XDG_TOPLEVEL_SET_TITLE) < 0)
        goto fail;

    struct wl_msg a;
    msg_init(&a, g_wl.toplevel_id, XDG_TOPLEVEL_SET_APP_ID);
    msg_str(&a, "qnode");
    if (msg_send(&a, g_wl.toplevel_id, XDG_TOPLEVEL_SET_APP_ID) < 0)
        goto fail;

    /* Fixed size window: min == max. */
    struct wl_msg mx;
    msg_init(&mx, g_wl.toplevel_id, XDG_TOPLEVEL_SET_MAX_SIZE);
    msg_u32(&mx, width);
    msg_u32(&mx, height);
    if (msg_send(&mx, g_wl.toplevel_id, XDG_TOPLEVEL_SET_MAX_SIZE) < 0)
        goto fail;

    struct wl_msg mn;
    msg_init(&mn, g_wl.toplevel_id, XDG_TOPLEVEL_SET_MIN_SIZE);
    msg_u32(&mn, width);
    msg_u32(&mn, height);
    if (msg_send(&mn, g_wl.toplevel_id, XDG_TOPLEVEL_SET_MIN_SIZE) < 0)
        goto fail;

    if (create_shm_buffer(width, height) < 0)
        goto fail;

    /* Commit an empty surface so the compositor sends the first configure. */
    struct wl_msg commit;
    msg_init(&commit, g_wl.surface_id, WL_SURFACE_COMMIT);
    if (msg_send(&commit, g_wl.surface_id, WL_SURFACE_COMMIT) < 0)
        goto fail;

    for (int i = 0; i < 1000 && !g_wl.configured; i++) {
        if (dispatch(1000) < 0) {
            WL_DBG("dispatch failed waiting for configure\n");
            goto fail;
        }
    }
    WL_DBG("configured=%d pending=%ux%u\n", g_wl.configured,
           g_wl.pending_width, g_wl.pending_height);
    if (!g_wl.configured) {
        WL_DBG("no configure event\n");
        goto fail;
    }

    if (g_wl.pending_width && g_wl.pending_height &&
        (g_wl.pending_width != width || g_wl.pending_height != height)) {
        if (create_shm_buffer(g_wl.pending_width, g_wl.pending_height) < 0)
            goto fail;
    }

    /* Tell the compositor the window geometry (surface local coordinates). */
    struct wl_msg g;
    msg_init(&g, g_wl.xdg_surface_id, XDG_SURFACE_SET_WIN_GEOMETRY);
    msg_i32(&g, 0);
    msg_i32(&g, 0);
    msg_i32(&g, (int32_t)g_wl.width);
    msg_i32(&g, (int32_t)g_wl.height);
    if (msg_send(&g, g_wl.xdg_surface_id, XDG_SURFACE_SET_WIN_GEOMETRY) < 0)
        goto fail;

    struct wl_msg bs;
    msg_init(&bs, g_wl.surface_id, WL_SURFACE_SET_BUFFER_SCALE);
    msg_i32(&bs, 1);
    if (msg_send(&bs, g_wl.surface_id, WL_SURFACE_SET_BUFFER_SCALE) < 0)
        goto fail;

    /* Flush the setup requests. */
    if (dispatch(0) < 0)
        goto fail;
    return 0;

fail:
    wayland_close();
    return -1;
}

void wayland_close(void)
{
    if (g_wl.fd >= 0)
        close(g_wl.fd);
    if (g_wl.shm_fd >= 0)
        close(g_wl.shm_fd);
    if (g_wl.shm)
        munmap(g_wl.shm, g_wl.shm_size);
    g_wl.fd = -1;
    g_wl.shm_fd = -1;
    g_wl.shm = NULL;
    g_wl.inited = 0;
}

uint32_t wayland_width(void)
{
    return g_wl.width;
}

uint32_t wayland_height(void)
{
    return g_wl.height;
}

int wayland_output_scale(void)
{
    return g_wl.out_scale ? g_wl.out_scale : 1;
}

int wayland_fill_output(struct wayland_output *out)
{
    if (!out)
        return -1;
    memset(out, 0, sizeof(*out));
    out->have_output = g_wl.have_output;
    out->x = g_wl.out_x;
    out->y = g_wl.out_y;
    out->physical_width = g_wl.out_physical_width;
    out->physical_height = g_wl.out_physical_height;
    out->width = g_wl.out_width;
    out->height = g_wl.out_height;
    out->refresh = g_wl.out_refresh;
    out->scale = g_wl.out_scale ? g_wl.out_scale : 1;
    out->transform = g_wl.out_transform;
    strncpy(out->make, g_wl.out_make, sizeof(out->make) - 1);
    strncpy(out->model, g_wl.out_model, sizeof(out->model) - 1);
    return 0;
}

/* Copy a finished frame into the shared buffer and commit it. */
int wayland_render(const uint8_t *fb, size_t size)
{
    if (!g_wl.inited || !g_wl.shm || !g_wl.buffer_id)
        return -1;
    if (size < g_wl.shm_size)
        return -1;
    memcpy(g_wl.shm, fb, g_wl.shm_size);

    struct wl_msg at;
    msg_init(&at, g_wl.surface_id, WL_SURFACE_ATTACH);
    msg_u32(&at, g_wl.buffer_id);
    msg_i32(&at, 0);
    msg_i32(&at, 0);
    if (msg_send(&at, g_wl.surface_id, WL_SURFACE_ATTACH) < 0)
        return -1;

    struct wl_msg dm;
    msg_init(&dm, g_wl.surface_id, WL_SURFACE_DAMAGE);
    msg_i32(&dm, 0);
    msg_i32(&dm, 0);
    msg_i32(&dm, (int32_t)g_wl.width);
    msg_i32(&dm, (int32_t)g_wl.height);
    if (msg_send(&dm, g_wl.surface_id, WL_SURFACE_DAMAGE) < 0)
        return -1;

    uint32_t cb = new_id();
    struct wl_msg fr;
    msg_init(&fr, g_wl.surface_id, WL_SURFACE_FRAME);
    msg_new_id(&fr, cb);
    if (msg_send(&fr, g_wl.surface_id, WL_SURFACE_FRAME) < 0)
        return -1;

    struct wl_msg cm;
    msg_init(&cm, g_wl.surface_id, WL_SURFACE_COMMIT);
    if (msg_send(&cm, g_wl.surface_id, WL_SURFACE_COMMIT) < 0)
        return -1;

    g_wl.frame_done = 0;
    for (int i = 0; i < 1000; i++) {
        int r = dispatch(1000);
        if (r < 0)
            return -1;
        if (g_wl.frame_done) {
            g_wl.frame_done = 0;
            return 0;
        }
        if (g_wl.closed)
            return -1;
    }
    return -1;
}

int wayland_resize(uint32_t width, uint32_t height)
{
    if (!g_wl.inited)
        return -1;
    if (width == 0 || height == 0)
        return -1;
    if (width == g_wl.width && height == g_wl.height)
        return 0;
    if (create_shm_buffer(width, height) < 0)
        return -1;
    struct wl_msg g;
    msg_init(&g, g_wl.xdg_surface_id, XDG_SURFACE_SET_WIN_GEOMETRY);
    msg_i32(&g, 0);
    msg_i32(&g, 0);
    msg_i32(&g, (int32_t)width);
    msg_i32(&g, (int32_t)height);
    if (msg_send(&g, g_wl.xdg_surface_id, XDG_SURFACE_SET_WIN_GEOMETRY) < 0)
        return -1;
    return 0;
}

/* Block for up to timeout_ms while keeping the window alive. Returns 0 when
 * the window is still open, >0 when the user closed it, -1 on error. */
int wayland_poll(int timeout_ms)
{
    if (!g_wl.inited)
        return -1;
    /* Keep the connection healthy; writes flush synchronously. */
    int r = dispatch(timeout_ms);
    if (r < 0)
        return -1;
    if (g_wl.closed)
        return 1;
    if (g_wl.pending_width && g_wl.pending_height &&
        (g_wl.pending_width != g_wl.width ||
         g_wl.pending_height != g_wl.height)) {
        uint32_t w = g_wl.pending_width;
        uint32_t h = g_wl.pending_height;
        g_wl.pending_width = 0;
        g_wl.pending_height = 0;
        if (create_shm_buffer(w, h) < 0)
            return -1;
    }
    return 0;
}
