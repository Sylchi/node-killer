/*
 * js.h - QuickJS JavaScript engine integration for the qnode bare-metal kernel
 *
 * Owns the QuickJS runtime/context lifecycle and exposes a minimal API for
 * the rest of the kernel (LVGL keyboard callback, boot code).
 */

#ifndef QNODE_JS_H
#define QNODE_JS_H

#ifdef __cplusplus
extern "C" {
#endif

/* Create runtime + context and evaluate the boot test program.
 * Returns 0 on success, -1 on failure. */
int js_init(void);

/* Run pending QuickJS jobs (GC finalizers, promise jobs, etc.). */
void js_step(void);

/* Set a property on the JS global object from C strings. */
void js_push_global_str(const char *name, const char *value);

#ifdef __cplusplus
}
#endif

#endif /* QNODE_JS_H */
