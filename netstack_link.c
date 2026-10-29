#define _GNU_SOURCE
#include "netstack_link.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <sys/ioctl.h>
#include <sys/socket.h>

#ifdef __linux__
#include <linux/if.h>
#include <linux/if_tun.h>
#endif

struct NsLink {
    NsStack *stack;
    NsL2 *l2;
    int kind;
    int fd;
    char name[IFNAMSIZ];
};

static int link_write(NsLink *link, const uint8_t *pkt, size_t len)
{
    if (link->fd < 0) {
        errno = ENODEV;
        return -1;
    }
    for (;;) {
        ssize_t n = write(link->fd, pkt, len);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return 0; /* dropped; TCP will retransmit */
            return -1;
        }
        return (int)n;
    }
}

static void tap_frame_send(NsL2 *l2, const uint8_t *frame, size_t len,
                           void *opaque)
{
    NsLink *link = opaque;
    (void)l2;
    if (!link)
        return;
    link_write(link, frame, len);
}

static void link_stack_send(NsStack *stack, const uint8_t *pkt, size_t len,
                            void *opaque)
{
    NsLink *link = opaque;
    (void)stack;
    if (!link)
        return;
    if (link->kind == NS_LINK_TAP && link->l2) {
        ns_l2_send_ip(link->l2, pkt, len);
        return;
    }
    ns_link_send(link, pkt, len);
}

static int link_open_device(NsLink *link, const char *name, int tap)
{
#ifdef __linux__
    struct ifreq ifr;
    int fd = open("/dev/net/tun", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0)
        return -1;
    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_flags = (short)((tap ? IFF_TAP : IFF_TUN) | IFF_NO_PI);
    if (name)
        snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", name);
    if (ioctl(fd, TUNSETIFF, &ifr) < 0) {
        int err = errno;
        close(fd);
        errno = err;
        return -1;
    }
    snprintf(link->name, sizeof(link->name), "%s", ifr.ifr_name);
    link->fd = fd;
    return 0;
#else
    (void)link;
    (void)name;
    (void)tap;
    errno = ENOSYS;
    return -1;
#endif
}

NsLink *ns_link_new(NsStack *stack, int kind, const char *device_name,
                    const uint8_t mac[NS_L2_MAC_LEN])
{
    static const uint8_t default_mac[NS_L2_MAC_LEN] = {
        0x02, 0x51, 0x4e, 0x00, 0x00, 0x01
    };
    NsLink *link;

    if (!stack)
        return NULL;
    link = calloc(1, sizeof(*link));
    if (!link)
        return NULL;
    link->stack = stack;
    link->kind = kind;
    link->fd = -1;

    if (kind == NS_LINK_TUN || kind == NS_LINK_TAP) {
        if (link_open_device(link, device_name, kind == NS_LINK_TAP) < 0) {
            int err = errno;
            free(link);
            errno = err;
            return NULL;
        }
    } else if (kind != NS_LINK_LOOPBACK) {
        free(link);
        errno = EINVAL;
        return NULL;
    }

    if (kind == NS_LINK_TAP) {
        link->l2 = ns_l2_new(stack, mac ? mac : default_mac, tap_frame_send,
                             link);
        if (!link->l2) {
            int err = errno;
            if (link->fd >= 0)
                close(link->fd);
            free(link);
            errno = err ? err : EINVAL;
            return NULL;
        }
    }
    return link;
}

void ns_link_free(NsLink *link)
{
    if (!link)
        return;
    ns_l2_free(link->l2);
    if (link->fd >= 0)
        close(link->fd);
    free(link);
}

int ns_link_fd(const NsLink *link)
{
    return link ? link->fd : -1;
}

void ns_link_attach(NsLink *link)
{
    if (!link)
        return;
    if (link->kind == NS_LINK_TAP && link->l2) {
        ns_l2_attach(link->l2);
        return;
    }
    ns_stack_set_send(link->stack, link_stack_send, link);
}

const char *ns_link_name(const NsLink *link)
{
    if (!link || (link->kind != NS_LINK_TUN && link->kind != NS_LINK_TAP))
        return NULL;
    return link->name;
}

int ns_link_send(NsLink *link, const uint8_t *pkt, size_t len)
{
    if (!link || !pkt || len == 0)
        return -1;

    if (link->kind == NS_LINK_LOOPBACK) {
        ns_input(link->stack, pkt, len);
        return (int)len;
    }
    if (link->kind == NS_LINK_TAP && link->l2)
        return ns_l2_send_ip(link->l2, pkt, len);
    return link_write(link, pkt, len);
}

int ns_link_pump(NsLink *link, int budget)
{
    uint8_t pkt[NS_MAX_PACKET];
    int processed = 0;

    if (!link || budget <= 0)
        return 0;
    if (link->kind == NS_LINK_LOOPBACK)
        return 0;

    while (processed < budget) {
        ssize_t n = read(link->fd, pkt, sizeof(pkt));
        if (n < 0) {
            if (errno == EINTR)
                continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;
            return -1;
        }
        if (n == 0)
            break;
        if (link->kind == NS_LINK_TAP && link->l2)
            ns_l2_input(link->l2, pkt, (size_t)n);
        else
            ns_input(link->stack, pkt, (size_t)n);
        processed++;
    }
    return processed;
}

void ns_link_tick(NsLink *link, uint64_t now_ms)
{
    if (link && link->kind == NS_LINK_TAP && link->l2)
        ns_l2_tick(link->l2, now_ms);
}

int ns_link_l2_config(NsLink *link, const NsAddr *local, int prefix_len,
                      const NsAddr *gateway)
{
    if (!link || link->kind != NS_LINK_TAP || !link->l2)
        return -NS_EINVAL;
    if (ns_addr_family(local) == NS_AF_INET)
        return ns_l2_set_ipv4(link->l2, local, prefix_len, gateway);
    return ns_l2_set_ipv6(link->l2, local, prefix_len, gateway);
}

int ns_link_l2_route(NsLink *link, const NsAddr *dest, int prefix_len,
                     const NsAddr *gateway)
{
    if (!link || link->kind != NS_LINK_TAP || !link->l2)
        return -NS_EINVAL;
    return ns_l2_add_route(link->l2, dest, prefix_len, gateway);
}

NsL2 *ns_link_l2(NsLink *link)
{
    return link ? link->l2 : NULL;
}
