# Owned TCP/IP stack (`netstack`)

Status: integrated. `node:net` hands managed IPv4 and IPv6 TCP streams and
`node:dgram` UDP sockets to the in-process stack in `netstack.c` instead of the
kernel. The stack also answers IPv4 and IPv6 ICMP echo requests, reports
unreachable UDP ports, fragments and reassembles IP packets, and learns path
MTUs from ICMP errors. A separate link layer (`netstack_l2.c`) adds Ethernet
framing, ARP for IPv4 and IPv6 neighbour discovery, so the stack can run on a
Linux TAP device as a real Ethernet peer. Unmanaged addresses still use kernel
sockets, and `netstack: false` restores the kernel path per socket.

The kernel-backed sharded transport is still available and is documented in
`docs/sharded-net.md`. The two features share the same `/64` address layout
and the same `net.shardAddress()` helpers, but they use different engines:
sharded listeners use kernel TCP, the managed prefix uses the owned stack.

## Architecture

```
  node:net / node:dgram / http / WebSocket
             |
       native.socket/read/write/sendto/recvfrom
             |
   node_netstack.c  (virtual fd bridge)
      |            |
   eventfd      netstack.c  (IPv4/IPv6 + TCP + UDP + ICMP)
                   |
              netstack_link.c
              /      |        \
       loopback   Linux TUN   Linux TAP
                                  |
                            netstack_l2.c
                       (Ethernet + ARP + NDP)
```

- `netstack.c` is transport-agnostic. It consumes and emits complete IPv4 or
  IPv6 packets; it never opens a kernel socket. IPv4 and IPv6 share the TCP
  state machine, the UDP socket table and the ICMP echo logic, and differ only
  in header encode/decode, checksum pseudo-headers and dispatch.
- `netstack_l2.c` owns one Ethernet interface: framing, ARP, IPv6 neighbour
  solicitation/advertisement and the neighbour cache. It sits between the IP
  engine and a frame transport.
- `netstack_link.c` is the link: an in-process loopback, a Linux TUN device
  carrying bare IP packets, or a Linux TAP device carrying Ethernet frames
  through `netstack_l2.c`.
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

- An IPv4 or IPv6 socket whose bind or connect address lies inside the
  matching managed prefix stays on the owned stack. This applies to both TCP
  streams and UDP datagrams.
- Any other address is converted to a real kernel socket in place, so the
  descriptor number and the JS `Socket`/`dgram.Socket` object stay valid.
- A UDP socket that sends first is placed on the owned engine when the
  destination is managed (or when forced); otherwise it falls back to the
  kernel. A wildcard bind on an unforced UDP socket also stays on the kernel.
- `shards`/`subnet` listeners, and sockets created when the stack could not be
  initialised, still use the kernel.
- `netstack: true` keeps the socket on the owned stack even when the address
  is outside the managed prefix (for example `127.0.0.1`).

`net.netstackInfo()` reports the engine:

```js
net.netstackInfo();
// { enabled: true, address: "fd00:dead:beef:99::1",
//   address4: "10.254.0.1", link: "loopback", fd: -1 }
```

`fd` is the TUN/TAP descriptor, or `-1` on the loopback link. `link` is the
interface name for a TUN/TAP link, or `"loopback"`.
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
| `QNODE_NETSTACK_PREFIX` | Override the managed IPv6 range, e.g. `fd00:1:2:3::/64`. The prefix length is honoured for on-link decisions and defaults to 64. |
| `QNODE_NETSTACK_IPV4_PREFIX` | Override the managed IPv4 range, e.g. `10.254.0.0/16` or `192.168.99.0/24`. The prefix length is honoured for on-link decisions. |
| `QNODE_NETSTACK_TUN=1` | Use a TUN link instead of the in-process loopback. |
| `QNODE_NETSTACK_TUN_NAME` | TUN interface name, e.g. `qn0`. Defaults to a kernel-assigned name. |
| `QNODE_NETSTACK_TAP=1` | Use a TAP (Ethernet) link. Takes precedence over TUN. |
| `QNODE_NETSTACK_TAP_NAME` | TAP interface name, e.g. `qn0`. Defaults to a kernel-assigned name. |
| `QNODE_NETSTACK_MAC` | Source MAC for a TAP link. Defaults to `02:51:4e:00:00:01`. |
| `QNODE_NETSTACK_GATEWAY4` | Optional default IPv4 gateway for off-link destinations. |
| `QNODE_NETSTACK_GATEWAY6` | Optional default IPv6 gateway for off-link destinations. |

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

### TAP

Set `QNODE_NETSTACK_TAP=1` to carry real Ethernet frames instead of bare IP
packets:

```sh
sudo ip tuntap add dev qn0 mode tap user "$USER"
sudo ip link set dev qn0 address 02:51:4e:00:00:02
sudo ip link set qn0 up
sudo ip -6 addr add fd00:dead:beef:99::2/64 dev qn0 nodad
sudo ip addr add 10.254.0.2/16 dev qn0

QNODE_NETSTACK=1 QNODE_NETSTACK_TAP=1 QNODE_NETSTACK_TAP_NAME=qn0 \
QNODE_NETSTACK_MAC=02:51:4e:00:00:01 \
  ./qnode app.js
```

The stack keeps `fd00:dead:beef:99::1` and `10.254.0.1`; the kernel side of the
device uses the `::2` and `.2` addresses. The stack answers ARP requests for its
IPv4 address and neighbour solicitations for its IPv6 address, and resolves the
kernel side before transmitting. The host does not need a static neighbour
entry; ARP and NDP populate the cache in both directions.

The stack uses the destination directly when it is on-link and the configured
gateway when it is not. There is no full routing table and only one interface,
so a TAP link reaches its on-link prefix plus destinations behind the optional
`QNODE_NETSTACK_GATEWAY4`/`QNODE_NETSTACK_GATEWAY6` next hop. Without a
gateway, an off-link destination is resolved as if it were on-link and normally
fails.

## Link layer: Ethernet, ARP and NDP

`netstack_l2.c` is independent of the transport. Tests drive it over a
simulated Ethernet segment; the TAP link drives it with frames read from and
written to `/dev/net/tun`.

- Outbound IP packets are prefixed with a 14-byte Ethernet header. The
  EtherType follows the IP version (`0x0800` or `0x86dd`).
- IPv4 uses ARP: requests are broadcast, replies are unicast, and both request
  senders and reply senders are learnt. IPv4 limited broadcast
  (`255.255.255.255`), the subnet broadcast address and multicast destinations
  are framed with the all-ones or `01:00:5e:xx:xx:xx` MAC without a neighbour
  lookup.
- IPv6 uses neighbour solicitation (type 135) and advertisement (type 136).
  Solicitations go to the solicited-node multicast address and MAC
  (`33:33:xx:xx:xx:xx`); advertisements are sent directly to the solicitor.
  Other multicast destinations are mapped to `33:33` MACs without resolution.
- Frames addressed to the interface's own IP address are delivered straight
  back into `ns_input()` without touching the wire, so same-process loopback
  still works on a TAP link.
- ARP requests for the interface address are answered. NDP solicitations are
  answered only for the interface's own address and not for duplicate address
  detection probes, which carry an unspecified source.
- The neighbour cache holds 64 entries. An entry is *incomplete* while requests
  are outstanding and *reachable* afterwards. Probes are retried every second,
  up to three transmissions, and a reachable entry expires after 60 seconds.
- Packets waiting for resolution are queued: at most 64 packets in total and 8
  per neighbour. Overflow, probe exhaustion and malformed input are counted as
  drops rather than blocking the caller.
- Incoming NDP messages are validated before use: IPv6 payload, hop limit 255,
  next header 58, a valid ICMPv6 checksum and a message type of 135 or 136. NDP
  is intercepted before the packet reaches the IP engine.

`NsL2Stats` exposes `rx_frames`, `tx_frames`, `rx_arp`, `tx_arp`, `rx_ndp`,
`tx_ndp`, `local_delivered`, `neighbor_hits`, `neighbor_misses`,
`neighbors_created`, `neighbor_timeouts`, `queued`, `queue_dropped` and
`dropped`.

Current link-layer limits:

- No router advertisements, SLAAC, duplicate address detection for the
  interface address, or neighbour-unreachability detection beyond expiry.
- No IGMP/MLD membership; multicast and broadcast are framed and transmitted,
  but incoming multicast is only accepted for delivery to the IP engine.
- One interface per stack, with one on-link prefix and one optional gateway per
  address family.

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

TCP segments are sized from the cached path MTU (see below) and capped at
`NS_MSS` (1400 bytes). A smaller PMTU therefore produces smaller segments
without involving IP fragmentation.

Current limits:

- No SACK, window scaling, congestion control or delayed ACK. Segments are
  delivered in order; the receive window is a fixed 64 KiB ring, and peers that
  exceed it are retransmitted into after the application reads.
- No cross-process loopback. Two processes need a TUN or TAP link (or a future
  shared-memory/raw link).
- TLS over a virtual fd is routed through the bridge, but there is no
  dedicated regression test yet.
- IPv4 is plain-only. There is no shard byte in an IPv4 header, so sharded
  listener allocation remains an IPv6 feature.

## Fragmentation, reassembly and PMTU

All outbound IP traffic (TCP, UDP and ICMP) goes through a shared emitter:

- IPv4 fragments use one IP identification per datagram and set MF plus the
  fragment offset. `DF` is set only when no fragmentation is needed.
- IPv6 uses a Fragment extension header (next header 44) with a 32-bit
  identification. Non-fragmented packets are emitted without the extension
  header.
- Fragment sizes are computed from the destination's path MTU and rounded down
  to a multiple of 8 bytes.

Inbound fragments are reassembled before checksum validation and dispatch:

- The key is address family, source, destination, upper-layer protocol and
  identification.
- Up to 8 datagrams are reassembled concurrently. A set expires 30 seconds
  after its most recent fragment, and incomplete, overlapping-invalid or
  oversized sets are dropped and counted in `reassembly_dropped`.
- Fragments may arrive out of order; the bitmap accepts overlapping duplicates.
- IPv4 reassembly honours header options by preserving the first fragment's
  header. Only the IPv6 Fragment extension header is parsed; other IPv6
  extension headers remain unsupported.

Path MTU is cached per destination:

- 32 entries with a 10-minute lifetime; when full, the entry closest to
  expiry is evicted first.
- Values are clamped to the link MTU (1500) and the family minimum: 68 for
  IPv4 and 1280 for IPv6. The lookup returns the link MTU when no entry exists.
- ICMPv4 destination-unreachable / fragmentation-needed (type 3, code 4) and
  ICMPv6 packet-too-big (type 2) lower the cached value. Reports never raise it,
  so a stale error cannot undo a newer, smaller observation.
- `ns_path_mtu()` reads the current value and `ns_path_mtu_set()` overrides it;
  setting 0 removes the entry and restores the link MTU.

`NsStats` exposes `fragments_rx`, `fragments_tx`, `reassembled`,
`reassembly_dropped` and `pmtu_updates`.

## UDP behaviour

The UDP engine shares the IP layer and the virtual-fd bridge with TCP. A UDP
socket is identified separately from a TCP connection and is opened with
`ns_udp_open()`, which binds immediately (port 0 picks an ephemeral port in
the 49152–65535 range). The engine supports:

- IPv4 and IPv6 headers and pseudo-header checksums;
- exact-address and wildcard binds in one family; an exact bind wins over a
  wildcard bind for the same port;
- `SO_REUSEADDR` between datagram sockets, modelled as "both sockets asked
  for it", matching the usual Linux bind rule;
- connected sockets that filter input by peer address and port and allow
  `send()`/`sendto(NULL)` without repeating the destination;
- `connect()`, `disconnect()`, `send()`, `send(offset, length, ...)`,
  `bind()`, `address()`, `remoteAddress()`, `close()` and the usual
  `message`/`listening`/`connect`/`close`/`error` events in `node:dgram`.

Limits and errors:

- At most 256 UDP sockets per stack, 64 queued datagrams and 256 KiB of
  queued payload per socket. Datagrams that arrive for a full queue are
  counted as drops; datagrams for no matching socket also generate an ICMP
  port-unreachable error.
- `NS_EMSGSIZE`/`EMSGSIZE` only when the datagram cannot be represented on the
  wire: the IPv4 UDP payload maximum is 65507 bytes (`65535 - 20 - 8`) and the
  IPv6 maximum is 65527 bytes (`65535 - 8`). Datagrams larger than the path
  MTU up to those limits are fragmented by the IP layer rather than rejected.
- `EADDRINUSE` on a conflicting bind; `EDESTADDRREQ` when an unconnected
  socket sends without a destination; `ENOTCONN` for a disconnected peer
  query. A receive buffer smaller than the datagram truncates it.
- Every transmitted datagram carries a checksum; a computed zero is sent as
  `0xffff`, as required for IPv6. Incoming IPv6 datagrams with a zero checksum
  are dropped.

The `dgram` module is implemented in `bootstrap/55-dgram.js`. It uses the same
`native.socket(..., SOCK_DGRAM, ...)`, `bind`, `sendto`, `recvfrom`, `connect`
and `disconnect` primitives as the TCP path. Broadcast and multicast
membership setters are accepted as no-ops for API compatibility. An outbound
datagram to a broadcast or multicast destination is framed and transmitted by
the link layer on a TAP link, but the engine does not implement receive-side
delivery to matching sockets or multicast membership filtering.

## ICMP behaviour

The engine implements the subset needed for reachability tests and UDP error
reporting:

- IPv4 echo requests (type 8) are answered with type 0; ICMPv6 echo requests
  (type 128) are answered with type 129. The reply is sourced from the address
  the request was sent to, sent back to the request's source, and preserves the
  identifier, sequence number and payload.
- Checksums use the ICMP message for IPv4 and the ICMPv6 pseudo-header for
  IPv6. Invalid checksums and truncated messages are dropped.
- A UDP datagram with no matching socket produces ICMPv4 destination
  unreachable / port unreachable (type 3, code 3) or ICMPv6 destination
  unreachable / port unreachable (type 1, code 4). The IPv4 error quotes the
  original IP header plus eight bytes; IPv6 quotes up to the 1280-byte
  minimum MTU.
- ICMPv4 fragmentation-needed and ICMPv6 packet-too-big errors update the path
  MTU cache as described above.
- Errors are suppressed for packets whose source or destination is
  unspecified, multicast or broadcast.

`ns_icmp_echo()` sends an echo request from a local to a remote address and is
used by the C tests. Messages larger than the path MTU are fragmented. There is
no JavaScript ping API; a host `ping` reaches the stack through the TUN link.
`NsStats.icmp_rx` and `NsStats.icmp_tx` count received messages (echo requests
and errors) and emitted replies and errors.

Limits:

- Only echo request/reply, UDP port-unreachable generation and PMTU learning
  from fragmentation-needed / packet-too-big are implemented. Redirect,
  time-exceeded and parameter-problem messages are neither generated nor acted
  on.
- Other incoming ICMP errors are counted but not reported to TCP or UDP
  sockets, so there is no error-driven socket failure or retransmission hint.
- No broadcast or multicast echo replies are sent.

## Sharded transport relationship

The kernel sharded server (`subnet` + `shards`) is still the supported path
for spreading accepted connections across multiple kernel listeners. Setting
`shards` or `subnet` forces kernel sockets, even if `netstack: true` is also
present, because the owned stack does not yet implement per-shard threads or
connection-address allocation.

## Testing

```sh
make netstack-test       # C engine: TCP, UDP, ICMP, dispatch, retransmit, limits
make netstack-tun-test   # optional TUN path in a private user+network namespace
make netstack-tap-test   # optional TAP/ARP/NDP path in a private namespace
make qnode-test          # includes netstack_socket.js and netstack_dgram.js
```

`tests/netstack_test.c` covers IPv4 and IPv6 datagram round-trips, ephemeral
ports, wildcard and exact binds, reuse rules, connected sockets, disconnect,
queue ordering, truncation, checksum handling and the protocol-maximum size
errors. It also checks IPv4/IPv6 echo request/reply fields and checksums, the
IPv4/IPv6 UDP port-unreachable errors and their quoted packets, and
fragmentation/reassembly: multi-fragment datagrams in both families,
out-of-order delivery, reduced path MTU sizing and the public PMTU API. PMTU
learning is exercised with crafted ICMPv4 fragmentation-needed and ICMPv6
packet-too-big messages, including the downward-only rule and family minimums,
and TCP is checked to chunk writes at a reduced PMTU.

`tests/qnode/netstack_socket.js` runs the TCP integration end to end over
loopback: explicit and automatic netstack selection for both families,
concurrent connections, IPv6 and IPv4 binary echoes spanning multiple MSS,
forced IPv4 on `127.0.0.1`, and kernel fallback for unmanaged addresses.

`tests/qnode/netstack_dgram.js` does the same for UDP: owned IPv4 and IPv6
datagrams, auto-selection by address, send-first auto-binding, queued
messages, connected sockets and peer filtering, `disconnect()`, kernel
fallback, forced `127.0.0.1`, the `ERR_SOCKET_DGRAM_*` errors, `EADDRINUSE`
and `EMSGSIZE` at the protocol maximum. The WebSocket suite
in `tests/qnode/websocket.js` also runs over `node:net` and can be pointed at
managed addresses for manual testing.

`tests/qnode/netstack_tun.sh` starts a TUN-backed stack in `unshare -rn`, adds
IPv6 and IPv4 host-side addresses, and exchanges TCP streams and UDP
datagrams with kernel clients over both families. It also sends 6000-byte UDP
datagrams and runs `ping -4`/`ping -6`, including 4000-byte payloads, to
exercise IPv4 and IPv6 fragmentation, reassembly and real ICMP echo traffic
against a kernel peer. It skips (and succeeds) when user namespaces, `ip(8)` or
`/dev/net/tun` are unavailable; the ICMP checks are skipped when `ping` is not
installed.

`tests/netstack_l2_test.c` links `netstack_l2.c` against a simulated two-node
Ethernet segment. It checks ARP request/reply and cache learning, IPv6
neighbour solicitation/advertisement, Ethernet framing and MAC selection,
packet queueing while a gateway is unresolved, probe exhaustion and packet
drop, local delivery without a frame, broadcast/subnet-broadcast and IPv6
multicast MAC mapping, and neighbour expiry.

`tests/qnode/netstack_tap.sh` follows the TUN script but creates a TAP device
with an explicit kernel MAC (`02:51:4e:00:00:02`) and runs qnode with
`02:51:4e:00:00:01`. It repeats the TCP, UDP and large-datagram transfers and
the `ping` checks, then verifies through `ip neigh` that the kernel learnt the
qnode MAC for both `10.254.0.1` and `fd00:dead:beef:99::1`, covering real ARP
and NDP interop in both directions.

The C tests are `tests/netstack_test.c` and `tests/netstack_l2_test.c`; they
link the stack directly and need no runtime or privileges.
