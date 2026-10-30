/*
 * main.c - Entry point for qnode bare-metal kernel
 *
 * Phase 4: Boot to UART + Framebuffer + Touch input + Heap + LVGL Boot UI + QuickJS
 */

#include <stdint.h>
#include "uart.h"
#include "timer.h"
#include "framebuffer.h"
#include "touch.h"
#include "heap.h"
#include "bcm2711.h"
#include "lvgl.h"
#include "js.h"

/* Heap memory buffer - 4MB for JavaScript runtime */
static uint8_t heap_buffer[4 * 1024 * 1024] __attribute__((aligned(16)));

/* On-screen keyboard text callback: forward to the UART boot console
 * and push the text into the QuickJS runtime (global "kbInput"). */
static void kb_text_cb(const char *text, void *user_data) {
    (void)user_data;
    uart_puts(text);
    uart_puts("\r\n");

    /* Push the on-screen keyboard text into QuickJS */
    js_push_global_str("kbInput", text);
}

/* Called from start.S after BSS is cleared and stack is set up */
void main(void)
{
    /* Initialize hardware */
    uart_init();
    timer_init();

    /* Initialize heap allocator */
    heap_init(heap_buffer, sizeof(heap_buffer));

    /* Print boot message */
    uart_puts("\r\n");
    uart_puts("========================================\r\n");
    uart_puts("qnode bare-metal kernel for Pi 4\r\n");
    uart_puts("Phase 4: JavaScript Runtime Support\r\n");
    uart_puts("========================================\r\n");
    uart_puts("\r\n");

    /* Initialize framebuffer */
    uart_puts("Initializing framebuffer...\r\n");
    uart_puts("Requesting 800x480 @ 32bpp\r\n");

    framebuffer_t fb;
    int result = framebuffer_init(&fb, 800, 480, 32);

    if (result != 0) {
        uart_puts("ERROR: Framebuffer initialization failed!\r\n");
        uart_puts("Check mailbox communication with GPU\r\n");
        while (1) {
            timer_delay_ms(500);
            uart_putc('!');
        }
    }

    uart_puts("SUCCESS: Framebuffer initialized\r\n");
    uart_puts("Base address: 0x");
    uart_put_hex((uint32_t)(uintptr_t)fb.base);
    uart_puts("\r\n");
    uart_puts("Size: ");
    uart_put_dec(fb.size);
    uart_puts(" bytes\r\n");
    uart_puts("Pitch: ");
    uart_put_dec(fb.pitch);
    uart_puts(" bytes/row\r\n");

    /* Initialize touch input */
    uart_puts("Initializing touch input...\r\n");
    result = touch_init();
    if (result == 0) {
        uart_puts("SUCCESS: Touch input initialized\r\n");
    } else {
        uart_puts("WARNING: Touch input not available, continuing without touch\r\n");
    }

    /* Initialize LVGL (display + flush callback + boot splash screen) */
    uart_puts("Initializing LVGL...\r\n");
    int lvgl_result = lvgl_init(&fb);
    if (lvgl_result != 0) {
        uart_puts("ERROR: LVGL initialization failed!\r\n");
        while (1) {
            timer_delay_ms(500);
            uart_putc('!');
        }
    }
    uart_puts("SUCCESS: LVGL initialized, boot screen displayed.\r\n");

    /* Forward on-screen keyboard text changes to the boot console */
    lvgl_set_keyboard_text_cb(kb_text_cb, NULL);

    /* Initialize JavaScript engine (QuickJS runtime + context + boot test) */
    if (js_init() != 0) {
        uart_puts("ERROR: QuickJS initialization failed!\r\n");
        while (1) {
            timer_delay_ms(500);
            uart_putc('!');
        }
    }

    /* LVGL renders the boot splash screen into the framebuffer
     * via the flush callback - no direct pixel manipulation needed */
    uart_puts("LVGL rendering active. Boot screen displayed.\r\n");
    uart_puts("UART echo active. Type characters to see them echoed.\r\n");
    uart_puts("\r\n");

    /* Main loop: echo characters back and run the LVGL loop */
    int heartbeat = 0;

    while (1) {
        /* Check for UART input */
        if (uart_rx_ready()) {
            char c = uart_getc();

            /* Echo back */
            if (c == '\r') {
                uart_puts("\r\n");
            } else if (c == 3) {  /* Ctrl+C */
                uart_puts("\r\n\r\nHalting...\r\n");
                break;
            } else {
                uart_putc(c);
            }
        }

        /* Advance LVGL: run timers, input handling and rendering */
        lvgl_step();

        /* Run pending QuickJS jobs (GC finalizers, promise jobs, etc.) */
        js_step();

        /* Show heartbeat every ~2 seconds */
        timer_delay_ms(100);
        heartbeat++;
        if (heartbeat >= 20) {
            heartbeat = 0;
            uart_putc('.');
        }
    }

    /* Halt */
    uart_puts("System halted. Reset to restart.\r\n");
    while (1) {
        __asm__ volatile("wfe");
    }
}
