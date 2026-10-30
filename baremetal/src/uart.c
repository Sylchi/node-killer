/*
 * uart.c - PL011 UART driver for BCM2711 (Pi 4)
 *
 * UART0 is connected to GPIO pins 14 (TX) and 15 (RX) by default.
 * On Pi 4, the primary UART is mapped to the PL011 (not the mini UART).
 */

#include "uart.h"
#include "bcm2711.h"

/* GPIO function select values for UART0 */
#define GPIO_FUNC_ALT0      4

void uart_init(void)
{
    /* Disable UART while configuring */
    mmio_write(UART0_CR, 0);

    /* Set GPIO 14 and 15 to ALT0 function (UART0) */
    /* GPFSEL1 controls GPIO 10-19:
     * - GPIO 14: bits 12-14 (14 - 10 = 4, so bit position = 4*3 = 12)
     * - GPIO 15: bits 15-17 (15 - 10 = 5, so bit position = 5*3 = 15)
     */
    uint32_t sel = mmio_read(GPFSEL1);
    sel &= ~(7 << 12);  /* Clear GPIO 14 */
    sel &= ~(7 << 15);  /* Clear GPIO 15 */
    sel |= (GPIO_FUNC_ALT0 << 12);  /* GPIO 14 = ALT0 (TXD0) */
    sel |= (GPIO_FUNC_ALT0 << 15);  /* GPIO 15 = ALT0 (RXD0) */
    mmio_write(GPFSEL1, sel);

    /* Disable pull-up/down on GPIO 14 and 15 (Pi 4 style) */
    /* GPIO_PUP_PDN_CNTRL0 controls GPIO 0-15:
     * - GPIO 14: bits 28-29
     * - GPIO 15: bits 30-31
     * Value 0 = no resistor (pull disabled)
     */
    uint32_t pup = mmio_read(GPIO_PUP_PDN_CNTRL0);
    pup &= ~(3 << 28);  /* GPIO 14: no pull */
    pup &= ~(3 << 30);  /* GPIO 15: no pull */
    mmio_write(GPIO_PUP_PDN_CNTRL0, pup);

    /* Clear all pending interrupts */
    mmio_write(UART0_ICR, 0x7FF);

    /* Set baud rate: 115200 @ 48MHz clock
     * divisor = 48000000 / (16 * 115200) = 26.041666...
     * integer = 26, fractional = 3 */
    mmio_write(UART0_IBRD, UART0_IBRD_VAL);
    mmio_write(UART0_FBRD, UART0_FBRD_VAL);

    /* Line control: 8 bits, FIFO enabled, no parity, 1 stop bit */
    mmio_write(UART0_LCRH, UART0_LCRH_WLEN_8 | UART0_LCRH_FEN);

    /* Mask all interrupts (we're polling for now) */
    mmio_write(UART0_IMSC, 0);

    /* Enable UART, TX, and RX */
    mmio_write(UART0_CR, UART0_CR_UARTEN | UART0_CR_TXE | UART0_CR_RXE);
}

void uart_putc(char c)
{
    /* Wait for transmit FIFO to have space */
    while (mmio_read(UART0_FR) & UART0_FR_TXFF)
        ;
    mmio_write(UART0_DR, (uint32_t)c);
}

char uart_getc(void)
{
    /* Wait for receive FIFO to have data */
    while (mmio_read(UART0_FR) & UART0_FR_RXFE)
        ;
    return (char)(mmio_read(UART0_DR) & 0xFF);
}

void uart_puts(const char *s)
{
    while (*s) {
        if (*s == '\n')
            uart_putc('\r');  /* Convert \n to \r\n for serial terminals */
        uart_putc(*s++);
    }
}

void uart_write(const void *buf, size_t len)
{
    const uint8_t *p = (const uint8_t *)buf;
    while (len--)
        uart_putc(*p++);
}

size_t uart_read(void *buf, size_t len)
{
    uint8_t *p = (uint8_t *)buf;
    size_t n = 0;
    while (n < len && uart_rx_ready())
        p[n++] = uart_getc();
    return n;
}

int uart_rx_ready(void)
{
    return !(mmio_read(UART0_FR) & UART0_FR_RXFE);
}

int uart_tx_ready(void)
{
    return !(mmio_read(UART0_FR) & UART0_FR_TXFF);
}

void uart_put_hex(uint32_t value)
{
    const char hex_digits[] = "0123456789ABCDEF";
    uart_puts("0x");
    for (int i = 28; i >= 0; i -= 4) {
        uart_putc(hex_digits[(value >> i) & 0xF]);
    }
}

void uart_put_dec(uint32_t value)
{
    if (value == 0) {
        uart_putc('0');
        return;
    }
    
    char buf[10];
    int i = 0;
    while (value > 0) {
        buf[i++] = '0' + (value % 10);
        value /= 10;
    }
    
    while (i > 0) {
        uart_putc(buf[--i]);
    }
}

