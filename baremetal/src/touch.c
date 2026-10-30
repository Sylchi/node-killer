#include "touch.h"
#include "mailbox.h"
#include "bcm2711.h"

// Touch screen buffer structure
// The GPU writes touch data to this buffer
typedef struct {
    uint8_t status;      // 0x80 = touch down, 0x00 = no touch
    uint16_t x;          // X coordinate
    uint16_t y;          // Y coordinate
    uint8_t padding[1];  // Padding to align to 8 bytes
} __attribute__((packed)) TouchBuffer;

// Touch screen buffer (must be 16-byte aligned for mailbox)
static TouchBuffer touch_buffer __attribute__((aligned(16)));
static bool touch_initialized = false;
static TouchPoint last_point = {0, 0, false};

int touch_init(void) {
    if (touch_initialized) {
        return 0;
    }
    
    // Initialize the touch screen buffer address with the GPU
    // Using mailbox channel 6 (touch screen)
    uint32_t buffer_addr = (uint32_t)(uintptr_t)&touch_buffer;
    
    // Send buffer address to GPU via mailbox
    // The GPU will write touch data to this buffer
    mailbox_write(MAILBOX_CH_TOUCH, buffer_addr | 0xD); // 0xD = channel 6 with tag
    
    touch_initialized = true;
    return 0;
}

bool touch_read(TouchPoint *point) {
    if (!touch_initialized || !point) {
        return false;
    }
    
    // Read the status byte to check if there's a touch event
    if (touch_buffer.status == 0x80) {
        // Touch is down
        point->x = touch_buffer.x;
        point->y = touch_buffer.y;
        point->pressed = true;
        
        // Update last known position
        last_point.x = point->x;
        last_point.y = point->y;
        last_point.pressed = true;
        
        // Clear the status to acknowledge we've read it
        touch_buffer.status = 0x00;
        
        return true;
    } else if (last_point.pressed) {
        // Touch was released
        point->x = last_point.x;
        point->y = last_point.y;
        point->pressed = false;
        
        last_point.pressed = false;
        return true;
    }
    
    return false;
}

bool touch_is_pressed(void) {
    if (!touch_initialized) {
        return false;
    }
    return touch_buffer.status == 0x80;
}

TouchPoint touch_get_position(void) {
    return last_point;
}
