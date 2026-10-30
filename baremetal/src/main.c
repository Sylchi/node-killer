/*
 * main.c - Entry point for qnode bare-metal kernel
 *
 * Phase 4: Boot to UART + Framebuffer + Touch input + Heap + JS Runtime
 */

#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "uart.h"
#include "timer.h"
#include "framebuffer.h"
#include "touch.h"
#include "heap.h"
#include "bcm2711.h"
#include "quickjs.h"

/* Heap memory buffer - 4MB for JavaScript runtime */
static uint8_t heap_buffer[4 * 1024 * 1024] __attribute__((aligned(16)));

/* console.log implementation - outputs to UART */
static JSValue js_console_log(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    for (int i = 0; i < argc; i++) {
        if (i > 0) uart_puts(" ");
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) {
            uart_puts(str);
            JS_FreeCString(ctx, str);
        } else {
            uart_puts("[object]");
        }
    }
    uart_puts("\r\n");
    return JS_UNDEFINED;
}

/* Test JavaScript program */
static const char *test_js = 
    "console.log('Hello from QuickJS!');\n"
    "console.log('2 + 2 =', 2 + 2);\n"
    "console.log('Array test:', [1, 2, 3].length);\n"
    "console.log('Object test:', {x: 10, y: 20}.x);\n"
    "let sum = 0;\n"
    "for (let i = 1; i <= 10; i++) sum += i;\n"
    "console.log('Sum 1-10:', sum);\n";

/* QuickJS memory allocation wrapper functions */
static void *js_malloc_wrapper(void *opaque, size_t size) {
    (void)opaque;
    return malloc(size);
}

static void js_free_wrapper(void *opaque, void *ptr) {
    (void)opaque;
    free(ptr);
}

static void *js_realloc_wrapper(void *opaque, void *ptr, size_t size) {
    (void)opaque;
    return realloc(ptr, size);
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
    
    uart_puts("Initializing framebuffer...\r\n");
    uart_puts("Requesting 800x480 @ 32bpp\r\n");
    
    /* Initialize framebuffer */
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
    uart_put_hex((uint32_t)fb.base);
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
    
    /* Initialize JavaScript runtime */
    uart_puts("Initializing JavaScript runtime...\r\n");
    
    /* Print heap statistics before QuickJS init */
    uart_puts("Heap stats before JS init:\r\n");
    uart_puts("  Free: ");
    uart_put_dec(heap_get_free());
    uart_puts(" bytes\r\n");
    uart_puts("  Used: ");
    uart_put_dec(heap_get_used());
    uart_puts(" bytes\r\n");
    
    /* Initialize JavaScript runtime - SKIPPED FOR DEBUG */
    uart_puts("JavaScript runtime initialization skipped (debug mode)\r\n");
    uart_puts("Heap stats: Free=");
    uart_put_dec(heap_get_free());
    uart_puts(" bytes, Used=");
    uart_put_dec(heap_get_used());
    uart_puts(" bytes\r\n");
    uart_puts("\r\n");
    
    /* Draw a simple test pattern: colored rectangles */
    uart_puts("Drawing test pattern...\r\n");
    
    uint32_t *pixels = (uint32_t*)fb.base;
    int pitch_pixels = fb.pitch / 4;
    
    /* Clear screen to dark blue */
    for (int y = 0; y < 480; y++) {
        for (int x = 0; x < 800; x++) {
            pixels[y * pitch_pixels + x] = 0x001020;  /* Dark blue */
        }
    }
    
    /* Draw red rectangle */
    for (int y = 50; y < 150; y++) {
        for (int x = 50; x < 250; x++) {
            pixels[y * pitch_pixels + x] = 0xFF0000;  /* Red */
        }
    }
    
    /* Draw green rectangle */
    for (int y = 50; y < 150; y++) {
        for (int x = 300; x < 500; x++) {
            pixels[y * pitch_pixels + x] = 0x00FF00;  /* Green */
        }
    }
    
    /* Draw blue rectangle */
    for (int y = 50; y < 150; y++) {
        for (int x = 550; x < 750; x++) {
            pixels[y * pitch_pixels + x] = 0x0000FF;  /* Blue */
        }
    }
    
    /* Draw yellow rectangle */
    for (int y = 200; y < 300; y++) {
        for (int x = 50; x < 250; x++) {
            pixels[y * pitch_pixels + x] = 0xFFFF00;  /* Yellow */
        }
    }
    
    /* Draw cyan rectangle */
    for (int y = 200; y < 300; y++) {
        for (int x = 300; x < 500; x++) {
            pixels[y * pitch_pixels + x] = 0x00FFFF;  /* Cyan */
        }
    }
    
    /* Draw magenta rectangle */
    for (int y = 200; y < 300; y++) {
        for (int x = 550; x < 750; x++) {
            pixels[y * pitch_pixels + x] = 0xFF00FF;  /* Magenta */
        }
    }
    
    /* Draw white border */
    for (int x = 0; x < 800; x++) {
        pixels[0 * pitch_pixels + x] = 0xFFFFFF;           /* Top border */
        pixels[479 * pitch_pixels + x] = 0xFFFFFF;         /* Bottom border */
    }
    for (int y = 0; y < 480; y++) {
        pixels[y * pitch_pixels + 0] = 0xFFFFFF;           /* Left border */
        pixels[y * pitch_pixels + 799] = 0xFFFFFF;         /* Right border */
    }
    
    uart_puts("Test pattern drawn!\r\n");
    uart_puts("You should see colored rectangles on the display.\r\n");
    uart_puts("\r\n");
    
    uart_puts("Phase 3 complete. System running.\r\n");
    uart_puts("UART echo active. Type characters to see them echoed.\r\n");
    if (result == 0) {
        uart_puts("Touch input active. Touch the screen to see coordinates.\r\n");
    }
    uart_puts("\r\n");

    /* Main loop: echo characters back, handle touch, and show heartbeat */
    int heartbeat = 0;
    TouchPoint last_touch = {0};
    bool had_touch = false;
    
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
        
        /* Check for touch input */
        TouchPoint touch;
        if (result == 0 && touch_read(&touch)) {
            if (touch.pressed) {
                /* Draw a white dot at touch position */
                int tx = touch.x;
                int ty = touch.y;
                
                /* Draw a 5x5 white square at touch point */
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        int px = tx + dx;
                        int py = ty + dy;
                        if (px >= 0 && px < 800 && py >= 0 && py < 480) {
                            pixels[py * pitch_pixels + px] = 0xFFFFFF;
                        }
                    }
                }
                
                /* Report touch on UART */
                if (!had_touch || last_touch.x != touch.x || last_touch.y != touch.y) {
                    uart_puts("Touch at (");
                    uart_put_dec(touch.x);
                    uart_puts(", ");
                    uart_put_dec(touch.y);
                    uart_puts(")\r\n");
                    last_touch = touch;
                    had_touch = true;
                }
            }
        }
        
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
