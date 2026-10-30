/*
 * lvgl.h - LVGL integration for the qnode bare-metal kernel (Pi 4)
 *
 * Wraps LVGL (https://github.com/lvgl/lvgl) on top of the framebuffer,
 * touch input and timer drivers already provided by this kernel.
 */

#ifndef LVGL_BAREMETAL_H
#define LVGL_BAREMETAL_H

#include <stdint.h>
#include "framebuffer.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Initialize LVGL: display + flush callback + touch input + boot screen.
 * Must be called after the framebuffer has been initialized.
 * Returns 0 on success, -1 on failure. */
int lvgl_init(framebuffer_t *fb);

/* Deinitialize LVGL (display, input, timers). */
void lvgl_deinit(void);

/* Advance LVGL: feed the LVGL tick and run its timers.
 * Call this from the main loop. */
void lvgl_step(void);

/* Register a callback invoked whenever the on-screen keyboard text changes. */
typedef void (*lvgl_keyboard_text_cb_t)(const char *text, void *user_data);
void lvgl_set_keyboard_text_cb(lvgl_keyboard_text_cb_t cb, void *user_data);

#ifdef __cplusplus
}
#endif

#endif /* LVGL_BAREMETAL_H */
