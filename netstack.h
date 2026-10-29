/*
 * netstack - an in-process TCP/IP stack with IPv6 shard dispatch.
 *
 * IPv4 uses the same TCP engine in plain mode; IPv6 additionally supports the
 * sharded service addresses. See docs/netstack.md for the addressing and
 * dispatch model.
 */
#ifndef NETSTACK_H
#define NETSTACK_H

#include <stddef.h>
#include <stdint.h>

#define NS_ADDR_LEN 16
#define NS_PREFIX_LEN 8
#define NS_MAX_SHARDS 256
#define NS_MAX_LISTENERS 64
#define NS_MAX_PACKET 2048
#define NS_RCVBUF_SIZE 65536
#define NS_MAX_UDP_SOCKETS 256
#define NS_UDP_QUEUE_MAX 64
#define NS_UDP_QUEUE_BYTES (256 * 1024)

typedef struct NsStack NsStack;

/* Address families used by NsAddr. The stack deliberately does not depend on
   the host socket headers; the bridge maps AF_INET/AF_INET6 to these. */
enum {
    NS_AF_UNSPEC = 0,
    NS_AF_INET = 2,
    NS_AF_INET6 = 10,
};

/* IPv4 addresses occupy b[0..3]; the remaining bytes are zero. IPv6 uses all
   16 bytes. Comparisons include the family. */
typedef struct NsAddr {
    uint8_t b[NS_ADDR_LEN];
    uint8_t family;
} NsAddr;

enum {
    NS_OK = 0,
    NS_EAGAIN = 1,
    NS_ENOTCONN = 2,
    NS_EMSGSIZE = 3,
    NS_ECLOSED = 4,
    NS_EINVAL = 5,
    NS_EADDRINUSE = 6,
    NS_EDESTADDRREQ = 7,
};

/* Connection states, in the order used by ns_conn_state(). */
enum {
    NS_CLOSED = 0,
    NS_LISTEN,
    NS_SYN_SENT,
    NS_SYN_RCVD,
    NS_ESTABLISHED,
    NS_FIN_WAIT_1,
    NS_FIN_WAIT_2,
    NS_CLOSE_WAIT,
    NS_LAST_ACK,
    NS_TIME_WAIT,
};

typedef struct NsStats {
    uint64_t rx_packets;
    uint64_t tx_packets;
    uint64_t dropped;
    uint64_t retransmits;
    uint64_t dispatched;
    uint64_t accepted;
    uint64_t icmp_rx;
    uint64_t icmp_tx;
    uint64_t per_shard_rx[NS_MAX_SHARDS];
} NsStats;

typedef void (*NsLinkSendFn)(NsStack *stack, const uint8_t *pkt, size_t len,
                             void *opaque);

NsStack *ns_stack_new(const uint8_t prefix[NS_PREFIX_LEN], int nshards,
                      NsLinkSendFn send, void *opaque);
void ns_stack_free(NsStack *s);
void ns_stack_set_send(NsStack *s, NsLinkSendFn send, void *opaque);

/* Plain (non-sharded) mode.
 *
 * The shard model allocates a fresh IPv6 address for every accepted
 * connection and chooses a shard from byte 8 of the destination address.
 * That is great for a single process that owns a whole /64, but it cannot
 * interoperate with an ordinary peer: a peer that connects to the address
 * it was told about expects the SYN-ACK, and later the data, to come back
 * from that same address.
 *
 * Plain mode keeps one stable local address for the whole stack and
 * dispatches every packet to shard 0. Listeners are bound to an explicit
 * address and port. This is the mode used by the node:net integration and
 * by the TUN link. */
int ns_stack_set_plain(NsStack *s, const NsAddr *local);
int ns_stack_is_plain(const NsStack *s);
const NsAddr *ns_stack_local(const NsStack *s);

/* The plain address for one family, or NULL when that family has no address.
   A plain stack may own an IPv4 address, an IPv6 address, or both. */
const NsAddr *ns_stack_local_family(const NsStack *s, int family);

/* Bind a listener to an explicit address. ns_listen() keeps its original
   service-address behaviour for the sharded model. Passing a NULL address
   is equivalent to ns_listen(). */
int ns_listen_addr(NsStack *s, const NsAddr *local, uint16_t port);
int ns_listen_port(NsStack *s, uint16_t port, uint16_t *out_port);
int ns_listen_port_ex(NsStack *s, const NsAddr *local, uint16_t port,
                      uint16_t *out_port);
int ns_unlisten(NsStack *s, uint16_t port);

void ns_addr_service(const NsStack *s, int shard, NsAddr *out);
int ns_addr_shard(const NsAddr *a);
int ns_addr_family(const NsAddr *a);
void ns_addr_format(const NsAddr *a, char out[64]);

int ns_listen(NsStack *s, uint16_t port);
int ns_listener_addr(const NsStack *s, uint16_t port, int shard, NsAddr *out);

/* local_shard is the client-side shard that owns the connection. */
uint64_t ns_connect(NsStack *s, int local_shard, const NsAddr *service,
                    uint16_t port, uint16_t local_port);

/* Connect from an explicit local address/port. Required in plain mode.
   Pass local_port 0 to pick an ephemeral port. */
uint64_t ns_connect_from(NsStack *s, const NsAddr *local, uint16_t local_port,
                         const NsAddr *remote, uint16_t remote_port);

void ns_input(NsStack *s, const uint8_t *pkt, size_t len);
int ns_run(NsStack *s, int budget);
void ns_tick(NsStack *s, uint64_t now_ms);

int ns_send(NsStack *s, uint64_t id, const void *buf, size_t len);
int ns_recv(NsStack *s, uint64_t id, void *buf, size_t len);
int ns_close(NsStack *s, uint64_t id);
int ns_accept(NsStack *s, uint64_t *id_out);

/* Accept the next connection queued on a specific listener port. */
int ns_accept_port(NsStack *s, uint16_t port, uint64_t *id_out);

/* Readiness helpers for the event-loop integration. */
int ns_accept_ready(NsStack *s);
int ns_accept_ready_port(NsStack *s, uint16_t port);
int ns_conn_readable(NsStack *s, uint64_t id);
int ns_conn_writable(NsStack *s, uint64_t id);
int ns_conn_established(NsStack *s, uint64_t id);

int ns_conn_state(NsStack *s, uint64_t id);
int ns_conn_peer_closed(NsStack *s, uint64_t id);
int ns_conn_addr(NsStack *s, uint64_t id, NsAddr *local, uint16_t *lport,
                 NsAddr *remote, uint16_t *rport);

/* UDP sockets. A UDP socket is opened bound to a local address/port; pass
   port 0 for an ephemeral port. A zero address (or a NULL local) is the
   wildcard bind. The returned id is separate from the TCP connection id
   space and 0 means failure. */
uint64_t ns_udp_open(NsStack *s, const NsAddr *local, uint16_t port, int reuse);
int ns_udp_connect(NsStack *s, uint64_t id, const NsAddr *remote,
                   uint16_t rport);
int ns_udp_disconnect(NsStack *s, uint64_t id);
int ns_udp_sendto(NsStack *s, uint64_t id, const NsAddr *dst, uint16_t dport,
                  const void *buf, size_t len);
/* Returns the datagram length, or -NS_EAGAIN when the queue is empty. */
int ns_udp_recvfrom(NsStack *s, uint64_t id, void *buf, size_t len,
                    NsAddr *src, uint16_t *sport);
int ns_udp_close(NsStack *s, uint64_t id);
int ns_udp_readable(NsStack *s, uint64_t id);
int ns_udp_bound_addr(NsStack *s, uint64_t id, NsAddr *local,
                      uint16_t *lport);
int ns_udp_peer_addr(NsStack *s, uint64_t id, NsAddr *remote,
                     uint16_t *rport);
int ns_udp_is_connected(NsStack *s, uint64_t id);

/* Send an ICMP (IPv4) or ICMPv6 echo request from local to remote. The
   identifier and sequence number are echoed back by the peer. Returns 0, or
   -NS_EMSGSIZE when the packet does not fit in one link frame. */
int ns_icmp_echo(NsStack *s, const NsAddr *local, const NsAddr *remote,
                 uint16_t id, uint16_t seq, const void *payload, size_t len);

int ns_shard_pending(NsStack *s, int shard);
const NsStats *ns_stats(NsStack *s);
const uint8_t *ns_dispatch_log(NsStack *s, int *len);
void ns_dispatch_log_clear(NsStack *s);

#endif /* NETSTACK_H */
