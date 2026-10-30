#include "mailbox.h"
#include "bcm2711.h"
#include "timer.h"

// Mailbox registers (ARM-local peripherals)
#define MBOX_BASE       0xFF800000
#define MBOX_READ       (MBOX_BASE + 0x00)
#define MBOX_STATUS     (MBOX_BASE + 0x18)
#define MBOX_WRITE      (MBOX_BASE + 0x20)

// Status bits
#define MBOX_FULL       0x80000000
#define MBOX_EMPTY      0x40000000

void mailbox_init(void)
{
    // Mailbox is always ready, no initialization needed
}

int mailbox_write(uint8_t channel, uint32_t data)
{
    // Wait until mailbox is not full
    while (REG32(MBOX_STATUS) & MBOX_FULL) {
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

    // Wait for data in mailbox
    while (1) {
        // Wait until mailbox is not empty
        while (REG32(MBOX_STATUS) & MBOX_EMPTY) {
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
    // Property tags must be 16-byte aligned
    // Flush data cache to ensure memory is visible to VideoCore
    // (This is simplified - real implementation needs proper cache maintenance)

    uint32_t addr = (uint32_t)(uintptr_t)buffer;

    // Write to mailbox channel 8 (property tags)
    mailbox_write(MAILBOX_CH_PROPS, addr);

    // Read response from channel 8
    uint32_t response = mailbox_read(MAILBOX_CH_PROPS);

    // Check if successful (should get back our buffer address)
    if (response == addr) {
        // Check if request was successful (buffer[1] should have success code)
        if (buffer[1] == 0x80000000) {
            return 0;  // Success
        }
    }

    return -1;  // Failure
}
