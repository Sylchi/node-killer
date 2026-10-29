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

int main(void)
{
    test_arp_ipv4();
    test_ndp_ipv6();
    test_unresolved_timeout();
    test_local_delivery();
    test_broadcast_and_multicast();

    if (failures) {
        fprintf(stderr, "netstack_l2: %d check(s) failed\n", failures);
        return 1;
    }
    printf("netstack_l2: all checks passed\n");
    return 0;
}
