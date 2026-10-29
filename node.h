#ifndef QNODE_NODE_H
#define QNODE_NODE_H

#include "quickjs.h"

int js_node_init(JSContext *ctx, JSRuntime *rt);
int js_node_start(JSContext *ctx);
/* Register the worker start hook used by worker_threads. Call once in the
   main process before creating workers. */
void js_node_install_worker_hooks(void);
JSValue js_node_run_main(JSContext *ctx, const char *path);

#endif
