/*
 * js.c - QuickJS JavaScript engine integration for the qnode bare-metal kernel (Pi 4)
 *
 * Creates the QuickJS runtime/context, registers the C-backed console.log
 * global, evaluates the boot test program and exposes helpers for pushing
 * text into the JS global object.
 *
 * Resource limits:
 *  - heap limit      : 2 MB of the 4 MB kernel heap
 *  - JS stack limit  : 160 KB (kernel stack is 256 KB, see linker.ld)
 *  - time budget     : 2 s per evaluation/job batch (watchdog interrupt)
 */

#include <string.h>
#include "js.h"
#include "quickjs.h"
#include "timer.h"
#include "uart.h"

#define JS_HEAP_LIMIT       (2 * 1024 * 1024)
#define JS_STACK_LIMIT      (160 * 1024)
#define JS_TIME_BUDGET_MS   2000

static JSRuntime *g_js_runtime = NULL;
static JSContext *g_js_context = NULL;
static uint64_t g_js_deadline_ms = 0;

/* Boot test program executed on startup */
static const char boot_test_js[] =
    "console.log('Hello from QuickJS!');\n"
    "console.log('2 + 2 =', 2 + 2);\n"
    "console.log('Array test:', [1, 2, 3].length);\n"
    "console.log('Object test:', {x: 10, y: 20}.x);\n"
    "let sum = 0;\n"
    "for (let i = 1; i <= 10; i++) sum += i;\n"
    "console.log('Sum 1-10:', sum);\n";

/* console.log implementation - outputs to UART */
static JSValue js_console_log(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    for (int i = 0; i < argc; i++) {
        if (i > 0) uart_puts(" ");
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) {
            uart_puts(str);
            JS_FreeCString(ctx, str);
        } else {
            uart_puts("[object]");
        }
    }
    uart_puts("\r\n");
    return JS_UNDEFINED;
}

/* Watchdog: abort script execution once the current budget is exhausted */
static int js_interrupt_handler(JSContext *ctx, void *opaque)
{
    (void)ctx;
    (void)opaque;
    return (g_js_deadline_ms != 0 && timer_get_ms() > g_js_deadline_ms) ? 1 : 0;
}

static void js_begin_exec(void)
{
    g_js_deadline_ms = timer_get_ms() + JS_TIME_BUDGET_MS;
}

static void js_end_exec(void)
{
    g_js_deadline_ms = 0;
}

/* Print and clear the pending JS exception (if any) */
static void js_report_exception(void)
{
    if (g_js_context == NULL || !JS_HasException(g_js_context)) {
        return;
    }
    JSValue exc = JS_GetException(g_js_context);
    const char *str = JS_ToCString(g_js_context, exc);
    uart_puts("JS exception: ");
    uart_puts(str != NULL ? str : "<unknown>");
    uart_puts("\r\n");
    if (str != NULL) {
        JS_FreeCString(g_js_context, str);
    }
    JS_FreeValue(g_js_context, exc);
}

int js_init(void)
{
    if (g_js_runtime == NULL) {
        g_js_runtime = JS_NewRuntime();
    }
    if (g_js_runtime == NULL) {
        return -1;
    }
    JS_SetMemoryLimit(g_js_runtime, JS_HEAP_LIMIT);
    JS_SetMaxStackSize(g_js_runtime, JS_STACK_LIMIT);
    JS_SetInterruptHandler(g_js_runtime, js_interrupt_handler, NULL);

    if (g_js_context == NULL) {
        g_js_context = JS_NewContext(g_js_runtime);
    }
    if (g_js_context == NULL) {
        return -1;
    }

    /* Register the C-backed console.log global */
    JSValue global = JS_GetGlobalObject(g_js_context);
    JSValue console_obj = JS_NewObject(g_js_context);
    JSValue log_fn = JS_NewCFunction(g_js_context, (JSCFunction *)js_console_log, "log", 1);
    JS_SetPropertyStr(g_js_context, console_obj, "log", log_fn);
    JS_SetPropertyStr(g_js_context, global, "console", console_obj);

    js_begin_exec();
    JSValue result = JS_Eval(g_js_context, boot_test_js, strlen(boot_test_js),
                             "boot_test.js", 0);
    js_end_exec();
    JS_FreeValue(g_js_context, result);
    js_report_exception();
    return 0;
}

void js_step(void)
{
    if (g_js_runtime == NULL) {
        return;
    }
    JSContext *ctx = NULL;
    int ret;

    js_begin_exec();
    while ((ret = JS_ExecutePendingJob(g_js_runtime, &ctx)) > 0) {
        /* keep draining the pending job queue */
    }
    js_end_exec();

    if (ret < 0) {
        js_report_exception();
    }
}

void js_push_global_str(const char *name, const char *value)
{
    if (g_js_context == NULL || name == NULL || value == NULL) {
        return;
    }
    JSValue global = JS_GetGlobalObject(g_js_context);
    JSValue str = JS_NewString(g_js_context, value);
    JS_SetPropertyStr(g_js_context, global, name, str);
    JS_FreeValue(g_js_context, str);
    JS_FreeValue(g_js_context, global);
}
