/*
 * netstack prototype tests. Build with the netstack-test target.
 */
#include "../netstack.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;

#define CHECK(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
        failures++; \
    } \
} while (0)

typedef struct Link {
    NsStack *a;
    NsStack *b;
    int drop_next;
    int drop_synack;
    uint64_t now;
} Link;

static void link_send(NsStack *stack, const uint8_t *pkt, size_t len,
                      void *opaque)
{
    Link *l = opaque;
    NsStack *peer;

    if (l->drop_next > 0) {
        l->drop_next--;
        return;
    }
    if (l->drop_synack && len >= 54 &&
        (pkt[40 + 13] & 0x12) == 0x12) {
        l->drop_synack = 0;
        return;
    }
    peer = (stack == l->a) ? l->b : l->a;
    ns_input(peer, pkt, len);
}

/* Run both ends until they are idle, ticking timers while idle. */
static int pump(Link *l, int max_rounds)
{
    int round;

    for (round = 0; round < max_rounds; round++) {
        int na = ns_run(l->a, 64);
        int nb = ns_run(l->b, 64);
        if (na == 0 && nb == 0) {
            l->now += 50;
            ns_tick(l->a, l->now);
            ns_tick(l->b, l->now);
            na = ns_run(l->a, 64);
            nb = ns_run(l->b, 64);
            if (na == 0 && nb == 0)
                break;
        }
    }
    return round;
}

static const uint8_t prefix[NS_PREFIX_LEN] = {
    0xfd, 0x00, 0x51, 0x4e, 0x00, 0x00, 0x00, 0x00
};

static void make_pair(Link *l, int nshards)
{
    memset(l, 0, sizeof(*l));
    l->now = 1000;
    l->a = ns_stack_new(prefix, nshards, link_send, l);
    l->b = ns_stack_new(prefix, nshards, link_send, l);
    CHECK(l->a != NULL);
    CHECK(l->b != NULL);
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

/* Two plain-mode stacks with stable IPv4 addresses, mirroring how the
   node bridge configures the engine. */
static void make_plain_pair(Link *l, NsAddr *local_a, NsAddr *local_b)
{
    memset(l, 0, sizeof(*l));
    l->now = 1000;
    l->a = ns_stack_new(prefix, 1, link_send, l);
    l->b = ns_stack_new(prefix, 1, link_send, l);
    CHECK(l->a != NULL);
    CHECK(l->b != NULL);
    set_addr4(local_a, 10, 254, 0, 1);
    set_addr4(local_b, 10, 254, 0, 2);
    CHECK(ns_stack_set_plain(l->a, local_a) == 0);
    CHECK(ns_stack_set_plain(l->b, local_b) == 0);
    CHECK(ns_stack_local_family(l->a, NS_AF_INET) != NULL);
    CHECK(ns_stack_local_family(l->a, NS_AF_INET6) == NULL);
}

static void free_pair(Link *l)
{
    ns_stack_free(l->a);
    ns_stack_free(l->b);
    l->a = l->b = NULL;
}

static void test_addressing(void)
{
    NsStack *s = ns_stack_new(prefix, 8, NULL, NULL);
    NsAddr svc, a1, a2;
    char text[64];

    CHECK(s != NULL);
    ns_addr_service(s, 3, &svc);
    CHECK(ns_addr_shard(&svc) == 3);
    CHECK(svc.b[0] == 0xfd && svc.b[7] == 0x00);

    a1 = svc;
    a2 = svc;
    a1.b[15] = 1;
    a2.b[15] = 2;
    CHECK(ns_addr_shard(&a1) == 3);
    CHECK(ns_addr_shard(&a2) == 3);
    CHECK(memcmp(a1.b, a2.b, 16) != 0);

    ns_addr_format(&svc, text);
    CHECK(strstr(text, "fd00:514e") != NULL);

    CHECK(ns_stack_new(NULL, 1, NULL, NULL) == NULL);
    CHECK(ns_stack_new(prefix, 0, NULL, NULL) == NULL);
    CHECK(ns_stack_new(prefix, NS_MAX_SHARDS + 1, NULL, NULL) == NULL);
    ns_stack_free(s);
}

static void test_handshake_and_data(void)
{
    Link l;
    NsAddr service, cli_local, srv_local;
    NsAddr cli_remote;
    uint16_t cli_port, srv_port;
    uint64_t cid, sid;
    char buf[32];
    int n;

    make_pair(&l, 4);
    CHECK(ns_listen(l.b, 8080) == 0);
    CHECK(ns_listener_addr(l.b, 8080, 2, &service) == 0);
    CHECK(ns_addr_shard(&service) == 2);

    cid = ns_connect(l.a, 1, &service, 8080, 40000);
    CHECK(cid != 0);
    pump(&l, 20);

    CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
    CHECK(ns_accept(l.b, &sid) == 0);
    CHECK(ns_conn_state(l.b, sid) == NS_ESTABLISHED);

    CHECK(ns_conn_addr(l.b, sid, &srv_local, &srv_port,
                       NULL, NULL) == 0);
    CHECK(ns_conn_addr(l.a, cid, &cli_local, &cli_port,
                       &cli_remote, NULL) == 0);
    CHECK(ns_addr_shard(&srv_local) == 2);
    CHECK(!(srv_local.b[9] == 0 && srv_local.b[10] == 0 &&
            srv_local.b[11] == 0 && srv_local.b[12] == 0 &&
            srv_local.b[13] == 0 && srv_local.b[14] == 0 &&
            srv_local.b[15] == 0));
    CHECK(memcmp(&cli_remote.b, &srv_local.b, 16) == 0);
    CHECK(srv_port == 8080);
    CHECK(cli_port == 40000);

    CHECK(ns_send(l.a, cid, "hello", 5) == 5);
    pump(&l, 10);
    memset(buf, 0, sizeof(buf));
    n = ns_recv(l.b, sid, buf, sizeof(buf));
    CHECK(n == 5);
    CHECK(memcmp(buf, "hello", 5) == 0);

    CHECK(ns_send(l.b, sid, "world!", 6) == 6);
    pump(&l, 10);
    memset(buf, 0, sizeof(buf));
    n = ns_recv(l.a, cid, buf, sizeof(buf));
    CHECK(n == 6);
    CHECK(memcmp(buf, "world!", 6) == 0);

    CHECK(ns_close(l.a, cid) == 0);
    pump(&l, 20);
    CHECK(ns_conn_peer_closed(l.b, sid) == 1);
    CHECK(ns_recv(l.b, sid, buf, sizeof(buf)) == 0);
    CHECK(ns_close(l.b, sid) == 0);
    pump(&l, 20);
    CHECK(ns_conn_state(l.a, cid) == NS_CLOSED ||
          ns_conn_state(l.a, cid) == NS_TIME_WAIT);

    free_pair(&l);
}

static void test_retransmit(void)
{
    Link l;
    NsAddr service;
    uint64_t cid, sid;

    make_pair(&l, 2);
    CHECK(ns_listen(l.b, 9000) == 0);
    CHECK(ns_listener_addr(l.b, 9000, 0, &service) == 0);

    l.drop_next = 1; /* lose the initial SYN */
    cid = ns_connect(l.a, 0, &service, 9000, 41000);
    CHECK(cid != 0);
    pump(&l, 30);

    CHECK(ns_stats(l.a)->retransmits >= 1);
    CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
    CHECK(ns_accept(l.b, &sid) == 0);
    CHECK(ns_conn_state(l.b, sid) == NS_ESTABLISHED);

    free_pair(&l);
}

static void test_multi_shard(void)
{
    Link l;
    int shard;

    make_pair(&l, 6);
    CHECK(ns_listen(l.b, 7000) == 0);

    for (shard = 0; shard < 6; shard++) {
        NsAddr service, local;
        uint64_t cid, sid;

        CHECK(ns_listener_addr(l.b, 7000, shard, &service) == 0);
        CHECK(ns_addr_shard(&service) == shard);
        cid = ns_connect(l.a, shard, &service, 7000,
                         (uint16_t)(42000 + shard));
        CHECK(cid != 0);
        pump(&l, 20);
        CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
        CHECK(ns_accept(l.b, &sid) == 0);
        CHECK(ns_conn_addr(l.b, sid, &local, NULL, NULL, NULL) == 0);
        CHECK(ns_addr_shard(&local) == shard);
        ns_close(l.a, cid);
        pump(&l, 10);
        ns_close(l.b, sid);
        pump(&l, 10);
    }

    free_pair(&l);
}

/* ---------------- crafted packets for the dispatch test ---------------- */

static uint32_t tsum_add(uint32_t sum, const uint8_t *p, size_t len)
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

static uint16_t tsum_fold(uint32_t sum)
{
    while (sum >> 16)
        sum = (sum & 0xffff) + (sum >> 16);
    return (uint16_t)~sum;
}

static void craft_packet(uint8_t *pkt, int shard, uint16_t sport,
                         uint16_t dport, uint32_t seq)
{
    uint8_t *tcp = pkt + 40;
    uint32_t sum = 0;
    uint8_t tail[4] = { 0, 0, 0, 20 };

    memset(pkt, 0, 60);
    pkt[0] = 0x60;
    pkt[4] = 0;
    pkt[5] = 20;
    pkt[6] = 6;
    pkt[7] = 64;
    memcpy(pkt + 8, prefix, 8);
    pkt[8 + 8] = (uint8_t)shard;       /* source shard */
    pkt[15] = 1;
    memcpy(pkt + 24, prefix, 8);
    pkt[24 + 8] = (uint8_t)shard;      /* destination shard */
    pkt[24 + 15] = 2;
    pkt[40] = (uint8_t)(sport >> 8);
    pkt[41] = (uint8_t)sport;
    pkt[42] = (uint8_t)(dport >> 8);
    pkt[43] = (uint8_t)dport;
    pkt[44] = (uint8_t)(seq >> 24);
    pkt[45] = (uint8_t)(seq >> 16);
    pkt[46] = (uint8_t)(seq >> 8);
    pkt[47] = (uint8_t)seq;
    pkt[52] = 5 << 4;
    pkt[53] = 0x10; /* ACK, no matching connection: just gets counted */
    pkt[54] = 0xff;
    pkt[55] = 0xff;

    sum = tsum_add(sum, pkt + 8, 16);
    sum = tsum_add(sum, pkt + 24, 16);
    sum = tsum_add(sum, tail, 4);
    sum = tsum_add(sum, (const uint8_t[]){ 0, 0, 0, 6 }, 4);
    sum = tsum_add(sum, tcp, 20);
    uint16_t csum = tsum_fold(sum);
    tcp[16] = (uint8_t)(csum >> 8);
    tcp[17] = (uint8_t)csum;
}

static void test_interleaved_dispatch(void)
{
    Link l;
    uint8_t pkt[60];
    const uint8_t *log;
    int len, i;

    make_pair(&l, 4);

    /* Three packets for shard 0, one each for shards 1 and 2. */
    for (i = 0; i < 3; i++) {
        craft_packet(pkt, 0, (uint16_t)(50000 + i), 1234, 1);
        ns_input(l.b, pkt, sizeof(pkt));
    }
    craft_packet(pkt, 1, 50010, 1234, 1);
    ns_input(l.b, pkt, sizeof(pkt));
    craft_packet(pkt, 2, 50011, 1234, 1);
    ns_input(l.b, pkt, sizeof(pkt));

    CHECK(ns_shard_pending(l.b, 0) == 3);
    CHECK(ns_shard_pending(l.b, 1) == 1);
    CHECK(ns_shard_pending(l.b, 2) == 1);

    ns_dispatch_log_clear(l.b);
    CHECK(ns_run(l.b, 3) == 3);
    log = ns_dispatch_log(l.b, &len);
    CHECK(len == 3);
    /* One packet from each non-empty shard per round. */
    CHECK(log[0] == 0 && log[1] == 1 && log[2] == 2);
    CHECK(ns_shard_pending(l.b, 0) == 2);
    CHECK(ns_shard_pending(l.b, 1) == 0);
    CHECK(ns_shard_pending(l.b, 2) == 0);

    CHECK(ns_run(l.b, 8) == 2);
    CHECK(ns_shard_pending(l.b, 0) == 0);

    /* Queues for out-of-range shards are rejected before dispatch. */
    craft_packet(pkt, 3, 50020, 1234, 1);
    ns_input(l.b, pkt, sizeof(pkt));
    CHECK(ns_shard_pending(l.b, 3) == 1);
    CHECK(ns_run(l.b, 1) == 1);

    free_pair(&l);
}

static void test_large_transfer(void)
{
    Link l;
    NsAddr service;
    uint64_t cid, sid;
    uint8_t *out;
    uint8_t *in;
    size_t total = 5000;
    size_t got = 0;
    size_t i;
    int n;

    make_pair(&l, 3);
    CHECK(ns_listen(l.b, 9100) == 0);
    CHECK(ns_listener_addr(l.b, 9100, 1, &service) == 0);

    cid = ns_connect(l.a, 0, &service, 9100, 41001);
    CHECK(cid != 0);
    pump(&l, 20);
    CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
    CHECK(ns_accept(l.b, &sid) == 0);

    out = malloc(total);
    in = malloc(total);
    CHECK(out != NULL && in != NULL);
    for (i = 0; i < total; i++)
        out[i] = (uint8_t)(i * 31 + 7);

    CHECK(ns_send(l.a, cid, out, total) == (int)total);
    pump(&l, 20);
    while (got < total) {
        n = ns_recv(l.b, sid, in + got, total - got);
        CHECK(n > 0);
        if (n <= 0)
            break;
        got += (size_t)n;
    }
    CHECK(got == total);
    CHECK(memcmp(out, in, total) == 0);

    free(out);
    free(in);
    free_pair(&l);
}

static void test_retransmit_synack(void)
{
    Link l;
    NsAddr service;
    uint64_t cid, sid;

    make_pair(&l, 2);
    CHECK(ns_listen(l.b, 9200) == 0);
    CHECK(ns_listener_addr(l.b, 9200, 1, &service) == 0);

    l.drop_synack = 1;
    cid = ns_connect(l.a, 1, &service, 9200, 41002);
    CHECK(cid != 0);
    pump(&l, 40);

    CHECK(ns_stats(l.a)->retransmits >= 1);
    CHECK(ns_stats(l.b)->retransmits >= 1);
    CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
    CHECK(ns_accept(l.b, &sid) == 0);

    free_pair(&l);
}

static void test_unique_connection_addresses(void)
{
    Link l;
    NsAddr seen[16];
    int i, j;

    make_pair(&l, 4);
    CHECK(ns_listen(l.b, 7300) == 0);

    for (i = 0; i < 16; i++) {
        NsAddr service, local;
        uint64_t cid, sid;

        CHECK(ns_listener_addr(l.b, 7300, i % 4, &service) == 0);
        cid = ns_connect(l.a, i % 4, &service, 7300,
                         (uint16_t)(43000 + i));
        CHECK(cid != 0);
        pump(&l, 20);
        CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
        CHECK(ns_accept(l.b, &sid) == 0);
        CHECK(ns_conn_addr(l.b, sid, &local, NULL, NULL, NULL) == 0);
        CHECK(ns_addr_shard(&local) == i % 4);
        for (j = 0; j < i; j++)
            CHECK(memcmp(&seen[j].b, &local.b, 16) != 0);
        seen[i] = local;
        ns_close(l.a, cid);
        pump(&l, 10);
        ns_close(l.b, sid);
        pump(&l, 10);
    }

    free_pair(&l);
}

static void test_listener_validation(void)
{
    Link l;

    make_pair(&l, 2);
    CHECK(ns_listen(l.b, 0) < 0);
    CHECK(ns_listen(l.b, 80) == 0);
    CHECK(ns_listen(l.b, 80) < 0);
    CHECK(ns_listener_addr(l.b, 81, 0, NULL) < 0);
    CHECK(ns_listener_addr(l.b, 80, 2, NULL) < 0);
    free_pair(&l);
}

static void test_ipv4_plain(void)
{
    Link l;
    NsAddr local_a, local_b;
    NsAddr conn_local, conn_remote;
    uint16_t lport = 0, rport = 0;
    uint64_t cid, sid;
    char buf[32];
    char text[64];
    int n;

    make_plain_pair(&l, &local_a, &local_b);
    CHECK(ns_stack_is_plain(l.a));
    CHECK(ns_listen_addr(l.b, &local_b, 8080) == 0);

    cid = ns_connect_from(l.a, &local_a, 40000, &local_b, 8080);
    CHECK(cid != 0);
    pump(&l, 20);
    CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
    CHECK(ns_accept_port(l.b, 8080, &sid) == 0);
    CHECK(ns_conn_state(l.b, sid) == NS_ESTABLISHED);

    CHECK(ns_conn_addr(l.a, cid, &conn_local, &lport,
                       &conn_remote, &rport) == 0);
    CHECK(conn_local.family == NS_AF_INET);
    CHECK(conn_local.b[0] == 10 && conn_local.b[3] == 1);
    CHECK(conn_remote.family == NS_AF_INET);
    CHECK(conn_remote.b[0] == 10 && conn_remote.b[3] == 2);
    CHECK(lport == 40000 && rport == 8080);
    ns_addr_format(&conn_remote, text);
    CHECK(strcmp(text, "10.254.0.2") == 0);

    CHECK(ns_send(l.a, cid, "v4 hello", 8) == 8);
    pump(&l, 10);
    memset(buf, 0, sizeof(buf));
    n = ns_recv(l.b, sid, buf, sizeof(buf));
    CHECK(n == 8);
    CHECK(memcmp(buf, "v4 hello", 8) == 0);

    CHECK(ns_send(l.b, sid, "v4 world", 8) == 8);
    pump(&l, 10);
    memset(buf, 0, sizeof(buf));
    n = ns_recv(l.a, cid, buf, sizeof(buf));
    CHECK(n == 8);
    CHECK(memcmp(buf, "v4 world", 8) == 0);

    ns_close(l.a, cid);
    pump(&l, 20);
    CHECK(ns_conn_peer_closed(l.b, sid) == 1);
    ns_close(l.b, sid);
    pump(&l, 20);

    /* ns_connect() uses the stack's stable IPv4 address as the source. */
    cid = ns_connect(l.a, 0, &local_b, 8080, 40001);
    CHECK(cid != 0);
    pump(&l, 20);
    CHECK(ns_conn_state(l.a, cid) == NS_ESTABLISHED);
    CHECK(ns_accept_port(l.b, 8080, &sid) == 0);
    CHECK(ns_conn_addr(l.a, cid, &conn_local, NULL, NULL, NULL) == 0);
    CHECK(conn_local.family == NS_AF_INET);
    CHECK(conn_local.b[0] == 10 && conn_local.b[3] == 1);
    ns_close(l.a, cid);
    pump(&l, 10);
    ns_close(l.b, sid);
    pump(&l, 10);

    free_pair(&l);
}

int main(void)
{
    test_addressing();
    test_handshake_and_data();
    test_retransmit();
    test_retransmit_synack();
    test_large_transfer();
    test_multi_shard();
    test_unique_connection_addresses();
    test_interleaved_dispatch();
    test_listener_validation();
    test_ipv4_plain();

    if (failures) {
        fprintf(stderr, "netstack: %d check(s) failed\n", failures);
        return 1;
    }
    printf("netstack: all checks passed\n");
    return 0;
}
