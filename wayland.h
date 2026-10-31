/*
 * wayland.h - minimal Wayland client for the qnode runtime
 *
 * Opens a connection to a Wayland compositor, creates an xdg-shell toplevel
 * window backed by a wl_shm buffer and renders frames into it from memory
 * owned by JavaScript (see native.allocMemory()).
 */

#ifndef QNODE_WAYLAND_H
#define QNODE_WAYLAND_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Properties of the monitor the compositor reported for the first output. */
struct wayland_output {
    int have_output;
    int x, y;                     /* position in the global layout */
    int physical_width, physical_height; /* millimetres */
    int width, height;            /* current mode in pixels */
    int refresh;                  /* mHz */
    int scale;                    /* buffer scale factor */
    int transform;
    char make[64];
    char model[64];
};

/* Connect to the compositor named by `display_name` (or $WAYLAND_DISPLAY,
 * defaulting to "wayland-0") and create an 800x600-style toplevel window.
 * Returns 0 on success, -1 on failure. */
int wayland_open(const char *display_name, uint32_t width, uint32_t height);

/* Tear the client down. */
void wayland_close(void);

/* Copy `size` bytes (the full window, XRGB8888) into the shared buffer and
 * commit a frame. Returns 0 once the compositor has presented it. */
int wayland_render(const uint8_t *fb, size_t size);

/* Resize the surface and re-allocate the shm buffer. */
int wayland_resize(uint32_t width, uint32_t height);

/* Process compositor events for up to `timeout_ms`, keeping the window alive.
 * Returns 0 while the window is open, 1 after the user closed it, -1 on
 * error. */
int wayland_poll(int timeout_ms);

uint32_t wayland_width(void);
uint32_t wayland_height(void);

/* Monitor description filled from wl_output (scale, mode, physical size). */
int wayland_fill_output(struct wayland_output *out);

#ifdef __cplusplus
}
#endif

#endif /* QNODE_WAYLAND_H */
