/*
 * netstack_l2 - Ethernet framing, ARP and IPv6 neighbour discovery.
 *
 * The layer is deliberately transport-neutral: the caller supplies a frame
 * send callback, which can be a simulated Ethernet segment in tests or a TAP
 * device in netstack_link.c.
 */
#include "netstack_l2.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#define ETH_HDR 14
#define ETHERTYPE_IPV4 0x0800
#define ETHERTYPE_ARP 0x0806
#define ETHERTYPE_IPV6 0x86dd

#define IPV4_HDR 20
#define IPV6_HDR 40
#define ICMP6_HDR 8
#define ND_NS 135
#define ND_NA 136
#define ND_RS 133
#define ND_RA 134
#define ND_OPT_SOURCE_LL 1
#define ND_OPT_TARGET_LL 2

#define NEIGH_FREE 0
#define NEIGH_INCOMPLETE 1
#define NEIGH_REACHABLE 2

#define ROUTE_FREE 0
#define ROUTE_STATIC 1
#define ROUTE_CONNECTED 2
#define ROUTE_RA 3

typedef struct NsL2Pkt {
    struct NsL2Pkt *next;
    NsAddr next_hop;
    size_t len;
    uint8_t data[];
} NsL2Pkt;

typedef struct NsRoute {
    NsAddr dest;       /* network address, host bits zero */
    NsAddr gateway;
    uint8_t family;
    uint8_t prefix_len;
    uint8_t has_gateway;
    uint8_t kind;      /* ROUTE_STATIC, ROUTE_CONNECTED or ROUTE_RA */
    uint64_t used;
    uint64_t expires;  /* 0 means no lifetime */
} NsRoute;

typedef struct NsNeigh {
    NsAddr addr;
    uint8_t mac[NS_L2_MAC_LEN];
    uint8_t state;
    uint8_t retries;
    uint64_t next_probe;
    uint64_t expires;
    uint64_t used;
} NsNeigh;

struct NsL2 {
    NsStack *stack;
    uint8_t mac[NS_L2_MAC_LEN];
    NsL2SendFn send;
    void *opaque;
    uint16_t mtu;
    uint64_t clock;
    uint64_t next_used;

    int has4;
    NsAddr local4;

    int has6;
    NsAddr local6;
    int has_link6;
    NsAddr link6;
    int router_discovery;
    int rs_left;
    uint64_t next_rs;

    NsRoute routes[NS_L2_MAX_ROUTES];
    NsNeigh neigh[NS_L2_MAX_NEIGHBORS];
    NsL2Pkt *pending;
    int npending;

    NsL2Stats stats;
};

static NsNeigh *neigh_find(const NsL2 *l2, const NsAddr *addr);
static void pending_flush(NsL2 *l2, const NsAddr *addr, const uint8_t *mac);
static void neigh_learn(NsL2 *l2, const NsAddr *addr, const uint8_t *mac);

/* ---------------- byte order, addresses and checksums ---------------- */

static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)((p[0] << 8) | p[1]);
}

static uint32_t rd32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}

static void wr16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}

static void wr32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

static uint32_t csum_add(uint32_t sum, const uint8_t *p, size_t len)
{
    while (len > 1) {
        sum += (uint16_t)((p[0] << 8) | p[1]);
        p += 2;
        len -= 2;
    }
    if (len)
        sum += (uint16_t)(p[0] << 8);
    return sum;
}

static uint16_t csum_fold(uint32_t sum)
{
    while (sum >> 16)
        sum = (sum & 0xffff) + (sum >> 16);
    return (uint16_t)~sum;
}

/* Return the checksum field value for an ICMPv6 message. A valid message
   validates to zero. */
static uint16_t icmp6_checksum(const uint8_t *src, const uint8_t *dst,
                               const uint8_t *msg, size_t len)
{
    uint8_t tail[4];
    uint8_t next[4] = { 0, 0, 0, 58 };
    uint32_t sum = 0;

    wr32(tail, (uint32_t)len);
    sum = csum_add(sum, src, 16);
    sum = csum_add(sum, dst, 16);
    sum = csum_add(sum, tail, sizeof(tail));
    sum = csum_add(sum, next, sizeof(next));
    sum = csum_add(sum, msg, len);
    return csum_fold(sum);
}

static int addr_eq(const NsAddr *a, const NsAddr *b)
{
    int family = ns_addr_family(a);
    size_t len;

    if (family != ns_addr_family(b))
        return 0;
    len = family == NS_AF_INET ? 4 : 16;
    return memcmp(a->b, b->b, len) == 0;
}

static int addr_unspecified(const NsAddr *a)
{
    int family = ns_addr_family(a);
    size_t len = family == NS_AF_INET ? 4 : 16;
    size_t i;

    for (i = 0; i < len; i++)
        if (a->b[i])
            return 0;
    return 1;
}

static int addr_multicast(const NsAddr *a)
{
    if (ns_addr_family(a) == NS_AF_INET)
        return (a->b[0] & 0xf0) == 0xe0;
    return a->b[0] == 0xff;
}

static int addr_broadcast4(const NsAddr *a)
{
    return ns_addr_family(a) == NS_AF_INET && a->b[0] == 0xff &&
           a->b[1] == 0xff && a->b[2] == 0xff && a->b[3] == 0xff;
}

/* fe80::/10. */
static int addr_link_local(const NsAddr *a)
{
    return ns_addr_family(a) == NS_AF_INET6 && a->b[0] == 0xfe &&
           (a->b[1] & 0xc0) == 0x80;
}

static int ipv6_enabled(const NsL2 *l2)
{
    return l2->has6 || l2->has_link6;
}

static int is_local6(const NsL2 *l2, const NsAddr *addr)
{
    return (l2->has6 && addr_eq(addr, &l2->local6)) ||
           (l2->has_link6 && addr_eq(addr, &l2->link6));
}

/* Build an EUI-64 link-local address from the interface MAC. */
static void make_link_local6(const uint8_t mac[NS_L2_MAC_LEN], NsAddr *out)
{
    memset(out, 0, sizeof(*out));
    out->family = NS_AF_INET6;
    out->b[0] = 0xfe;
    out->b[1] = 0x80;
    out->b[8] = (uint8_t)(mac[0] ^ 0x02); /* flip the universal/local bit */
    out->b[9] = mac[1];
    out->b[10] = mac[2];
    out->b[11] = 0xff;
    out->b[12] = 0xfe;
    out->b[13] = mac[3];
    out->b[14] = mac[4];
    out->b[15] = mac[5];
}

static void make_link_local_net(NsAddr *out)
{
    memset(out, 0, sizeof(*out));
    out->family = NS_AF_INET6;
    out->b[0] = 0xfe;
    out->b[1] = 0x80;
}

static uint32_t mask4(int prefix_len)
{
    if (prefix_len <= 0)
        return 0;
    if (prefix_len >= 32)
        return 0xffffffffu;
    return 0xffffffffu << (32 - prefix_len);
}

/* Zero the host bits of an address in place. */
static void addr_mask(NsAddr *addr, int prefix_len)
{
    if (ns_addr_family(addr) == NS_AF_INET) {
        wr32(addr->b, rd32(addr->b) & mask4(prefix_len));
    } else {
        int full = prefix_len / 8;
        int rem = prefix_len % 8;
        int i;

        if (rem) {
            addr->b[full] &= (uint8_t)(0xff << (8 - rem));
            full++;
        }
        for (i = full; i < 16; i++)
            addr->b[i] = 0;
    }
}

static int addr_in_prefix(const NsAddr *addr, const NsAddr *net, int prefix_len)
{
    if (ns_addr_family(addr) != ns_addr_family(net))
        return 0;
    if (ns_addr_family(addr) == NS_AF_INET)
        return (rd32(addr->b) & mask4(prefix_len)) == rd32(net->b);
    {
        int full = prefix_len / 8;
        int rem = prefix_len % 8;

        if (full && memcmp(addr->b, net->b, (size_t)full) != 0)
            return 0;
        if (rem) {
            uint8_t mask = (uint8_t)(0xff << (8 - rem));
            if ((addr->b[full] & mask) != (net->b[full] & mask))
                return 0;
        }
    }
    return 1;
}

static NsRoute *route_find(NsL2 *l2, const NsAddr *dest, int prefix_len)
{
    int i;

    for (i = 0; i < NS_L2_MAX_ROUTES; i++) {
        NsRoute *r = &l2->routes[i];
        if (r->kind != ROUTE_FREE && r->prefix_len == prefix_len &&
            addr_eq(&r->dest, dest))
            return r;
    }
    return NULL;
}

/* Prefer a free slot, then evict the least recently used static or learned
   route. Connected routes are never evicted because neighbours need them to
   decide whether a gateway is reachable. */
static NsRoute *route_alloc(NsL2 *l2)
{
    NsRoute *victim = NULL;
    int i;

    for (i = 0; i < NS_L2_MAX_ROUTES; i++)
        if (l2->routes[i].kind == ROUTE_FREE)
            return &l2->routes[i];
    for (i = 0; i < NS_L2_MAX_ROUTES; i++) {
        NsRoute *r = &l2->routes[i];
        if (r->kind == ROUTE_CONNECTED)
            continue;
        if (!victim || r->used < victim->used)
            victim = r;
    }
    return victim;
}

static int route_add_internal(NsL2 *l2, const NsAddr *dest, int prefix_len,
                              const NsAddr *gateway, int kind)
{
    NsAddr net;
    NsRoute *r;
    int family;

    if (!l2 || !dest)
        return -NS_EINVAL;
    family = ns_addr_family(dest);
    if (family != NS_AF_INET && family != NS_AF_INET6)
        return -NS_EINVAL;
    if (prefix_len < 0 || prefix_len > (family == NS_AF_INET ? 32 : 128))
        return -NS_EINVAL;
    if (gateway && ns_addr_family(gateway) != family)
        return -NS_EINVAL;

    net = *dest;
    net.family = (uint8_t)family;
    addr_mask(&net, prefix_len);

    r = route_find(l2, &net, prefix_len);
    if (r && r->kind == ROUTE_CONNECTED && kind == ROUTE_STATIC)
        return -NS_EINVAL; /* never replace the interface's connected route */
    if (!r) {
        r = route_alloc(l2);
        if (!r)
            return -NS_ENOSPC;
        memset(r, 0, sizeof(*r));
    }
    r->dest = net;
    r->family = (uint8_t)family;
    r->prefix_len = (uint8_t)prefix_len;
    r->kind = (uint8_t)kind;
    r->has_gateway = gateway != NULL;
    if (gateway) {
        r->gateway = *gateway;
        r->gateway.family = (uint8_t)family;
    } else {
        memset(&r->gateway, 0, sizeof(r->gateway));
        r->gateway.family = (uint8_t)family;
    }
    r->used = ++l2->next_used;
    r->expires = 0;
    return 0;
}

/* Add or refresh a default route learned from a router advertisement. An
   explicitly configured route for the same prefix wins. Returns 0 on success
   or a negative NsError. */
static int route_add_ra(NsL2 *l2, const NsAddr *gateway, uint64_t lifetime_ms)
{
    NsAddr zero;
    NsRoute *r;
    int existed;
    int changed;
    int rc;

    memset(&zero, 0, sizeof(zero));
    zero.family = NS_AF_INET6;
    r = route_find(l2, &zero, 0);
    if (r && r->kind != ROUTE_RA)
        return 0; /* keep an explicit default route */

    if (lifetime_ms == 0) {
        if (r)
            memset(r, 0, sizeof(*r));
        return 0;
    }

    existed = r != NULL;
    changed = !r || !addr_eq(&r->gateway, gateway);
    rc = route_add_internal(l2, &zero, 0, gateway, ROUTE_RA);
    if (rc < 0)
        return rc;
    r = route_find(l2, &zero, 0);
    if (!r)
        return -NS_ENOSPC;
    r->expires = l2->clock + lifetime_ms;
    if (!existed || changed)
        l2->stats.ra_routes++;
    return 0;
}

static const NsRoute *route_match(const NsL2 *l2, const NsAddr *dst)
{
    const NsRoute *best = NULL;
    int i;

    for (i = 0; i < NS_L2_MAX_ROUTES; i++) {
        const NsRoute *r = &l2->routes[i];

        if (r->kind == ROUTE_FREE ||
            !addr_in_prefix(dst, &r->dest, r->prefix_len))
            continue;
        if (!best || r->prefix_len > best->prefix_len ||
            (r->prefix_len == best->prefix_len &&
             r->kind == ROUTE_CONNECTED && best->kind != ROUTE_CONNECTED))
            best = r;
    }
    return best;
}

/* Match a route and record the use for LRU eviction. */
static const NsRoute *route_match_touch(NsL2 *l2, const NsAddr *dst)
{
    const NsRoute *r = route_match(l2, dst);

    if (r) {
        NsRoute *mutable = &l2->routes[r - l2->routes];
        mutable->used = ++l2->next_used;
    }
    return r;
}

/* Resolve the next hop for `dst`. Returns 1 on success, 0 when no route
   matches, and -1 when the route's gateway is not reachable on-link. */
static int route_next_hop(NsL2 *l2, const NsAddr *dst, NsAddr *next)
{
    const NsRoute *r = route_match_touch(l2, dst);
    const NsRoute *g;

    if (!r)
        return 0;
    if (!r->has_gateway) {
        *next = *dst;
        next->family = (uint8_t)ns_addr_family(dst);
        return 1;
    }
    /* A gateway must be reachable through an on-link route, not recursively
       through another gateway. */
    g = route_match_touch(l2, &r->gateway);
    if (!g || g->has_gateway)
        return -1;
    *next = r->gateway;
    return 1;
}

static void route_flush_family(NsL2 *l2, int family)
{
    int i;

    for (i = 0; i < NS_L2_MAX_ROUTES; i++)
        if (l2->routes[i].kind != ROUTE_FREE &&
            l2->routes[i].kind != ROUTE_RA &&
            l2->routes[i].family == (uint8_t)family)
            memset(&l2->routes[i], 0, sizeof(l2->routes[i]));
}

/* True when `dst` is the directed broadcast address of an on-link IPv4
   route. */
static int subnet_broadcast4(const NsL2 *l2, const NsAddr *dst)
{
    uint32_t addr;
    int i;

    if (ns_addr_family(dst) != NS_AF_INET)
        return 0;
    addr = rd32(dst->b);
    for (i = 0; i < NS_L2_MAX_ROUTES; i++) {
        const NsRoute *r = &l2->routes[i];
        uint32_t mask;
        uint32_t host;

        if (r->kind == ROUTE_FREE || r->has_gateway ||
            r->family != NS_AF_INET || r->prefix_len >= 31)
            continue;
        mask = mask4(r->prefix_len);
        host = ~mask;
        if ((addr & mask) == rd32(r->dest.b) && (addr & host) == host)
            return 1;
    }
    return 0;
}

static int mac_eq(const uint8_t *a, const uint8_t *b)
{
    return memcmp(a, b, NS_L2_MAC_LEN) == 0;
}

static int mac_broadcast(const uint8_t *a)
{
    int i;
    for (i = 0; i < NS_L2_MAC_LEN; i++)
        if (a[i] != 0xff)
            return 0;
    return 1;
}

static int mac_multicast(const uint8_t *a)
{
    return (a[0] & 1) != 0;
}

static int mac_usable(const uint8_t *a)
{
    int i;
    if (mac_multicast(a))
        return 0;
    for (i = 0; i < NS_L2_MAC_LEN; i++)
        if (a[i])
            return 1;
    return 0;
}

static void mac_multicast4(const NsAddr *dst, uint8_t mac[NS_L2_MAC_LEN])
{
    mac[0] = 0x01;
    mac[1] = 0x00;
    mac[2] = 0x5e;
    mac[3] = (uint8_t)(dst->b[1] & 0x7f);
    mac[4] = dst->b[2];
    mac[5] = dst->b[3];
}

static void mac_multicast6(const NsAddr *dst, uint8_t mac[NS_L2_MAC_LEN])
{
    mac[0] = 0x33;
    mac[1] = 0x33;
    mac[2] = dst->b[12];
    mac[3] = dst->b[13];
    mac[4] = dst->b[14];
    mac[5] = dst->b[15];
}

/* ---------------- frame output ---------------- */

static int l2_emit(NsL2 *l2, const uint8_t *dstmac, uint16_t ethertype,
                   const uint8_t *payload, size_t len)
{
    uint8_t *frame;
    size_t total = ETH_HDR + len;

    if (!l2->send) {
        l2->stats.dropped++;
        return -1;
    }
    frame = malloc(total);
    if (!frame) {
        l2->stats.dropped++;
        return -1;
    }
    memcpy(frame, dstmac, NS_L2_MAC_LEN);
    memcpy(frame + 6, l2->mac, NS_L2_MAC_LEN);
    wr16(frame + 12, ethertype);
    if (len)
        memcpy(frame + ETH_HDR, payload, len);

    l2->stats.tx_frames++;
    l2->send(l2, frame, total, l2->opaque);
    free(frame);
    return 0;
}

static int l2_emit_ip(NsL2 *l2, const uint8_t *pkt, size_t len,
                      const uint8_t *dstmac)
{
    uint16_t ethertype;

    if (len < 1) {
        l2->stats.dropped++;
        return -1;
    }
    if ((pkt[0] >> 4) == 4)
        ethertype = ETHERTYPE_IPV4;
    else if ((pkt[0] >> 4) == 6)
        ethertype = ETHERTYPE_IPV6;
    else {
        l2->stats.dropped++;
        return -1;
    }
    return l2_emit(l2, dstmac, ethertype, pkt, len);
}

/* ---------------- ARP ---------------- */

static int arp_emit_request(NsL2 *l2, const NsAddr *target)
{
    uint8_t arp[28];
    uint8_t bcast[NS_L2_MAC_LEN];

    if (!l2->has4)
        return -1;
    memset(bcast, 0xff, sizeof(bcast));
    memset(arp, 0, sizeof(arp));
    wr16(arp, 1);            /* Ethernet */
    wr16(arp + 2, 0x0800);   /* IPv4 */
    arp[4] = 6;
    arp[5] = 4;
    wr16(arp + 6, 1);        /* request */
    memcpy(arp + 8, l2->mac, NS_L2_MAC_LEN);
    memcpy(arp + 14, l2->local4.b, 4);
    memcpy(arp + 24, target->b, 4);
    l2->stats.tx_arp++;
    return l2_emit(l2, bcast, ETHERTYPE_ARP, arp, sizeof(arp));
}

static int arp_emit_reply(NsL2 *l2, const uint8_t *dstmac, const NsAddr *peer)
{
    uint8_t arp[28];

    if (!l2->has4)
        return -1;
    memset(arp, 0, sizeof(arp));
    wr16(arp, 1);
    wr16(arp + 2, 0x0800);
    arp[4] = 6;
    arp[5] = 4;
    wr16(arp + 6, 2);        /* reply */
    memcpy(arp + 8, l2->mac, NS_L2_MAC_LEN);
    memcpy(arp + 14, l2->local4.b, 4);
    memcpy(arp + 18, dstmac, NS_L2_MAC_LEN);
    memcpy(arp + 24, peer->b, 4);
    l2->stats.tx_arp++;
    return l2_emit(l2, dstmac, ETHERTYPE_ARP, arp, sizeof(arp));
}

/* ---------------- IPv6 neighbour discovery ---------------- */

static int ndp_emit_ns(NsL2 *l2, const NsAddr *target)
{
    uint8_t pkt[IPV6_HDR + 24 + 8];
    uint8_t dst6[16];
    uint8_t dstmac[NS_L2_MAC_LEN];
    uint8_t *ip = pkt;
    uint8_t *icmp = pkt + IPV6_HDR;
    const NsAddr *src;
    uint16_t csum;

    if (!ipv6_enabled(l2))
        return -1;
    if (addr_link_local(target) && l2->has_link6)
        src = &l2->link6;
    else if (l2->has6)
        src = &l2->local6;
    else
        src = &l2->link6;
    memset(pkt, 0, sizeof(pkt));
    memset(dst6, 0, sizeof(dst6));
    dst6[0] = 0xff;
    dst6[1] = 0x02;
    dst6[11] = 0x01;
    dst6[12] = 0xff;
    dst6[13] = target->b[13];
    dst6[14] = target->b[14];
    dst6[15] = target->b[15];
    dstmac[0] = 0x33;
    dstmac[1] = 0x33;
    dstmac[2] = 0xff;
    dstmac[3] = target->b[13];
    dstmac[4] = target->b[14];
    dstmac[5] = target->b[15];

    ip[0] = 0x60;
    wr16(ip + 4, 24 + 8);
    ip[6] = 58;
    ip[7] = 255;
    memcpy(ip + 8, src->b, 16);
    memcpy(ip + 24, dst6, 16);

    icmp[0] = ND_NS;
    icmp[1] = 0;
    memcpy(icmp + 8, target->b, 16);
    icmp[24] = ND_OPT_SOURCE_LL;
    icmp[25] = 1;
    memcpy(icmp + 26, l2->mac, NS_L2_MAC_LEN);
    csum = icmp6_checksum(ip + 8, ip + 24, icmp, 24 + 8);
    wr16(icmp + 2, csum);

    l2->stats.tx_ndp++;
    return l2_emit(l2, dstmac, ETHERTYPE_IPV6, pkt, sizeof(pkt));
}

static int ndp_emit_na(NsL2 *l2, const uint8_t *dstmac, const NsAddr *dst,
                       const NsAddr *target)
{
    uint8_t pkt[IPV6_HDR + 24 + 8];
    uint8_t *ip = pkt;
    uint8_t *icmp = pkt + IPV6_HDR;
    uint16_t csum;

    memset(pkt, 0, sizeof(pkt));
    ip[0] = 0x60;
    wr16(ip + 4, 24 + 8);
    ip[6] = 58;
    ip[7] = 255;
    memcpy(ip + 8, target->b, 16);
    memcpy(ip + 24, dst->b, 16);

    icmp[0] = ND_NA;
    icmp[1] = 0;
    /* Solicited and override flags. */
    icmp[4] = 0x60;
    memcpy(icmp + 8, target->b, 16);
    icmp[24] = ND_OPT_TARGET_LL;
    icmp[25] = 1;
    memcpy(icmp + 26, l2->mac, NS_L2_MAC_LEN);
    csum = icmp6_checksum(ip + 8, ip + 24, icmp, 24 + 8);
    wr16(icmp + 2, csum);

    l2->stats.tx_ndp++;
    return l2_emit(l2, dstmac, ETHERTYPE_IPV6, pkt, sizeof(pkt));
}

/* Send a router solicitation to the all-routers multicast group. */
static int ndp_emit_rs(NsL2 *l2)
{
    uint8_t pkt[IPV6_HDR + 8 + 8];
    uint8_t dst6[16];
    uint8_t dstmac[NS_L2_MAC_LEN] = { 0x33, 0x33, 0, 0, 0, 2 };
    uint8_t *ip = pkt;
    uint8_t *icmp = pkt + IPV6_HDR;
    size_t opt = l2->has_link6 ? 8 : 0;
    size_t plen = 8 + opt;
    uint16_t csum;

    memset(pkt, 0, sizeof(pkt));
    memset(dst6, 0, sizeof(dst6));
    dst6[0] = 0xff;
    dst6[1] = 0x02;
    dst6[15] = 0x02;

    ip[0] = 0x60;
    wr16(ip + 4, (uint16_t)plen);
    ip[6] = 58;
    ip[7] = 255;
    if (l2->has_link6)
        memcpy(ip + 8, l2->link6.b, 16);
    memcpy(ip + 24, dst6, 16);

    icmp[0] = ND_RS;
    icmp[1] = 0;
    if (opt) {
        icmp[8] = ND_OPT_SOURCE_LL;
        icmp[9] = 1;
        memcpy(icmp + 10, l2->mac, NS_L2_MAC_LEN);
    }
    csum = icmp6_checksum(ip + 8, dst6, icmp, plen);
    wr16(icmp + 2, csum);

    l2->stats.tx_rs++;
    return l2_emit(l2, dstmac, ETHERTYPE_IPV6, pkt, IPV6_HDR + plen);
}

/* Find a link-layer option and return a pointer to its address bytes. */
static const uint8_t *ndp_option(const uint8_t *opts, size_t len,
                                 uint8_t type)
{
    size_t off = 0;

    while (off + 2 <= len) {
        uint8_t otype = opts[off];
        size_t olen = (size_t)opts[off + 1] * 8;

        if (olen == 0 || olen > len - off)
            break;
        if (otype == type && olen >= 8)
            return opts + off + 2;
        off += olen;
    }
    return NULL;
}

/* Consume a router advertisement. Only the default router is used; prefix
   information options are ignored because SLAAC is not implemented. */
static void ndp_ra_input(NsL2 *l2, const uint8_t *src,
                         const uint8_t *icmp, size_t icmp_len,
                         const uint8_t *srcmac)
{
    const uint8_t *slla;
    const uint8_t *mac;
    NsAddr router;
    uint16_t lifetime;

    if (!l2->router_discovery || icmp_len < 16)
        return;
    memset(&router, 0, sizeof(router));
    router.family = NS_AF_INET6;
    memcpy(router.b, src, 16);
    if (addr_unspecified(&router) || !addr_link_local(&router))
        return;

    l2->stats.rx_ra++;
    l2->rs_left = 0; /* a router answered; stop soliciting */

    slla = ndp_option(icmp + 16, icmp_len - 16, ND_OPT_SOURCE_LL);
    mac = slla ? slla : srcmac;
    if (mac_usable(mac))
        neigh_learn(l2, &router, mac);

    lifetime = rd16(icmp + 6);
    route_add_ra(l2, &router, (uint64_t)lifetime * 1000);
}

/* Return 1 when the message was consumed, 0 when it should be passed on as a
   normal IPv6 packet. */
static int ndp_input(NsL2 *l2, const uint8_t *ip, size_t len,
                     const uint8_t *srcmac)
{
    const uint8_t *src = ip + 8;
    const uint8_t *dst = ip + 24;
    const uint8_t *icmp;
    const uint8_t *opts;
    size_t total;
    size_t icmp_len;
    size_t opt_len;
    uint8_t type;
    NsAddr srcaddr, dstaddr, target;

    if (len < IPV6_HDR)
        return 0;
    if (ip[6] != 58 || ip[7] != 255)
        return 0;

    total = IPV6_HDR + (size_t)rd16(ip + 4);
    if (total > len)
        return 1;
    if (total < IPV6_HDR + 8)
        return 0;
    type = ip[40];
    if (type != ND_NS && type != ND_NA && type != ND_RS && type != ND_RA)
        return 0;
    icmp = ip + IPV6_HDR;
    icmp_len = total - IPV6_HDR;
    if (icmp6_checksum(src, dst, icmp, icmp_len) != 0 || icmp[1] != 0)
        return 1;

    if (type == ND_RS)
        return 1; /* we are a host, not a router */
    if (type == ND_RA) {
        ndp_ra_input(l2, src, icmp, icmp_len, srcmac);
        return 1;
    }
    if (total < IPV6_HDR + 24)
        return 1;
    l2->stats.rx_ndp++;

    memset(&srcaddr, 0, sizeof(srcaddr));
    memset(&dstaddr, 0, sizeof(dstaddr));
    memset(&target, 0, sizeof(target));
    srcaddr.family = dstaddr.family = target.family = NS_AF_INET6;
    memcpy(srcaddr.b, src, 16);
    memcpy(dstaddr.b, dst, 16);
    memcpy(target.b, icmp + 8, 16);

    opts = icmp + 24;
    opt_len = icmp_len - 24;

    if (icmp[0] == ND_NS) {
        const uint8_t *slla;

        /* DAD probes have no usable source and must not be answered. */
        if (!ipv6_enabled(l2) || addr_unspecified(&srcaddr) ||
            addr_multicast(&srcaddr))
            return 1;
        if (!is_local6(l2, &target))
            return 1;
        slla = ndp_option(opts, opt_len, ND_OPT_SOURCE_LL);
        ndp_emit_na(l2, slla ? slla : srcmac, &srcaddr, &target);
        return 1;
    }

    /* Neighbour advertisement. */
    if (!ipv6_enabled(l2) || addr_unspecified(&srcaddr))
        return 1;
    {
        const uint8_t *tlla = ndp_option(opts, opt_len, ND_OPT_TARGET_LL);
        const uint8_t *mac = tlla ? tlla : srcmac;
        NsNeigh *n;

        if (!mac_usable(mac))
            return 1;
        n = NULL;
        {
            int i;
            for (i = 0; i < NS_L2_MAX_NEIGHBORS; i++) {
                if (l2->neigh[i].state != NEIGH_FREE &&
                    addr_eq(&l2->neigh[i].addr, &target)) {
                    n = &l2->neigh[i];
                    break;
                }
            }
        }
        /* Only advertisements we asked for (or that update an existing
           entry) are trusted; unsolicited advertisements from an unrelated
           host must not create cache state. */
        if (n) {
            memcpy(n->mac, mac, NS_L2_MAC_LEN);
            n->state = NEIGH_REACHABLE;
            n->expires = l2->clock + NS_L2_REACHABLE_MS;
            n->retries = 0;
            n->used = ++l2->next_used;
            pending_flush(l2, &target, mac);
        }
    }
    return 1;
}

/* ---------------- neighbour cache ---------------- */

static void pending_drop_addr(NsL2 *l2, const NsAddr *addr, int counted)
{
    NsL2Pkt **pp = &l2->pending;

    while (*pp) {
        NsL2Pkt *p = *pp;
        if (addr_eq(&p->next_hop, addr)) {
            *pp = p->next;
            free(p);
            l2->npending--;
            if (counted)
                l2->stats.queue_dropped++;
        } else {
            pp = &p->next;
        }
    }
}

static NsNeigh *neigh_find(const NsL2 *l2, const NsAddr *addr)
{
    int i;

    for (i = 0; i < NS_L2_MAX_NEIGHBORS; i++) {
        NsNeigh *n = (NsNeigh *)&l2->neigh[i];
        if (n->state != NEIGH_FREE && addr_eq(&n->addr, addr))
            return n;
    }
    return NULL;
}

static NsNeigh *neigh_alloc(NsL2 *l2, const NsAddr *addr)
{
    NsNeigh *victim = NULL;
    int i;

    for (i = 0; i < NS_L2_MAX_NEIGHBORS; i++) {
        if (l2->neigh[i].state == NEIGH_FREE) {
            victim = &l2->neigh[i];
            break;
        }
    }
    if (!victim) {
        victim = &l2->neigh[0];
        for (i = 1; i < NS_L2_MAX_NEIGHBORS; i++)
            if (l2->neigh[i].used < victim->used)
                victim = &l2->neigh[i];
        if (victim->state == NEIGH_INCOMPLETE)
            pending_drop_addr(l2, &victim->addr, 1);
    }
    memset(victim, 0, sizeof(*victim));
    victim->addr = *addr;
    victim->addr.family = (uint8_t)ns_addr_family(addr);
    victim->used = ++l2->next_used;
    l2->stats.neighbors_created++;
    return victim;
}

static int pending_count_addr(const NsL2 *l2, const NsAddr *addr)
{
    const NsL2Pkt *p = l2->pending;
    int n = 0;

    while (p) {
        if (addr_eq(&p->next_hop, addr))
            n++;
        p = p->next;
    }
    return n;
}

static int pending_push(NsL2 *l2, const NsAddr *addr, const uint8_t *pkt,
                        size_t len)
{
    NsL2Pkt *p;

    if (l2->npending >= NS_L2_MAX_PENDING)
        return -1;
    if (pending_count_addr(l2, addr) >= NS_L2_PENDING_PER_NEIGHBOR)
        return -1;
    p = malloc(sizeof(*p) + len);
    if (!p)
        return -1;
    p->next = NULL;
    p->next_hop = *addr;
    p->next_hop.family = (uint8_t)ns_addr_family(addr);
    p->len = len;
    memcpy(p->data, pkt, len);
    if (!l2->pending) {
        l2->pending = p;
    } else {
        NsL2Pkt *tail = l2->pending;
        while (tail->next)
            tail = tail->next;
        tail->next = p;
    }
    l2->npending++;
    return 0;
}

static void pending_flush(NsL2 *l2, const NsAddr *addr, const uint8_t *mac)
{
    NsL2Pkt **pp = &l2->pending;

    while (*pp) {
        NsL2Pkt *p = *pp;
        if (addr_eq(&p->next_hop, addr)) {
            *pp = p->next;
            l2->npending--;
            l2_emit_ip(l2, p->data, p->len, mac);
            free(p);
        } else {
            pp = &p->next;
        }
    }
}

static void neigh_learn(NsL2 *l2, const NsAddr *addr, const uint8_t *mac)
{
    NsNeigh *n;

    if (addr_unspecified(addr) || addr_multicast(addr) ||
        addr_broadcast4(addr) || !mac_usable(mac))
        return;
    if ((l2->has4 && addr_eq(addr, &l2->local4)) || is_local6(l2, addr))
        return;

    n = neigh_find(l2, addr);
    if (!n) {
        n = neigh_alloc(l2, addr);
        if (!n)
            return;
    }
    memcpy(n->mac, mac, NS_L2_MAC_LEN);
    n->state = NEIGH_REACHABLE;
    n->expires = l2->clock + NS_L2_REACHABLE_MS;
    n->retries = 0;
    n->used = ++l2->next_used;
    pending_flush(l2, addr, mac);
}

static void neigh_probe(NsL2 *l2, NsNeigh *n)
{
    if (ns_addr_family(&n->addr) == NS_AF_INET)
        arp_emit_request(l2, &n->addr);
    else
        ndp_emit_ns(l2, &n->addr);
}

static int neigh_send(NsL2 *l2, const uint8_t *pkt, size_t len,
                      const NsAddr *next_hop)
{
    NsNeigh *n = neigh_find(l2, next_hop);

    if (n && n->state == NEIGH_REACHABLE) {
        l2->stats.neighbor_hits++;
        return l2_emit_ip(l2, pkt, len, n->mac);
    }

    if (!n) {
        n = neigh_alloc(l2, next_hop);
        if (!n) {
            l2->stats.dropped++;
            return -1;
        }
        n->state = NEIGH_INCOMPLETE;
        n->retries = 0;
        n->next_probe = l2->clock + NS_L2_PROBE_INTERVAL_MS;
    }

    if (pending_push(l2, next_hop, pkt, len) < 0) {
        l2->stats.queue_dropped++;
        return -1;
    }
    l2->stats.queued++;

    if (n->state == NEIGH_INCOMPLETE && n->retries == 0) {
        l2->stats.neighbor_misses++;
        neigh_probe(l2, n);
        n->retries = 1;
        n->next_probe = l2->clock + NS_L2_PROBE_INTERVAL_MS;
    }
    return 0;
}

/* ---------------- inbound frames ---------------- */

static void arp_input(NsL2 *l2, const uint8_t *arp, size_t len)
{
    uint16_t op;
    uint8_t sha[NS_L2_MAC_LEN];
    NsAddr spa, tpa;

    if (len < 28)
        return;
    if (rd16(arp) != 1 || rd16(arp + 2) != 0x0800 ||
        arp[4] != NS_L2_MAC_LEN || arp[5] != 4)
        return;
    op = rd16(arp + 6);
    memcpy(sha, arp + 8, NS_L2_MAC_LEN);
    memset(&spa, 0, sizeof(spa));
    memset(&tpa, 0, sizeof(tpa));
    spa.family = tpa.family = NS_AF_INET;
    memcpy(spa.b, arp + 14, 4);
    memcpy(tpa.b, arp + 24, 4);

    l2->stats.rx_arp++;
    neigh_learn(l2, &spa, sha);

    if (op == 1 && l2->has4 && addr_eq(&tpa, &l2->local4) &&
        !addr_unspecified(&spa))
        arp_emit_reply(l2, sha, &spa);
}

/* ---------------- public API ---------------- */

NsL2 *ns_l2_new(NsStack *stack, const uint8_t mac[NS_L2_MAC_LEN],
                NsL2SendFn send, void *opaque)
{
    NsL2 *l2;
    int i;

    if (!mac || !mac_usable(mac)) {
        errno = EINVAL;
        return NULL;
    }
    l2 = calloc(1, sizeof(*l2));
    if (!l2)
        return NULL;
    l2->stack = stack;
    memcpy(l2->mac, mac, NS_L2_MAC_LEN);
    l2->send = send;
    l2->opaque = opaque;
    l2->mtu = NS_L2_MTU;
    l2->clock = 1;
    l2->next_used = 1;
    for (i = 0; i < NS_L2_MAX_NEIGHBORS; i++)
        l2->neigh[i].state = NEIGH_FREE;
    return l2;
}

void ns_l2_free(NsL2 *l2)
{
    NsL2Pkt *p;

    if (!l2)
        return;
    p = l2->pending;
    while (p) {
        NsL2Pkt *next = p->next;
        free(p);
        p = next;
    }
    free(l2);
}

void ns_l2_set_send(NsL2 *l2, NsL2SendFn send, void *opaque)
{
    if (!l2)
        return;
    l2->send = send;
    l2->opaque = opaque;
}

static void l2_stack_send(NsStack *stack, const uint8_t *pkt, size_t len,
                          void *opaque)
{
    (void)stack;
    ns_l2_send_ip(opaque, pkt, len);
}

void ns_l2_attach(NsL2 *l2)
{
    if (!l2 || !l2->stack)
        return;
    ns_stack_set_send(l2->stack, l2_stack_send, l2);
}

int ns_l2_set_ipv4(NsL2 *l2, const NsAddr *local, int prefix_len,
                   const NsAddr *gateway)
{
    NsAddr zero;

    if (!l2 || !local || ns_addr_family(local) != NS_AF_INET ||
        prefix_len < 0 || prefix_len > 32)
        return -NS_EINVAL;
    if (gateway && ns_addr_family(gateway) != NS_AF_INET)
        return -NS_EINVAL;
    l2->local4 = *local;
    l2->local4.family = NS_AF_INET;
    l2->has4 = 1;

    route_flush_family(l2, NS_AF_INET);
    if (route_add_internal(l2, &l2->local4, prefix_len, NULL,
                           ROUTE_CONNECTED) < 0)
        return -NS_ENOSPC;
    if (gateway) {
        memset(&zero, 0, sizeof(zero));
        zero.family = NS_AF_INET;
        if (route_add_internal(l2, &zero, 0, gateway, ROUTE_STATIC) < 0)
            return -NS_ENOSPC;
    }
    return 0;
}

int ns_l2_set_ipv6(NsL2 *l2, const NsAddr *local, int prefix_len,
                   const NsAddr *gateway)
{
    NsAddr zero;

    if (!l2 || !local || ns_addr_family(local) != NS_AF_INET6 ||
        prefix_len < 0 || prefix_len > 128)
        return -NS_EINVAL;
    if (gateway && ns_addr_family(gateway) != NS_AF_INET6)
        return -NS_EINVAL;
    l2->local6 = *local;
    l2->local6.family = NS_AF_INET6;
    l2->has6 = 1;

    route_flush_family(l2, NS_AF_INET6);
    if (l2->has_link6) {
        NsAddr linknet;

        make_link_local_net(&linknet);
        if (route_add_internal(l2, &linknet, 64, NULL, ROUTE_CONNECTED) < 0)
            return -NS_ENOSPC;
    }
    if (route_add_internal(l2, &l2->local6, prefix_len, NULL,
                           ROUTE_CONNECTED) < 0)
        return -NS_ENOSPC;
    if (gateway) {
        memset(&zero, 0, sizeof(zero));
        zero.family = NS_AF_INET6;
        if (route_add_internal(l2, &zero, 0, gateway, ROUTE_STATIC) < 0)
            return -NS_ENOSPC;
    }
    return 0;
}

int ns_l2_set_router_discovery(NsL2 *l2, int enable)
{
    NsAddr linknet;
    int had_link;
    int i;

    if (!l2)
        return -NS_EINVAL;

    if (enable) {
        if (l2->router_discovery)
            return 0;
        make_link_local6(l2->mac, &l2->link6);
        make_link_local_net(&linknet);
        if (route_add_internal(l2, &linknet, 64, NULL, ROUTE_CONNECTED) < 0) {
            memset(&l2->link6, 0, sizeof(l2->link6));
            return -NS_ENOSPC;
        }
        l2->has_link6 = 1;
        l2->router_discovery = 1;
        l2->rs_left = NS_L2_RS_MAX;
        l2->next_rs = l2->clock;
        return 0;
    }

    had_link = l2->has_link6;
    l2->router_discovery = 0;
    l2->rs_left = 0;
    l2->has_link6 = 0;
    memset(&l2->link6, 0, sizeof(l2->link6));

    make_link_local_net(&linknet);
    for (i = 0; i < NS_L2_MAX_ROUTES; i++) {
        NsRoute *r = &l2->routes[i];

        if (r->kind == ROUTE_FREE)
            continue;
        if (r->kind == ROUTE_RA ||
            (had_link && r->family == NS_AF_INET6 && r->prefix_len == 64 &&
             addr_eq(&r->dest, &linknet)))
            memset(r, 0, sizeof(*r));
    }
    return 0;
}

const NsAddr *ns_l2_link_local6(const NsL2 *l2)
{
    return l2 && l2->has_link6 ? &l2->link6 : NULL;
}

int ns_l2_add_route(NsL2 *l2, const NsAddr *dest, int prefix_len,
                    const NsAddr *gateway)
{
    return route_add_internal(l2, dest, prefix_len, gateway, ROUTE_STATIC);
}

int ns_l2_del_route(NsL2 *l2, const NsAddr *dest, int prefix_len)
{
    NsAddr net;
    NsRoute *r;
    int family;

    if (!l2 || !dest)
        return -NS_EINVAL;
    family = ns_addr_family(dest);
    if (family != NS_AF_INET && family != NS_AF_INET6)
        return -NS_EINVAL;
    if (prefix_len < 0 || prefix_len > (family == NS_AF_INET ? 32 : 128))
        return -NS_EINVAL;
    net = *dest;
    net.family = (uint8_t)family;
    addr_mask(&net, prefix_len);
    r = route_find(l2, &net, prefix_len);
    if (!r)
        return -NS_EINVAL;
    memset(r, 0, sizeof(*r));
    return 0;
}

int ns_l2_route_lookup(const NsL2 *l2, const NsAddr *dst, NsL2RouteInfo *route)
{
    const NsRoute *r;

    if (!l2 || !dst)
        return 0;
    r = route_match(l2, dst);
    if (!r)
        return 0;
    if (route) {
        memset(route, 0, sizeof(*route));
        route->dest = r->dest;
        route->gateway = r->gateway;
        route->prefix_len = r->prefix_len;
        route->has_gateway = r->has_gateway;
    }
    return 1;
}

int ns_l2_send_ip(NsL2 *l2, const uint8_t *pkt, size_t len)
{
    int version;
    NsAddr dst, next;
    uint8_t mcast[NS_L2_MAC_LEN];
    uint8_t bcast[NS_L2_MAC_LEN];
    int routed;

    if (!l2 || !pkt || len < IPV4_HDR) {
        if (l2)
            l2->stats.dropped++;
        return -NS_EINVAL;
    }
    version = pkt[0] >> 4;
    memset(&dst, 0, sizeof(dst));
    memset(&next, 0, sizeof(next));

    if (version == 4) {
        dst.family = NS_AF_INET;
        memcpy(dst.b, pkt + 16, 4);
        if (l2->has4 && addr_eq(&dst, &l2->local4)) {
            l2->stats.local_delivered++;
            if (l2->stack)
                ns_input(l2->stack, pkt, len);
            return 0;
        }
        if (!l2->has4) {
            l2->stats.dropped++;
            return -1;
        }
        memset(bcast, 0xff, sizeof(bcast));
        if (addr_broadcast4(&dst) || subnet_broadcast4(l2, &dst))
            return l2_emit_ip(l2, pkt, len, bcast);
        if (addr_multicast(&dst)) {
            mac_multicast4(&dst, mcast);
            return l2_emit_ip(l2, pkt, len, mcast);
        }
        routed = route_next_hop(l2, &dst, &next);
        if (routed <= 0) {
            if (routed == 0)
                l2->stats.no_route++;
            else
                l2->stats.gateway_unreachable++;
            l2->stats.dropped++;
            return -1;
        }
        return neigh_send(l2, pkt, len, &next);
    }

    if (version == 6) {
        if (len < IPV6_HDR) {
            l2->stats.dropped++;
            return -1;
        }
        dst.family = NS_AF_INET6;
        memcpy(dst.b, pkt + 24, 16);
        if (is_local6(l2, &dst)) {
            l2->stats.local_delivered++;
            if (l2->stack)
                ns_input(l2->stack, pkt, len);
            return 0;
        }
        if (!ipv6_enabled(l2)) {
            l2->stats.dropped++;
            return -1;
        }
        if (addr_multicast(&dst)) {
            mac_multicast6(&dst, mcast);
            return l2_emit_ip(l2, pkt, len, mcast);
        }
        routed = route_next_hop(l2, &dst, &next);
        if (routed <= 0) {
            if (routed == 0)
                l2->stats.no_route++;
            else
                l2->stats.gateway_unreachable++;
            l2->stats.dropped++;
            return -1;
        }
        return neigh_send(l2, pkt, len, &next);
    }

    l2->stats.dropped++;
    return -1;
}

void ns_l2_input(NsL2 *l2, const uint8_t *frame, size_t len)
{
    uint16_t ethertype;
    const uint8_t *payload;
    size_t plen;

    if (!l2 || !frame || len < ETH_HDR) {
        if (l2)
            l2->stats.dropped++;
        return;
    }
    if (!mac_eq(frame, l2->mac) && !mac_broadcast(frame) &&
        !mac_multicast(frame)) {
        l2->stats.dropped++;
        return;
    }
    if (mac_eq(frame + 6, l2->mac))
        return; /* our own frame looped back */

    l2->stats.rx_frames++;
    ethertype = rd16(frame + 12);
    payload = frame + ETH_HDR;
    plen = len - ETH_HDR;

    if (ethertype == ETHERTYPE_ARP) {
        arp_input(l2, payload, plen);
        return;
    }
    if (ethertype == ETHERTYPE_IPV4) {
        if (l2->stack)
            ns_input(l2->stack, payload, plen);
        return;
    }
    if (ethertype == ETHERTYPE_IPV6) {
        if (plen >= IPV6_HDR) {
            if (ndp_input(l2, payload, plen, frame + 6))
                return;
        }
        if (l2->stack)
            ns_input(l2->stack, payload, plen);
        return;
    }
}

void ns_l2_tick(NsL2 *l2, uint64_t now_ms)
{
    int i;

    if (!l2)
        return;
    l2->clock = now_ms;

    for (i = 0; i < NS_L2_MAX_ROUTES; i++) {
        NsRoute *r = &l2->routes[i];

        if (r->kind == ROUTE_FREE || r->expires == 0 ||
            now_ms < r->expires)
            continue;
        memset(r, 0, sizeof(*r));
        l2->stats.route_expired++;
    }

    if (l2->router_discovery && l2->rs_left > 0 && now_ms >= l2->next_rs) {
        ndp_emit_rs(l2);
        l2->rs_left--;
        l2->next_rs = now_ms + NS_L2_RS_INTERVAL_MS;
    }

    for (i = 0; i < NS_L2_MAX_NEIGHBORS; i++) {
        NsNeigh *n = &l2->neigh[i];

        if (n->state == NEIGH_FREE)
            continue;
        if (n->state == NEIGH_REACHABLE) {
            if (now_ms >= n->expires) {
                n->state = NEIGH_FREE;
                pending_drop_addr(l2, &n->addr, 0);
            }
            continue;
        }
        if (now_ms < n->next_probe)
            continue;
        if (n->retries >= NS_L2_PROBE_MAX) {
            l2->stats.neighbor_timeouts++;
            pending_drop_addr(l2, &n->addr, 1);
            n->state = NEIGH_FREE;
            continue;
        }
        neigh_probe(l2, n);
        n->retries++;
        n->next_probe = now_ms + NS_L2_PROBE_INTERVAL_MS;
    }
}

int ns_l2_neighbor(const NsL2 *l2, const NsAddr *addr,
                   uint8_t mac[NS_L2_MAC_LEN])
{
    const NsNeigh *n;

    if (!l2 || !addr)
        return 0;
    n = neigh_find(l2, addr);
    if (!n || n->state != NEIGH_REACHABLE)
        return 0;
    if (mac)
        memcpy(mac, n->mac, NS_L2_MAC_LEN);
    return 1;
}

int ns_l2_pending_count(const NsL2 *l2)
{
    return l2 ? l2->npending : 0;
}

const uint8_t *ns_l2_mac(const NsL2 *l2)
{
    return l2 ? l2->mac : NULL;
}

const NsL2Stats *ns_l2_stats(const NsL2 *l2)
{
    return l2 ? &l2->stats : NULL;
}
