/*
 * netstack_link - packet transport for netstack.
 *
 * netstack owns TCP but not the wire. A link either loops packets straight
 * back into the stack (same-process client/server, no privileges needed) or
 * moves them through a Linux TUN/TAP device. TUN carries bare IP packets; TAP
 * carries Ethernet frames and is paired with netstack_l2 for ARP and IPv6
 * neighbour discovery. Setting up interface addresses and routes is the
 * caller's job because that requires privileges the runtime does not assume.
 */
#ifndef NETSTACK_LINK_H
#define NETSTACK_LINK_H

#include <stddef.h>
#include <stdint.h>

#include "netstack.h"
#include "netstack_l2.h"

typedef struct NsLink NsLink;

enum {
    NS_LINK_LOOPBACK = 0,
    NS_LINK_TUN = 1,
    NS_LINK_TAP = 2,
};

/* Create a link for an already-configured plain-mode stack. For TUN and TAP,
   `device_name` may be NULL to let the kernel pick a name; the device must
   already exist or be creatable from /dev/net/tun. TAP uses `mac` as the
   stack's Ethernet address; it may be NULL for a default locally
   administered address. Returns NULL and sets errno on failure. */
NsLink *ns_link_new(NsStack *stack, int kind, const char *device_name,
                    const uint8_t mac[NS_L2_MAC_LEN]);
void ns_link_free(NsLink *link);

/* Install the link as the stack's transmit path. */
void ns_link_attach(NsLink *link);

/* Real fd to poll for incoming packets, or -1 for a loopback link. */
int ns_link_fd(const NsLink *link);

/* Read up to `budget` packets from the link and feed them to the stack.
   Returns the number of packets processed, or -1 on a hard error. */
int ns_link_pump(NsLink *link, int budget);

/* Feed one already-framed IP packet (loopback/TUN) or Ethernet frame (TAP)
   into the link. Used by tests and by raw transports. */
int ns_link_send(NsLink *link, const uint8_t *pkt, size_t len);

/* Advance link-layer timers (neighbour retries and expiry on TAP). */
void ns_link_tick(NsLink *link, uint64_t now_ms);

/* Configure one address family on a TAP link's neighbour layer. `gateway`
   may be NULL for an on-link-only interface. Returns 0 or -NS_EINVAL. */
int ns_link_l2_config(NsLink *link, const NsAddr *local, int prefix_len,
                      const NsAddr *gateway);

/* The neighbour layer for a TAP link, or NULL for loopback/TUN. */
NsL2 *ns_link_l2(NsLink *link);

/* The interface name chosen for a TUN/TAP link, or NULL. */
const char *ns_link_name(const NsLink *link);

#endif /* NETSTACK_LINK_H */
