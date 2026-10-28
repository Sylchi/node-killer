/*
 * WebAssembly support for QuickJS / qnode.
 *
 * Copyright (c) 2026 the qnode authors.
 *
 * MIT license (see LICENSE).
 */

#ifndef QJS_WASM_H
#define QJS_WASM_H

#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Installs the global `WebAssembly` object in `ctx`.  Returns 0 on success and
   -1 if an exception is pending.  When the build has no wasm3 support this is a
   no-op, leaving `typeof WebAssembly` as "undefined". */
JS_EXTERN int js_wasm_init(JSContext *ctx);

/* The `qjs:wasm` C module, exporting the same `WebAssembly` namespace. */
JS_EXTERN JSModuleDef *js_init_module_wasm(JSContext *ctx,
                                            const char *module_name);

/* Runs a WASI command module: instantiates `path` with the given argv and
   calls `_start` (or `_initialize`).  Returns the WASI exit status as a JS
   number, or JS_EXCEPTION. */
JS_EXTERN JSValue js_wasm_run_file(JSContext *ctx, const char *path,
                                   int argc, const char *const *argv);

/* Returns 1 when this build embeds wasm3, 0 otherwise. */
JS_EXTERN int js_wasm_available(void);

#ifdef __cplusplus
}
#endif

#endif /* QJS_WASM_H */
