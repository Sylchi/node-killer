# qnode internals

`qnode` is the Node.js-compatible runtime built on top of quickjs-ng on
Linux. This page describes how the pieces fit together and where to make
changes.

## Source layout

| Path | Role |
|---|---|
| `qnode.c` | CLI entry point: runtime/context setup, argument parsing, event loop drain |
| `node.c` | Native layer: filesystem, sockets, DNS, child processes, zlib, TLS, crypto, module loading |
| `node.h` | Entry points used by `qnode.c` and the worker hook |
| `bootstrap/` | Node compatibility layer, split into ordered parts |
| `netstack.c` | Experimental userspace TCP stack; linked only into `netstack_test` |
| `vendor/` | zlib, mbedTLS, libsodium, libev, wasm3 |
| `tests/` | Test262-compatible tests plus qnode-only tests |

`node.c` is compiled only on Linux. The upstream `qjs` and `qjsc` targets do
not depend on it.

## Boot sequence

1. `qnode.c` creates the `JSRuntime`/`JSContext` and calls `js_node_init()`.
2. `js_node_init()` builds the `__qnode_native` and `__qnode_consts` globals
   from `node.c`, then evaluates the embedded bootstrap.
3. The bootstrap installs globals (`process`, `Buffer`, timers, console),
   the CommonJS loader and the builtin module registry.
4. `js_node_run_main()` loads the requested entry point as CommonJS or ESM,
   then `qnode.c` drains the libev event loop.

The bootstrap is evaluated once per context, including inside workers.

## The bootstrap

`node_bootstrap.js` is generated at build time by concatenating the ordered
parts in `bootstrap/` (`cmake/concat_js.cmake`). The parts share a single
top-level scope; see `bootstrap/README.md` for the ordering rules and a
table of contents.

This is deliberate: the compatibility layer needs mutual recursion between
the loader, builtin modules and globals, which is awkward to express as ES
modules. Keep the parts ordered and treat cross-part references as ordinary
top-level bindings.

## Native bridge

`node.c` exposes primitives as `__qnode_native.<name>`; constants live in
`__qnode_consts`. The bootstrap wraps them in Node-shaped APIs. When adding
an API:

1. Add the C function and register it in the `native` object in `node.c`.
2. Add the wrapper to the relevant `bootstrap/*.js` part.
3. Add a test under `tests/` and wire it into `tests/run-qnode-tests.sh`.

C functions follow a common shape: they take `JSValueConst` arguments,
return `JSValue`, and use `node_get_bytes()`/`node_free_bytes()` for buffers
that may be strings, `Buffer`s, typed arrays or `ArrayBuffer`s.

## Module loading

- CommonJS resolution and evaluation live in
  `bootstrap/40-modules.js` (`resolveRequest`, `loadCJS`).
- ESM resolution is driven from `node.c`: the `node_normalize()` and
  `node_load()` module-loader hooks call back into `__qnode_resolve` and
  `__qnode_import_cjs` in the bootstrap, then hand plain files to
  `js_module_load()` from quickjs-libc.
- Builtins are exposed to ESM through `node_wrap_module()`: the bootstrap
  returns a plain object, and `node.c` synthesises a C module whose exports
  mirror that object's own enumerable properties, plus a `default` export.
  CommonJS modules imported from ESM use the same path.
- `package.json` `"type"` and extension rules are implemented by
  `moduleKind()` in the bootstrap.

## Event loop and workers

The event loop is quickjs-libc's libev loop, reached through the `qjs:os`
module. `setTimeout`, sockets and DNS all register handlers there.

Workers are real threads. Each worker gets its own context and re-runs the
bootstrap with `__qnode_worker_mode` set; `bootstrap/99-entry.js` then loads
the worker entry file. `MessagePort`/`BroadcastChannel` sit in
`bootstrap/90-web-streams.js`.

**Known limitation:** TLS state (`node_tls_contexts`, `node_tls_conns`,
`node_tls_system_ca` in `node.c`) is process-global and not synchronised.
Concurrent TLS use from multiple workers is not safe yet. Crypto RNG state
*is* thread-local.

## Testing

```bash
make test        # upstream quickjs-ng suite (qjs)
make qnode-test  # qnode-only tests (crypto, workers, fetch, modules, net)
```

Test262 cannot exercise the Node APIs, so qnode tests live in `tests/qnode/`.
`tests.conf` excludes the whole directory, and `tests/run-qnode-tests.sh`
picks up every `*.js` file in it automatically, so adding a test needs no
config change. (`net_shards.js` is run through its `net_shards.sh` wrapper.)
