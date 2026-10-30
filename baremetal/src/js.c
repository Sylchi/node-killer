/*
 * js.c - QuickJS JavaScript engine integration for the qnode bare-metal kernel (Pi 4)
 *
 * Creates the QuickJS runtime/context, registers the C-backed console.log
 * global, evaluates the boot test program and exposes helpers for pushing
 * text into the JS global object.
 */

#include <string.h>
#include "js.h"
#include "quickjs.h"
#include "uart.h"

static JSRuntime *g_js_runtime = NULL;
static JSContext *g_js_context = NULL;

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

int js_init(void)
{
    if (g_js_runtime == NULL) {
        g_js_runtime = JS_NewRuntime();
    }
    if (g_js_runtime == NULL) {
        return -1;
    }
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

    JS_Eval(g_js_context, boot_test_js, strlen(boot_test_js), "boot_test.js", 0);
    return 0;
}

void js_step(void)
{
    if (g_js_runtime == NULL) {
        return;
    }
    JSContext *ctx = NULL;
    while (JS_ExecutePendingJob(g_js_runtime, &ctx) > 0) {
        /* keep draining the pending job queue */
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
