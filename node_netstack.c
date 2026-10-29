#define _GNU_SOURCE
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

#ifdef __linux__
#include <sys/eventfd.h>
#endif

#include "netstack.h"
#include "netstack_link.h"

#define VFD_MAX 512
#define VFD_OPTS_MAX 16

enum {
    VFD_FREE = 0,
    VFD_UNBOUND,
    VFD_LISTEN,
    VFD_CONN,
};

typedef struct VfdOpt {
    int level;
    int opt;
    int value;
} VfdOpt;

typedef struct Vfd {
    int fd;
    int kind;
    int domain;
    int force;            /* 1 = explicitly requested netstack */
    uint64_t conn;        /* netstack connection id */
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

static NsStack *ns_stack;
static NsLink *ns_link;
static int ns_ready;
static int ns_tried;
static char ns_prefix_text[64] = "fd00:dead:beef:99::/64";

static Vfd vfds[VFD_MAX];

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

/* ---------------- initialization ---------------- */

static int parse_prefix(const char *text, uint8_t out[NS_PREFIX_LEN])
{
    char buf[INET6_ADDRSTRLEN];
    const char *slash;
    size_t n;
    struct in6_addr a;

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
    memcpy(out, a.s6_addr, NS_PREFIX_LEN);
    return 0;
}

static int ns_init(void)
{
    uint8_t prefix[NS_PREFIX_LEN];
    NsAddr local;
    const char *env;
    const char *tun_name = NULL;
    int kind = NS_LINK_LOOPBACK;

    if (ns_ready)
        return 0;
    if (ns_tried)
        return -1;
    ns_tried = 1;

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
    if (parse_prefix(ns_prefix_text, prefix) < 0)
        return -1;

    memset(&local, 0, sizeof(local));
    memcpy(local.b, prefix, NS_PREFIX_LEN);
    local.b[15] = 1; /* the stack's stable local address */

    ns_stack = ns_stack_new(prefix, 1, NULL, NULL);
    if (!ns_stack)
        return -1;
    ns_stack_set_plain(ns_stack, &local);

    env = getenv("QNODE_NETSTACK_TUN");
    if (env && env[0] && env[0] != '0') {
        kind = NS_LINK_TUN;
        tun_name = getenv("QNODE_NETSTACK_TUN_NAME");
        if (tun_name && !tun_name[0])
            tun_name = NULL;
    }
    ns_link = ns_link_new(ns_stack, kind, tun_name);
    if (!ns_link) {
        ns_stack_free(ns_stack);
        ns_stack = NULL;
        return -1;
    }
    ns_link_attach(ns_link);
    ns_ready = 1;
    return 0;
#endif
}

int node_netstack_info(char *addr, size_t addrlen, const char **link)
{
    const NsAddr *local;

    if (!ns_init()) {
        local = ns_stack_local(ns_stack);
        if (addr && addrlen)
            ns_addr_format(local, addr);
        if (link)
            *link = ns_link_name(ns_link) ? ns_link_name(ns_link) : "loopback";
        return 0;
    }
    if (addr && addrlen)
        addr[0] = '\0';
    if (link)
        *link = NULL;
    return -1;
}

int node_netstack_link_fd(void)
{
    if (ns_init() < 0)
        return -1;
    return ns_link_fd(ns_link);
}

/* ---------------- descriptor table ---------------- */

static Vfd *vfd_find(int fd)
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
    if (!ns_ready)
        return 0;
    return vfd_find(fd) != NULL;
}

static Vfd *vfd_alloc(int domain, int force)
{
    int i;
    int fd;
#ifdef __linux__
    fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
#else
    fd = -1;
#endif
    if (fd < 0)
        return NULL;
    for (i = 0; i < VFD_MAX; i++) {
        if (vfds[i].kind == VFD_FREE) {
            Vfd *v = &vfds[i];
            memset(v, 0, sizeof(*v));
            v->fd = fd;
            v->kind = VFD_UNBOUND;
            v->domain = domain;
            v->force = force;
            return v;
        }
    }
    close(fd);
    errno = EMFILE;
    return NULL;
}

static void vfd_reset(Vfd *v)
{
    if (!v || v->kind == VFD_FREE)
        return;
    if (v->fd >= 0)
        close(v->fd);
    memset(v, 0, sizeof(*v));
    v->fd = -1;
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
    if (!v || v->fd < 0 || v->signaled)
        return;
    if (write(v->fd, &one, sizeof(one)) == sizeof(one))
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
        }
    }
}

/* ---------------- kernel fallback ---------------- */

static int vfd_kernel_socket(const Vfd *v)
{
    int fd = socket(v->domain, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    int i;
    if (fd < 0)
        return -1;
    for (i = 0; i < v->nopts; i++)
        setsockopt(fd, v->opts[i].level, v->opts[i].opt,
                   &v->opts[i].value, sizeof(v->opts[i].value));
    return fd;
}

/* Replace the eventfd with a kernel socket while keeping the same descriptor
   number, so the JS layer can keep using it unchanged. */
static int vfd_install_kernel(Vfd *v, int newfd)
{
    if (dup2(newfd, v->fd) < 0)
        return -1;
    close(newfd);
    v->kind = VFD_FREE;
    v->fd = -1;
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
        struct sockaddr_in6 local;
        memset(&local, 0, sizeof(local));
        local.sin6_family = AF_INET6;
        local.sin6_port = htons(v->bind_port);
        if (v->bind_wildcard)
            local.sin6_addr = in6addr_any;
        else
            memcpy(&local.sin6_addr, v->bind_addr.b, 16);
        if (bind(fd, (struct sockaddr *)&local, sizeof(local)) < 0) {
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
    const struct sockaddr_in6 *s6;

    if (!sa || sa->sa_family != AF_INET6 || len < sizeof(*s6)) {
        errno = EAFNOSUPPORT;
        return -1;
    }
    s6 = (const struct sockaddr_in6 *)sa;
    memcpy(addr->b, &s6->sin6_addr, 16);
    if (port)
        *port = ntohs(s6->sin6_port);
    if (wildcard)
        *wildcard = IN6_IS_ADDR_UNSPECIFIED(&s6->sin6_addr);
    return 0;
}

static void ns_to_sa(const NsAddr *addr, uint16_t port, struct sockaddr *sa,
                     socklen_t *len)
{
    struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)sa;
    memset(s6, 0, sizeof(*s6));
    s6->sin6_family = AF_INET6;
    s6->sin6_port = htons(port);
    memcpy(&s6->sin6_addr, addr->b, 16);
    *len = sizeof(*s6);
}

static int addr_managed(const NsAddr *addr)
{
    const NsAddr *local = ns_stack_local(ns_stack);
    return memcmp(addr->b, local->b, NS_PREFIX_LEN) == 0;
}

/* ---------------- socket API ---------------- */

int node_netstack_socket(int domain, int type, int mode)
{
    Vfd *v;

    if (mode < 0 || domain != AF_INET6 || (type & 0xf) != SOCK_STREAM)
        return -1;
    if (!ns_init()) {
        v = vfd_alloc(domain, mode == 1);
        if (!v)
            return -1;
        return v->fd;
    }
    return -1;
}

int node_netstack_bind(int fd, const struct sockaddr *sa, socklen_t len)
{
    Vfd *v = vfd_find(fd);
    NsAddr addr;
    uint16_t port;
    int wildcard;

    if (!v) {
        errno = EBADF;
        return -1;
    }
    if (sa_to_ns(sa, len, &addr, &port, &wildcard) < 0)
        return -1;

    /* A wildcard bind stays pending until listen/connect tells us which
       engine the socket is for. Explicit netstack addresses (or a forced
       socket) stay on the owned stack; everything else falls back. */
    if (wildcard || addr_managed(&addr) || v->force) {
        v->bound = 1;
        v->bind_wildcard = wildcard;
        v->bind_addr = addr;
        v->bind_port = port;
        return 0;
    }
    return vfd_to_kernel_bind(v, sa, len);
}

int node_netstack_listen(int fd, int backlog)
{
    Vfd *v = vfd_find(fd);
    uint16_t port;
    NsAddr local;
    int err;

    if (!v) {
        errno = EBADF;
        return -1;
    }
    if (v->kind == VFD_LISTEN) {
        errno = EINVAL;
        return -1;
    }

    if (v->force || (v->bound && !v->bind_wildcard &&
                     addr_managed(&v->bind_addr))) {
        local = v->bound ? v->bind_addr : *ns_stack_local(ns_stack);
        if (v->bound && v->bind_wildcard)
            local = *ns_stack_local(ns_stack);
        port = v->bound ? v->bind_port : 0;
        err = ns_listen_port_ex(ns_stack, &local, port, &port);
        if (err < 0) {
            errno = EADDRINUSE;
            return -1;
        }
        v->kind = VFD_LISTEN;
        v->local = local;
        v->lport = port;
        return 0;
    }

    /* Kernel listener. */
    {
        int kfd = vfd_kernel_socket(v);
        struct sockaddr_in6 local6;
        socklen_t llen;
        if (kfd < 0)
            return -1;
        memset(&local6, 0, sizeof(local6));
        local6.sin6_family = AF_INET6;
        local6.sin6_port = htons(v->bound ? v->bind_port : 0);
        if (v->bound && !v->bind_wildcard)
            memcpy(&local6.sin6_addr, v->bind_addr.b, 16);
        else
            local6.sin6_addr = in6addr_any;
        llen = sizeof(local6);
        if (v->bound && bind(kfd, (struct sockaddr *)&local6, llen) < 0) {
            int e = errno;
            close(kfd);
            errno = e;
            return -1;
        }
        if (listen(kfd, backlog) < 0) {
            int e = errno;
            close(kfd);
            errno = e;
            return -1;
        }
        if (vfd_install_kernel(v, kfd) < 0)
            return -1;
        return 0;
    }
}

int node_netstack_accept(int fd, struct sockaddr *sa, socklen_t *len)
{
    Vfd *v = vfd_find(fd);
    Vfd *nv;
    uint64_t id;
    struct sockaddr_storage peer;
    socklen_t plen = sizeof(peer);
    NsAddr local, remote;
    uint16_t lport, rport;

    if (!v || v->kind != VFD_LISTEN) {
        errno = EBADF;
        return -1;
    }
    vfd_drain(v);
    node_netstack_pump();

    if (ns_accept_port(ns_stack, v->lport, &id) != 0) {
        errno = EAGAIN;
        return -1;
    }
    nv = vfd_alloc(AF_INET6, 0);
    if (!nv) {
        ns_close(ns_stack, id);
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
    return nv->fd;
}

int node_netstack_connect(int fd, const struct sockaddr *sa, socklen_t len)
{
    Vfd *v = vfd_find(fd);
    NsAddr remote, local;
    uint16_t rport, lport;
    uint64_t id;
    int state;

    if (!v) {
        errno = EBADF;
        return -1;
    }
    if (sa_to_ns(sa, len, &remote, &rport, NULL) < 0)
        return -1;

    if (v->force || addr_managed(&remote)) {
        if (v->bound && !v->bind_wildcard)
            local = v->bind_addr;
        else
            local = *ns_stack_local(ns_stack);
        lport = v->bound ? v->bind_port : 0;
        id = ns_connect_from(ns_stack, &local, lport, &remote, rport);
        if (!id) {
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
        if (state == NS_ESTABLISHED || state == NS_CLOSE_WAIT)
            return 0;
        if (state == NS_CLOSED) {
            errno = ECONNREFUSED;
            return -1;
        }
        errno = EINPROGRESS;
        return -1;
    }

    return vfd_to_kernel_connect(v, sa, len);
}

ssize_t node_netstack_read(int fd, void *buf, size_t len)
{
    Vfd *v = vfd_find(fd);
    int n;

    if (!v || v->kind != VFD_CONN) {
        errno = EBADF;
        return -1;
    }
    vfd_drain(v);
    node_netstack_pump();
    n = ns_recv(ns_stack, v->conn, buf, len);
    if (n < 0) {
        if (n == -NS_EAGAIN)
            errno = EAGAIN;
        else
            errno = ENOTCONN;
        return -1;
    }
    vfd_signal_all();
    return n;
}

ssize_t node_netstack_write(int fd, const void *buf, size_t len)
{
    Vfd *v = vfd_find(fd);
    int n;

    if (!v || v->kind != VFD_CONN) {
        errno = EBADF;
        return -1;
    }
    n = ns_send(ns_stack, v->conn, buf, len);
    if (n < 0) {
        if (n == -NS_EAGAIN)
            errno = EAGAIN;
        else if (n == -NS_ENOTCONN)
            errno = EPIPE;
        else
            errno = EINVAL;
        return -1;
    }
    node_netstack_pump();
    return n;
}

int node_netstack_close(int fd)
{
    Vfd *v = vfd_find(fd);
    if (!v) {
        errno = EBADF;
        return -1;
    }
    if (v->kind == VFD_CONN)
        ns_close(ns_stack, v->conn);
    else if (v->kind == VFD_LISTEN)
        ns_unlisten(ns_stack, v->lport);
    node_netstack_pump();
    vfd_reset(v);
    return 0;
}

int node_netstack_shutdown(int fd, int how)
{
    Vfd *v = vfd_find(fd);
    if (!v || v->kind != VFD_CONN) {
        errno = ENOTCONN;
        return -1;
    }
    if (how == SHUT_WR || how == SHUT_RDWR)
        ns_close(ns_stack, v->conn);
    node_netstack_pump();
    return 0;
}

int node_netstack_getsockname(int fd, struct sockaddr *sa, socklen_t *len)
{
    Vfd *v = vfd_find(fd);
    NsAddr local;
    uint16_t lport = 0;

    if (!v) {
        errno = EBADF;
        return -1;
    }
    if (v->kind == VFD_CONN) {
        ns_conn_addr(ns_stack, v->conn, &local, &lport, NULL, NULL);
    } else if (v->kind == VFD_LISTEN) {
        local = v->local;
        lport = v->lport;
    } else {
        memset(&local, 0, sizeof(local));
    }
    ns_to_sa(&local, lport, sa, len);
    return 0;
}

int node_netstack_getpeername(int fd, struct sockaddr *sa, socklen_t *len)
{
    Vfd *v = vfd_find(fd);
    NsAddr remote;
    uint16_t rport = 0;

    if (!v || v->kind != VFD_CONN) {
        errno = ENOTCONN;
        return -1;
    }
    ns_conn_addr(ns_stack, v->conn, NULL, NULL, &remote, &rport);
    ns_to_sa(&remote, rport, sa, len);
    return 0;
}

int node_netstack_setsockopt(int fd, int level, int opt, const void *val,
                             socklen_t len)
{
    Vfd *v = vfd_find(fd);
    int value = 0;

    if (!v) {
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
    return 0;
}

int node_netstack_getsockopt(int fd, int level, int opt, void *val,
                             socklen_t *len)
{
    Vfd *v = vfd_find(fd);
    int value = 0;

    if (!v) {
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
    return 0;
}

int node_netstack_poll(int fd, int events)
{
    Vfd *v = vfd_find(fd);
    int revents = 0;
    (void)events;

    if (!v)
        return 0;
    if (v->kind == VFD_LISTEN &&
        ns_accept_ready_port(ns_stack, v->lport))
        revents |= 0x001; /* POLLIN */
    else if (v->kind == VFD_CONN &&
             ns_conn_readable(ns_stack, v->conn))
        revents |= 0x001;
    return revents;
}

int node_netstack_pump(void)
{
    int n = 0;
    if (!ns_ready)
        return 0;
    if (ns_link_fd(ns_link) >= 0)
        ns_link_pump(ns_link, 128);
    n = ns_run(ns_stack, 256);
    ns_tick(ns_stack, now_ms());
    vfd_signal_all();
    return n;
}

int node_netstack_tick(void)
{
    if (!ns_ready)
        return 0;
    ns_tick(ns_stack, now_ms());
    /* Retransmissions were just queued through the link; run them now so a
       loopback connection makes progress without another socket call. */
    if (ns_link_fd(ns_link) >= 0)
        ns_link_pump(ns_link, 128);
    ns_run(ns_stack, 256);
    vfd_signal_all();
    return 0;
}
