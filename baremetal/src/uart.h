/*
 * uart.h - PL011 UART driver for BCM2711 (Pi 4)
 */
#ifndef UART_H
#define UART_H

#include <stdint.h>
#include <stddef.h>

/**
 * Initialize UART0 (PL011) at 115200 baud, 8N1.
 * Configures GPIO pins 14/15 for UART function.
 */
void uart_init(void);

/**
 * Send a single character over UART.
 * Blocks until the transmit FIFO has space.
 */
void uart_putc(char c);

/**
 * Receive a single character from UART.
 * Blocks until a character is available.
 */
char uart_getc(void);

/**
 * Send a null-terminated string over UART.
 */
void uart_puts(const char *s);

/**
 * Send exactly n bytes over UART.
 */
void uart_write(const void *buf, size_t len);

/**
 * Read up to n bytes from UART.
 * Returns number of bytes actually read.
 */
size_t uart_read(void *buf, size_t len);

/**
 * Check if UART has data available to read (non-blocking).
 */
int uart_rx_ready(void);

/**
 * Check if UART transmit FIFO has space (non-blocking).
 */
int uart_tx_ready(void);

/**
 * Print a hexadecimal number (with 0x prefix)
 */
void uart_put_hex(uint32_t value);

/**
 * Print a decimal number
 */
void uart_put_dec(uint32_t value);

#endif /* UART_H */
