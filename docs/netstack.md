# qnode netstack: an owned TCP/IP stack with IPv6 shard dispatch

Status: prototype. The code lives in `netstack.c` / `netstack.h` and is not yet
wired into `node:net`; the existing OS-socket path is unchanged.

## Motivation

qnode currently delegates TCP and UDP to the kernel. That is the right default,
but it leaves three things outside our control:

- per-connection state is shared in the kernel and demultiplexed by a global
  hash table;
- every read/write crosses a syscall boundary;
- there is no natural way to pin one connection to one worker without a shared
  accept queue or `SO_REUSEPORT` guesswork.

The netstack is an in-process alternative with a deliberately different
demultiplexing rule: **the destination IPv6 address selects the worker shard**.
Because IPv6 gives every connection a practically unlimited supply of
addresses, each connection can own an address. A packet's dispatch decision is
then a single byte load, not a hash of a 4-tuple, and connections owned by one
shard touch no other shard's state.

## Addressing

A stack owns a `/64` prefix. The 64 host bits are split as:

```
|<------------- /64 prefix ------------->|< shard >|<------ slot ------>
 0                                      7 8        9                 15
```

- `byte 8` is the shard id. It is also the dispatch key.
- `bytes 9..15` are a per-shard slot index (56 bits, big endian).
- Slot `0` on each shard is reserved for that shard's *service address*, the
  address a listener advertises for the initial SYN.
- Slot `n >= 1` is a per-connection address.

`ns_input()` reads `destination.b[8]`, validates it against the shard count,
and appends the packet to that shard's queue. It never inspects ports to pick a
shard.

### Connection migration on SYN-ACK

A client sends its SYN to a listener's service address. The server allocates a
fresh address from the connection's shard and sends the SYN-ACK **from that
fresh address**. The client recognizes the SYN-ACK as belonging to its pending
connection (same local address/port and peer port), records the new source as
the remote endpoint, and sends the final ACK there. From then on every packet
in both directions is addressed to a per-connection address, so dispatch is
purely address-based at both ends.

This is connection migration in the QUIC sense. It works between two netstack
instances; it is not wire-compatible with a peer that expects the SYN-ACK to
come from the address it sent the SYN to.

## Shards and interleaved dispatch

Each shard owns:

- a FIFO of inbound packets;
- its connection list and slot allocator;
- its accept queue and retransmission timers.

`ns_run()` drains one packet from each non-empty shard per round, up to a
budget. A busy shard cannot starve the others, which is what "interleaved"
means here. The queues and per-shard state are the seams for real threads: a
future version can give each shard a thread and an eventfd wakeup, with the
only cross-shard traffic being the inbound packet queue (already a bounded
MPSC hand-off) and address allocation.

## Prototype scope

Implemented:

- IPv6 header encode/decode and TCP segment encode/decode with checksums;
- address allocation and shard mapping;
- listener service addresses;
- TCP handshake with SYN-ACK address migration;
- in-order data transfer with ACKs, PSH, and a receive ring;
- FIN close (FIN_WAIT_1/2, CLOSE_WAIT, LAST_ACK, TIME_WAIT);
- fixed-RTO retransmission of unacked data;
- per-shard packet queues and round-robin dispatch;
- statistics and a dispatch trace for tests.

Not implemented yet:

- out-of-order reassembly, SACK, window scaling, congestion control;
- TIME_WAIT reuse rules beyond a fixed expiry;
- UDP, ICMPv6, fragmentation;
- a TUN device or raw-socket link (the prototype link is an in-process
  callback);
- `node:net` integration and a JS binding.

## Link abstraction

The stack is transport-agnostic. A link is a callback:

```c
typedef void (*NsLinkSendFn)(NsStack *stack, const uint8_t *pkt, size_t len,
                             void *opaque);
```

The prototype test wires two stacks together by calling the peer's
`ns_input()` from the callback. A production link would write the packet to a
TUN/TAP fd (Linux) or to a shared-memory ring between processes. The stack
already emits and accepts complete IPv6 packets, so the link never needs to
understand TCP.

## Testing

Build and run the prototype with `make netstack-test` (or build the
`netstack_test` target and run `netstack-test` directly). The test covers:

- address encoding and shard extraction;
- handshake, address migration, and accept;
- bidirectional in-order data transfer;
- close/EOF;
- retransmission after a dropped packet;
- round-robin dispatch across shards.
