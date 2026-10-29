# Owned TCP/IP stack (`netstack`)

Status: integrated. `node:net` now hands managed IPv4 and IPv6 TCP streams to
the in-process stack in `netstack.c` instead of the kernel. UDP and unmanaged
addresses still use kernel sockets, and `netstack: false` restores the kernel
path per socket.

The kernel-backed sharded transport is still available and is documented in
`docs/sharded-net.md`. The two features share the same `/64` address layout
and the same `net.shardAddress()` helpers, but they use different engines:
sharded listeners use kernel TCP, the managed prefix uses the owned stack.

## Architecture

```
  node:net / http / WebSocket
             |
       native.socket/read/write/...
             |
   node_netstack.c  (virtual fd bridge)
      |            |
   eventfd      netstack.c  (IPv4/IPv6 + TCP state machine)
                   |
              netstack_link.c
              /             \
       loopback          Linux TUN
```

- `netstack.c` is transport-agnostic. It consumes and emits complete IPv4 or
  IPv6 packets; it never opens a kernel socket. IPv4 and IPv6 share the TCP
  state machine and differ only in header encode/decode, checksum
  pseudo-headers and dispatch.
- `netstack_link.c` is the link: an in-process loopback or a Linux TUN device.
- `node_netstack.c` exposes the stack as descriptors. Each virtual fd is an
  `eventfd`; `node.c` routes socket natives to the bridge when the descriptor
  is virtual, and libev polls the underlying eventfd as usual.
- `bootstrap/50-net-http.js` treats a virtual fd like any other non-blocking
  socket. Connect completion uses the read handler, because a virtual fd has
  no writable-side event of its own.

## Selecting the owned stack

`net.connect()` and `net.createServer()` accept a `netstack` option:

```js
const net = require("node:net");

// Force this socket onto the owned stack.
const server = net.createServer({ netstack: true }, (sock) => {
  sock.end("hello from userspace TCP");
});

server.listen({ port: 8080, host: net.netstackAddress(), netstack: true });

// Force the kernel even for an address in the managed prefix.
const kernelSocket = net.connect({ host: "...", port: 80, netstack: false });
```

The default is automatic:

- An IPv4 or IPv6 stream socket whose bind or connect address lies inside the
  matching managed prefix stays on the owned stack.
- Any other address is converted to a real kernel socket in place, so the
  descriptor number and the JS `Socket` object stay valid.
- UDP sockets, `shards`/`subnet` listeners, and sockets created when the stack
  could not be initialised still use the kernel.
- `netstack: true` keeps the socket on the owned stack even when the address
  is outside the managed prefix (for example `127.0.0.1`).

`net.netstackInfo()` reports the engine:

```js
net.netstackInfo();
// { enabled: true, address: "fd00:dead:beef:99::1",
//   address4: "10.254.0.1", link: "loopback", fd: -1 }
```

`fd` is the TUN descriptor, or `-1` on the loopback link.
`net.netstackAddress()` returns the IPv6 address; `net.netstackAddress(4)`
returns the IPv4 address.

## Addressing

The default IPv6 prefix is `fd00:dead:beef:99::/64` and the default IPv4
prefix is `10.254.0.0/16`. The stack owns one stable local address in each:
`fd00:dead:beef:99::1` and `10.254.0.1`. In plain mode, client connections use
the local address for the destination family as their source, and listeners
may bind any explicit address inside the corresponding prefix.

IPv4 has no shard byte, so every IPv4 packet is dispatched to shard 0. The
sharded `/64` address allocation described below remains IPv6-only.

The low 64 bits of an address still follow the sharded layout used by the
kernel path:

```
|<------------- /64 prefix ------------->|< shard >|<------ slot ------>
 0                                      7 8        9                 15
```

Plain mode keeps the current single-shard design: every packet is dispatched
to shard 0, and the destination address is recorded as the connection's local
address. The shard byte is therefore available for a future threaded
dispatcher without changing the wire format, but it is not used for
demultiplexing yet.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `QNODE_NETSTACK=0` | Disable the owned stack; all sockets use the kernel. |
| `QNODE_NETSTACK_PREFIX` | Override the managed IPv6 `/64`, e.g. `fd00:1:2:3::/64`. |
| `QNODE_NETSTACK_IPV4_PREFIX` | Override the managed IPv4 range, e.g. `10.254.0.0/16` or `192.168.99.0/24`. |
| `QNODE_NETSTACK_TUN=1` | Use a TUN link instead of the in-process loopback. |
| `QNODE_NETSTACK_TUN_NAME` | TUN interface name, e.g. `qn0`. Defaults to a kernel-assigned name. |

## Links

### Loopback

The default link injects emitted packets straight back into the same stack.
It needs no privileges and is what the integration tests use. A client and
server in the same process can talk over the owned stack with no external
interface, route or address configuration.

Because the stack is process-local, loopback does **not** connect two qnode
processes, and it does not reach the host network.

### TUN

Set `QNODE_NETSTACK_TUN=1` to move packet I/O to a TUN device:

```sh
sudo ip tuntap add dev qn0 mode tun user "$USER"
sudo ip link set qn0 up
sudo ip -6 addr add fd00:dead:beef:99::2/64 dev qn0
sudo ip addr add 10.254.0.2/16 dev qn0

QNODE_NETSTACK=1 QNODE_NETSTACK_TUN=1 QNODE_NETSTACK_TUN_NAME=qn0 \
  ./qnode app.js
```

The stack keeps `fd00:dead:beef:99::1` and `10.254.0.1`; `::2` and `10.254.0.2`
are the host side of the link. Add routes so the host knows which destinations
belong to the stack, and ensure the managed prefixes are routed to the TUN
device. Incoming packets wake
the TUN read handler, and an unref'd 20 ms heartbeat drives retransmission
timers. The heartbeat only runs while other work keeps the event loop alive, so
an idle `qnode -e` still exits.

Creating a TUN device normally needs `CAP_NET_ADMIN` (or a user namespace).
The loopback link remains the default because it works unprivileged.

## TCP behaviour

Implemented:

- IPv4 and IPv6 header encode/decode, including IP and TCP checksums with the
  correct pseudo-header for each family;
- SYN / SYN-ACK / ACK handshake and accept queue;
- in-order data transfer, ACK, PSH and a receive ring;
- FIN close with `FIN_WAIT_1`, `FIN_WAIT_2`, `CLOSE_WAIT`, `LAST_ACK` and
  `TIME_WAIT`;
- fixed-RTO retransmission of unacknowledged data, including data dropped
  because the peer's receive buffer was full;
- non-blocking accept/read/write/shutdown through the virtual fd bridge;
- `SO_ERROR`, `SO_REUSEADDR`-style option bookkeeping and address queries
  used by `node:net`.

Current limits:

- TCP only. UDP, ICMP, IPv4/IPv6 fragmentation and reassembly are not
  implemented; those packets are dropped, and UDP stays on the kernel path.
- No out-of-order reassembly, SACK, window scaling, congestion control or
  delayed ACK. The receive window is a fixed 64 KiB ring; peers that exceed it
  are retransmitted into after the application reads.
- No cross-process loopback. Two processes need a TUN link (or a future
  shared-memory/raw link).
- Path MTU discovery is not implemented; the stack emits 1400-byte segments.
- TLS over a virtual fd is routed through the bridge, but there is no
  dedicated regression test yet.
- IPv4 is plain-only. There is no shard byte in an IPv4 header, so sharded
  listener allocation remains an IPv6 feature.

## Sharded transport relationship

The kernel sharded server (`subnet` + `shards`) is still the supported path
for spreading accepted connections across multiple kernel listeners. Setting
`shards` or `subnet` forces kernel sockets, even if `netstack: true` is also
present, because the owned stack does not yet implement per-shard threads or
connection-address allocation.

## Testing

```sh
make netstack-test       # C engine: handshake, data, close, retransmit, dispatch
make netstack-tun-test   # optional TUN path in a private user+network namespace
make qnode-test          # includes tests/qnode/netstack_socket.js
```

`tests/qnode/netstack_socket.js` runs the JS integration end to end over
loopback: explicit and automatic netstack selection for both families,
concurrent connections, IPv6 and IPv4 binary echoes spanning multiple MSS,
forced IPv4 on `127.0.0.1`, and kernel fallback for unmanaged addresses. The
WebSocket suite in `tests/qnode/websocket.js` also runs over `node:net` and
can be pointed at managed addresses for manual testing.

`tests/qnode/netstack_tun.sh` starts a TUN-backed stack in `unshare -rn`, adds
IPv6 and IPv4 host-side addresses, and connects to both with kernel clients.
It skips (and succeeds) when user namespaces, `ip(8)` or `/dev/net/tun` are
unavailable.

The C test is `tests/netstack_test.c`; it links the stack directly and needs no
runtime or privileges.
