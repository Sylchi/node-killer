/*
 * main.c - Entry point for qnode bare-metal kernel
 *
 * Phase 2: Boot to UART + Framebuffer output
 */

#include <stdint.h>
#include "uart.h"
#include "timer.h"
#include "framebuffer.h"
#include "bcm2711.h"

/* Called from start.S after BSS is cleared and stack is set up */
void main(void)
{
    /* Initialize hardware */
    uart_init();
    timer_init();

    /* Print boot message */
    uart_puts("\r\n");
    uart_puts("========================================\r\n");
    uart_puts("qnode bare-metal kernel for Pi 4\r\n");
    uart_puts("Phase 2: Display Support\r\n");
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
    
    uart_puts("Phase 2 complete. System running.\r\n");
    uart_puts("UART echo active. Type characters to see them echoed.\r\n");
    uart_puts("\r\n");

    /* Main loop: echo characters back and show heartbeat */
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
