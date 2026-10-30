/*
 * timer.c - System timer driver for BCM2711 (Pi 4)
 *
 * The BCM2711 system timer runs at 1 MHz (1 microsecond per tick).
 * It's a free-running 64-bit counter that starts at boot.
 */

#include "timer.h"
#include "bcm2711.h"

void timer_init(void)
{
    /* The system timer is always running on Pi 4.
     * No initialization needed - just verify it's ticking. */
}

uint64_t timer_get_us(void)
{
    /* Read 64-bit counter atomically by reading high, low, high again.
     * If high changed, re-read to avoid torn read. */
    uint32_t hi, lo;
    do {
        hi = mmio_read(TIMER_CHI);
        lo = mmio_read(TIMER_CLO);
    } while (hi != mmio_read(TIMER_CHI));
    
    return ((uint64_t)hi << 32) | lo;
}

uint64_t timer_get_ms(void)
{
    return timer_get_us() / 1000;
}

void timer_delay_us(uint64_t us)
{
    uint64_t start = timer_get_us();
    while ((timer_get_us() - start) < us)
        ;
}

void timer_delay_ms(uint64_t ms)
{
    timer_delay_us(ms * 1000);
}
