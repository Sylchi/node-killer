#include "mailbox.h"
#include "bcm2711.h"
#include "timer.h"
#include "uart.h"

// Mailbox registers (VideoCore mailbox)
#define MBOX_BASE       (BCM_PERIPHERAL_BASE + 0xB880)
#define MBOX_READ       (MBOX_BASE + 0x00)
#define MBOX_STATUS     (MBOX_BASE + 0x18)
#define MBOX_WRITE      (MBOX_BASE + 0x20)

// Status bits
#define MBOX_FULL       0x80000000
#define MBOX_EMPTY      0x40000000

// Timeout for mailbox operations (1 second in microseconds)
#define MBOX_TIMEOUT_US 1000000

void mailbox_init(void)
{
    // Mailbox is always ready, no initialization needed
}

int mailbox_write(uint8_t channel, uint32_t data)
{
    uint64_t start = timer_get_us();
    
    // Wait until mailbox is not full, with timeout
    while (REG32(MBOX_STATUS) & MBOX_FULL) {
        if (timer_get_us() - start > MBOX_TIMEOUT_US) {
            return -1;  // Timeout
        }
        timer_delay_us(1);
    }

    // Combine channel (lower 4 bits) with data (upper 28 bits)
    // Data must be 16-byte aligned
    REG32(MBOX_WRITE) = (data & ~0xF) | (channel & 0xF);
    return 0;
}

uint32_t mailbox_read(uint8_t channel)
{
    uint32_t data;
    uint64_t start = timer_get_us();

    // Wait for data in mailbox, with timeout
    while (1) {
        // Wait until mailbox is not empty
        while (REG32(MBOX_STATUS) & MBOX_EMPTY) {
            if (timer_get_us() - start > MBOX_TIMEOUT_US) {
                return 0xFFFFFFFF;  // Timeout indicator
            }
            timer_delay_us(1);
        }

        // Read response
        data = REG32(MBOX_READ);

        // Check if it's from the requested channel
        if ((data & 0xF) == channel) {
            return data & ~0xF;  // Return data without channel bits
        }
    }
}

int mailbox_call_prop(uint32_t *buffer)
{
    uint32_t addr = (uint32_t)(uintptr_t)buffer;

    // Write to mailbox channel 8 (property tags)
    if (mailbox_write(MAILBOX_CH_PROPS, addr) != 0) {
        return -1;  // Write timeout
    }

    // Read response from channel 8
    uint32_t response = mailbox_read(MAILBOX_CH_PROPS);
    if (response == 0xFFFFFFFF) {
        return -1;  // Read timeout
    }

    // Check if successful (should get back our buffer address)
    if (response == addr) {
        // Check if request was successful (buffer[1] should have success code)
        if (buffer[1] == 0x80000000) {
            return 0;  // Success
        }
    }

    return -1;  // Failure
}
