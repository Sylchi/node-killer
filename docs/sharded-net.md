# Sharded IPv6 transport for `node:net`

Status: implemented on the kernel TCP path. The owned TCP/IP stack in
`netstack.c` is now integrated as the default engine for the managed IPv6
prefix; see `docs/netstack.md`. Sharded listeners continue to use kernel TCP,
so the two can coexist in one process.

The sharded transport uses ordinary kernel TCP sockets, one per IPv6 shard
address. The kernel already demultiplexes by the full 4-tuple, so this keeps
interoperability and hardware offload while removing the shared accept queue
from the hot path: a connection is steered to a shard by its destination
address, and only that shard's listener accepts it.

Setting `shards` or `subnet` selects kernel sockets even when the owned stack
is enabled, because the owned stack does not implement per-shard threads or
per-connection address allocation yet.

## Address layout

A server owns a `/64` prefix. The low 64 bits are split as:

```
|<------------- /64 prefix ------------->|< shard >|<------ slot ------>
 0                                      7 8        9                 15
```

`node:net` uses slot 0 for listener service addresses. Byte 8 is the shard id,
so `shardAddress("fd00:1:2:3::/64", 5)` is `fd00:1:2:3:500::`. Shards 0 through
255 are valid. Per-connection addresses and slot allocation are part of the
owned netstack prototype, not the kernel path.

## Server

```js
const net = require("node:net");

const server = net.createServer((sock) => {
  console.log(sock.shard, sock.localAddress);
  sock.end("hello");
});

server.on("error", console.error);
server.on("shardedFallback", (err) => {
  console.warn("sharding unavailable, using one listener:", err.code);
});

server.listen({
  port: 8080,
  subnet: "fd00:1:2:3::/64",
  shards: 4,
  freeBind: true,          // the /64 is routed to this host
  fallback: true,          // default: fall back to one listener
});
```

`listen()` accepts these additions to the usual `node:net` options:

| Option | Meaning |
| --- | --- |
| `shards` | Number of shard listeners to create (1 to 256). Omit it for the normal single listener; specifying `subnet` enables the shard path even with one listener. |
| `subnet` | IPv6 `/64` used to derive shard addresses. When omitted, `host` is used as the prefix. A host such as `fd00:1:2:3::` is normalized to its `/64`. |
| `freeBind` | Set `IPV6_FREEBIND` (Linux) so addresses in a routed prefix can be bound without being assigned to the interface. Off by default. Also available to clients using `localAddress`. |
| `fallback` | When a shard bind fails with `EADDRNOTAVAIL`, `EAFNOSUPPORT`, `EPROTONOSUPPORT`, `EINVAL`, or `ENODEV`, close the partial set and bind one listener instead. Default `true`. |
| `fallbackHost` | Address for the fallback listener. Defaults to `::` (or `0.0.0.0` if IPv6 is unavailable). |
| `reusePort` | Existing option; sets `SO_REUSEPORT` on each listener. Useful when several processes share a shard address. |

Sharded servers expose:

- `server.sharded` - `true` when the shard listeners were created.
- `server.shardCount` - number of shard listeners, or `0`.
- `server.addresses()` - array of `{ address, family, port, shard }`, one per
  listener. The normal `server.address()` returns the first entry in the
  classic `{ address, family, port }` shape.
- `sock.shard` on accepted sockets - the shard that accepted the connection.
  `sock.localAddress` remains the actual destination address.
- `"shardedFallback"` event - emitted with the original error after a fallback
  listener starts.

When `port` is `0`, the first shard chooses an ephemeral port and the remaining
shards bind the same port. All shard listeners therefore share one port, as a
client would expect.

## Client

Clients can select a shard with `shard` and bind a source address with the
standard `localAddress` / `localPort` options:

```js
const c = net.createConnection({
  host: "fd00:1:2:3::/64", // or use `subnet`
  shard: 2,
  port: 8080,
  localAddress: net.shardAddress("fd00:9:9:9::/64", 2),
  localPort: 0,
  freeBind: true,
});
```

- `shard` resolves the destination with `net.shardAddress(subnet || host, shard)`.
- `subnet` supplies the destination prefix when `host` is omitted.
- `localAddress` binds the client's source address, and `freeBind` permits a
  source address from a routed client prefix.
- `net.shardAddress(prefix, shard)` and `net.shardIndex(address)` convert
  between a prefix and a shard id.

The client source address is what makes return traffic affinity possible when
several client processes or workers each own a source prefix. Without
`localAddress`, the kernel chooses the source address normally.

`http.request()` and `https.request()` forward `shard`, `subnet`,
`localAddress`, `localPort`, and `freeBind` to the socket. Agent pool keys
include the family, shard, subnet, and local address, so connections for
different shards are never reused for one another.

## Deploying a prefix

A socket bound to an address only receives traffic the kernel considers local.
Depending on the deployment, use one of:

```sh
# Assign the /64 to an interface (the usual routed-prefix case).
ip -6 addr add fd00:1:2:3::/64 dev eth0

# Or terminate the whole /64 locally, e.g. on a loopback test rig.
ip -6 route add local fd00:1:2:3::/64 dev lo table local
```

Then either assign the individual shard addresses or enable `freeBind` and
ensure the prefix is routed to the host. A bind can succeed with `freeBind`
even when the prefix is not routed, so verify reachability before relying on
it.

Publish one AAAA record per shard (or let clients choose a shard explicitly)
if you want connection-level spread at the DNS layer. With multiple processes,
either give each process a distinct prefix, or set `reusePort: true` so the
kernel hashes new connections across processes sharing a shard address.

## Semantics and limits

- This is standard TCP. `tcpdump`, `ss`, firewalls, NAT, and TLS behave
  normally.
- Dispatch is by destination address. A client that always connects to the
  first address always uses shard 0; clients must spread across addresses.
- The accept loop drains up to 64 connections per shard per event-loop turn,
  so a busy shard does not starve the others.
- `shards` listeners are IPv6-only. IPv4 and dual-stack listeners keep the
  existing single-listener behavior.
- If the fallback listener is used, `sock.shard` is `undefined` and
  `server.sharded` is `false`.
- This path does not replace kernel TCP for sharded listeners. The owned
  stack, loopback/TUN links, and automatic selection by managed address are
  described in `docs/netstack.md`.

## Tests

```sh
make net-test BUILD_DIR=build
```

`tests/qnode/net_shards.sh` runs the suite inside `unshare -rn` when user namespaces
and `ip` are available, configures a private `/64` on loopback, and exercises
shard address derivation, per-shard listeners, shard selection, client source
binding, fallback, and the `fallback: false` error path. Without user
namespaces it runs the fallback and single-listener cases and skips the rest.
