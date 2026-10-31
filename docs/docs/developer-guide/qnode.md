# qnode internals

`qnode` is the Node.js-compatible runtime built on top of quickjs-ng on
Linux. This page describes how the pieces fit together and where to make
changes.

## Source layout

| Path | Role |
|---|---|
| `qnode.c` | CLI entry point: runtime/context setup, argument parsing, event loop drain |
| `node.c` | Native layer: filesystem, sockets, DNS, child processes, zlib, TLS, crypto, module loading |
| `node_netstack.c` | Virtual-fd bridge between `node.c` sockets and the owned TCP/UDP/ICMP stack |
| `node.h` | Entry points used by `qnode.c` and the worker hook |
| `bootstrap/` | Node compatibility layer, split into ordered parts |
| `netstack.c` | Owned IPv4/IPv6 TCP, UDP and ICMP engine (no kernel sockets) |
| `netstack_l2.c` | Ethernet framing, ARP, IPv6 NDP/router discovery and the neighbour cache |
| `netstack_link.c` | Loopback, Linux TUN and Linux TAP links for the owned stack |
| `vendor/` | zlib, mbedTLS, libsodium, libev, wasm3 |
| `tests/` | Test262-compatible tests plus qnode-only tests |

`node.c` is compiled only on Linux. The upstream `qjs` and `qjsc` targets do
not depend on it. `netstack.c` and `netstack_l2.c` are portable; the
Linux-only pieces are the TUN/TAP links and the `eventfd` virtual descriptors.

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

`node_bootstrap.js` is generated at build time by `scripts/build.js`, which
concatenates the ordered parts in `bootstrap/`. The parts share a single
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

## Networking

`node:net` and `node:dgram` have two engines:

- **Kernel sockets** for `netstack: false`, unmanaged addresses, and the
  sharded TCP transport (`subnet`/`shards`). This is the existing path and
  remains fully interoperable with the host.
- **Owned TCP, UDP and ICMP** for IPv4 and IPv6 sockets inside the managed
  prefixes (default `10.254.0.0/16` and `fd00:dead:beef:99::/64`).
  `native.socket()` returns an `eventfd`-backed virtual fd; `node_netstack.c`
  implements the socket operations on top of `netstack.c`, and the real
  eventfd is what libev polls. UDP adds `sendto`/`recvfrom`/`disconnect`
  natives and shares the virtual-fd bridge with streams. ICMP answers echo
  requests, generates port-unreachable errors for unmatched UDP datagrams, and
  learns path MTUs from fragmentation-needed / packet-too-big errors; it has no
  JavaScript API and is driven by packets arriving on the link.
  The shared IP emitter fragments datagrams to the cached path MTU, and inbound
  fragments are reassembled before checksum validation and dispatch. Path MTU
  is cached per destination and also sizes TCP segments (capped at `NS_MSS`).
- **Ethernet via TAP** (`netstack_l2.c`) when `QNODE_NETSTACK_TAP=1`. The IP
  engine is unchanged; outbound packets are framed and resolved with ARP for
  IPv4 and neighbour solicitation for IPv6, and inbound frames are unwrapped
  before `ns_input()`. The neighbour cache queues a bounded number of packets
  while resolution is in progress. One interface is supported, with a
  longest-prefix route table: configuring an address installs its connected
  route, the optional gateway becomes a default route, and
  `QNODE_NETSTACK_ROUTES` adds entries such as `10.9.0.0/16 via 10.254.0.2`.
  A next hop must be on-link. The default MAC is `02:51:4e:00:00:01` and is set
  with `QNODE_NETSTACK_MAC`. Setting `QNODE_NETSTACK_RD=1` enables IPv6 router
  discovery: the link derives a link-local address, solicits routers and
  installs an expiring default route from advertisements.

When a virtual socket binds, connects or sends to an address outside the
managed prefix, the bridge creates a kernel socket, `dup2`s it onto the same
descriptor and marks the slot free. The JS layer therefore never has to
recreate a `Socket`/`dgram.Socket` just because the engine changed.
`native.isVirtualFd(fd)` exposes the distinction, which the bootstrap uses to
choose read vs. write readiness for non-blocking connect. A wildcard UDP bind
that has not been forced stays on the kernel; an explicit managed bind, a
managed send destination or `netstack: true` selects the owned engine.
`bootstrap/55-dgram.js` implements the Node-shaped `dgram` API on these
primitives.

The stack is driven by three native calls: socket operations pump it
synchronously; an unref'd timer calls `netstackTick()` for RTO retransmits; and
a TUN/TAP link additionally installs a read handler that calls
`netstackPump()`. A TAP link also advances neighbour retries and expiry from
the same tick. The loopback link needs no timer or privileges, but it is
process-local. See `docs/netstack.md` for the packet engine, link layer,
environment variables and limits.

WebSocket support lives in `bootstrap/85-websocket.js`. `http.Server` emits
the standard `'upgrade'`/`'connect'` events, and `node:websocket` provides both
the WHATWG `WebSocket` client and a Node-style `WebSocketServer` that can
attach to an existing HTTP server or listen on its own port. The global
`WebSocket` is installed in `99-entry.js`.

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
module. `setTimeout`, sockets and DNS all register handlers there. Both I/O
handlers and timers support Node's ref/unref semantics: an unref'd timer is
serviced while the loop runs for other work, but does not keep the process
alive by itself.

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
make test              # upstream quickjs-ng suite (qjs)
make qnode-test        # qnode-only tests (crypto, workers, fetch, modules, net, dgram, WebSocket)
make netstack-test     # owned TCP/UDP/ICMP engine, fragment/PMTU and L2/ARP/NDP in isolation
make netstack-tun-test # optional TUN path, including large fragmented datagrams
make netstack-tap-test # optional TAP path: Ethernet frames, ARP and NDP against the kernel
```

Test262 cannot exercise the Node APIs, so qnode tests live in `tests/qnode/`.
`tests.conf` excludes the whole directory, and `tests/run-qnode-tests.sh`
picks up every `*.js` file in it automatically, so adding a test needs no
config change. (`net_shards.js` is run through its `net_shards.sh` wrapper.)
