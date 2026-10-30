#ifndef MAILBOX_H
#define MAILBOX_H

#include <stdint.h>

// Mailbox channels
#define MAILBOX_CH_POWER 0
#define MAILBOX_CH_FB    1
#define MAILBOX_CH_VUART 2
#define MAILBOX_CH_VCHIQ 3
#define MAILBOX_CH_LEDS  4
#define MAILBOX_CH_BTNS  5
#define MAILBOX_CH_TOUCH 6
#define MAILBOX_CH_PROPS 8

// Property tags
#define TAG_END           0x00000000
#define TAG_SET_PHYS_W_H  0x00048003
#define TAG_SET_VIRT_W_H  0x00048004
#define TAG_SET_DEPTH     0x00048005
#define TAG_SET_PIXEL_ORD 0x00048006
#define TAG_ALLOC_FB      0x00040001
#define TAG_GET_PITCH     0x00040008

// Initialize mailbox
void mailbox_init(void);

// Write to mailbox channel
int mailbox_write(uint8_t channel, uint32_t data);

// Read from mailbox channel
uint32_t mailbox_read(uint8_t channel);

// Call property tags interface
int mailbox_call_prop(uint32_t *buffer);

#endif // MAILBOX_H
