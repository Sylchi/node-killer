/*
 * Minimal <stdatomic.h> for the JavaScript C compiler.
 *
 * QuickJS only needs the C11 atomic fetch/add helpers that back its
 * single-threaded reference counts. The full generic implementation in GCC's
 * header relies on statement expressions and the generic __atomic builtins,
 * neither of which the compiler implements yet, so this header provides plain
 * (non-atomic) equivalents with the same signatures.
 *
 * The `_Atomic` qualifier itself is accepted by the parser and has no effect.
 */
#ifndef _STDATOMIC_H
#define _STDATOMIC_H

#define __ATOMIC_RELAXED 0
#define __ATOMIC_CONSUME 1
#define __ATOMIC_ACQUIRE 2
#define __ATOMIC_RELEASE 3
#define __ATOMIC_ACQ_REL 4
#define __ATOMIC_SEQ_CST 5

typedef enum {
  memory_order_relaxed = 0,
  memory_order_consume = 1,
  memory_order_acquire = 2,
  memory_order_release = 3,
  memory_order_acq_rel = 4,
  memory_order_seq_cst = 5
} memory_order;

typedef _Bool atomic_bool;
typedef char atomic_char;
typedef signed char atomic_schar;
typedef unsigned char atomic_uchar;
typedef short atomic_short;
typedef unsigned short atomic_ushort;
typedef int atomic_int;
typedef unsigned int atomic_uint;
typedef long atomic_long;
typedef unsigned long atomic_ulong;
typedef long long atomic_llong;
typedef unsigned long long atomic_ullong;
typedef unsigned long atomic_size_t;
typedef long atomic_ptrdiff_t;
typedef unsigned long atomic_uintptr_t;
typedef long atomic_intptr_t;
typedef unsigned int atomic_uint_least8_t;
typedef unsigned int atomic_uint_least16_t;
typedef unsigned int atomic_uint_least32_t;
typedef unsigned long atomic_uint_least64_t;
typedef int atomic_int_least8_t;
typedef int atomic_int_least16_t;
typedef int atomic_int_least32_t;
typedef long atomic_int_least64_t;

#define ATOMIC_VAR_INIT(value) (value)
#define atomic_init(ptr, value) (*(ptr) = (value))

#define atomic_thread_fence(order) ((void)0)
#define atomic_signal_fence(order) ((void)0)
#define atomic_is_lock_free(obj) 1

#define atomic_load(ptr) (*(ptr))
#define atomic_load_explicit(ptr, order) (*(ptr))
#define atomic_store(ptr, value) (*(ptr) = (value))
#define atomic_store_explicit(ptr, value, order) (*(ptr) = (value))

#define atomic_fetch_add(ptr, value) (*(ptr) = *(ptr) + (value), *(ptr) - (value))
#define atomic_fetch_add_explicit(ptr, value, order) atomic_fetch_add(ptr, value)
#define atomic_fetch_sub(ptr, value) (*(ptr) = *(ptr) - (value), *(ptr) + (value))
#define atomic_fetch_sub_explicit(ptr, value, order) atomic_fetch_sub(ptr, value)
#define atomic_fetch_or(ptr, value) (*(ptr) = *(ptr) | (value), *(ptr) & ~(value))
#define atomic_fetch_or_explicit(ptr, value, order) atomic_fetch_or(ptr, value)
#define atomic_fetch_and(ptr, value) (*(ptr) = *(ptr) & (value), *(ptr) | ~(value))
#define atomic_fetch_and_explicit(ptr, value, order) atomic_fetch_and(ptr, value)
#define atomic_fetch_xor(ptr, value) (*(ptr) = *(ptr) ^ (value), *(ptr) ^ (value))
#define atomic_fetch_xor_explicit(ptr, value, order) atomic_fetch_xor(ptr, value)

#define atomic_exchange(ptr, value) (*(ptr) = (value))
#define atomic_exchange_explicit(ptr, value, order) (*(ptr) = (value))

#endif /* _STDATOMIC_H */
