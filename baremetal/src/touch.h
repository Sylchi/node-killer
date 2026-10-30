#ifndef TOUCH_H
#define TOUCH_H

#include <stdint.h>
#include <stdbool.h>

typedef struct {
    uint16_t x;
    uint16_t y;
    bool pressed;
} TouchPoint;

// Initialize touch controller via mailbox
int touch_init(void);

// Read current touch state
// Returns true if touch data is available, false otherwise
bool touch_read(TouchPoint *point);

// Check if touch is currently pressed
bool touch_is_pressed(void);

// Get last known touch position
TouchPoint touch_get_position(void);

#endif // TOUCH_H
