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
    int kind;
    int fd;
    char name[IFNAMSIZ];
};

static void link_stack_send(NsStack *stack, const uint8_t *pkt, size_t len,
                            void *opaque)
{
    NsLink *link = opaque;
    (void)stack;
    if (!link)
        return;
    ns_link_send(link, pkt, len);
}

static int link_open_tun(NsLink *link, const char *name)
{
#ifdef __linux__
    struct ifreq ifr;
    int fd = open("/dev/net/tun", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0)
        return -1;
    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
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
    errno = ENOSYS;
    return -1;
#endif
}

NsLink *ns_link_new(NsStack *stack, int kind, const char *tun_name)
{
    NsLink *link;

    if (!stack)
        return NULL;
    link = calloc(1, sizeof(*link));
    if (!link)
        return NULL;
    link->stack = stack;
    link->kind = kind;
    link->fd = -1;

    if (kind == NS_LINK_TUN) {
        if (link_open_tun(link, tun_name) < 0) {
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
    return link;
}

void ns_link_free(NsLink *link)
{
    if (!link)
        return;
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
    ns_stack_set_send(link->stack, link_stack_send, link);
}

const char *ns_link_name(const NsLink *link)
{
    if (!link || link->kind != NS_LINK_TUN)
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
        ns_input(link->stack, pkt, (size_t)n);
        processed++;
    }
    return processed;
}
