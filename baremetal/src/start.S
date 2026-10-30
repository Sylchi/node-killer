/*
 * start.S - ARM64 startup code for Raspberry Pi 4
 *
 * The GPU firmware loads kernel8.img at address 0x80000 and jumps here.
 * We set up the bare minimum: exception vectors, stack, MMU (identity map),
 * and then call into C main().
 */

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

.section ".text.boot"
.global _start

_start:
    /* We're in EL2 or EL1 depending on firmware config.
     * Drop to EL1 if we're in EL2, set up stack, clear BSS, call main. */

    /* Check current exception level */
    mrs     x0, CurrentEL
    lsr     x0, x0, #2
    cmp     x0, #3
    b.eq    .Lel3
    cmp     x0, #2
    b.eq    .Lel2
    b       .Lel1

.Lel3:
    /* EL3: set up to drop to EL2 first */
    mov     x0, #0x5b1        /* Non-secure EL1, HVC enabled */
    msr     scr_el3, x0
    mov     x0, #0x3c9        /* EL2h, DAIF masked */
    msr     spsr_el3, x0
    adr     x0, .Lel2_entry
    msr     elr_el3, x0
    eret

.Lel2_entry:
.Lel2:
    /* EL2: configure hypervisor, drop to EL1 */
    /* Enable AArch64 for EL1 */
    mrs     x0, hcr_el2
    orr     x0, x0, #0x80000000    /* RW bit: EL1 is AArch64 */
    msr     hcr_el2, x0

    /* Don't trap floating point to EL2 */
    mov     x0, #0x33ff
    msr     cptr_el2, x0
    msr     hstr_el2, xzr

    /* Enable NEON/FP at EL1 */
    mov     x0, #(3 << 20)
    msr     cpacr_el1, x0

    /* Set up stack for EL1 and drop */
    mov     x0, #0x3c5          /* EL1h, DAIF masked */
    msr     spsr_el2, x0
    adr     x0, .Lel1_entry
    msr     elr_el2, x0
    eret

.Lel1_entry:
.Lel1:
    /* We're in EL1 now. Set up the kernel. */

    /* Set up stack pointer. Stack grows down from just before kernel load addr. */
    ldr     x0, =__stack_top
    mov     sp, x0

    /* Enable NEON/FP at EL1 (if not already done) */
    mov     x0, #(3 << 20)
    msr     cpacr_el1, x0
    isb

    /* Invalidate caches before enabling MMU */
    /* (Firmware should have done this, but be safe) */

    /* Clear BSS */
    ldr     x0, =__bss_start
    ldr     x1, =__bss_end
    mov     x2, #0
.Lclear_bss:
    cmp     x0, x1
    b.ge    .Lbss_done
    str     x2, [x0], #8
    b       .Lclear_bss
.Lbss_done:

    /* Jump to C main() */
    bl      main

    /* If main returns, halt */
.Lhalt:
    wfe
    b       .Lhalt

/* ------------------------------------------------------------------ */
/* Exception vectors (minimal - just park on unexpected exceptions)   */
/* ------------------------------------------------------------------ */

/* We need to align vectors to 2KB (0x800) boundary */
.section ".text.vectors", "ax"
.align 11
.global exception_vectors

exception_vectors:
    /* Current EL with SP_EL0 */
    b       .Lexception_park      /* Synchronous */
    .balign 0x80
    b       .Lexception_park      /* IRQ */
    .balign 0x80
    b       .Lexception_park      /* FIQ */
    .balign 0x80
    b       .Lexception_park      /* SError */

    /* Current EL with SP_ELx */
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park

    /* Lower EL using AArch64 */
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park

    /* Lower EL using AArch32 */
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park
    .balign 0x80
    b       .Lexception_park

.Lexception_park:
    /* For now, just park. Later we'll read ESR_EL1 to diagnose. */
    wfe
    b       .Lexception_park

/* ------------------------------------------------------------------ */
/* Install exception vector table into VBAR_EL1                       */
/* ------------------------------------------------------------------ */

.section ".text"
.global install_exception_vectors

install_exception_vectors:
    adr     x0, exception_vectors
    msr     vbar_el1, x0
    isb
    ret
