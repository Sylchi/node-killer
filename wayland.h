/*
 * wayland.h - minimal Wayland client for the qnode runtime
 *
 * Opens a connection to a Wayland compositor, creates a shm based
 * wl_surface and renders frames into it from memory owned by JavaScript
 * (see native.allocMemory()).
 */

#ifndef QNODE_WAYLAND_H
#define QNODE_WAYLAND_H

#ifdef __cplusplus
extern "C" {
#endif

/* Connect to the compositor named by `display_name` (or $WAYLAND_DISPLAY,
 * defaulting to "wayland-0") and create a wl_surface of the given size.
 * Returns 0 on success, -1 on failure. */
int wayland_open(const char *display_name, uint32_t width, uint32_t height);

/* Tear the client down. */
void wayland_close(void);

/* Copy `size` bytes from JS memory into the wl_surface and commit the frame.
 * Returns 0 on success, -1 on failure. */
int wayland_render(const uint8_t *fb, size_t size);

/* Resize the surface and re-allocate the shm buffer. Returns 0 on success,
 * -1 on failure. */
int wayland_resize(uint32_t width, uint32_t height);

#ifdef __cplusplus
}
#endif

#endif /* QNODE_WAYLAND_H */
