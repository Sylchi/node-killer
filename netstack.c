/*
 * netstack - an in-process TCP/IP stack with IPv6 shard dispatch.
 *
 * Prototype scope and the addressing model are described in docs/netstack.md.
 * IPv4 and IPv6 share the TCP state machine; the IP header encode/decode and
 * pseudo-header checksum are selected from the NsAddr family.
 */
#include "netstack.h"

#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NS_IPV4_HDR 20
#define NS_IPV6_HDR 40
#define NS_TCP_HDR 20
#define NS_UDP_HDR 8
#define NS_ICMP_HDR 8
#define NS_MTU 1500
#define NS_MSS 1400
#define NS_RTO_MS 200
#define NS_MAX_RETRIES 6
#define NS_TIME_WAIT_MS 5000
#define NS_QUEUE_MAX 4096
#define NS_DISPATCH_LOG_MAX 256

/* Reassembly and path-MTU limits. A full datagram is at most 65535 bytes;
   the bitmap tracks which of those bytes have arrived. */
#define NS_REASM_MAX 8
#define NS_REASM_TIMEOUT_MS 30000
#define NS_REASM_MAX_LEN 65535
#define NS_REASM_BITMAP ((NS_REASM_MAX_LEN + 7) / 8)
#define NS_PMTU_ENTRIES 32
#define NS_PMTU_LIFETIME_MS 600000
#define NS_PMTU_V4_MIN 68
#define NS_PMTU_V6_MIN 1280
#define NS_MAX_IP_PACKET 65535

#define NS_TCP_FIN 0x01
#define NS_TCP_SYN 0x02
#define NS_TCP_RST 0x04
#define NS_TCP_PSH 0x08
#define NS_TCP_ACK 0x10

typedef struct NsPacket {
    struct NsPacket *next;
    uint32_t len;
    uint8_t data[];
} NsPacket;

typedef struct NsSeg {
    struct NsSeg *next;
    uint32_t seq;
    uint32_t len;      /* payload length */
    uint32_t seq_len;  /* sequence space consumed (payload or FIN) */
    uint64_t deadline;
    int retries;
    uint8_t flags;
    uint8_t data[];
} NsSeg;

typedef struct NsConn {
    struct NsConn *next;
    struct NsConn *accept_next;
    struct NsShard *shard;
    uint64_t id;
    uint64_t time_wait_at;
    uint64_t closed_at;
    uint8_t state;
    uint8_t accepted;
    uint8_t peer_closed;
    uint8_t local_closed;
    NsAddr local;
    NsAddr remote;
    uint16_t lport;
    uint16_t rport;
    uint32_t iss;
    uint32_t snd_una;
    uint32_t snd_nxt;
    uint32_t rcv_nxt;
    uint16_t rcv_wnd;
    uint8_t *rbuf;
    size_t rcap;
    size_t rhead;
    size_t rlen;
    NsSeg *tx_head;
    NsSeg *tx_tail;
} NsConn;

typedef struct NsShard {
    NsStack *stack;
    int index;
    NsConn *conns;
    NsConn *accept_head;
    NsConn *accept_tail;
    NsPacket *qhead;
    NsPacket *qtail;
    int qlen;
    uint64_t next_conn_seq;
    uint64_t next_slot;
    uint16_t next_port;
} NsShard;

typedef struct NsDgram {
    struct NsDgram *next;
    NsAddr src;
    uint16_t sport;
    uint16_t len;
    uint8_t data[];
} NsDgram;

typedef struct NsUdp {
    struct NsUdp *next;
    uint64_t id;
    NsAddr local;
    NsAddr remote;
    uint16_t lport;
    uint16_t rport;
    uint8_t has_local;
    uint8_t connected;
    uint8_t reuse;
    NsDgram *qhead;
    NsDgram *qtail;
    int qlen;
    size_t qbytes;
} NsUdp;

typedef struct NsListener {
    NsAddr addr;
    uint16_t port;
    int has_addr;
} NsListener;

/* One partially reassembled datagram. The key is family, source, destination,
   upper-layer protocol and identification. */
typedef struct NsReasm {
    struct NsReasm *next;
    NsAddr src;
    NsAddr dst;
    uint32_t id;
    uint64_t expires;
    size_t total;    /* upper-layer length, known once the last fragment lands */
    size_t have;     /* unique payload bytes received */
    uint8_t family;
    uint8_t proto;
    uint8_t has_hdr;
    uint8_t hdr_len;
    uint8_t hdr[60]; /* IPv4 header (with options) or IPv6 base header */
    uint8_t *data;
    uint8_t *bitmap;
} NsReasm;

typedef struct NsPmtu {
    NsAddr dst;
    uint64_t expires;
    uint16_t mtu;
    uint8_t valid;
} NsPmtu;

struct NsStack {
    uint8_t prefix[NS_PREFIX_LEN];
    int nshards;
    NsShard shards[NS_MAX_SHARDS];
    NsLinkSendFn send;
    void *opaque;
    NsListener listeners[NS_MAX_LISTENERS];
    int nlisteners;
    NsUdp *udp;
    int nudp;
    uint64_t next_udp_seq;
    uint16_t next_udp_port;
    int plain;
    NsAddr plain_addr4;
    NsAddr plain_addr6;
    int has_plain4;
    int has_plain6;
    uint16_t ip_id;
    uint32_t ip6_id;
    NsReasm *reasm;
    int nreasm;
    NsPmtu pmtu[NS_PMTU_ENTRIES];
    uint64_t clock;
    uint32_t rnd;
    NsStats stats;
    uint8_t dispatch_log[NS_DISPATCH_LOG_MAX];
    int dispatch_log_len;
};

static void udp_free(NsUdp *u);
static void reasm_destroy(NsStack *s, NsReasm *e);
static void reasm_add(NsStack *s, int family, const NsAddr *src,
                      const NsAddr *dst, uint8_t proto, uint32_t id,
                      size_t off, int more, const uint8_t *hdr,
                      size_t hdr_len, const uint8_t *data, size_t len);
static void ip_dispatch(NsStack *s, const uint8_t *pkt, size_t len, int family,
                        size_t ip_hdr, uint8_t proto);
static int ip_emit(NsStack *s, const NsAddr *src, const NsAddr *dst,
                   uint8_t proto, const uint8_t *l4, size_t l4_len);

/* ---------------- byte order and checksums ---------------- */

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

static uint16_t l4_checksum(const uint8_t *src, const uint8_t *dst,
                            int family, uint8_t proto, const uint8_t *seg,
                            size_t seg_len)
{
    uint32_t sum = 0;

    if (family == NS_AF_INET) {
        uint8_t pseudo[12];
        memcpy(pseudo, src, 4);
        memcpy(pseudo + 4, dst, 4);
        pseudo[8] = 0;
        pseudo[9] = proto;
        wr16(pseudo + 10, (uint16_t)seg_len);
        sum = csum_add(sum, pseudo, sizeof(pseudo));
    } else {
        uint8_t tail[4];
        uint8_t next[4] = { 0, 0, 0, proto };
        sum = csum_add(sum, src, 16);
        sum = csum_add(sum, dst, 16);
        wr32(tail, (uint32_t)seg_len);
        sum = csum_add(sum, tail, sizeof(tail));
        sum = csum_add(sum, next, sizeof(next));
    }
    sum = csum_add(sum, seg, seg_len);
    return csum_fold(sum);
}

static uint16_t tcp_checksum(const uint8_t *src, const uint8_t *dst,
                             int family, const uint8_t *tcp, size_t tcp_len)
{
    return l4_checksum(src, dst, family, 6, tcp, tcp_len);
}

/* A computed zero is transmitted as 0xffff: zero means "no checksum" in
   IPv4 and is invalid in IPv6. */
static uint16_t udp_checksum(const uint8_t *src, const uint8_t *dst,
                             int family, const uint8_t *udp, size_t udp_len)
{
    uint16_t c = l4_checksum(src, dst, family, 17, udp, udp_len);
    return c ? c : 0xffff;
}

static uint16_t ipv4_checksum(const uint8_t *hdr, size_t len)
{
    return csum_fold(csum_add(0, hdr, len));
}

static int seq_lt(uint32_t a, uint32_t b)
{
    return (int32_t)(a - b) < 0;
}

static int seq_le(uint32_t a, uint32_t b)
{
    return (int32_t)(a - b) <= 0;
}

/* ---------------- addresses ---------------- */

static void shard_alloc_addr(NsShard *sh, NsAddr *out)
{
    uint64_t slot = sh->next_slot++;
    int i;

    memset(out, 0, sizeof(*out));
    out->family = NS_AF_INET6;
    memcpy(out->b, sh->stack->prefix, NS_PREFIX_LEN);
    out->b[8] = (uint8_t)sh->index;
    for (i = 0; i < 7; i++) {
        out->b[15 - i] = (uint8_t)(slot >> (i * 8));
    }
}

void ns_addr_service(const NsStack *s, int shard, NsAddr *out)
{
    memset(out, 0, sizeof(*out));
    out->family = NS_AF_INET6;
    memcpy(out->b, s->prefix, NS_PREFIX_LEN);
    out->b[8] = (uint8_t)shard;
}

int ns_addr_shard(const NsAddr *a)
{
    if (!a || a->family == NS_AF_INET)
        return 0;
    return a->b[8];
}

int ns_addr_family(const NsAddr *a)
{
    if (!a || a->family == NS_AF_UNSPEC)
        return NS_AF_INET6;
    return a->family;
}

void ns_addr_format(const NsAddr *a, char out[64])
{
    int family = ns_addr_family(a);
    if (!a) {
        snprintf(out, 64, "<invalid>");
        return;
    }
    if (family == NS_AF_INET) {
        if (!inet_ntop(AF_INET, a->b, out, 64))
            snprintf(out, 64, "<invalid>");
        return;
    }
    if (!inet_ntop(AF_INET6, a->b, out, 64))
        snprintf(out, 64, "<invalid>");
}

static int addr_eq(const NsAddr *a, const NsAddr *b)
{
    return ns_addr_family(a) == ns_addr_family(b) &&
           memcmp(a->b, b->b, sizeof(a->b)) == 0;
}

static int addr_unspecified(const NsAddr *a)
{
    int i;
    for (i = 0; i < NS_ADDR_LEN; i++)
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

static int addr_broadcast(const NsAddr *a)
{
    return ns_addr_family(a) == NS_AF_INET &&
           a->b[0] == 255 && a->b[1] == 255 && a->b[2] == 255 &&
           a->b[3] == 255;
}

static int is_service_addr(const NsAddr *a)
{
    int i;
    if (ns_addr_family(a) != NS_AF_INET6)
        return 0;
    for (i = 9; i < 16; i++)
        if (a->b[i] != 0)
            return 0;
    return 1;
}

/* ---------------- path MTU ---------------- */

static uint16_t pmtu_clamp(int family, uint32_t mtu)
{
    uint32_t min = family == NS_AF_INET ? NS_PMTU_V4_MIN : NS_PMTU_V6_MIN;

    if (mtu < min)
        mtu = min;
    if (mtu > NS_MTU)
        mtu = NS_MTU;
    return (uint16_t)mtu;
}

static NsPmtu *pmtu_find(NsStack *s, const NsAddr *dst)
{
    int i;

    for (i = 0; i < NS_PMTU_ENTRIES; i++)
        if (s->pmtu[i].valid && addr_eq(&s->pmtu[i].dst, dst))
            return &s->pmtu[i];
    return NULL;
}

static uint16_t pmtu_lookup(NsStack *s, const NsAddr *dst)
{
    NsPmtu *e = pmtu_find(s, dst);

    return e ? e->mtu : NS_MTU;
}

/* Record a path MTU. ICMP errors pass lower_only so a stale error cannot
   undo a newer, smaller value; the public API replaces the entry. */
static void pmtu_note(NsStack *s, const NsAddr *dst, uint32_t mtu,
                      int lower_only)
{
    NsPmtu *e = pmtu_find(s, dst);
    NsPmtu *slot = e;
    uint16_t value;
    int i;

    if (!dst || addr_unspecified(dst))
        return;
    value = pmtu_clamp(ns_addr_family(dst), mtu);
    if (slot) {
        if (lower_only && value >= slot->mtu)
            return;
        if (slot->mtu != value)
            s->stats.pmtu_updates++;
        slot->mtu = value;
        slot->expires = s->clock + NS_PMTU_LIFETIME_MS;
        return;
    }
    for (i = 0; i < NS_PMTU_ENTRIES; i++) {
        if (!s->pmtu[i].valid) {
            slot = &s->pmtu[i];
            break;
        }
        if (!slot || s->pmtu[i].expires < slot->expires)
            slot = &s->pmtu[i];
    }
    if (!slot)
        return;
    slot->dst = *dst;
    slot->dst.family = (uint8_t)ns_addr_family(dst);
    slot->mtu = value;
    slot->expires = s->clock + NS_PMTU_LIFETIME_MS;
    slot->valid = 1;
    s->stats.pmtu_updates++;
}

/* ---------------- stack and shard lifecycle ---------------- */

NsStack *ns_stack_new(const uint8_t prefix[NS_PREFIX_LEN], int nshards,
                      NsLinkSendFn send, void *opaque)
{
    NsStack *s;
    int i;

    if (!prefix || nshards < 1 || nshards > NS_MAX_SHARDS)
        return NULL;
    s = calloc(1, sizeof(*s));
    if (!s)
        return NULL;
    memcpy(s->prefix, prefix, NS_PREFIX_LEN);
    s->nshards = nshards;
    s->send = send;
    s->opaque = opaque;
    s->clock = 1;
    s->rnd = 0x9e3779b9u ^ (uint32_t)nshards;
    s->next_udp_port = (uint16_t)(49152 + nshards * 31);
    for (i = 0; i < nshards; i++) {
        s->shards[i].stack = s;
        s->shards[i].index = i;
        s->shards[i].next_slot = 1; /* slot 0 is the service address */
        s->shards[i].next_port = (uint16_t)(49152 + i * 97);
    }
    return s;
}

static void conn_free(NsConn *c)
{
    NsSeg *seg = c->tx_head;
    while (seg) {
        NsSeg *next = seg->next;
        free(seg);
        seg = next;
    }
    free(c->rbuf);
    free(c);
}

void ns_stack_free(NsStack *s)
{
    int i;
    if (!s)
        return;
    for (i = 0; i < s->nshards; i++) {
        NsPacket *p = s->shards[i].qhead;
        while (p) {
            NsPacket *next = p->next;
            free(p);
            p = next;
        }
        NsConn *c = s->shards[i].conns;
        while (c) {
            NsConn *next = c->next;
            conn_free(c);
            c = next;
        }
    }
    {
        NsUdp *u = s->udp;
        while (u) {
            NsUdp *next = u->next;
            udp_free(u);
            u = next;
        }
    }
    while (s->reasm)
        reasm_destroy(s, s->reasm);
    free(s);
}

void ns_stack_set_send(NsStack *s, NsLinkSendFn send, void *opaque)
{
    if (!s)
        return;
    s->send = send;
    s->opaque = opaque;
}

/* ---------------- plain mode ---------------- */

static NsAddr *plain_slot(NsStack *s, int family)
{
    if (family == NS_AF_INET)
        return &s->plain_addr4;
    if (family == NS_AF_INET6)
        return &s->plain_addr6;
    return NULL;
}

int ns_stack_set_plain(NsStack *s, const NsAddr *local)
{
    NsAddr *slot;
    int family = ns_addr_family(local);

    if (!s || !local)
        return -NS_EINVAL;
    slot = plain_slot(s, family);
    if (!slot)
        return -NS_EINVAL;
    s->plain = 1;
    *slot = *local;
    slot->family = (uint8_t)family;
    if (family == NS_AF_INET)
        s->has_plain4 = 1;
    else
        s->has_plain6 = 1;
    return 0;
}

int ns_stack_is_plain(const NsStack *s)
{
    return s ? s->plain : 0;
}

const NsAddr *ns_stack_local_family(const NsStack *s, int family)
{
    if (!s)
        return NULL;
    if (family == NS_AF_INET)
        return s->has_plain4 ? &s->plain_addr4 : NULL;
    if (family == NS_AF_INET6)
        return s->has_plain6 ? &s->plain_addr6 : NULL;
    return NULL;
}

const NsAddr *ns_stack_local(const NsStack *s)
{
    const NsAddr *a;
    if (!s)
        return NULL;
    a = ns_stack_local_family(s, NS_AF_INET6);
    return a ? a : ns_stack_local_family(s, NS_AF_INET);
}

/* ---------------- listeners ---------------- */

static int listener_match(const NsStack *s, const NsListener *l,
                          const NsAddr *dst, uint16_t port)
{
    if (l->port != port)
        return 0;
    if (l->has_addr)
        return addr_eq(&l->addr, dst);
    if (s->plain) {
        const NsAddr *local =
            ns_stack_local_family(s, ns_addr_family(dst));
        return local && addr_eq(local, dst);
    }
    return is_service_addr(dst);
}

static int find_listener_at(const NsStack *s, const NsAddr *dst,
                            uint16_t port)
{
    int i;
    for (i = 0; i < s->nlisteners; i++)
        if (listener_match(s, &s->listeners[i], dst, port))
            return i;
    return -1;
}

static int find_listener_port(const NsStack *s, uint16_t port)
{
    int i;
    for (i = 0; i < s->nlisteners; i++)
        if (s->listeners[i].port == port)
            return i;
    return -1;
}

int ns_listen(NsStack *s, uint16_t port)
{
    return ns_listen_addr(s, NULL, port);
}

int ns_listen_addr(NsStack *s, const NsAddr *local, uint16_t port)
{
    NsListener *l;

    if (!s || port == 0 || s->nlisteners >= NS_MAX_LISTENERS)
        return -NS_EINVAL;
    if (find_listener_port(s, port) >= 0)
        return -NS_EINVAL;
    l = &s->listeners[s->nlisteners++];
    l->port = port;
    l->has_addr = local != NULL;
    if (local)
        l->addr = *local;
    else
        memset(&l->addr, 0, sizeof(l->addr));
    return 0;
}

/* Register a listener for an ephemeral port and report the chosen port.
   Ports in the ephemeral range are scanned upward from a per-stack cursor. */
int ns_listen_port(NsStack *s, uint16_t port, uint16_t *out_port)
{
    return ns_listen_port_ex(s, NULL, port, out_port);
}

int ns_listen_port_ex(NsStack *s, const NsAddr *local, uint16_t port,
                      uint16_t *out_port)
{
    uint16_t p;
    int err;

    if (!s || !out_port)
        return -NS_EINVAL;
    if (port != 0)
        return ns_listen_addr(s, local, port);
    p = s->shards[0].next_port;
    for (;;) {
        err = ns_listen_addr(s, local, p);
        if (err == 0) {
            s->shards[0].next_port = p + 1;
            *out_port = p;
            return 0;
        }
        p++;
        if (p == 0)
            return -NS_EINVAL;
    }
}

int ns_unlisten(NsStack *s, uint16_t port)
{
    int i;
    if (!s)
        return -NS_EINVAL;
    for (i = 0; i < s->nlisteners; i++) {
        if (s->listeners[i].port != port)
            continue;
        memmove(&s->listeners[i], &s->listeners[i + 1],
                (size_t)(s->nlisteners - i - 1) * sizeof(s->listeners[0]));
        s->nlisteners--;
        return 0;
    }
    return -NS_EINVAL;
}

int ns_listener_addr(const NsStack *s, uint16_t port, int shard, NsAddr *out)
{
    int i;

    if (!s || !out || shard < 0 || shard >= s->nshards)
        return -NS_EINVAL;
    i = find_listener_port(s, port);
    if (i < 0)
        return -NS_EINVAL;
    if (s->plain) {
        const NsAddr *local;
        if (s->listeners[i].has_addr) {
            *out = s->listeners[i].addr;
            return 0;
        }
        local = ns_stack_local(s);
        if (!local)
            return -NS_EINVAL;
        *out = *local;
    } else {
        ns_addr_service(s, shard, out);
    }
    return 0;
}

/* ---------------- connection helpers ---------------- */

static uint32_t ns_rand(NsStack *s)
{
    s->rnd = s->rnd * 1664525u + 1013904223u;
    return s->rnd;
}

static NsConn *conn_new(NsShard *sh, uint8_t state)
{
    NsConn *c = calloc(1, sizeof(*c));
    if (!c)
        return NULL;
    c->rbuf = malloc(NS_RCVBUF_SIZE);
    if (!c->rbuf) {
        free(c);
        return NULL;
    }
    c->rcap = NS_RCVBUF_SIZE;
    c->shard = sh;
    c->state = state;
    c->rcv_wnd = 65535;
    c->id = ((uint64_t)(sh->index + 1) << 32) | (++sh->next_conn_seq);
    c->next = sh->conns;
    sh->conns = c;
    return c;
}

static NsConn *conn_by_id(NsStack *s, uint64_t id)
{
    uint32_t shard_no = (uint32_t)(id >> 32);
    NsConn *c;

    if (!s || shard_no == 0 || shard_no > (uint32_t)s->nshards)
        return NULL;
    for (c = s->shards[shard_no - 1].conns; c; c = c->next)
        if (c->id == id)
            return c;
    return NULL;
}

static NsConn *conn_find(NsShard *sh, const NsAddr *la, uint16_t lp,
                         const NsAddr *ra, uint16_t rp)
{
    NsConn *c;
    for (c = sh->conns; c; c = c->next)
        if (c->lport == lp && c->rport == rp &&
            addr_eq(&c->local, la) && addr_eq(&c->remote, ra))
            return c;
    return NULL;
}

static NsConn *conn_find_pending(NsShard *sh, const NsAddr *la, uint16_t lp,
                                 uint16_t rp)
{
    NsConn *c;
    for (c = sh->conns; c; c = c->next)
        if (c->state == NS_SYN_SENT && c->lport == lp && c->rport == rp &&
            addr_eq(&c->local, la))
            return c;
    return NULL;
}

static void accept_push(NsShard *sh, NsConn *c)
{
    if (c->accepted)
        return;
    c->accept_next = NULL;
    if (sh->accept_tail)
        sh->accept_tail->accept_next = c;
    else
        sh->accept_head = c;
    sh->accept_tail = c;
}

static void accept_remove(NsShard *sh, NsConn *c)
{
    NsConn **pp = &sh->accept_head;
    NsConn *prev = NULL;

    while (*pp) {
        if (*pp == c) {
            *pp = c->accept_next;
            if (sh->accept_tail == c)
                sh->accept_tail = prev;
            return;
        }
        prev = *pp;
        pp = &(*pp)->accept_next;
    }
}

/* ---------------- IP output, fragmentation and PMTU ---------------- */

static void ipv4_send_one(NsStack *s, const NsAddr *src, const NsAddr *dst,
                          uint8_t proto, uint16_t id, size_t off, int mf,
                          int df, const uint8_t *payload, size_t plen)
{
    uint8_t pkt[NS_MTU];
    size_t total = NS_IPV4_HDR + plen;
    uint16_t frag;

    memset(pkt, 0, NS_IPV4_HDR);
    pkt[0] = 0x45;
    wr16(pkt + 2, (uint16_t)total);
    wr16(pkt + 4, id);
    frag = (uint16_t)((df ? 0x4000 : 0) | (mf ? 0x2000 : 0) |
                      ((off / 8) & 0x1fff));
    wr16(pkt + 6, frag);
    pkt[8] = 64; /* TTL */
    pkt[9] = proto;
    memcpy(pkt + 12, src->b, 4);
    memcpy(pkt + 16, dst->b, 4);
    wr16(pkt + 10, ipv4_checksum(pkt, NS_IPV4_HDR));
    if (plen)
        memcpy(pkt + NS_IPV4_HDR, payload, plen);

    s->stats.tx_packets++;
    if (mf || off)
        s->stats.fragments_tx++;
    s->send(s, pkt, total, s->opaque);
}

static void ipv6_send_one(NsStack *s, const NsAddr *src, const NsAddr *dst,
                          uint8_t proto, uint32_t id, size_t off, int mf,
                          int with_frag, const uint8_t *payload, size_t plen)
{
    uint8_t pkt[NS_MTU];
    size_t hdr = with_frag ? NS_IPV6_HDR + 8 : NS_IPV6_HDR;
    size_t body = with_frag ? 8 + plen : plen;

    memset(pkt, 0, NS_IPV6_HDR);
    pkt[0] = 0x60;
    wr16(pkt + 4, (uint16_t)body);
    pkt[6] = with_frag ? 44 : proto;
    pkt[7] = 64; /* hop limit */
    memcpy(pkt + 8, src->b, 16);
    memcpy(pkt + 24, dst->b, 16);
    if (with_frag) {
        pkt[40] = proto;
        pkt[41] = 0;
        wr16(pkt + 42, (uint16_t)((off & 0xfff8) | (mf ? 1 : 0)));
        wr32(pkt + 44, id);
    }
    if (plen)
        memcpy(pkt + hdr, payload, plen);

    s->stats.tx_packets++;
    if (with_frag)
        s->stats.fragments_tx++;
    s->send(s, pkt, NS_IPV6_HDR + body, s->opaque);
}

/* Emit one upper-layer segment, fragmenting it to the path MTU. The L4
   checksum is computed by the caller over the whole segment, so fragments
   are plain byte slices of it. */
static int ip_emit(NsStack *s, const NsAddr *src, const NsAddr *dst,
                   uint8_t proto, const uint8_t *l4, size_t l4_len)
{
    int family = ns_addr_family(dst);
    size_t ip_hdr = family == NS_AF_INET ? NS_IPV4_HDR : NS_IPV6_HDR;
    size_t total = ip_hdr + l4_len;
    size_t max_data;
    size_t off;
    uint16_t pmtu;

    if (!s->send || family != ns_addr_family(src))
        return -NS_EMSGSIZE;
    if (family == NS_AF_INET) {
        if (total > NS_MAX_IP_PACKET)
            return -NS_EMSGSIZE;
    } else if (l4_len > NS_MAX_IP_PACKET) {
        return -NS_EMSGSIZE;
    }

    pmtu = pmtu_lookup(s, dst);
    if (total <= pmtu) {
        if (family == NS_AF_INET)
            ipv4_send_one(s, src, dst, proto, ++s->ip_id, 0, 0, 1, l4,
                          l4_len);
        else
            ipv6_send_one(s, src, dst, proto, ++s->ip6_id, 0, 0, 0, l4,
                          l4_len);
        return 0;
    }

    if (family == NS_AF_INET) {
        uint16_t id;

        if (pmtu <= NS_IPV4_HDR)
            return -NS_EMSGSIZE;
        max_data = ((size_t)(pmtu - NS_IPV4_HDR) / 8) * 8;
        if (max_data < 8)
            return -NS_EMSGSIZE;
        id = ++s->ip_id;
        for (off = 0; off < l4_len; off += max_data) {
            size_t chunk = l4_len - off < max_data ? l4_len - off : max_data;
            int mf = off + chunk < l4_len;
            ipv4_send_one(s, src, dst, proto, id, off, mf, 0, l4 + off,
                          chunk);
        }
    } else {
        uint32_t id;

        if (pmtu <= NS_IPV6_HDR + 8)
            return -NS_EMSGSIZE;
        max_data = ((size_t)(pmtu - NS_IPV6_HDR - 8) / 8) * 8;
        if (max_data < 8)
            return -NS_EMSGSIZE;
        id = ++s->ip6_id;
        for (off = 0; off < l4_len; off += max_data) {
            size_t chunk = l4_len - off < max_data ? l4_len - off : max_data;
            int mf = off + chunk < l4_len;
            ipv6_send_one(s, src, dst, proto, id, off, mf, 1, l4 + off,
                          chunk);
        }
    }
    return 0;
}

/* Largest TCP payload that fits the current path MTU. */
static size_t tcp_segment_limit(NsStack *s, const NsAddr *dst)
{
    int family = ns_addr_family(dst);
    size_t ip_hdr = family == NS_AF_INET ? NS_IPV4_HDR : NS_IPV6_HDR;
    size_t mss;
    uint16_t pmtu = pmtu_lookup(s, dst);

    if (pmtu <= ip_hdr + NS_TCP_HDR)
        return 1;
    mss = pmtu - ip_hdr - NS_TCP_HDR;
    if (mss > NS_MSS)
        mss = NS_MSS;
    return mss;
}

/* ---------------- TCP transmit ---------------- */

static void ns_emit(NsConn *c, uint8_t flags, uint32_t seq, uint32_t ack,
                    const uint8_t *payload, size_t plen)
{
    NsStack *s = c->shard->stack;
    uint8_t tcp[NS_TCP_HDR + NS_MSS];
    size_t tcp_len = NS_TCP_HDR + plen;
    int family = ns_addr_family(&c->local);

    if (!s->send || plen > NS_MSS || family != ns_addr_family(&c->remote))
        return;

    wr16(tcp, c->lport);
    wr16(tcp + 2, c->rport);
    wr32(tcp + 4, seq);
    wr32(tcp + 8, ack);
    tcp[12] = (uint8_t)((NS_TCP_HDR / 4) << 4);
    tcp[13] = flags;
    wr16(tcp + 14, c->rcv_wnd);
    wr16(tcp + 16, 0);
    wr16(tcp + 18, 0);
    if (plen)
        memcpy(tcp + NS_TCP_HDR, payload, plen);
    wr16(tcp + 16, tcp_checksum(c->local.b, c->remote.b, family, tcp,
                                tcp_len));

    ip_emit(s, &c->local, &c->remote, 6, tcp, tcp_len);
}

static NsSeg *seg_add(NsConn *c, uint32_t seq, uint32_t seq_len,
                      uint8_t flags, const uint8_t *data, size_t len,
                      uint64_t now)
{
    NsSeg *seg = calloc(1, sizeof(*seg) + len);
    if (!seg)
        return NULL;
    seg->seq = seq;
    seg->len = (uint32_t)len;
    seg->seq_len = seq_len;
    seg->flags = flags;
    seg->deadline = now + NS_RTO_MS;
    if (len)
        memcpy(seg->data, data, len);
    if (c->tx_tail)
        c->tx_tail->next = seg;
    else
        c->tx_head = seg;
    c->tx_tail = seg;
    return seg;
}

static void conn_ack(NsConn *c, uint32_t ack)
{
    NsSeg *seg;

    if (seq_lt(c->snd_una, ack))
        c->snd_una = ack;
    while ((seg = c->tx_head) != NULL) {
        uint32_t end = seg->seq + seg->seq_len;
        if (!seq_le(end, ack))
            break;
        c->tx_head = seg->next;
        if (!c->tx_head)
            c->tx_tail = NULL;
        free(seg);
    }
}

static void conn_maybe_advance(NsConn *c, uint64_t now)
{
    int all_acked = seq_le(c->snd_nxt, c->snd_una);

    switch (c->state) {
    case NS_SYN_RCVD:
        /* The final ACK moves a server connection to ESTABLISHED. */
        break;
    case NS_FIN_WAIT_1:
        if (all_acked) {
            if (c->peer_closed) {
                c->state = NS_TIME_WAIT;
                c->time_wait_at = now;
            } else {
                c->state = NS_FIN_WAIT_2;
            }
        }
        break;
    case NS_LAST_ACK:
        if (all_acked)
            c->state = NS_CLOSED;
        break;
    default:
        break;
    }
}

/* ---------------- receive ---------------- */

static size_t rbuf_write(NsConn *c, const uint8_t *data, size_t len)
{
    size_t tail = (c->rhead + c->rlen) % c->rcap;
    size_t first;
    size_t written;

    if (len > c->rcap - c->rlen)
        len = c->rcap - c->rlen; /* the peer retransmits the rest */
    written = len;
    first = c->rcap - tail;
    if (first > len)
        first = len;
    memcpy(c->rbuf + tail, data, first);
    if (len > first)
        memcpy(c->rbuf, data + first, len - first);
    c->rlen += len;
    return written;
}

static void conn_input(NsConn *c, uint8_t flags, uint32_t seq, uint32_t ack,
                       const uint8_t *payload, size_t plen, uint64_t now)
{
    if (flags & NS_TCP_RST) {
        c->state = NS_CLOSED;
        c->peer_closed = 1;
        return;
    }

    /* A duplicate SYN while the server is in SYN_RCVD means the SYN-ACK was
       lost; retransmit it instead of treating the SYN as data. */
    if ((flags & NS_TCP_SYN) && !(flags & NS_TCP_ACK) &&
        c->state == NS_SYN_RCVD) {
        c->shard->stack->stats.retransmits++;
        ns_emit(c, NS_TCP_SYN | NS_TCP_ACK, c->iss, c->rcv_nxt, NULL, 0);
        return;
    }

    if ((flags & (NS_TCP_SYN | NS_TCP_ACK)) == (NS_TCP_SYN | NS_TCP_ACK)) {
        if (c->state == NS_SYN_SENT) {
            c->rcv_nxt = seq + 1;
            conn_ack(c, ack);
            c->state = NS_ESTABLISHED;
            ns_emit(c, NS_TCP_ACK, c->snd_nxt, c->rcv_nxt, NULL, 0);
        } else if (c->state == NS_SYN_RCVD) {
            /* Duplicate SYN-ACK: retransmit the SYN-ACK. */
            c->shard->stack->stats.retransmits++;
            ns_emit(c, NS_TCP_SYN | NS_TCP_ACK, c->iss, c->rcv_nxt, NULL, 0);
        } else if (c->state == NS_ESTABLISHED) {
            /* The peer missed our final ACK. */
            ns_emit(c, NS_TCP_ACK, c->snd_nxt, c->rcv_nxt, NULL, 0);
        }
        return;
    }

    if (flags & NS_TCP_ACK) {
        conn_ack(c, ack);
        if (c->state == NS_SYN_RCVD) {
            c->state = NS_ESTABLISHED;
            accept_push(c->shard, c);
        }
        conn_maybe_advance(c, now);
    }

    if (plen) {
        if (seq == c->rcv_nxt) {
            size_t written = rbuf_write(c, payload, plen);
            c->rcv_nxt += (uint32_t)written;
        } else if (seq_lt(seq, c->rcv_nxt)) {
            uint32_t skip = c->rcv_nxt - seq;
            if (skip < plen) {
                size_t written = rbuf_write(c, payload + skip, plen - skip);
                c->rcv_nxt += (uint32_t)written;
            }
        }
        /* Out-of-order data is dropped; the peer retransmits. */
        ns_emit(c, NS_TCP_ACK, c->snd_nxt, c->rcv_nxt, NULL, 0);
    }

    if (flags & NS_TCP_FIN) {
        uint32_t fin_seq = seq + (uint32_t)plen;
        if (fin_seq == c->rcv_nxt) {
            c->rcv_nxt++;
            c->peer_closed = 1;
            if (c->state == NS_ESTABLISHED)
                c->state = NS_CLOSE_WAIT;
            else if (c->state == NS_FIN_WAIT_1 || c->state == NS_FIN_WAIT_2) {
                c->state = NS_TIME_WAIT;
                c->time_wait_at = now;
            }
        }
        ns_emit(c, NS_TCP_ACK, c->snd_nxt, c->rcv_nxt, NULL, 0);
        conn_maybe_advance(c, now);
    }
}

static NsConn *server_accept_syn(NsShard *sh, const NsAddr *src,
                                 const NsAddr *dst, uint16_t sport,
                                 uint16_t dport, uint32_t seq, uint64_t now)
{
    NsStack *s = sh->stack;
    NsConn *c = conn_new(sh, NS_SYN_RCVD);
    if (!c)
        return NULL;
    if (s->plain || ns_addr_family(dst) == NS_AF_INET)
        c->local = *dst;
    else
        shard_alloc_addr(sh, &c->local);
    c->remote = *src;
    c->lport = dport;
    c->rport = sport;
    c->rcv_nxt = seq + 1;
    c->iss = ns_rand(s);
    c->snd_una = c->iss;
    c->snd_nxt = c->iss + 1;
    seg_add(c, c->iss, 1, NS_TCP_SYN, NULL, 0, now);
    ns_emit(c, NS_TCP_SYN | NS_TCP_ACK, c->iss, c->rcv_nxt, NULL, 0);
    return c;
}

/* ---------------- ICMP ---------------- */

/* Never answer a packet whose source is not a unicast address, and never
   send an error about a multicast, broadcast or unspecified destination. */
static int icmp_can_reply(const NsAddr *src, const NsAddr *dst)
{
    return !addr_unspecified(src) && !addr_multicast(src) &&
           !addr_broadcast(src) && !addr_unspecified(dst) &&
           !addr_multicast(dst) && !addr_broadcast(dst);
}

static int icmp_emit(NsStack *s, const NsAddr *src, const NsAddr *dst,
                     uint8_t *msg, size_t len)
{
    int family = ns_addr_family(dst);
    int r;

    if (!s->send || family != ns_addr_family(src) || len < NS_ICMP_HDR ||
        len > NS_MAX_IP_PACKET)
        return -NS_EMSGSIZE;

    wr16(msg + 2, 0);
    if (family == NS_AF_INET)
        wr16(msg + 2, ipv4_checksum(msg, len));
    else
        wr16(msg + 2, l4_checksum(src->b, dst->b, family, 58, msg, len));

    r = ip_emit(s, src, dst, family == NS_AF_INET ? 1 : 58, msg, len);
    if (r == 0)
        s->stats.icmp_tx++;
    return r;
}

/* Learn the path MTU from an ICMP error. The quoted packet's destination is
   the peer the original datagram was sent to. */
static void icmp_pmtu_input(NsStack *s, int family, const uint8_t *icmp,
                            size_t icmp_len)
{
    const uint8_t *quote;
    size_t quote_len;
    size_t ip_hdr;
    size_t addr_len;
    NsAddr dst;
    uint32_t mtu;

    if (family == NS_AF_INET) {
        if (icmp[0] != 3 || icmp[1] != 4 || icmp_len < NS_ICMP_HDR + NS_IPV4_HDR)
            return;
        mtu = rd16(icmp + 6);
        if (mtu == 0)
            mtu = NS_PMTU_V4_MIN;
        quote = icmp + NS_ICMP_HDR;
        quote_len = icmp_len - NS_ICMP_HDR;
        if ((quote[0] >> 4) != 4)
            return;
        ip_hdr = (size_t)(quote[0] & 0x0f) * 4;
        if (ip_hdr < NS_IPV4_HDR || quote_len < ip_hdr)
            return;
        addr_len = 4;
        memset(&dst, 0, sizeof(dst));
        dst.family = NS_AF_INET;
        memcpy(dst.b, quote + 16, addr_len);
    } else {
        if (icmp[0] != 2 || icmp_len < NS_ICMP_HDR + NS_IPV6_HDR)
            return;
        mtu = rd32(icmp + 4);
        if (mtu == 0)
            return;
        quote = icmp + NS_ICMP_HDR;
        quote_len = icmp_len - NS_ICMP_HDR;
        if ((quote[0] >> 4) != 6)
            return;
        addr_len = 16;
        memset(&dst, 0, sizeof(dst));
        dst.family = NS_AF_INET6;
        memcpy(dst.b, quote + 24, addr_len);
    }
    pmtu_note(s, &dst, mtu, 1);
}

/* Answer an echo request from the address the request was sent to. */
static void icmp_input(NsShard *sh, const uint8_t *pkt, size_t len)
{
    NsStack *s = sh->stack;
    int family = (pkt[0] >> 4) == 4 ? NS_AF_INET : NS_AF_INET6;
    size_t ip_hdr = family == NS_AF_INET
                        ? (size_t)(pkt[0] & 0x0f) * 4 : NS_IPV6_HDR;
    size_t addr_len = family == NS_AF_INET ? 4 : 16;
    const uint8_t *icmp;
    size_t icmp_len;
    NsAddr sa, da;

    if (len < ip_hdr + NS_ICMP_HDR) {
        s->stats.dropped++;
        return;
    }
    icmp = pkt + ip_hdr;
    icmp_len = len - ip_hdr;
    if (family == NS_AF_INET) {
        if (ipv4_checksum(icmp, icmp_len) != 0) {
            s->stats.dropped++;
            return;
        }
    } else if (l4_checksum(pkt + 8, pkt + 24, family, 58, icmp,
                           icmp_len) != 0) {
        s->stats.dropped++;
        return;
    }
    s->stats.icmp_rx++;
    icmp_pmtu_input(s, family, icmp, icmp_len);

    memset(&sa, 0, sizeof(sa));
    memset(&da, 0, sizeof(da));
    sa.family = da.family = (uint8_t)family;
    memcpy(sa.b, family == NS_AF_INET ? pkt + 12 : pkt + 8, addr_len);
    memcpy(da.b, family == NS_AF_INET ? pkt + 16 : pkt + 24, addr_len);

    if ((family == NS_AF_INET && icmp[0] == 8 && icmp[1] == 0) ||
        (family == NS_AF_INET6 && icmp[0] == 128 && icmp[1] == 0)) {
        uint8_t *reply;
        int r;

        if (!icmp_can_reply(&sa, &da))
            return;
        reply = malloc(icmp_len);
        if (!reply) {
            s->stats.dropped++;
            return;
        }
        memcpy(reply, icmp, icmp_len);
        reply[0] = family == NS_AF_INET ? 0 : 129;
        reply[1] = 0;
        r = icmp_emit(s, &da, &sa, reply, icmp_len);
        free(reply);
        if (r < 0)
            s->stats.dropped++;
    }
}

/* Build an ICMP/ICMPv6 error quoting the packet that triggered it. */
static void icmp_send_error(NsShard *sh, const uint8_t *pkt, size_t len,
                            uint8_t type, uint8_t code)
{
    NsStack *s = sh->stack;
    uint8_t msg[NS_MAX_PACKET];
    int family = (pkt[0] >> 4) == 4 ? NS_AF_INET : NS_AF_INET6;
    size_t ip_hdr = family == NS_AF_INET
                        ? (size_t)(pkt[0] & 0x0f) * 4 : NS_IPV6_HDR;
    size_t addr_len = family == NS_AF_INET ? 4 : 16;
    size_t quote_len = len;
    size_t msg_len;
    NsAddr src, dst;

    if (len <= ip_hdr)
        return;
    memset(&src, 0, sizeof(src));
    memset(&dst, 0, sizeof(dst));
    src.family = dst.family = (uint8_t)family;
    memcpy(src.b, family == NS_AF_INET ? pkt + 12 : pkt + 8, addr_len);
    memcpy(dst.b, family == NS_AF_INET ? pkt + 16 : pkt + 24, addr_len);
    if (!icmp_can_reply(&src, &dst))
        return;

    if (family == NS_AF_INET) {
        /* RFC 792: internet header plus 64 bits of the original data. */
        if (quote_len > ip_hdr + NS_UDP_HDR)
            quote_len = ip_hdr + NS_UDP_HDR;
    } else {
        /* RFC 4443: keep the error within the minimum IPv6 MTU. */
        size_t max_quote = 1280 - NS_IPV6_HDR - NS_ICMP_HDR;
        if (quote_len > max_quote)
            quote_len = max_quote;
    }
    if (quote_len < ip_hdr || quote_len > NS_MAX_PACKET - NS_ICMP_HDR)
        return;
    msg_len = NS_ICMP_HDR + quote_len;
    memset(msg, 0, NS_ICMP_HDR);
    msg[0] = type;
    msg[1] = code;
    memcpy(msg + NS_ICMP_HDR, pkt, quote_len);
    icmp_emit(s, &dst, &src, msg, msg_len);
}

static void icmp_port_unreachable(NsShard *sh, const uint8_t *pkt, size_t len)
{
    if ((pkt[0] >> 4) == 4)
        icmp_send_error(sh, pkt, len, 3, 3);
    else
        icmp_send_error(sh, pkt, len, 1, 4);
}

int ns_icmp_echo(NsStack *s, const NsAddr *local, const NsAddr *remote,
                 uint16_t id, uint16_t seq, const void *payload, size_t len)
{
    uint8_t *msg;
    int family;
    size_t total;
    int r;

    if (!s || !local || !remote)
        return -NS_EINVAL;
    family = ns_addr_family(remote);
    if (family != ns_addr_family(local))
        return -NS_EINVAL;
    if (len > (size_t)NS_MAX_IP_PACKET - NS_ICMP_HDR)
        return -NS_EMSGSIZE;
    total = NS_ICMP_HDR + len;
    msg = malloc(total);
    if (!msg)
        return -NS_EMSGSIZE;
    memset(msg, 0, NS_ICMP_HDR);
    msg[0] = family == NS_AF_INET ? 8 : 128;
    msg[1] = 0;
    wr16(msg + 4, id);
    wr16(msg + 6, seq);
    if (len)
        memcpy(msg + NS_ICMP_HDR, payload, len);
    r = icmp_emit(s, local, remote, msg, total);
    free(msg);
    return r;
}

/* ---------------- UDP ---------------- */

static void udp_free(NsUdp *u)
{
    NsDgram *d = u->qhead;
    while (d) {
        NsDgram *next = d->next;
        free(d);
        d = next;
    }
    free(u);
}

static NsUdp *udp_by_id(NsStack *s, uint64_t id)
{
    NsUdp *u;

    if (!s || (id >> 63) == 0)
        return NULL;
    for (u = s->udp; u; u = u->next)
        if (u->id == id)
            return u;
    return NULL;
}

/* Two binds overlap when they share a port and family and either one is the
   wildcard or both name the same local address. SO_REUSEADDR is modelled as
   "both sockets asked for it". */
static int udp_port_conflict(const NsStack *s, const NsAddr *local,
                             int has_local, uint16_t port, int family,
                             int reuse)
{
    NsUdp *u;

    for (u = s->udp; u; u = u->next) {
        if (u->lport != port || u->local.family != family)
            continue;
        if (has_local && u->has_local && !addr_eq(&u->local, local))
            continue;
        if (reuse && u->reuse)
            continue;
        return 1;
    }
    return 0;
}

static NsUdp *udp_find(NsStack *s, const NsAddr *dst, uint16_t dport,
                       const NsAddr *src, uint16_t sport)
{
    NsUdp *u;
    NsUdp *best = NULL;
    int best_exact = -1;

    for (u = s->udp; u; u = u->next) {
        int exact;

        if (u->lport != dport ||
            u->local.family != (uint8_t)ns_addr_family(dst))
            continue;
        if (u->connected &&
            (u->rport != sport || !addr_eq(&u->remote, src)))
            continue;
        if (u->has_local) {
            if (!addr_eq(&u->local, dst))
                continue;
            exact = 1;
        } else {
            exact = 0;
        }
        if (exact > best_exact) {
            best = u;
            best_exact = exact;
        }
    }
    return best;
}

static int udp_emit(NsStack *s, const NsAddr *src, const NsAddr *dst,
                    uint16_t sport, uint16_t dport, const void *buf,
                    size_t len)
{
    uint8_t small[NS_MAX_PACKET];
    uint8_t *udp = small;
    int family = ns_addr_family(dst);
    size_t udp_len = NS_UDP_HDR + len;
    int r;

    if (!s->send || family != ns_addr_family(src) || udp_len > 65535 ||
        (family == NS_AF_INET && NS_IPV4_HDR + udp_len > NS_MAX_IP_PACKET))
        return -NS_EMSGSIZE;
    if (udp_len > sizeof(small)) {
        udp = malloc(udp_len);
        if (!udp)
            return -NS_EMSGSIZE;
    }

    wr16(udp, sport);
    wr16(udp + 2, dport);
    wr16(udp + 4, (uint16_t)udp_len);
    wr16(udp + 6, 0);
    if (len)
        memcpy(udp + NS_UDP_HDR, buf, len);
    wr16(udp + 6, udp_checksum(src->b, dst->b, family, udp, udp_len));

    r = ip_emit(s, src, dst, 17, udp, udp_len);
    if (udp != small)
        free(udp);
    return r;
}

uint64_t ns_udp_open(NsStack *s, const NsAddr *local, uint16_t port, int reuse)
{
    NsAddr la;
    NsUdp *u;
    uint16_t p;
    int family;
    int has_local;
    int tries;

    if (!s || s->nudp >= NS_MAX_UDP_SOCKETS)
        return 0;

    if (local) {
        family = ns_addr_family(local);
        la = *local;
        la.family = (uint8_t)family;
        has_local = !addr_unspecified(&la);
    } else {
        if (ns_stack_local_family(s, NS_AF_INET6))
            family = NS_AF_INET6;
        else if (ns_stack_local_family(s, NS_AF_INET))
            family = NS_AF_INET;
        else
            family = NS_AF_INET6;
        memset(&la, 0, sizeof(la));
        la.family = (uint8_t)family;
        has_local = 0;
    }
    if (!has_local)
        memset(la.b, 0, sizeof(la.b));

    if (port) {
        if (udp_port_conflict(s, &la, has_local, port, family, reuse))
            return 0;
        p = port;
    } else {
        p = s->next_udp_port;
        if (p < 1024)
            p = 49152;
        for (tries = 0; tries < 65535; tries++) {
            if (p == 0)
                p = 49152;
            if (!udp_port_conflict(s, &la, has_local, p, family, reuse))
                break;
            p++;
        }
        if (tries >= 65535)
            return 0;
        s->next_udp_port = (uint16_t)(p + 1);
    }

    u = calloc(1, sizeof(*u));
    if (!u)
        return 0;
    u->id = (1ULL << 63) | (++s->next_udp_seq);
    u->local = la;
    u->lport = p;
    u->has_local = (uint8_t)(has_local != 0);
    u->reuse = (uint8_t)(reuse != 0);
    u->next = s->udp;
    s->udp = u;
    s->nudp++;
    return u->id;
}

int ns_udp_connect(NsStack *s, uint64_t id, const NsAddr *remote,
                   uint16_t rport)
{
    NsUdp *u = udp_by_id(s, id);
    int family;

    if (!u)
        return -NS_ENOTCONN;
    if (!remote || rport == 0 || addr_unspecified(remote))
        return -NS_EINVAL;
    family = ns_addr_family(remote);
    if (family != (int)u->local.family)
        return -NS_EINVAL;
    u->remote = *remote;
    u->remote.family = (uint8_t)family;
    u->rport = rport;
    u->connected = 1;
    return 0;
}

int ns_udp_disconnect(NsStack *s, uint64_t id)
{
    NsUdp *u = udp_by_id(s, id);

    if (!u)
        return -NS_ENOTCONN;
    u->connected = 0;
    u->rport = 0;
    memset(&u->remote, 0, sizeof(u->remote));
    return 0;
}

int ns_udp_sendto(NsStack *s, uint64_t id, const NsAddr *dst, uint16_t dport,
                  const void *buf, size_t len)
{
    NsUdp *u = udp_by_id(s, id);
    const NsAddr *src;
    const NsAddr *rdst;
    uint16_t rport;
    int family;

    if (!u)
        return -NS_ENOTCONN;
    if (!dst) {
        if (!u->connected)
            return -NS_EDESTADDRREQ;
        rdst = &u->remote;
        rport = u->rport;
    } else {
        if (dport == 0 || addr_unspecified(dst))
            return -NS_EINVAL;
        rdst = dst;
        rport = dport;
    }
    family = ns_addr_family(rdst);

    if (u->has_local) {
        if (ns_addr_family(&u->local) != family)
            return -NS_EINVAL;
        src = &u->local;
    } else {
        if (u->local.family && (int)u->local.family != family)
            return -NS_EINVAL;
        src = ns_stack_local_family(s, family);
        if (!src)
            return -NS_EINVAL;
    }

    if (udp_emit(s, src, rdst, u->lport, rport, buf, len) != 0)
        return -NS_EMSGSIZE;
    return (int)len;
}

int ns_udp_recvfrom(NsStack *s, uint64_t id, void *buf, size_t len,
                    NsAddr *src, uint16_t *sport)
{
    NsUdp *u = udp_by_id(s, id);
    NsDgram *d;
    size_t n;

    if (!u)
        return -NS_ENOTCONN;
    d = u->qhead;
    if (!d)
        return -NS_EAGAIN;
    u->qhead = d->next;
    if (!u->qhead)
        u->qtail = NULL;
    u->qlen--;
    u->qbytes -= d->len;

    n = len < d->len ? len : d->len;
    if (n)
        memcpy(buf, d->data, n);
    if (src)
        *src = d->src;
    if (sport)
        *sport = d->sport;
    free(d);
    return (int)n;
}

int ns_udp_close(NsStack *s, uint64_t id)
{
    NsUdp **pp;
    NsUdp *u;

    if (!s)
        return -NS_EINVAL;
    for (pp = &s->udp; (u = *pp) != NULL; pp = &u->next) {
        if (u->id != id)
            continue;
        *pp = u->next;
        s->nudp--;
        udp_free(u);
        return 0;
    }
    return -NS_ENOTCONN;
}

int ns_udp_readable(NsStack *s, uint64_t id)
{
    NsUdp *u = udp_by_id(s, id);

    if (!u)
        return 1;
    return u->qhead != NULL;
}

int ns_udp_bound_addr(NsStack *s, uint64_t id, NsAddr *local,
                      uint16_t *lport)
{
    NsUdp *u = udp_by_id(s, id);

    if (!u)
        return -NS_ENOTCONN;
    if (local)
        *local = u->local;
    if (lport)
        *lport = u->lport;
    return 0;
}

int ns_udp_peer_addr(NsStack *s, uint64_t id, NsAddr *remote,
                     uint16_t *rport)
{
    NsUdp *u = udp_by_id(s, id);

    if (!u || !u->connected)
        return -NS_ENOTCONN;
    if (remote)
        *remote = u->remote;
    if (rport)
        *rport = u->rport;
    return 0;
}

int ns_udp_is_connected(NsStack *s, uint64_t id)
{
    NsUdp *u = udp_by_id(s, id);
    return u ? u->connected : 0;
}

static void udp_input(NsShard *sh, const uint8_t *pkt, size_t len)
{
    NsStack *s = sh->stack;
    int family = (pkt[0] >> 4) == 4 ? NS_AF_INET : NS_AF_INET6;
    size_t ip_hdr = family == NS_AF_INET
                        ? (size_t)(pkt[0] & 0x0f) * 4 : NS_IPV6_HDR;
    size_t addr_len = family == NS_AF_INET ? 4 : 16;
    const uint8_t *udp;
    uint16_t sport, dport, ulen;
    size_t dlen;
    const uint8_t *data;
    NsAddr sa, da;
    NsUdp *u;
    NsDgram *d;

    if (len < ip_hdr + NS_UDP_HDR) {
        s->stats.dropped++;
        return;
    }
    udp = pkt + ip_hdr;
    sport = rd16(udp);
    dport = rd16(udp + 2);
    ulen = rd16(udp + 4);
    if (ulen < NS_UDP_HDR || ulen > len - ip_hdr) {
        s->stats.dropped++;
        return;
    }
    dlen = ulen - NS_UDP_HDR;
    data = udp + NS_UDP_HDR;

    memset(&sa, 0, sizeof(sa));
    memset(&da, 0, sizeof(da));
    sa.family = da.family = (uint8_t)family;
    memcpy(sa.b, family == NS_AF_INET ? pkt + 12 : pkt + 8, addr_len);
    memcpy(da.b, family == NS_AF_INET ? pkt + 16 : pkt + 24, addr_len);

    u = udp_find(s, &da, dport, &sa, sport);
    if (!u) {
        /* No listener: tell the sender with an ICMP error. */
        icmp_port_unreachable(sh, pkt, len);
        s->stats.dropped++;
        return;
    }
    if (u->qlen >= NS_UDP_QUEUE_MAX ||
        u->qbytes + dlen > NS_UDP_QUEUE_BYTES) {
        s->stats.dropped++;
        return;
    }
    d = malloc(sizeof(*d) + dlen);
    if (!d) {
        s->stats.dropped++;
        return;
    }
    d->next = NULL;
    d->src = sa;
    d->sport = sport;
    d->len = (uint16_t)dlen;
    if (dlen)
        memcpy(d->data, data, dlen);
    if (u->qtail)
        u->qtail->next = d;
    else
        u->qhead = d;
    u->qtail = d;
    u->qlen++;
    u->qbytes += dlen;
}

/* ---------------- fragment reassembly ---------------- */

static int reasm_bit_test(const uint8_t *bm, size_t i)
{
    return (bm[i >> 3] >> (i & 7)) & 1;
}

static void reasm_bit_set(uint8_t *bm, size_t i)
{
    bm[i >> 3] |= (uint8_t)(1u << (i & 7));
}

static NsReasm *reasm_find(NsStack *s, int family, const NsAddr *src,
                           const NsAddr *dst, uint8_t proto, uint32_t id)
{
    NsReasm *e;

    for (e = s->reasm; e; e = e->next)
        if (e->family == family && e->proto == proto && e->id == id &&
            addr_eq(&e->src, src) && addr_eq(&e->dst, dst))
            return e;
    return NULL;
}

static void reasm_destroy(NsStack *s, NsReasm *e)
{
    NsReasm **pp = &s->reasm;

    while (*pp && *pp != e)
        pp = &(*pp)->next;
    if (*pp != e)
        return;
    *pp = e->next;
    s->nreasm--;
    free(e->data);
    free(e->bitmap);
    free(e);
}

static NsReasm *reasm_create(NsStack *s, int family, const NsAddr *src,
                             const NsAddr *dst, uint8_t proto, uint32_t id)
{
    NsReasm *e;

    /* Reclaim expired sets before enforcing the limit. */
    e = s->reasm;
    while (e) {
        NsReasm *next = e->next;
        if (s->clock >= e->expires) {
            s->stats.reassembly_dropped++;
            reasm_destroy(s, e);
        }
        e = next;
    }
    if (s->nreasm >= NS_REASM_MAX)
        return NULL;

    e = calloc(1, sizeof(*e));
    if (!e)
        return NULL;
    e->data = malloc(NS_REASM_MAX_LEN);
    e->bitmap = calloc(1, NS_REASM_BITMAP);
    if (!e->data || !e->bitmap) {
        free(e->data);
        free(e->bitmap);
        free(e);
        return NULL;
    }
    e->family = (uint8_t)family;
    e->proto = proto;
    e->id = id;
    e->src = *src;
    e->src.family = (uint8_t)family;
    e->dst = *dst;
    e->dst.family = (uint8_t)family;
    e->expires = s->clock + NS_REASM_TIMEOUT_MS;
    e->next = s->reasm;
    s->reasm = e;
    s->nreasm++;
    return e;
}

static void reasm_add(NsStack *s, int family, const NsAddr *src,
                      const NsAddr *dst, uint8_t proto, uint32_t id,
                      size_t off, int more, const uint8_t *hdr,
                      size_t hdr_len, const uint8_t *data, size_t len)
{
    NsReasm *e;
    size_t i;
    size_t max_total = family == NS_AF_INET
                           ? NS_MAX_IP_PACKET - NS_IPV4_HDR
                           : NS_MAX_IP_PACKET;

    e = reasm_find(s, family, src, dst, proto, id);
    if (!e) {
        e = reasm_create(s, family, src, dst, proto, id);
        if (!e) {
            s->stats.reassembly_dropped++;
            return;
        }
    }
    e->expires = s->clock + NS_REASM_TIMEOUT_MS;

    if (off == 0 && !e->has_hdr && hdr && hdr_len <= sizeof(e->hdr)) {
        memcpy(e->hdr, hdr, hdr_len);
        e->hdr_len = (uint8_t)hdr_len;
        e->has_hdr = 1;
    }
    if (off > max_total || len > max_total - off) {
        s->stats.reassembly_dropped++;
        reasm_destroy(s, e);
        return;
    }
    if (!more) {
        size_t end = off + len;
        if (end > max_total || (e->total && e->total != end)) {
            s->stats.reassembly_dropped++;
            reasm_destroy(s, e);
            return;
        }
        e->total = end;
    }
    if (e->total && off + len > e->total) {
        s->stats.reassembly_dropped++;
        reasm_destroy(s, e);
        return;
    }
    for (i = 0; i < len; i++) {
        size_t pos = off + i;
        if (!reasm_bit_test(e->bitmap, pos)) {
            e->data[pos] = data[i];
            reasm_bit_set(e->bitmap, pos);
            e->have++;
        }
    }

    if (!e->total || e->have != e->total || !e->has_hdr)
        return;

    {
        size_t payload_total = e->total;
        size_t header_len = e->hdr_len;
        size_t pkt_len = header_len + payload_total;
        uint8_t *pkt = malloc(pkt_len);
        uint8_t *copy = malloc(header_len);

        if (!pkt || !copy) {
            free(pkt);
            free(copy);
            s->stats.reassembly_dropped++;
            reasm_destroy(s, e);
            return;
        }
        memcpy(copy, e->hdr, header_len);
        memcpy(pkt + header_len, e->data, payload_total);
        if (family == NS_AF_INET) {
            uint16_t frag;

            if (pkt_len > NS_MAX_IP_PACKET) {
                free(pkt);
                free(copy);
                s->stats.reassembly_dropped++;
                reasm_destroy(s, e);
                return;
            }
            memcpy(pkt, copy, header_len);
            wr16(pkt + 2, (uint16_t)pkt_len);
            frag = rd16(pkt + 6) & 0x4000; /* keep DF, clear MF/offset */
            wr16(pkt + 6, frag);
            wr16(pkt + 10, 0);
            wr16(pkt + 10, ipv4_checksum(pkt, header_len));
        } else {
            memcpy(pkt, copy, NS_IPV6_HDR);
            wr16(pkt + 4, (uint16_t)payload_total);
            pkt[6] = e->proto;
        }
        free(copy);
        s->stats.reassembled++;
        reasm_destroy(s, e);
        ip_dispatch(s, pkt, pkt_len, family, header_len, proto);
        free(pkt);
    }
}

/* Validate one complete IP packet and queue it for the owning shard. */
static void ip_dispatch(NsStack *s, const uint8_t *pkt, size_t len, int family,
                        size_t ip_hdr, uint8_t proto)
{
    const uint8_t *src = family == NS_AF_INET ? pkt + 12 : pkt + 8;
    const uint8_t *dst = family == NS_AF_INET ? pkt + 16 : pkt + 24;
    const uint8_t *l4;
    size_t l4_len;
    size_t off;
    int shard;
    NsShard *sh;
    NsPacket *p;

    if (len < ip_hdr) {
        s->stats.dropped++;
        return;
    }
    l4 = pkt + ip_hdr;
    l4_len = len - ip_hdr;

    if (proto == 17) {
        uint16_t ulen;

        if (l4_len < NS_UDP_HDR) {
            s->stats.dropped++;
            return;
        }
        ulen = rd16(l4 + 4);
        if (ulen < NS_UDP_HDR || ulen > l4_len) {
            s->stats.dropped++;
            return;
        }
        len = ip_hdr + ulen;
        l4_len = ulen;
        if (rd16(l4 + 6) == 0) {
            if (family != NS_AF_INET) {
                s->stats.dropped++;
                return;
            }
        } else if (l4_checksum(src, dst, family, 17, l4, l4_len) != 0) {
            s->stats.dropped++;
            return;
        }
    } else if (proto == 1 || proto == 58) {
        if (l4_len < NS_ICMP_HDR) {
            s->stats.dropped++;
            return;
        }
    } else {
        if (l4_len < NS_TCP_HDR) {
            s->stats.dropped++;
            return;
        }
        off = (size_t)(l4[12] >> 4) * 4;
        if (off < NS_TCP_HDR || off > l4_len ||
            tcp_checksum(src, dst, family, l4, l4_len) != 0) {
            s->stats.dropped++;
            return;
        }
    }

    if (family == NS_AF_INET)
        shard = 0;
    else
        shard = s->plain ? 0 : pkt[24 + 8];
    if (shard < 0 || shard >= s->nshards) {
        s->stats.dropped++;
        return;
    }

    sh = &s->shards[shard];
    if (sh->qlen >= NS_QUEUE_MAX) {
        s->stats.dropped++;
        return;
    }
    p = malloc(sizeof(*p) + len);
    if (!p) {
        s->stats.dropped++;
        return;
    }
    p->next = NULL;
    p->len = (uint32_t)len;
    memcpy(p->data, pkt, len);
    if (sh->qtail)
        sh->qtail->next = p;
    else
        sh->qhead = p;
    sh->qtail = p;
    sh->qlen++;
    s->stats.per_shard_rx[shard]++;
}

static void shard_process(NsShard *sh, NsPacket *p)
{
    const uint8_t *pkt = p->data;
    int family = (pkt[0] >> 4) == 4 ? NS_AF_INET : NS_AF_INET6;
    size_t ip_hdr = family == NS_AF_INET
                        ? (size_t)(pkt[0] & 0x0f) * 4 : NS_IPV6_HDR;
    const uint8_t *src = family == NS_AF_INET ? pkt + 12 : pkt + 8;
    const uint8_t *dst = family == NS_AF_INET ? pkt + 16 : pkt + 24;
    uint8_t proto = family == NS_AF_INET ? pkt[9] : pkt[6];
    size_t addr_len = family == NS_AF_INET ? 4 : 16;
    const uint8_t *tcp;
    uint16_t tcp_len;
    size_t off;
    const uint8_t *payload;
    size_t plen;
    NsAddr sa, da;
    uint16_t sport, dport;
    uint32_t seq, ack;
    uint8_t flags;
    NsStack *s = sh->stack;
    uint64_t now = s->clock;
    NsConn *c;

    /* UDP packets are not TCP segments; do not decode a TCP header until
       after this check, since a short datagram may end before tcp[12]. */
    if (proto == 17) {
        udp_input(sh, pkt, p->len);
        return;
    }
    if (proto == 1 || proto == 58) {
        icmp_input(sh, pkt, p->len);
        return;
    }

    tcp = pkt + ip_hdr;
    tcp_len = (uint16_t)(p->len - ip_hdr);
    off = (size_t)(tcp[12] >> 4) * 4;
    payload = tcp + off;
    plen = tcp_len - off;
    sport = rd16(tcp);
    dport = rd16(tcp + 2);
    seq = rd32(tcp + 4);
    ack = rd32(tcp + 8);
    flags = tcp[13];

    memset(&sa, 0, sizeof(sa));
    memset(&da, 0, sizeof(da));
    sa.family = da.family = (uint8_t)family;
    memcpy(sa.b, src, addr_len);
    memcpy(da.b, dst, addr_len);

    c = conn_find(sh, &da, dport, &sa, sport);
    if (!c && (flags & NS_TCP_SYN) && !(flags & NS_TCP_ACK)) {
        if (find_listener_at(s, &da, dport) >= 0) {
            c = server_accept_syn(sh, &sa, &da, sport, dport, seq, now);
            if (!c) {
                s->stats.dropped++;
                return;
            }
            /* server_accept_syn() already answered the SYN. */
            return;
        }
    }
    if (!c && !s->plain && (flags & (NS_TCP_SYN | NS_TCP_ACK)) ==
                   (NS_TCP_SYN | NS_TCP_ACK)) {
        /* The server allocates a new address for the connection and sends
           the SYN-ACK from it; migrate the pending client endpoint. */
        c = conn_find_pending(sh, &da, dport, sport);
        if (c)
            c->remote = sa;
    }
    if (!c) {
        s->stats.dropped++;
        return;
    }

    conn_input(c, flags, seq, ack, payload, plen, now);
}

/* ---------------- public I/O ---------------- */

int ns_run(NsStack *s, int budget)
{
    int processed = 0;
    int progress = 1;

    if (!s || budget <= 0)
        return 0;

    /* One packet per shard per round keeps a busy shard from starving the
       others. This is the interleaved dispatch policy. */
    while (processed < budget && progress) {
        int i;
        progress = 0;
        for (i = 0; i < s->nshards && processed < budget; i++) {
            NsShard *sh = &s->shards[i];
            NsPacket *p = sh->qhead;
            if (!p)
                continue;
            sh->qhead = p->next;
            if (!sh->qhead)
                sh->qtail = NULL;
            sh->qlen--;
            if (s->dispatch_log_len < NS_DISPATCH_LOG_MAX)
                s->dispatch_log[s->dispatch_log_len++] = (uint8_t)i;
            shard_process(sh, p);
            free(p);
            s->stats.dispatched++;
            processed++;
            progress = 1;
        }
    }
    return processed;
}

void ns_input(NsStack *s, const uint8_t *pkt, size_t len)
{
    int family;
    int proto;

    if (!s || len < 1)
        return;
    s->stats.rx_packets++;

    family = (pkt[0] >> 4) == 4 ? NS_AF_INET : NS_AF_INET6;
    if (family == NS_AF_INET) {
        uint16_t frag;
        uint16_t total;
        size_t ip_hdr;

        if ((pkt[0] >> 4) != 4 || len < NS_IPV4_HDR) {
            s->stats.dropped++;
            return;
        }
        ip_hdr = (size_t)(pkt[0] & 0x0f) * 4;
        if (ip_hdr < NS_IPV4_HDR || ip_hdr > len) {
            s->stats.dropped++;
            return;
        }
        total = rd16(pkt + 2);
        if (total < ip_hdr || total > len) {
            s->stats.dropped++;
            return;
        }
        len = total;
        if (ipv4_checksum(pkt, ip_hdr) != 0) {
            s->stats.dropped++;
            return;
        }
        proto = pkt[9];
        if (proto != 1 && proto != 6 && proto != 17) {
            s->stats.dropped++;
            return;
        }
        frag = rd16(pkt + 6);
        if (frag & 0x3fff) {
            NsAddr src, dst;

            memset(&src, 0, sizeof(src));
            memset(&dst, 0, sizeof(dst));
            src.family = dst.family = NS_AF_INET;
            memcpy(src.b, pkt + 12, 4);
            memcpy(dst.b, pkt + 16, 4);
            s->stats.fragments_rx++;
            reasm_add(s, family, &src, &dst, (uint8_t)proto, rd16(pkt + 4),
                      (size_t)(frag & 0x1fff) * 8, (frag & 0x2000) != 0,
                      pkt, ip_hdr, pkt + ip_hdr, len - ip_hdr);
            return;
        }
        ip_dispatch(s, pkt, len, family, ip_hdr, (uint8_t)proto);
    } else {
        size_t body;
        size_t min_hdr;

        if ((pkt[0] >> 4) != 6 || len < NS_IPV6_HDR) {
            s->stats.dropped++;
            return;
        }
        body = rd16(pkt + 4);
        if (body > len - NS_IPV6_HDR) {
            s->stats.dropped++;
            return;
        }
        len = NS_IPV6_HDR + body;
        proto = pkt[6];

        /* Only the Fragment extension header is understood. A fragment
           carries an upper-layer protocol in its next-header field. */
        if (proto == 44) {
            uint16_t word;
            uint8_t inner;
            size_t off;
            NsAddr src, dst;

            if (len < NS_IPV6_HDR + 8) {
                s->stats.dropped++;
                return;
            }
            inner = pkt[NS_IPV6_HDR];
            if (inner != 6 && inner != 17 && inner != 58) {
                s->stats.dropped++;
                return;
            }
            word = rd16(pkt + NS_IPV6_HDR + 2);
            off = (size_t)(word & 0xfff8);
            memset(&src, 0, sizeof(src));
            memset(&dst, 0, sizeof(dst));
            src.family = dst.family = NS_AF_INET6;
            memcpy(src.b, pkt + 8, 16);
            memcpy(dst.b, pkt + 24, 16);
            s->stats.fragments_rx++;
            reasm_add(s, family, &src, &dst, inner,
                      rd32(pkt + NS_IPV6_HDR + 4), off, (word & 1) != 0,
                      pkt, NS_IPV6_HDR, pkt + NS_IPV6_HDR + 8,
                      len - NS_IPV6_HDR - 8);
            return;
        }
        if (proto != 6 && proto != 17 && proto != 58) {
            s->stats.dropped++;
            return;
        }
        min_hdr = proto == 6 ? NS_TCP_HDR
                            : proto == 17 ? NS_UDP_HDR : NS_ICMP_HDR;
        if (len < NS_IPV6_HDR + min_hdr) {
            s->stats.dropped++;
            return;
        }
        ip_dispatch(s, pkt, len, family, NS_IPV6_HDR, (uint8_t)proto);
    }
}

void ns_tick(NsStack *s, uint64_t now_ms)
{
    int i;

    if (!s)
        return;
    s->clock = now_ms;

    /* Expire incomplete fragment sets and path-MTU observations. */
    {
        NsReasm *e = s->reasm;
        int j;

        while (e) {
            NsReasm *next = e->next;
            if (now_ms >= e->expires) {
                s->stats.reassembly_dropped++;
                reasm_destroy(s, e);
            }
            e = next;
        }
        for (j = 0; j < NS_PMTU_ENTRIES; j++)
            if (s->pmtu[j].valid && now_ms >= s->pmtu[j].expires)
                s->pmtu[j].valid = 0;
    }

    for (i = 0; i < s->nshards; i++) {
        NsShard *sh = &s->shards[i];
        NsConn *c;
        for (c = sh->conns; c; c = c->next) {
            NsSeg *seg;
            if (c->state == NS_TIME_WAIT &&
                now_ms - c->time_wait_at >= NS_TIME_WAIT_MS) {
                c->state = NS_CLOSED;
                continue;
            }
            for (seg = c->tx_head; seg; seg = seg->next) {
                if (now_ms < seg->deadline)
                    continue;
                if (seg->retries >= NS_MAX_RETRIES) {
                    c->state = NS_CLOSED;
                    c->peer_closed = 1;
                    break;
                }
                ns_emit(c, seg->flags, seg->seq, c->rcv_nxt, seg->data,
                        seg->len);
                seg->retries++;
                seg->deadline = now_ms +
                    ((uint64_t)NS_RTO_MS << (seg->retries > 4 ? 4
                                                            : seg->retries));
                s->stats.retransmits++;
            }
            conn_maybe_advance(c, now_ms);
        }

        /* Reap connections that have been fully closed for a while. */
        NsConn **pp = &sh->conns;
        while ((c = *pp) != NULL) {
            if (c->state == NS_CLOSED) {
                if (c->closed_at == 0) {
                    c->closed_at = now_ms;
                    pp = &c->next;
                    continue;
                }
                if (now_ms - c->closed_at >= NS_TIME_WAIT_MS) {
                    *pp = c->next;
                    accept_remove(sh, c);
                    conn_free(c);
                    continue;
                }
            } else {
                c->closed_at = 0;
            }
            pp = &c->next;
        }
    }
}

static uint64_t conn_connect(NsStack *s, NsShard *sh, const NsAddr *local,
                             uint16_t local_port, const NsAddr *remote,
                             uint16_t remote_port)
{
    NsConn *c;
    int family = ns_addr_family(remote);

    if (local && ns_addr_family(local) != family)
        return 0;
    if (!local && family == NS_AF_INET &&
        !ns_stack_local_family(s, NS_AF_INET))
        return 0;
    c = conn_new(sh, NS_SYN_SENT);
    if (!c)
        return 0;
    c->remote = *remote;
    c->remote.family = (uint8_t)family;
    if (local) {
        c->local = *local;
        c->local.family = (uint8_t)family;
    } else if (family == NS_AF_INET) {
        c->local = *ns_stack_local_family(s, NS_AF_INET);
    } else if (s->plain && ns_stack_local_family(s, NS_AF_INET6)) {
        c->local = *ns_stack_local_family(s, NS_AF_INET6);
    } else {
        shard_alloc_addr(sh, &c->local);
    }
    c->lport = local_port ? local_port : sh->next_port++;
    c->rport = remote_port;
    c->iss = ns_rand(s);
    c->snd_una = c->iss;
    c->snd_nxt = c->iss + 1;
    seg_add(c, c->iss, 1, NS_TCP_SYN, NULL, 0, s->clock);
    ns_emit(c, NS_TCP_SYN, c->iss, 0, NULL, 0);
    return c->id;
}

uint64_t ns_connect(NsStack *s, int local_shard, const NsAddr *service,
                    uint16_t port, uint16_t local_port)
{
    const NsAddr *local = NULL;
    NsShard *sh;

    if (!s || !service || port == 0 || local_shard < 0 ||
        local_shard >= s->nshards)
        return 0;

    if (ns_addr_family(service) == NS_AF_INET) {
        /* IPv4 is plain-only: there is no shard byte, so the connection
           must live on shard 0. */
        local = ns_stack_local_family(s, NS_AF_INET);
        if (!s->plain || !local)
            return 0;
        return conn_connect(s, &s->shards[0], local, local_port, service,
                            port);
    }
    if (ns_addr_shard(service) >= s->nshards)
        return 0;
    sh = &s->shards[local_shard];
    if (s->plain)
        local = ns_stack_local_family(s, NS_AF_INET6);
    return conn_connect(s, sh, local, local_port, service, port);
}

uint64_t ns_connect_from(NsStack *s, const NsAddr *local, uint16_t local_port,
                         const NsAddr *remote, uint16_t remote_port)
{
    if (!s || !local || !remote || remote_port == 0)
        return 0;
    return conn_connect(s, &s->shards[0], local, local_port, remote,
                        remote_port);
}

int ns_send(NsStack *s, uint64_t id, const void *buf, size_t len)
{
    NsConn *c = conn_by_id(s, id);
    const uint8_t *p = buf;
    size_t total = len;
    size_t limit;

    if (!c)
        return -NS_ENOTCONN;
    if (c->state != NS_ESTABLISHED && c->state != NS_CLOSE_WAIT)
        return -NS_ENOTCONN;
    limit = tcp_segment_limit(s, &c->remote);
    while (len > 0) {
        size_t n = len > limit ? limit : len;
        uint8_t flags = NS_TCP_ACK | (n == len ? NS_TCP_PSH : 0);
        NsSeg *seg = seg_add(c, c->snd_nxt, (uint32_t)n, flags, p, n,
                             s->clock);
        if (!seg)
            return -NS_EMSGSIZE;
        ns_emit(c, flags, seg->seq, c->rcv_nxt, p, n);
        c->snd_nxt += (uint32_t)n;
        p += n;
        len -= n;
    }
    return (int)total;
}

int ns_recv(NsStack *s, uint64_t id, void *buf, size_t len)
{
    NsConn *c = conn_by_id(s, id);
    size_t n, first;

    if (!c)
        return -NS_ENOTCONN;
    if (c->rlen == 0) {
        if (c->peer_closed || c->state == NS_CLOSED)
            return 0;
        return -NS_EAGAIN;
    }
    n = len < c->rlen ? len : c->rlen;
    first = c->rcap - c->rhead;
    if (first > n)
        first = n;
    memcpy(buf, c->rbuf + c->rhead, first);
    if (n > first)
        memcpy((uint8_t *)buf + first, c->rbuf, n - first);
    c->rhead = (c->rhead + n) % c->rcap;
    c->rlen -= n;
    return (int)n;
}

int ns_close(NsStack *s, uint64_t id)
{
    NsConn *c = conn_by_id(s, id);

    if (!c)
        return -NS_ENOTCONN;
    if (c->state == NS_CLOSED)
        return 0;
    if (c->state == NS_SYN_SENT || c->state == NS_SYN_RCVD) {
        c->state = NS_CLOSED;
        c->peer_closed = 1;
        return 0;
    }
    if (c->local_closed)
        return 0;
    if (c->state == NS_FIN_WAIT_2) {
        /* Our FIN is already acknowledged; wait for the peer's FIN. */
        c->local_closed = 1;
        return 0;
    }
    ns_emit(c, NS_TCP_FIN | NS_TCP_ACK, c->snd_nxt, c->rcv_nxt, NULL, 0);
    seg_add(c, c->snd_nxt, 1, NS_TCP_FIN | NS_TCP_ACK, NULL, 0, s->clock);
    c->snd_nxt++;
    c->local_closed = 1;
    c->state = (c->peer_closed || c->state == NS_CLOSE_WAIT)
                   ? NS_LAST_ACK : NS_FIN_WAIT_1;
    return 0;
}

int ns_accept(NsStack *s, uint64_t *id_out)
{
    int i;

    if (!s || !id_out)
        return -NS_EINVAL;
    for (i = 0; i < s->nshards; i++) {
        NsShard *sh = &s->shards[i];
        while (sh->accept_head) {
            NsConn *c = sh->accept_head;
            sh->accept_head = c->accept_next;
            if (!sh->accept_head)
                sh->accept_tail = NULL;
            c->accept_next = NULL;
            if (c->state == NS_SYN_SENT || c->state == NS_SYN_RCVD)
                continue;
            c->accepted = 1;
            *id_out = c->id;
            s->stats.accepted++;
            return 0;
        }
    }
    return -NS_EAGAIN;
}

int ns_accept_port(NsStack *s, uint16_t port, uint64_t *id_out)
{
    int i;

    if (!s || !id_out)
        return -NS_EINVAL;
    for (i = 0; i < s->nshards; i++) {
        NsShard *sh = &s->shards[i];
        NsConn *c, *prev = NULL;
        for (c = sh->accept_head; c; prev = c, c = c->accept_next) {
            if (c->lport != port)
                continue;
            if (prev)
                prev->accept_next = c->accept_next;
            else
                sh->accept_head = c->accept_next;
            if (sh->accept_tail == c)
                sh->accept_tail = prev;
            c->accept_next = NULL;
            if (c->state == NS_SYN_SENT || c->state == NS_SYN_RCVD)
                continue;
            c->accepted = 1;
            *id_out = c->id;
            s->stats.accepted++;
            return 0;
        }
    }
    return -NS_EAGAIN;
}

/* ---------------- introspection ---------------- */

int ns_accept_ready(NsStack *s)
{
    int i;
    if (!s)
        return 0;
    for (i = 0; i < s->nshards; i++)
        if (s->shards[i].accept_head)
            return 1;
    return 0;
}

int ns_accept_ready_port(NsStack *s, uint16_t port)
{
    int i;
    if (!s)
        return 0;
    for (i = 0; i < s->nshards; i++) {
        NsConn *c;
        for (c = s->shards[i].accept_head; c; c = c->accept_next)
            if (c->lport == port)
                return 1;
    }
    return 0;
}

int ns_conn_readable(NsStack *s, uint64_t id)
{
    NsConn *c = conn_by_id(s, id);
    if (!c)
        return 1;
    return c->rlen > 0 || c->peer_closed || c->state == NS_CLOSED;
}

int ns_conn_writable(NsStack *s, uint64_t id)
{
    NsConn *c = conn_by_id(s, id);
    if (!c)
        return 1;
    return (c->state == NS_ESTABLISHED || c->state == NS_CLOSE_WAIT) &&
           !c->local_closed;
}

int ns_conn_established(NsStack *s, uint64_t id)
{
    NsConn *c = conn_by_id(s, id);
    if (!c)
        return 0;
    return c->state == NS_ESTABLISHED || c->state == NS_CLOSE_WAIT ||
           c->state == NS_FIN_WAIT_1 || c->state == NS_FIN_WAIT_2;
}

int ns_conn_state(NsStack *s, uint64_t id)
{
    NsConn *c = conn_by_id(s, id);
    return c ? c->state : NS_CLOSED;
}

int ns_conn_peer_closed(NsStack *s, uint64_t id)
{
    NsConn *c = conn_by_id(s, id);
    return c ? (c->peer_closed || c->state == NS_CLOSED) : 1;
}

int ns_conn_addr(NsStack *s, uint64_t id, NsAddr *local, uint16_t *lport,
                 NsAddr *remote, uint16_t *rport)
{
    NsConn *c = conn_by_id(s, id);
    if (!c)
        return -NS_ENOTCONN;
    if (local)
        *local = c->local;
    if (lport)
        *lport = c->lport;
    if (remote)
        *remote = c->remote;
    if (rport)
        *rport = c->rport;
    return 0;
}

int ns_path_mtu(NsStack *s, const NsAddr *dst)
{
    if (!s || !dst)
        return -NS_EINVAL;
    return (int)pmtu_lookup(s, dst);
}

int ns_path_mtu_set(NsStack *s, const NsAddr *dst, uint16_t mtu)
{
    NsPmtu *e;

    if (!s || !dst)
        return -NS_EINVAL;
    if (mtu == 0) {
        e = pmtu_find(s, dst);
        if (e)
            e->valid = 0;
        return 0;
    }
    pmtu_note(s, dst, mtu, 0);
    return 0;
}

int ns_shard_pending(NsStack *s, int shard)
{
    if (!s || shard < 0 || shard >= s->nshards)
        return -NS_EINVAL;
    return s->shards[shard].qlen;
}

const NsStats *ns_stats(NsStack *s)
{
    return s ? &s->stats : NULL;
}

const uint8_t *ns_dispatch_log(NsStack *s, int *len)
{
    if (!s)
        return NULL;
    if (len)
        *len = s->dispatch_log_len;
    return s->dispatch_log;
}

void ns_dispatch_log_clear(NsStack *s)
{
    if (s)
        s->dispatch_log_len = 0;
}
