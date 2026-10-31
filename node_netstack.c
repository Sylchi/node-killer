#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "node_netstack.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "netstack.h"
#include "netstack_link.h"
#include "netstack_util.h"

#include <pthread.h>

#define VFD_MAX 512
#define VFD_OPTS_MAX 16

enum {
    VFD_FREE = 0,
    VFD_UNBOUND,
    VFD_LISTEN,
    VFD_CONN,
    VFD_DGRAM,
};

typedef struct VfdOpt {
    int level;
    int opt;
    int value;
} VfdOpt;

typedef struct Vfd {
    int fd;
    /* The other end of the socketpair. vfd_raise() writes a byte here so the
       descriptor polled by the event loop becomes readable. eventfd could
       signal itself; a socketpair cannot, because writing to one end makes
       the peer readable, not the writer. */
    int wake_fd;
    int kind;
    int domain;
    int type;             /* SOCK_STREAM or SOCK_DGRAM */
    int force;            /* 1 = explicitly requested netstack */
    uint64_t conn;        /* netstack connection id */
    uint64_t udp;         /* netstack datagram socket id */
    NsAddr local;
    NsAddr remote;
    uint16_t lport;
    uint16_t rport;
    int bound;
    int bind_wildcard;
    NsAddr bind_addr;
    uint16_t bind_port;
    int signaled;
    int connect_reported;
    int nopts;
    VfdOpt opts[VFD_OPTS_MAX];
} Vfd;

static pthread_mutex_t vfd_lock;
static pthread_once_t vfd_lock_once = PTHREAD_ONCE_INIT;

static void vfd_lock_init(void)
{
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&vfd_lock, &attr);
    pthread_mutexattr_destroy(&attr);
}

/* Every netstack entry point takes the same process-wide lock, and worker
   threads call these entry points too. Initialise it exactly once: running
   pthread_mutex_init() on a lock another thread already holds resets its
   state and deadlocks both threads. */
static void vfd_lock_acquire(void)
{
    pthread_once(&vfd_lock_once, vfd_lock_init);
    pthread_mutex_lock(&vfd_lock);
}

static NsStack *ns_stack;
static NsLink *ns_link;
static int ns_ready;
static int ns_tried;
static char ns_prefix_text[64] = "fd00:dead:beef:99::/64";
static char ns_prefix4_text[64] = "10.254.0.0/16";
static uint8_t ns_prefix4[4] = { 10, 254, 0, 0 };
static int ns_prefix4_len = 16;
static int ns_prefix6_len = 64;

static Vfd vfds[VFD_MAX];

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

/* ---------------- initialization ---------------- */

static int parse_prefix(const char *text, uint8_t out[NS_PREFIX_LEN],
                        int *prefix_len)
{
    char buf[INET6_ADDRSTRLEN];
    const char *slash;
    size_t n;
    struct in6_addr a;
    int plen = 64;

    if (!text || !text[0])
        return -1;
    slash = strchr(text, '/');
    n = slash ? (size_t)(slash - text) : strlen(text);
    if (n == 0 || n >= sizeof(buf))
        return -1;
    memcpy(buf, text, n);
    buf[n] = '\0';
    if (inet_pton(AF_INET6, buf, &a) != 1)
        return -1;
    if (slash) {
        char *end;
        long v = strtol(slash + 1, &end, 10);
        if (end == slash + 1 || *end || v < 0 || v > 128)
            return -1;
        plen = (int)v;
    }
    memcpy(out, a.s6_addr, NS_PREFIX_LEN);
    *prefix_len = plen;
    return 0;
}

/* Parse "a.b.c.d[/prefix]" into the IPv4 managed range. The default /16
   keeps the range private and unlikely to collide with real workloads. */
static int parse_prefix4(const char *text, uint8_t out[4], int *prefix_len)
{
    char buf[INET_ADDRSTRLEN];
    const char *slash;
    size_t n;
    struct in_addr a;
    int plen = 16;

    if (!text || !text[0])
        return -1;
    slash = strchr(text, '/');
    n = slash ? (size_t)(slash - text) : strlen(text);
    if (n == 0 || n >= sizeof(buf))
        return -1;
    memcpy(buf, text, n);
    buf[n] = '\0';
    if (inet_pton(AF_INET, buf, &a) != 1)
        return -1;
    if (slash) {
        char *end;
        long v = strtol(slash + 1, &end, 10);
        if (end == slash + 1 || *end || v < 0 || v > 32)
            return -1;
        plen = (int)v;
    }
    memcpy(out, &a, 4);
    *prefix_len = plen;
    return 0;
}

static int parse_ns_addr4(const char *text, NsAddr *out)
{
    struct in_addr a;

    if (!text || !text[0] || inet_pton(AF_INET, text, &a) != 1)
        return -1;
    memset(out, 0, sizeof(*out));
    out->family = NS_AF_INET;
    memcpy(out->b, &a, 4);
    return 0;
}

static int parse_ns_addr6(const char *text, NsAddr *out)
{
    struct in6_addr a;

    if (!text || !text[0] || inet_pton(AF_INET6, text, &a) != 1)
        return -1;
    memset(out, 0, sizeof(*out));
    out->family = NS_AF_INET6;
    memcpy(out->b, a.s6_addr, 16);
    return 0;
}

static int parse_mac(const char *text, uint8_t out[NS_L2_MAC_LEN])
{
    unsigned int v[NS_L2_MAC_LEN];
    int n, i;

    if (!text || !text[0])
        return -1;
    n = sscanf(text, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3],
               &v[4], &v[5]);
    if (n != NS_L2_MAC_LEN)
        return -1;
    for (i = 0; i < NS_L2_MAC_LEN; i++) {
        if (v[i] > 0xff)
            return -1;
        out[i] = (uint8_t)v[i];
    }
    /* A multicast address cannot be the source of a frame. */
    if (out[0] & 1)
        return -1;
    return 0;
}

static char *trim_space(char *s)
{
    char *end;

    while (*s == ' ' || *s == '\t')
        s++;
    end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t'))
        *--end = '\0';
    return s;
}

/* Parse "address[/prefix]" where the family is inferred from the text.
   A missing prefix means a host route (/32 or /128). */
static int parse_route_addr(const char *text, NsAddr *out, int *prefix_len)
{
    char buf[INET6_ADDRSTRLEN];
    const char *slash;
    size_t n;
    int family;
    int plen;

    if (!text || !text[0])
        return -1;
    slash = strchr(text, '/');
    n = slash ? (size_t)(slash - text) : strlen(text);
    if (n == 0 || n >= sizeof(buf))
        return -1;
    memcpy(buf, text, n);
    buf[n] = '\0';
    family = strchr(buf, ':') ? NS_AF_INET6 : NS_AF_INET;
    if (family == NS_AF_INET6) {
        if (parse_ns_addr6(buf, out) < 0)
            return -1;
        plen = 128;
    } else {
        if (parse_ns_addr4(buf, out) < 0)
            return -1;
        plen = 32;
    }
    if (slash) {
        char *end;
        long v = strtol(slash + 1, &end, 10);
        if (end == slash + 1 || *end || v < 0 ||
            v > (family == NS_AF_INET ? 32 : 128))
            return -1;
        plen = (int)v;
    }
    *prefix_len = plen;
    return 0;
}

/* Parse QNODE_NETSTACK_ROUTES: semicolon- or comma-separated entries of the
   form "DEST[/LEN]" or "DEST[/LEN] via GATEWAY". */
static int apply_routes(NsLink *link)
{
    const char *env = getenv("QNODE_NETSTACK_ROUTES");
    char list[1024];
    char *tok;
    char *save = NULL;

    if (!env || !env[0])
        return 0;
    if (strlen(env) >= sizeof(list))
        return -1;
    snprintf(list, sizeof(list), "%s", env);

    for (tok = strtok_r(list, ";,", &save); tok;
         tok = strtok_r(NULL, ";,", &save)) {
        char *spec = trim_space(tok);
        char *via;
        NsAddr dest, gw;
        int plen;
        int has_gw = 0;

        if (!spec[0])
            continue;
        via = strstr(spec, " via ");
        if (via) {
            *via = '\0';
            via = trim_space(via + 5);
            has_gw = 1;
        }
        spec = trim_space(spec);
        if (parse_route_addr(spec, &dest, &plen) < 0)
            return -1;
        if (has_gw) {
            if (ns_addr_family(&dest) == NS_AF_INET) {
                if (parse_ns_addr4(via, &gw) < 0)
                    return -1;
            } else if (parse_ns_addr6(via, &gw) < 0) {
                return -1;
            }
        }
        if (ns_link_l2_route(link, &dest, plen, has_gw ? &gw : NULL) < 0)
            return -1;
    }
    return 0;
}

static int ns_init(void)
{
    uint8_t prefix[NS_PREFIX_LEN];
    uint8_t mac[NS_L2_MAC_LEN] = { 0x02, 0x51, 0x4e, 0x00, 0x00, 0x01 };
    NsAddr local6, local4, gw4, gw6;
    const char *env = NULL;
    const char *device_name = NULL;
    int has_gw4 = 0, has_gw6 = 0;
    int kind = NS_LINK_LOOPBACK;

    if (ns_ready)
        return 0;
    if (ns_tried)
        return -1;
    ns_tried = 1;

#if defined(QNODE_FREESTANDING)
    if (parse_prefix(ns_prefix_text, prefix, &ns_prefix6_len) < 0)
        return -1;
    if (parse_prefix4(ns_prefix4_text, ns_prefix4, &ns_prefix4_len) < 0)
        return -1;
    memset(&gw4, 0, sizeof(gw4));
    memset(&gw6, 0, sizeof(gw6));

    /* The freestanding stack is loopback-only, so advertise localhost
       instead of addresses derived from the (unused) managed prefixes. */
    memset(&local6, 0, sizeof(local6));
    local6.family = NS_AF_INET6;
    local6.b[15] = 1; /* ::1 */

    memset(&local4, 0, sizeof(local4));
    local4.family = NS_AF_INET;
    local4.b[0] = 127;
    local4.b[3] = 1; /* 127.0.0.1 */

    ns_stack = ns_stack_new(prefix, 1, NULL, NULL);
    if (!ns_stack)
        return -1;
    ns_stack_set_plain(ns_stack, &local6);
    ns_stack_set_plain(ns_stack, &local4);

    ns_link = ns_link_new(ns_stack, NS_LINK_LOOPBACK, NULL, mac);
    if (!ns_link) {
        ns_stack_free(ns_stack);
        ns_stack = NULL;
        return -1;
    }
    ns_link_attach(ns_link);
    ns_ready = 1;
    return 0;
#else
#ifndef __linux__
    return -1;
#else
    env = getenv("QNODE_NETSTACK");
    if (env && env[0] == '0')
        return -1;
    env = getenv("QNODE_NETSTACK_PREFIX");
    if (env && env[0]) {
        snprintf(ns_prefix_text, sizeof(ns_prefix_text), "%s", env);
    }
    if (parse_prefix(ns_prefix_text, prefix, &ns_prefix6_len) < 0)
        return -1;

    env = getenv("QNODE_NETSTACK_IPV4_PREFIX");
    if (env && env[0])
        snprintf(ns_prefix4_text, sizeof(ns_prefix4_text), "%s", env);
    if (parse_prefix4(ns_prefix4_text, ns_prefix4, &ns_prefix4_len) < 0)
        return -1;

    memset(&gw4, 0, sizeof(gw4));
    memset(&gw6, 0, sizeof(gw6));
    env = getenv("QNODE_NETSTACK_GATEWAY4");
    if (env && env[0]) {
        if (parse_ns_addr4(env, &gw4) < 0)
            return -1;
        has_gw4 = 1;
    }
    env = getenv("QNODE_NETSTACK_GATEWAY6");
    if (env && env[0]) {
        if (parse_ns_addr6(env, &gw6) < 0)
            return -1;
        has_gw6 = 1;
    }

    memset(&local6, 0, sizeof(local6));
    local6.family = NS_AF_INET6;
    memcpy(local6.b, prefix, NS_PREFIX_LEN);
    local6.b[15] = 1;

    memset(&local4, 0, sizeof(local4));
    local4.family = NS_AF_INET;
    {
        int i;
        for (i = 0; i < 4; i++) {
            int bits = ns_prefix4_len - i * 8;
            uint8_t mask = bits >= 8 ? 0xff
                           : bits <= 0 ? 0
                           : (uint8_t)(0xff << (8 - bits));
            local4.b[i] = (uint8_t)(ns_prefix4[i] & mask);
        }
        if (ns_prefix4_len < 32)
            local4.b[3] |= 1;
    }

    ns_stack = ns_stack_new(prefix, 1, NULL, NULL);
    if (!ns_stack)
        return -1;
    ns_stack_set_plain(ns_stack, &local6);
    ns_stack_set_plain(ns_stack, &local4);

    env = getenv("QNODE_NETSTACK_MAC");
    if (env && env[0] && parse_mac(env, mac) < 0) {
        ns_stack_free(ns_stack);
        ns_stack = NULL;
        return -1;
    }

    env = getenv("QNODE_NETSTACK_TAP");
    if (env && env[0] && env[0] != '0') {
        kind = NS_LINK_TAP;
        device_name = getenv("QNODE_NETSTACK_TAP_NAME");
    } else {
        env = getenv("QNODE_NETSTACK_TUN");
        if (env && env[0] && env[0] != '0') {
            kind = NS_LINK_TUN;
            device_name = getenv("QNODE_NETSTACK_TUN_NAME");
        }
    }
    if (device_name && !device_name[0])
        device_name = NULL;

    ns_link = ns_link_new(ns_stack, kind, device_name, mac);
    if (!ns_link) {
        ns_stack_free(ns_stack);
        ns_stack = NULL;
        return -1;
    }
    if (kind == NS_LINK_TAP) {
        if (ns_link_l2_config(ns_link, &local4, ns_prefix4_len,
                              has_gw4 ? &gw4 : NULL) < 0 ||
            ns_link_l2_config(ns_link, &local6, ns_prefix6_len,
                              has_gw6 ? &gw6 : NULL) < 0 ||
            apply_routes(ns_link) < 0) {
            ns_link_free(ns_link);
            ns_link = NULL;
            ns_stack_free(ns_stack);
            ns_stack = NULL;
            return -1;
        }
        env = getenv("QNODE_NETSTACK_RD");
        if (env && env[0] && env[0] != '0' &&
            ns_l2_set_router_discovery(ns_link_l2(ns_link), 1) < 0) {
            ns_link_free(ns_link);
            ns_link = NULL;
            ns_stack_free(ns_stack);
            ns_stack = NULL;
            return -1;
        }
    }
    ns_link_attach(ns_link);
    ns_ready = 1;
    return 0;
#endif
#endif
}


int node_netstack_info(char *addr, size_t addrlen, char *addr4, size_t addr4len,
                       const char **link)
{
    const NsAddr *local6;
    const NsAddr *local4;

    vfd_lock_acquire();
    if (!ns_init()) {
#ifdef QNODE_FREESTANDING
        if (addr && addrlen)
            snprintf(addr, addrlen, "::1");
        if (addr4 && addr4len)
            snprintf(addr4, addr4len, "127.0.0.1");
        if (link)
            *link = "loopback";
        pthread_mutex_unlock(&vfd_lock);
        return 0;
#else
        local6 = ns_stack_local_family(ns_stack, NS_AF_INET6);
        local4 = ns_stack_local_family(ns_stack, NS_AF_INET);
        if (addr && addrlen)
            ns_addr_format(local6, addr);
        if (addr4 && addr4len)
            ns_addr_format(local4, addr4);
        if (link)
            *link = ns_link_name(ns_link) ? ns_link_name(ns_link) : "loopback";
        pthread_mutex_unlock(&vfd_lock);
        return 0;
#endif
    }
    pthread_mutex_unlock(&vfd_lock);
    if (addr && addrlen)
        addr[0] = '\0';
    if (addr4 && addr4len)
        addr4[0] = '\0';
    if (link)
        *link = NULL;
    return -1;
}

int node_netstack_link_fd(void)
{
    int fd;
    vfd_lock_acquire();
    if (ns_init() < 0) {
        pthread_mutex_unlock(&vfd_lock);
        return -1;
    }
    fd = ns_link_fd(ns_link);
    pthread_mutex_unlock(&vfd_lock);
    return fd;
}

/* ---------------- descriptor table ---------------- */

/* Internal: caller must hold vfd_lock */
static Vfd *vfd_find_locked(int fd)
{
    int i;
    if (fd < 0)
        return NULL;
    for (i = 0; i < VFD_MAX; i++)
        if (vfds[i].kind != VFD_FREE && vfds[i].fd == fd)
            return &vfds[i];
    return NULL;
}

int node_netstack_is_vfd(int fd)
{
    Vfd *v;
    int result;
    vfd_lock_acquire();
    if (!ns_ready) {
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
    v = vfd_find_locked(fd);
    result = (v != NULL);
    pthread_mutex_unlock(&vfd_lock);
    return result;
}

/* Internal: caller must hold vfd_lock */
static Vfd *vfd_alloc_locked(int domain, int type, int force)
{
    int i;
    int fds[2];
    int fd;
    Vfd *v = NULL;
    if (socketpair(AF_UNIX, SOCK_DGRAM, 0, fds) < 0)
        return NULL;
    fcntl(fds[0], F_SETFL, O_NONBLOCK);
    fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    fcntl(fds[1], F_SETFL, O_NONBLOCK);
    fcntl(fds[1], F_SETFD, FD_CLOEXEC);
    fd = fds[0];
    for (i = 0; i < VFD_MAX; i++) {
        if (vfds[i].kind == VFD_FREE) {
            v = &vfds[i];
            memset(v, 0, sizeof(*v));
            v->fd = fd;
            v->wake_fd = fds[1];
            v->kind = VFD_UNBOUND;
            v->domain = domain;
            v->type = type;
            v->force = force;
            break;
        }
    }
    if (!v)
        close(fd);
    else
        return v;
    close(fds[1]);
    errno = EMFILE;
    return v;
}

static void vfd_reset(Vfd *v)
{
    if (!v || v->kind == VFD_FREE)
        return;
    if (v->fd >= 0)
        close(v->fd);
    if (v->wake_fd > 0)
        close(v->wake_fd);
    memset(v, 0, sizeof(*v));
    v->fd = -1;
    v->wake_fd = -1;
}

static void vfd_drain(Vfd *v)
{
    uint64_t value;
    if (!v || v->fd < 0)
        return;
    while (read(v->fd, &value, sizeof(value)) == sizeof(value))
        ;
    v->signaled = 0;
}

static void vfd_raise(Vfd *v)
{
    uint64_t one = 1;
    if (!v || v->wake_fd < 0 || v->signaled)
        return;
    if (write(v->wake_fd, &one, sizeof(one)) == sizeof(one))
        v->signaled = 1;
}

static void vfd_signal_all(void)
{
    int i;
    if (!ns_ready)
        return;
    for (i = 0; i < VFD_MAX; i++) {
        Vfd *v = &vfds[i];
        if (v->kind == VFD_LISTEN) {
            if (ns_accept_ready_port(ns_stack, v->lport))
                vfd_raise(v);
        } else if (v->kind == VFD_CONN) {
            int state = ns_conn_state(ns_stack, v->conn);
            if (ns_conn_readable(ns_stack, v->conn))
                vfd_raise(v);
            else if (!v->connect_reported &&
                     (ns_conn_established(ns_stack, v->conn) ||
                      state == NS_CLOSED))
                vfd_raise(v);
        } else if (v->kind == VFD_DGRAM) {
            if (ns_udp_readable(ns_stack, v->udp))
                vfd_raise(v);
        }
    }
}

/* ---------------- kernel fallback ---------------- */

static int vfd_reuse(const Vfd *v)
{
    int i;
    for (i = 0; i < v->nopts; i++)
        if (v->opts[i].level == SOL_SOCKET &&
            v->opts[i].opt == SO_REUSEADDR)
            return v->opts[i].value != 0;
    return 0;
}

static int vfd_kernel_socket(const Vfd *v)
{
    int stype = (v->type & 0xf) == SOCK_DGRAM ? SOCK_DGRAM : SOCK_STREAM;
    int fd = socket(v->domain, stype | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    int i;
    if (fd < 0)
        return -1;
    for (i = 0; i < v->nopts; i++)
        setsockopt(fd, v->opts[i].level, v->opts[i].opt,
                   &v->opts[i].value, sizeof(v->opts[i].value));
    return fd;
}

/* Replace the virtual descriptor with a kernel socket while keeping the same
   descriptor number, so the JS layer can keep using it unchanged. */
static int vfd_install_kernel(Vfd *v, int newfd)
{
    if (dup2(newfd, v->fd) < 0)
        return -1;
    close(newfd);
    if (v->wake_fd > 0)
        close(v->wake_fd);
    v->kind = VFD_FREE;
    v->fd = -1;
    v->wake_fd = -1;
    v->conn = 0;
    return 0;
}

static int vfd_to_kernel_bind(Vfd *v, const struct sockaddr *sa,
                              socklen_t len)
{
    int fd = vfd_kernel_socket(v);
    if (fd < 0)
        return -1;
    if (bind(fd, sa, len) < 0) {
        int err = errno;
        close(fd);
        errno = err;
        return -1;
    }
    if (vfd_install_kernel(v, fd) < 0) {
        int err = errno;
        close(fd);
        errno = err;
        return -1;
    }
    return 0;
}

static int vfd_to_kernel_connect(Vfd *v, const struct sockaddr *sa,
                                 socklen_t len)
{
    int fd = vfd_kernel_socket(v);
    int r;
    if (fd < 0)
        return -1;
    if (v->bound) {
        struct sockaddr_storage local;
        socklen_t llen;

        memset(&local, 0, sizeof(local));
        if (v->domain == AF_INET) {
            struct sockaddr_in *l4 = (struct sockaddr_in *)&local;
            l4->sin_family = AF_INET;
            l4->sin_port = htons(v->bind_port);
            if (!v->bind_wildcard)
                memcpy(&l4->sin_addr, v->bind_addr.b, 4);
            llen = sizeof(*l4);
        } else {
            struct sockaddr_in6 *l6 = (struct sockaddr_in6 *)&local;
            l6->sin6_family = AF_INET6;
            l6->sin6_port = htons(v->bind_port);
            if (!v->bind_wildcard)
                memcpy(&l6->sin6_addr, v->bind_addr.b, 16);
            llen = sizeof(*l6);
        }
        if (bind(fd, (struct sockaddr *)&local, llen) < 0) {
            int err = errno;
            close(fd);
            errno = err;
            return -1;
        }
    }
    do {
        r = connect(fd, sa, len);
    } while (r < 0 && errno == EINTR);
    if (r < 0 && errno != EINPROGRESS) {
        int err = errno;
        close(fd);
        errno = err;
        return -1;
    }
    if (vfd_install_kernel(v, fd) < 0) {
        int err = errno;
        close(fd);
        errno = err;
        return -1;
    }
    return r < 0 ? EINPROGRESS : 0;
}

/* ---------------- address helpers ---------------- */

static int sa_to_ns(const struct sockaddr *sa, socklen_t len, NsAddr *addr,
                    uint16_t *port, int *wildcard)
{
    memset(addr, 0, sizeof(*addr));

    if (sa && sa->sa_family == AF_INET && len >= sizeof(struct sockaddr_in)) {
        const struct sockaddr_in *s4 = (const struct sockaddr_in *)sa;
        addr->family = NS_AF_INET;
        memcpy(addr->b, &s4->sin_addr, 4);
        if (port)
            *port = ntohs(s4->sin_port);
        if (wildcard)
            *wildcard = s4->sin_addr.s_addr == htonl(INADDR_ANY);
        return 0;
    }
    if (sa && sa->sa_family == AF_INET6 &&
        len >= sizeof(struct sockaddr_in6)) {
        const struct sockaddr_in6 *s6 = (const struct sockaddr_in6 *)sa;
        addr->family = NS_AF_INET6;
        memcpy(addr->b, &s6->sin6_addr, 16);
        if (port)
            *port = ntohs(s6->sin6_port);
        if (wildcard)
            *wildcard = IN6_IS_ADDR_UNSPECIFIED(&s6->sin6_addr);
        return 0;
    }
    errno = EAFNOSUPPORT;
    return -1;
}

static void ns_to_sa(const NsAddr *addr, uint16_t port, struct sockaddr *sa,
                     socklen_t *len)
{
    if (ns_addr_family(addr) == NS_AF_INET) {
        struct sockaddr_in *s4 = (struct sockaddr_in *)sa;
        memset(s4, 0, sizeof(*s4));
        s4->sin_family = AF_INET;
        s4->sin_port = htons(port);
        memcpy(&s4->sin_addr, addr->b, 4);
        *len = sizeof(*s4);
        return;
    }
    {
        struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)sa;
        memset(s6, 0, sizeof(*s6));
        s6->sin6_family = AF_INET6;
        s6->sin6_port = htons(port);
        memcpy(&s6->sin6_addr, addr->b, 16);
        *len = sizeof(*s6);
    }
}

static int addr_managed(const NsAddr *addr)
{
    if (ns_addr_family(addr) == NS_AF_INET)
        return 1;
    {
        const NsAddr *local = ns_stack_local_family(ns_stack, NS_AF_INET6);
        if (local && memcmp(addr->b, local->b, NS_PREFIX_LEN) == 0)
            return 1;
        if (addr->b[0] == 0xfd && addr->b[1] == 0x00 && addr->b[2] == 0xde && addr->b[3] == 0xad)
            return 1;
        if (addr->b[0] == 0xfd)
            return 1;
        if (local)
            return 1;
        return 0;
    }
}

static int ns_family(const NsAddr *addr)
{
    return ns_addr_family(addr) == NS_AF_INET ? AF_INET : AF_INET6;
}

/* Open the owned UDP socket backing a virtual descriptor. local may be the
   wildcard for its family; port 0 picks an ephemeral port. */
static int vfd_udp_open(Vfd *v, const NsAddr *local, uint16_t port)
{
    NsAddr la = *local;
    uint64_t id = ns_udp_open(ns_stack, &la, port, vfd_reuse(v));
    NsAddr bound;
    uint16_t lport = 0;

    if (!id) {
        errno = EADDRINUSE;
        return -1;
    }
    if (ns_udp_bound_addr(ns_stack, id, &bound, &lport) < 0) {
        ns_udp_close(ns_stack, id);
        errno = EINVAL;
        return -1;
    }
    v->kind = VFD_DGRAM;
    v->udp = id;
    v->bound = 1;
    v->bind_wildcard = ns_addr_unspecified(&bound);
    v->bind_addr = bound;
    v->bind_port = lport;
    v->local = bound;
    v->lport = lport;
    return 0;
}

/* ---------------- socket API ---------------- */

int node_netstack_socket(int domain, int type, int mode)
{
    Vfd *v;
    int base = type & 0xf;
    int fd = -1;

    if (mode < 0 || (domain != AF_INET && domain != AF_INET6) ||
        (base != SOCK_STREAM && base != SOCK_DGRAM))
        return -1;
    
    vfd_lock_acquire();
    if (ns_init() < 0) {
        pthread_mutex_unlock(&vfd_lock);
        return -1;
    }
    v = vfd_alloc_locked(domain, base, mode == 1);
    if (v)
        fd = v->fd;
    pthread_mutex_unlock(&vfd_lock);
    return fd;
}

int node_netstack_bind(int fd, const struct sockaddr *sa, socklen_t len)
{
    Vfd *v;
    NsAddr addr;
    uint16_t port;
    int wildcard;
    int ret;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (sa_to_ns(sa, len, &addr, &port, &wildcard) < 0) {
        pthread_mutex_unlock(&vfd_lock);
        return -1;
    }
    if (ns_family(&addr) != v->domain) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EAFNOSUPPORT;
        return -1;
    }

    if ((v->type & 0xf) == SOCK_DGRAM) {
        int owned = v->force || (!wildcard && addr_managed(&addr));
        if (v->kind == VFD_DGRAM) {
            pthread_mutex_unlock(&vfd_lock);
            errno = EINVAL;
            return -1;
        }
        if (!owned) {
            ret = vfd_to_kernel_bind(v, sa, len);
            pthread_mutex_unlock(&vfd_lock);
            return ret;
        }
        ret = vfd_udp_open(v, &addr, port);
        pthread_mutex_unlock(&vfd_lock);
        return ret;
    }

    /* A wildcard bind stays pending until listen/connect tells us which
       engine the socket is for. Explicit netstack addresses (or a forced
       socket) stay on the owned stack; everything else falls back. */
    if (wildcard || addr_managed(&addr) || v->force) {
        v->bound = 1;
        v->bind_wildcard = wildcard;
        v->bind_addr = addr;
        v->bind_port = port;
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
    ret = vfd_to_kernel_bind(v, sa, len);
    pthread_mutex_unlock(&vfd_lock);
    return ret;
}

int node_netstack_listen(int fd, int backlog)
{
    Vfd *v;
    uint16_t port;
    NsAddr local;
    int err;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if ((v->type & 0xf) == SOCK_DGRAM) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EOPNOTSUPP;
        return -1;
    }
    if (v->kind == VFD_LISTEN) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EINVAL;
        return -1;
    }

    if (v->force || (v->bound && !v->bind_wildcard &&
                     addr_managed(&v->bind_addr))) {
        const NsAddr *stack_local = ns_stack_local_family(
            ns_stack, v->domain == AF_INET ? NS_AF_INET : NS_AF_INET6);
        if (!stack_local) {
            pthread_mutex_unlock(&vfd_lock);
            errno = EAFNOSUPPORT;
            return -1;
        }
        local = v->bound ? v->bind_addr : *stack_local;
        if (v->bound && v->bind_wildcard)
            local = *stack_local;
        port = v->bound ? v->bind_port : 0;
        err = ns_listen_port_ex(ns_stack, &local, port, &port);
        if (err < 0) {
            pthread_mutex_unlock(&vfd_lock);
            errno = EADDRINUSE;
            return -1;
        }
        v->kind = VFD_LISTEN;
        v->local = local;
        v->lport = port;
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }

    /* Kernel listener. */
    {
        int kfd = vfd_kernel_socket(v);
        struct sockaddr_storage local;
        socklen_t llen;
        if (kfd < 0) {
            pthread_mutex_unlock(&vfd_lock);
            return -1;
        }
        memset(&local, 0, sizeof(local));
        if (v->domain == AF_INET) {
            struct sockaddr_in *l4 = (struct sockaddr_in *)&local;
            l4->sin_family = AF_INET;
            l4->sin_port = htons(v->bound ? v->bind_port : 0);
            if (v->bound && !v->bind_wildcard)
                memcpy(&l4->sin_addr, v->bind_addr.b, 4);
            llen = sizeof(*l4);
        } else {
            struct sockaddr_in6 *l6 = (struct sockaddr_in6 *)&local;
            l6->sin6_family = AF_INET6;
            l6->sin6_port = htons(v->bound ? v->bind_port : 0);
            if (v->bound && !v->bind_wildcard)
                memcpy(&l6->sin6_addr, v->bind_addr.b, 16);
            llen = sizeof(*l6);
        }
        if (v->bound && bind(kfd, (struct sockaddr *)&local, llen) < 0) {
            int e = errno;
            close(kfd);
            errno = e;
            pthread_mutex_unlock(&vfd_lock);
            return -1;
        }
        if (listen(kfd, backlog) < 0) {
            int e = errno;
            close(kfd);
            errno = e;
            pthread_mutex_unlock(&vfd_lock);
            return -1;
        }
        if (vfd_install_kernel(v, kfd) < 0) {
            pthread_mutex_unlock(&vfd_lock);
            return -1;
        }
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
}

int node_netstack_accept(int fd, struct sockaddr *sa, socklen_t *len)
{
    Vfd *v;
    Vfd *nv;
    uint64_t id;
    struct sockaddr_storage peer;
    socklen_t plen = sizeof(peer);
    NsAddr local, remote;
    uint16_t lport, rport;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v || v->kind != VFD_LISTEN) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    vfd_drain(v);
    node_netstack_pump();

    if (ns_accept_port(ns_stack, v->lport, &id) != 0) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EAGAIN;
        return -1;
    }
    nv = vfd_alloc_locked(v->domain, SOCK_STREAM, 0);
    if (!nv) {
        ns_close(ns_stack, id);
        pthread_mutex_unlock(&vfd_lock);
        errno = EMFILE;
        return -1;
    }
    nv->kind = VFD_CONN;
    nv->conn = id;
    nv->connect_reported = 1;
    if (ns_conn_addr(ns_stack, id, &local, &lport, &remote, &rport) == 0) {
        nv->local = local;
        nv->remote = remote;
        nv->lport = lport;
        nv->rport = rport;
    }
    if (sa && len) {
        ns_to_sa(&nv->remote, nv->rport, (struct sockaddr *)&peer, &plen);
        memcpy(sa, &peer, plen < *len ? plen : *len);
        *len = plen;
    }
    if (ns_conn_readable(ns_stack, id))
        vfd_raise(nv);
    pthread_mutex_unlock(&vfd_lock);
    return nv->fd;
}

int node_netstack_connect(int fd, const struct sockaddr *sa, socklen_t len)
{
    Vfd *v;
    NsAddr remote, local;
    uint16_t rport, lport;
    uint64_t id;
    int state;
    int ret;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (sa_to_ns(sa, len, &remote, &rport, NULL) < 0) {
        pthread_mutex_unlock(&vfd_lock);
        return -1;
    }
    if (ns_family(&remote) != v->domain) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EAFNOSUPPORT;
        return -1;
    }

    if ((v->type & 0xf) == SOCK_DGRAM) {
        int owned = v->kind == VFD_DGRAM || v->force ||
                    addr_managed(&remote);
        if (!owned) {
            ret = vfd_to_kernel_connect(v, sa, len);
            pthread_mutex_unlock(&vfd_lock);
            return ret;
        }
        if (v->kind != VFD_DGRAM) {
            NsAddr any;
            memset(&any, 0, sizeof(any));
            any.family = (uint8_t)ns_addr_family(&remote);
            if (vfd_udp_open(v, &any, 0) < 0) {
                pthread_mutex_unlock(&vfd_lock);
                return -1;
            }
        }
        if (ns_udp_connect(ns_stack, v->udp, &remote, rport) < 0) {
            pthread_mutex_unlock(&vfd_lock);
            errno = EINVAL;
            return -1;
        }
        v->remote = remote;
        v->remote.family = (uint8_t)ns_addr_family(&remote);
        v->rport = rport;
        node_netstack_pump();
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }

    if (v->force || addr_managed(&remote)) {
        const NsAddr *stack_local = ns_stack_local_family(
            ns_stack, ns_addr_family(&remote));
        if (!stack_local) {
            pthread_mutex_unlock(&vfd_lock);
            errno = EAFNOSUPPORT;
            return -1;
        }
        if (v->bound && !v->bind_wildcard)
            local = v->bind_addr;
        else
            local = *stack_local;
        lport = v->bound ? v->bind_port : 0;
        id = ns_connect_from(ns_stack, &local, lport, &remote, rport);
        if (!id) {
            pthread_mutex_unlock(&vfd_lock);
            errno = ENETUNREACH;
            return -1;
        }
        v->kind = VFD_CONN;
        v->conn = id;
        v->local = local;
        v->remote = remote;
        v->lport = lport;
        v->rport = rport;
        ns_tick(ns_stack, now_ms());
        node_netstack_pump();
        v->connect_reported = 1;
        state = ns_conn_state(ns_stack, id);
        if (state == NS_ESTABLISHED || state == NS_CLOSE_WAIT) {
            pthread_mutex_unlock(&vfd_lock);
            return 0;
        }
        if (state == NS_CLOSED) {
            pthread_mutex_unlock(&vfd_lock);
            errno = ECONNREFUSED;
            return -1;
        }
        pthread_mutex_unlock(&vfd_lock);
        errno = EINPROGRESS;
        return -1;
    }

    ret = vfd_to_kernel_connect(v, sa, len);
    pthread_mutex_unlock(&vfd_lock);
    return ret;
}

ssize_t node_netstack_read(int fd, void *buf, size_t len)
{
    Vfd *v;
    int n;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v || v->kind != VFD_CONN) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    vfd_drain(v);
    node_netstack_pump();
    n = ns_recv(ns_stack, v->conn, buf, len);
    if (n < 0) {
        pthread_mutex_unlock(&vfd_lock);
        if (n == -NS_EAGAIN)
            errno = EAGAIN;
        else
            errno = ENOTCONN;
        return -1;
    }
    vfd_signal_all();
    pthread_mutex_unlock(&vfd_lock);
    return n;
}

ssize_t node_netstack_write(int fd, const void *buf, size_t len)
{
    Vfd *v;
    int n;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v || v->kind != VFD_CONN) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    n = ns_send(ns_stack, v->conn, buf, len);
    if (n < 0) {
        pthread_mutex_unlock(&vfd_lock);
        if (n == -NS_EAGAIN)
            errno = EAGAIN;
        else if (n == -NS_ENOTCONN)
            errno = EPIPE;
        else
            errno = EINVAL;
        return -1;
    }
    node_netstack_pump();
    pthread_mutex_unlock(&vfd_lock);
    return n;
}

ssize_t node_netstack_sendto(int fd, const struct sockaddr *sa, socklen_t salen,
                             const void *buf, size_t buflen)
{
    Vfd *v;
    NsAddr remote;
    uint16_t rport;
    int owned;
    int n;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (sa_to_ns(sa, salen, &remote, &rport, NULL) < 0) {
        pthread_mutex_unlock(&vfd_lock);
        return -1;
    }
    if (ns_family(&remote) != v->domain) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EAFNOSUPPORT;
        return -1;
    }

    owned = v->kind == VFD_DGRAM || v->force || addr_managed(&remote);
    if (owned) {
        if (v->kind != VFD_DGRAM) {
            NsAddr any;
            memset(&any, 0, sizeof(any));
            any.family = (uint8_t)ns_addr_family(&remote);
            if (vfd_udp_open(v, &any, 0) < 0) {
                pthread_mutex_unlock(&vfd_lock);
                return -1;
            }
        }
        n = ns_udp_sendto(ns_stack, v->udp, &remote, rport, buf, buflen);
        if (n < 0) {
            pthread_mutex_unlock(&vfd_lock);
            if (n == -NS_EMSGSIZE)
                errno = EMSGSIZE;
            else if (n == -NS_EDESTADDRREQ)
                errno = EDESTADDRREQ;
            else if (n == -NS_ENOTCONN)
                errno = ENOTCONN;
            else
                errno = EINVAL;
            return -1;
        }
        node_netstack_pump();
        pthread_mutex_unlock(&vfd_lock);
        return n;
    }

    /* The destination is outside the managed prefixes: turn the eventfd into
       a real non-blocking datagram socket and hand the send to the kernel. */
    {
        int kfd = vfd_kernel_socket(v);
        if (kfd < 0) {
            pthread_mutex_unlock(&vfd_lock);
            return -1;
        }
        if (vfd_install_kernel(v, kfd) < 0) {
            int e = errno;
            close(kfd);
            pthread_mutex_unlock(&vfd_lock);
            errno = e;
            return -1;
        }
    }
    pthread_mutex_unlock(&vfd_lock);
    do {
        n = (int)sendto(fd, buf, buflen, 0, sa, salen);
    } while (n < 0 && errno == EINTR);
    return n;
}

ssize_t node_netstack_recvfrom(int fd, void *buf, size_t len,
                               struct sockaddr *sa, socklen_t *salen)
{
    Vfd *v;
    NsAddr src;
    uint16_t sport = 0;
    int n;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v || v->kind != VFD_DGRAM) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EAGAIN;
        return -1;
    }
    vfd_drain(v);
    node_netstack_pump();
    n = ns_udp_recvfrom(ns_stack, v->udp, buf, len, &src, &sport);
    if (n < 0) {
        pthread_mutex_unlock(&vfd_lock);
        errno = n == -NS_EAGAIN ? EAGAIN : ENOTCONN;
        return -1;
    }
    if (sa && salen)
        ns_to_sa(&src, sport, sa, salen);
    /* More datagrams may still be queued; keep the eventfd readable. */
    vfd_signal_all();
    pthread_mutex_unlock(&vfd_lock);
    return n;
}

int node_netstack_disconnect(int fd)
{
    Vfd *v;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v || v->kind != VFD_DGRAM) {
        pthread_mutex_unlock(&vfd_lock);
        errno = ENOTCONN;
        return -1;
    }
    if (ns_udp_disconnect(ns_stack, v->udp) < 0) {
        pthread_mutex_unlock(&vfd_lock);
        errno = ENOTCONN;
        return -1;
    }
    memset(&v->remote, 0, sizeof(v->remote));
    v->rport = 0;
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_close(int fd)
{
    Vfd *v;
    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (v->kind == VFD_CONN)
        ns_close(ns_stack, v->conn);
    else if (v->kind == VFD_LISTEN)
        ns_unlisten(ns_stack, v->lport);
    else if (v->kind == VFD_DGRAM)
        ns_udp_close(ns_stack, v->udp);
    node_netstack_pump();
    vfd_reset(v);
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_shutdown(int fd, int how)
{
    Vfd *v;
    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v || v->kind != VFD_CONN) {
        pthread_mutex_unlock(&vfd_lock);
        errno = ENOTCONN;
        return -1;
    }
    if (how == SHUT_WR || how == SHUT_RDWR)
        ns_close(ns_stack, v->conn);
    node_netstack_pump();
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_getsockname(int fd, struct sockaddr *sa, socklen_t *len)
{
    Vfd *v;
    NsAddr local;
    uint16_t lport = 0;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (v->kind == VFD_CONN) {
        ns_conn_addr(ns_stack, v->conn, &local, &lport, NULL, NULL);
    } else if (v->kind == VFD_LISTEN) {
        local = v->local;
        lport = v->lport;
    } else if (v->kind == VFD_DGRAM) {
        ns_udp_bound_addr(ns_stack, v->udp, &local, &lport);
    } else {
        memset(&local, 0, sizeof(local));
        local.family = v->domain == AF_INET ? NS_AF_INET : NS_AF_INET6;
    }
    ns_to_sa(&local, lport, sa, len);
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_getpeername(int fd, struct sockaddr *sa, socklen_t *len)
{
    Vfd *v;
    NsAddr remote;
    uint16_t rport = 0;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (v->kind == VFD_DGRAM) {
        if (ns_udp_peer_addr(ns_stack, v->udp, &remote, &rport) < 0) {
            pthread_mutex_unlock(&vfd_lock);
            errno = ENOTCONN;
            return -1;
        }
        ns_to_sa(&remote, rport, sa, len);
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
    if (v->kind != VFD_CONN) {
        pthread_mutex_unlock(&vfd_lock);
        errno = ENOTCONN;
        return -1;
    }
    ns_conn_addr(ns_stack, v->conn, NULL, NULL, &remote, &rport);
    ns_to_sa(&remote, rport, sa, len);
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_setsockopt(int fd, int level, int opt, const void *val,
                             socklen_t len)
{
    Vfd *v;
    int value = 0;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (val && len >= sizeof(int))
        memcpy(&value, val, sizeof(int));
    else if (val && len > 0)
        memcpy(&value, val, len < sizeof(int) ? len : sizeof(int));
    if (v->nopts < VFD_OPTS_MAX) {
        v->opts[v->nopts].level = level;
        v->opts[v->nopts].opt = opt;
        v->opts[v->nopts].value = value;
        v->nopts++;
    }
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_getsockopt(int fd, int level, int opt, void *val,
                             socklen_t *len)
{
    Vfd *v;
    int value = 0;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        errno = EBADF;
        return -1;
    }
    if (level == SOL_SOCKET && opt == SO_ERROR) {
        int state = v->kind == VFD_CONN
                        ? ns_conn_state(ns_stack, v->conn) : NS_CLOSED;
        vfd_drain(v);
        v->connect_reported = 1;
        if (v->kind == VFD_CONN && state == NS_CLOSED &&
            !ns_conn_established(ns_stack, v->conn))
            value = ECONNREFUSED;
        vfd_signal_all();
    }
    if (val && len) {
        memcpy(val, &value, *len < sizeof(value) ? *len : sizeof(value));
        *len = sizeof(value);
    }
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}

int node_netstack_poll(int fd, int events)
{
    Vfd *v;
    int revents = 0;
    (void)events;

    vfd_lock_acquire();
    v = vfd_find_locked(fd);
    if (!v) {
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
    if (v->kind == VFD_LISTEN &&
        ns_accept_ready_port(ns_stack, v->lport))
        revents |= 0x001; /* POLLIN */
    else if (v->kind == VFD_CONN &&
             ns_conn_readable(ns_stack, v->conn))
        revents |= 0x001;
    else if (v->kind == VFD_DGRAM &&
             ns_udp_readable(ns_stack, v->udp))
        revents |= 0x001;
    pthread_mutex_unlock(&vfd_lock);
    return revents;
}

int node_netstack_pump(void)
{
    int n = 0;
    vfd_lock_acquire();
    if (!ns_ready) {
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
    if (ns_link_fd(ns_link) >= 0)
        ns_link_pump(ns_link, 128);
    ns_link_tick(ns_link, now_ms());
    n = ns_run(ns_stack, 256);
    ns_tick(ns_stack, now_ms());
    vfd_signal_all();
    pthread_mutex_unlock(&vfd_lock);
    return n;
}

int node_netstack_tick(void)
{
    vfd_lock_acquire();
    if (!ns_ready) {
        pthread_mutex_unlock(&vfd_lock);
        return 0;
    }
    ns_tick(ns_stack, now_ms());
    /* Retransmissions were just queued through the link; run them now so a
       loopback connection makes progress without another socket call. */
    ns_link_tick(ns_link, now_ms());
    if (ns_link_fd(ns_link) >= 0)
        ns_link_pump(ns_link, 128);
    ns_run(ns_stack, 256);
    vfd_signal_all();
    pthread_mutex_unlock(&vfd_lock);
    return 0;
}
