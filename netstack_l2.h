/*
 * netstack_l2 - Ethernet, ARP and IPv6 neighbour discovery for netstack.
 *
 * The IP engine in netstack.c exchanges bare IPv4/IPv6 packets. An NsL2 owns
 * one Ethernet interface: it frames outbound IP packets, resolves the next
 * hop (ARP for IPv4, neighbour solicitation for IPv6), queues packets while a
 * neighbour is unresolved, and answers ARP/NS requests addressed to the
 * interface. Inbound frames are handed back to ns_input() after link-layer
 * processing.
 *
 * An NsL2 is transport-independent. Tests drive it over a simulated Ethernet
 * segment; netstack_link.c drives it over a Linux TAP device.
 */
#ifndef NETSTACK_L2_H
#define NETSTACK_L2_H

#include <stddef.h>
#include <stdint.h>

#include "netstack.h"

#define NS_L2_MAC_LEN 6
#define NS_L2_MAX_NEIGHBORS 64
#define NS_L2_MAX_PENDING 64
#define NS_L2_PENDING_PER_NEIGHBOR 8
#define NS_L2_MAX_ROUTES 32
#define NS_L2_PROBE_INTERVAL_MS 1000
#define NS_L2_PROBE_MAX 3
#define NS_L2_REACHABLE_MS 60000
#define NS_L2_MTU 1500

typedef struct NsL2 NsL2;

/* Deliver one complete Ethernet frame (including the 14-byte header) to the
   wire. The callback must not retain the buffer. */
typedef void (*NsL2SendFn)(NsL2 *l2, const uint8_t *frame, size_t len,
                           void *opaque);

typedef struct NsL2Stats {
    uint64_t rx_frames;       /* frames accepted from the link */
    uint64_t tx_frames;       /* frames handed to the link */
    uint64_t rx_arp;
    uint64_t tx_arp;
    uint64_t rx_ndp;
    uint64_t tx_ndp;
    uint64_t local_delivered; /* IP packets delivered without touching the wire */
    uint64_t neighbor_hits;   /* resolved from a reachable cache entry */
    uint64_t neighbor_misses; /* resolution started */
    uint64_t neighbors_created;
    uint64_t neighbor_timeouts;
    uint64_t queued;          /* packets held for an unresolved neighbour */
    uint64_t queue_dropped;   /* packets dropped because a queue was full */
    uint64_t dropped;         /* malformed, off-link or unroutable packets */
    uint64_t no_route;        /* packets with no matching route */
    uint64_t gateway_unreachable; /* route next hop has no on-link route */
} NsL2Stats;

/* One route-table entry. Returned by ns_l2_route_lookup(). */
typedef struct NsL2RouteInfo {
    NsAddr dest;        /* network address, host bits zero */
    NsAddr gateway;     /* valid when has_gateway is set */
    int prefix_len;
    int has_gateway;    /* 0 means the destination is on-link */
} NsL2RouteInfo;

/* Create an interface. `mac` must be a unicast Ethernet address. The stack
   may be NULL for a pure ARP/NDP test fixture, but ns_l2_attach() needs one.
   Returns NULL and sets errno on failure. */
NsL2 *ns_l2_new(NsStack *stack, const uint8_t mac[NS_L2_MAC_LEN],
                NsL2SendFn send, void *opaque);
void ns_l2_free(NsL2 *l2);

/* Replace the frame transport (used by the TAP link and by tests). */
void ns_l2_set_send(NsL2 *l2, NsL2SendFn send, void *opaque);

/* Install this interface as the stack's packet output path. */
void ns_l2_attach(NsL2 *l2);

/* Interface addressing. `local` is the stack's address on this link and
   `prefix_len` is the on-link prefix length. `gateway` may be NULL. Configuring
   a family resets that family's route table and installs a connected route for
   `local`; a non-NULL gateway adds a default route through it. An address
   family may be configured independently; a packet for an unconfigured family
   is dropped. Returns 0 or -NS_EINVAL. */
int ns_l2_set_ipv4(NsL2 *l2, const NsAddr *local, int prefix_len,
                   const NsAddr *gateway);
int ns_l2_set_ipv6(NsL2 *l2, const NsAddr *local, int prefix_len,
                   const NsAddr *gateway);

/* Add or replace a route. `gateway` selects the next hop and must itself be
   reachable through an on-link route; NULL marks the destination as on-link.
   Destinations are masked to `prefix_len`, so `0.0.0.0/0` and `::/0` are
   default routes. A static route cannot replace the connected route for the
   interface prefix. Returns 0, -NS_EINVAL, or -NS_ENOSPC when the table is
   full of connected routes. */
int ns_l2_add_route(NsL2 *l2, const NsAddr *dest, int prefix_len,
                    const NsAddr *gateway);
int ns_l2_del_route(NsL2 *l2, const NsAddr *dest, int prefix_len);

/* Longest-prefix lookup. Returns 1 and fills `route` when a route matches,
   0 when there is none. */
int ns_l2_route_lookup(const NsL2 *l2, const NsAddr *dst,
                       NsL2RouteInfo *route);

/* Emit one IP packet. Performs local delivery, ARP/NDP resolution, queueing
   and Ethernet framing. Returns 0 when the packet was delivered, queued or
   sent, or a negative value when it could not be handled. */
int ns_l2_send_ip(NsL2 *l2, const uint8_t *pkt, size_t len);

/* Feed one inbound Ethernet frame into the link layer. ARP and NDP messages
   are handled here; IP payloads are passed to ns_input(). */
void ns_l2_input(NsL2 *l2, const uint8_t *frame, size_t len);

/* Advance neighbour retry and expiry timers. */
void ns_l2_tick(NsL2 *l2, uint64_t now_ms);

/* Test/introspection helpers. ns_l2_neighbor() returns 1 and fills `mac` when
   the address is resolved, 0 otherwise. */
int ns_l2_neighbor(const NsL2 *l2, const NsAddr *addr,
                   uint8_t mac[NS_L2_MAC_LEN]);
int ns_l2_pending_count(const NsL2 *l2);
const uint8_t *ns_l2_mac(const NsL2 *l2);
const NsL2Stats *ns_l2_stats(const NsL2 *l2);

#endif /* NETSTACK_L2_H */
