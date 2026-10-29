/*
 * qnode - Node.js-compatible runtime on quickjs-ng.
 *
 * CLI entry point: creates the runtime, installs the Node bootstrap and
 * runs a CommonJS/ES module, then drains the libev event loop.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <stdbool.h>

#include "quickjs.h"
#include "quickjs-libc.h"
#include "node.h"
#include "qjs-wasm.h"

#ifndef QNODE_VERSION
#define QNODE_VERSION "0.1.0"
#endif

typedef struct {
    JSRuntime *rt;
    JSContext *ctx;
    int exit_code;
    int had_uncaught;
} QNode;

static int file_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static int dir_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

/* Resolve a script path the way Node does for a command-line entry: exact
   path first, then the usual extensions, then a directory's package.json or
   index file. Returns a malloc'd string or NULL. */
static char *resolve_entry(const char *path)
{
    static const char *exts[] = { "", ".js", ".cjs", ".mjs", ".json" };
    static const char *indexes[] = { "index.js", "index.json", "index.cjs",
                                     "index.mjs" };
    char *abs;
    size_t i;

    if (path[0] == '/') {
        abs = strdup(path);
    } else {
        char cwd[4096];
        if (!getcwd(cwd, sizeof(cwd)))
            return NULL;
        size_t n = strlen(cwd) + 1 + strlen(path) + 1;
        abs = malloc(n);
        if (!abs)
            return NULL;
        snprintf(abs, n, "%s/%s", cwd, path);
    }
    if (!abs)
        return NULL;

    for (i = 0; i < sizeof(exts) / sizeof(exts[0]); i++) {
        size_t n = strlen(abs) + strlen(exts[i]) + 1;
        char *cand = malloc(n);
        if (!cand) {
            free(abs);
            return NULL;
        }
        snprintf(cand, n, "%s%s", abs, exts[i]);
        if (exts[i][0] == '\0' && file_exists(cand)) {
            free(abs);
            return cand;
        }
        if (exts[i][0] != '\0' && file_exists(cand)) {
            free(abs);
            return cand;
        }
        free(cand);
    }

    if (dir_exists(abs)) {
        char *pkg_path = malloc(strlen(abs) + 16);
        if (pkg_path) {
            sprintf(pkg_path, "%s/package.json", abs);
            if (file_exists(pkg_path)) {
                /* Let the JS resolver handle the main field: it accepts a
                   directory and reads package.json. */
                free(pkg_path);
                return abs;
            }
            free(pkg_path);
        }
        for (i = 0; i < sizeof(indexes) / sizeof(indexes[0]); i++) {
            size_t n = strlen(abs) + strlen(indexes[i]) + 2;
            char *cand = malloc(n);
            if (!cand)
                continue;
            snprintf(cand, n, "%s/%s", abs, indexes[i]);
            if (file_exists(cand)) {
                free(abs);
                return cand;
            }
            free(cand);
        }
    }

    free(abs);
    return NULL;
}

static void print_usage(FILE *out)
{
    fprintf(out,
        "Usage: qnode [options] [script.js] [arguments]\n"
        "\n"
        "Options:\n"
        "  -e, --eval <script>   evaluate a script\n"
        "  -p, --print <script>  evaluate and print the result\n"
        "  -r, --require <mod>   require a module before running the script\n"
        "      --version         print the qnode version\n"
        "  -h, --help            print this help\n"
        "\n"
        "Commands:\n"
        "  install [pkg...]      install npm packages into node_modules\n"
        "\n"
        "Documentation: https://github.com/quickjs-ng/quickjs\n");
}

static void node_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                   JSValueConst reason, bool is_handled,
                                   void *opaque)
{
    JSValue global, fn, args[3], r;

    (void)opaque;
    /* The tracker fires as soon as a promise is rejected, before a handler
       can be attached in the same turn.  Let the bootstrap defer the report
       to a microtask and cancel it when the promise becomes handled. */
    global = JS_GetGlobalObject(ctx);
    fn = JS_GetPropertyStr(ctx, global, "__qnode_track_rejection");
    if (JS_IsFunction(ctx, fn)) {
        args[0] = JS_DupValue(ctx, promise);
        args[1] = JS_DupValue(ctx, reason);
        args[2] = JS_NewBool(ctx, is_handled);
        r = JS_Call(ctx, fn, JS_UNDEFINED, 3, args);
        if (JS_IsException(r))
            js_std_dump_error(ctx);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        JS_FreeValue(ctx, args[2]);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
}

static void report_exception(JSContext *ctx, QNode *q)
{
    JSValue exc = JS_GetException(ctx);
    q->had_uncaught = 1;
    const char *str = JS_ToCString(ctx, exc);
    fprintf(stderr, "Uncaught%s%s\n", str ? " " : "",
            str ? str : "exception");
    if (str)
        JS_FreeCString(ctx, str);
    if (JS_IsError(exc)) {
        JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (JS_IsString(stack)) {
            const char *s = JS_ToCString(ctx, stack);
            if (s) {
                if (s[0] == '\n')
                    s++;
                fprintf(stderr, "%s\n", s);
                JS_FreeCString(ctx, s);
            }
        }
        JS_FreeValue(ctx, stack);
    }
    JS_FreeValue(ctx, exc);
    if (q->exit_code == 0)
        q->exit_code = 1;
}

static void emit_process_event(JSContext *ctx, const char *name, int code)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue proc = JS_GetPropertyStr(ctx, global, "process");
    if (JS_IsObject(proc)) {
        JSValue fn = JS_GetPropertyStr(ctx, proc, "emit");
        if (JS_IsFunction(ctx, fn)) {
            JSValue args[2];
            args[0] = JS_NewString(ctx, name);
            args[1] = JS_NewInt32(ctx, code);
            JSValue r = JS_Call(ctx, fn, proc, 2, args);
            if (JS_IsException(r))
                JS_FreeValue(ctx, JS_GetException(ctx));
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, args[0]);
            JS_FreeValue(ctx, args[1]);
        }
        JS_FreeValue(ctx, fn);
    }
    JS_FreeValue(ctx, proc);
    JS_FreeValue(ctx, global);
}

int main(int argc, char **argv)
{
    QNode q;
    JSRuntime *rt;
    JSContext *ctx;
    const char *script = NULL;
    const char *eval_src = NULL;
    int print_result = 0;
    char **requires = NULL;
    int nrequires = 0;
    int first_arg = 0;
    int install_mode = 0;

    memset(&q, 0, sizeof(q));

    /* Worker threads re-enter the qnode bootstrap through this hook. */
    js_node_install_worker_hooks();

    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (!strcmp(a, "--version") || !strcmp(a, "-v")) {
            printf("v20.11.0-qnode.%s\n", QNODE_VERSION);
            return 0;
        } else if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
            print_usage(stdout);
            return 0;
        } else if (!strcmp(a, "-e") || !strcmp(a, "--eval")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "qnode: %s requires an argument\n", a);
                return 9;
            }
            eval_src = argv[++i];
        } else if (!strcmp(a, "-p") || !strcmp(a, "--print")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "qnode: %s requires an argument\n", a);
                return 9;
            }
            eval_src = argv[++i];
            print_result = 1;
        } else if (!strcmp(a, "-r") || !strcmp(a, "--require")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "qnode: %s requires an argument\n", a);
                return 9;
            }
            requires = realloc(requires, sizeof(char *) * (nrequires + 1));
            requires[nrequires++] = argv[++i];
        } else if (!strcmp(a, "--")) {
            if (i + 1 < argc) {
                script = argv[i + 1];
                first_arg = i + 2;
            }
            break;
        } else if (a[0] == '-' && a[1] != '\0') {
            fprintf(stderr, "qnode: bad option: %s\n", a);
            print_usage(stderr);
            return 9;
        } else if (!strcmp(a, "install") || !strcmp(a, "i") ||
                   !strcmp(a, "add")) {
            install_mode = 1;
            first_arg = i + 1;
            break;
        } else {
            script = a;
            first_arg = i + 1;
            break;
        }
    }

    rt = JS_NewRuntime();
    if (!rt) {
        fprintf(stderr, "qnode: out of memory\n");
        return 1;
    }
    JS_SetMaxStackSize(rt, 2 << 20);
    js_std_init_handlers(rt);

    ctx = JS_NewContext(rt);
    if (!ctx) {
        fprintf(stderr, "qnode: cannot create JS context\n");
        return 1;
    }
    JS_SetContextOpaque(ctx, &q);
    JS_SetHostPromiseRejectionTracker(rt, node_rejection_tracker, &q);
    js_std_add_helpers(ctx, 0, NULL);

    q.rt = rt;
    q.ctx = ctx;

    if (js_node_init(ctx, rt) < 0) {
        report_exception(ctx, &q);
        goto done;
    }
    if (js_node_start(ctx) < 0) {
        report_exception(ctx, &q);
        goto done;
    }

    /* A .wasm entry point is a WASI command, not a JS module. */
    if (!install_mode && !eval_src && script) {
        size_t slen = strlen(script);
        if (slen > 5 && !strcmp(script + slen - 5, ".wasm")) {
            int wargc = 1 + (argc - first_arg);
            const char **wargv = malloc(sizeof(char *) * wargc);
            JSValue r;
            int i;
            if (!wargv) {
                fprintf(stderr, "qnode: out of memory\n");
                q.exit_code = 1;
                goto done;
            }
            wargv[0] = script;
            for (i = 0; i < argc - first_arg; i++)
                wargv[1 + i] = argv[first_arg + i];
            r = js_wasm_run_file(ctx, script, wargc, wargv);
            free(wargv);
            if (JS_IsException(r)) {
                report_exception(ctx, &q);
                q.exit_code = 1;
            } else {
                int32_t code = 0;
                JS_ToInt32(ctx, &code, r);
                q.exit_code = code;
            }
            JS_FreeValue(ctx, r);
            goto done;
        }
    }

    /* process.argv = [execPath, script|"-e", ...args] */
    {
        char *script_path = NULL;
        int nargs = 0;
        int capacity = argc + 4;
        JSValue *jsargs = malloc(sizeof(JSValue) * capacity);

        jsargs[nargs++] = JS_NewString(ctx, "/proc/self/exe");
        if (install_mode) {
            jsargs[nargs++] = JS_NewString(ctx, "install");
        } else if (script) {
            script_path = resolve_entry(script);
            if (!script_path) {
                fprintf(stderr,
                    "qnode: Cannot find module '%s'\n", script);
                q.exit_code = 1;
                free(jsargs);
                goto done;
            }
            jsargs[nargs++] = JS_NewString(ctx, script_path);
        } else if (eval_src) {
            jsargs[nargs++] = JS_NewString(ctx, "-e");
        } else {
            jsargs[nargs++] = JS_NewString(ctx, "-");
        }
        for (int i = first_arg; i < argc && nargs < capacity; i++)
            jsargs[nargs++] = JS_NewString(ctx, argv[i]);

        JSValue global = JS_GetGlobalObject(ctx);
        JSValue set_argv = JS_GetPropertyStr(ctx, global, "__qnode_set_argv");
        if (JS_IsFunction(ctx, set_argv)) {
            JSValue r = JS_Call(ctx, set_argv, JS_UNDEFINED, nargs, jsargs);
            JS_FreeValue(ctx, r);
        }
        JS_FreeValue(ctx, set_argv);
        JS_FreeValue(ctx, global);
        for (int i = 0; i < nargs; i++)
            JS_FreeValue(ctx, jsargs[i]);
        free(jsargs);

        q.exit_code = 0;
        int failed = 0;

        for (int i = 0; i < nrequires; i++) {
            JSValue global = JS_GetGlobalObject(ctx);
            JSValue fn = JS_GetPropertyStr(ctx, global, "__qnode_require");
            if (JS_IsFunction(ctx, fn)) {
                JSValue arg = JS_NewString(ctx, requires[i]);
                JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
                JS_FreeValue(ctx, arg);
                if (JS_IsException(r)) {
                    report_exception(ctx, &q);
                    failed = 1;
                }
                JS_FreeValue(ctx, r);
            }
            JS_FreeValue(ctx, fn);
            JS_FreeValue(ctx, global);
            if (failed)
                break;
        }

        if (install_mode && !failed) {
            JSValue global = JS_GetGlobalObject(ctx);
            JSValue fn = JS_GetPropertyStr(ctx, global, "__qnode_npm_install");
            JSValue arr = JS_NewArray(ctx);
            int32_t n = 0;
            for (int i = first_arg; i < argc; i++)
                JS_SetPropertyUint32(ctx, arr, n++,
                                     JS_NewString(ctx, argv[i]));
            if (JS_IsFunction(ctx, fn)) {
                JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arr);
                if (JS_IsException(r)) {
                    report_exception(ctx, &q);
                    failed = 1;
                } else {
                    /* js_std_await consumes its argument */
                    JSValue awaited = js_std_await(ctx, r);
                    if (JS_IsException(awaited)) {
                        report_exception(ctx, &q);
                        failed = 1;
                    }
                    JS_FreeValue(ctx, awaited);
                }
            }
            JS_FreeValue(ctx, arr);
            JS_FreeValue(ctx, fn);
            JS_FreeValue(ctx, global);
        } else if (eval_src && !failed) {
            JSValue ret = JS_Eval(ctx, eval_src, strlen(eval_src),
                                  "<eval>", JS_EVAL_TYPE_GLOBAL);
            if (JS_IsException(ret)) {
                report_exception(ctx, &q);
                failed = 1;
            } else if (print_result) {
                JSValue global = JS_GetGlobalObject(ctx);
                JSValue fn = JS_GetPropertyStr(ctx, global, "__qnode_inspect");
                if (JS_IsFunction(ctx, fn)) {
                    JSValue s = JS_Call(ctx, fn, JS_UNDEFINED, 1, &ret);
                    if (JS_IsString(s)) {
                        const char *cs = JS_ToCString(ctx, s);
                        if (cs) {
                            printf("%s\n", cs);
                            JS_FreeCString(ctx, cs);
                        }
                    }
                    JS_FreeValue(ctx, s);
                }
                JS_FreeValue(ctx, fn);
                JS_FreeValue(ctx, global);
            }
            JS_FreeValue(ctx, ret);
        } else if (script_path) {
            JSValue ret = js_node_run_main(ctx, script_path);
            if (JS_IsException(ret)) {
                report_exception(ctx, &q);
                failed = 1;
            } else {
                /* js_std_await consumes its argument */
                JSValue awaited = js_std_await(ctx, ret);
                if (JS_IsException(awaited)) {
                    report_exception(ctx, &q);
                    failed = 1;
                }
                JS_FreeValue(ctx, awaited);
            }
        } else {
            /* No script: leave the runtime running so `-i`-like uses and
               piped stdin work. Simply exit when the loop drains. */
        }

        if (!failed) {
            /* Drain the loop, emitting beforeExit whenever it runs dry.
               If a handler schedules more work, run the loop again. */
            for (;;) {
                if (js_std_loop(ctx) < 0) {
                    if (JS_IsException(JS_GetException(ctx)))
                        report_exception(ctx, &q);
                    break;
                }
                emit_process_event(ctx, "beforeExit", q.exit_code);
                if (!js_std_has_pending(ctx))
                    break;
            }
        }
        free(script_path);
    }

done:
    /* run process 'exit' handlers, then report the exit code */
    {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue proc = JS_GetPropertyStr(ctx, global, "process");
        if (JS_IsObject(proc)) {
            JSValue code = JS_GetPropertyStr(ctx, proc, "exitCode");
            if (JS_IsNumber(code)) {
                int32_t c;
                JS_ToInt32(ctx, &c, code);
                if (q.exit_code == 0)
                    q.exit_code = c;
            }
            JS_FreeValue(ctx, code);
        }
        JS_FreeValue(ctx, proc);
        JS_FreeValue(ctx, global);
        emit_process_event(ctx, "exit", q.exit_code);
    }

    free(requires);
    node_tls_thread_cleanup();
    JS_FreeContext(ctx);
    js_std_free_handlers(rt);
    JS_FreeRuntime(rt);
    return q.exit_code;
}
