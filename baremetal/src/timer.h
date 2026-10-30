/*
 * timer.h - System timer driver for BCM2711 (Pi 4)
 */
#ifndef TIMER_H
#define TIMER_H

#include <stdint.h>

/**
 * Initialize the system timer.
 * Just verifies the timer is running (it always is on Pi).
 */
void timer_init(void);

/**
 * Get current time in microseconds since boot.
 * Returns a 64-bit counter value.
 */
uint64_t timer_get_us(void);

/**
 * Get current time in milliseconds since boot.
 */
uint64_t timer_get_ms(void);

/**
 * Busy-wait for a specified number of microseconds.
 * Not interruptible - use only for short delays.
 */
void timer_delay_us(uint64_t us);

/**
 * Busy-wait for a specified number of milliseconds.
 */
void timer_delay_ms(uint64_t ms);

#endif /* TIMER_H */
