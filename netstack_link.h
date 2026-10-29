/*
 * netstack_link - packet transport for netstack.
 *
 * netstack owns TCP but not the wire. A link either loops packets straight
 * back into the stack (same-process client/server, no privileges needed) or
 * moves them through a Linux TUN device. The TUN path is what lets the
 * stack exchange packets with the rest of the network namespace; setting
 * up the interface address and routes is the caller's job because that
 * requires privileges the runtime does not assume.
 */
#ifndef NETSTACK_LINK_H
#define NETSTACK_LINK_H

#include <stddef.h>
#include <stdint.h>

#include "netstack.h"

typedef struct NsLink NsLink;

enum {
    NS_LINK_LOOPBACK = 0,
    NS_LINK_TUN = 1,
};

/* Create a link for an already-configured plain-mode stack. For
   NS_LINK_TUN, `tun_name` may be NULL to let the kernel pick a name; the
   device must already exist or be creatable from /dev/net/tun. Returns
   NULL and sets errno on failure. */
NsLink *ns_link_new(NsStack *stack, int kind, const char *tun_name);
void ns_link_free(NsLink *link);

/* Install the link as the stack's transmit path. */
void ns_link_attach(NsLink *link);

/* Real fd to poll for incoming packets, or -1 for a loopback link. */
int ns_link_fd(const NsLink *link);

/* Read up to `budget` packets from the link and feed them to the stack.
   Returns the number of packets processed, or -1 on a hard error. */
int ns_link_pump(NsLink *link, int budget);

/* Feed one already-framed IPv6 packet into the link (used by the stack's
   send callback and by tests). */
int ns_link_send(NsLink *link, const uint8_t *pkt, size_t len);

/* The interface name chosen for a TUN link, or NULL. */
const char *ns_link_name(const NsLink *link);

#endif /* NETSTACK_LINK_H */
