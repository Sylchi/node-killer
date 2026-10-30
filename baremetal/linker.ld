/*
 * linker.ld - Linker script for qnode bare-metal kernel on Pi 4
 *
 * The GPU firmware loads kernel8.img at 0x80000. We lay out:
 *   - .text.boot at 0x80000 (entry point)
 *   - .text, .rodata, .data, .bss follow
 *   - Stack grows down from 0x80000 (below kernel image)
 */

ENTRY(_start)

SECTIONS
{
    /* Kernel is loaded here by the GPU firmware */
    . = 0x80000;

    /* Boot code must be first - this is where the firmware jumps */
    .text.boot : {
        KEEP(*(.text.boot))
    }

    /* Exception vectors need 2KB alignment (enforced in start.S) */
    .text.vectors : {
        KEEP(*(.text.vectors))
    }

    /* Rest of the code */
    .text : {
        *(.text .text.*)
    }

    /* Read-only data */
    .rodata : ALIGN(16) {
        *(.rodata .rodata.*)
    }

    /* Initialized data */
    .data : ALIGN(16) {
        *(.data .data.*)
    }

    /* BSS (zero-initialized) */
    .bss : ALIGN(16) {
        __bss_start = .;
        *(.bss .bss.*)
        *(COMMON)
        __bss_end = .;
    }

    /* End of kernel image */
    __kernel_end = .;

    /* Stack starts at 0x80000 (below the kernel image) and grows down.
     * We reserve 64KB for the initial stack. */
    . = ALIGN(16);
    __stack_bottom = 0x80000 - 0x10000;
    __stack_top = 0x80000;

    /* Provide symbols for BSS clearing in start.S */
    PROVIDE(__bss_start = __bss_start);
    PROVIDE(__bss_end = __bss_end);
}
