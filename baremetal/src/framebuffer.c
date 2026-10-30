#include "framebuffer.h"
#include "mailbox.h"
#include "uart.h"
#include <stddef.h>

// Property tag buffer (must be 16-byte aligned)
__attribute__((aligned(16)))
static uint32_t fb_property_buffer[32];

int framebuffer_init(framebuffer_t *fb, uint32_t width, uint32_t height, uint32_t depth)
{
    // Initialize mailbox
    mailbox_init();

    // Set up property tags for framebuffer allocation
    // See: https://github.com/raspberrypi/firmware/wiki/Mailbox-property-interface
    
    uint32_t *ptr = fb_property_buffer;
    
    // Buffer size (will be filled in later)
    *ptr++ = 0;  // Placeholder for buffer size
    
    // Request indicator
    *ptr++ = 0x00000000;
    
    // Tag: Set physical width/height
    *ptr++ = TAG_SET_PHYS_W_H;  // Tag
    *ptr++ = 8;                  // Value buffer size
    *ptr++ = 0;                  // Request
    *ptr++ = width;              // Width
    *ptr++ = height;             // Height
    
    // Tag: Set virtual width/height
    *ptr++ = TAG_SET_VIRT_W_H;  // Tag
    *ptr++ = 8;                  // Value buffer size
    *ptr++ = 0;                  // Request
    *ptr++ = width;              // Width
    *ptr++ = height;             // Height
    
    // Tag: Set depth
    *ptr++ = TAG_SET_DEPTH;     // Tag
    *ptr++ = 4;                  // Value buffer size
    *ptr++ = 0;                  // Request
    *ptr++ = depth;              // Depth (bits per pixel)
    
    // Tag: Allocate framebuffer
    *ptr++ = TAG_ALLOC_FB;      // Tag
    *ptr++ = 8;                  // Value buffer size
    *ptr++ = 0;                  // Request
    *ptr++ = 16;                 // Alignment (16 bytes)
    *ptr++ = 0;                  // Placeholder for response
    
    // Tag: Get pitch
    *ptr++ = TAG_GET_PITCH;     // Tag
    *ptr++ = 4;                  // Value buffer size
    *ptr++ = 0;                  // Request
    *ptr++ = 0;                  // Placeholder for response
    
    // End tag
    *ptr++ = TAG_END;
    
    // Set buffer size
    fb_property_buffer[0] = (ptr - fb_property_buffer) * sizeof(uint32_t);
    
    uart_puts("FB: Sending property tags...\r\n");
    
    // Call mailbox
    int result = mailbox_call_prop(fb_property_buffer);
    
    if (result != 0) {
        uart_puts("FB: Mailbox call failed\r\n");
        return -1;
    }
    
    // Parse response
    ptr = fb_property_buffer;
    (void)*ptr++;                 // skip buffer size (bytes)
    uint32_t status = *ptr++;
    
    if ((status & 0x80000000) == 0) {
        uart_puts("FB: GPU returned error\r\n");
        return -1;
    }
    
    // Skip through tags to find our responses
    while (*ptr != TAG_END) {
        uint32_t tag = *ptr++;
        uint32_t value_size = *ptr++;
        (void)*ptr++;             // skip tag indicator
        
        if (tag == TAG_ALLOC_FB) {
            fb->base = (void *)(uintptr_t)(*ptr++);
            fb->size = *ptr++;
            
            // Convert bus address to physical address (mask off 0xC0000000)
            fb->base = (void *)((uintptr_t)fb->base & 0x3FFFFFFF);
            
            uart_puts("FB: Allocated at 0x");
            uart_put_hex((uintptr_t)fb->base);
            uart_puts(", size ");
            uart_put_dec(fb->size);
            uart_puts(" bytes\r\n");
        } else if (tag == TAG_GET_PITCH) {
            fb->pitch = *ptr++;
            uart_puts("FB: Pitch ");
            uart_put_dec(fb->pitch);
            uart_puts(" bytes/row\r\n");
        } else {
            // Skip unknown tags
            ptr += (value_size + 3) / 4;  // Round up to 4-byte boundary
        }
    }
    
    if (fb->base == NULL || fb->pitch == 0) {
        uart_puts("FB: Failed to get framebuffer or pitch\r\n");
        return -1;
    }
    
    fb->width = width;
    fb->height = height;
    fb->depth = depth;
    
    uart_puts("FB: Initialized ");
    uart_put_dec(width);
    uart_puts("x");
    uart_put_dec(height);
    uart_puts(" @ ");
    uart_put_dec(depth);
    uart_puts("bpp\r\n");
    
    return 0;
}

void framebuffer_release(framebuffer_t *fb)
{
    // TODO: Send release tag to GPU
    fb->base = NULL;
    fb->size = 0;
    fb->pitch = 0;
}

void framebuffer_clear(framebuffer_t *fb, uint32_t color)
{
    if (fb->base == NULL) return;
    
    // For 32-bit depth, write 4 bytes per pixel
    for (uint32_t y = 0; y < fb->height; y++) {
        uint32_t *row = (uint32_t *)((uint8_t *)fb->base + y * fb->pitch);
        for (uint32_t x = 0; x < fb->width; x++) {
            row[x] = color;
        }
    }
}
