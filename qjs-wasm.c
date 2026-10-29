/*
 * WebAssembly support for QuickJS / qnode.
 *
 * The engine is wasm3 (MIT), linked statically into the core library.  This
 * file implements the WebAssembly JS API on top of it and exposes the result
 * as the global `WebAssembly` object and as the `qjs:wasm` module.
 *
 * What is covered:
 *   WebAssembly.Module / Instance / Memory / Global / Table
 *   WebAssembly.instantiate / compile / validate
 *   JS imports (functions and globals), exported functions, memories, globals
 *   and tables, and WASI preview1 (argv supplied per CLI invocation).
 *
 * Deliberate limits of this first cut:
 *   - imported tables are not linked (wasm3 has no host-table API)
 *   - an imported memory is copied into wasm3's own memory and the JS wrapper is
 *     repointed at it; wasm3 does not accept a host-owned buffer
 *   - compile()/validate() only parse the binary; functions are compiled lazily
 *     by wasm3 on first call
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

#include "cutils.h"
#include "quickjs.h"
#include "qjs-wasm.h"

#if defined(QJS_BUILD_WASM3)

#include "wasm3.h"
#include "m3_env.h"
#include "m3_function.h"
#include "m3_api_wasi.h"

/* ------------------------------------------------------------------ */
/* class ids, one set per runtime                                     */
/* ------------------------------------------------------------------ */

typedef struct QJSWasmClasses {
    JSRuntime *rt;
    JSClassID module;
    JSClassID instance;
    JSClassID memory;
    JSClassID global;
    JSClassID table;
    struct QJSWasmClasses *next;
} QJSWasmClasses;

static QJSWasmClasses *qjs_wasm_classes;
static atomic_flag qjs_wasm_classes_lock = ATOMIC_FLAG_INIT;

/* ------------------------------------------------------------------ */
/* data structures                                                    */
/* ------------------------------------------------------------------ */

typedef struct QJSWasmInstance QJSWasmInstance;

typedef struct QJSWasmImport {
    JSContext *ctx;
    QJSWasmInstance *inst;
    JSValue func;
} QJSWasmImport;

struct QJSWasmInstance {
    QJSWasmClasses *classes;
    IM3Environment env;
    IM3Runtime runtime;
    IM3Module module;
    bool module_loaded;

    M3WASI wasi;
    char **wasi_argv;
    uint32_t wasi_argc;

    uint8_t *wasm_bytes;
    size_t wasm_len;

    QJSWasmImport *imports;
    uint32_t num_imports;

    JSValue *memories;          /* cached WebAssembly.Memory per memory index */
    uint32_t num_memories;

    bool pending_exception;
    bool exited;
    uint32_t exit_code;
};

typedef struct QJSWasmModule {
    uint8_t *bytes;
    size_t len;
    JSValue exports;
    JSValue imports;
} QJSWasmModule;

typedef struct QJSWasmMemory {
    JSValue owner;              /* instance object, or undefined when standalone */
    QJSWasmInstance *inst;      /* NULL for a standalone Memory */
    uint32_t index;
    uint8_t *data;              /* standalone backing store */
    uint64_t pages;
    uint64_t max_pages;
    bool shared;
    JSValue buffer;
    bool has_buffer;
} QJSWasmMemory;

typedef union QJSWasmValue {
    uint32_t i32;
    uint64_t i64;
    float f32;
    double f64;
} QJSWasmValue;

typedef struct QJSWasmGlobal {
    JSValue owner;
    uint32_t export_index;
    bool standalone;
    M3ValueType type;
    bool is_mutable;
    QJSWasmValue value;
} QJSWasmGlobal;

typedef struct QJSWasmTable {
    JSValue owner;
    uint32_t export_index;
    bool standalone;
    JSValue *elems;
    uint32_t length;
    uint32_t max_length;
} QJSWasmTable;

static JSValue js_wasm_instantiate_internal(JSContext *ctx,
                                            JSValueConst module_or_bytes,
                                            JSValueConst imports,
                                            const char *const *argv,
                                            int argc);

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

/* Give a fresh Error the WebAssembly.<name> prototype so that
   `e instanceof WebAssembly.CompileError` works. */
static JSValue js_wasm_new_error(JSContext *ctx, const char *name)
{
    JSValue err = JS_NewError(ctx);
    JSValue global, wasm, ctor, proto;

    if (JS_IsException(err))
        return err;
    global = JS_GetGlobalObject(ctx);
    wasm = JS_GetPropertyStr(ctx, global, "WebAssembly");
    ctor = JS_GetPropertyStr(ctx, wasm, name);
    proto = JS_GetPropertyStr(ctx, ctor, "prototype");
    if (JS_IsObject(proto))
        JS_SetPrototype(ctx, err, proto);
    JS_FreeValue(ctx, proto);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, wasm);
    JS_FreeValue(ctx, global);
    return err;
}

static JSValue js_wasm_throw(JSContext *ctx, const char *name,
                             const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    JSValue err;

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    err = js_wasm_new_error(ctx, name);
    if (JS_IsException(err))
        return err;
    JS_DefinePropertyValueStr(ctx, err, "name", JS_NewString(ctx, name),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, buf),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, err);
}

static JSValue js_wasm_throw_wasi_exit(JSContext *ctx, uint32_t code)
{
    JSValue err = js_wasm_new_error(ctx, "RuntimeError");
    if (JS_IsException(err))
        return err;
    JS_DefinePropertyValueStr(ctx, err, "name",
                              JS_NewString(ctx, "RuntimeError"),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, err, "message",
                              JS_NewString(ctx, "WASI program called exit"),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, err, "wasiExitCode",
                              JS_NewInt64(ctx, (int64_t)code),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, err);
}

static JSValue js_wasm_get_property(JSContext *ctx, JSValueConst obj,
                                    const char *name)
{
    if (!JS_IsObject(obj))
        return JS_UNDEFINED;
    return JS_GetPropertyStr(ctx, obj, name);
}

static bool js_wasm_get_bytes(JSContext *ctx, JSValueConst val,
                              const uint8_t **out, size_t *out_len,
                              JSValue *keep_alive)
{
    size_t offset = 0, len = 0, bpe = 1;

    *keep_alive = JS_UNDEFINED;

    if (JS_IsArrayBuffer(val)) {
        *out = JS_GetArrayBuffer(ctx, &len, val);
        if (!*out && len != 0)
            return false;
        *out_len = len;
        return true;
    }

    if (JS_GetTypedArrayType(val) >= 0) {
        JSValue ab = JS_GetTypedArrayBuffer(ctx, val, &offset, &len, &bpe);
        const uint8_t *base;
        size_t ab_len;
        if (JS_IsException(ab))
            return false;
        base = JS_GetArrayBuffer(ctx, &ab_len, ab);
        if (!base && ab_len != 0) {
            JS_FreeValue(ctx, ab);
            return false;
        }
        if (offset > ab_len || len > ab_len - offset) {
            JS_FreeValue(ctx, ab);
            js_wasm_throw(ctx, "TypeError", "invalid typed array");
            return false;
        }
        *keep_alive = ab;
        *out = base + offset;
        *out_len = len;
        return true;
    }

    js_wasm_throw(ctx, "TypeError",
                  "WebAssembly: argument must be an ArrayBuffer or typed array");
    return false;
}

static uint8_t *js_wasm_copy_bytes(JSContext *ctx, const uint8_t *src,
                                   size_t len)
{
    uint8_t *p = js_malloc(ctx, len ? len : 1);
    if (!p)
        return NULL;
    if (len)
        memcpy(p, src, len);
    return p;
}

/* The ArrayBuffer handed out for a memory keeps its owner alive.  quickjs
   calls the realloc hook with size 0 when the buffer is detached or freed. */
static void *js_wasm_buffer_realloc(JSRuntime *rt, void *opaque,
                                    void *ptr, size_t size)
{
    JSValue *owner = opaque;
    (void)ptr;
    if (size == 0) {
        JS_FreeValueRT(rt, *owner);
        js_free_rt(rt, owner);
    }
    return NULL;
}

static JSValue js_wasm_new_buffer_owned(JSContext *ctx, uint8_t *ptr,
                                        size_t len, JSValueConst owner)
{
    JSValue *opaque = js_malloc(ctx, sizeof(*opaque));
    JSValue buf;
    if (!opaque)
        return JS_EXCEPTION;
    *opaque = JS_DupValue(ctx, owner);
    buf = JS_NewArrayBuffer(ctx, ptr, len, 0, js_wasm_buffer_realloc,
                            opaque, false);
    if (JS_IsException(buf)) {
        JS_FreeValue(ctx, *opaque);
        js_free(ctx, opaque);
    }
    return buf;
}

/* ------------------------------------------------------------------ */
/* class registration                                                 */
/* ------------------------------------------------------------------ */

static void js_wasm_module_finalizer(JSRuntime *rt, JSValueConst val);
static void js_wasm_module_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func);
static void js_wasm_instance_finalizer(JSRuntime *rt, JSValueConst val);
static void js_wasm_instance_mark(JSRuntime *rt, JSValueConst val,
                                  JS_MarkFunc *mark_func);
static void js_wasm_memory_finalizer(JSRuntime *rt, JSValueConst val);
static void js_wasm_memory_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func);
static void js_wasm_global_finalizer(JSRuntime *rt, JSValueConst val);
static void js_wasm_global_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func);
static void js_wasm_table_finalizer(JSRuntime *rt, JSValueConst val);
static void js_wasm_table_mark(JSRuntime *rt, JSValueConst val,
                               JS_MarkFunc *mark_func);

/* Drop the class registration belonging to a runtime that is being
   destroyed. Without this the entry would point into freed runtime memory
   and confuse the next runtime that happens to reuse the same address. */
static void js_wasm_classes_finalize(JSRuntime *rt, void *opaque)
{
    QJSWasmClasses *c = opaque;
    QJSWasmClasses **p;

    while (atomic_flag_test_and_set(&qjs_wasm_classes_lock))
        ;
    for (p = &qjs_wasm_classes; *p; p = &(*p)->next) {
        if (*p == c) {
            *p = c->next;
            break;
        }
    }
    atomic_flag_clear(&qjs_wasm_classes_lock);
    js_free_rt(rt, c);
}

static QJSWasmClasses *js_wasm_classes(JSRuntime *rt)
{
    QJSWasmClasses *c;

    while (atomic_flag_test_and_set(&qjs_wasm_classes_lock))
        ;
    for (c = qjs_wasm_classes; c; c = c->next) {
        if (c->rt == rt) {
            /* The entry is removed from the list when its runtime is freed,
               so it must still describe a live runtime here. */
            if (JS_IsRegisteredClass(rt, c->module))
                break;
            /* Defensive: re-register if the ids were cleared. */
            c->module = 0;
            c->instance = 0;
            c->memory = 0;
            c->global = 0;
            c->table = 0;
            goto register_classes;
        }
    }
    if (!c) {
        c = js_malloc_rt(rt, sizeof(*c));
        if (!c) {
            atomic_flag_clear(&qjs_wasm_classes_lock);
            return NULL;
        }
        memset(c, 0, sizeof(*c));
        c->rt = rt;
        c->next = qjs_wasm_classes;
        qjs_wasm_classes = c;
        /* Register while holding the lock so no other thread observes the
           entry before its class ids are initialized. */
        if (JS_AddRuntimeFinalizer(rt, js_wasm_classes_finalize, c) < 0) {
            qjs_wasm_classes = c->next;
            atomic_flag_clear(&qjs_wasm_classes_lock);
            js_free_rt(rt, c);
            return NULL;
        }
    }
register_classes:
    {
        static const JSClassDef module_class = {
            "WebAssembly.Module",
            .finalizer = js_wasm_module_finalizer,
            .gc_mark = js_wasm_module_mark,
        };
        static const JSClassDef instance_class = {
            "WebAssembly.Instance",
            .finalizer = js_wasm_instance_finalizer,
            .gc_mark = js_wasm_instance_mark,
        };
        static const JSClassDef memory_class = {
            "WebAssembly.Memory",
            .finalizer = js_wasm_memory_finalizer,
            .gc_mark = js_wasm_memory_mark,
        };
        static const JSClassDef global_class = {
            "WebAssembly.Global",
            .finalizer = js_wasm_global_finalizer,
            .gc_mark = js_wasm_global_mark,
        };
        static const JSClassDef table_class = {
            "WebAssembly.Table",
            .finalizer = js_wasm_table_finalizer,
            .gc_mark = js_wasm_table_mark,
        };

        JS_NewClassID(rt, &c->module);
        JS_NewClass(rt, c->module, &module_class);
        JS_NewClassID(rt, &c->instance);
        JS_NewClass(rt, c->instance, &instance_class);
        JS_NewClassID(rt, &c->memory);
        JS_NewClass(rt, c->memory, &memory_class);
        JS_NewClassID(rt, &c->global);
        JS_NewClass(rt, c->global, &global_class);
        JS_NewClassID(rt, &c->table);
        JS_NewClass(rt, c->table, &table_class);
    }
    atomic_flag_clear(&qjs_wasm_classes_lock);
    return c;
}

/* ------------------------------------------------------------------ */
/* value conversion                                                   */
/* ------------------------------------------------------------------ */

static bool js_to_wasm_value(JSContext *ctx, M3ValueType type,
                             JSValueConst v, uint64_t *slot)
{
    switch (type) {
    case c_m3Type_i32: {
        int32_t n = 0;
        if (JS_ToInt32(ctx, &n, v))
            return false;
        *(uint32_t *)slot = (uint32_t)n;
        return true;
    }
    case c_m3Type_i64: {
        int64_t n = 0;
        if (JS_IsBigInt(v)) {
            if (JS_ToBigInt64(ctx, &n, v))
                return false;
        } else {
            if (JS_ToInt64Ext(ctx, &n, v))
                return false;
        }
        *(int64_t *)slot = n;
        return true;
    }
    case c_m3Type_f32: {
        double d;
        float f;
        if (JS_ToFloat64(ctx, &d, v))
            return false;
        f = (float)d;
        memcpy(slot, &f, sizeof(f));
        return true;
    }
    case c_m3Type_f64: {
        double d;
        if (JS_ToFloat64(ctx, &d, v))
            return false;
        memcpy(slot, &d, sizeof(d));
        return true;
    }
    case c_m3Type_funcref:
    case c_m3Type_externref:
    case c_m3Type_exnref:
    case c_m3Type_contref:
        *(uintptr_t *)slot = 0;
        return true;
    default:
        js_wasm_throw(ctx, "TypeError",
                      "unsupported WebAssembly value type %d", (int)type);
        return false;
    }
}

static JSValue wasm_to_js_value(JSContext *ctx, M3ValueType type,
                                const uint64_t *slot)
{
    switch (type) {
    case c_m3Type_i32:
        return JS_NewInt32(ctx, *(const int32_t *)slot);
    case c_m3Type_i64:
        return JS_NewBigInt64(ctx, *(const int64_t *)slot);
    case c_m3Type_f32: {
        float f;
        memcpy(&f, slot, sizeof(f));
        return JS_NewFloat64(ctx, (double)f);
    }
    case c_m3Type_f64: {
        double d;
        memcpy(&d, slot, sizeof(d));
        return JS_NewFloat64(ctx, d);
    }
    case c_m3Type_funcref:
    case c_m3Type_externref:
    case c_m3Type_exnref:
    case c_m3Type_contref:
        return JS_NULL;
    default:
        return JS_UNDEFINED;
    }
}

/* ------------------------------------------------------------------ */
/* instance lifetime                                                  */
/* ------------------------------------------------------------------ */

static void js_wasm_instance_free(JSRuntime *rt, QJSWasmInstance *inst)
{
    uint32_t i;

    if (!inst)
        return;
    for (i = 0; i < inst->num_imports; i++)
        JS_FreeValueRT(rt, inst->imports[i].func);
    js_free_rt(rt, inst->imports);
    for (i = 0; i < inst->num_memories; i++)
        JS_FreeValueRT(rt, inst->memories[i]);
    js_free_rt(rt, inst->memories);
    if (inst->module_loaded) {
        if (inst->runtime)
            m3_FreeRuntime(inst->runtime);
    } else {
        if (inst->module)
            m3_FreeModule(inst->module);
        if (inst->runtime)
            m3_FreeRuntime(inst->runtime);
    }
    if (inst->env)
        m3_FreeEnvironment(inst->env);
    if (inst->wasi)
        m3_FreeCustomWASI(inst->wasi);
    for (i = 0; i < inst->wasi_argc; i++)
        js_free_rt(rt, inst->wasi_argv[i]);
    js_free_rt(rt, inst->wasi_argv);
    js_free_rt(rt, inst->wasm_bytes);
    js_free_rt(rt, inst);
}

static void js_wasm_module_finalizer(JSRuntime *rt, JSValueConst val)
{
    QJSWasmModule *m = JS_GetOpaque(val, js_wasm_classes(rt)->module);
    if (m) {
        js_free_rt(rt, m->bytes);
        JS_FreeValueRT(rt, m->exports);
        JS_FreeValueRT(rt, m->imports);
        js_free_rt(rt, m);
    }
}

static void js_wasm_module_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func)
{
    QJSWasmModule *m = JS_GetOpaque(val, js_wasm_classes(rt)->module);
    if (m) {
        JS_MarkValue(rt, m->exports, mark_func);
        JS_MarkValue(rt, m->imports, mark_func);
    }
}

static void js_wasm_instance_finalizer(JSRuntime *rt, JSValueConst val)
{
    QJSWasmInstance *inst =
        JS_GetOpaque(val, js_wasm_classes(rt)->instance);
    js_wasm_instance_free(rt, inst);
}

static void js_wasm_instance_mark(JSRuntime *rt, JSValueConst val,
                                  JS_MarkFunc *mark_func)
{
    QJSWasmInstance *inst =
        JS_GetOpaque(val, js_wasm_classes(rt)->instance);
    uint32_t i;
    if (!inst)
        return;
    for (i = 0; i < inst->num_imports; i++)
        JS_MarkValue(rt, inst->imports[i].func, mark_func);
    for (i = 0; i < inst->num_memories; i++)
        JS_MarkValue(rt, inst->memories[i], mark_func);
}

static void js_wasm_memory_finalizer(JSRuntime *rt, JSValueConst val)
{
    QJSWasmMemory *m = JS_GetOpaque(val, js_wasm_classes(rt)->memory);
    if (m) {
        if (m->has_buffer)
            JS_FreeValueRT(rt, m->buffer);
        JS_FreeValueRT(rt, m->owner);
        if (!m->inst)
            js_free_rt(rt, m->data);
        js_free_rt(rt, m);
    }
}

static void js_wasm_memory_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func)
{
    QJSWasmMemory *m = JS_GetOpaque(val, js_wasm_classes(rt)->memory);
    if (m) {
        JS_MarkValue(rt, m->owner, mark_func);
        if (m->has_buffer)
            JS_MarkValue(rt, m->buffer, mark_func);
    }
}

static void js_wasm_global_finalizer(JSRuntime *rt, JSValueConst val)
{
    QJSWasmGlobal *g = JS_GetOpaque(val, js_wasm_classes(rt)->global);
    if (g) {
        JS_FreeValueRT(rt, g->owner);
        js_free_rt(rt, g);
    }
}

static void js_wasm_global_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func)
{
    QJSWasmGlobal *g = JS_GetOpaque(val, js_wasm_classes(rt)->global);
    if (g)
        JS_MarkValue(rt, g->owner, mark_func);
}

static void js_wasm_table_finalizer(JSRuntime *rt, JSValueConst val)
{
    QJSWasmTable *t = JS_GetOpaque(val, js_wasm_classes(rt)->table);
    if (t) {
        uint32_t i;
        JS_FreeValueRT(rt, t->owner);
        if (t->standalone) {
            for (i = 0; i < t->length; i++)
                JS_FreeValueRT(rt, t->elems[i]);
            js_free_rt(rt, t->elems);
        }
        js_free_rt(rt, t);
    }
}

static void js_wasm_table_mark(JSRuntime *rt, JSValueConst val,
                               JS_MarkFunc *mark_func)
{
    QJSWasmTable *t = JS_GetOpaque(val, js_wasm_classes(rt)->table);
    uint32_t i;
    if (!t)
        return;
    JS_MarkValue(rt, t->owner, mark_func);
    if (t->standalone) {
        for (i = 0; i < t->length; i++)
            JS_MarkValue(rt, t->elems[i], mark_func);
    }
}

/* ------------------------------------------------------------------ */
/* imported JS functions                                              */
/* ------------------------------------------------------------------ */

static const void *js_wasm_import_trampoline(IM3Runtime runtime,
                                             IM3ImportContext ictx,
                                             uint64_t *sp, void *mem)
{
    QJSWasmImport *imp = ictx->userdata;
    QJSWasmInstance *inst;
    IM3FuncType ft;
    JSContext *ctx;
    JSValue argv[32];
    JSValue *argvp = argv;
    JSValue ret;
    uint32_t i, nargs, nrets;
    bool allocated = false;

    (void)runtime;
    (void)mem;

    if (!imp || !imp->ctx || JS_IsUndefined(imp->func))
        return m3Err_trapUnreachable;

    ctx = imp->ctx;
    inst = imp->inst;
    ft = ictx->function->funcType;
    nargs = ft->numArgs;
    nrets = ft->numRets;

    if (nargs > 32) {
        argvp = js_malloc(ctx, sizeof(JSValue) * nargs);
        if (!argvp) {
            JS_ThrowOutOfMemory(ctx);
            inst->pending_exception = true;
            return m3Err_trapUncaughtException;
        }
        allocated = true;
    }
    for (i = 0; i < nargs; i++)
        argvp[i] = wasm_to_js_value(ctx, ft->types[nrets + i],
                                    &sp[nrets + i]);

    ret = JS_Call(ctx, imp->func, JS_UNDEFINED, (int)nargs, argvp);
    for (i = 0; i < nargs; i++)
        JS_FreeValue(ctx, argvp[i]);
    if (allocated)
        js_free(ctx, argvp);

    if (JS_IsException(ret)) {
        inst->pending_exception = true;
        return m3Err_trapUncaughtException;
    }

    if (nrets == 1) {
        if (!js_to_wasm_value(ctx, ft->types[0], ret, &sp[0])) {
            JS_FreeValue(ctx, ret);
            inst->pending_exception = true;
            return m3Err_trapUncaughtException;
        }
    } else if (nrets > 1) {
        if (!JS_IsArray(ret)) {
            JS_FreeValue(ctx, ret);
            js_wasm_throw(ctx, "TypeError",
                          "a WebAssembly import with %u results must return an array",
                          nrets);
            inst->pending_exception = true;
            return m3Err_trapUncaughtException;
        }
        for (i = 0; i < nrets; i++) {
            JSValue v = JS_GetPropertyUint32(ctx, ret, i);
            bool ok;
            if (JS_IsException(v))
                ok = false;
            else
                ok = js_to_wasm_value(ctx, ft->types[i], v, &sp[i]);
            JS_FreeValue(ctx, v);
            if (!ok) {
                JS_FreeValue(ctx, ret);
                inst->pending_exception = true;
                return m3Err_trapUncaughtException;
            }
        }
    }
    JS_FreeValue(ctx, ret);
    return m3Err_none;
}

/* ------------------------------------------------------------------ */
/* module metadata                                                    */
/* ------------------------------------------------------------------ */

static const char *js_wasm_export_kind(uint8_t kind)
{
    switch (kind) {
    case d_externalKind_function: return "function";
    case d_externalKind_table: return "table";
    case d_externalKind_memory: return "memory";
    case d_externalKind_global: return "global";
    case d_externalKind_tag: return "tag";
    default: return "unknown";
    }
}

static JSValue js_wasm_build_exports_metadata(JSContext *ctx, IM3Module mod)
{
    JSValue arr = JS_NewArray(ctx);
    uint32_t i;
    if (JS_IsException(arr))
        return arr;
    for (i = 0; i < mod->numExports; i++) {
        M3Export *ex = &mod->exports[i];
        JSValue o = JS_NewObject(ctx);
        if (JS_IsException(o))
            goto fail;
        JS_SetPropertyStr(ctx, o, "name", JS_NewString(ctx, ex->name));
        JS_SetPropertyStr(ctx, o, "kind",
                          JS_NewString(ctx, js_wasm_export_kind(ex->kind)));
        if (JS_SetPropertyUint32(ctx, arr, i, o) < 0)
            goto fail;
    }
    return arr;
fail:
    JS_FreeValue(ctx, arr);
    return JS_EXCEPTION;
}

static JSValue js_wasm_build_imports_metadata(JSContext *ctx, IM3Module mod)
{
    JSValue arr = JS_NewArray(ctx);
    uint32_t i, n = 0;
    if (JS_IsException(arr))
        return arr;

    for (i = 0; i < mod->numFunctions; i++) {
        IM3Function f = &mod->functions[i];
        JSValue o;
        if (!f->import.moduleUtf8 || !f->import.fieldUtf8)
            continue;
        o = JS_NewObject(ctx);
        if (JS_IsException(o))
            goto fail;
        JS_SetPropertyStr(ctx, o, "module",
                          JS_NewString(ctx, f->import.moduleUtf8));
        JS_SetPropertyStr(ctx, o, "name",
                          JS_NewString(ctx, f->import.fieldUtf8));
        JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, "function"));
        if (JS_SetPropertyUint32(ctx, arr, n++, o) < 0)
            goto fail;
    }

    for (i = 0; i < mod->numGlobals; i++) {
        IM3Global g = &mod->globals[i];
        JSValue o;
        if (!g->imported || !g->import.moduleUtf8 || !g->import.fieldUtf8)
            continue;
        o = JS_NewObject(ctx);
        if (JS_IsException(o))
            goto fail;
        JS_SetPropertyStr(ctx, o, "module",
                          JS_NewString(ctx, g->import.moduleUtf8));
        JS_SetPropertyStr(ctx, o, "name",
                          JS_NewString(ctx, g->import.fieldUtf8));
        JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, "global"));
        if (JS_SetPropertyUint32(ctx, arr, n++, o) < 0)
            goto fail;
    }

    for (i = 0; i < mod->numMemories; i++) {
        IM3Memory mem = mod->memories[i];
        JSValue o;
        if (!mem->imported || !mem->import.moduleUtf8 ||
            !mem->import.fieldUtf8)
            continue;
        o = JS_NewObject(ctx);
        if (JS_IsException(o))
            goto fail;
        JS_SetPropertyStr(ctx, o, "module",
                          JS_NewString(ctx, mem->import.moduleUtf8));
        JS_SetPropertyStr(ctx, o, "name",
                          JS_NewString(ctx, mem->import.fieldUtf8));
        JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, "memory"));
        if (JS_SetPropertyUint32(ctx, arr, n++, o) < 0)
            goto fail;
    }

    for (i = 0; i < mod->numTables; i++) {
        IM3Table tab = mod->tables[i];
        JSValue o;
        if (!tab->imported || !tab->import.moduleUtf8 ||
            !tab->import.fieldUtf8)
            continue;
        o = JS_NewObject(ctx);
        if (JS_IsException(o))
            goto fail;
        JS_SetPropertyStr(ctx, o, "module",
                          JS_NewString(ctx, tab->import.moduleUtf8));
        JS_SetPropertyStr(ctx, o, "name",
                          JS_NewString(ctx, tab->import.fieldUtf8));
        JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, "table"));
        if (JS_SetPropertyUint32(ctx, arr, n++, o) < 0)
            goto fail;
    }

    return arr;
fail:
    JS_FreeValue(ctx, arr);
    return JS_EXCEPTION;
}

/* ------------------------------------------------------------------ */
/* WebAssembly.Memory                                                 */
/* ------------------------------------------------------------------ */

static JSValue js_wasm_memory_create(JSContext *ctx, QJSWasmInstance *inst,
                                     uint32_t index, JSValueConst owner,
                                     uint8_t *data, uint64_t pages,
                                     uint64_t max_pages, bool shared);

static JSValue js_wasm_memory_export(JSContext *ctx, QJSWasmInstance *inst,
                                     uint32_t index,
                                     JSValueConst instance_obj)
{
    JSValue v;

    if (index < inst->num_memories &&
        !JS_IsUndefined(inst->memories[index]))
        return JS_DupValue(ctx, inst->memories[index]);
    v = js_wasm_memory_create(ctx, inst, index, instance_obj, NULL, 0, 0,
                              false);
    if (JS_IsException(v))
        return v;
    if (index < inst->num_memories)
        inst->memories[index] = JS_DupValue(ctx, v);
    return v;
}

static JSValue js_wasm_memory_create(JSContext *ctx, QJSWasmInstance *inst,
                                     uint32_t index, JSValueConst owner,
                                     uint8_t *data, uint64_t pages,
                                     uint64_t max_pages, bool shared)
{
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    QJSWasmMemory *m = js_mallocz(ctx, sizeof(*m));
    JSValue obj;
    if (!m)
        return JS_EXCEPTION;
    m->owner = JS_DupValue(ctx, owner);
    m->inst = inst;
    m->index = index;
    m->data = data;
    m->pages = pages;
    m->max_pages = max_pages;
    m->shared = shared;
    m->buffer = JS_UNDEFINED;

    obj = JS_NewObjectClass(ctx, c->memory);
    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, m->owner);
        js_free(ctx, m);
        return obj;
    }
    JS_SetOpaque(obj, m);
    return obj;
}

static JSValue js_wasm_memory_ctor(JSContext *ctx, JSValueConst new_target,
                                   int argc, JSValueConst *argv)
{
    JSValue desc, initial_v, maximum_v, shared_v;
    int64_t initial, maximum = 65536;
    bool shared_f = false;
    uint64_t bytes;
    uint8_t *data;
    QJSWasmMemory *m;
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    JSValue obj;

    (void)new_target;
    if (argc < 1 || !JS_IsObject(argv[0]))
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Memory requires a descriptor object");
    desc = argv[0];
    initial_v = JS_GetPropertyStr(ctx, desc, "initial");
    maximum_v = JS_GetPropertyStr(ctx, desc, "maximum");
    shared_v = JS_GetPropertyStr(ctx, desc, "shared");

    if (JS_ToInt64(ctx, &initial, initial_v) < 0)
        goto fail;
    if (!JS_IsUndefined(maximum_v)) {
        if (JS_ToInt64(ctx, &maximum, maximum_v) < 0)
            goto fail;
    }
    shared_f = JS_ToBool(ctx, shared_v) > 0;
    JS_FreeValue(ctx, initial_v);
    JS_FreeValue(ctx, maximum_v);
    JS_FreeValue(ctx, shared_v);

    if (initial < 0 || initial > 65536 || maximum < initial ||
        maximum > 65536)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Memory: invalid initial/maximum");

    bytes = (uint64_t)initial * 65536;
    if (bytes > SIZE_MAX)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Memory: too large");
    data = js_mallocz(ctx, bytes ? (size_t)bytes : 1);
    if (!data)
        return JS_EXCEPTION;

    m = js_mallocz(ctx, sizeof(*m));
    if (!m) {
        js_free(ctx, data);
        return JS_EXCEPTION;
    }
    m->owner = JS_UNDEFINED;
    m->inst = NULL;
    m->data = data;
    m->pages = (uint64_t)initial;
    m->max_pages = (uint64_t)maximum;
    m->shared = shared_f;
    m->buffer = JS_UNDEFINED;

    obj = JS_NewObjectClass(ctx, c->memory);
    if (JS_IsException(obj)) {
        js_free(ctx, data);
        js_free(ctx, m);
        return obj;
    }
    JS_SetOpaque(obj, m);
    return obj;

fail:
    JS_FreeValue(ctx, initial_v);
    JS_FreeValue(ctx, maximum_v);
    JS_FreeValue(ctx, shared_v);
    return JS_EXCEPTION;
}

static JSValue js_wasm_memory_get_buffer(JSContext *ctx, JSValueConst this_val)
{
    QJSWasmMemory *m =
        JS_GetOpaque2(ctx, this_val, js_wasm_classes(JS_GetRuntime(ctx))->memory);
    uint8_t *ptr;
    size_t len;

    if (!m)
        return JS_EXCEPTION;

    if (m->inst && m->inst->module) {
        ptr = m3_GetMemory(m->inst->module, &len, m->index);
        if (!ptr) {
            /* A zero-page memory has no backing store; hand out an empty
               buffer rather than null. */
            len = 0;
        }
    } else {
        ptr = m->data;
        len = (size_t)(m->pages * 65536);
    }
    if (!ptr)
        ptr = (uint8_t *)"";

    if (m->has_buffer)
        return JS_DupValue(ctx, m->buffer);

    {
        JSValue owner = JS_IsUndefined(m->owner) ? this_val : m->owner;
        JSValue buf = js_wasm_new_buffer_owned(ctx, ptr, len, owner);
        if (JS_IsException(buf))
            return buf;
        m->buffer = buf;
        m->has_buffer = true;
        return JS_DupValue(ctx, buf);
    }
}

static JSValue js_wasm_memory_get_byte_length(JSContext *ctx,
                                              JSValueConst this_val)
{
    QJSWasmMemory *m =
        JS_GetOpaque2(ctx, this_val, js_wasm_classes(JS_GetRuntime(ctx))->memory);
    if (!m)
        return JS_EXCEPTION;
    if (m->inst && m->inst->module) {
        size_t len = m3_GetMemorySize(m->inst->module, m->index);
        return JS_NewInt64(ctx, (int64_t)len);
    }
    return JS_NewInt64(ctx, (int64_t)(m->pages * 65536));
}

static void js_wasm_memory_invalidate_buffer(JSContext *ctx,
                                             QJSWasmMemory *m)
{
    if (m->has_buffer) {
        JS_DetachArrayBuffer(ctx, m->buffer);
        JS_FreeValue(ctx, m->buffer);
        m->buffer = JS_UNDEFINED;
        m->has_buffer = false;
    }
}

static JSValue js_wasm_memory_grow(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QJSWasmMemory *m =
        JS_GetOpaque2(ctx, this_val, js_wasm_classes(JS_GetRuntime(ctx))->memory);
    int64_t delta = 0, old_pages;
    uint64_t new_pages;

    if (!m)
        return JS_EXCEPTION;
    if (argc < 1 || JS_ToInt64(ctx, &delta, argv[0]) < 0)
        return JS_EXCEPTION;
    if (delta < 0)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Memory.grow: negative delta");

    if (m->inst && m->inst->module) {
        IM3Memory mem;
        M3Result res;
        if (m->index >= m->inst->module->numMemories)
            return js_wasm_throw(ctx, "RangeError", "invalid memory index");
        mem = m->inst->module->memories[m->index];
        old_pages = (int64_t)mem->numPages;
        new_pages = (uint64_t)old_pages + (uint64_t)delta;
        if (new_pages > mem->maxPages)
            return js_wasm_throw(ctx, "RangeError",
                                 "WebAssembly.Memory.grow: maximum exceeded");
        res = ResizeMemory(m->inst->runtime, mem, new_pages);
        if (res)
            return js_wasm_throw(ctx, "RangeError",
                                 "WebAssembly.Memory.grow: %s", res);
        js_wasm_memory_invalidate_buffer(ctx, m);
        return JS_NewInt64(ctx, old_pages);
    }

    old_pages = (int64_t)m->pages;
    new_pages = m->pages + (uint64_t)delta;
    if (new_pages > m->max_pages)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Memory.grow: maximum exceeded");
    if (new_pages > SIZE_MAX / 65536)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Memory.grow: too large");
    {
        uint8_t *p = js_realloc(ctx, m->data,
                                new_pages ? (size_t)(new_pages * 65536) : 1);
        if (!p)
            return JS_EXCEPTION;
        if (new_pages > m->pages)
            memset(p + m->pages * 65536, 0,
                   (size_t)((new_pages - m->pages) * 65536));
        m->data = p;
        m->pages = new_pages;
    }
    js_wasm_memory_invalidate_buffer(ctx, m);
    return JS_NewInt64(ctx, old_pages);
}

/* ------------------------------------------------------------------ */
/* exported functions                                                 */
/* ------------------------------------------------------------------ */

static JSValue js_wasm_call_function(JSContext *ctx, QJSWasmInstance *inst,
                                     IM3Function fn, int argc,
                                     JSValueConst *argv)
{
    uint32_t nargs = m3_GetArgCount(fn);
    uint32_t nrets = m3_GetRetCount(fn);
    uint64_t args[16], rets[4];
    uint64_t *argsp = args, *retsp = rets;
    const void *argptrs[16], *retptrs[4];
    const void **argptrsp = argptrs, **retptrsp = retptrs;
    uint32_t i;
    M3Result res;
    JSValue ret;
    bool allocated = false;

    if ((int)nargs != argc)
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly function expects %u arguments, got %d",
                             nargs, argc);
    if (nargs > 16 || nrets > 4) {
        argsp = js_mallocz(ctx, sizeof(uint64_t) * (nargs ? nargs : 1));
        argptrsp = js_mallocz(ctx, sizeof(void *) * (nargs ? nargs : 1));
        retsp = js_mallocz(ctx, sizeof(uint64_t) * (nrets ? nrets : 1));
        retptrsp = js_mallocz(ctx, sizeof(void *) * (nrets ? nrets : 1));
        if (!argsp || !argptrsp || !retsp || !retptrsp) {
            js_free(ctx, argsp);
            js_free(ctx, argptrsp);
            js_free(ctx, retsp);
            js_free(ctx, retptrsp);
            return JS_ThrowOutOfMemory(ctx);
        }
        allocated = true;
    }

    for (i = 0; i < nargs; i++) {
        if (!js_to_wasm_value(ctx, m3_GetArgType(fn, i), argv[i], &argsp[i])) {
            ret = JS_EXCEPTION;
            goto done;
        }
        argptrsp[i] = &argsp[i];
    }
    for (i = 0; i < nrets; i++)
        retptrsp[i] = &retsp[i];

    inst->pending_exception = false;
    res = m3_Call(fn, nargs, argptrsp);
    if (res) {
        if (inst->pending_exception) {
            ret = JS_EXCEPTION;
        } else if (res == m3Err_trapWasiExit) {
            inst->exited = true;
            inst->exit_code = inst->wasi ? (uint32_t)inst->wasi->exit_code : 0;
            ret = js_wasm_throw_wasi_exit(ctx, inst->exit_code);
        } else {
            ret = js_wasm_throw(ctx, "RuntimeError", "%s", res);
        }
        goto done;
    }

    if (nrets > 0) {
        res = m3_GetResults(fn, nrets, retptrsp);
        if (res) {
            ret = js_wasm_throw(ctx, "RuntimeError", "%s", res);
            goto done;
        }
    }

    if (nrets == 1) {
        ret = wasm_to_js_value(ctx, m3_GetRetType(fn, 0), &retsp[0]);
    } else if (nrets > 1) {
        ret = JS_NewArray(ctx);
        if (JS_IsException(ret))
            goto done;
        for (i = 0; i < nrets; i++) {
            JSValue v = wasm_to_js_value(ctx, m3_GetRetType(fn, i), &retsp[i]);
            if (JS_SetPropertyUint32(ctx, ret, i, v) < 0) {
                JS_FreeValue(ctx, ret);
                ret = JS_EXCEPTION;
                goto done;
            }
        }
    } else {
        ret = JS_UNDEFINED;
    }

done:
    if (allocated) {
        js_free(ctx, argsp);
        js_free(ctx, argptrsp);
        js_free(ctx, retsp);
        js_free(ctx, retptrsp);
    }
    return ret;
}

static JSValue js_wasm_table_call(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic,
                                  JSValueConst *func_data)
{
    QJSWasmInstance *inst;
    IM3Function fn;
    int32_t index;
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));

    (void)this_val;
    (void)magic;
    if (JS_IsUndefined(func_data[0]))
        return js_wasm_throw(ctx, "TypeError", "stale WebAssembly export");
    inst = JS_GetOpaque(func_data[0], c->instance);
    if (!inst)
        return js_wasm_throw(ctx, "TypeError", "stale WebAssembly export");
    if (JS_ToInt32(ctx, &index, func_data[1]) < 0)
        return JS_EXCEPTION;
    if (index < 0 || (uint32_t)index >= inst->module->numFunctions)
        return js_wasm_throw(ctx, "TypeError", "invalid WebAssembly table entry");
    fn = &inst->module->functions[index];
    return js_wasm_call_function(ctx, inst, fn, argc, argv);
}

static JSValue js_wasm_export_call(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv, int magic,
                                   JSValueConst *func_data)
{
    QJSWasmInstance *inst;
    M3Export *ex;
    IM3Function fn;
    M3Result res;
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));

    (void)this_val;
    if (JS_IsUndefined(func_data[0]))
        return js_wasm_throw(ctx, "TypeError", "stale WebAssembly export");
    inst = JS_GetOpaque(func_data[0], c->instance);
    if (!inst)
        return js_wasm_throw(ctx, "TypeError", "stale WebAssembly export");
    if (magic < 0 || (uint32_t)magic >= inst->module->numExports)
        return js_wasm_throw(ctx, "TypeError", "invalid WebAssembly export");

    ex = &inst->module->exports[magic];
    res = m3_FindFunctionIn(&fn, inst->module, ex->name);
    if (res)
        return js_wasm_throw(ctx, "RuntimeError", "%s", res);

    return js_wasm_call_function(ctx, inst, fn, argc, argv);
}

/* ------------------------------------------------------------------ */
/* WebAssembly.Global                                                 */
/* ------------------------------------------------------------------ */

static QJSWasmGlobal *js_wasm_global_of(JSContext *ctx, JSValueConst this_val)
{
    return JS_GetOpaque2(ctx, this_val,
                         js_wasm_classes(JS_GetRuntime(ctx))->global);
}

static JSValue js_wasm_global_value_to_js(JSContext *ctx, QJSWasmGlobal *g,
                                          M3ValueType type,
                                          const QJSWasmValue *v)
{
    (void)g;
    switch (type) {
    case c_m3Type_i32:
        return JS_NewInt32(ctx, (int32_t)v->i32);
    case c_m3Type_i64:
        return JS_NewBigInt64(ctx, (int64_t)v->i64);
    case c_m3Type_f32:
        return JS_NewFloat64(ctx, (double)v->f32);
    case c_m3Type_f64:
        return JS_NewFloat64(ctx, v->f64);
    default:
        return JS_UNDEFINED;
    }
}

static JSValue js_wasm_global_get(JSContext *ctx, JSValueConst this_val)
{
    QJSWasmGlobal *g = js_wasm_global_of(ctx, this_val);

    if (!g)
        return JS_EXCEPTION;
    if (g->standalone)
        return js_wasm_global_value_to_js(ctx, g, g->type, &g->value);

    {
        QJSWasmInstance *inst =
            JS_GetOpaque(g->owner,
                         js_wasm_classes(JS_GetRuntime(ctx))->instance);
        M3Export *ex;
        IM3Global global;
        M3TaggedValue v;
        M3Result res;

        if (!inst)
            return js_wasm_throw(ctx, "TypeError", "stale WebAssembly global");
        if (g->export_index >= inst->module->numExports)
            return js_wasm_throw(ctx, "TypeError", "invalid WebAssembly global");
        ex = &inst->module->exports[g->export_index];
        global = m3_FindGlobal(inst->module, ex->name);
        if (!global)
            return js_wasm_throw(ctx, "TypeError", "unknown WebAssembly global");
        res = m3_GetGlobal(global, &v);
        if (res)
            return js_wasm_throw(ctx, "RuntimeError", "%s", res);
        switch (v.type) {
        case c_m3Type_i32:
            return JS_NewInt32(ctx, (int32_t)v.value.i32);
        case c_m3Type_i64:
            return JS_NewBigInt64(ctx, (int64_t)v.value.i64);
        case c_m3Type_f32:
            return JS_NewFloat64(ctx, (double)v.value.f32);
        case c_m3Type_f64:
            return JS_NewFloat64(ctx, v.value.f64);
        default:
            return JS_UNDEFINED;
        }
    }
}

static bool js_wasm_read_global_value(JSContext *ctx, M3ValueType type,
                                      JSValueConst val,
                                      QJSWasmValue *out)
{
    switch (type) {
    case c_m3Type_i32: {
        int32_t n;
        if (JS_ToInt32(ctx, &n, val))
            return false;
        out->i32 = (uint32_t)n;
        return true;
    }
    case c_m3Type_i64: {
        int64_t n;
        if (JS_ToBigInt64(ctx, &n, val))
            return false;
        out->i64 = (uint64_t)n;
        return true;
    }
    case c_m3Type_f32: {
        double d;
        if (JS_ToFloat64(ctx, &d, val))
            return false;
        out->f32 = (float)d;
        return true;
    }
    case c_m3Type_f64: {
        double d;
        if (JS_ToFloat64(ctx, &d, val))
            return false;
        out->f64 = d;
        return true;
    }
    default:
        js_wasm_throw(ctx, "TypeError",
                      "unsupported WebAssembly global type");
        return false;
    }
}

static JSValue js_wasm_global_set(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    QJSWasmGlobal *g = js_wasm_global_of(ctx, this_val);

    if (!g)
        return JS_EXCEPTION;

    if (g->standalone) {
        if (!g->is_mutable)
            return js_wasm_throw(ctx, "TypeError",
                                 "WebAssembly.Global is immutable");
        if (!js_wasm_read_global_value(ctx, g->type, val, &g->value))
            return JS_EXCEPTION;
        return JS_UNDEFINED;
    }

    {
        QJSWasmInstance *inst =
            JS_GetOpaque(g->owner,
                         js_wasm_classes(JS_GetRuntime(ctx))->instance);
        M3Export *ex;
        IM3Global global;
        M3TaggedValue v;
        M3Result res;

        if (!inst)
            return js_wasm_throw(ctx, "TypeError", "stale WebAssembly global");
        if (g->export_index >= inst->module->numExports)
            return js_wasm_throw(ctx, "TypeError", "invalid WebAssembly global");
        ex = &inst->module->exports[g->export_index];
        global = m3_FindGlobal(inst->module, ex->name);
        if (!global)
            return js_wasm_throw(ctx, "TypeError", "unknown WebAssembly global");
        if (!global->isMutable)
            return js_wasm_throw(ctx, "TypeError",
                                 "WebAssembly.Global is immutable");
        memset(&v, 0, sizeof(v));
        v.type = global->type;
        switch (v.type) {
        case c_m3Type_i32: {
            int32_t n;
            if (JS_ToInt32(ctx, &n, val))
                return JS_EXCEPTION;
            v.value.i32 = (uint32_t)n;
            break;
        }
        case c_m3Type_i64: {
            int64_t n;
            if (JS_ToBigInt64(ctx, &n, val))
                return JS_EXCEPTION;
            v.value.i64 = (uint64_t)n;
            break;
        }
        case c_m3Type_f32: {
            double d;
            if (JS_ToFloat64(ctx, &d, val))
                return JS_EXCEPTION;
            v.value.f32 = (float)d;
            break;
        }
        case c_m3Type_f64: {
            double d;
            if (JS_ToFloat64(ctx, &d, val))
                return JS_EXCEPTION;
            v.value.f64 = d;
            break;
        }
        default:
            return js_wasm_throw(ctx, "TypeError",
                                 "unsupported WebAssembly global type");
        }
        res = m3_SetGlobal(global, &v);
        if (res)
            return js_wasm_throw(ctx, "RuntimeError", "%s", res);
        return JS_UNDEFINED;
    }
}

static M3ValueType js_wasm_global_type_from_string(JSContext *ctx,
                                                   const char *s)
{
    if (!strcmp(s, "i32")) return c_m3Type_i32;
    if (!strcmp(s, "i64")) return c_m3Type_i64;
    if (!strcmp(s, "f32")) return c_m3Type_f32;
    if (!strcmp(s, "f64")) return c_m3Type_f64;
    if (!strcmp(s, "externref") || !strcmp(s, "anyfunc") ||
        !strcmp(s, "funcref"))
        return c_m3Type_externref;
    js_wasm_throw(ctx, "TypeError", "invalid WebAssembly.Global value type");
    return c_m3Type_unknown;
}

static JSValue js_wasm_global_ctor(JSContext *ctx, JSValueConst new_target,
                                   int argc, JSValueConst *argv)
{
    QJSWasmGlobal *g;
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    JSValue desc, type_v, mutable_v, obj;
    const char *type_s;
    M3ValueType type;

    (void)new_target;
    if (argc < 1 || !JS_IsObject(argv[0]))
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Global requires a descriptor object");
    desc = argv[0];
    type_v = JS_GetPropertyStr(ctx, desc, "value");
    mutable_v = JS_GetPropertyStr(ctx, desc, "mutable");
    if (!JS_IsString(type_v)) {
        JS_FreeValue(ctx, type_v);
        JS_FreeValue(ctx, mutable_v);
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Global descriptor needs a value type");
    }
    type_s = JS_ToCString(ctx, type_v);
    if (!type_s) {
        JS_FreeValue(ctx, type_v);
        JS_FreeValue(ctx, mutable_v);
        return JS_EXCEPTION;
    }
    type = js_wasm_global_type_from_string(ctx, type_s);
    JS_FreeCString(ctx, type_s);
    JS_FreeValue(ctx, type_v);
    if (type == c_m3Type_unknown) {
        JS_FreeValue(ctx, mutable_v);
        return JS_EXCEPTION;
    }

    g = js_mallocz(ctx, sizeof(*g));
    if (!g) {
        JS_FreeValue(ctx, mutable_v);
        return JS_EXCEPTION;
    }
    g->owner = JS_UNDEFINED;
    g->standalone = true;
    g->type = type;
    g->is_mutable = JS_ToBool(ctx, mutable_v) > 0;
    JS_FreeValue(ctx, mutable_v);

    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        if (!js_wasm_read_global_value(ctx, type, argv[1], &g->value)) {
            js_free(ctx, g);
            return JS_EXCEPTION;
        }
    }

    obj = JS_NewObjectClass(ctx, c->global);
    if (JS_IsException(obj)) {
        js_free(ctx, g);
        return obj;
    }
    JS_SetOpaque(obj, g);
    return obj;
}

/* ------------------------------------------------------------------ */
/* WebAssembly.Table                                                  */
/* ------------------------------------------------------------------ */

static QJSWasmTable *js_wasm_table_of(JSContext *ctx, JSValueConst this_val)
{
    return JS_GetOpaque2(ctx, this_val,
                         js_wasm_classes(JS_GetRuntime(ctx))->table);
}

static JSValue js_wasm_table_ctor(JSContext *ctx, JSValueConst new_target,
                                  int argc, JSValueConst *argv)
{
    QJSWasmTable *t;
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    JSValue desc, initial_v, maximum_v, obj;
    int64_t initial, maximum = -1;
    uint32_t i;

    (void)new_target;
    if (argc < 1 || !JS_IsObject(argv[0]))
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Table requires a descriptor object");
    desc = argv[0];
    initial_v = JS_GetPropertyStr(ctx, desc, "initial");
    maximum_v = JS_GetPropertyStr(ctx, desc, "maximum");
    if (JS_ToInt64(ctx, &initial, initial_v) < 0) {
        JS_FreeValue(ctx, initial_v);
        JS_FreeValue(ctx, maximum_v);
        return JS_EXCEPTION;
    }
    if (!JS_IsUndefined(maximum_v)) {
        if (JS_ToInt64(ctx, &maximum, maximum_v) < 0) {
            JS_FreeValue(ctx, initial_v);
            JS_FreeValue(ctx, maximum_v);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, initial_v);
    JS_FreeValue(ctx, maximum_v);

    if (initial < 0 || initial > UINT32_MAX ||
        (maximum >= 0 && maximum < initial) || maximum > UINT32_MAX)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Table: invalid initial/maximum");

    t = js_mallocz(ctx, sizeof(*t));
    if (!t)
        return JS_EXCEPTION;
    t->owner = JS_UNDEFINED;
    t->standalone = true;
    t->length = (uint32_t)initial;
    t->max_length = maximum < 0 ? (uint32_t)initial : (uint32_t)maximum;
    t->elems = js_mallocz(ctx, sizeof(JSValue) * (initial ? initial : 1));
    if (!t->elems) {
        js_free(ctx, t);
        return JS_EXCEPTION;
    }
    for (i = 0; i < t->length; i++)
        t->elems[i] = JS_NULL;

    obj = JS_NewObjectClass(ctx, c->table);
    if (JS_IsException(obj)) {
        js_free(ctx, t->elems);
        js_free(ctx, t);
        return obj;
    }
    JS_SetOpaque(obj, t);
    return obj;
}

static JSValue js_wasm_table_get_length(JSContext *ctx, JSValueConst this_val)
{
    QJSWasmTable *t = js_wasm_table_of(ctx, this_val);
    QJSWasmInstance *inst;

    if (!t)
        return JS_EXCEPTION;
    if (t->standalone)
        return JS_NewInt64(ctx, t->length);
    inst = JS_GetOpaque(t->owner,
                        js_wasm_classes(JS_GetRuntime(ctx))->instance);
    if (!inst || inst->module->numTables == 0)
        return JS_NewInt32(ctx, 0);
    return JS_NewInt64(ctx, (int64_t)inst->module->tables[0]->size);
}

static JSValue js_wasm_table_get(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    QJSWasmTable *t = js_wasm_table_of(ctx, this_val);
    int64_t idx;

    if (!t)
        return JS_EXCEPTION;
    if (argc < 1 || JS_ToInt64(ctx, &idx, argv[0]) < 0)
        return JS_EXCEPTION;
    if (idx < 0)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Table.get: invalid index");

    if (t->standalone) {
        if ((uint64_t)idx >= t->length)
            return js_wasm_throw(ctx, "RangeError",
                                 "WebAssembly.Table.get: index out of bounds");
        return JS_DupValue(ctx, t->elems[idx]);
    }

    {
        QJSWasmInstance *inst =
            JS_GetOpaque(t->owner,
                         js_wasm_classes(JS_GetRuntime(ctx))->instance);
        M3Table *tab;
        IM3Function fn;
        if (!inst)
            return js_wasm_throw(ctx, "TypeError", "stale WebAssembly table");
        if (inst->module->numTables == 0)
            return JS_NULL;
        tab = inst->module->tables[0];
        if ((uint64_t)idx >= tab->size)
            return js_wasm_throw(ctx, "RangeError",
                                 "WebAssembly.Table.get: index out of bounds");
        fn = (IM3Function)tab->elements[idx];
        if (!fn)
            return JS_NULL;
        {
            uint32_t f = (uint32_t)(fn - inst->module->functions);
            JSValue data[2];
            data[0] = t->owner;
            data[1] = JS_NewInt32(ctx, (int32_t)f);
            return JS_NewCFunctionData(ctx, js_wasm_table_call, 0, -1, 2,
                                       data);
        }
    }
}

static JSValue js_wasm_table_set(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    QJSWasmTable *t = js_wasm_table_of(ctx, this_val);
    int64_t idx;

    if (!t)
        return JS_EXCEPTION;
    if (argc < 1 || JS_ToInt64(ctx, &idx, argv[0]) < 0)
        return JS_EXCEPTION;
    if (!t->standalone)
        return js_wasm_throw(ctx, "TypeError",
                             "setting entries of an exported WebAssembly.Table is not supported");
    if (idx < 0 || (uint64_t)idx >= t->length)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Table.set: index out of bounds");
    JS_FreeValue(ctx, t->elems[idx]);
    t->elems[idx] = argc >= 2 ? JS_DupValue(ctx, argv[1]) : JS_NULL;
    return JS_UNDEFINED;
}

static JSValue js_wasm_table_grow(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    QJSWasmTable *t = js_wasm_table_of(ctx, this_val);
    int64_t delta, old;
    uint64_t new_len;
    uint32_t i;

    if (!t)
        return JS_EXCEPTION;
    if (!t->standalone)
        return js_wasm_throw(ctx, "TypeError",
                             "growing an exported WebAssembly.Table is not supported");
    if (argc < 1 || JS_ToInt64(ctx, &delta, argv[0]) < 0)
        return JS_EXCEPTION;
    if (delta < 0)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Table.grow: negative delta");
    old = t->length;
    new_len = (uint64_t)old + (uint64_t)delta;
    if (new_len > t->max_length)
        return js_wasm_throw(ctx, "RangeError",
                             "WebAssembly.Table.grow: maximum exceeded");
    {
        JSValue *p = js_realloc(ctx, t->elems,
                                sizeof(JSValue) * (new_len ? new_len : 1));
        if (!p)
            return JS_EXCEPTION;
        t->elems = p;
        for (i = (uint32_t)old; i < new_len; i++)
            t->elems[i] = argc >= 2 ? JS_DupValue(ctx, argv[1]) : JS_NULL;
        t->length = (uint32_t)new_len;
    }
    return JS_NewInt64(ctx, old);
}

/* ------------------------------------------------------------------ */
/* instantiation                                                      */
/* ------------------------------------------------------------------ */

static bool js_wasm_is_wasi_module(const char *name)
{
    return name && (strcmp(name, "wasi_snapshot_preview1") == 0 ||
                    strcmp(name, "wasi_unstable") == 0);
}

static JSValue js_wasm_build_exports_object(JSContext *ctx,
                                            QJSWasmInstance *inst,
                                            JSValueConst instance_obj)
{
    IM3Module mod = inst->module;
    JSValue exports = JS_NewObject(ctx);
    uint32_t i;

    if (JS_IsException(exports))
        return exports;

    for (i = 0; i < mod->numExports; i++) {
        M3Export *ex = &mod->exports[i];
        JSValue v = JS_UNDEFINED;

        switch (ex->kind) {
        case d_externalKind_function: {
            JSValue data[1];
            data[0] = instance_obj;
            v = JS_NewCFunctionData(ctx, js_wasm_export_call, 0, (int)i, 1,
                                    data);
            if (!JS_IsException(v))
                JS_DefinePropertyValueStr(ctx, v, "name",
                                          JS_NewString(ctx, ex->name),
                                          JS_PROP_CONFIGURABLE);
            break;
        }
        case d_externalKind_memory:
            v = js_wasm_memory_export(ctx, inst, ex->index, instance_obj);
            break;
        case d_externalKind_global: {
            QJSWasmGlobal *g = js_mallocz(ctx, sizeof(*g));
            if (!g) {
                v = JS_EXCEPTION;
                break;
            }
            g->owner = JS_DupValue(ctx, instance_obj);
            g->export_index = i;
            g->standalone = false;
            v = JS_NewObjectClass(
                ctx, js_wasm_classes(JS_GetRuntime(ctx))->global);
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, g->owner);
                js_free(ctx, g);
            } else {
                JS_SetOpaque(v, g);
            }
            break;
        }
        case d_externalKind_table: {
            QJSWasmTable *t = js_mallocz(ctx, sizeof(*t));
            if (!t) {
                v = JS_EXCEPTION;
                break;
            }
            t->owner = JS_DupValue(ctx, instance_obj);
            t->export_index = i;
            t->standalone = false;
            v = JS_NewObjectClass(
                ctx, js_wasm_classes(JS_GetRuntime(ctx))->table);
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, t->owner);
                js_free(ctx, t);
            } else {
                JS_SetOpaque(v, t);
            }
            break;
        }
        default:
            v = JS_UNDEFINED;
            break;
        }

        if (JS_IsException(v))
            goto fail;
        if (JS_DefinePropertyValueStr(ctx, exports, ex->name, v,
                                      JS_PROP_C_W_E) < 0)
            goto fail;
    }
    return exports;
fail:
    JS_FreeValue(ctx, exports);
    return JS_EXCEPTION;
}

static bool js_wasm_read_argv(JSContext *ctx, JSValueConst arr,
                              char ***out, uint32_t *out_n)
{
    uint32_t i, n;
    char **argv;
    JSValue lenv;
    int64_t len;

    *out = NULL;
    *out_n = 0;
    if (!JS_IsArray(arr))
        return true;
    lenv = JS_GetPropertyStr(ctx, arr, "length");
    if (JS_ToInt64(ctx, &len, lenv) < 0) {
        JS_FreeValue(ctx, lenv);
        return false;
    }
    JS_FreeValue(ctx, lenv);
    if (len < 0)
        len = 0;
    if (len > 4096)
        len = 4096;
    n = (uint32_t)len;
    argv = js_mallocz(ctx, sizeof(char *) * (n + 1));
    if (!argv)
        return false;
    for (i = 0; i < n; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, arr, i);
        const char *s;
        if (JS_IsException(v))
            goto fail;
        s = JS_ToCString(ctx, v);
        JS_FreeValue(ctx, v);
        if (!s)
            goto fail;
        argv[i] = js_strdup(ctx, s);
        JS_FreeCString(ctx, s);
        if (!argv[i])
            goto fail;
    }
    *out = argv;
    *out_n = n;
    return true;
fail:
    for (i = 0; i < n; i++)
        js_free(ctx, argv[i]);
    js_free(ctx, argv);
    return false;
}

static void js_wasm_free_argv(JSContext *ctx, char **argv, uint32_t argc)
{
    uint32_t i;
    if (!argv)
        return;
    for (i = 0; i < argc; i++)
        js_free(ctx, argv[i]);
    js_free(ctx, argv);
}

static bool js_wasm_set_argv(JSContext *ctx, QJSWasmInstance *inst,
                             const char *const *argv, int argc)
{
    uint32_t i;

    inst->wasi_argv = js_mallocz(ctx, sizeof(char *) * (uint32_t)(argc + 1));
    if (!inst->wasi_argv)
        return false;
    inst->wasi_argc = (uint32_t)argc;
    for (i = 0; i < (uint32_t)argc; i++) {
        inst->wasi_argv[i] = js_strdup(ctx, argv[i]);
        if (!inst->wasi_argv[i])
            return false;
    }
    inst->wasi_argv[argc] = NULL;
    return true;
}

static JSValue js_wasm_instantiate_internal(JSContext *ctx,
                                            JSValueConst module_or_bytes,
                                            JSValueConst imports,
                                            const char *const *argv,
                                            int argc)
{
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    QJSWasmModule *src = JS_GetOpaque(module_or_bytes, c->module);
    const uint8_t *bytes;
    size_t len;
    JSValue keep = JS_UNDEFINED;
    QJSWasmInstance *inst = NULL;
    JSValue instance_obj = JS_UNDEFINED;
    M3Result res;
    uint32_t i;
    bool ok = false;

    if (src) {
        bytes = src->bytes;
        len = src->len;
    } else {
        if (!js_wasm_get_bytes(ctx, module_or_bytes, &bytes, &len, &keep))
            return JS_EXCEPTION;
    }

    if (len > UINT32_MAX) {
        js_wasm_throw(ctx, "CompileError", "module is too large");
        goto fail;
    }

    inst = js_mallocz(ctx, sizeof(*inst));
    if (!inst) {
        JS_ThrowOutOfMemory(ctx);
        goto fail;
    }
    inst->classes = c;
    inst->wasm_bytes = js_wasm_copy_bytes(ctx, bytes, len);
    if (!inst->wasm_bytes) {
        JS_ThrowOutOfMemory(ctx);
        goto fail;
    }
    inst->wasm_len = len;

    inst->env = m3_NewEnvironment();
    if (!inst->env) {
        js_wasm_throw(ctx, "CompileError", "cannot create wasm environment");
        goto fail;
    }
    inst->runtime = m3_NewRuntime(inst->env, 1024 * 1024, NULL);
    if (!inst->runtime) {
        js_wasm_throw(ctx, "CompileError", "cannot create wasm runtime");
        goto fail;
    }

    res = m3_ParseModule(inst->env, &inst->module, inst->wasm_bytes,
                         (uint32_t)len);
    if (res) {
        inst->module = NULL;
        js_wasm_throw(ctx, "CompileError", "%s", res);
        goto fail;
    }
    m3_SetModuleName(inst->module, "qjs");

    /* Check the imports before doing anything irreversible.  WASI is always
       served by the host, even if the caller supplied a JS object for it. */
    for (i = 0; i < inst->module->numFunctions; i++) {
        IM3Function f = &inst->module->functions[i];
        JSValue modobj, fnobj;
        if (!f->import.moduleUtf8 || !f->import.fieldUtf8)
            continue;
        if (js_wasm_is_wasi_module(f->import.moduleUtf8))
            continue;
        modobj = js_wasm_get_property(ctx, imports, f->import.moduleUtf8);
        if (JS_IsException(modobj))
            goto fail;
        fnobj = js_wasm_get_property(ctx, modobj, f->import.fieldUtf8);
        JS_FreeValue(ctx, modobj);
        if (JS_IsException(fnobj))
            goto fail;
        if (!JS_IsFunction(ctx, fnobj)) {
            JS_FreeValue(ctx, fnobj);
            js_wasm_throw(ctx, "LinkError",
                          "import \"%s\".\"%s\" is not a function",
                          f->import.moduleUtf8, f->import.fieldUtf8);
            goto fail;
        }
        inst->num_imports++;
        JS_FreeValue(ctx, fnobj);
    }

    for (i = 0; i < inst->module->numTables; i++) {
        IM3Table tab = inst->module->tables[i];
        if (!tab->imported || !tab->import.moduleUtf8 ||
            js_wasm_is_wasi_module(tab->import.moduleUtf8))
            continue;
        js_wasm_throw(ctx, "LinkError",
                      "importing tables (\"%s\".\"%s\") is not supported",
                      tab->import.moduleUtf8, tab->import.fieldUtf8);
        goto fail;
    }

    if (inst->num_imports) {
        inst->imports = js_mallocz(ctx, sizeof(*inst->imports) *
                                          inst->num_imports);
        if (!inst->imports) {
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
    }

    {
        uint32_t n = 0;
        for (i = 0; i < inst->module->numFunctions; i++) {
            IM3Function f = &inst->module->functions[i];
            JSValue modobj, fnobj;
            if (!f->import.moduleUtf8 || !f->import.fieldUtf8)
                continue;
            if (js_wasm_is_wasi_module(f->import.moduleUtf8))
                continue;
            modobj = js_wasm_get_property(ctx, imports, f->import.moduleUtf8);
            if (JS_IsException(modobj))
                goto fail;
            fnobj = js_wasm_get_property(ctx, modobj, f->import.fieldUtf8);
            JS_FreeValue(ctx, modobj);
            if (JS_IsException(fnobj))
                goto fail;
            if (!JS_IsFunction(ctx, fnobj)) {
                JS_FreeValue(ctx, fnobj);
                js_wasm_throw(ctx, "LinkError",
                              "import \"%s\".\"%s\" is not a function",
                              f->import.moduleUtf8, f->import.fieldUtf8);
                goto fail;
            }
            inst->imports[n].ctx = ctx;
            inst->imports[n].inst = inst;
            inst->imports[n].func = fnobj;
            n++;
        }
    }

    /* Imported globals.  Use a WebAssembly.Global when one was supplied,
       otherwise coerce the plain JS value to the declared type. */
    for (i = 0; i < inst->module->numGlobals; i++) {
        IM3Global g = &inst->module->globals[i];
        JSValue modobj, val;
        M3TaggedValue tv;

        if (!g->imported || !g->import.moduleUtf8 || !g->import.fieldUtf8)
            continue;
        if (js_wasm_is_wasi_module(g->import.moduleUtf8))
            continue;
        modobj = js_wasm_get_property(ctx, imports, g->import.moduleUtf8);
        if (JS_IsException(modobj))
            goto fail;
        val = js_wasm_get_property(ctx, modobj, g->import.fieldUtf8);
        JS_FreeValue(ctx, modobj);
        if (JS_IsException(val))
            goto fail;
        if (JS_IsUndefined(val)) {
            JS_FreeValue(ctx, val);
            js_wasm_throw(ctx, "LinkError",
                          "import \"%s\".\"%s\" is not a global",
                          g->import.moduleUtf8, g->import.fieldUtf8);
            goto fail;
        }

        memset(&tv, 0, sizeof(tv));
        tv.type = g->type;
        {
            QJSWasmGlobal *jg = JS_GetOpaque(val, c->global);
            if (jg && jg->standalone) {
                if (jg->type != g->type) {
                    JS_FreeValue(ctx, val);
                    js_wasm_throw(ctx, "LinkError",
                                  "global import \"%s\".\"%s\" has the wrong type",
                                  g->import.moduleUtf8, g->import.fieldUtf8);
                    goto fail;
                }
                switch (g->type) {
                case c_m3Type_i32: tv.value.i32 = jg->value.i32; break;
                case c_m3Type_i64: tv.value.i64 = jg->value.i64; break;
                case c_m3Type_f32: tv.value.f32 = jg->value.f32; break;
                case c_m3Type_f64: tv.value.f64 = jg->value.f64; break;
                default: break;
                }
            } else {
                QJSWasmValue v;
                if (!js_wasm_read_global_value(ctx, g->type, val, &v)) {
                    JS_FreeValue(ctx, val);
                    goto fail;
                }
                switch (g->type) {
                case c_m3Type_i32: tv.value.i32 = v.i32; break;
                case c_m3Type_i64: tv.value.i64 = v.i64; break;
                case c_m3Type_f32: tv.value.f32 = v.f32; break;
                case c_m3Type_f64: tv.value.f64 = v.f64; break;
                default: break;
                }
            }
        }
        JS_FreeValue(ctx, val);

        res = m3_LinkGlobal(inst->module, g->import.moduleUtf8,
                            g->import.fieldUtf8, &tv);
        if (res) {
            js_wasm_throw(ctx, "LinkError", "%s", res);
            goto fail;
        }
    }

    res = m3_LoadModule(inst->runtime, inst->module);
    if (res) {
        inst->module_loaded = true; /* the runtime owns it either way */
        js_wasm_throw(ctx, "LinkError", "%s", res);
        goto fail;
    }
    inst->module_loaded = true;

    if (inst->module->numMemories) {
        uint32_t n = inst->module->numMemories;
        inst->memories = js_mallocz(ctx, sizeof(JSValue) * n);
        if (!inst->memories) {
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        for (i = 0; i < n; i++)
            inst->memories[i] = JS_UNDEFINED;
        inst->num_memories = n;
    }

    /* Link the JS functions now that the module has a runtime.  Descriptors
       were created in module order, so re-walk the imports the same way. */
    {
        uint32_t n = 0;
        for (i = 0; i < inst->module->numFunctions; i++) {
            IM3Function f = &inst->module->functions[i];
            if (!f->import.moduleUtf8 || !f->import.fieldUtf8)
                continue;
            if (js_wasm_is_wasi_module(f->import.moduleUtf8))
                continue;
            res = m3_LinkRawFunctionEx(inst->module, f->import.moduleUtf8,
                                       f->import.fieldUtf8, NULL,
                                       js_wasm_import_trampoline,
                                       &inst->imports[n]);
            if (res) {
                js_wasm_throw(ctx, "LinkError", "%s", res);
                goto fail;
            }
            n++;
        }
        if (n != inst->num_imports) {
            js_wasm_throw(ctx, "LinkError", "internal import mismatch");
            goto fail;
        }
    }

    /* WASI preview1, with a per-instance context so argv is not shared. */
    {
        M3WASI wasi = NULL;
        res = m3_NewCustomWASI(&wasi);
        if (res || !wasi) {
            js_wasm_throw(ctx, "LinkError", "cannot create WASI context");
            goto fail;
        }
        inst->wasi = wasi;
        if (!argv) {
            static const char *default_argv[] = { "wasm" };
            argv = default_argv;
            argc = 1;
        }
        if (!js_wasm_set_argv(ctx, inst, argv, argc)) {
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        wasi->argc = inst->wasi_argc;
        wasi->argv = (ccstr_t *)inst->wasi_argv;
        res = m3_LinkCustomWASI(inst->module, wasi);
        if (res) {
            js_wasm_throw(ctx, "LinkError", "%s", res);
            goto fail;
        }
    }

    instance_obj = JS_NewObjectClass(ctx, c->instance);
    if (JS_IsException(instance_obj))
        goto fail;
    JS_SetOpaque(instance_obj, inst);

    /* An imported memory supplied as a standalone WebAssembly.Memory is copied
       into wasm3's own memory and the JS wrapper is repointed at it. */
    for (i = 0; i < inst->module->numMemories; i++) {
        IM3Memory mem = inst->module->memories[i];
        JSValue modobj, memobj;
        QJSWasmMemory *jm;
        size_t mlen;
        uint8_t *mptr;

        if (!mem->imported || !mem->import.moduleUtf8 ||
            !mem->import.fieldUtf8 ||
            js_wasm_is_wasi_module(mem->import.moduleUtf8))
            continue;
        modobj = js_wasm_get_property(ctx, imports, mem->import.moduleUtf8);
        if (JS_IsException(modobj))
            goto fail;
        memobj = js_wasm_get_property(ctx, modobj, mem->import.fieldUtf8);
        JS_FreeValue(ctx, modobj);
        if (JS_IsException(memobj))
            goto fail;
        jm = JS_GetOpaque(memobj, c->memory);
        if (!jm || jm->inst) {
            JS_FreeValue(ctx, memobj);
            js_wasm_throw(ctx, "LinkError",
                          "import \"%s\".\"%s\" is not a WebAssembly.Memory",
                          mem->import.moduleUtf8, mem->import.fieldUtf8);
            goto fail;
        }
        mptr = m3_GetMemory(inst->module, &mlen, i);
        if (mptr && jm->data) {
            size_t copy = (size_t)(jm->pages * 65536);
            if (copy > mlen)
                copy = mlen;
            memcpy(mptr, jm->data, copy);
        }
        js_free(ctx, jm->data);
        jm->data = NULL;
        jm->inst = inst;
        jm->index = i;
        js_wasm_memory_invalidate_buffer(ctx, jm);
        JS_FreeValue(ctx, jm->owner);
        jm->owner = JS_DupValue(ctx, instance_obj);
        if (i < inst->num_memories) {
            JS_FreeValue(ctx, inst->memories[i]);
            inst->memories[i] = JS_DupValue(ctx, memobj);
        }
        JS_FreeValue(ctx, memobj);
    }

    res = m3_RunStart(inst->module);
    if (res) {
        if (res == m3Err_trapWasiExit) {
            inst->exited = true;
            inst->exit_code = inst->wasi ? (uint32_t)inst->wasi->exit_code : 0;
            js_wasm_throw_wasi_exit(ctx, inst->exit_code);
        } else {
            js_wasm_throw(ctx, "RuntimeError", "%s", res);
        }
        goto fail;
    }

    {
        JSValue exports_obj =
            js_wasm_build_exports_object(ctx, inst, instance_obj);
        if (JS_IsException(exports_obj)) {
            /* fail: frees instance_obj (and with it the opaque instance) */
            goto fail;
        }
        if (JS_SetPropertyStr(ctx, instance_obj, "exports", exports_obj) < 0) {
            JS_FreeValue(ctx, exports_obj);
            goto fail;
        }
    }

    ok = true;

fail:
    JS_FreeValue(ctx, keep);
    if (!ok) {
        if (!JS_IsUndefined(instance_obj)) {
            /* Clear the opaque first so the instance is freed once, here. */
            JS_SetOpaque(instance_obj, NULL);
            JS_FreeValue(ctx, instance_obj);
        }
        js_wasm_instance_free(JS_GetRuntime(ctx), inst);
        return JS_EXCEPTION;
    }
    return instance_obj;
}

/* ------------------------------------------------------------------ */
/* WebAssembly namespace                                              */
/* ------------------------------------------------------------------ */

/* Parse, load and compile the whole module without running it.  Used by
   validate() and the Module constructor so malformed bytecode is reported at
   compile time rather than on the first call. */
static M3Result js_wasm_verify(const uint8_t *bytes, size_t len)
{
    IM3Environment env;
    IM3Runtime runtime;
    IM3Module mod = NULL;
    M3Result res;

    env = m3_NewEnvironment();
    if (!env)
        return m3Err_mallocFailed;
    res = m3_ParseModule(env, &mod, bytes, (uint32_t)len);
    if (res) {
        m3_FreeEnvironment(env);
        return res;
    }
    runtime = m3_NewRuntime(env, 1024 * 1024, NULL);
    if (!runtime) {
        m3_FreeModule(mod);
        m3_FreeEnvironment(env);
        return m3Err_mallocFailed;
    }
    res = m3_LoadModule(runtime, mod);
    if (!res)
        res = m3_CompileModule(mod);
    m3_FreeRuntime(runtime);
    m3_FreeEnvironment(env);
    return res;
}

static JSValue js_wasm_module_ctor(JSContext *ctx, JSValueConst new_target,
                                   int argc, JSValueConst *argv)
{
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    const uint8_t *bytes;
    size_t len;
    JSValue keep = JS_UNDEFINED;
    QJSWasmModule *m = NULL;
    JSValue obj;
    IM3Environment env = NULL;
    IM3Module mod = NULL;
    M3Result res;

    (void)new_target;
    if (argc < 1)
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Module requires a buffer");
    if (!js_wasm_get_bytes(ctx, argv[0], &bytes, &len, &keep))
        return JS_EXCEPTION;
    if (len > UINT32_MAX) {
        JS_FreeValue(ctx, keep);
        return js_wasm_throw(ctx, "CompileError", "module is too large");
    }

    res = js_wasm_verify(bytes, len);
    if (res) {
        JS_FreeValue(ctx, keep);
        return js_wasm_throw(ctx, "CompileError", "%s", res);
    }

    env = m3_NewEnvironment();
    if (!env) {
        JS_FreeValue(ctx, keep);
        return JS_ThrowOutOfMemory(ctx);
    }
    res = m3_ParseModule(env, &mod, bytes, (uint32_t)len);
    if (res) {
        m3_FreeEnvironment(env);
        JS_FreeValue(ctx, keep);
        return js_wasm_throw(ctx, "CompileError", "%s", res);
    }

    m = js_mallocz(ctx, sizeof(*m));
    if (!m) {
        m3_FreeModule(mod);
        m3_FreeEnvironment(env);
        JS_FreeValue(ctx, keep);
        return JS_ThrowOutOfMemory(ctx);
    }
    m->bytes = js_wasm_copy_bytes(ctx, bytes, len);
    JS_FreeValue(ctx, keep);
    if (!m->bytes) {
        m3_FreeModule(mod);
        m3_FreeEnvironment(env);
        js_free(ctx, m);
        return JS_ThrowOutOfMemory(ctx);
    }
    m->len = len;
    m->exports = js_wasm_build_exports_metadata(ctx, mod);
    m->imports = js_wasm_build_imports_metadata(ctx, mod);
    m3_FreeModule(mod);
    m3_FreeEnvironment(env);
    if (JS_IsException(m->exports) || JS_IsException(m->imports)) {
        JS_FreeValue(ctx, m->exports);
        JS_FreeValue(ctx, m->imports);
        js_free(ctx, m->bytes);
        js_free(ctx, m);
        return JS_EXCEPTION;
    }

    obj = JS_NewObjectClass(ctx, c->module);
    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, m->exports);
        JS_FreeValue(ctx, m->imports);
        js_free(ctx, m->bytes);
        js_free(ctx, m);
        return obj;
    }
    JS_SetOpaque(obj, m);
    JS_DefinePropertyValueStr(ctx, obj, "exports",
                              JS_DupValue(ctx, m->exports),
                              JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, obj, "imports",
                              JS_DupValue(ctx, m->imports),
                              JS_PROP_CONFIGURABLE);
    return obj;
}

static JSValue js_wasm_instance_ctor(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv)
{
    JSValue imports = argc >= 2 ? argv[1] : JS_UNDEFINED;
    (void)new_target;
    if (argc < 1 || !JS_GetOpaque(argv[0],
                                 js_wasm_classes(JS_GetRuntime(ctx))->module))
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Instance requires a Module");
    return js_wasm_instantiate_internal(ctx, argv[0], imports, NULL, 0);
}

static JSValue js_wasm_module_exports_static(JSContext *ctx,
                                             JSValueConst this_val,
                                             int argc, JSValueConst *argv)
{
    QJSWasmModule *m;
    (void)this_val;
    if (argc < 1 ||
        !(m = JS_GetOpaque(argv[0],
                           js_wasm_classes(JS_GetRuntime(ctx))->module)))
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Module.exports requires a Module");
    return JS_DupValue(ctx, m->exports);
}

static JSValue js_wasm_module_imports_static(JSContext *ctx,
                                             JSValueConst this_val,
                                             int argc, JSValueConst *argv)
{
    QJSWasmModule *m;
    (void)this_val;
    if (argc < 1 ||
        !(m = JS_GetOpaque(argv[0],
                           js_wasm_classes(JS_GetRuntime(ctx))->module)))
        return js_wasm_throw(ctx, "TypeError",
                             "WebAssembly.Module.imports requires a Module");
    return JS_DupValue(ctx, m->imports);
}

static JSValue js_wasm_validate(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const uint8_t *bytes;
    size_t len;
    JSValue keep = JS_UNDEFINED;
    M3Result res;
    (void)this_val;

    if (argc < 1)
        return JS_NewBool(ctx, false);
    if (!js_wasm_get_bytes(ctx, argv[0], &bytes, &len, &keep)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_NewBool(ctx, false);
    }
    if (len > UINT32_MAX) {
        JS_FreeValue(ctx, keep);
        return JS_NewBool(ctx, false);
    }
    res = js_wasm_verify(bytes, len);
    JS_FreeValue(ctx, keep);
    return JS_NewBool(ctx, res == m3Err_none);
}

/* Promise helpers */


static JSValue js_wasm_instantiate_promise(JSContext *ctx,
                                           JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    JSValue result;
    bool from_module;

    (void)this_val;
    if (JS_IsException(promise))
        return promise;

    if (argc < 1) {
        JSValue err = js_wasm_throw(ctx, "TypeError",
                                    "WebAssembly.instantiate requires a buffer");
        (void)err;
        err = JS_GetException(ctx);
        JS_Call(ctx, resolving[1], JS_UNDEFINED, 1, &err);
        JS_FreeValue(ctx, err);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    from_module = JS_GetOpaque(argv[0], c->module) != NULL;
    {
        JSValue imports = argc >= 2 ? argv[1] : JS_UNDEFINED;
        JSValue inst;
        char **wargv = NULL;
        uint32_t wargc = 0;

        /* Non-standard qjs extension: a third argument may carry WASI
           options, e.g. { argv: ["prog", "--flag"] }. */
        if (argc >= 3 && JS_IsObject(argv[2])) {
            JSValue opts = argv[2];
            JSValue av = JS_GetPropertyStr(ctx, opts, "argv");
            bool ok = true;
            if (JS_IsException(av)) {
                ok = false;
            } else if (!JS_IsUndefined(av)) {
                ok = js_wasm_read_argv(ctx, av, &wargv, &wargc);
            }
            JS_FreeValue(ctx, av);
            if (!ok) {
                JSValue err = JS_GetException(ctx);
                JSValue r = JS_Call(ctx, resolving[1], JS_UNDEFINED, 1, &err);
                JS_FreeValue(ctx, r);
                JS_FreeValue(ctx, err);
                JS_FreeValue(ctx, resolving[0]);
                JS_FreeValue(ctx, resolving[1]);
                js_wasm_free_argv(ctx, wargv, wargc);
                return promise;
            }
        }

        inst = js_wasm_instantiate_internal(ctx, argv[0], imports,
                                            (const char *const *)wargv,
                                            (int)wargc);
        js_wasm_free_argv(ctx, wargv, wargc);
        if (JS_IsException(inst)) {
            JSValue err = JS_GetException(ctx);
            JSValue r = JS_Call(ctx, resolving[1], JS_UNDEFINED, 1, &err);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, err);
            JS_FreeValue(ctx, resolving[0]);
            JS_FreeValue(ctx, resolving[1]);
            return promise;
        }
        if (from_module) {
            result = inst;
        } else {
            JSValue modargs[1] = { argv[0] };
            JSValue mod = js_wasm_module_ctor(ctx, JS_UNDEFINED, 1, modargs);
            if (JS_IsException(mod)) {
                JSValue err = JS_GetException(ctx);
                JS_FreeValue(ctx, inst);
                JS_Call(ctx, resolving[1], JS_UNDEFINED, 1, &err);
                JS_FreeValue(ctx, err);
                JS_FreeValue(ctx, resolving[0]);
                JS_FreeValue(ctx, resolving[1]);
                return promise;
            }
            result = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, result, "module", mod);
            JS_SetPropertyStr(ctx, result, "instance", inst);
        }
    }

    {
        JSValue r = JS_Call(ctx, resolving[0], JS_UNDEFINED, 1, &result);
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, resolving[0]);
    JS_FreeValue(ctx, resolving[1]);
    return promise;
}

static JSValue js_wasm_compile_promise(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    JSValue result;
    (void)this_val;

    if (JS_IsException(promise))
        return promise;
    if (argc < 1) {
        JSValue err = js_wasm_throw(ctx, "TypeError",
                                    "WebAssembly.compile requires a buffer");
        (void)err;
        err = JS_GetException(ctx);
        JS_Call(ctx, resolving[1], JS_UNDEFINED, 1, &err);
        JS_FreeValue(ctx, err);
    } else {
        result = js_wasm_module_ctor(ctx, JS_UNDEFINED, 1, argv);
        if (JS_IsException(result)) {
            JSValue err = JS_GetException(ctx);
            JS_Call(ctx, resolving[1], JS_UNDEFINED, 1, &err);
            JS_FreeValue(ctx, err);
        } else {
            JS_Call(ctx, resolving[0], JS_UNDEFINED, 1, &result);
            JS_FreeValue(ctx, result);
        }
    }
    JS_FreeValue(ctx, resolving[0]);
    JS_FreeValue(ctx, resolving[1]);
    return promise;
}

static JSValue js_wasm_error_ctor(JSContext *ctx, JSValueConst new_target,
                                  int argc, JSValueConst *argv, int magic)
{
    static const char *names[] = {
        "CompileError", "LinkError", "RuntimeError"
    };
    JSValue err;
    const char *msg = NULL;

    (void)new_target;
    if (argc >= 1) {
        msg = JS_ToCString(ctx, argv[0]);
        if (!msg)
            return JS_EXCEPTION;
    }
    err = js_wasm_new_error(ctx, names[magic]);
    if (JS_IsException(err)) {
        if (msg)
            JS_FreeCString(ctx, msg);
        return err;
    }
    if (JS_IsObject(new_target)) {
        JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
        if (JS_IsObject(proto))
            JS_SetPrototype(ctx, err, proto);
        JS_FreeValue(ctx, proto);
    }
    JS_DefinePropertyValueStr(ctx, err, "name",
                              JS_NewString(ctx, names[magic]),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, err, "message",
                              JS_NewString(ctx, msg ? msg : ""),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    if (msg)
        JS_FreeCString(ctx, msg);
    return err;
}

static JSValue js_wasm_global_valueof(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    (void)argc;
    (void)argv;
    return js_wasm_global_get(ctx, this_val);
}

static const JSCFunctionListEntry js_wasm_memory_proto_funcs[] = {
    JS_CGETSET_DEF("buffer", js_wasm_memory_get_buffer, NULL),
    JS_CGETSET_DEF("byteLength", js_wasm_memory_get_byte_length, NULL),
    JS_CFUNC_DEF("grow", 1, js_wasm_memory_grow),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "WebAssembly.Memory",
                       JS_PROP_CONFIGURABLE),
};

static const JSCFunctionListEntry js_wasm_global_proto_funcs[] = {
    JS_CGETSET_DEF("value", js_wasm_global_get, js_wasm_global_set),
    JS_CFUNC_DEF("valueOf", 0, js_wasm_global_valueof),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "WebAssembly.Global",
                       JS_PROP_CONFIGURABLE),
};

static const JSCFunctionListEntry js_wasm_table_proto_funcs[] = {
    JS_CGETSET_DEF("length", js_wasm_table_get_length, NULL),
    JS_CFUNC_DEF("get", 1, js_wasm_table_get),
    JS_CFUNC_DEF("set", 2, js_wasm_table_set),
    JS_CFUNC_DEF("grow", 1, js_wasm_table_grow),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "WebAssembly.Table",
                       JS_PROP_CONFIGURABLE),
};

static const JSCFunctionListEntry js_wasm_namespace_funcs[] = {
    JS_CFUNC_DEF("instantiate", 1, js_wasm_instantiate_promise),
    JS_CFUNC_DEF("compile", 1, js_wasm_compile_promise),
    JS_CFUNC_DEF("validate", 1, js_wasm_validate),
};

static JSValue js_wasm_new_error_ctor(JSContext *ctx, const char *name,
                                      int magic)
{
    JSValue ctor, proto, err, parent;
    union {
        JSCFunction *generic;
        JSValue (*magic)(JSContext *, JSValueConst, int, JSValueConst *,
                         int);
    } fn;

    fn.magic = js_wasm_error_ctor;
    ctor = JS_NewCFunction2(ctx, fn.generic, name, 1,
                            JS_CFUNC_constructor_magic, magic);
    if (JS_IsException(ctor))
        return ctor;
    proto = JS_NewObject(ctx);
    if (JS_IsException(proto)) {
        JS_FreeValue(ctx, ctor);
        return proto;
    }
    err = JS_NewError(ctx);
    if (!JS_IsException(err)) {
        parent = JS_GetPrototype(ctx, err);
        if (JS_IsObject(parent))
            JS_SetPrototype(ctx, proto, parent);
        JS_FreeValue(ctx, parent);
        JS_FreeValue(ctx, err);
    }
    JS_SetConstructor(ctx, ctor, proto);
    JS_FreeValue(ctx, proto);
    return ctor;
}

static JSValue js_wasm_new_namespace(JSContext *ctx)
{
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    JSValue wasm = JS_NewObject(ctx);
    JSValue ctor, proto;

    if (!c) {
        JS_ThrowOutOfMemory(ctx);
        return JS_EXCEPTION;
    }
    if (JS_IsException(wasm))
        return wasm;

    ctor = JS_NewCFunction2(ctx, js_wasm_module_ctor, "Module", 1,
                            JS_CFUNC_constructor, 0);
    proto = JS_NewObject(ctx);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, c->module, proto);
    JS_SetPropertyStr(ctx, ctor, "exports",
                      JS_NewCFunction(ctx, js_wasm_module_exports_static,
                                      "exports", 1));
    JS_SetPropertyStr(ctx, ctor, "imports",
                      JS_NewCFunction(ctx, js_wasm_module_imports_static,
                                      "imports", 1));
    JS_SetPropertyStr(ctx, wasm, "Module", ctor);

    ctor = JS_NewCFunction2(ctx, js_wasm_instance_ctor, "Instance", 1,
                            JS_CFUNC_constructor, 0);
    proto = JS_NewObject(ctx);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, c->instance, proto);
    JS_SetPropertyStr(ctx, wasm, "Instance", ctor);

    ctor = JS_NewCFunction2(ctx, js_wasm_memory_ctor, "Memory", 1,
                            JS_CFUNC_constructor, 0);
    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_wasm_memory_proto_funcs,
                               countof(js_wasm_memory_proto_funcs));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, c->memory, proto);
    JS_SetPropertyStr(ctx, wasm, "Memory", ctor);

    ctor = JS_NewCFunction2(ctx, js_wasm_global_ctor, "Global", 1,
                            JS_CFUNC_constructor, 0);
    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_wasm_global_proto_funcs,
                               countof(js_wasm_global_proto_funcs));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, c->global, proto);
    JS_SetPropertyStr(ctx, wasm, "Global", ctor);

    ctor = JS_NewCFunction2(ctx, js_wasm_table_ctor, "Table", 1,
                            JS_CFUNC_constructor, 0);
    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_wasm_table_proto_funcs,
                               countof(js_wasm_table_proto_funcs));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, c->table, proto);
    JS_SetPropertyStr(ctx, wasm, "Table", ctor);

    JS_SetPropertyStr(ctx, wasm, "CompileError",
                      js_wasm_new_error_ctor(ctx, "CompileError", 0));
    JS_SetPropertyStr(ctx, wasm, "LinkError",
                      js_wasm_new_error_ctor(ctx, "LinkError", 1));
    JS_SetPropertyStr(ctx, wasm, "RuntimeError",
                      js_wasm_new_error_ctor(ctx, "RuntimeError", 2));

    JS_SetPropertyFunctionList(ctx, wasm, js_wasm_namespace_funcs,
                               countof(js_wasm_namespace_funcs));
    return wasm;
}

/* ------------------------------------------------------------------ */
/* module registration                                                */
/* ------------------------------------------------------------------ */

static int js_wasm_module_init(JSContext *ctx, JSModuleDef *m)
{
    JSValue wasm = js_wasm_new_namespace(ctx);
    if (JS_IsException(wasm))
        return -1;
    return JS_SetModuleExport(ctx, m, "WebAssembly", wasm);
}

JSModuleDef *js_init_module_wasm(JSContext *ctx, const char *module_name)
{
    JSModuleDef *m;
    if (!js_wasm_classes(JS_GetRuntime(ctx))) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    m = JS_NewCModule(ctx, module_name, js_wasm_module_init);
    if (!m)
        return NULL;
    JS_AddModuleExport(ctx, m, "WebAssembly");
    return m;
}

int js_wasm_init(JSContext *ctx)
{
    JSValue global, wasm;

    if (!js_wasm_classes(JS_GetRuntime(ctx))) {
        JS_ThrowOutOfMemory(ctx);
        return -1;
    }

    wasm = js_wasm_new_namespace(ctx);
    if (JS_IsException(wasm))
        return -1;
    global = JS_GetGlobalObject(ctx);
    if (JS_DefinePropertyValueStr(ctx, global, "WebAssembly", wasm,
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE) < 0) {
        JS_FreeValue(ctx, global);
        return -1;
    }
    JS_FreeValue(ctx, global);
    return 0;
}

int js_wasm_available(void)
{
    return 1;
}

/* ------------------------------------------------------------------ */
/* CLI helper: run a .wasm file as a WASI command                     */
/* ------------------------------------------------------------------ */

static uint8_t *js_wasm_load_file(JSContext *ctx, const char *path,
                                  size_t *out_len)
{
    FILE *f;
    long size;
    uint8_t *buf;

    f = fopen(path, "rb");
    if (!f)
        return NULL;
    if (fseek(f, 0, SEEK_END) < 0) {
        fclose(f);
        return NULL;
    }
    size = ftell(f);
    if (size < 0 || fseek(f, 0, SEEK_SET) < 0) {
        fclose(f);
        return NULL;
    }
    buf = js_malloc(ctx, (size_t)size ? (size_t)size : 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (size > 0 && fread(buf, 1, (size_t)size, f) != (size_t)size) {
        js_free(ctx, buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *out_len = (size_t)size;
    return buf;
}

JSValue js_wasm_run_file(JSContext *ctx, const char *path,
                         int argc, const char *const *argv)
{
    uint8_t *buf;
    size_t len = 0;
    JSValue bytes, inst, exports, fn, ret;
    QJSWasmInstance *wi;
    QJSWasmClasses *c = js_wasm_classes(JS_GetRuntime(ctx));
    const char *default_argv[1];
    const char *const *wargv = argv;
    int wargc = argc;

    buf = js_wasm_load_file(ctx, path, &len);
    if (!buf)
        return js_wasm_throw(ctx, "Error", "cannot load '%s'", path);

    bytes = JS_NewUint8ArrayCopy(ctx, buf, len);
    js_free(ctx, buf);
    if (JS_IsException(bytes))
        return bytes;

    if (!wargv) {
        default_argv[0] = path;
        wargv = default_argv;
        wargc = 1;
    }

    inst = js_wasm_instantiate_internal(ctx, bytes, JS_UNDEFINED, wargv, wargc);
    JS_FreeValue(ctx, bytes);
    if (JS_IsException(inst))
        return inst;

    wi = JS_GetOpaque(inst, c->instance);
    if (!wi) {
        JS_FreeValue(ctx, inst);
        return js_wasm_throw(ctx, "Error", "invalid WebAssembly instance");
    }

    exports = JS_GetPropertyStr(ctx, inst, "exports");
    if (JS_IsException(exports)) {
        JS_FreeValue(ctx, inst);
        return exports;
    }
    fn = JS_GetPropertyStr(ctx, exports, "_start");
    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        fn = JS_GetPropertyStr(ctx, exports, "_initialize");
    }
    JS_FreeValue(ctx, exports);

    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        JS_FreeValue(ctx, inst);
        return js_wasm_throw(ctx, "Error",
                             "'%s' exports neither _start nor _initialize",
                             path);
    }

    ret = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
    JS_FreeValue(ctx, fn);
    if (JS_IsException(ret)) {
        JSValue err = JS_GetException(ctx);
        JSValue code = js_wasm_get_property(ctx, err, "wasiExitCode");
        if (JS_IsNumber(code)) {
            int32_t exit_code = 0;
            JS_ToInt32(ctx, &exit_code, code);
            JS_FreeValue(ctx, code);
            JS_FreeValue(ctx, err);
            JS_FreeValue(ctx, inst);
            return JS_NewInt32(ctx, exit_code);
        }
        JS_FreeValue(ctx, code);
        JS_FreeValue(ctx, inst);
        return JS_Throw(ctx, err);
    }
    JS_FreeValue(ctx, ret);
    {
        uint32_t code = wi->exit_code;
        JS_FreeValue(ctx, inst);
        return JS_NewInt32(ctx, (int)code);
    }
}

#else /* !QJS_BUILD_WASM3 */

JSModuleDef *js_init_module_wasm(JSContext *ctx, const char *module_name)
{
    (void)ctx;
    (void)module_name;
    return NULL;
}

int js_wasm_init(JSContext *ctx)
{
    (void)ctx;
    return 0;
}

int js_wasm_available(void)
{
    return 0;
}

JSValue js_wasm_run_file(JSContext *ctx, const char *path,
                         int argc, const char *const *argv)
{
    (void)path;
    (void)argc;
    (void)argv;
    return js_wasm_throw(ctx, "Error",
                         "this build does not include WebAssembly support");
}

#endif /* QJS_BUILD_WASM3 */
