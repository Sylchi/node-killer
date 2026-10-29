/*
 * netstack L2 tests: Ethernet framing, ARP, IPv6 neighbour discovery and
 * neighbour-cache queueing over a simulated two-node Ethernet segment.
 */
#include "../netstack.h"
#include "../netstack_l2.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ETH_HDR 14
#define ETHERTYPE_IPV4 0x0800
#define ETHERTYPE_ARP 0x0806
#define ETHERTYPE_IPV6 0x86dd

static int failures;

#define CHECK(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
        failures++; \
    } \
} while (0)

typedef struct Sim {
    NsStack *sa;
    NsStack *sb;
    NsL2 *a;
    NsL2 *b;
    uint64_t now;
    int capture_on;
    size_t capture_len;
    uint8_t capture[NS_MAX_PACKET];
} Sim;

static const uint8_t sim_prefix[NS_PREFIX_LEN] = {
    0xfd, 0x00, 0x51, 0x4e, 0x00, 0x00, 0x00, 0x00
};

static const uint8_t mac_a[NS_L2_MAC_LEN] = { 0x02, 0x00, 0x00, 0x00, 0x00, 0x01 };
static const uint8_t mac_b[NS_L2_MAC_LEN] = { 0x02, 0x00, 0x00, 0x00, 0x00, 0x02 };

static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)((p[0] << 8) | p[1]);
}

static void sim_send(NsL2 *from, const uint8_t *frame, size_t len,
                     void *opaque)
{
    Sim *sim = opaque;

    if (sim->capture_on) {
        size_t n = len < sizeof(sim->capture) ? len : sizeof(sim->capture);
        memcpy(sim->capture, frame, n);
        sim->capture_len = n;
    }
    if (from == sim->a) {
        if (sim->b)
            ns_l2_input(sim->b, frame, len);
    } else if (from == sim->b) {
        if (sim->a)
            ns_l2_input(sim->a, frame, len);
    }
}

static void set_addr4(NsAddr *a, uint8_t b0, uint8_t b1, uint8_t b2,
                      uint8_t b3)
{
    memset(a, 0, sizeof(*a));
    a->family = NS_AF_INET;
    a->b[0] = b0;
    a->b[1] = b1;
    a->b[2] = b2;
    a->b[3] = b3;
}

static void set_addr6(NsAddr *a, uint8_t low)
{
    memset(a, 0, sizeof(*a));
    a->family = NS_AF_INET6;
    memcpy(a->b, sim_prefix, NS_PREFIX_LEN);
    a->b[15] = low;
}

/* Build a two-node segment. `v4`/`v6` select which families are configured;
   outputs receive each node's address for the enabled families. */
static void setup(Sim *sim, int v4, int v6, NsAddr *a4, NsAddr *b4,
                  NsAddr *a6, NsAddr *b6)
{
    memset(sim, 0, sizeof(*sim));
    sim->now = 1000;
    sim->sa = ns_stack_new(sim_prefix, 1, NULL, NULL);
    sim->sb = ns_stack_new(sim_prefix, 1, NULL, NULL);
    CHECK(sim->sa != NULL && sim->sb != NULL);

    if (v4) {
        set_addr4(a4, 10, 0, 0, 1);
        set_addr4(b4, 10, 0, 0, 2);
        CHECK(ns_stack_set_plain(sim->sa, a4) == 0);
        CHECK(ns_stack_set_plain(sim->sb, b4) == 0);
    }
    if (v6) {
        set_addr6(a6, 1);
        set_addr6(b6, 2);
        CHECK(ns_stack_set_plain(sim->sa, a6) == 0);
        CHECK(ns_stack_set_plain(sim->sb, b6) == 0);
    }

    sim->a = ns_l2_new(sim->sa, mac_a, sim_send, sim);
    sim->b = ns_l2_new(sim->sb, mac_b, sim_send, sim);
    CHECK(sim->a != NULL && sim->b != NULL);

    if (v4) {
        CHECK(ns_l2_set_ipv4(sim->a, a4, 24, NULL) == 0);
        CHECK(ns_l2_set_ipv4(sim->b, b4, 24, NULL) == 0);
    }
    if (v6) {
        CHECK(ns_l2_set_ipv6(sim->a, a6, 64, NULL) == 0);
        CHECK(ns_l2_set_ipv6(sim->b, b6, 64, NULL) == 0);
    }
    ns_l2_attach(sim->a);
    ns_l2_attach(sim->b);
    ns_l2_tick(sim->a, sim->now);
    ns_l2_tick(sim->b, sim->now);
}

static void teardown(Sim *sim)
{
    ns_stack_free(sim->sa);
    ns_stack_free(sim->sb);
    ns_l2_free(sim->a);
    ns_l2_free(sim->b);
    sim->sa = sim->sb = NULL;
    sim->a = sim->b = NULL;
}

/* ---------------- routing-table fixture ---------------- */

#define ROUTE_MAX_NODES 8

typedef struct RouteSim {
    NsL2 *nodes[ROUTE_MAX_NODES];
    int nnodes;
    NsL2 *a;
    int capture_on;
    size_t capture_len;
    uint8_t capture[NS_MAX_PACKET];
} RouteSim;

static void route_sim_send(NsL2 *from, const uint8_t *frame, size_t len,
                           void *opaque)
{
    RouteSim *sim = opaque;
    int i;

    if (from == sim->a && sim->capture_on) {
        size_t n = len < sizeof(sim->capture) ? len : sizeof(sim->capture);
        memcpy(sim->capture, frame, n);
        sim->capture_len = n;
    }
    for (i = 0; i < sim->nnodes; i++)
        if (sim->nodes[i] != from)
            ns_l2_input(sim->nodes[i], frame, len);
}

static void put16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}

static uint32_t csum_bytes(uint32_t sum, const uint8_t *p, size_t len)
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

/* ICMPv6 checksum; returns 0 when the checksum field is valid. */
static uint16_t icmp6_csum(const uint8_t *src, const uint8_t *dst,
                           const uint8_t *msg, size_t len)
{
    uint8_t tail[4];
    uint32_t sum = 0;

    put16(tail, (uint16_t)(len >> 16));
    put16(tail + 2, (uint16_t)len);
    sum = csum_bytes(sum, src, 16);
    sum = csum_bytes(sum, dst, 16);
    sum = csum_bytes(sum, tail, sizeof(tail));
    sum += 58; /* next header */
    sum = csum_bytes(sum, msg, len);
    return csum_fold(sum);
}

static void make_link_local(NsAddr *a, const uint8_t mac[NS_L2_MAC_LEN])
{
    memset(a, 0, sizeof(*a));
    a->family = NS_AF_INET6;
    a->b[0] = 0xfe;
    a->b[1] = 0x80;
    a->b[8] = (uint8_t)(mac[0] ^ 0x02);
    a->b[9] = mac[1];
    a->b[10] = mac[2];
    a->b[11] = 0xff;
    a->b[12] = 0xfe;
    a->b[13] = mac[3];
    a->b[14] = mac[4];
    a->b[15] = mac[5];
}

/* Build an Ethernet/IPv6 router advertisement from `src`. */
static size_t make_ra(uint8_t *frame, const uint8_t srcmac[NS_L2_MAC_LEN],
                      const NsAddr *src, uint16_t lifetime, int with_slla)
{
    uint8_t *ip = frame + ETH_HDR;
    uint8_t *icmp = ip + 40;
    uint8_t dst6[16];
    size_t plen = 16 + (with_slla ? 8 : 0);

    memset(frame, 0, ETH_HDR + 40 + plen);
    frame[0] = 0x33;
    frame[1] = 0x33;
    frame[5] = 0x01; /* 33:33:00:00:00:01, all-nodes multicast */
    memcpy(frame + 6, srcmac, NS_L2_MAC_LEN);
    put16(frame + 12, ETHERTYPE_IPV6);

    memset(dst6, 0, sizeof(dst6));
    dst6[0] = 0xff;
    dst6[1] = 0x02;
    dst6[15] = 0x01;
    ip[0] = 0x60;
    put16(ip + 4, (uint16_t)plen);
    ip[6] = 58;
    ip[7] = 255;
    memcpy(ip + 8, src->b, 16);
    memcpy(ip + 24, dst6, 16);

    icmp[0] = 134; /* router advertisement */
    icmp[1] = 0;
    icmp[4] = 64; /* current hop limit */
    put16(icmp + 6, lifetime);
    if (with_slla) {
        icmp[16] = 1; /* source link-layer address */
        icmp[17] = 1;
        memcpy(icmp + 18, srcmac, NS_L2_MAC_LEN);
    }
    put16(icmp + 2, icmp6_csum(ip + 8, dst6, icmp, plen));
    return ETH_HDR + 40 + plen;
}

static void set_addr6_full(NsAddr *a, const uint8_t b[16])
{
    memset(a, 0, sizeof(*a));
    a->family = NS_AF_INET6;
    memcpy(a->b, b, 16);
}

/* Minimal IPv4/UDP packet. Only the header fields the L2 layer reads are
   filled in; the stack is not involved in these tests. */
static size_t make_v4(uint8_t *pkt, const NsAddr *dst)
{
    static const uint8_t src[4] = { 10, 0, 0, 1 };

    memset(pkt, 0, 20 + 8);
    pkt[0] = 0x45;
    put16(pkt + 2, 20 + 8);
    pkt[8] = 64;
    pkt[9] = 17;
    memcpy(pkt + 12, src, 4);
    memcpy(pkt + 16, dst->b, 4);
    put16(pkt + 20, 1234);
    put16(pkt + 22, 5678);
    put16(pkt + 24, 8);
    return 20 + 8;
}

static size_t make_v6(uint8_t *pkt, const NsAddr *dst)
{
    static const uint8_t src[16] = {
        0xfd, 0x00, 0x51, 0x4e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
    };

    memset(pkt, 0, 40 + 8);
    pkt[0] = 0x60;
    put16(pkt + 4, 8);
    pkt[6] = 17;
    pkt[7] = 64;
    memcpy(pkt + 8, src, 16);
    memcpy(pkt + 24, dst->b, 16);
    put16(pkt + 40, 1234);
    put16(pkt + 42, 5678);
    put16(pkt + 44, 8);
    return 40 + 8;
}

static NsL2 *route_add_node(RouteSim *sim, const uint8_t mac[NS_L2_MAC_LEN],
                            const NsAddr *addr, int prefix_len)
{
    NsL2 *n = ns_l2_new(NULL, mac, route_sim_send, sim);

    CHECK(n != NULL);
    CHECK(sim->nnodes < ROUTE_MAX_NODES);
    sim->nodes[sim->nnodes++] = n;
    if (ns_addr_family(addr) == NS_AF_INET)
        CHECK(ns_l2_set_ipv4(n, addr, prefix_len, NULL) == 0);
    else
        CHECK(ns_l2_set_ipv6(n, addr, prefix_len, NULL) == 0);
    return n;
}

/* Send one packet from A and check that the last frame A emitted is addressed
   to `expected`'s MAC. Resolution runs synchronously on this segment, so the
   final frame is the data frame. */
static void expect_next_hop(RouteSim *sim, NsL2 *expected, const uint8_t *pkt,
                            size_t len)
{
    sim->capture_on = 1;
    sim->capture_len = 0;
    CHECK(ns_l2_send_ip(sim->a, pkt, len) == 0);
    CHECK(sim->capture_len > 0);
    CHECK(memcmp(sim->capture, ns_l2_mac(expected), NS_L2_MAC_LEN) == 0);
}

static void close_route_sim(RouteSim *sim)
{
    int i;

    for (i = 0; i < sim->nnodes; i++)
        ns_l2_free(sim->nodes[i]);
    sim->nnodes = 0;
    sim->a = NULL;
}

static void test_routing_table(void)
{
    static const uint8_t mac_a2[NS_L2_MAC_LEN] = { 0x02, 0, 0, 0, 1, 1 };
    static const uint8_t mac_r0[NS_L2_MAC_LEN] = { 0x02, 0, 0, 0, 1, 2 };
    static const uint8_t mac_r1[NS_L2_MAC_LEN] = { 0x02, 0, 0, 0, 1, 3 };
    static const uint8_t mac_r2[NS_L2_MAC_LEN] = { 0x02, 0, 0, 0, 1, 4 };
    static const uint8_t mac_r6[NS_L2_MAC_LEN] = { 0x02, 0, 0, 0, 1, 5 };
    static const uint8_t mac_peer[NS_L2_MAC_LEN] = { 0x02, 0, 0, 0, 1, 6 };
    static const uint8_t prefix7[16] = {
        0x20, 0x01, 0x0d, 0xb8, 0x00, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    };
    static const uint8_t prefix8[16] = {
        0x20, 0x01, 0x0d, 0xb8, 0x00, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    };
    RouteSim sim;
    NsAddr a4, a6, gw0, gw1, gw2, gw6, peer4, dst, net, badgw;
    NsAddr net7;
    NsL2 *r0, *r1, *r2, *r6, *peer;
    NsL2RouteInfo info;
    uint8_t pkt[64];
    uint8_t bcast[NS_L2_MAC_LEN];
    uint64_t before;
    size_t len;

    memset(&sim, 0, sizeof(sim));
    set_addr4(&a4, 10, 0, 0, 1);
    set_addr4(&gw0, 10, 0, 0, 254);
    set_addr4(&gw1, 10, 0, 0, 252);
    set_addr4(&gw2, 10, 0, 0, 253);
    set_addr4(&peer4, 10, 0, 0, 9);
    set_addr6(&a6, 1);
    set_addr6(&gw6, 0xfe);
    set_addr6_full(&net7, prefix7);

    sim.a = ns_l2_new(NULL, mac_a2, route_sim_send, &sim);
    CHECK(sim.a != NULL);
    sim.nodes[sim.nnodes++] = sim.a;
    CHECK(ns_l2_set_ipv4(sim.a, &a4, 24, NULL) == 0);
    CHECK(ns_l2_set_ipv6(sim.a, &a6, 64, NULL) == 0);

    r0 = route_add_node(&sim, mac_r0, &gw0, 24);
    r1 = route_add_node(&sim, mac_r1, &gw1, 24);
    r2 = route_add_node(&sim, mac_r2, &gw2, 24);
    r6 = route_add_node(&sim, mac_r6, &gw6, 64);
    peer = route_add_node(&sim, mac_peer, &peer4, 24);
    (void)r0;
    (void)r1;
    (void)r2;
    (void)r6;
    (void)peer;

    /* Connected route: an on-link peer needs no gateway. */
    set_addr4(&dst, 10, 0, 0, 9);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(info.prefix_len == 24);
    CHECK(info.has_gateway == 0);
    len = make_v4(pkt, &dst);
    expect_next_hop(&sim, peer, pkt, len);

    /* More specific /24 beats /16; /16 handles the rest of 192.168/16. */
    set_addr4(&net, 192, 168, 0, 0);
    CHECK(ns_l2_add_route(sim.a, &net, 16, &gw1) == 0);
    set_addr4(&net, 192, 168, 5, 0);
    CHECK(ns_l2_add_route(sim.a, &net, 24, &gw2) == 0);
    set_addr4(&net, 0, 0, 0, 0);
    CHECK(ns_l2_add_route(sim.a, &net, 0, &gw0) == 0);

    set_addr4(&dst, 192, 168, 5, 7);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(info.prefix_len == 24);
    CHECK(info.has_gateway == 1);
    CHECK(memcmp(info.gateway.b, gw2.b, 4) == 0);
    len = make_v4(pkt, &dst);
    expect_next_hop(&sim, r2, pkt, len);

    set_addr4(&dst, 192, 168, 9, 7);
    len = make_v4(pkt, &dst);
    expect_next_hop(&sim, r1, pkt, len);

    set_addr4(&dst, 8, 8, 8, 8);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(info.prefix_len == 0);
    CHECK(info.has_gateway == 1);
    len = make_v4(pkt, &dst);
    expect_next_hop(&sim, r0, pkt, len);

    /* An on-link /24 route gets a directed broadcast address. */
    set_addr4(&net, 192, 168, 20, 0);
    CHECK(ns_l2_add_route(sim.a, &net, 24, NULL) == 0);
    set_addr4(&dst, 192, 168, 20, 255);
    memset(bcast, 0xff, sizeof(bcast));
    sim.capture_on = 1;
    sim.capture_len = 0;
    len = make_v4(pkt, &dst);
    CHECK(ns_l2_send_ip(sim.a, pkt, len) == 0);
    CHECK(sim.capture_len > 0);
    CHECK(memcmp(sim.capture, bcast, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_pending_count(sim.a) == 0);

    /* IPv6 route through an on-link router. */
    CHECK(ns_l2_add_route(sim.a, &net7, 64, &gw6) == 0);
    set_addr6_full(&dst, prefix7);
    dst.b[15] = 9;
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(info.prefix_len == 64);
    CHECK(info.has_gateway == 1);
    CHECK(memcmp(info.gateway.b, gw6.b, 16) == 0);
    len = make_v6(pkt, &dst);
    expect_next_hop(&sim, r6, pkt, len);

    /* A gateway that is not on-link cannot be used. */
    set_addr4(&net, 172, 16, 0, 0);
    set_addr4(&badgw, 192, 0, 2, 1);
    CHECK(ns_l2_add_route(sim.a, &net, 12, &badgw) == 0);
    set_addr4(&dst, 172, 16, 5, 5);
    before = ns_l2_stats(sim.a)->gateway_unreachable;
    sim.capture_on = 1;
    sim.capture_len = 0;
    len = make_v4(pkt, &dst);
    CHECK(ns_l2_send_ip(sim.a, pkt, len) < 0);
    CHECK(ns_l2_stats(sim.a)->gateway_unreachable == before + 1);
    CHECK(sim.capture_len == 0);
    CHECK(ns_l2_pending_count(sim.a) == 0);

    /* Removing the default route makes an otherwise unmatched packet fail. */
    set_addr4(&net, 0, 0, 0, 0);
    CHECK(ns_l2_del_route(sim.a, &net, 0) == 0);
    CHECK(ns_l2_del_route(sim.a, &net, 0) == -NS_EINVAL);
    set_addr4(&dst, 8, 8, 8, 8);
    before = ns_l2_stats(sim.a)->no_route;
    len = make_v4(pkt, &dst);
    CHECK(ns_l2_send_ip(sim.a, pkt, len) < 0);
    CHECK(ns_l2_stats(sim.a)->no_route == before + 1);

    /* Neither family has a default route; IPv6 misses are counted too. */
    set_addr6_full(&dst, prefix8);
    dst.b[15] = 1;
    before = ns_l2_stats(sim.a)->no_route;
    len = make_v6(pkt, &dst);
    CHECK(ns_l2_send_ip(sim.a, pkt, len) < 0);
    CHECK(ns_l2_stats(sim.a)->no_route == before + 1);

    /* Adding the same prefix again replaces the gateway. */
    set_addr4(&net, 10, 1, 0, 0);
    CHECK(ns_l2_add_route(sim.a, &net, 16, &gw1) == 0);
    CHECK(ns_l2_add_route(sim.a, &net, 16, &gw2) == 0);
    set_addr4(&dst, 10, 1, 2, 3);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(memcmp(info.gateway.b, gw2.b, 4) == 0);

    /* A static route cannot replace the connected route for the same
       prefix. */
    set_addr4(&net, 10, 0, 0, 0);
    CHECK(ns_l2_add_route(sim.a, &net, 24, &gw1) == -NS_EINVAL);
    set_addr4(&dst, 10, 0, 0, 9);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(info.has_gateway == 0);

    /* Invalid route requests are rejected. */
    CHECK(ns_l2_add_route(NULL, &net, 16, NULL) == -NS_EINVAL);
    CHECK(ns_l2_add_route(sim.a, &net, 33, NULL) == -NS_EINVAL);
    CHECK(ns_l2_add_route(sim.a, &net, 16, &gw6) == -NS_EINVAL);
    CHECK(ns_l2_add_route(sim.a, &a6, 129, NULL) == -NS_EINVAL);

    /* Reconfiguring an address family resets its routes. */
    CHECK(ns_l2_set_ipv4(sim.a, &a4, 24, NULL) == 0);
    set_addr4(&dst, 10, 1, 2, 3);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 0);
    set_addr4(&dst, 192, 168, 5, 7);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 0);
    set_addr4(&dst, 10, 0, 0, 9);
    CHECK(ns_l2_route_lookup(sim.a, &dst, &info) == 1);
    CHECK(info.prefix_len == 24);

    close_route_sim(&sim);
}

static void test_arp_ipv4(void)
{
    Sim sim;
    NsAddr a4, b4, a6, b6;
    uint64_t ua, ub;
    uint16_t bport = 0;
    uint8_t mac[NS_L2_MAC_LEN];
    char buf[32];
    int n;
    uint64_t arp_tx;

    setup(&sim, 1, 0, &a4, &b4, &a6, &b6);
    ua = ns_udp_open(sim.sa, &a4, 0, 0);
    ub = ns_udp_open(sim.sb, &b4, 0, 0);
    CHECK(ua != 0 && ub != 0);
    CHECK(ns_udp_bound_addr(sim.sb, ub, NULL, &bport) == 0);

    sim.capture_on = 1;
    CHECK(ns_udp_sendto(sim.sa, ua, &b4, bport, "hello", 5) == 5);

    /* The first packet triggers ARP; the reply resolves the neighbour and
       flushes the queued IP packet before sendto() returns. */
    CHECK(ns_l2_stats(sim.a)->tx_arp == 1);
    CHECK(ns_l2_stats(sim.b)->rx_arp == 1);
    CHECK(ns_l2_stats(sim.b)->tx_arp == 1);
    CHECK(ns_l2_stats(sim.a)->rx_arp == 1);
    CHECK(ns_l2_neighbor(sim.a, &b4, mac) == 1);
    CHECK(memcmp(mac, mac_b, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_neighbor(sim.b, &a4, mac) == 1);
    CHECK(memcmp(mac, mac_a, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_pending_count(sim.a) == 0);

    /* The frame that reached the wire is Ethernet/IPv4 from a to b. */
    CHECK(sim.capture_len == ETH_HDR + 20 + 8 + 5);
    CHECK(memcmp(sim.capture, mac_b, NS_L2_MAC_LEN) == 0);
    CHECK(memcmp(sim.capture + 6, mac_a, NS_L2_MAC_LEN) == 0);
    CHECK(rd16(sim.capture + 12) == ETHERTYPE_IPV4);
    CHECK(sim.capture[ETH_HDR] == 0x45);
    CHECK(memcmp(sim.capture + ETH_HDR + 12, a4.b, 4) == 0);
    CHECK(memcmp(sim.capture + ETH_HDR + 16, b4.b, 4) == 0);

    CHECK(ns_run(sim.sb, 10) == 1);
    memset(buf, 0, sizeof(buf));
    n = ns_udp_recvfrom(sim.sb, ub, buf, sizeof(buf), NULL, NULL);
    CHECK(n == 5);
    CHECK(memcmp(buf, "hello", 5) == 0);

    /* A reachable neighbour is used directly: no new ARP. */
    arp_tx = ns_l2_stats(sim.a)->tx_arp;
    CHECK(ns_udp_sendto(sim.sa, ua, &b4, bport, "again", 5) == 5);
    CHECK(ns_l2_stats(sim.a)->tx_arp == arp_tx);
    CHECK(ns_l2_stats(sim.a)->neighbor_hits >= 1);
    CHECK(ns_run(sim.sb, 10) == 1);
    n = ns_udp_recvfrom(sim.sb, ub, buf, sizeof(buf), NULL, NULL);
    CHECK(n == 5);
    CHECK(memcmp(buf, "again", 5) == 0);

    /* Reachable entries expire and are resolved again. */
    ns_l2_tick(sim.a, sim.now + NS_L2_REACHABLE_MS + 1);
    CHECK(ns_l2_neighbor(sim.a, &b4, NULL) == 0);
    CHECK(ns_udp_sendto(sim.sa, ua, &b4, bport, "third", 5) == 5);
    CHECK(ns_l2_stats(sim.a)->tx_arp == arp_tx + 1);

    CHECK(ns_udp_close(sim.sa, ua) == 0);
    CHECK(ns_udp_close(sim.sb, ub) == 0);
    teardown(&sim);
}

static void test_ndp_ipv6(void)
{
    Sim sim;
    NsAddr a4, b4, a6, b6;
    uint64_t ua, ub;
    uint16_t bport = 0;
    uint8_t mac[NS_L2_MAC_LEN];
    char buf[32];
    int n;

    setup(&sim, 0, 1, &a4, &b4, &a6, &b6);
    ua = ns_udp_open(sim.sa, &a6, 0, 0);
    ub = ns_udp_open(sim.sb, &b6, 0, 0);
    CHECK(ua != 0 && ub != 0);
    CHECK(ns_udp_bound_addr(sim.sb, ub, NULL, &bport) == 0);

    sim.capture_on = 1;
    CHECK(ns_udp_sendto(sim.sa, ua, &b6, bport, "hello6", 6) == 6);

    CHECK(ns_l2_stats(sim.a)->tx_ndp == 1);
    CHECK(ns_l2_stats(sim.b)->rx_ndp == 1);
    CHECK(ns_l2_stats(sim.b)->tx_ndp == 1);
    CHECK(ns_l2_stats(sim.a)->rx_ndp == 1);
    CHECK(ns_l2_neighbor(sim.a, &b6, mac) == 1);
    CHECK(memcmp(mac, mac_b, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_pending_count(sim.a) == 0);

    CHECK(sim.capture_len == ETH_HDR + 40 + 8 + 6);
    CHECK(memcmp(sim.capture, mac_b, NS_L2_MAC_LEN) == 0);
    CHECK(memcmp(sim.capture + 6, mac_a, NS_L2_MAC_LEN) == 0);
    CHECK(rd16(sim.capture + 12) == ETHERTYPE_IPV6);
    CHECK((sim.capture[ETH_HDR] >> 4) == 6);
    CHECK(sim.capture[ETH_HDR + 6] == 17);
    CHECK(memcmp(sim.capture + ETH_HDR + 8, a6.b, 16) == 0);
    CHECK(memcmp(sim.capture + ETH_HDR + 24, b6.b, 16) == 0);

    CHECK(ns_run(sim.sb, 10) == 1);
    memset(buf, 0, sizeof(buf));
    n = ns_udp_recvfrom(sim.sb, ub, buf, sizeof(buf), NULL, NULL);
    CHECK(n == 6);
    CHECK(memcmp(buf, "hello6", 6) == 0);

    CHECK(ns_udp_close(sim.sa, ua) == 0);
    CHECK(ns_udp_close(sim.sb, ub) == 0);
    teardown(&sim);
}

static void test_unresolved_timeout(void)
{
    Sim sim;
    NsAddr a4, gw4, remote;
    NsStack *sa;
    NsL2 *a;
    uint64_t u;
    uint8_t bcast[NS_L2_MAC_LEN];
    uint64_t arp_tx;

    memset(&sim, 0, sizeof(sim));
    sim.now = 1000;
    sa = ns_stack_new(sim_prefix, 1, NULL, NULL);
    CHECK(sa != NULL);
    set_addr4(&a4, 10, 0, 0, 1);
    set_addr4(&gw4, 10, 0, 0, 254);
    set_addr4(&remote, 192, 168, 1, 5);
    CHECK(ns_stack_set_plain(sa, &a4) == 0);

    a = ns_l2_new(sa, mac_a, sim_send, &sim);
    CHECK(a != NULL);
    sim.sa = sa;
    sim.a = a;
    CHECK(ns_l2_set_ipv4(a, &a4, 24, &gw4) == 0);
    ns_l2_attach(a);
    ns_l2_tick(a, sim.now);

    u = ns_udp_open(sa, &a4, 0, 0);
    CHECK(u != 0);
    sim.capture_on = 1;
    CHECK(ns_udp_sendto(sa, u, &remote, 7000, "x", 1) == 1);

    /* Off-link destinations resolve the gateway, not the destination. */
    memset(bcast, 0xff, sizeof(bcast));
    CHECK(sim.capture_len == ETH_HDR + 28);
    CHECK(memcmp(sim.capture, bcast, NS_L2_MAC_LEN) == 0);
    CHECK(rd16(sim.capture + 12) == ETHERTYPE_ARP);
    CHECK(rd16(sim.capture + ETH_HDR + 6) == 1);
    CHECK(memcmp(sim.capture + ETH_HDR + 24, gw4.b, 4) == 0);
    CHECK(ns_l2_pending_count(a) == 1);
    CHECK(ns_l2_stats(a)->neighbor_misses == 1);

    /* Three transmissions, then give up and drop the queued packet. */
    ns_l2_tick(a, 2000);
    ns_l2_tick(a, 3000);
    ns_l2_tick(a, 4000);
    arp_tx = ns_l2_stats(a)->tx_arp;
    CHECK(arp_tx == 3);
    CHECK(ns_l2_stats(a)->neighbor_timeouts == 1);
    CHECK(ns_l2_pending_count(a) == 0);
    CHECK(ns_l2_neighbor(a, &gw4, NULL) == 0);

    CHECK(ns_udp_close(sa, u) == 0);
    ns_stack_free(sa);
    ns_l2_free(a);
}

static void test_local_delivery(void)
{
    Sim sim;
    NsAddr a4, b4, a6, b6;
    const uint8_t payload[1] = { 'p' };

    setup(&sim, 1, 0, &a4, &b4, &a6, &b6);
    CHECK(ns_icmp_echo(sim.sa, &a4, &a4, 1, 1, payload, 1) == 0);
    CHECK(ns_l2_stats(sim.a)->local_delivered >= 1);
    CHECK(ns_l2_stats(sim.a)->tx_frames == 0);
    CHECK(ns_l2_pending_count(sim.a) == 0);
    CHECK(ns_run(sim.sa, 1) == 1);
    CHECK(ns_stats(sim.sa)->icmp_rx == 1);
    CHECK(ns_stats(sim.sa)->icmp_tx == 2); /* request plus local reply */
    teardown(&sim);
}

static void test_broadcast_and_multicast(void)
{
    Sim sim;
    NsAddr a4, a6, bcast, subnet_bcast, mcast6;
    NsStack *sa;
    NsL2 *a;
    uint64_t u4, u6;
    uint8_t ff[NS_L2_MAC_LEN];
    uint8_t m6[NS_L2_MAC_LEN] = { 0x33, 0x33, 0x00, 0x00, 0x00, 0x01 };

    memset(&sim, 0, sizeof(sim));
    sim.now = 1000;
    sa = ns_stack_new(sim_prefix, 1, NULL, NULL);
    CHECK(sa != NULL);
    set_addr4(&a4, 10, 0, 0, 1);
    set_addr4(&bcast, 255, 255, 255, 255);
    set_addr4(&subnet_bcast, 10, 0, 0, 255);
    set_addr6(&a6, 1);
    memset(&mcast6, 0, sizeof(mcast6));
    mcast6.family = NS_AF_INET6;
    mcast6.b[0] = 0xff;
    mcast6.b[1] = 0x02;
    mcast6.b[15] = 1;
    CHECK(ns_stack_set_plain(sa, &a4) == 0);
    CHECK(ns_stack_set_plain(sa, &a6) == 0);

    a = ns_l2_new(sa, mac_a, sim_send, &sim);
    CHECK(a != NULL);
    sim.sa = sa;
    sim.a = a;
    CHECK(ns_l2_set_ipv4(a, &a4, 24, NULL) == 0);
    CHECK(ns_l2_set_ipv6(a, &a6, 64, NULL) == 0);
    ns_l2_attach(a);
    ns_l2_tick(a, sim.now);

    u4 = ns_udp_open(sa, &a4, 0, 0);
    u6 = ns_udp_open(sa, &a6, 0, 0);
    CHECK(u4 != 0 && u6 != 0);
    sim.capture_on = 1;
    memset(ff, 0xff, sizeof(ff));

    CHECK(ns_udp_sendto(sa, u4, &bcast, 7000, "b", 1) == 1);
    CHECK(rd16(sim.capture + 12) == ETHERTYPE_IPV4);
    CHECK(memcmp(sim.capture, ff, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_pending_count(a) == 0);

    CHECK(ns_udp_sendto(sa, u4, &subnet_bcast, 7000, "b", 1) == 1);
    CHECK(memcmp(sim.capture, ff, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_pending_count(a) == 0);

    CHECK(ns_udp_sendto(sa, u6, &mcast6, 7000, "m", 1) == 1);
    CHECK(rd16(sim.capture + 12) == ETHERTYPE_IPV6);
    CHECK(memcmp(sim.capture, m6, NS_L2_MAC_LEN) == 0);
    CHECK(ns_l2_pending_count(a) == 0);

    CHECK(ns_udp_close(sa, u4) == 0);
    CHECK(ns_udp_close(sa, u6) == 0);
    ns_stack_free(sa);
    ns_l2_free(a);
}

static void test_router_discovery(void)
{
    Sim sim;
    NsL2 *a, *b;
    NsAddr a_ll, b_ll, router, dst, zero, fake;
    NsL2RouteInfo info;
    const NsAddr *ll;
    uint8_t frame[128];
    uint8_t pkt[64];
    uint8_t mac[NS_L2_MAC_LEN];
    uint8_t rs_dst[16];
    uint64_t tx;
    size_t len;

    memset(&sim, 0, sizeof(sim));
    sim.now = 1000;
    a = ns_l2_new(NULL, mac_a, sim_send, &sim);
    b = ns_l2_new(NULL, mac_b, sim_send, &sim);
    CHECK(a != NULL && b != NULL);
    if (!a || !b)
        return;
    sim.a = a;
    sim.b = b;

    make_link_local(&a_ll, mac_a);
    make_link_local(&b_ll, mac_b);
    memset(&router, 0, sizeof(router));
    memset(&zero, 0, sizeof(zero));
    zero.family = NS_AF_INET6;
    memset(&dst, 0, sizeof(dst));
    dst.family = NS_AF_INET6;
    dst.b[0] = 0x20;
    dst.b[1] = 0x01;
    dst.b[2] = 0x0d;
    dst.b[3] = 0xb8;
    dst.b[15] = 9;

    CHECK(ns_l2_set_router_discovery(NULL, 1) == -NS_EINVAL);
    CHECK(ns_l2_link_local6(a) == NULL);
    CHECK(ns_l2_set_router_discovery(a, 1) == 0);
    CHECK(ns_l2_set_router_discovery(a, 1) == 0); /* idempotent */
    CHECK(ns_l2_set_router_discovery(b, 1) == 0);
    ll = ns_l2_link_local6(a);
    CHECK(ll != NULL);
    CHECK(ll && memcmp(ll->b, a_ll.b, 16) == 0);

    /* Link-local neighbours resolve through NDP with a link-local source. */
    len = make_v6(pkt, &b_ll);
    CHECK(ns_l2_send_ip(a, pkt, len) == 0);
    CHECK(ns_l2_stats(a)->tx_ndp == 1);
    CHECK(ns_l2_stats(b)->rx_ndp == 1);
    CHECK(ns_l2_stats(b)->tx_ndp == 1);
    CHECK(ns_l2_stats(a)->rx_ndp == 1);
    CHECK(ns_l2_neighbor(a, &b_ll, mac) == 1);
    CHECK(memcmp(mac, mac_b, NS_L2_MAC_LEN) == 0);

    /* Three solicitations, one per second. */
    sim.capture_on = 1;
    ns_l2_tick(a, 1000);
    CHECK(ns_l2_stats(a)->tx_rs == 1);
    CHECK(sim.capture_len == ETH_HDR + 40 + 8 + 8);
    CHECK(memcmp(sim.capture, "\x33\x33\x00\x00\x00\x02", 6) == 0);
    CHECK(rd16(sim.capture + 12) == ETHERTYPE_IPV6);
    CHECK(sim.capture[ETH_HDR + 6] == 58);
    CHECK(sim.capture[ETH_HDR + 7] == 255);
    CHECK(memcmp(sim.capture + ETH_HDR + 8, a_ll.b, 16) == 0);
    memset(rs_dst, 0, sizeof(rs_dst));
    rs_dst[0] = 0xff;
    rs_dst[1] = 0x02;
    rs_dst[15] = 0x02;
    CHECK(memcmp(sim.capture + ETH_HDR + 24, rs_dst, 16) == 0);
    CHECK(sim.capture[ETH_HDR + 40] == 133);
    CHECK(icmp6_csum(sim.capture + ETH_HDR + 8, rs_dst,
                     sim.capture + ETH_HDR + 40, 16) == 0);

    ns_l2_tick(a, 1000);
    CHECK(ns_l2_stats(a)->tx_rs == 1);
    ns_l2_tick(a, 2000);
    CHECK(ns_l2_stats(a)->tx_rs == 2);
    ns_l2_tick(a, 3000);
    CHECK(ns_l2_stats(a)->tx_rs == 3);
    ns_l2_tick(a, 4000);
    CHECK(ns_l2_stats(a)->tx_rs == 3);

    /* Invalid advertisements are ignored: bad checksum, then a non-link-local
       source. */
    len = make_ra(frame, mac_b, &b_ll, 30, 0);
    frame[ETH_HDR + 40 + 2] ^= 0xff;
    ns_l2_input(a, frame, len);
    CHECK(ns_l2_stats(a)->rx_ra == 0);
    set_addr6(&fake, 9); /* fd00:51:4e::9, not link-local */
    len = make_ra(frame, mac_b, &fake, 30, 0);
    ns_l2_input(a, frame, len);
    CHECK(ns_l2_stats(a)->rx_ra == 0);
    CHECK(ns_l2_route_lookup(a, &dst, &info) == 0);

    /* A router advertisement installs a default route and stops soliciting. */
    router = b_ll;
    len = make_ra(frame, mac_b, &router, 30, 1);
    ns_l2_input(a, frame, len);
    CHECK(ns_l2_stats(a)->rx_ra == 1);
    CHECK(ns_l2_stats(a)->ra_routes == 1);
    tx = ns_l2_stats(a)->tx_rs;
    ns_l2_tick(a, 5000);
    CHECK(ns_l2_stats(a)->tx_rs == tx);

    CHECK(ns_l2_route_lookup(a, &dst, &info) == 1);
    CHECK(info.prefix_len == 0);
    CHECK(info.has_gateway == 1);
    CHECK(memcmp(info.gateway.b, router.b, 16) == 0);

    sim.capture_on = 1;
    sim.capture_len = 0;
    len = make_v6(pkt, &dst);
    CHECK(ns_l2_send_ip(a, pkt, len) == 0);
    CHECK(sim.capture_len > 0);
    CHECK(memcmp(sim.capture, mac_b, NS_L2_MAC_LEN) == 0);

    /* The learned default route expires with the advertised lifetime. */
    CHECK(ns_l2_stats(a)->route_expired == 0);
    ns_l2_tick(a, 34000);
    CHECK(ns_l2_stats(a)->route_expired == 1);
    CHECK(ns_l2_route_lookup(a, &dst, &info) == 0);

    /* A zero lifetime withdraws the router. */
    len = make_ra(frame, mac_b, &router, 30, 0);
    ns_l2_input(a, frame, len);
    CHECK(ns_l2_route_lookup(a, &dst, &info) == 1);
    len = make_ra(frame, mac_b, &router, 0, 0);
    ns_l2_input(a, frame, len);
    CHECK(ns_l2_route_lookup(a, &dst, &info) == 0);

    /* An explicitly configured default route is not replaced by an RA and
       does not expire. */
    CHECK(ns_l2_add_route(a, &zero, 0, &router) == 0);
    len = make_ra(frame, mac_b, &router, 30, 0);
    ns_l2_input(a, frame, len);
    ns_l2_tick(a, 130000);
    CHECK(ns_l2_route_lookup(a, &dst, &info) == 1);
    CHECK(info.has_gateway == 1);

    /* Disabling discovery drops the link-local address and learned routes. */
    CHECK(ns_l2_del_route(a, &zero, 0) == 0);
    CHECK(ns_l2_set_router_discovery(a, 0) == 0);
    CHECK(ns_l2_link_local6(a) == NULL);
    CHECK(ns_l2_route_lookup(a, &dst, &info) == 0);

    ns_l2_free(a);
    ns_l2_free(b);
}

int main(void)
{
    test_arp_ipv4();
    test_ndp_ipv6();
    test_unresolved_timeout();
    test_local_delivery();
    test_broadcast_and_multicast();
    test_routing_table();
    test_router_discovery();

    if (failures) {
        fprintf(stderr, "netstack_l2: %d check(s) failed\n", failures);
        return 1;
    }
    printf("netstack_l2: all checks passed\n");
    return 0;
}
