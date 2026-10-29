/*
 * netstack_util - byte order, checksum and address helpers shared by the
 * owned stack and its link layer.
 *
 * These are small, hot-path primitives, so they live in a header rather than
 * a separate translation unit. Only netstack.c and its link layer include
 * this file; it is not part of the public API.
 */
#ifndef NETSTACK_UTIL_H
#define NETSTACK_UTIL_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "netstack.h"

static inline uint16_t ns_rd16(const uint8_t *p)
{
    return (uint16_t)((p[0] << 8) | p[1]);
}

static inline uint32_t ns_rd32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}

static inline void ns_wr16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}

static inline void ns_wr32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

static inline uint32_t ns_csum_add(uint32_t sum, const uint8_t *p, size_t len)
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

static inline uint16_t ns_csum_fold(uint32_t sum)
{
    while (sum >> 16)
        sum = (sum & 0xffff) + (sum >> 16);
    return (uint16_t)~sum;
}

/* Return the checksum field value for an IPv4 or IPv6 transport segment. The
   pseudo-header is selected from `family`. */
static inline uint16_t ns_l4_checksum(const uint8_t *src, const uint8_t *dst,
                                      int family, uint8_t proto,
                                      const uint8_t *seg, size_t seg_len)
{
    uint32_t sum = 0;

    if (family == NS_AF_INET) {
        uint8_t pseudo[12];
        memcpy(pseudo, src, 4);
        memcpy(pseudo + 4, dst, 4);
        pseudo[8] = 0;
        pseudo[9] = proto;
        ns_wr16(pseudo + 10, (uint16_t)seg_len);
        sum = ns_csum_add(sum, pseudo, sizeof(pseudo));
    } else {
        uint8_t tail[4];
        uint8_t next[4] = { 0, 0, 0, proto };
        sum = ns_csum_add(sum, src, 16);
        sum = ns_csum_add(sum, dst, 16);
        ns_wr32(tail, (uint32_t)seg_len);
        sum = ns_csum_add(sum, tail, sizeof(tail));
        sum = ns_csum_add(sum, next, sizeof(next));
    }
    sum = ns_csum_add(sum, seg, seg_len);
    return ns_csum_fold(sum);
}

/* Return 1 when the first `bits` bits of addr and net are equal. */
static inline int ns_prefix_match(const uint8_t *addr, const uint8_t *net,
                                  int bits)
{
    int full = bits / 8;
    int rem = bits % 8;

    if (full && memcmp(addr, net, (size_t)full) != 0)
        return 0;
    if (rem) {
        uint8_t mask = (uint8_t)(0xff << (8 - rem));
        if ((addr[full] & mask) != (net[full] & mask))
            return 0;
    }
    return 1;
}

/* IPv4 addresses use b[0..3]; the rest of the bytes are zero by contract.
   Comparing the family-specific length keeps the helper correct even if a
   caller leaves padding uninitialised. */
static inline int ns_addr_eq(const NsAddr *a, const NsAddr *b)
{
    int family = ns_addr_family(a);
    size_t len;

    if (family != ns_addr_family(b))
        return 0;
    len = family == NS_AF_INET ? 4 : NS_ADDR_LEN;
    return memcmp(a->b, b->b, len) == 0;
}

static inline int ns_addr_unspecified(const NsAddr *a)
{
    int family = ns_addr_family(a);
    size_t len = family == NS_AF_INET ? 4 : NS_ADDR_LEN;
    size_t i;

    for (i = 0; i < len; i++)
        if (a->b[i])
            return 0;
    return 1;
}

static inline int ns_addr_multicast(const NsAddr *a)
{
    if (ns_addr_family(a) == NS_AF_INET)
        return (a->b[0] & 0xf0) == 0xe0;
    return a->b[0] == 0xff;
}

static inline int ns_addr_broadcast(const NsAddr *a)
{
    return ns_addr_family(a) == NS_AF_INET && a->b[0] == 0xff &&
           a->b[1] == 0xff && a->b[2] == 0xff && a->b[3] == 0xff;
}

#endif /* NETSTACK_UTIL_H */
