/*
 * netstack - an in-process TCP/IP stack with IPv6 shard dispatch.
 *
 * See docs/netstack.md for the addressing and dispatch model.
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

typedef struct NsStack NsStack;

typedef struct NsAddr {
    uint8_t b[NS_ADDR_LEN];
} NsAddr;

enum {
    NS_OK = 0,
    NS_EAGAIN = 1,
    NS_ENOTCONN = 2,
    NS_EMSGSIZE = 3,
    NS_ECLOSED = 4,
    NS_EINVAL = 5,
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
    uint64_t per_shard_rx[NS_MAX_SHARDS];
} NsStats;

typedef void (*NsLinkSendFn)(NsStack *stack, const uint8_t *pkt, size_t len,
                             void *opaque);

NsStack *ns_stack_new(const uint8_t prefix[NS_PREFIX_LEN], int nshards,
                      NsLinkSendFn send, void *opaque);
void ns_stack_free(NsStack *s);

void ns_addr_service(const NsStack *s, int shard, NsAddr *out);
int ns_addr_shard(const NsAddr *a);
void ns_addr_format(const NsAddr *a, char out[64]);

int ns_listen(NsStack *s, uint16_t port);
int ns_listener_addr(const NsStack *s, uint16_t port, int shard, NsAddr *out);

/* local_shard is the client-side shard that owns the connection. */
uint64_t ns_connect(NsStack *s, int local_shard, const NsAddr *service,
                    uint16_t port, uint16_t local_port);

void ns_input(NsStack *s, const uint8_t *pkt, size_t len);
int ns_run(NsStack *s, int budget);
void ns_tick(NsStack *s, uint64_t now_ms);

int ns_send(NsStack *s, uint64_t id, const void *buf, size_t len);
int ns_recv(NsStack *s, uint64_t id, void *buf, size_t len);
int ns_close(NsStack *s, uint64_t id);
int ns_accept(NsStack *s, uint64_t *id_out);

int ns_conn_state(NsStack *s, uint64_t id);
int ns_conn_peer_closed(NsStack *s, uint64_t id);
int ns_conn_addr(NsStack *s, uint64_t id, NsAddr *local, uint16_t *lport,
                 NsAddr *remote, uint16_t *rport);

int ns_shard_pending(NsStack *s, int shard);
const NsStats *ns_stats(NsStack *s);
const uint8_t *ns_dispatch_log(NsStack *s, int *len);
void ns_dispatch_log_clear(NsStack *s);

#endif /* NETSTACK_H */
