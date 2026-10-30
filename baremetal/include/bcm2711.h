/*
 * bcm2711.h - BCM2711 (Raspberry Pi 4) hardware definitions
 *
 * Reference: BCM2711 ARM Peripherals datasheet + errata for Pi 4B.
 * Peripheral base address is 0xFE000000 (not 0x3F000000 like Pi 3).
 */
#ifndef BCM2711_H
#define BCM2711_H

#include <stdint.h>

/* ------------------------------------------------------------------ */
/* Memory map                                                         */
/* ------------------------------------------------------------------ */

#define BCM_PERIPHERAL_BASE     0xFE000000UL
#define BCM_LOCAL_PERIPHERALS   0xFF800000UL

/* Kernel load address (GPU firmware loads kernel8.img here) */
#define KERNEL_LOAD_ADDR        0x80000UL

/* ------------------------------------------------------------------ */
/* GPIO (general purpose I/O)                                         */
/* ------------------------------------------------------------------ */

#define GPIO_BASE               (BCM_PERIPHERAL_BASE + 0x200000)

/* Function select registers: 10 pins per register, 3 bits each */
#define GPFSEL0                 (GPIO_BASE + 0x00)
#define GPFSEL1                 (GPIO_BASE + 0x04)
#define GPFSEL2                 (GPIO_BASE + 0x08)

/* Pin output set/clear */
#define GPSET0                  (GPIO_BASE + 0x1C)
#define GPSET1                  (GPIO_BASE + 0x20)
#define GPCLR0                  (GPIO_BASE + 0x28)
#define GPCLR1                  (GPIO_BASE + 0x2C)

/* Pin level (read) */
#define GPLEV0                  (GPIO_BASE + 0x34)
#define GPLEV1                  (GPIO_BASE + 0x38)

/* Pull-up/down control (Pi 4 uses a different mechanism than Pi 3) */
#define GPIO_PUP_PDN_CNTRL0     (GPIO_BASE + 0xE4)
#define GPIO_PUP_PDN_CNTRL1     (GPIO_BASE + 0xE8)
#define GPIO_PUP_PDN_CNTRL2     (GPIO_BASE + 0xEC)
#define GPIO_PUP_PDN_CNTRL3     (GPIO_BASE + 0xF0)

/* Alternate function selects */
#define GPIO_ALT0               4
#define GPIO_ALT1               5
#define GPIO_ALT2               6
#define GPIO_ALT3               7
#define GPIO_ALT4               3
#define GPIO_ALT5               2
#define GPIO_INPUT              0
#define GPIO_OUTPUT             1

/* Mini UART (AUX) - not used, but defined for reference */
#define AUX_BASE                (BCM_PERIPHERAL_BASE + 0x215000)
#define AUX_ENABLES             (AUX_BASE + 0x04)
#define AUX_MU_IO               (AUX_BASE + 0x40)
#define AUX_MU_IER              (AUX_BASE + 0x44)
#define AUX_MU_IIR              (AUX_BASE + 0x48)
#define AUX_MU_LCR              (AUX_BASE + 0x4C)
#define AUX_MU_LSR              (AUX_BASE + 0x54)
#define AUX_MU_CNTL             (AUX_BASE + 0x60)
#define AUX_MU_BAUD             (AUX_BASE + 0x68)

/* ------------------------------------------------------------------ */
/* PL011 UART (UART0)                                                 */
/* ------------------------------------------------------------------ */

#define UART0_BASE              (BCM_PERIPHERAL_BASE + 0x201000)

#define UART0_DR                (UART0_BASE + 0x00)
#define UART0_RSRECR            (UART0_BASE + 0x04)
#define UART0_FR                (UART0_BASE + 0x18)
#define UART0_ILPR              (UART0_BASE + 0x20)
#define UART0_IBRD              (UART0_BASE + 0x24)
#define UART0_FBRD              (UART0_BASE + 0x28)
#define UART0_LCRH              (UART0_BASE + 0x2C)
#define UART0_CR                (UART0_BASE + 0x30)
#define UART0_IFLS              (UART0_BASE + 0x34)
#define UART0_IMSC              (UART0_BASE + 0x38)
#define UART0_RIS               (UART0_BASE + 0x3C)
#define UART0_MIS               (UART0_BASE + 0x40)
#define UART0_ICR               (UART0_BASE + 0x44)

/* Flag register bits */
#define UART0_FR_TXFF           (1 << 5)    /* Transmit FIFO full */
#define UART0_FR_RXFE           (1 << 4)    /* Receive FIFO empty */
#define UART0_FR_BUSY           (1 << 3)    /* UART busy */

/* Control register bits */
#define UART0_CR_UARTEN         (1 << 0)    /* UART enable */
#define UART0_CR_TXE            (1 << 8)    /* Transmit enable */
#define UART0_CR_RXE            (1 << 9)    /* Receive enable */

/* Line control register bits */
#define UART0_LCRH_FEN          (1 << 4)    /* FIFO enable */
#define UART0_LCRH_WLEN_8       (3 << 5)    /* 8-bit word length */

/* Baud rate: 115200 @ 48MHz clock
 * divisor = 48000000 / (16 * 115200) = 26.041666...
 * integer part = 26, fractional = 0.041666 * 64 + 0.5 = 3 */
#define UART0_IBRD_VAL          26
#define UART0_FBRD_VAL          3

/* ------------------------------------------------------------------ */
/* System Timer                                                       */
/* ------------------------------------------------------------------ */

#define TIMER_BASE              (BCM_PERIPHERAL_BASE + 0x3000)
#define TIMER_CS                (TIMER_BASE + 0x00)
#define TIMER_CLO               (TIMER_BASE + 0x04)  /* Counter lower 32 bits */
#define TIMER_CHI               (TIMER_BASE + 0x08)  /* Counter upper 32 bits */
#define TIMER_C0                (TIMER_BASE + 0x0C)
#define TIMER_C1                (TIMER_BASE + 0x10)
#define TIMER_C2                (TIMER_BASE + 0x14)
#define TIMER_C3                (TIMER_BASE + 0x18)

/* Timer runs at 1 MHz, so each tick = 1 microsecond */
#define TIMER_FREQ_HZ           1000000

/* ------------------------------------------------------------------ */
/* ARM Local Peripherals (GIC, timers, mailboxes)                     */
/* ------------------------------------------------------------------ */

/* ARM Timer (based on ARM SP804, different from system timer) */
#define ARM_TIMER_BASE          (BCM_PERIPHERAL_BASE + 0xB000)
#define ARM_TIMER_LOAD          (ARM_TIMER_BASE + 0x400)
#define ARM_TIMER_VALUE         (ARM_TIMER_BASE + 0x404)
#define ARM_TIMER_CTRL          (ARM_TIMER_BASE + 0x408)
#define ARM_TIMER_IRQCLR        (ARM_TIMER_BASE + 0x40C)
#define ARM_TIMER_RIS           (ARM_TIMER_BASE + 0x410)
#define ARM_TIMER_MIS           (ARM_TIMER_BASE + 0x414)
#define ARM_TIMER_RELOAD        (ARM_TIMER_BASE + 0x418)
#define ARM_TIMER_PREDIV        (ARM_TIMER_BASE + 0x41C)
#define ARM_TIMER_CNTR          (ARM_TIMER_BASE + 0x420)

/* ------------------------------------------------------------------ */
/* VideoCore Mailbox                                                  */
/* ------------------------------------------------------------------ */

#define MAILBOX_BASE            (BCM_PERIPHERAL_BASE + 0xB880)
#define MAILBOX_READ            (MAILBOX_BASE + 0x00)
#define MAILBOX_POLL            (MAILBOX_BASE + 0x10)
#define MAILBOX_SENDER          (MAILBOX_BASE + 0x14)
#define MAILBOX_STATUS          (MAILBOX_BASE + 0x18)
#define MAILBOX_WRITE           (MAILBOX_BASE + 0x20)

/* Mailbox status bits */
#define MAILBOX_STATUS_EMPTY    (1 << 30)
#define MAILBOX_STATUS_FULL     (1 << 31)

/* Mailbox channels */
#define MAILBOX_CH_POWER        0
#define MAILBOX_CH_FB           1   /* Framebuffer */
#define MAILBOX_CH_VUART        2
#define MAILBOX_CH_VCHIQ        3
#define MAILBOX_CH_LEDS         4
#define MAILBOX_CH_BTNS         5
#define MAILBOX_CH_TOUCH        6   /* Touchscreen */
#define MAILBOX_CH_COUNT        7
#define MAILBOX_CH_PROP         8   /* Property tags (ARM -> VC) */

/* ------------------------------------------------------------------ */
/* Framebuffer property tags                                          */
/* ------------------------------------------------------------------ */

#define TagSetPhysWH            0x00048003
#define TagSetVirtWH            0x00048004
#define TagSetDepth             0x00048005
#define TagSetPixelOrder        0x00048006
#define TagSetAlphaMode         0x00048007
#define TagAllocFB              0x00040001
#define TagGetPitch             0x00040008
#define TagGetClockRate         0x00010007

/* ------------------------------------------------------------------ */
/* Interrupt controller                                               */
/* ------------------------------------------------------------------ */

#define IRQ_BASIC_PENDING       (BCM_PERIPHERAL_BASE + 0xB200)
#define IRQ_PENDING_1           (BCM_PERIPHERAL_BASE + 0xB204)
#define IRQ_PENDING_2           (BCM_PERIPHERAL_BASE + 0xB208)
#define IRQ_FIQ_CONTROL         (BCM_PERIPHERAL_BASE + 0xB20C)
#define IRQ_ENABLE_1            (BCM_PERIPHERAL_BASE + 0xB210)
#define IRQ_ENABLE_2            (BCM_PERIPHERAL_BASE + 0xB214)
#define IRQ_ENABLE_BASIC        (BCM_PERIPHERAL_BASE + 0xB218)
#define IRQ_DISABLE_1           (BCM_PERIPHERAL_BASE + 0xB21C)
#define IRQ_DISABLE_2           (BCM_PERIPHERAL_BASE + 0xB220)
#define IRQ_DISABLE_BASIC       (BCM_PERIPHERAL_BASE + 0xB224)

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/* Memory-mapped I/O: volatile to prevent compiler optimization */
#define REG32(addr)             (*(volatile uint32_t *)(uintptr_t)(addr))

/* Memory barriers (required for MMIO on ARM) */
static inline void mmio_write(uint32_t addr, uint32_t val)
{
    __asm__ volatile("dmb st" ::: "memory");
    REG32(addr) = val;
}

static inline uint32_t mmio_read(uint32_t addr)
{
    uint32_t val = REG32(addr);
    __asm__ volatile("dmb ld" ::: "memory");
    return val;
}

/* Delay loop (approximate, for early init before timer is set up) */
static inline void delay_cycles(uint32_t count)
{
    while (count--)
        __asm__ volatile("nop");
}

#endif /* BCM2711_H */
