/*
 * lvgl.c - LVGL integration for the qnode bare-metal kernel (Pi 4)
 *
 * - Creates an LVGL display on top of the mailbox framebuffer
 * - Flush callback copies the rendered LVGL draw buffer to the framebuffer
 * - Wires the FT5406 touch controller into LVGL as a pointer input device
 * - Builds a simple boot splash screen (spinner + text)
 */

#include "lvgl.h"
#include "../lvgl/lvgl.h"
#include "touch.h"
#include "timer.h"

/* Display resolution in pixels (must match the framebuffer) */
#define LVGL_HOR_RES 800
#define LVGL_VER_RES 480

/* Size of the LVGL draw buffer in pixels (full screen, XRGB8888 = 32bpp) */
#define LVGL_BUF_SIZE (LVGL_HOR_RES * LVGL_VER_RES)

/* LVGL draw buffer holding the frame rendered by the software renderer */
static uint32_t lvgl_draw_buf[LVGL_BUF_SIZE] __attribute__((aligned(16)));

/* Framebuffer LVGL renders into via the flush callback */
static framebuffer_t *lvgl_fb = NULL;

/* LVGL display and touch input device */
static lv_display_t *lvgl_disp = NULL;
static lv_indev_t *lvgl_indev = NULL;

/* On-screen keyboard text state */
static lv_obj_t *lvgl_kb_ta = NULL;
static char lvgl_kb_buf[64];
static uint32_t lvgl_kb_len = 0;

/* Keyboard text callback */
static lvgl_keyboard_text_cb_t lvgl_kb_text_cb = NULL;
static void *lvgl_kb_text_cb_data = NULL;

/* Last value fed into the LVGL tick (in ms) */
static uint32_t lvgl_last_tick = 0;

/* Flush callback: copy the rendered LVGL frame into the framebuffer.
 * Called by the LVGL refresh timer with the invalidated area. We use
 * LV_DISPLAY_RENDER_MODE_FULL, so the area always covers the whole screen
 * and px_map points to the start of the draw buffer. */
static void lvgl_flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    lv_display_flush_ready(disp);

    if (lvgl_fb == NULL || px_map == NULL) {
        return;
    }

    uint32_t *src = (uint32_t *)px_map;
    uint32_t *dst = (uint32_t *)lvgl_fb->base;
    uint32_t pitch_px = lvgl_fb->pitch / 4;

    for (uint32_t y = 0; y < lvgl_fb->height; y++) {
        for (uint32_t x = 0; x < lvgl_fb->width; x++) {
            /* XRGB8888 pixels are stored as 0xFFRRGGBB - strip the padding */
            dst[y * pitch_px + x] = src[y * lvgl_fb->width + x] & 0x00FFFFFFu;
        }
    }
}

/* Touch input callback for LVGL: forward the FT5406 touch driver state. */
static void lvgl_indev_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    (void)indev;

    TouchPoint tp;
    bool pressed = false;
    uint16_t x = 0;
    uint16_t y = 0;

    if (touch_read(&tp)) {
        pressed = tp.pressed;
        x = tp.x;
        y = tp.y;
    }

    data->point.x = x;
    data->point.y = y;
    data->state = pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

int lvgl_init(framebuffer_t *fb)
{
    lvgl_fb = fb;

    lv_init();

    lvgl_disp = lv_display_create(LVGL_HOR_RES, LVGL_VER_RES);
    if (lvgl_disp == NULL) {
        return -1;
    }

    lv_display_set_flush_cb(lvgl_disp, lvgl_flush_cb);
    lv_display_set_buffers(lvgl_disp, lvgl_draw_buf, NULL, sizeof(lvgl_draw_buf),
                            LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_color_format(lvgl_disp, LV_COLOR_FORMAT_XRGB8888);
    lv_display_set_render_mode(lvgl_disp, LV_DISPLAY_RENDER_MODE_FULL);

    /* Touch input via the existing FT5406 driver */
    lvgl_indev = lv_indev_create();
    if (lvgl_indev != NULL) {
        lv_indev_set_type(lvgl_indev, LV_INDEV_TYPE_POINTER);
        lv_indev_set_read_cb(lvgl_indev, lvgl_indev_read_cb);
        lv_indev_set_display(lvgl_indev, lvgl_disp);
        lv_indev_enable(lvgl_indev, true);
    }

    /* Boot splash screen: dark background, spinner and text */
    lv_obj_t *scr = lv_display_get_screen_active(lvgl_disp);

    lv_obj_set_style_bg_color(scr, lv_color_make(0x10, 0x14, 0x28), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);

    lv_obj_t *label = lv_label_create(scr);
    lv_label_set_text(label, "Starting...");
    lv_obj_set_width(label, LVGL_HOR_RES);
    lv_obj_set_pos(label, 0, 90);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);

    lv_obj_t *spinner = lv_spinner_create(scr);
    lv_spinner_set_anim_params(spinner, 1000, 90);
    lv_obj_set_size(spinner, 60, 60);
    lv_obj_set_pos(spinner, (LVGL_HOR_RES - 60) / 2, 160);

    /* On-screen keyboard with an editable text area */
    lv_obj_t *ta = lv_textarea_create(scr);
    lv_textarea_set_text(ta, "");
    lv_obj_set_size(ta, LVGL_HOR_RES, 36);
    lv_obj_set_pos(ta, 0, 246);

    lv_obj_t *kb = lv_keyboard_create(scr);
    lv_keyboard_set_textarea(kb, ta);
    lv_keyboard_set_mode(kb, LV_KEYBOARD_MODE_TEXT_LOWER);
    lv_obj_set_pos(kb, 0, 290);

    lvgl_kb_ta = ta;

    lv_refr_now(lvgl_disp);

    return 0;
}

void lvgl_deinit(void)
{
    if (lvgl_indev != NULL) {
        lv_indev_delete(lvgl_indev);
        lvgl_indev = NULL;
    }
    if (lvgl_disp != NULL) {
        lv_display_delete(lvgl_disp);
        lvgl_disp = NULL;
    }
}

void lvgl_set_keyboard_text_cb(lvgl_keyboard_text_cb_t cb, void *user_data)
{
    lvgl_kb_text_cb = cb;
    lvgl_kb_text_cb_data = user_data;
}

void lvgl_step(void)
{
    uint32_t now = (uint32_t)timer_get_ms();
    uint32_t ms = now - lvgl_last_tick;
    lvgl_last_tick = now;

    lv_tick_inc(ms);
    lv_timer_handler();

    /* Report the on-screen keyboard text whenever it changes */
    const char *txt = lv_textarea_get_text(lvgl_kb_ta);
    if (txt != NULL) {
        uint32_t len = 0;
        while (txt[len] != 0 && len < sizeof(lvgl_kb_buf)) {
            len++;
        }

        if (len != lvgl_kb_len) {
            lvgl_kb_len = len;
            for (uint32_t i = 0; i < len; i++) {
                lvgl_kb_buf[i] = txt[i];
            }
            lvgl_kb_buf[len] = 0;

            if (lvgl_kb_text_cb != NULL) {
                lvgl_kb_text_cb(lvgl_kb_buf, lvgl_kb_text_cb_data);
            }
        }
    }
}
