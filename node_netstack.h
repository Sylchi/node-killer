/*
 * node_netstack - node:net <-> netstack bridge.
 *
 * AF_INET and AF_INET6 stream sockets are handed out as virtual descriptors:
 * a real eventfd that the libev event loop can poll, with the socket state
 * held by the in-process netstack. Addresses inside the stack's managed
 * prefixes stay on the owned TCP engine; any other address is transparently
 * converted to a kernel socket at bind/connect time so existing workloads
 * keep working.
 */
#ifndef NODE_NETSTACK_H
#define NODE_NETSTACK_H

#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/types.h>

/* mode: 1 = force netstack, 0 = auto, -1 = never. Returns a virtual fd, or
   -1 when the caller should fall back to a kernel socket. */
int node_netstack_socket(int domain, int type, int mode);

int node_netstack_is_vfd(int fd);

int node_netstack_bind(int fd, const struct sockaddr *sa, socklen_t len);
int node_netstack_listen(int fd, int backlog);
int node_netstack_accept(int fd, struct sockaddr *sa, socklen_t *len);
int node_netstack_connect(int fd, const struct sockaddr *sa, socklen_t len);

ssize_t node_netstack_read(int fd, void *buf, size_t len);
ssize_t node_netstack_write(int fd, const void *buf, size_t len);
int node_netstack_close(int fd);
int node_netstack_shutdown(int fd, int how);

int node_netstack_getsockname(int fd, struct sockaddr *sa, socklen_t *len);
int node_netstack_getpeername(int fd, struct sockaddr *sa, socklen_t *len);
int node_netstack_setsockopt(int fd, int level, int opt, const void *val,
                             socklen_t len);
int node_netstack_getsockopt(int fd, int level, int opt, void *val,
                             socklen_t *len);
int node_netstack_poll(int fd, int events);

/* Drive the stack: drain the link, run TCP, fire retransmit timers and wake
   virtual descriptors. Returns the number of packets processed. */
int node_netstack_pump(void);
int node_netstack_tick(void);

/* Real fd to poll for TUN input, or -1 for the loopback link. */
int node_netstack_link_fd(void);

/* Fill in diagnostics: enabled, IPv6 address, IPv4 address, link name.
   Returns 0 when the stack is ready. */
int node_netstack_info(char *addr, size_t addrlen, char *addr4, size_t addr4len,
                       const char **link);

#endif /* NODE_NETSTACK_H */
