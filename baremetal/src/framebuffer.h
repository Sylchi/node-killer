#ifndef FRAMEBUFFER_H
#define FRAMEBUFFER_H

#include <stdint.h>

// Framebuffer configuration
#define FB_WIDTH    800
#define FB_HEIGHT   480
#define FB_DEPTH    32  // bits per pixel

typedef struct {
    void *base;         // Framebuffer base address (physical address from GPU)
    uint32_t size;      // Total size in bytes
    uint32_t pitch;     // Bytes per row (may be > width * 4 due to alignment)
    uint32_t width;
    uint32_t height;
    uint32_t depth;
} framebuffer_t;

// Initialize framebuffer with specified resolution
int framebuffer_init(framebuffer_t *fb, uint32_t width, uint32_t height, uint32_t depth);

// Release framebuffer
void framebuffer_release(framebuffer_t *fb);

// Set a pixel (assumes 32-bit depth)
static inline void framebuffer_set_pixel(framebuffer_t *fb, uint32_t x, uint32_t y, uint32_t color)
{
    if (x >= fb->width || y >= fb->height) return;
    uint32_t *pixels = (uint32_t *)((uint8_t *)fb->base + y * fb->pitch);
    pixels[x] = color;
}

// Clear framebuffer to a color
void framebuffer_clear(framebuffer_t *fb, uint32_t color);

#endif // FRAMEBUFFER_H
