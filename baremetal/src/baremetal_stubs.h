/*
 * Bare-metal stubs for POSIX functions required by QuickJS
 */

#ifndef BAREMETAL_STUBS_H
#define BAREMETAL_STUBS_H

#include "timer.h"
#include <stdint.h>
#include <stddef.h>
#include <time.h>

/* Clock definitions if not already defined */
#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 1
#endif

#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif

/* Stub clock_gettime using our timer */
static inline int clock_gettime(int clk_id, struct timespec *tp) {
    (void)clk_id;
    uint64_t us = timer_get_us();
    tp->tv_sec = us / 1000000;
    tp->tv_nsec = (us % 1000000) * 1000;
    return 0;
}

/* pthread stubs - single-threaded environment
 * These work with newlib's pthread type definitions
 */

/* Mutex operations - no-op in single-threaded */
static inline int pthread_mutex_init(pthread_mutex_t *mutex, const void *attr) {
    (void)mutex; (void)attr;
    return 0;
}

static inline int pthread_mutex_destroy(pthread_mutex_t *mutex) {
    (void)mutex;
    return 0;
}

static inline int pthread_mutex_lock(pthread_mutex_t *mutex) {
    (void)mutex;
    return 0;
}

static inline int pthread_mutex_unlock(pthread_mutex_t *mutex) {
    (void)mutex;
    return 0;
}

/* Condition variable operations - no-op in single-threaded */
static inline int pthread_condattr_init(pthread_condattr_t *attr) {
    (void)attr;
    return 0;
}

static inline int pthread_condattr_setclock(pthread_condattr_t *attr, int clock_id) {
    (void)attr; (void)clock_id;
    return 0;
}

static inline int pthread_condattr_destroy(pthread_condattr_t *attr) {
    (void)attr;
    return 0;
}

static inline int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr) {
    (void)cond; (void)attr;
    return 0;
}

static inline int pthread_cond_destroy(pthread_cond_t *cond) {
    (void)cond;
    return 0;
}

static inline int pthread_cond_signal(pthread_cond_t *cond) {
    (void)cond;
    return 0;
}

static inline int pthread_cond_broadcast(pthread_cond_t *cond) {
    (void)cond;
    return 0;
}

static inline int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
    (void)cond; (void)mutex;
    return 0;
}

static inline int pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex, const struct timespec *abstime) {
    (void)cond; (void)mutex; (void)abstime;
    return 0;
}

/* Thread operations - stubs */
/* Note: PTHREAD_CREATE_DETACHED is already defined by newlib */

static inline int pthread_attr_init(pthread_attr_t *attr) {
    (void)attr;
    return 0;
}

static inline int pthread_attr_setstacksize(pthread_attr_t *attr, size_t stacksize) {
    (void)attr; (void)stacksize;
    return 0;
}

static inline int pthread_attr_setdetachstate(pthread_attr_t *attr, int detachstate) {
    (void)attr; (void)detachstate;
    return 0;
}

static inline int pthread_attr_destroy(pthread_attr_t *attr) {
    (void)attr;
    return 0;
}

static inline int pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start_routine)(void*), void *arg) {
    (void)thread; (void)attr; (void)start_routine; (void)arg;
    /* Can't create threads in bare-metal, just call the function directly */
    return 0;
}

static inline int pthread_join(pthread_t thread, void **retval) {
    (void)thread; (void)retval;
    return 0;
}

/* pthread_once - execute once */
/* Use a simple zero initializer that works with newlib's structure */
#ifndef PTHREAD_ONCE_INIT
#define PTHREAD_ONCE_INIT {0}
#endif

static inline int pthread_once(pthread_once_t *once_control, void (*init_routine)(void)) {
    /* In single-threaded environment, just check and execute */
    static int initialized = 0;
    if (!initialized) {
        initialized = 1;
        init_routine();
    }
    return 0;
}

#endif /* BAREMETAL_STUBS_H */
