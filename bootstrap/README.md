# qnode bootstrap

The Node.js compatibility layer is a single script, split into the parts in
this directory. At build time `cmake/concat_js.cmake` concatenates the parts
in filename order into `build/node_bootstrap.js`, which is then embedded as a
C array and evaluated once at startup.

The parts are **not** ES modules. They share one top-level scope, so:

- declarations are visible across files, exactly as if the parts were one
  file;
- filename order is execution order (hence the numeric prefixes);
- moving code between parts must preserve that order. If a part needs a
  `const` or `class` from another part at load time, it must come later.

## Parts

| File | Contents |
|---|---|
| `00-core.js` | errors, encodings, `Buffer`, `path`, `util` |
| `10-events-stream.js` | `events`, `stream` |
| `20-fs-process.js` | `fs`, `process`/`os`, timers, `console` |
| `30-web.js` | `AbortController`/`EventTarget`, `URL`, `querystring` |
| `40-modules.js` | `node_modules` resolution, CommonJS loader |
| `50-net-http.js` | `net` (including owned-stack selection), `http`, `child_process` |
| `60-crypto.js` | hashes, HMACs, key objects, signatures, KDFs |
| `70-misc.js` | `assert`, `string_decoder`, small core modules, `readline` |
| `80-tls.js` | `tls` |
| `85-websocket.js` | `WebSocket` client and `WebSocketServer` (`node:websocket`) |
| `90-web-streams.js` | WHATWG streams, `MessageChannel`, builtin registry |
| `95-fetch.js` | `fetch`, `Request`/`Response`, web body types |
| `97-npm.js` | npm installer |
| `99-entry.js` | globals, C-facing module loader, worker entry point |

## Adding a builtin

1. Add the implementation to the appropriate part.
2. Register the name in the builtin module registry in `90-web-streams.js`.
3. Add a native primitive to `node.c` and expose it through
   `__qnode_native` if the implementation needs one.
4. Add a test under `tests/qnode/` and make sure it runs through
   `make qnode-test`.
