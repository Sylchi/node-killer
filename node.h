#ifndef QNODE_NODE_H
#define QNODE_NODE_H

#include "quickjs.h"

int js_node_init(JSContext *ctx, JSRuntime *rt);
int js_node_start(JSContext *ctx);
JSValue js_node_run_main(JSContext *ctx, const char *path);

#endif
