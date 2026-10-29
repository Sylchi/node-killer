/*
 * qnode - Node.js compatibility layer for quickjs-ng
 *
 * Native primitives used by the JS bootstrap: filesystem, process,
 * sockets, DNS and child processes. The event loop itself lives in
 * quickjs-libc and is backed by libev.
 */
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#include <dirent.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/utsname.h>
#include <sys/uio.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <pwd.h>

#include <strings.h>
#include <pthread.h>
#include <sodium.h>
#include <zlib.h>
#include <mbedtls/version.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#include <mbedtls/pk.h>
#include <mbedtls/pem.h>
#include <mbedtls/md.h>
#include <mbedtls/oid.h>
#include <mbedtls/error.h>
#include <mbedtls/pkcs5.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/base64.h>
#include <mbedtls/rsa.h>
#include <mbedtls/ecp.h>
#if MBEDTLS_VERSION_MAJOR >= 4
#include <psa/crypto.h>
#else
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#endif

#include "cutils.h"
#include "quickjs.h"
#include "quickjs-libc.h"
#include "node.h"
#include "node_netstack.h"
#include "qjs-wasm.h"

#ifndef NODE_PATH_MAX
#define NODE_PATH_MAX 4096
#endif

#include "node_bootstrap.h"

static JSValue node_err(JSContext *ctx, JSValue val, int err)
{
    JSValue arr = JS_NewArray(ctx);
    if (JS_IsException(arr)) {
        JS_FreeValue(ctx, val);
        return arr;
    }
    JS_SetPropertyUint32(ctx, arr, 0, val);
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, err));
    return arr;
}

static JSValue node_ok(JSContext *ctx, JSValue val)
{
    return node_err(ctx, val, 0);
}

static int node_sockaddr_type(JSContext *ctx, const char *host, int port,
                              struct sockaddr_storage *ss, socklen_t *plen,
                              bool passive, int socktype);
static JSValue node_addr_obj(JSContext *ctx, struct sockaddr_storage *ss,
                             socklen_t len);

static const char *node_cstr(JSContext *ctx, JSValueConst v)
{
    return JS_ToCString(ctx, v);
}

typedef struct {
    const uint8_t *data;
    size_t len;
    JSValue abuf;
    char *cstr;
} NodeBytes;

/* Accept strings, ArrayBuffers and typed arrays (incl. Buffer). */
static int node_get_bytes(JSContext *ctx, JSValueConst v, NodeBytes *b)
{
    memset(b, 0, sizeof(*b));
    b->abuf = JS_UNDEFINED;
    if (JS_IsString(v)) {
        size_t len;
        b->cstr = (char *)JS_ToCStringLen(ctx, &len, v);
        if (!b->cstr)
            return -1;
        b->data = (const uint8_t *)b->cstr;
        b->len = len;
        return 0;
    }
    if (JS_IsArrayBuffer(v)) {
        size_t size;
        uint8_t *p = JS_GetArrayBuffer(ctx, &size, v);
        if (!p)
            return -1;
        b->data = p;
        b->len = size;
        return 0;
    }
    {
        size_t off, len, bpe;
        JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe);
        if (JS_IsException(ab)) {
            JS_FreeValue(ctx, ab);
            return -1;
        }
        uint8_t *p = JS_GetArrayBuffer(ctx, &bpe, ab);
        if (!p) {
            JS_FreeValue(ctx, ab);
            return -1;
        }
        b->abuf = ab;
        b->data = p + off;
        b->len = len;
        return 0;
    }
}

static void node_free_bytes(JSContext *ctx, NodeBytes *b)
{
    if (b->cstr)
        JS_FreeCString(ctx, b->cstr);
    if (!JS_IsUndefined(b->abuf))
        JS_FreeValue(ctx, b->abuf);
}

/* ---------------- process ---------------- */

static JSValue js_node_getpid(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, getpid());
}

static JSValue js_node_getppid(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, getppid());
}

static JSValue js_node_getuid(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, 1000);
#else
    return JS_NewInt32(ctx, getuid());
#endif
}

static JSValue js_node_getgid(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, 1000);
#else
    return JS_NewInt32(ctx, getgid());
#endif
}

static JSValue js_node_umask(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        int32_t mask;
        if (JS_ToInt32(ctx, &mask, argv[0]))
            return JS_EXCEPTION;
        (void)mask;
        return JS_NewInt32(ctx, 022);
    }
    return JS_NewInt32(ctx, 022);
#else
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        int32_t mask;
        if (JS_ToInt32(ctx, &mask, argv[0]))
            return JS_EXCEPTION;
        return JS_NewInt32(ctx, umask(mask));
    }
    int old = umask(0);
    umask(old);
    return JS_NewInt32(ctx, old);
#endif
}

static JSValue js_node_kill(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    int32_t pid, sig = SIGTERM;
    if (JS_ToInt32(ctx, &pid, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &sig, argv[1]))
            return JS_EXCEPTION;
    return JS_NewInt32(ctx, kill(pid, sig) ? errno : 0);
}

static JSValue js_node_abort(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    abort();
    return JS_UNDEFINED;
}

static JSValue js_node_cwd(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    char buf[NODE_PATH_MAX];
    if (!getcwd(buf, sizeof(buf)))
        return node_err(ctx, JS_NULL, errno);
    return node_ok(ctx, JS_NewString(ctx, buf));
}

static JSValue js_node_chdir(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    int err;
    if (!path)
        return JS_EXCEPTION;
    err = chdir(path) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_hrtime(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt64(ctx, ts.tv_sec));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, ts.tv_nsec));
    return arr;
}

static JSValue js_node_hostname(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_NewString(ctx, "qnode");
#else
    char buf[256];
    if (gethostname(buf, sizeof(buf)))
        buf[0] = '\0';
    return JS_NewString(ctx, buf);
#endif
}

static JSValue js_node_exepath(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    char buf[NODE_PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n < 0)
        return JS_NewString(ctx, "qnode");
    buf[n] = '\0';
    return JS_NewString(ctx, buf);
}

static int node_sodium_init(void);

static JSValue js_node_random_bytes(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    int32_t len;
    if (JS_ToInt32(ctx, &len, argv[0]) || len < 0)
        return JS_ThrowRangeError(ctx, "invalid length");
    uint8_t *buf = js_malloc(ctx, len ? len : 1);
    if (!buf)
        return JS_EXCEPTION;
    if (node_sodium_init() == 0) {
        randombytes_buf(buf, (size_t)len);
    } else {
        int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
        size_t got = 0;
        if (fd >= 0) {
            while (got < (size_t)len) {
                ssize_t n = read(fd, buf + got, len - got);
                if (n <= 0)
                    break;
                got += n;
            }
            close(fd);
        }
        if (got < (size_t)len) {
            js_free(ctx, buf);
            return JS_ThrowPlainError(ctx, "cannot read random bytes");
        }
    }
    JSValue val = JS_NewUint8ArrayCopy(ctx, buf, len);
    js_free(ctx, buf);
    return val;
}

static JSValue js_node_stdout_write(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);
static JSValue js_node_stderr_write(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);

static JSValue node_fd_write_all(JSContext *ctx, int fd, JSValueConst data)
{
    NodeBytes b;
    if (node_get_bytes(ctx, data, &b))
        return JS_EXCEPTION;
    size_t off = 0;
    while (off < b.len) {
        ssize_t n = write(fd, b.data + off, b.len - off);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        off += n;
    }
    node_free_bytes(ctx, &b);
    return JS_NewInt64(ctx, off);
}

static JSValue js_node_stdout_write(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    return node_fd_write_all(ctx, 1, argv[0]);
}

static JSValue js_node_stderr_write(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    return node_fd_write_all(ctx, 2, argv[0]);
}

/* ---------------- filesystem ---------------- */

static JSValue js_node_read_file(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        int err = errno;
        JS_FreeCString(ctx, path);
        return node_err(ctx, JS_NULL, err);
    }
    struct stat st;
    if (fstat(fd, &st)) {
        int err = errno;
        close(fd);
        JS_FreeCString(ctx, path);
        return node_err(ctx, JS_NULL, err);
    }
    size_t cap = st.st_size > 0 ? st.st_size : 4096, len = 0;
    uint8_t *buf = js_malloc(ctx, cap ? cap : 1);
    if (!buf) {
        close(fd);
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    for (;;) {
        if (len == cap) {
            size_t ncap = cap < 65536 ? 65536 : cap * 2;
            uint8_t *nb = js_realloc(ctx, buf, ncap);
            if (!nb) {
                js_free(ctx, buf);
                close(fd);
                JS_FreeCString(ctx, path);
                return JS_EXCEPTION;
            }
            buf = nb;
            cap = ncap;
        }
        ssize_t n = read(fd, buf + len, cap - len);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            int err = errno;
            js_free(ctx, buf);
            close(fd);
            JS_FreeCString(ctx, path);
            return node_err(ctx, JS_NULL, err);
        }
        if (n == 0)
            break;
        len += n;
    }
    close(fd);
    JS_FreeCString(ctx, path);
    JSValue val = JS_NewArrayBufferCopy(ctx, buf, len);
    js_free(ctx, buf);
    return node_ok(ctx, val);
}

static int node_parse_flags(const char *s)
{
    int flags;
    switch (s[0]) {
    case 'r': flags = O_RDONLY; break;
    case 'w': flags = O_WRONLY | O_CREAT | O_TRUNC; break;
    case 'a': flags = O_WRONLY | O_CREAT | O_APPEND; break;
    default: flags = O_RDONLY; break;
    }
    for (const char *p = s + 1; *p; p++) {
        switch (*p) {
        case '+': flags = (flags & ~O_ACCMODE) | O_RDWR; break;
        case 'x': flags |= O_EXCL; break;
        case 's': flags |= O_SYNC; break;
        case 'e': flags |= O_CLOEXEC; break;
        default: break;
        }
    }
    return flags;
}

static JSValue js_node_write_file(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    NodeBytes b;
    if (!path)
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &b)) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    int flags = O_WRONLY | O_CREAT | O_TRUNC;
    int mode = 0666;
    const char *flagstr = NULL;
    if (argc > 2 && !JS_IsUndefined(argv[2])) {
        flagstr = node_cstr(ctx, argv[2]);
        if (flagstr) {
            /* numeric flags are also accepted */
            if (flagstr[0] >= '0' && flagstr[0] <= '9')
                flags = atoi(flagstr);
            else
                flags = node_parse_flags(flagstr);
            JS_FreeCString(ctx, flagstr);
        }
    }
    if (argc > 3 && !JS_IsUndefined(argv[3])) {
        if (JS_ToInt32(ctx, &mode, argv[3])) {
            node_free_bytes(ctx, &b);
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }
    int fd = open(path, flags | O_CLOEXEC, mode);
    if (fd < 0) {
        int err = errno;
        node_free_bytes(ctx, &b);
        JS_FreeCString(ctx, path);
        return node_err(ctx, JS_NULL, err);
    }
    size_t off = 0;
    int err = 0;
    while (off < b.len) {
        ssize_t n = write(fd, b.data + off, b.len - off);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            err = errno;
            break;
        }
        off += n;
    }
    close(fd);
    node_free_bytes(ctx, &b);
    JS_FreeCString(ctx, path);
    return node_err(ctx, JS_NULL, err);
}

static JSValue node_stat_obj(JSContext *ctx, const struct stat *st)
{
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "dev", JS_NewInt64(ctx, st->st_dev));
    JS_SetPropertyStr(ctx, o, "ino", JS_NewInt64(ctx, st->st_ino));
    JS_SetPropertyStr(ctx, o, "mode", JS_NewInt32(ctx, st->st_mode));
    JS_SetPropertyStr(ctx, o, "nlink", JS_NewInt64(ctx, st->st_nlink));
    JS_SetPropertyStr(ctx, o, "uid", JS_NewInt32(ctx, st->st_uid));
    JS_SetPropertyStr(ctx, o, "gid", JS_NewInt32(ctx, st->st_gid));
    JS_SetPropertyStr(ctx, o, "rdev", JS_NewInt64(ctx, st->st_rdev));
    JS_SetPropertyStr(ctx, o, "size", JS_NewFloat64(ctx, (double)st->st_size));
    JS_SetPropertyStr(ctx, o, "blksize", JS_NewInt64(ctx, st->st_blksize));
    JS_SetPropertyStr(ctx, o, "blocks", JS_NewInt64(ctx, st->st_blocks));
    JS_SetPropertyStr(ctx, o, "atimeMs", JS_NewFloat64(ctx, st->st_atime * 1000.0));
    JS_SetPropertyStr(ctx, o, "mtimeMs", JS_NewFloat64(ctx, st->st_mtime * 1000.0));
    JS_SetPropertyStr(ctx, o, "ctimeMs", JS_NewFloat64(ctx, st->st_ctime * 1000.0));
    JS_SetPropertyStr(ctx, o, "birthtimeMs", JS_NewFloat64(ctx, st->st_ctime * 1000.0));
    return o;
}

static JSValue js_node_stat(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    struct stat st;
    int r, err = 0;
    if (!path)
        return JS_EXCEPTION;
    bool follow = true;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        follow = JS_ToBool(ctx, argv[1]);
    r = follow ? stat(path, &st) : lstat(path, &st);
    if (r)
        err = errno;
    JS_FreeCString(ctx, path);
    if (r)
        return node_err(ctx, JS_NULL, err);
    return node_ok(ctx, node_stat_obj(ctx, &st));
}

static JSValue js_node_fstat(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t fd;
    struct stat st;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (fstat(fd, &st))
        return node_err(ctx, JS_NULL, errno);
    return node_ok(ctx, node_stat_obj(ctx, &st));
}

static JSValue js_node_readdir(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    DIR *d = opendir(path);
    if (!d) {
        int err = errno;
        JS_FreeCString(ctx, path);
        return node_err(ctx, JS_NULL, err);
    }
    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, ".."))
            continue;
        JS_SetPropertyUint32(ctx, arr, n++, JS_NewString(ctx, de->d_name));
    }
    closedir(d);
    JS_FreeCString(ctx, path);
    return node_ok(ctx, arr);
}

static JSValue js_node_mkdir(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    int32_t mode = 0777;
    if (!path)
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &mode, argv[1])) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    int err = mkdir(path, mode) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_rmdir(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int err = rmdir(path) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_unlink(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int err = unlink(path) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_rename(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *a = node_cstr(ctx, argv[0]);
    const char *b = a ? node_cstr(ctx, argv[1]) : NULL;
    int err;
    if (!a || !b) {
        if (a) JS_FreeCString(ctx, a);
        if (b) JS_FreeCString(ctx, b);
        return JS_EXCEPTION;
    }
    err = rename(a, b) ? errno : 0;
    JS_FreeCString(ctx, a);
    JS_FreeCString(ctx, b);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_realpath(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    char buf[NODE_PATH_MAX];
    if (!path)
        return JS_EXCEPTION;
    if (!realpath(path, buf)) {
        int err = errno;
        JS_FreeCString(ctx, path);
        return node_err(ctx, JS_NULL, err);
    }
    JS_FreeCString(ctx, path);
    return node_ok(ctx, JS_NewString(ctx, buf));
}

static JSValue js_node_readlink(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    char buf[NODE_PATH_MAX];
    if (!path)
        return JS_EXCEPTION;
    ssize_t n = readlink(path, buf, sizeof(buf) - 1);
    int err = n < 0 ? errno : 0;
    JS_FreeCString(ctx, path);
    if (n < 0)
        return node_err(ctx, JS_NULL, err);
    buf[n] = '\0';
    return node_ok(ctx, JS_NewString(ctx, buf));
}

static JSValue js_node_symlink(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *target = node_cstr(ctx, argv[0]);
    const char *path = target ? node_cstr(ctx, argv[1]) : NULL;
    int err;
    if (!target || !path) {
        if (target) JS_FreeCString(ctx, target);
        if (path) JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    err = symlink(target, path) ? errno : 0;
    JS_FreeCString(ctx, target);
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_chmod(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    int32_t mode;
    if (!path || JS_ToInt32(ctx, &mode, argv[1])) {
        if (path) JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    int err = chmod(path, mode) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_chown(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, 0);
#else
    const char *path = node_cstr(ctx, argv[0]);
    int32_t uid, gid;
    if (!path || JS_ToInt32(ctx, &uid, argv[1]) ||
        JS_ToInt32(ctx, &gid, argv[2])) {
        if (path) JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    int err = chown(path, uid, gid) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
#endif
}

static JSValue js_node_utimes(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    double atime, mtime;
    if (!path || JS_ToFloat64(ctx, &atime, argv[1]) ||
        JS_ToFloat64(ctx, &mtime, argv[2])) {
        if (path) JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    struct timeval tv[2];
    tv[0].tv_sec = (time_t)(atime / 1000.0);
    tv[0].tv_usec = (suseconds_t)((int64_t)atime % 1000) * 1000;
    tv[1].tv_sec = (time_t)(mtime / 1000.0);
    tv[1].tv_usec = (suseconds_t)((int64_t)mtime % 1000) * 1000;
    int err = utimes(path, tv) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_truncate(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    int64_t len;
    if (!path || JS_ToInt64(ctx, &len, argv[1])) {
        if (path) JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    int err = truncate(path, len) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_copyfile(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const char *src = node_cstr(ctx, argv[0]);
    const char *dst = src ? node_cstr(ctx, argv[1]) : NULL;
    int err = 0;
    if (!src || !dst) {
        if (src) JS_FreeCString(ctx, src);
        if (dst) JS_FreeCString(ctx, dst);
        return JS_EXCEPTION;
    }
    int in = open(src, O_RDONLY | O_CLOEXEC);
    if (in < 0) {
        err = errno;
        goto done;
    }
    int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0666);
    if (out < 0) {
        err = errno;
        close(in);
        goto done;
    }
    uint8_t buf[65536];
    for (;;) {
        ssize_t n = read(in, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR)
                continue;
            err = errno;
            break;
        }
        if (n == 0)
            break;
        ssize_t off = 0;
        while (off < n) {
            ssize_t w = write(out, buf + off, n - off);
            if (w < 0) {
                if (errno == EINTR)
                    continue;
                err = errno;
                break;
            }
            off += w;
        }
        if (err)
            break;
    }
    close(in);
    if (close(out) && !err)
        err = errno;
done:
    JS_FreeCString(ctx, src);
    JS_FreeCString(ctx, dst);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_access(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    int32_t mode = F_OK;
    if (!path)
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &mode, argv[1])) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    int err = access(path, mode) ? errno : 0;
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_open(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    const char *flags_s = path ? node_cstr(ctx, argv[1]) : NULL;
    int32_t mode = 0666;
    if (!path || !flags_s) {
        if (path) JS_FreeCString(ctx, path);
        if (flags_s) JS_FreeCString(ctx, flags_s);
        return JS_EXCEPTION;
    }
    if (argc > 2 && !JS_IsUndefined(argv[2]))
        if (JS_ToInt32(ctx, &mode, argv[2])) {
            JS_FreeCString(ctx, path);
            JS_FreeCString(ctx, flags_s);
            return JS_EXCEPTION;
        }
    int flags = (flags_s[0] >= '0' && flags_s[0] <= '9')
                    ? atoi(flags_s) : node_parse_flags(flags_s);
    int fd = open(path, flags | O_CLOEXEC, mode);
    int err = fd < 0 ? errno : 0;
    JS_FreeCString(ctx, path);
    JS_FreeCString(ctx, flags_s);
    return node_err(ctx, fd < 0 ? JS_NULL : JS_NewInt32(ctx, fd), err);
}

static JSValue js_node_read(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    int32_t fd, len = 65536;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &len, argv[1]))
            return JS_EXCEPTION;
    if (len < 0 || len > 16 * 1024 * 1024)
        return JS_ThrowRangeError(ctx, "invalid read length");
    int64_t position = -1;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2]))
        if (JS_ToInt64(ctx, &position, argv[2]))
            return JS_EXCEPTION;
    uint8_t *buf = js_malloc(ctx, len ? len : 1);
    if (!buf)
        return JS_EXCEPTION;
    ssize_t n;
    if (node_netstack_is_vfd(fd)) {
        n = node_netstack_read(fd, buf, (size_t)len);
    } else {
        do {
            n = position >= 0 ? pread(fd, buf, len, position)
                              : read(fd, buf, len);
        } while (n < 0 && errno == EINTR);
    }
    if (n < 0) {
        int err = errno;
        js_free(ctx, buf);
        return node_err(ctx, JS_NULL, err);
    }
    JSValue val = JS_NewUint8ArrayCopy(ctx, buf, n);
    js_free(ctx, buf);
    return node_ok(ctx, val);
}

/* poll(fd, events, 0): non-destructive readiness check, for diagnostics. */
static JSValue js_node_poll1(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t fd, events;
    struct pollfd pfd;
    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt32(ctx, &events, argv[1]))
        return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd))
        return JS_NewInt32(ctx, node_netstack_poll(fd, events));
    pfd.fd = fd;
    pfd.events = (short)events;
    pfd.revents = 0;
    int r = poll(&pfd, 1, 0);
    return JS_NewInt32(ctx, r < 0 ? -errno : pfd.revents);
}

static JSValue js_node_write(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t fd;
    NodeBytes b;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &b))
        return JS_EXCEPTION;
    int64_t position = -1;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2]))
        if (JS_ToInt64(ctx, &position, argv[2]))
            return JS_EXCEPTION;
    ssize_t n;
    if (node_netstack_is_vfd(fd)) {
        n = node_netstack_write(fd, b.data, b.len);
    } else {
        do {
            n = position >= 0 ? pwrite(fd, b.data, b.len, position)
                              : write(fd, b.data, b.len);
        } while (n < 0 && errno == EINTR);
    }
    int err = n < 0 ? errno : 0;
    node_free_bytes(ctx, &b);
    if (n < 0)
        return node_err(ctx, JS_NULL, err);
    return node_ok(ctx, JS_NewInt64(ctx, n));
}

static JSValue js_node_sendto(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t fd, port;
    NodeBytes b;
    struct sockaddr_storage ss;
    socklen_t len;
    ssize_t n = -1;
    int err = 0;

    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt32(ctx, &port, argv[2]))
        return JS_EXCEPTION;
    const char *host = JS_IsUndefined(argv[1]) || JS_IsNull(argv[1])
                           ? NULL : node_cstr(ctx, argv[1]);
    if (node_get_bytes(ctx, argv[3], &b)) {
        if (host) JS_FreeCString(ctx, host);
        return JS_EXCEPTION;
    }
    err = node_sockaddr_type(ctx, host, port, &ss, &len, false, SOCK_DGRAM);
    if (!err) {
        if (node_netstack_is_vfd(fd)) {
            n = node_netstack_sendto(fd, (struct sockaddr *)&ss, len, b.data,
                                     b.len);
        } else {
            do {
                n = sendto(fd, b.data, b.len, 0, (struct sockaddr *)&ss,
                           len);
            } while (n < 0 && errno == EINTR);
        }
        if (n < 0)
            err = errno;
    }
    if (host) JS_FreeCString(ctx, host);
    node_free_bytes(ctx, &b);
    if (err)
        return node_err(ctx, JS_NULL, err);
    return node_ok(ctx, JS_NewInt64(ctx, n));
}

static JSValue js_node_recvfrom(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    int32_t fd, maxlen = 65536;
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    ssize_t n;

    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &maxlen, argv[1]))
            return JS_EXCEPTION;
    if (maxlen < 0 || maxlen > 16 * 1024 * 1024)
        return JS_ThrowRangeError(ctx, "invalid receive length");

    uint8_t *buf = js_malloc(ctx, maxlen ? (size_t)maxlen : 1);
    if (!buf)
        return JS_EXCEPTION;
    memset(&ss, 0, sizeof(ss));
    if (node_netstack_is_vfd(fd)) {
        n = node_netstack_recvfrom(fd, buf, (size_t)maxlen,
                                   (struct sockaddr *)&ss, &len);
    } else {
        do {
            n = recvfrom(fd, buf, (size_t)maxlen, 0,
                         (struct sockaddr *)&ss, &len);
        } while (n < 0 && errno == EINTR);
    }
    if (n < 0) {
        int err = errno;
        js_free(ctx, buf);
        return node_err(ctx, JS_NULL, err);
    }
    JSValue val = JS_NewArray(ctx);
    JSValue data = JS_NewUint8ArrayCopy(ctx, buf, n);
    JSValue addr = node_addr_obj(ctx, &ss, len);
    JS_SetPropertyUint32(ctx, val, 0, data);
    JS_SetPropertyUint32(ctx, val, 1, addr);
    js_free(ctx, buf);
    return node_ok(ctx, val);
}

static JSValue js_node_disconnect(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int32_t fd;
    int err = 0;

    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd)) {
        err = node_netstack_disconnect(fd) ? errno : 0;
    } else {
        struct sockaddr sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_family = AF_UNSPEC;
        if (connect(fd, &sa, sizeof(sa)))
            err = errno;
    }
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_close(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd))
        return JS_NewInt32(ctx, node_netstack_close(fd) ? errno : 0);
    return JS_NewInt32(ctx, close(fd) ? errno : 0);
}

static JSValue js_node_fsync(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, fsync(fd) ? errno : 0);
}

static JSValue js_node_ftruncate(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    int32_t fd;
    int64_t len;
    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt64(ctx, &len, argv[1]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, ftruncate(fd, len) ? errno : 0);
}

static JSValue js_node_dup(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    int nfd = dup(fd);
    return node_err(ctx, nfd < 0 ? JS_NULL : JS_NewInt32(ctx, nfd),
                    nfd < 0 ? errno : 0);
}

static JSValue js_node_pipe(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    int fds[2];
    if (pipe(fds))
        return node_err(ctx, JS_NULL, errno);
    fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    fcntl(fds[1], F_SETFD, FD_CLOEXEC);
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, fds[0]));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, fds[1]));
    return node_ok(ctx, arr);
}

static JSValue js_node_isatty(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    return JS_NewBool(ctx, isatty(fd));
}

extern char **environ;

static JSValue js_node_environ(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    JSValue o = JS_NewObject(ctx);
    for (char **e = environ; e && *e; e++) {
        const char *eq = strchr(*e, '=');
        if (!eq)
            continue;
        size_t n = eq - *e;
        char *key = js_malloc(ctx, n + 1);
        if (!key)
            return JS_EXCEPTION;
        memcpy(key, *e, n);
        key[n] = '\0';
        JS_SetPropertyStr(ctx, o, key, JS_NewString(ctx, eq + 1));
        js_free(ctx, key);
    }
    return o;
}

static JSValue js_node_uname(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)this_val; (void)argc; (void)argv;
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "sysname", JS_NewString(ctx, "qnode"));
    JS_SetPropertyStr(ctx, o, "nodename", JS_NewString(ctx, "qnode"));
    JS_SetPropertyStr(ctx, o, "release", JS_NewString(ctx, "0.1.0"));
    JS_SetPropertyStr(ctx, o, "version", JS_NewString(ctx, "freestanding"));
    JS_SetPropertyStr(ctx, o, "machine", JS_NewString(ctx, "unknown"));
    return node_ok(ctx, o);
#else
    struct utsname u;
    JSValue o = JS_NewObject(ctx);
    if (uname(&u))
        return node_err(ctx, JS_NULL, errno);
    JS_SetPropertyStr(ctx, o, "sysname", JS_NewString(ctx, u.sysname));
    JS_SetPropertyStr(ctx, o, "nodename", JS_NewString(ctx, u.nodename));
    JS_SetPropertyStr(ctx, o, "release", JS_NewString(ctx, u.release));
    JS_SetPropertyStr(ctx, o, "version", JS_NewString(ctx, u.version));
    JS_SetPropertyStr(ctx, o, "machine", JS_NewString(ctx, u.machine));
    return node_ok(ctx, o);
#endif
}

static JSValue js_node_cpu_count(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, 1);
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return JS_NewInt32(ctx, n > 0 ? n : 1);
#endif
}

/* Real footprint of this process plus the engine's own accounting. */
static JSValue js_node_memory_usage(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    JSMemoryUsage m;
    uint64_t rss = 0;
    FILE *f = fopen("/proc/self/statm", "r");
    if (f) {
        unsigned long vms = 0, res = 0;
        if (fscanf(f, "%lu %lu", &vms, &res) == 2)
            rss = (uint64_t)res * (uint64_t)sysconf(_SC_PAGESIZE);
        fclose(f);
    }
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &m);
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewFloat64(ctx, (double)rss));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewFloat64(ctx, (double)m.malloc_size));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewFloat64(ctx, (double)m.memory_used_size));
    JS_SetPropertyUint32(ctx, arr, 3, JS_NewFloat64(ctx, (double)m.binary_object_size));
    JS_SetPropertyUint32(ctx, arr, 4, JS_NewFloat64(ctx, (double)m.binary_object_size));
    return arr;
}

/* getrusage(RUSAGE_SELF), in the units Node reports. */
static JSValue js_node_rusage(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    struct rusage ru;
    JSValue arr;
    if (getrusage(RUSAGE_SELF, &ru))
        return node_err(ctx, JS_NULL, errno);
    arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewFloat64(ctx,
        ru.ru_utime.tv_sec * 1e6 + ru.ru_utime.tv_usec));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewFloat64(ctx,
        ru.ru_stime.tv_sec * 1e6 + ru.ru_stime.tv_usec));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewFloat64(ctx, (double)ru.ru_maxrss));
    JS_SetPropertyUint32(ctx, arr, 3, JS_NewFloat64(ctx, (double)ru.ru_minflt));
    JS_SetPropertyUint32(ctx, arr, 4, JS_NewFloat64(ctx, (double)ru.ru_majflt));
    JS_SetPropertyUint32(ctx, arr, 5, JS_NewFloat64(ctx, (double)ru.ru_nvcsw));
    JS_SetPropertyUint32(ctx, arr, 6, JS_NewFloat64(ctx, (double)ru.ru_nivcsw));
    JS_SetPropertyUint32(ctx, arr, 7, JS_NewFloat64(ctx, (double)ru.ru_inblock));
    JS_SetPropertyUint32(ctx, arr, 8, JS_NewFloat64(ctx, (double)ru.ru_oublock));
    return arr;
}

static JSValue js_node_meminfo(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    long pages = sysconf(_SC_PHYS_PAGES);
    long avail = sysconf(_SC_AVPHYS_PAGES);
    long psize = sysconf(_SC_PAGESIZE);
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0,
        JS_NewFloat64(ctx, (double)pages * psize));
    JS_SetPropertyUint32(ctx, arr, 1,
        JS_NewFloat64(ctx, (double)avail * psize));
    return arr;
}

static JSValue js_node_set_nonblock(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd))
        return JS_NewInt32(ctx, 0);
    int fl = fcntl(fd, F_GETFL);
    if (fl < 0)
        return JS_NewInt32(ctx, errno);
    return JS_NewInt32(ctx, fcntl(fd, F_SETFL, fl | O_NONBLOCK) ? errno : 0);
}

/* ---------------- sockets ---------------- */

static JSValue js_node_socket(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t domain = AF_INET, type = SOCK_STREAM, proto = 0, mode = 0;
    if (argc > 0 && !JS_IsUndefined(argv[0]))
        if (JS_ToInt32(ctx, &domain, argv[0])) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &type, argv[1])) return JS_EXCEPTION;
    if (argc > 2 && !JS_IsUndefined(argv[2]))
        if (JS_ToInt32(ctx, &proto, argv[2])) return JS_EXCEPTION;
    if (argc > 3 && !JS_IsUndefined(argv[3]))
        if (JS_ToInt32(ctx, &mode, argv[3])) return JS_EXCEPTION;

    /* The owned TCP stack owns managed IPv4/IPv6 streams. Everything else,
       and every failure to initialise the stack, falls through to the
       kernel. */
    if (proto == 0) {
        int vfd = node_netstack_socket(domain, type, mode);
        if (vfd >= 0)
            return node_ok(ctx, JS_NewInt32(ctx, vfd));
    }

    int fd = socket(domain, type | SOCK_CLOEXEC, proto);
    if (fd < 0)
        return node_err(ctx, JS_NULL, errno);
    int fl = fcntl(fd, F_GETFL);
    if (fl >= 0)
        fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    return node_ok(ctx, JS_NewInt32(ctx, fd));
}

static int node_sockaddr_type(JSContext *ctx, const char *host, int port,
                              struct sockaddr_storage *ss, socklen_t *plen,
                              bool passive, int socktype)
{
    struct addrinfo hints, *res = NULL;
    char portbuf[16];
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = socktype;
    hints.ai_flags = passive ? AI_PASSIVE : 0;
    snprintf(portbuf, sizeof(portbuf), "%d", port);
#ifdef QNODE_FREESTANDING
    /* try literal parsing first for IPv4/IPv6 */
    if (host && host[0]) {
        struct in_addr a4;
        if (inet_pton(AF_INET, host, &a4) == 1) {
            struct sockaddr_in *s4 = (struct sockaddr_in *)ss;
            memset(s4, 0, sizeof(*s4));
            s4->sin_family = AF_INET;
            s4->sin_port = htons((uint16_t)port);
            s4->sin_addr = a4;
            *plen = sizeof(*s4);
            return 0;
        }
        struct in6_addr a6;
        if (inet_pton(AF_INET6, host, &a6) == 1) {
            struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)ss;
            memset(s6, 0, sizeof(*s6));
            s6->sin6_family = AF_INET6;
            s6->sin6_port = htons((uint16_t)port);
            s6->sin6_addr = a6;
            *plen = sizeof(*s6);
            return 0;
        }
    }
#endif
    int r = getaddrinfo((host && host[0]) ? host : NULL, portbuf, &hints, &res);
    if (r != 0)
        return EADDRNOTAVAIL;
    memcpy(ss, res->ai_addr, res->ai_addrlen);
    *plen = res->ai_addrlen;
    freeaddrinfo(res);
    (void)ctx;
    return 0;
}

static int node_sockaddr(JSContext *ctx, const char *host, int port,
                         struct sockaddr_storage *ss, socklen_t *plen,
                         bool passive)
{
    return node_sockaddr_type(ctx, host, port, ss, plen, passive, SOCK_STREAM);
}

static JSValue js_node_bind(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    int32_t fd, port;
    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt32(ctx, &port, argv[2]))
        return JS_EXCEPTION;
    const char *host = JS_IsUndefined(argv[1]) || JS_IsNull(argv[1])
                           ? NULL : node_cstr(ctx, argv[1]);
    struct sockaddr_storage ss;
    socklen_t len;
    int err = node_sockaddr(ctx, host, port, &ss, &len, true);
    if (!err) {
        if (node_netstack_is_vfd(fd))
            err = node_netstack_bind(fd, (struct sockaddr *)&ss, len) ? errno : 0;
        else if (bind(fd, (struct sockaddr *)&ss, len))
            err = errno;
    }
    if (host) JS_FreeCString(ctx, host);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_listen(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t fd, backlog = 128;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &backlog, argv[1])) return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd))
        return JS_NewInt32(ctx, node_netstack_listen(fd, backlog) ? errno : 0);
    return JS_NewInt32(ctx, listen(fd, backlog) ? errno : 0);
}

static JSValue js_node_accept(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    int nfd;
    if (node_netstack_is_vfd(fd)) {
        nfd = node_netstack_accept(fd, (struct sockaddr *)&ss, &len);
        if (nfd < 0)
            return node_err(ctx, JS_NULL, errno);
        return node_ok(ctx, JS_NewInt32(ctx, nfd));
    }
    do {
        nfd = accept(fd, (struct sockaddr *)&ss, &len);
    } while (nfd < 0 && errno == EINTR);
    if (nfd < 0)
        return node_err(ctx, JS_NULL, errno);
    int fl = fcntl(nfd, F_GETFL);
    if (fl >= 0)
        fcntl(nfd, F_SETFL, fl | O_NONBLOCK);
    fcntl(nfd, F_SETFD, FD_CLOEXEC);
    return node_ok(ctx, JS_NewInt32(ctx, nfd));
}

static JSValue js_node_connect(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    int32_t fd, port;
    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt32(ctx, &port, argv[2]))
        return JS_EXCEPTION;
    const char *host = JS_IsUndefined(argv[1]) || JS_IsNull(argv[1])
                           ? "127.0.0.1" : node_cstr(ctx, argv[1]);
    if (!host)
        return JS_EXCEPTION;
    struct sockaddr_storage ss;
    socklen_t len;
    int err = node_sockaddr(ctx, host, port, &ss, &len, false);
    if (!err) {
        if (node_netstack_is_vfd(fd))
            err = node_netstack_connect(fd, (struct sockaddr *)&ss, len);
        else if (connect(fd, (struct sockaddr *)&ss, len))
            err = errno;
    }
    JS_FreeCString(ctx, host);
    return JS_NewInt32(ctx, err);
}

static JSValue js_node_setsockopt(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int32_t fd, level, opt, val = 1;
    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt32(ctx, &level, argv[1]) ||
        JS_ToInt32(ctx, &opt, argv[2]))
        return JS_EXCEPTION;
    if (argc > 3 && !JS_IsUndefined(argv[3]))
        if (JS_ToInt32(ctx, &val, argv[3])) return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd))
        return JS_NewInt32(ctx, node_netstack_setsockopt(fd, level, opt, &val,
                                                         sizeof(val)) ? errno : 0);
    return JS_NewInt32(ctx, setsockopt(fd, level, opt, &val, sizeof(val)) ? errno : 0);
}

static JSValue js_node_getsockopt(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int32_t fd, level, opt, val = 0;
    socklen_t len = sizeof(val);
    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt32(ctx, &level, argv[1]) ||
        JS_ToInt32(ctx, &opt, argv[2]))
        return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd)) {
        if (node_netstack_getsockopt(fd, level, opt, &val, &len))
            return node_err(ctx, JS_NULL, errno);
        return node_ok(ctx, JS_NewInt32(ctx, val));
    }
    if (getsockopt(fd, level, opt, &val, &len))
        return node_err(ctx, JS_NULL, errno);
    return node_ok(ctx, JS_NewInt32(ctx, val));
}

/* Synchronous require() of an ES module (no top-level await). */
static JSValue js_node_require_esm(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *path = node_cstr(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    size_t len;
    uint8_t *buf = js_load_file(ctx, &len, path);
    if (!buf) {
        JS_FreeCString(ctx, path);
        return JS_ThrowReferenceError(ctx, "cannot load module '%s'", path);
    }
    JSValue obj = JS_Eval(ctx, (const char *)buf, len, path,
                          JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    js_free(ctx, buf);
    if (JS_IsException(obj)) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    JSModuleDef *m = JS_VALUE_GET_PTR(obj);
    if (js_module_set_import_meta(ctx, obj, true, false) < 0 ||
        JS_ResolveModule(ctx, obj) < 0) {
        JS_FreeValue(ctx, obj);
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    /* JS_EvalFunction consumes its argument; keep obj alive for the
       module namespace lookup. */
    JSValue val = JS_EvalFunction(ctx, JS_DupValue(ctx, obj));
    JSValue ns = JS_GetModuleNamespace(ctx, m);
    JS_FreeValue(ctx, obj);
    JS_FreeCString(ctx, path);
    if (JS_IsException(val)) {
        JS_FreeValue(ctx, ns);
        return val;
    }
    if (JS_IsPromise(val)) {
        switch (JS_PromiseState(ctx, val)) {
        case JS_PROMISE_FULFILLED:
            JS_FreeValue(ctx, val);
            return ns;
        case JS_PROMISE_REJECTED: {
            JSValue reason = JS_PromiseResult(ctx, val);
            JS_FreeValue(ctx, ns);
            JS_FreeValue(ctx, val);
            return JS_Throw(ctx, reason);
        }
        default:
            JS_FreeValue(ctx, val);
            JS_FreeValue(ctx, ns);
            return JS_ThrowTypeError(ctx,
                "require() of an async module (top-level await) is not "
                "supported");
        }
    }
    JS_FreeValue(ctx, val);
    return ns;
}

static JSValue node_addr_obj(JSContext *ctx, struct sockaddr_storage *ss,
                             socklen_t len)
{
    char host[INET6_ADDRSTRLEN] = "";
    int port = 0, family = AF_UNSPEC;
    if (ss->ss_family == AF_INET) {
        struct sockaddr_in *a = (struct sockaddr_in *)ss;
        inet_ntop(AF_INET, &a->sin_addr, host, sizeof(host));
        port = ntohs(a->sin_port);
        family = AF_INET;
    } else if (ss->ss_family == AF_INET6) {
        struct sockaddr_in6 *a = (struct sockaddr_in6 *)ss;
        inet_ntop(AF_INET6, &a->sin6_addr, host, sizeof(host));
        port = ntohs(a->sin6_port);
        family = AF_INET6;
    }
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewString(ctx, host));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, family));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewInt32(ctx, port));
    (void)len;
    return arr;
}

/* Parse an IPv6 address with an optional "/prefix" suffix. A missing
   prefix defaults to /64, the shard layout used by node:net. */
static int node_ipv6_subnet(JSContext *ctx, JSValueConst val, uint8_t addr[16],
                            int *prefix_len)
{
    const char *s = node_cstr(ctx, val);
    if (!s)
        return -1;
    const char *slash = strchr(s, '/');
    size_t alen = slash ? (size_t)(slash - s) : strlen(s);
    char abuf[INET6_ADDRSTRLEN];
    int plen = 64;
    if (alen == 0 || alen >= sizeof(abuf)) {
        JS_FreeCString(ctx, s);
        JS_ThrowTypeError(ctx, "invalid IPv6 subnet");
        return -1;
    }
    memcpy(abuf, s, alen);
    abuf[alen] = '\0';
    if (slash) {
        char *end;
        long v = strtol(slash + 1, &end, 10);
        if (end == slash + 1 || *end || v < 0 || v > 128) {
            JS_FreeCString(ctx, s);
            JS_ThrowRangeError(ctx, "invalid IPv6 prefix length");
            return -1;
        }
        plen = (int)v;
    }
    JS_FreeCString(ctx, s);
    if (inet_pton(AF_INET6, abuf, addr) != 1) {
        JS_ThrowTypeError(ctx, "invalid IPv6 address '%s'", abuf);
        return -1;
    }
    *prefix_len = plen;
    return 0;
}

/* shardAddress("/64 prefix", shard) -> address in slot 0 of that shard.
   The low 64 bits are zeroed first so callers can pass either a prefix or
   any address inside it. */
static JSValue js_node_shard_address(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    uint8_t addr[16];
    int plen;
    int32_t shard;
    if (node_ipv6_subnet(ctx, argv[0], addr, &plen) < 0)
        return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &shard, argv[1]))
        return JS_EXCEPTION;
    if (plen != 64)
        return JS_ThrowRangeError(ctx,
            "shard addresses require a /64 IPv6 prefix");
    if (shard < 0 || shard > 255)
        return JS_ThrowRangeError(ctx, "shard must be between 0 and 255");
    memset(addr + 8, 0, 8);
    addr[8] = (uint8_t)shard;
    char out[INET6_ADDRSTRLEN];
    if (!inet_ntop(AF_INET6, addr, out, sizeof(out)))
        return JS_ThrowInternalError(ctx, "cannot format IPv6 address");
    return JS_NewString(ctx, out);
}

/* The inverse of shardAddress: byte 8 of an IPv6 address, or -1. */
static JSValue js_node_shard_index(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *s = node_cstr(ctx, argv[0]);
    if (!s)
        return JS_EXCEPTION;
    struct in6_addr addr;
    int ok = inet_pton(AF_INET6, s, &addr);
    JS_FreeCString(ctx, s);
    if (ok != 1)
        return JS_NewInt32(ctx, -1);
    return JS_NewInt32(ctx, addr.s6_addr[8]);
}

static JSValue js_node_getsockname(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (node_netstack_is_vfd(fd)) {
        if (node_netstack_getsockname(fd, (struct sockaddr *)&ss, &len))
            return node_err(ctx, JS_NULL, errno);
        return node_ok(ctx, node_addr_obj(ctx, &ss, len));
    }
    if (getsockname(fd, (struct sockaddr *)&ss, &len))
        return node_err(ctx, JS_NULL, errno);
    return node_ok(ctx, node_addr_obj(ctx, &ss, len));
}

static JSValue js_node_getpeername(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (node_netstack_is_vfd(fd)) {
        if (node_netstack_getpeername(fd, (struct sockaddr *)&ss, &len))
            return node_err(ctx, JS_NULL, errno);
        return node_ok(ctx, node_addr_obj(ctx, &ss, len));
    }
    if (getpeername(fd, (struct sockaddr *)&ss, &len))
        return node_err(ctx, JS_NULL, errno);
    return node_ok(ctx, node_addr_obj(ctx, &ss, len));
}

static JSValue js_node_shutdown(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    int32_t fd, how = SHUT_WR;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &how, argv[1])) return JS_EXCEPTION;
    if (node_netstack_is_vfd(fd))
        return JS_NewInt32(ctx, node_netstack_shutdown(fd, how) ? errno : 0);
    return JS_NewInt32(ctx, shutdown(fd, how) ? errno : 0);
}

static JSValue js_node_netstack_info(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    char addr[64];
    char addr4[64];
    const char *link = NULL;
    int ok = node_netstack_info(addr, sizeof(addr), addr4, sizeof(addr4),
                                &link);
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, ok == 0 ? 1 : 0));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewString(ctx, addr));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewString(ctx, link ? link : ""));
    JS_SetPropertyUint32(ctx, arr, 3,
                         JS_NewInt32(ctx, node_netstack_link_fd()));
    JS_SetPropertyUint32(ctx, arr, 4, JS_NewString(ctx, addr4));
    (void)this_val; (void)argc; (void)argv;
    return arr;
}

static JSValue js_node_netstack_pump(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, node_netstack_pump());
}

static JSValue js_node_netstack_tick(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, node_netstack_tick());
}

static JSValue js_node_is_virtual_fd(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    (void)this_val; (void)argc;
    return JS_NewBool(ctx, node_netstack_is_vfd(fd));
}

static JSValue js_node_dns(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    const char *host = node_cstr(ctx, argv[0]);
    struct addrinfo hints, *res = NULL, *p;
    if (!host)
        return JS_EXCEPTION;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    int r = getaddrinfo(host, NULL, &hints, &res);
    JS_FreeCString(ctx, host);
    if (r != 0)
        return node_err(ctx, JS_NULL, r == EAI_NONAME ? ENOENT : EADDRNOTAVAIL);
    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (p = res; p; p = p->ai_next) {
        struct sockaddr_storage ss;
        char hbuf[INET6_ADDRSTRLEN] = "";
        if (p->ai_addrlen > sizeof(ss))
            continue;
        memcpy(&ss, p->ai_addr, p->ai_addrlen);
        if (ss.ss_family == AF_INET)
            inet_ntop(AF_INET, &((struct sockaddr_in *)&ss)->sin_addr,
                      hbuf, sizeof(hbuf));
        else if (ss.ss_family == AF_INET6)
            inet_ntop(AF_INET6, &((struct sockaddr_in6 *)&ss)->sin6_addr,
                      hbuf, sizeof(hbuf));
        else
            continue;
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "address", JS_NewString(ctx, hbuf));
        JS_SetPropertyStr(ctx, o, "family",
                          JS_NewInt32(ctx, ss.ss_family));
        JS_SetPropertyUint32(ctx, arr, n++, o);
    }
    freeaddrinfo(res);
    return node_ok(ctx, arr);
}

/* ---------------- child processes ---------------- */

static void node_close_fd(int fd)
{
    if (fd >= 0)
        close(fd);
}

static JSValue js_node_spawn(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)this_val; (void)argc; (void)argv;
    return node_err(ctx, JS_NULL, ENOSYS);
#else
    /* spawn(argvArray, cwd|null, envArray|null, stdinMode, stdoutMode, stderrMode)
       mode: 0=inherit 1=pipe 2=ignore */
    if (!JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx, "spawn: argv must be an array");
    JSValue lenv = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t alen;
    if (JS_ToInt32(ctx, &alen, lenv) || alen <= 0) {
        JS_FreeValue(ctx, lenv);
        return JS_ThrowTypeError(ctx, "spawn: empty argv");
    }
    JS_FreeValue(ctx, lenv);
    char **args = js_mallocz(ctx, (alen + 1) * sizeof(char *));
    if (!args)
        return JS_EXCEPTION;
    for (int i = 0; i < alen; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
        args[i] = (char *)JS_ToCString(ctx, v);
        JS_FreeValue(ctx, v);
        if (!args[i]) {
            for (int j = 0; j < i; j++)
                JS_FreeCString(ctx, args[j]);
            js_free(ctx, args);
            return JS_EXCEPTION;
        }
    }
    args[alen] = NULL;

    const char *cwd = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]))
        cwd = JS_ToCString(ctx, argv[1]);

    char **envp = NULL;
    if (argc > 2 && JS_IsArray(argv[2])) {
        JSValue elen = JS_GetPropertyStr(ctx, argv[2], "length");
        int32_t n;
        if (JS_ToInt32(ctx, &n, elen) || n < 0) n = 0;
        JS_FreeValue(ctx, elen);
        envp = js_mallocz(ctx, (n + 1) * sizeof(char *));
        if (!envp) {
            for (int i = 0; i < alen; i++) JS_FreeCString(ctx, args[i]);
            js_free(ctx, args);
            if (cwd) JS_FreeCString(ctx, cwd);
            return JS_EXCEPTION;
        }
        for (int i = 0; i < n; i++) {
            JSValue v = JS_GetPropertyUint32(ctx, argv[2], i);
            envp[i] = (char *)JS_ToCString(ctx, v);
            JS_FreeValue(ctx, v);
        }
        envp[n] = NULL;
    }

    int modes[3] = { 0, 0, 0 };
    for (int i = 0; i < 3; i++) {
        if (argc > 3 + i && !JS_IsUndefined(argv[3 + i]))
            modes[i] = JS_ToInt32(ctx, &modes[i], argv[3 + i]) ? 0 : modes[i];
    }

    int pipes[3][2] = { { -1, -1 }, { -1, -1 }, { -1, -1 } };
    int err = 0;
    for (int i = 0; i < 3; i++) {
        if (modes[i] == 1) {
            if (pipe(pipes[i])) {
                err = errno;
                goto fail;
            }
            fcntl(pipes[i][0], F_SETFD, FD_CLOEXEC);
            fcntl(pipes[i][1], F_SETFD, FD_CLOEXEC);
        }
    }

    pid_t pid = fork();
    if (pid < 0) {
        err = errno;
        goto fail;
    }
    if (pid == 0) {
        /* child */
        if (cwd && chdir(cwd))
            _exit(127);
        for (int i = 0; i < 3; i++) {
            if (modes[i] == 1) {
                dup2(pipes[i][i == 0 ? 0 : 1], i);
            } else if (modes[i] == 2) {
                int fd = open("/dev/null", i == 0 ? O_RDONLY : O_WRONLY);
                if (fd >= 0) {
                    dup2(fd, i);
                    close(fd);
                }
            }
        }
        for (int i = 0; i < 3; i++) {
            if (modes[i] == 1) {
                close(pipes[i][0]);
                close(pipes[i][1]);
            }
        }
        if (envp)
            execvpe(args[0], args, envp);
        else
            execvp(args[0], args);
        _exit(127);
    }

    /* parent */
    for (int i = 0; i < 3; i++) {
        if (modes[i] == 1)
            close(pipes[i][i == 0 ? 0 : 1]);
    }
    for (int i = 0; i < alen; i++) JS_FreeCString(ctx, args[i]);
    js_free(ctx, args);
    if (cwd) JS_FreeCString(ctx, cwd);
    if (envp) {
        for (int i = 0; envp[i]; i++) JS_FreeCString(ctx, envp[i]);
        js_free(ctx, envp);
    }
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, pid));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, pipes[0][1]));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewInt32(ctx, pipes[1][0]));
    JS_SetPropertyUint32(ctx, arr, 3, JS_NewInt32(ctx, pipes[2][0]));
    return node_ok(ctx, arr);

fail:
    for (int i = 0; i < 3; i++) {
        node_close_fd(pipes[i][0]);
        node_close_fd(pipes[i][1]);
    }
    for (int i = 0; i < alen; i++) JS_FreeCString(ctx, args[i]);
    js_free(ctx, args);
    if (cwd) JS_FreeCString(ctx, cwd);
    if (envp) {
        for (int i = 0; envp[i]; i++) JS_FreeCString(ctx, envp[i]);
        js_free(ctx, envp);
    }
    return node_err(ctx, JS_NULL, err);
#endif
}

static JSValue js_node_waitpid(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
#ifdef QNODE_FREESTANDING
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return node_err(ctx, JS_NULL, ENOSYS);
#else
    int32_t pid = -1, options = 0;
    if (argc > 0 && !JS_IsUndefined(argv[0]))
        if (JS_ToInt32(ctx, &pid, argv[0])) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &options, argv[1])) return JS_EXCEPTION;
    int status = 0;
    pid_t r = waitpid(pid, &status, options);
    if (r < 0)
        return node_err(ctx, JS_NULL, errno);
    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, r));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, status));
    return node_ok(ctx, arr);
#endif
}

/* ---------------- zlib / compression ---------------- */

/* compress(data, windowBits, level, memLevel, strategy) */
static JSValue js_node_zlib_compress(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    NodeBytes in;
    int32_t windowBits = 15, level = -1, memLevel = 8, strategy = 0;
    z_stream zs;
    int r;

    if (node_get_bytes(ctx, argv[0], &in))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) &&
        JS_ToInt32(ctx, &windowBits, argv[1])) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    if (argc > 2 && !JS_IsUndefined(argv[2]) &&
        JS_ToInt32(ctx, &level, argv[2])) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    if (argc > 3 && !JS_IsUndefined(argv[3]) &&
        JS_ToInt32(ctx, &memLevel, argv[3])) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    if (argc > 4 && !JS_IsUndefined(argv[4]) &&
        JS_ToInt32(ctx, &strategy, argv[4])) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }

    memset(&zs, 0, sizeof(zs));
    r = deflateInit2(&zs, level, Z_DEFLATED, windowBits, memLevel, strategy);
    if (r != Z_OK) {
        node_free_bytes(ctx, &in);
        return JS_ThrowPlainError(ctx, "zlib: deflateInit2 failed (%d)", r);
    }

    uLong bound = deflateBound(&zs, (uLong)in.len);
    uint8_t *out = js_malloc(ctx, bound ? bound : 1);
    if (!out) {
        deflateEnd(&zs);
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    zs.next_in = (Bytef *)in.data;
    zs.avail_in = (uInt)in.len;
    zs.next_out = out;
    zs.avail_out = (uInt)bound;
    r = deflate(&zs, Z_FINISH);
    size_t produced = bound - zs.avail_out;
    deflateEnd(&zs);
    node_free_bytes(ctx, &in);
    if (r != Z_STREAM_END) {
        js_free(ctx, out);
        return JS_ThrowPlainError(ctx, "zlib: deflate failed (%d)", r);
    }
    JSValue val = JS_NewUint8ArrayCopy(ctx, out, produced);
    js_free(ctx, out);
    return val;
}

/* decompress(data, windowBits) */
static JSValue js_node_zlib_decompress(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    NodeBytes in;
    int32_t windowBits = 15;
    z_stream zs;
    int r;
    size_t cap = 0, len = 0;
    uint8_t *out = NULL;

    if (node_get_bytes(ctx, argv[0], &in))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) &&
        JS_ToInt32(ctx, &windowBits, argv[1])) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }

    memset(&zs, 0, sizeof(zs));
    r = inflateInit2(&zs, windowBits);
    if (r != Z_OK) {
        node_free_bytes(ctx, &in);
        return JS_ThrowPlainError(ctx, "zlib: inflateInit2 failed (%d)", r);
    }

    cap = in.len ? in.len * 4 : 256;
    if (cap < 256)
        cap = 256;
    out = js_malloc(ctx, cap);
    if (!out) {
        inflateEnd(&zs);
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    zs.next_in = (Bytef *)in.data;
    zs.avail_in = (uInt)in.len;

    for (;;) {
        zs.next_out = out + len;
        zs.avail_out = (uInt)(cap - len);
        r = inflate(&zs, Z_FINISH);
        len = cap - zs.avail_out;
        if (r == Z_STREAM_END)
            break;
        if (r != Z_OK && r != Z_BUF_ERROR) {
            js_free(ctx, out);
            inflateEnd(&zs);
            node_free_bytes(ctx, &in);
            return JS_ThrowPlainError(ctx, "zlib: inflate failed (%d)", r);
        }
        if (zs.avail_out == 0) {
            size_t ncap = cap * 2;
            uint8_t *nb = js_realloc(ctx, out, ncap);
            if (!nb) {
                js_free(ctx, out);
                inflateEnd(&zs);
                node_free_bytes(ctx, &in);
                return JS_EXCEPTION;
            }
            out = nb;
            cap = ncap;
            continue;
        }
        /* No progress possible: truncated input. */
        js_free(ctx, out);
        inflateEnd(&zs);
        node_free_bytes(ctx, &in);
        return JS_ThrowPlainError(ctx, "zlib: unexpected end of file");
    }
    inflateEnd(&zs);
    node_free_bytes(ctx, &in);

    JSValue val = JS_NewUint8ArrayCopy(ctx, out, len);
    js_free(ctx, out);
    return val;
}

/* Streaming inflate. Fetch needs to decompress gzip/deflate responses while
   the body is still arriving, so keep a small pool of live z_streams indexed
   by an integer handle rather than allocating one per JS object. */

#define NODE_MAX_INFLATE_STREAMS 128

/* Worker threads share the process address space but each runtime has its
   own JSContext-backed state, so keep per-thread structures. */
#if defined(__GNUC__) || defined(__clang__)
#define NODE_THREAD_LOCAL __thread
#else
#define NODE_THREAD_LOCAL _Thread_local
#endif

#define NODE_INFLATE_TLS NODE_THREAD_LOCAL

typedef struct {
    z_stream zs;
    int used;
    int done;
} NodeInflateStream;

static NODE_INFLATE_TLS NodeInflateStream node_inflate_streams[NODE_MAX_INFLATE_STREAMS];

static JSValue node_empty_bytes(JSContext *ctx)
{
    return JS_NewUint8ArrayCopy(ctx, (const uint8_t *)"", 0);
}

static NodeInflateStream *node_inflate_get(JSContext *ctx, int32_t id)
{
    if (id < 0 || id >= NODE_MAX_INFLATE_STREAMS ||
        !node_inflate_streams[id].used) {
        JS_ThrowRangeError(ctx, "zlib: invalid inflate stream");
        return NULL;
    }
    return &node_inflate_streams[id];
}

/* Run inflate over `in`, appending all output into a single Uint8Array. */
static JSValue node_inflate_run(JSContext *ctx, NodeInflateStream *s,
                                const uint8_t *in, size_t in_len, int flush)
{
    uint8_t scratch[16384];
    uint8_t *out = NULL;
    size_t cap = 0, len = 0;
    int r;

    s->zs.next_in = (Bytef *)in;
    s->zs.avail_in = (uInt)in_len;
    for (;;) {
        uInt before = s->zs.avail_in;
        size_t produced;

        s->zs.next_out = scratch;
        s->zs.avail_out = sizeof(scratch);
        r = inflate(&s->zs, flush);
        produced = sizeof(scratch) - s->zs.avail_out;
        if (produced) {
            if (len + produced > cap) {
                size_t ncap = cap ? cap : sizeof(scratch);
                uint8_t *nb;
                while (ncap < len + produced)
                    ncap *= 2;
                nb = js_realloc(ctx, out, ncap);
                if (!nb) {
                    js_free(ctx, out);
                    return JS_EXCEPTION;
                }
                out = nb;
                cap = ncap;
            }
            memcpy(out + len, scratch, produced);
            len += produced;
        }
        if (r == Z_STREAM_END) {
            s->done = 1;
            break;
        }
        if (r != Z_OK && r != Z_BUF_ERROR) {
            js_free(ctx, out);
            return JS_ThrowPlainError(ctx, "zlib: inflate failed (%d)", r);
        }
        if (produced == 0 && s->zs.avail_in == before)
            break;
        if (flush == Z_FINISH && produced == 0)
            break;
    }

    JSValue val = JS_NewUint8ArrayCopy(ctx, out ? out : (uint8_t *)"", len);
    js_free(ctx, out);
    return val;
}

/* zlibInflateStart(windowBits) -> id */
static JSValue js_node_zlib_inflate_start(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    int32_t windowBits = 15;
    int i, r;

    if (argc > 0 && !JS_IsUndefined(argv[0]) &&
        JS_ToInt32(ctx, &windowBits, argv[0]))
        return JS_EXCEPTION;

    for (i = 0; i < NODE_MAX_INFLATE_STREAMS; i++) {
        if (!node_inflate_streams[i].used)
            break;
    }
    if (i == NODE_MAX_INFLATE_STREAMS)
        return JS_ThrowPlainError(ctx, "zlib: too many inflate streams");

    memset(&node_inflate_streams[i], 0, sizeof(node_inflate_streams[i]));
    node_inflate_streams[i].used = 1;
    r = inflateInit2(&node_inflate_streams[i].zs, windowBits);
    if (r != Z_OK) {
        node_inflate_streams[i].used = 0;
        return JS_ThrowPlainError(ctx, "zlib: inflateInit2 failed (%d)", r);
    }
    return JS_NewInt32(ctx, i);
}

/* zlibInflateWrite(id, data) -> Uint8Array */
static JSValue js_node_zlib_inflate_write(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    NodeBytes in;
    NodeInflateStream *s;
    int32_t id;
    JSValue ret;

    if (JS_ToInt32(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &in))
        return JS_EXCEPTION;
    s = node_inflate_get(ctx, id);
    if (!s) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    if (s->done) {
        node_free_bytes(ctx, &in);
        return node_empty_bytes(ctx);
    }
    ret = node_inflate_run(ctx, s, in.data, in.len, Z_NO_FLUSH);
    node_free_bytes(ctx, &in);
    return ret;
}

/* zlibInflateEnd(id) -> trailing Uint8Array */
static JSValue js_node_zlib_inflate_end(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    NodeInflateStream *s;
    int32_t id;
    int was_done, ok;
    JSValue ret;

    if (JS_ToInt32(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    s = node_inflate_get(ctx, id);
    if (!s)
        return JS_EXCEPTION;

    was_done = s->done;
    ret = was_done ? node_empty_bytes(ctx)
                   : node_inflate_run(ctx, s, NULL, 0, Z_FINISH);
    ok = s->done;
    inflateEnd(&s->zs);
    s->used = 0;
    s->done = 0;

    if (!JS_IsException(ret) && !ok && !was_done) {
        JS_FreeValue(ctx, ret);
        return JS_ThrowPlainError(ctx, "zlib: unexpected end of file");
    }
    return ret;
}

static JSValue js_node_crc32(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    NodeBytes in;
    uint32_t seed = 0;
    if (node_get_bytes(ctx, argv[0], &in))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToUint32(ctx, &seed, argv[1])) {
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    uLong crc = crc32(seed, in.data, (uInt)in.len);
    node_free_bytes(ctx, &in);
    return JS_NewUint32(ctx, (uint32_t)crc);
}

/* ---------------- text encoding ---------------- */

/* UTF-8 conversion. The engine already has a fast decoder, so expose it
   instead of decoding byte by byte in JS (which costs ~300ns/byte). */
static JSValue js_node_utf8_decode(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    NodeBytes in;
    JSValue r;

    if (node_get_bytes(ctx, argv[0], &in))
        return JS_EXCEPTION;
    r = JS_NewStringLen(ctx, (const char *)in.data, in.len);
    node_free_bytes(ctx, &in);
    return r;
}

static JSValue js_node_utf8_encode(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *p;
    size_t len;
    JSValue r;

    p = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!p)
        return JS_EXCEPTION;
    r = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)p, len);
    JS_FreeCString(ctx, p);
    return r;
}

/* ---------------- TLS ---------------- */

#define NODE_TLS_MAX_CTX 256
#define NODE_TLS_MAX_CONN 1024
#define NODE_TLS_WANT_READ 1001
#define NODE_TLS_WANT_WRITE 1002

typedef struct {
    mbedtls_x509_crt cert;
    mbedtls_pk_context key;
    mbedtls_x509_crt ca;
    int has_ca;
    int used;
    int refs;
} NodeTLSContext;

typedef struct {
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config conf;
    mbedtls_x509_crt ca;          /* custom CA for client connections */
    NodeTLSContext *server_ctx;   /* borrowed server context */
    char **alpn;
    int alpn_count;
    int has_ca;
    int used;
} NodeTLSConn;

/* TLS handles are per JS context, and qnode runs one context per thread.
   Keeping the registry and the RNG thread-local gives each worker an
   independent handle namespace and avoids sharing mbedTLS state. */
typedef struct {
    NodeTLSContext *contexts[NODE_TLS_MAX_CTX];
    NodeTLSConn conns[NODE_TLS_MAX_CONN];
    int initialized;
    mbedtls_x509_crt system_ca;
    int system_ca_loaded;
#if MBEDTLS_VERSION_MAJOR < 4
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context drbg;
#endif
} NodeTLSState;

static NODE_THREAD_LOCAL NodeTLSState *node_tls_state;

static NodeTLSState *node_tls_state_get(void)
{
    if (!node_tls_state)
        node_tls_state = calloc(1, sizeof(*node_tls_state));
    return node_tls_state;
}

#if MBEDTLS_VERSION_MAJOR >= 4
static int node_tls_rng_init(NodeTLSState *st)
{
    (void)st;
    return psa_crypto_init() == PSA_SUCCESS ? 0 : -1;
}
#else
static int node_tls_rng_init(NodeTLSState *st)
{
    mbedtls_entropy_init(&st->entropy);
    mbedtls_ctr_drbg_init(&st->drbg);
    return mbedtls_ctr_drbg_seed(&st->drbg, mbedtls_entropy_func,
                                 &st->entropy, NULL, 0);
}
#endif

static int node_tls_init(NodeTLSState *st)
{
    if (st->initialized)
        return 0;
    if (node_tls_rng_init(st) != 0)
        return -1;
    st->initialized = 1;
    return 0;
}

static void node_tls_set_min_version(mbedtls_ssl_config *conf)
{
#if MBEDTLS_VERSION_MAJOR >= 3
    mbedtls_ssl_conf_min_tls_version(conf, MBEDTLS_SSL_VERSION_TLS1_2);
#else
    mbedtls_ssl_conf_min_version(conf, MBEDTLS_SSL_MAJOR_VERSION_3,
                                 MBEDTLS_SSL_MINOR_VERSION_3);
#endif
}

static void node_tls_set_rng(NodeTLSState *st, mbedtls_ssl_config *conf)
{
#if MBEDTLS_VERSION_MAJOR < 4
    mbedtls_ssl_conf_rng(conf, mbedtls_ctr_drbg_random, &st->drbg);
#else
    (void)st;
    (void)conf;
#endif
}

static int node_tls_pk_parse_key(NodeTLSState *st, mbedtls_pk_context *pk,
                                 const unsigned char *buf, size_t len)
{
#if MBEDTLS_VERSION_MAJOR == 3
    return mbedtls_pk_parse_key(pk, buf, len, NULL, 0,
                                mbedtls_ctr_drbg_random, &st->drbg);
#else
    (void)st;
    return mbedtls_pk_parse_key(pk, buf, len, NULL, 0);
#endif
}

/* mbedTLS does not ship a public OID-to-short-name helper in every version,
   so map the attribute types Node exposes by hand. */
static const char *node_tls_oid_short_name(const mbedtls_asn1_buf *oid)
{
#define NODE_OID_MATCH(s) \
    (oid->len == sizeof(s) - 1 && memcmp(oid->p, s, sizeof(s) - 1) == 0)
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_CN))              return "CN";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_SUR_NAME))        return "SN";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_GIVEN_NAME))      return "GN";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_SERIAL_NUMBER))   return "serialNumber";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_COUNTRY))         return "C";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_LOCALITY))        return "L";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_STATE))           return "ST";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_ORGANIZATION))    return "O";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_ORG_UNIT))        return "OU";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_TITLE))           return "title";
    if (NODE_OID_MATCH(MBEDTLS_OID_AT_PSEUDONYM))       return "pseudonym";
    if (NODE_OID_MATCH(MBEDTLS_OID_DOMAIN_COMPONENT))   return "DC";
    if (NODE_OID_MATCH(MBEDTLS_OID_PKCS9_EMAIL))        return "emailAddress";
#undef NODE_OID_MATCH
    return NULL;
}

static void node_tls_context_free_now(NodeTLSContext *c)
{
    if (!c)
        return;
    mbedtls_x509_crt_free(&c->cert);
    mbedtls_pk_free(&c->key);
    mbedtls_x509_crt_free(&c->ca);
    free(c);
}

static void node_tls_context_put(NodeTLSContext *c)
{
    if (!c)
        return;
    if (--c->refs == 0)
        node_tls_context_free_now(c);
}

static void node_tls_free_alpn(NodeTLSConn *c)
{
    if (!c->alpn)
        return;
    for (int i = 0; i < c->alpn_count; i++)
        free(c->alpn[i]);
    free(c->alpn);
    c->alpn = NULL;
    c->alpn_count = 0;
}

static void node_tls_conn_clear(NodeTLSConn *c)
{
    mbedtls_ssl_free(&c->ssl);
    mbedtls_ssl_config_free(&c->conf);
    mbedtls_x509_crt_free(&c->ca);
    node_tls_free_alpn(c);
    node_tls_context_put(c->server_ctx);
    memset(c, 0, sizeof(*c));
}

static int node_tls_alloc_conn(NodeTLSState *st)
{
    for (int i = 0; i < NODE_TLS_MAX_CONN; i++) {
        if (!st->conns[i].used) {
            memset(&st->conns[i], 0, sizeof(st->conns[i]));
            st->conns[i].used = 1;
            return i;
        }
    }
    return -1;
}

/* The ALPN argument is the wire format Node uses: a sequence of
   length-prefixed protocol names. mbedTLS wants a NULL-terminated array of
   C strings, which must stay alive for the lifetime of the connection. */
static int node_tls_parse_alpn(NodeTLSConn *c, const uint8_t *data, size_t len)
{
    size_t off = 0, n = 0;

    while (off < len) {
        size_t l = data[off++];
        if (off + l > len)
            return -1;
        n++;
        off += l;
    }
    if (n == 0)
        return 0;

    c->alpn = calloc(n + 1, sizeof(char *));
    if (!c->alpn)
        return -1;

    off = 0;
    n = 0;
    while (off < len) {
        size_t l = data[off++];
        c->alpn[n] = malloc(l + 1);
        if (!c->alpn[n])
            return -1;
        memcpy(c->alpn[n], data + off, l);
        c->alpn[n][l] = '\0';
        n++;
        c->alpn_count = (int)n;
        off += l;
    }
    c->alpn[n] = NULL;
    return 0;
}

/* Non-blocking socket callbacks. Returning 0 from recv signals EOF, which
   mbedTLS reports as MBEDTLS_ERR_SSL_CONN_EOF. */
static int node_tls_bio_send(void *ctx, const unsigned char *buf, size_t len)
{
    int fd = (int)(intptr_t)ctx;
    ssize_t n;
    if (node_netstack_is_vfd(fd)) {
        n = node_netstack_write(fd, buf, len);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return MBEDTLS_ERR_SSL_WANT_WRITE;
            return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
        }
        return (int)n;
    }
    do {
        n = send(fd, buf, len, MSG_NOSIGNAL);
    } while (n < 0 && errno == EINTR);
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return MBEDTLS_ERR_SSL_WANT_WRITE;
        return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
    }
    return (int)n;
}

static int node_tls_bio_recv(void *ctx, unsigned char *buf, size_t len)
{
    int fd = (int)(intptr_t)ctx;
    ssize_t n;
    if (node_netstack_is_vfd(fd)) {
        n = node_netstack_read(fd, buf, len);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return MBEDTLS_ERR_SSL_WANT_READ;
            return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
        }
        return (int)n;
    }
    do {
        n = recv(fd, buf, len, 0);
    } while (n < 0 && errno == EINTR);
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return MBEDTLS_ERR_SSL_WANT_READ;
        return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
    }
    return (int)n;
}

static int node_tls_load_system_ca(NodeTLSState *st)
{
    static const char *paths[] = {
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/ssl/cert.pem",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
        NULL
    };
    const char *env;

    if (st->system_ca_loaded)
        return st->system_ca.raw.p ? 0 : -1;
    st->system_ca_loaded = 1;
    mbedtls_x509_crt_init(&st->system_ca);

    /* Match the OpenSSL default-path behaviour: SSL_CERT_FILE and
       SSL_CERT_DIR override the platform locations. */
    env = getenv("SSL_CERT_FILE");
    if (env && env[0] &&
        mbedtls_x509_crt_parse_file(&st->system_ca, env) >= 0 &&
        st->system_ca.raw.p)
        return 0;

    for (int i = 0; paths[i]; i++) {
        if (mbedtls_x509_crt_parse_file(&st->system_ca, paths[i]) >= 0 &&
            st->system_ca.raw.p)
            return 0;
    }

    env = getenv("SSL_CERT_DIR");
    if (env && env[0] &&
        mbedtls_x509_crt_parse_path(&st->system_ca, env) >= 0 &&
        st->system_ca.raw.p)
        return 0;
    if (mbedtls_x509_crt_parse_path(&st->system_ca, "/etc/ssl/certs") >= 0 &&
        st->system_ca.raw.p)
        return 0;
    return -1;
}

/* Release everything this thread's TLS layer still owns. Called when a worker
   exits so mbedTLS allocations do not accumulate across worker lifetimes. */
void node_tls_thread_cleanup(void)
{
    NodeTLSState *st = node_tls_state;
    int i;

    if (!st)
        return;
    for (i = 0; i < NODE_TLS_MAX_CONN; i++) {
        if (st->conns[i].used)
            node_tls_conn_clear(&st->conns[i]);
    }
    for (i = 0; i < NODE_TLS_MAX_CTX; i++) {
        if (st->contexts[i]) {
            node_tls_context_put(st->contexts[i]);
            st->contexts[i] = NULL;
        }
    }
    if (st->system_ca_loaded)
        mbedtls_x509_crt_free(&st->system_ca);
#if MBEDTLS_VERSION_MAJOR < 4
    if (st->initialized) {
        mbedtls_ctr_drbg_free(&st->drbg);
        mbedtls_entropy_free(&st->entropy);
    }
#endif
    free(st);
    node_tls_state = NULL;
}

static void node_tls_raise(JSContext *ctx, mbedtls_ssl_context *ssl,
                           int ret, const char *what)
{
    char errbuf[256] = "";

    if (ret != 0)
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));

    if (ssl) {
        uint32_t flags = mbedtls_ssl_get_verify_result(ssl);
        if (flags != 0 && flags != (uint32_t)-1) {
            char vbuf[512], *nl;
            mbedtls_x509_crt_verify_info(vbuf, sizeof(vbuf), "", flags);
            nl = strchr(vbuf, '\n');
            if (nl)
                *nl = '\0';
            JS_ThrowPlainError(ctx, "%s: %s", what, vbuf);
            return;
        }
    }
    if (errbuf[0])
        JS_ThrowPlainError(ctx, "%s: %s", what, errbuf);
    else
        JS_ThrowPlainError(ctx, "%s failed", what);
}

/* tlsClientInit(fd, hostname, verify, caPem|null, alpnWire|null) */
static JSValue js_node_tls_client_init(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    int32_t fd;
    int verify = 1;
    const char *host = NULL;
    const char *ca = NULL;
    NodeBytes alpn = { 0 };
    NodeTLSConn *conn;
    NodeTLSState *st;
    mbedtls_x509_crt *ca_chain = NULL;
    int id, ret;

    st = node_tls_state_get();
    if (!st)
        return JS_ThrowOutOfMemory(ctx);
    if (node_tls_init(st) != 0)
        return JS_ThrowPlainError(ctx, "cannot initialize TLS");
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        host = node_cstr(ctx, argv[1]);
        if (!host)
            return JS_EXCEPTION;
    }
    if (argc > 2 && !JS_IsUndefined(argv[2]))
        verify = JS_ToBool(ctx, argv[2]);
    if (argc > 3 && JS_IsString(argv[3])) {
        ca = node_cstr(ctx, argv[3]);
        if (!ca) {
            if (host) JS_FreeCString(ctx, host);
            return JS_EXCEPTION;
        }
    }
    if (argc > 4 && !JS_IsUndefined(argv[4]) && !JS_IsNull(argv[4])) {
        if (node_get_bytes(ctx, argv[4], &alpn)) {
            if (host) JS_FreeCString(ctx, host);
            if (ca) JS_FreeCString(ctx, ca);
            return JS_EXCEPTION;
        }
    }

    id = node_tls_alloc_conn(st);
    if (id < 0)
        goto oom;
    conn = &st->conns[id];
    mbedtls_ssl_init(&conn->ssl);
    mbedtls_ssl_config_init(&conn->conf);
    mbedtls_x509_crt_init(&conn->ca);

    if (ca && ca[0]) {
        ret = mbedtls_x509_crt_parse(&conn->ca,
                                     (const unsigned char *)ca, strlen(ca) + 1);
        if (ret >= 0 && conn->ca.raw.p) {
            conn->has_ca = 1;
            ca_chain = &conn->ca;
        }
    } else if (verify) {
        if (node_tls_load_system_ca(st) == 0)
            ca_chain = &st->system_ca;
    }

    ret = mbedtls_ssl_config_defaults(&conn->conf, MBEDTLS_SSL_IS_CLIENT,
                                      MBEDTLS_SSL_TRANSPORT_STREAM,
                                      MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret != 0)
        goto fail;
    node_tls_set_min_version(&conn->conf);
    node_tls_set_rng(st, &conn->conf);
    mbedtls_ssl_conf_authmode(&conn->conf, verify ? MBEDTLS_SSL_VERIFY_REQUIRED
                                                  : MBEDTLS_SSL_VERIFY_NONE);
    if (verify && ca_chain)
        mbedtls_ssl_conf_ca_chain(&conn->conf, ca_chain, NULL);

    if (alpn.len) {
        if (node_tls_parse_alpn(conn, alpn.data, alpn.len))
            goto fail;
#if MBEDTLS_VERSION_MAJOR >= 4
        mbedtls_ssl_conf_alpn_protocols(&conn->conf,
                                        (const char * const *)conn->alpn);
#else
        mbedtls_ssl_conf_alpn_protocols(&conn->conf, (const char **)conn->alpn);
#endif
    }

    ret = mbedtls_ssl_setup(&conn->ssl, &conn->conf);
    if (ret != 0)
        goto fail;
    if (host && host[0]) {
        ret = mbedtls_ssl_set_hostname(&conn->ssl, host);
        if (ret != 0)
            goto fail;
    }
    mbedtls_ssl_set_bio(&conn->ssl, (void *)(intptr_t)fd,
                        node_tls_bio_send, node_tls_bio_recv, NULL);

    node_free_bytes(ctx, &alpn);
    if (host) JS_FreeCString(ctx, host);
    if (ca) JS_FreeCString(ctx, ca);
    return node_ok(ctx, JS_NewInt32(ctx, id));

fail:
    node_tls_conn_clear(conn);
    st->conns[id].used = 0;
    node_free_bytes(ctx, &alpn);
    if (host) JS_FreeCString(ctx, host);
    if (ca) JS_FreeCString(ctx, ca);
    node_tls_raise(ctx, NULL, ret, "cannot create TLS connection");
    return JS_EXCEPTION;

oom:
    node_free_bytes(ctx, &alpn);
    if (host) JS_FreeCString(ctx, host);
    if (ca) JS_FreeCString(ctx, ca);
    return JS_ThrowOutOfMemory(ctx);
}

/* tlsServerContext(certPem, keyPem, caPem|null) -> ctx id */
static JSValue js_node_tls_server_context(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    const char *cert, *key, *ca = NULL;
    NodeTLSContext *c = NULL;
    NodeTLSState *st;
    int slot = -1, ret;

    st = node_tls_state_get();
    if (!st)
        return JS_ThrowOutOfMemory(ctx);
    if (node_tls_init(st) != 0)
        return JS_ThrowPlainError(ctx, "cannot initialize TLS");
    cert = node_cstr(ctx, argv[0]);
    if (!cert)
        return JS_EXCEPTION;
    key = node_cstr(ctx, argv[1]);
    if (!key) {
        JS_FreeCString(ctx, cert);
        return JS_EXCEPTION;
    }
    if (argc > 2 && JS_IsString(argv[2])) {
        ca = node_cstr(ctx, argv[2]);
        if (!ca) {
            JS_FreeCString(ctx, cert);
            JS_FreeCString(ctx, key);
            return JS_EXCEPTION;
        }
    }

    for (int i = 0; i < NODE_TLS_MAX_CTX; i++) {
        if (!st->contexts[i]) {
            slot = i;
            break;
        }
    }
    if (slot < 0)
        goto oom;

    c = calloc(1, sizeof(*c));
    if (!c)
        goto oom;
    mbedtls_x509_crt_init(&c->cert);
    mbedtls_pk_init(&c->key);
    mbedtls_x509_crt_init(&c->ca);

    ret = mbedtls_x509_crt_parse(&c->cert, (const unsigned char *)cert,
                                 strlen(cert) + 1);
    if (ret < 0 || !c->cert.raw.p)
        goto fail;
    ret = node_tls_pk_parse_key(st, &c->key, (const unsigned char *)key,
                                strlen(key) + 1);
    if (ret != 0)
        goto fail;
    if (ca && ca[0]) {
        ret = mbedtls_x509_crt_parse(&c->ca, (const unsigned char *)ca,
                                     strlen(ca) + 1);
        if (ret >= 0 && c->ca.raw.p)
            c->has_ca = 1;
    }

    c->refs = 1;
    c->used = 1;
    st->contexts[slot] = c;

    JS_FreeCString(ctx, cert);
    JS_FreeCString(ctx, key);
    if (ca) JS_FreeCString(ctx, ca);
    return node_ok(ctx, JS_NewInt32(ctx, slot));

fail:
    node_tls_context_free_now(c);
    node_tls_raise(ctx, NULL, ret, "cannot create TLS context");
    JS_FreeCString(ctx, cert);
    JS_FreeCString(ctx, key);
    if (ca) JS_FreeCString(ctx, ca);
    return JS_EXCEPTION;

oom:
    JS_FreeCString(ctx, cert);
    JS_FreeCString(ctx, key);
    if (ca) JS_FreeCString(ctx, ca);
    return JS_ThrowOutOfMemory(ctx);
}

/* tlsAccept(ctxId, fd) -> conn id */
static JSValue js_node_tls_accept(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int32_t ctxid, fd;
    NodeTLSContext *sc;
    NodeTLSConn *conn;
    NodeTLSState *st;
    int id, ret;

    st = node_tls_state_get();
    if (!st)
        return JS_ThrowOutOfMemory(ctx);
    if (node_tls_init(st) != 0)
        return JS_ThrowPlainError(ctx, "cannot initialize TLS");
    if (JS_ToInt32(ctx, &ctxid, argv[0]) || JS_ToInt32(ctx, &fd, argv[1]))
        return JS_EXCEPTION;
    if (ctxid < 0 || ctxid >= NODE_TLS_MAX_CTX ||
        !st->contexts[ctxid])
        return JS_ThrowRangeError(ctx, "invalid TLS context");
    sc = st->contexts[ctxid];

    id = node_tls_alloc_conn(st);
    if (id < 0)
        return node_err(ctx, JS_NULL, ENOMEM);
    conn = &st->conns[id];
    mbedtls_ssl_init(&conn->ssl);
    mbedtls_ssl_config_init(&conn->conf);
    mbedtls_x509_crt_init(&conn->ca);

    ret = mbedtls_ssl_config_defaults(&conn->conf, MBEDTLS_SSL_IS_SERVER,
                                      MBEDTLS_SSL_TRANSPORT_STREAM,
                                      MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret != 0)
        goto fail;
    node_tls_set_min_version(&conn->conf);
    node_tls_set_rng(st, &conn->conf);
    mbedtls_ssl_conf_authmode(&conn->conf, MBEDTLS_SSL_VERIFY_NONE);
    if (sc->has_ca)
        mbedtls_ssl_conf_ca_chain(&conn->conf, &sc->ca, NULL);
    mbedtls_ssl_conf_own_cert(&conn->conf, &sc->cert, &sc->key);

    ret = mbedtls_ssl_setup(&conn->ssl, &conn->conf);
    if (ret != 0)
        goto fail;
    mbedtls_ssl_set_bio(&conn->ssl, (void *)(intptr_t)fd,
                        node_tls_bio_send, node_tls_bio_recv, NULL);

    sc->refs++;
    conn->server_ctx = sc;
    return node_ok(ctx, JS_NewInt32(ctx, id));

fail:
    node_tls_conn_clear(conn);
    st->conns[id].used = 0;
    node_tls_raise(ctx, NULL, ret, "cannot create TLS connection");
    return JS_EXCEPTION;
}

static NodeTLSConn *node_tls_conn(JSContext *ctx, JSValueConst v)
{
    NodeTLSState *st = node_tls_state;
    int32_t id;
    if (JS_ToInt32(ctx, &id, v))
        return NULL;
    if (!st || id < 0 || id >= NODE_TLS_MAX_CONN || !st->conns[id].used) {
        JS_ThrowRangeError(ctx, "invalid TLS handle");
        return NULL;
    }
    return &st->conns[id];
}

/* tlsHandshake(id) -> 0 done, 1 want read, 2 want write */
static JSValue js_node_tls_handshake(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    NodeTLSConn *conn = node_tls_conn(ctx, argv[0]);
    int ret;

    if (!conn)
        return JS_EXCEPTION;
    ret = mbedtls_ssl_handshake(&conn->ssl);
    if (ret == 0)
        return node_ok(ctx, JS_NewInt32(ctx, 0));
    if (ret == MBEDTLS_ERR_SSL_WANT_READ)
        return node_ok(ctx, JS_NewInt32(ctx, 1));
    if (ret == MBEDTLS_ERR_SSL_WANT_WRITE)
        return node_ok(ctx, JS_NewInt32(ctx, 2));
    node_tls_raise(ctx, &conn->ssl, ret, "TLS handshake failed");
    return JS_EXCEPTION;
}

/* tlsRead(id, max) -> bytes; empty means EOF */
static JSValue js_node_tls_read(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    NodeTLSConn *conn = node_tls_conn(ctx, argv[0]);
    int32_t len = 16384;
    uint8_t *buf;
    int ret;

    if (!conn)
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) &&
        JS_ToInt32(ctx, &len, argv[1]))
        return JS_EXCEPTION;
    if (len <= 0 || len > 16 * 1024 * 1024)
        return JS_ThrowRangeError(ctx, "invalid read length");

    buf = js_malloc(ctx, len);
    if (!buf)
        return JS_EXCEPTION;
    for (;;) {
        ret = mbedtls_ssl_read(&conn->ssl, buf, len);
#ifdef MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET
        if (ret == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET)
            continue;
#endif
        break;
    }
    if (ret > 0) {
        JSValue v = JS_NewUint8ArrayCopy(ctx, buf, ret);
        js_free(ctx, buf);
        return node_ok(ctx, v);
    }
    js_free(ctx, buf);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_READ);
    if (ret == MBEDTLS_ERR_SSL_WANT_WRITE)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_WRITE);
    if (ret == 0 || ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY ||
        ret == MBEDTLS_ERR_SSL_CONN_EOF)
        return node_ok(ctx, JS_NewUint8ArrayCopy(ctx, (const uint8_t *)"", 0));
    node_tls_raise(ctx, &conn->ssl, ret, "TLS read failed");
    return JS_EXCEPTION;
}

/* tlsWrite(id, data) -> bytes written */
static JSValue js_node_tls_write(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    NodeTLSConn *conn = node_tls_conn(ctx, argv[0]);
    NodeBytes b;
    int ret;

    if (!conn)
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &b))
        return JS_EXCEPTION;
    ret = mbedtls_ssl_write(&conn->ssl, b.data, b.len);
    node_free_bytes(ctx, &b);
    if (ret >= 0)
        return node_ok(ctx, JS_NewInt32(ctx, ret));
    if (ret == MBEDTLS_ERR_SSL_WANT_READ)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_READ);
    if (ret == MBEDTLS_ERR_SSL_WANT_WRITE)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_WRITE);
    node_tls_raise(ctx, &conn->ssl, ret, "TLS write failed");
    return JS_EXCEPTION;
}

static JSValue js_node_tls_shutdown(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    NodeTLSConn *conn = node_tls_conn(ctx, argv[0]);
    if (!conn)
        return JS_EXCEPTION;
    mbedtls_ssl_close_notify(&conn->ssl);
    return JS_UNDEFINED;
}

static JSValue js_node_tls_free(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    NodeTLSState *st = node_tls_state;
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    if (st && id >= 0 && id < NODE_TLS_MAX_CONN && st->conns[id].used) {
        node_tls_conn_clear(&st->conns[id]);
        st->conns[id].used = 0;
    }
    return JS_UNDEFINED;
}

static JSValue js_node_tls_free_context(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    NodeTLSState *st = node_tls_state;
    int32_t id;
    NodeTLSContext *c;

    if (JS_ToInt32(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    if (!st || id < 0 || id >= NODE_TLS_MAX_CTX ||
        !(c = st->contexts[id]))
        return JS_UNDEFINED;
    st->contexts[id] = NULL;
    c->used = 0;
    node_tls_context_put(c);
    return JS_UNDEFINED;
}

static JSValue node_tls_name_object(JSContext *ctx, const mbedtls_x509_name *name)
{
    JSValue obj = JS_NewObject(ctx);
    for (const mbedtls_x509_name *cur = name; cur; cur = cur->next) {
        const char *key = node_tls_oid_short_name(&cur->oid);
        if (key)
            JS_SetPropertyStr(ctx, obj, key,
                              JS_NewStringLen(ctx, (const char *)cur->val.p,
                                              cur->val.len));
    }
    return obj;
}

static JSValue node_tls_time_string(JSContext *ctx, const mbedtls_x509_time *t)
{
    static const char *months[] = {
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    };
    char buf[64];

    if (t->mon < 1 || t->mon > 12)
        return JS_NULL;
    snprintf(buf, sizeof(buf), "%s %2d %02d:%02d:%02d %d GMT",
             months[t->mon - 1], t->day, t->hour, t->min, t->sec, t->year);
    return JS_NewString(ctx, buf);
}

/* Format the serial the way Node does: uppercase hex with leading zero
   bytes stripped. */
static JSValue node_tls_serial_string(JSContext *ctx,
                                      const mbedtls_x509_buf *serial)
{
    static const char hex[] = "0123456789ABCDEF";
    size_t i = 0, n;
    char *buf, *p;
    JSValue v;

    while (i < serial->len && serial->p[i] == 0)
        i++;
    n = serial->len - i;
    if (n == 0)
        return JS_NewString(ctx, "0");
    buf = js_malloc(ctx, n * 2 + 1);
    if (!buf)
        return JS_EXCEPTION;
    p = buf;
    for (; i < serial->len; i++) {
        *p++ = hex[serial->p[i] >> 4];
        *p++ = hex[serial->p[i] & 0x0f];
    }
    *p = '\0';
    v = JS_NewStringLen(ctx, buf, n * 2);
    js_free(ctx, buf);
    return v;
}

static JSValue js_node_tls_peer_cert(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    NodeTLSConn *conn = node_tls_conn(ctx, argv[0]);
    const mbedtls_x509_crt *cert;
    JSValue obj;

    if (!conn)
        return JS_EXCEPTION;
    cert = mbedtls_ssl_get_peer_cert(&conn->ssl);
    if (!cert)
        return JS_NULL;

    obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "subject",
                      node_tls_name_object(ctx, &cert->subject));
    JS_SetPropertyStr(ctx, obj, "issuer",
                      node_tls_name_object(ctx, &cert->issuer));
    JS_SetPropertyStr(ctx, obj, "valid_from",
                      node_tls_time_string(ctx, &cert->valid_from));
    JS_SetPropertyStr(ctx, obj, "valid_to",
                      node_tls_time_string(ctx, &cert->valid_to));
    JS_SetPropertyStr(ctx, obj, "raw",
                      JS_NewArrayBufferCopy(ctx, cert->raw.p, cert->raw.len));
    JS_SetPropertyStr(ctx, obj, "serialNumber",
                      node_tls_serial_string(ctx, &cert->serial));

    {
        size_t cap = cert->raw.len * 2 + 256;
        unsigned char *pem = js_malloc(ctx, cap);
        if (pem) {
            size_t olen = 0;
            int ret = mbedtls_pem_write_buffer(
                "-----BEGIN CERTIFICATE-----\n",
                "-----END CERTIFICATE-----\n",
                cert->raw.p, cert->raw.len, pem, cap, &olen);
            if (ret == 0)
                JS_SetPropertyStr(ctx, obj, "pem",
                                  JS_NewStringLen(ctx, (const char *)pem, olen));
            js_free(ctx, pem);
        }
    }

    {
        const mbedtls_md_info_t *info =
            mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
        unsigned char md[32];
        if (info && mbedtls_md(info, cert->raw.p, cert->raw.len, md) == 0) {
            size_t size = mbedtls_md_get_size(info) * 3;
            char *fp = js_malloc(ctx, size);
            if (fp) {
                size_t off = 0;
                for (size_t i = 0; i < mbedtls_md_get_size(info); i++) {
                    if (i)
                        fp[off++] = ':';
                    snprintf(fp + off, 3, "%02X", md[i]);
                    off += 2;
                }
                fp[off] = '\0';
                JS_SetPropertyStr(ctx, obj, "fingerprint256",
                                  JS_NewString(ctx, fp));
                js_free(ctx, fp);
            }
        }
    }

    return obj;
}

static JSValue js_node_tls_info(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    NodeTLSConn *conn = node_tls_conn(ctx, argv[0]);
    const char *protocol, *cipher, *alpn;
    JSValue obj;

    if (!conn)
        return JS_EXCEPTION;
    protocol = mbedtls_ssl_get_version(&conn->ssl);
    cipher = mbedtls_ssl_get_ciphersuite(&conn->ssl);
    alpn = mbedtls_ssl_get_alpn_protocol(&conn->ssl);

    obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "protocol",
                      JS_NewString(ctx, protocol ? protocol : ""));
    JS_SetPropertyStr(ctx, obj, "cipher",
                      JS_NewString(ctx, cipher ? cipher : ""));
    if (alpn && alpn[0])
        JS_SetPropertyStr(ctx, obj, "alpnProtocol", JS_NewString(ctx, alpn));
    else
        JS_SetPropertyStr(ctx, obj, "alpnProtocol", JS_FALSE);
    return obj;
}

/* ---------------- digest ---------------- */

/* digest(name, data) -> Uint8Array. Used by crypto for algorithms that are
   not implemented in JS (sha384/sha512). */
static JSValue js_node_digest(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *name;
    NodeBytes in;
    unsigned char *out = NULL;
    size_t outlen;
    mbedtls_md_type_t type = MBEDTLS_MD_NONE;
    const mbedtls_md_info_t *info;
    JSValue val;

    name = node_cstr(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &in)) {
        JS_FreeCString(ctx, name);
        return JS_EXCEPTION;
    }

    if (!strcasecmp(name, "md5"))         type = MBEDTLS_MD_MD5;
    else if (!strcasecmp(name, "sha1"))   type = MBEDTLS_MD_SHA1;
    else if (!strcasecmp(name, "sha224")) type = MBEDTLS_MD_SHA224;
    else if (!strcasecmp(name, "sha256")) type = MBEDTLS_MD_SHA256;
    else if (!strcasecmp(name, "sha384")) type = MBEDTLS_MD_SHA384;
    else if (!strcasecmp(name, "sha512")) type = MBEDTLS_MD_SHA512;

    info = type == MBEDTLS_MD_NONE ? NULL : mbedtls_md_info_from_type(type);
    if (!info) {
        JS_FreeCString(ctx, name);
        node_free_bytes(ctx, &in);
        return JS_ThrowTypeError(ctx, "Digest method not supported: %s", name);
    }

    {
        NodeTLSState *st = node_tls_state_get();
        if (!st || node_tls_init(st) != 0) {
            JS_FreeCString(ctx, name);
            node_free_bytes(ctx, &in);
            return JS_ThrowPlainError(ctx, "cannot initialize TLS");
        }
    }
    outlen = mbedtls_md_get_size(info);
    out = js_malloc(ctx, outlen);
    if (!out) {
        JS_FreeCString(ctx, name);
        node_free_bytes(ctx, &in);
        return JS_EXCEPTION;
    }
    if (mbedtls_md(info, in.data, in.len, out) != 0) {
        js_free(ctx, out);
        JS_FreeCString(ctx, name);
        node_free_bytes(ctx, &in);
        return JS_ThrowPlainError(ctx, "digest failed: %s", name);
    }
    JS_FreeCString(ctx, name);
    node_free_bytes(ctx, &in);
    val = JS_NewUint8ArrayCopy(ctx, out, outlen);
    js_free(ctx, out);
    return val;
}

/* ---------------- crypto ---------------- */

/* Each worker thread needs its own DRBG because the TLS one is process
   global and is only safe on the main thread. */
typedef struct {
#if MBEDTLS_VERSION_MAJOR < 4
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context drbg;
#endif
    int initialized;
} NodeCryptoRng;

static NODE_THREAD_LOCAL NodeCryptoRng node_crypto_rng;

static int node_crypto_init(void)
{
    if (node_crypto_rng.initialized)
        return 0;
#if MBEDTLS_VERSION_MAJOR < 4
    mbedtls_entropy_init(&node_crypto_rng.entropy);
    mbedtls_ctr_drbg_init(&node_crypto_rng.drbg);
    if (mbedtls_ctr_drbg_seed(&node_crypto_rng.drbg, mbedtls_entropy_func,
                              &node_crypto_rng.entropy,
                              (const unsigned char *)"qnode crypto", 12) != 0)
        return -1;
#endif
    node_crypto_rng.initialized = 1;
    return 0;
}

static int node_crypto_random(void *p_rng, unsigned char *buf, size_t len)
{
#if MBEDTLS_VERSION_MAJOR < 4
    (void)p_rng;
    return mbedtls_ctr_drbg_random(&node_crypto_rng.drbg, buf, len);
#else
    (void)p_rng;
    (void)buf;
    (void)len;
    return -1;
#endif
}

static mbedtls_md_type_t node_md_type(const char *name)
{
    if (!strcasecmp(name, "md5"))         return MBEDTLS_MD_MD5;
    if (!strcasecmp(name, "sha1"))        return MBEDTLS_MD_SHA1;
    if (!strcasecmp(name, "sha224"))      return MBEDTLS_MD_SHA224;
    if (!strcasecmp(name, "sha256"))      return MBEDTLS_MD_SHA256;
    if (!strcasecmp(name, "sha384"))      return MBEDTLS_MD_SHA384;
    if (!strcasecmp(name, "sha512"))      return MBEDTLS_MD_SHA512;
    return MBEDTLS_MD_NONE;
}

static int node_crypto_parse_key(JSContext *ctx, const uint8_t *data, size_t len,
                                 const uint8_t *pwd, size_t pwdlen,
                                 mbedtls_pk_context *pk, int *is_private)
{
    uint8_t *copy = NULL;
    const unsigned char *in = data;
    size_t inlen = len;
    int ret;

    if (node_crypto_init() != 0)
        return -1;
    mbedtls_pk_init(pk);

    /* PEM parsers require a NUL-terminated buffer. */
    if (len >= 10 && !memcmp(data, "-----BEGIN", 10)) {
        copy = js_malloc(ctx, len + 1);
        if (!copy)
            return -1;
        memcpy(copy, data, len);
        copy[len] = '\0';
        in = copy;
        inlen = len + 1;
    }

    ret = mbedtls_pk_parse_key(pk, in, inlen, pwd, pwdlen,
                               node_crypto_random, NULL);
    if (ret == 0) {
        *is_private = 1;
    } else {
        mbedtls_pk_free(pk);
        mbedtls_pk_init(pk);
        ret = mbedtls_pk_parse_public_key(pk, in, inlen);
        if (ret == 0)
            *is_private = 0;
    }

    if (copy)
        js_free(ctx, copy);
    if (ret != 0) {
        mbedtls_pk_free(pk);
        return -1;
    }
    return 0;
}

static const char *node_curve_name(mbedtls_ecp_group_id id)
{
    switch (id) {
    case MBEDTLS_ECP_DP_SECP256R1: return "prime256v1";
    case MBEDTLS_ECP_DP_SECP384R1: return "secp384r1";
    case MBEDTLS_ECP_DP_SECP521R1: return "secp521r1";
#ifdef MBEDTLS_ECP_DP_SECP256K1_ENABLED
    case MBEDTLS_ECP_DP_SECP256K1: return "secp256k1";
#endif
    default: {
        const mbedtls_ecp_curve_info *info =
            mbedtls_ecp_curve_info_from_grp_id(id);
        return info ? info->name : "unknown";
    }
    }
}

static mbedtls_ecp_group_id node_curve_id(const char *name)
{
    if (!strcasecmp(name, "prime256v1") || !strcasecmp(name, "secp256r1") ||
        !strcasecmp(name, "p-256") || !strcasecmp(name, "p256"))
        return MBEDTLS_ECP_DP_SECP256R1;
    if (!strcasecmp(name, "secp384r1") || !strcasecmp(name, "p-384") ||
        !strcasecmp(name, "p384"))
        return MBEDTLS_ECP_DP_SECP384R1;
    if (!strcasecmp(name, "secp521r1") || !strcasecmp(name, "p-521") ||
        !strcasecmp(name, "p521"))
        return MBEDTLS_ECP_DP_SECP521R1;
#ifdef MBEDTLS_ECP_DP_SECP256K1_ENABLED
    if (!strcasecmp(name, "secp256k1"))
        return MBEDTLS_ECP_DP_SECP256K1;
#endif
    return MBEDTLS_ECP_DP_NONE;
}

static const uint8_t *node_curve_oid(mbedtls_ecp_group_id id, size_t *len)
{
    static const uint8_t p256[] = { 0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07 };
    static const uint8_t p384[] = { 0x2b,0x81,0x04,0x00,0x22 };
    static const uint8_t p521[] = { 0x2b,0x81,0x04,0x00,0x23 };
#ifdef MBEDTLS_ECP_DP_SECP256K1_ENABLED
    static const uint8_t k256[] = { 0x2b,0x81,0x04,0x00,0x0a };
#endif
    switch (id) {
    case MBEDTLS_ECP_DP_SECP256R1: *len = sizeof(p256); return p256;
    case MBEDTLS_ECP_DP_SECP384R1: *len = sizeof(p384); return p384;
    case MBEDTLS_ECP_DP_SECP521R1: *len = sizeof(p521); return p521;
#ifdef MBEDTLS_ECP_DP_SECP256K1_ENABLED
    case MBEDTLS_ECP_DP_SECP256K1: *len = sizeof(k256); return k256;
#endif
    default: return NULL;
    }
}

/* Small DER encoder used to wrap PKCS#1/SEC1 keys in PKCS#8. */
static size_t node_der_len_size(size_t n)
{
    if (n < 0x80) return 1;
    if (n <= 0xff) return 2;
    if (n <= 0xffff) return 3;
    return 4;
}

static size_t node_der_tlv_size(size_t n)
{
    return 1 + node_der_len_size(n) + n;
}

static uint8_t *node_der_write(uint8_t *p, uint8_t tag, size_t n)
{
    *p++ = tag;
    if (n < 0x80) {
        *p++ = (uint8_t)n;
    } else if (n <= 0xff) {
        *p++ = 0x81;
        *p++ = (uint8_t)n;
    } else if (n <= 0xffff) {
        *p++ = 0x82;
        *p++ = (uint8_t)(n >> 8);
        *p++ = (uint8_t)n;
    } else {
        *p++ = 0x83;
        *p++ = (uint8_t)(n >> 16);
        *p++ = (uint8_t)(n >> 8);
        *p++ = (uint8_t)n;
    }
    return p;
}

static uint8_t *node_der_write_oid(uint8_t *p, const uint8_t *oid, size_t len)
{
    p = node_der_write(p, 0x06, len);
    memcpy(p, oid, len);
    return p + len;
}

static int node_crypto_pkcs8_der(JSContext *ctx, mbedtls_pk_context *pk,
                                 const uint8_t *keyder, size_t keylen,
                                 uint8_t **out, size_t *outlen)
{
    static const uint8_t rsa_oid[] =
        { 0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01 };
    static const uint8_t ec_oid[] =
        { 0x2a,0x86,0x48,0xce,0x3d,0x02,0x01 };
    mbedtls_pk_type_t type = mbedtls_pk_get_type(pk);
    const uint8_t *alg_oid, *curve_oid = NULL;
    size_t alg_oid_len, curve_len = 0, alg_len, seq_len, total;
    uint8_t *buf, *p;

    if (type == MBEDTLS_PK_RSA) {
        alg_oid = rsa_oid;
        alg_oid_len = sizeof(rsa_oid);
    } else if (type == MBEDTLS_PK_ECKEY || type == MBEDTLS_PK_ECKEY_DH ||
               type == MBEDTLS_PK_ECDSA) {
        mbedtls_ecp_keypair *ec = mbedtls_pk_ec(*pk);
        if (!ec)
            return -1;
        curve_oid = node_curve_oid(ec->MBEDTLS_PRIVATE(grp).id, &curve_len);
        if (!curve_oid)
            return -1;
        alg_oid = ec_oid;
        alg_oid_len = sizeof(ec_oid);
    } else {
        return -1;
    }

    alg_len = node_der_tlv_size(alg_oid_len) +
              (type == MBEDTLS_PK_RSA ? 2 : node_der_tlv_size(curve_len));
    seq_len = node_der_tlv_size(1) + node_der_tlv_size(alg_len) +
              node_der_tlv_size(keylen);
    total = node_der_tlv_size(seq_len);

    buf = js_malloc(ctx, total);
    if (!buf)
        return -1;
    p = node_der_write(buf, 0x30, seq_len);
    p = node_der_write(p, 0x02, 1);
    *p++ = 0;
    p = node_der_write(p, 0x30, alg_len);
    p = node_der_write_oid(p, alg_oid, alg_oid_len);
    if (type == MBEDTLS_PK_RSA) {
        *p++ = 0x05;
        *p++ = 0x00;
    } else {
        p = node_der_write_oid(p, curve_oid, curve_len);
    }
    p = node_der_write(p, 0x04, keylen);
    memcpy(p, keyder, keylen);
    p += keylen;

    *out = buf;
    *outlen = (size_t)(p - buf);
    return 0;
}

static JSValue node_pem_encode(JSContext *ctx, const char *label,
                               const uint8_t *der, size_t derlen)
{
    size_t b64len = 0, i, len;
    unsigned char *b64;
    char begin[96], end[96], *out, *p;

    if (mbedtls_base64_encode(NULL, 0, &b64len, der, derlen) !=
        MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL) {
        if (b64len == 0)
            return JS_ThrowPlainError(ctx, "base64 encoding failed");
    }
    if (b64len == 0)
        b64len = ((derlen + 2) / 3) * 4 + 1;
    b64 = js_malloc(ctx, b64len);
    if (!b64)
        return JS_EXCEPTION;
    if (mbedtls_base64_encode(b64, b64len, &len, der, derlen) != 0) {
        js_free(ctx, b64);
        return JS_ThrowPlainError(ctx, "base64 encoding failed");
    }

    snprintf(begin, sizeof(begin), "-----BEGIN %s-----\n", label);
    snprintf(end, sizeof(end), "-----END %s-----\n", label);
    out = js_malloc(ctx, strlen(begin) + len * 2 + 128);
    if (!out) {
        js_free(ctx, b64);
        return JS_EXCEPTION;
    }
    p = out;
    memcpy(p, begin, strlen(begin));
    p += strlen(begin);
    for (i = 0; i < len; i++) {
        *p++ = (char)b64[i];
        if ((i + 1) % 64 == 0)
            *p++ = '\n';
    }
    if (len % 64 != 0)
        *p++ = '\n';
    memcpy(p, end, strlen(end));
    p += strlen(end);

    js_free(ctx, b64);
    JSValue v = JS_NewStringLen(ctx, out, p - out);
    js_free(ctx, out);
    return v;
}

/* Extract the BIT STRING payload from a SubjectPublicKeyInfo. */
static const uint8_t *node_der_tlv(const uint8_t *p, const uint8_t *end,
                                   uint8_t *tag, size_t *len)
{
    size_t l;
    int n;

    if (p + 2 > end)
        return NULL;
    *tag = *p++;
    l = *p++;
    if (l & 0x80) {
        n = (int)(l & 0x7f);
        if (n == 0 || n > 4 || p + n > end)
            return NULL;
        l = 0;
        while (n-- > 0)
            l = (l << 8) | *p++;
    }
    if (p + l > end)
        return NULL;
    *len = l;
    return p;
}

static const uint8_t *node_spki_to_pkcs1(const uint8_t *spki, size_t spki_len,
                                         size_t *outlen)
{
    const uint8_t *end = spki + spki_len, *p, *q;
    uint8_t tag;
    size_t len, alen;

    p = node_der_tlv(spki, end, &tag, &len);
    if (!p || tag != 0x30)
        return NULL;
    end = p + len;
    q = node_der_tlv(p, end, &tag, &alen);
    if (!q || tag != 0x30)
        return NULL;
    q = node_der_tlv(q + alen, end, &tag, &len);
    if (!q || tag != 0x03 || len < 1 || q[0] != 0)
        return NULL;
    *outlen = len - 1;
    return q + 1;
}

/* ---------------- Ed25519 (libsodium) ---------------- */

static pthread_once_t node_sodium_once = PTHREAD_ONCE_INIT;
static int node_sodium_status = -1;

static void node_sodium_init_once(void)
{
    node_sodium_status = sodium_init();
}

static int node_sodium_init(void)
{
    pthread_once(&node_sodium_once, node_sodium_init_once);
    return node_sodium_status < 0 ? -1 : 0;
}

/* Decode a PEM block into DER. Returns 1 when decoded, 0 when the input is
   not PEM, and -1 on malformed input. */
static int node_pem_to_der(JSContext *ctx, const uint8_t *data, size_t len,
                           uint8_t **out, size_t *outlen)
{
    const uint8_t *body, *end, *p;
    uint8_t *b64, *der;
    size_t b64len = 0, n = 0, derlen;

    if (len < 11 || memcmp(data, "-----BEGIN ", 11) != 0)
        return 0;
    p = memchr(data, '\n', len);
    if (!p)
        return -1;
    body = p + 1;
    end = NULL;
    for (p = body; p + 9 <= data + len; p++) {
        if (memcmp(p, "-----END ", 9) == 0) {
            end = p;
            break;
        }
    }
    if (!end)
        return -1;
    /* Traditional encrypted PEM (RFC 1421) puts Proc-Type/DEK-Info headers
       between the BEGIN line and the base64 payload. Those lines contain
       non-base64 characters (':' and ','), so skip through the blank line
       that terminates the header block. */
    for (p = body; p < end && *p != ':' && *p != '\n' && *p != '\r'; p++)
        ;
    if (p < end && *p == ':') {
        for (;;) {
            const uint8_t *nl = memchr(p, '\n', (size_t)(end - p));
            if (!nl)
                return -1;
            p = nl + 1;
            if (p < end && *p == '\n') {
                body = p + 1;
                break;
            }
            if (p + 1 < end && *p == '\r' && p[1] == '\n') {
                body = p + 2;
                break;
            }
            if (p >= end)
                return -1;
        }
    }
    for (p = body; p < end; p++) {
        if (*p != ' ' && *p != '\t' && *p != '\r' && *p != '\n')
            b64len++;
    }
    if (b64len == 0)
        return -1;
    b64 = js_malloc(ctx, b64len);
    if (!b64)
        return -1;
    for (p = body; p < end; p++) {
        if (*p != ' ' && *p != '\t' && *p != '\r' && *p != '\n')
            b64[n++] = *p;
    }
    derlen = b64len * 3 / 4 + 4;
    der = js_malloc(ctx, derlen);
    if (!der) {
        js_free(ctx, b64);
        return -1;
    }
    if (mbedtls_base64_decode(der, derlen, &derlen, b64, b64len) != 0) {
        js_free(ctx, b64);
        js_free(ctx, der);
        return -1;
    }
    js_free(ctx, b64);
    *out = der;
    *outlen = derlen;
    return 1;
}

static int node_ed25519_parse_der(const uint8_t *der, size_t derlen,
                                  int *is_private, uint8_t seed[32],
                                  uint8_t pub[32])
{
    static const uint8_t oid[] = { 0x2b, 0x65, 0x70 };
    const uint8_t *end = der + derlen, *p, *q, *v;
    uint8_t tag;
    size_t len, alen;

    p = node_der_tlv(der, end, &tag, &len);
    if (!p || tag != 0x30 || p + len > end)
        return 0;
    end = p + len;
    if (p >= end)
        return 0;

    if (*p == 0x02) {
        /* PKCS#8 PrivateKeyInfo. */
        v = node_der_tlv(p, end, &tag, &len);
        if (!v || tag != 0x02)
            return 0;
        p = v + len;
        v = node_der_tlv(p, end, &tag, &len);
        if (!v || tag != 0x30)
            return 0;
        q = node_der_tlv(v, v + len, &tag, &alen);
        if (!q || tag != 0x06 || alen != sizeof(oid) ||
            memcmp(q, oid, sizeof(oid)) != 0)
            return 0;
        p = v + len;
        v = node_der_tlv(p, end, &tag, &len);
        if (!v || tag != 0x04)
            return 0;
        q = node_der_tlv(v, v + len, &tag, &alen);
        if (!q || tag != 0x04 || alen != 32)
            return 0;
        memcpy(seed, q, 32);
        *is_private = 1;
        return 1;
    }

    if (*p == 0x30) {
        /* SubjectPublicKeyInfo. */
        v = node_der_tlv(p, end, &tag, &len);
        if (!v || tag != 0x30)
            return 0;
        q = node_der_tlv(v, v + len, &tag, &alen);
        if (!q || tag != 0x06 || alen != sizeof(oid) ||
            memcmp(q, oid, sizeof(oid)) != 0)
            return 0;
        p = v + len;
        v = node_der_tlv(p, end, &tag, &len);
        if (!v || tag != 0x03 || len != 33 || v[0] != 0)
            return 0;
        memcpy(pub, v + 1, 32);
        *is_private = 0;
        return 1;
    }

    return 0;
}

/* Returns 1 for an Ed25519 key, 0 when the input is not Ed25519, and -1 on
   malformed PEM input. */
static int node_ed25519_parse(JSContext *ctx, const uint8_t *data, size_t len,
                              int *is_private, uint8_t seed[32],
                              uint8_t pub[32])
{
    uint8_t *der = NULL;
    size_t derlen = 0;
    const uint8_t *use = data;
    int ret;

    if (len >= 11 && memcmp(data, "-----BEGIN ", 11) == 0) {
        ret = node_pem_to_der(ctx, data, len, &der, &derlen);
        if (ret <= 0)
            return ret;
        use = der;
    } else {
        derlen = len;
    }
    ret = node_ed25519_parse_der(use, derlen, is_private, seed, pub);
    if (der)
        js_free(ctx, der);
    return ret;
}

static int node_ed25519_pkcs8_der(JSContext *ctx, const uint8_t seed[32],
                                  uint8_t **out, size_t *outlen)
{
    static const uint8_t oid[] = { 0x2b, 0x65, 0x70 };
    size_t inner = node_der_tlv_size(32);
    size_t content = 3 + node_der_tlv_size(node_der_tlv_size(sizeof(oid))) +
                     node_der_tlv_size(inner);
    size_t total = node_der_tlv_size(content);
    uint8_t *buf = js_malloc(ctx, total), *p;

    if (!buf)
        return -1;
    p = node_der_write(buf, 0x30, content);
    p = node_der_write(p, 0x02, 1);
    *p++ = 0;
    p = node_der_write(p, 0x30, node_der_tlv_size(sizeof(oid)));
    p = node_der_write_oid(p, oid, sizeof(oid));
    p = node_der_write(p, 0x04, inner);
    p = node_der_write(p, 0x04, 32);
    memcpy(p, seed, 32);
    p += 32;
    *out = buf;
    *outlen = (size_t)(p - buf);
    return 0;
}

static int node_ed25519_spki_der(JSContext *ctx, const uint8_t pub[32],
                                 uint8_t **out, size_t *outlen)
{
    static const uint8_t oid[] = { 0x2b, 0x65, 0x70 };
    size_t content = node_der_tlv_size(node_der_tlv_size(sizeof(oid))) +
                     node_der_tlv_size(33);
    size_t total = node_der_tlv_size(content);
    uint8_t *buf = js_malloc(ctx, total), *p;

    if (!buf)
        return -1;
    p = node_der_write(buf, 0x30, content);
    p = node_der_write(p, 0x30, node_der_tlv_size(sizeof(oid)));
    p = node_der_write_oid(p, oid, sizeof(oid));
    p = node_der_write(p, 0x03, 33);
    *p++ = 0;
    memcpy(p, pub, 32);
    p += 32;
    *out = buf;
    *outlen = (size_t)(p - buf);
    return 0;
}

static JSValue js_node_crypto_key_info(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    NodeBytes in, pwd;
    mbedtls_pk_context pk;
    int is_private = 0;
    JSValue obj, details;
    const uint8_t *pwd_data = NULL;
    size_t pwd_len = 0;

    if (node_get_bytes(ctx, argv[0], &in))
        return JS_EXCEPTION;
    memset(&pwd, 0, sizeof(pwd));
    pwd.abuf = JS_UNDEFINED;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        if (node_get_bytes(ctx, argv[1], &pwd)) {
            node_free_bytes(ctx, &in);
            return JS_EXCEPTION;
        }
        pwd_data = pwd.data;
        pwd_len = pwd.len;
    }
    {
        uint8_t seed[32], edpub[32];
        int ed_private = 0;
        int ed = node_ed25519_parse(ctx, in.data, in.len, &ed_private,
                                    seed, edpub);
        if (ed < 0) {
            node_free_bytes(ctx, &in);
            node_free_bytes(ctx, &pwd);
            return JS_ThrowTypeError(ctx, "Invalid key data");
        }
        if (ed == 1) {
            obj = JS_NewObject(ctx);
            details = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, obj, "type",
                              JS_NewString(ctx, ed_private ? "private"
                                                          : "public"));
            JS_SetPropertyStr(ctx, obj, "asymmetricKeyType",
                              JS_NewString(ctx, "ed25519"));
            JS_SetPropertyStr(ctx, obj, "details", details);
            node_free_bytes(ctx, &in);
            node_free_bytes(ctx, &pwd);
            return obj;
        }
    }
    if (node_crypto_parse_key(ctx, in.data, in.len, pwd_data, pwd_len,
                              &pk, &is_private)) {
        node_free_bytes(ctx, &in);
        node_free_bytes(ctx, &pwd);
        return JS_ThrowTypeError(ctx, "Invalid key data");
    }

    obj = JS_NewObject(ctx);
    details = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "type",
                      JS_NewString(ctx, is_private ? "private" : "public"));

    mbedtls_pk_type_t type = mbedtls_pk_get_type(&pk);
    if (type == MBEDTLS_PK_RSA) {
        mbedtls_rsa_context *rsa = mbedtls_pk_rsa(pk);
        mbedtls_mpi E;
        unsigned long exponent = 65537;

        mbedtls_mpi_init(&E);
        if (rsa && mbedtls_rsa_export(rsa, NULL, NULL, NULL, NULL, &E) == 0) {
            size_t elen = mbedtls_mpi_size(&E);
            uint8_t ebuf[8];
            if (elen <= sizeof(ebuf)) {
                if (mbedtls_mpi_write_binary(&E, ebuf, elen) == 0) {
                    exponent = 0;
                    for (size_t i = 0; i < elen; i++)
                        exponent = (exponent << 8) | ebuf[i];
                }
            }
        }
        mbedtls_mpi_free(&E);
        JS_SetPropertyStr(ctx, obj, "asymmetricKeyType", JS_NewString(ctx, "rsa"));
        JS_SetPropertyStr(ctx, details, "modulusLength",
                          JS_NewInt64(ctx, (int64_t)mbedtls_pk_get_bitlen(&pk)));
        JS_SetPropertyStr(ctx, details, "publicExponent",
                          JS_NewFloat64(ctx, (double)exponent));
    } else if (type == MBEDTLS_PK_ECKEY || type == MBEDTLS_PK_ECKEY_DH ||
               type == MBEDTLS_PK_ECDSA) {
        mbedtls_ecp_keypair *ec = mbedtls_pk_ec(pk);
        const char *name = ec ? node_curve_name(ec->MBEDTLS_PRIVATE(grp).id)
                              : "unknown";
        JS_SetPropertyStr(ctx, obj, "asymmetricKeyType", JS_NewString(ctx, "ec"));
        JS_SetPropertyStr(ctx, details, "namedCurve", JS_NewString(ctx, name));
    } else {
        JS_SetPropertyStr(ctx, obj, "asymmetricKeyType",
                          JS_NewString(ctx, mbedtls_pk_get_name(&pk)));
    }
    JS_SetPropertyStr(ctx, obj, "details", details);

    mbedtls_pk_free(&pk);
    node_free_bytes(ctx, &in);
    node_free_bytes(ctx, &pwd);
    return obj;
}

static JSValue js_node_crypto_export_key(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    NodeBytes in, pwd;
    mbedtls_pk_context pk;
    const char *kind;
    const uint8_t *pwd_data = NULL;
    size_t pwd_len = 0;
    int is_private = 0, ret = -1;
    uint8_t *buf = NULL;
    size_t bufsize, len = 0;
    JSValue result = JS_EXCEPTION;

    if (node_get_bytes(ctx, argv[0], &in))
        return JS_EXCEPTION;
    memset(&pwd, 0, sizeof(pwd));
    pwd.abuf = JS_UNDEFINED;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        if (node_get_bytes(ctx, argv[1], &pwd)) {
            node_free_bytes(ctx, &in);
            return JS_EXCEPTION;
        }
        pwd_data = pwd.data;
        pwd_len = pwd.len;
    }
    kind = node_cstr(ctx, argv[2]);
    if (!kind) {
        node_free_bytes(ctx, &in);
        node_free_bytes(ctx, &pwd);
        return JS_EXCEPTION;
    }
    mbedtls_pk_init(&pk);
    {
        uint8_t seed[32], edpub[32], sk[64];
        int ed_private = 0;
        int ed = node_ed25519_parse(ctx, in.data, in.len, &ed_private,
                                    seed, edpub);
        if (ed < 0) {
            JS_ThrowTypeError(ctx, "Invalid key data");
            goto done;
        }
        if (ed == 1) {
            if (node_sodium_init() != 0) {
                JS_ThrowPlainError(ctx, "Failed to initialize crypto");
                goto done;
            }
            if (ed_private)
                crypto_sign_ed25519_seed_keypair(edpub, sk, seed);
            if (!strcmp(kind, "pkcs8-der") || !strcmp(kind, "pkcs8-pem")) {
                if (!ed_private) {
                    JS_ThrowTypeError(ctx, "Private key required");
                    goto done;
                }
                if (node_ed25519_pkcs8_der(ctx, seed, &buf, &len) != 0) {
                    JS_ThrowOutOfMemory(ctx);
                    goto done;
                }
                if (!strcmp(kind, "pkcs8-der"))
                    result = JS_NewUint8ArrayCopy(ctx, buf, len);
                else
                    result = node_pem_encode(ctx, "PRIVATE KEY", buf, len);
            } else if (!strcmp(kind, "spki-der") ||
                       !strcmp(kind, "spki-pem")) {
                if (node_ed25519_spki_der(ctx, edpub, &buf, &len) != 0) {
                    JS_ThrowOutOfMemory(ctx);
                    goto done;
                }
                if (!strcmp(kind, "spki-der"))
                    result = JS_NewUint8ArrayCopy(ctx, buf, len);
                else
                    result = node_pem_encode(ctx, "PUBLIC KEY", buf, len);
            } else {
                JS_ThrowTypeError(ctx, "Unsupported key type for Ed25519");
            }
            goto done;
        }
    }
    if (node_crypto_parse_key(ctx, in.data, in.len, pwd_data, pwd_len,
                              &pk, &is_private)) {
        JS_FreeCString(ctx, kind);
        node_free_bytes(ctx, &in);
        node_free_bytes(ctx, &pwd);
        return JS_ThrowTypeError(ctx, "Invalid key data");
    }

    {
        mbedtls_pk_type_t kt = mbedtls_pk_get_type(&pk);
        int is_rsa = kt == MBEDTLS_PK_RSA;
        int is_ec = kt == MBEDTLS_PK_ECKEY || kt == MBEDTLS_PK_ECKEY_DH ||
                    kt == MBEDTLS_PK_ECDSA;
        if (strncmp(kind, "pkcs1", 5) == 0 && !is_rsa) {
            JS_ThrowTypeError(ctx, "Key is not an RSA key");
            goto done;
        }
        if (strncmp(kind, "sec1", 4) == 0 && !is_ec) {
            JS_ThrowTypeError(ctx, "Key is not an EC key");
            goto done;
        }
    }

    bufsize = (mbedtls_pk_get_bitlen(&pk) / 8) * 6 + 4096;

    if (!strcmp(kind, "pkcs8-der") || !strcmp(kind, "pkcs8-pem") ||
        !strcmp(kind, "pkcs1-der") || !strcmp(kind, "pkcs1-pem") ||
        !strcmp(kind, "sec1-der") || !strcmp(kind, "sec1-pem")) {
        if (!is_private) {
            JS_ThrowTypeError(ctx, "Private key required");
            goto done;
        }
    }

    if (!strcmp(kind, "spki-der") || !strcmp(kind, "spki-pem") ||
        !strcmp(kind, "pkcs1-public-der") || !strcmp(kind, "pkcs1-public-pem")) {
        uint8_t *der;
        size_t der_size;

        buf = js_malloc(ctx, bufsize);
        if (!buf)
            goto done;
        ret = mbedtls_pk_write_pubkey_der(&pk, buf, bufsize);
        if (ret < 0)
            goto done;
        der = buf + bufsize - ret;
        der_size = (size_t)ret;

        if (!strcmp(kind, "spki-der")) {
            result = JS_NewUint8ArrayCopy(ctx, der, der_size);
        } else if (!strcmp(kind, "spki-pem")) {
            result = node_pem_encode(ctx, "PUBLIC KEY", der, der_size);
        } else {
            const uint8_t *inner = node_spki_to_pkcs1(der, der_size, &len);
            if (!inner) {
                JS_ThrowTypeError(ctx, "Key is not an RSA key");
                goto done;
            }
            if (!strcmp(kind, "pkcs1-public-der"))
                result = JS_NewUint8ArrayCopy(ctx, inner, len);
            else
                result = node_pem_encode(ctx, "RSA PUBLIC KEY", inner, len);
        }
        goto done;
    }

    buf = js_malloc(ctx, bufsize);
    if (!buf)
        goto done;
    if (!strcmp(kind, "pkcs1-der") || !strcmp(kind, "sec1-der")) {
        ret = mbedtls_pk_write_key_der(&pk, buf, bufsize);
        if (ret < 0)
            goto done;
        result = JS_NewUint8ArrayCopy(ctx, buf + bufsize - ret, (size_t)ret);
    } else if (!strcmp(kind, "pkcs1-pem") || !strcmp(kind, "sec1-pem")) {
        ret = mbedtls_pk_write_key_pem(&pk, buf, bufsize);
        if (ret < 0)
            goto done;
        result = JS_NewString(ctx, (const char *)buf);
    } else {
        uint8_t *der = NULL;
        size_t derlen = 0;
        uint8_t *wrapped = NULL;
        size_t wrappedlen = 0;

        ret = mbedtls_pk_write_key_der(&pk, buf, bufsize);
        if (ret < 0)
            goto done;
        der = buf + bufsize - ret;
        derlen = (size_t)ret;
        if (node_crypto_pkcs8_der(ctx, &pk, der, derlen,
                                  &wrapped, &wrappedlen) != 0) {
            JS_ThrowTypeError(ctx, "Unsupported key type");
            goto done;
        }
        if (!strcmp(kind, "pkcs8-der"))
            result = JS_NewUint8ArrayCopy(ctx, wrapped, wrappedlen);
        else
            result = node_pem_encode(ctx, "PRIVATE KEY", wrapped, wrappedlen);
        js_free(ctx, wrapped);
    }

done:
    JS_FreeCString(ctx, kind);
    if (buf)
        js_free(ctx, buf);
    mbedtls_pk_free(&pk);
    node_free_bytes(ctx, &in);
    node_free_bytes(ctx, &pwd);
    return result;
}

static JSValue js_node_crypto_generate_key_pair(JSContext *ctx,
                                                JSValueConst this_val,
                                                int argc, JSValueConst *argv)
{
    const char *type = node_cstr(ctx, argv[0]);
    int32_t bits = 2048;
    uint32_t exponent = 65537;
    const char *curve = "prime256v1";
    mbedtls_pk_context pk;
    uint8_t *buf = NULL, *priv = NULL, *pub = NULL;
    size_t bufsize, privlen = 0, publen = 0;
    JSValue obj = JS_EXCEPTION;

    if (!type)
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        JS_ToInt32(ctx, &bits, argv[1]);
    if (argc > 2 && !JS_IsUndefined(argv[2]))
        JS_ToUint32(ctx, &exponent, argv[2]);
    if (argc > 3 && !JS_IsUndefined(argv[3])) {
        curve = node_cstr(ctx, argv[3]);
        if (!curve) {
            JS_FreeCString(ctx, type);
            return JS_EXCEPTION;
        }
    }

    if (node_crypto_init() != 0) {
        JS_ThrowPlainError(ctx, "Failed to initialize RNG");
        goto out;
    }
    mbedtls_pk_init(&pk);

    if (!strcasecmp(type, "ed25519")) {
        uint8_t seed[32], edpub[32], sk[64];
        if (node_sodium_init() != 0) {
            JS_ThrowPlainError(ctx, "Failed to initialize crypto");
            goto out_pk;
        }
        crypto_sign_ed25519_keypair(edpub, sk);
        memcpy(seed, sk, 32);
        if (node_ed25519_pkcs8_der(ctx, seed, &priv, &privlen) != 0) {
            JS_ThrowOutOfMemory(ctx);
            goto out_pk;
        }
        if (node_ed25519_spki_der(ctx, edpub, &pub, &publen) != 0) {
            JS_ThrowOutOfMemory(ctx);
            goto out_pk;
        }
        goto build_obj;
    } else if (!strcasecmp(type, "rsa")) {
        if (bits < 512 || bits > 16384) {
            JS_ThrowRangeError(ctx, "Invalid modulus length");
            goto out_pk;
        }
        if (mbedtls_pk_setup(&pk,
                             mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) != 0) {
            JS_ThrowPlainError(ctx, "Failed to create RSA key");
            goto out_pk;
        }
        if (mbedtls_rsa_gen_key(mbedtls_pk_rsa(pk), node_crypto_random, NULL,
                                (unsigned int)bits, exponent) != 0) {
            JS_ThrowPlainError(ctx, "Failed to generate RSA key");
            goto out_pk;
        }
    } else if (!strcasecmp(type, "ec")) {
        mbedtls_ecp_group_id gid = node_curve_id(curve);
        if (gid == MBEDTLS_ECP_DP_NONE) {
            JS_ThrowTypeError(ctx, "Invalid named curve: %s", curve);
            goto out_pk;
        }
        if (mbedtls_pk_setup(&pk,
                             mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) != 0) {
            JS_ThrowPlainError(ctx, "Failed to create EC key");
            goto out_pk;
        }
        if (mbedtls_ecp_gen_key(gid, mbedtls_pk_ec(pk), node_crypto_random,
                                NULL) != 0) {
            JS_ThrowPlainError(ctx, "Failed to generate EC key");
            goto out_pk;
        }
    } else {
        JS_ThrowTypeError(ctx, "Unsupported key type: %s", type);
        goto out_pk;
    }

    bufsize = (mbedtls_pk_get_bitlen(&pk) / 8) * 6 + 4096;
    buf = js_malloc(ctx, bufsize);
    if (!buf) {
        JS_ThrowOutOfMemory(ctx);
        goto out_pk;
    }
    int n = mbedtls_pk_write_key_der(&pk, buf, bufsize);
    if (n < 0) {
        JS_ThrowPlainError(ctx, "Failed to export private key");
        goto out_pk;
    }
    if (node_crypto_pkcs8_der(ctx, &pk, buf + bufsize - n, (size_t)n,
                              &priv, &privlen) != 0) {
        JS_ThrowPlainError(ctx, "Failed to export private key");
        goto out_pk;
    }
    n = mbedtls_pk_write_pubkey_der(&pk, buf, bufsize);
    if (n < 0) {
        JS_ThrowPlainError(ctx, "Failed to export public key");
        goto out_pk;
    }
    pub = js_malloc(ctx, (size_t)n);
    if (!pub) {
        JS_ThrowOutOfMemory(ctx);
        goto out_pk;
    }
    memcpy(pub, buf + bufsize - n, (size_t)n);
    publen = (size_t)n;

build_obj:
    obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "privateKey",
                      JS_NewUint8ArrayCopy(ctx, priv, privlen));
    JS_SetPropertyStr(ctx, obj, "publicKey",
                      JS_NewUint8ArrayCopy(ctx, pub, publen));

out_pk:
    mbedtls_pk_free(&pk);
out:
    if (buf) js_free(ctx, buf);
    if (priv) js_free(ctx, priv);
    if (pub) js_free(ctx, pub);
    if (argc > 3 && !JS_IsUndefined(argv[3]))
        JS_FreeCString(ctx, curve);
    JS_FreeCString(ctx, type);
    return obj;
}

static int node_crypto_digest_data(JSContext *ctx, const char *mdname,
                                   const NodeBytes *data,
                                   mbedtls_md_type_t *md_type,
                                   const mbedtls_md_info_t **md_info,
                                   unsigned char **hash, size_t *hash_len)
{
    mbedtls_md_type_t type = node_md_type(mdname);
    const mbedtls_md_info_t *info;
    unsigned char *out;

    if (type == MBEDTLS_MD_NONE) {
        JS_ThrowTypeError(ctx, "Digest method not supported: %s", mdname);
        return -1;
    }
    info = mbedtls_md_info_from_type(type);
    if (!info) {
        JS_ThrowTypeError(ctx, "Digest method not supported: %s", mdname);
        return -1;
    }
    *hash_len = mbedtls_md_get_size(info);
    out = js_malloc(ctx, *hash_len);
    if (!out) {
        JS_ThrowOutOfMemory(ctx);
        return -1;
    }
    if (mbedtls_md(info, data->data, data->len, out) != 0) {
        js_free(ctx, out);
        JS_ThrowPlainError(ctx, "Digest failed");
        return -1;
    }
    *md_type = type;
    *md_info = info;
    *hash = out;
    return 0;
}

static JSValue js_node_crypto_sign(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *mdname;
    NodeBytes data, key;
    mbedtls_pk_context pk;
    mbedtls_md_type_t md_type;
    const mbedtls_md_info_t *md_info = NULL;
    unsigned char *hash = NULL;
    size_t hash_len = 0, sig_size, sig_len = 0;
    unsigned char *sig = NULL;
    int is_private = 0, pss = 0;
    uint8_t edseed[32], edpub[32], edsk[64];
    int ed_private = 0, ed;
    JSValue result = JS_EXCEPTION;

    mdname = node_cstr(ctx, argv[0]);
    if (!mdname)
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &data)) {
        JS_FreeCString(ctx, mdname);
        return JS_EXCEPTION;
    }
    if (node_get_bytes(ctx, argv[2], &key)) {
        JS_FreeCString(ctx, mdname);
        node_free_bytes(ctx, &data);
        return JS_EXCEPTION;
    }
    if (argc > 3 && JS_ToBool(ctx, argv[3]) > 0)
        pss = 1;

    ed = node_ed25519_parse(ctx, key.data, key.len, &ed_private, edseed, edpub);
    if (ed < 0) {
        JS_ThrowTypeError(ctx, "Invalid key data");
        goto out;
    }
    if (ed == 1) {
        unsigned char ed_sig[crypto_sign_ed25519_BYTES];
        unsigned long long ed_siglen = 0;

        if (!ed_private) {
            JS_ThrowTypeError(ctx, "Private key required");
            goto out;
        }
        if (node_sodium_init() != 0) {
            JS_ThrowPlainError(ctx, "Failed to initialize crypto");
            goto out;
        }
        crypto_sign_ed25519_seed_keypair(edpub, edsk, edseed);
        if (crypto_sign_ed25519_detached(ed_sig, &ed_siglen, data.data,
                                         data.len, edsk) != 0) {
            JS_ThrowPlainError(ctx, "Signing failed");
            goto out;
        }
        result = JS_NewUint8ArrayCopy(ctx, ed_sig, (size_t)ed_siglen);
        goto out;
    }

    if (node_crypto_parse_key(ctx, key.data, key.len, NULL, 0,
                              &pk, &is_private)) {
        JS_ThrowTypeError(ctx, "Invalid key data");
        goto out;
    }
    if (!is_private) {
        JS_ThrowTypeError(ctx, "Private key required");
        goto out_pk;
    }
    if (node_crypto_digest_data(ctx, mdname, &data, &md_type, &md_info,
                                &hash, &hash_len) != 0)
        goto out_pk;

    sig_size = MBEDTLS_PK_SIGNATURE_MAX_SIZE;
    if (sig_size < mbedtls_pk_get_len(&pk) + 16)
        sig_size = mbedtls_pk_get_len(&pk) + 16;
    sig = js_malloc(ctx, sig_size);
    if (!sig) {
        JS_ThrowOutOfMemory(ctx);
        goto out_pk;
    }

    int ret;
    if (pss) {
        ret = mbedtls_pk_sign_ext(MBEDTLS_PK_RSASSA_PSS, &pk, md_type,
                                  hash, hash_len, sig, sig_size, &sig_len,
                                  node_crypto_random, NULL);
    } else {
        ret = mbedtls_pk_sign(&pk, md_type, hash, hash_len, sig, sig_size,
                              &sig_len, node_crypto_random, NULL);
    }
    if (ret != 0) {
        JS_ThrowPlainError(ctx, "Signing failed");
        goto out_pk;
    }
    result = JS_NewUint8ArrayCopy(ctx, sig, sig_len);

out_pk:
    mbedtls_pk_free(&pk);
out:
    if (sig) js_free(ctx, sig);
    if (hash) js_free(ctx, hash);
    JS_FreeCString(ctx, mdname);
    node_free_bytes(ctx, &data);
    node_free_bytes(ctx, &key);
    return result;
}

static JSValue js_node_crypto_verify(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    const char *mdname;
    NodeBytes data, key, sigb;
    mbedtls_pk_context pk;
    mbedtls_md_type_t md_type;
    const mbedtls_md_info_t *md_info = NULL;
    unsigned char *hash = NULL;
    size_t hash_len = 0;
    int is_private = 0, pss = 0, ok = 0;
    uint8_t edseed[32], edpub[32], edsk[64];
    int ed_private = 0, ed;
    JSValue result = JS_FALSE;

    mdname = node_cstr(ctx, argv[0]);
    if (!mdname)
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &data)) {
        JS_FreeCString(ctx, mdname);
        return JS_EXCEPTION;
    }
    if (node_get_bytes(ctx, argv[2], &key)) {
        JS_FreeCString(ctx, mdname);
        node_free_bytes(ctx, &data);
        return JS_EXCEPTION;
    }
    if (node_get_bytes(ctx, argv[3], &sigb)) {
        JS_FreeCString(ctx, mdname);
        node_free_bytes(ctx, &data);
        node_free_bytes(ctx, &key);
        return JS_EXCEPTION;
    }
    if (argc > 4 && JS_ToBool(ctx, argv[4]) > 0)
        pss = 1;

    ed = node_ed25519_parse(ctx, key.data, key.len, &ed_private, edseed, edpub);
    if (ed < 0) {
        JS_ThrowTypeError(ctx, "Invalid key data");
        goto out;
    }
    if (ed == 1) {
        if (node_sodium_init() != 0) {
            JS_ThrowPlainError(ctx, "Failed to initialize crypto");
            goto out;
        }
        if (ed_private)
            crypto_sign_ed25519_seed_keypair(edpub, edsk, edseed);
        ok = sigb.len == crypto_sign_ed25519_BYTES &&
             crypto_sign_ed25519_verify_detached(
                 (const unsigned char *)sigb.data, data.data, data.len,
                 edpub) == 0;
        result = JS_NewBool(ctx, ok);
        goto out;
    }

    if (node_crypto_parse_key(ctx, key.data, key.len, NULL, 0,
                              &pk, &is_private)) {
        JS_ThrowTypeError(ctx, "Invalid key data");
        goto out;
    }
    if (node_crypto_digest_data(ctx, mdname, &data, &md_type, &md_info,
                                &hash, &hash_len) != 0)
        goto out_pk;

    if (pss) {
        mbedtls_pk_rsassa_pss_options opts;
        opts.mgf1_hash_id = md_type;
        opts.expected_salt_len = MBEDTLS_RSA_SALT_LEN_ANY;
        ok = mbedtls_pk_verify_ext(MBEDTLS_PK_RSASSA_PSS, &opts, &pk, md_type,
                                   hash, hash_len, sigb.data, sigb.len) == 0;
    } else {
        ok = mbedtls_pk_verify(&pk, md_type, hash, hash_len,
                               sigb.data, sigb.len) == 0;
    }
    result = JS_NewBool(ctx, ok);

out_pk:
    mbedtls_pk_free(&pk);
out:
    if (hash) js_free(ctx, hash);
    JS_FreeCString(ctx, mdname);
    node_free_bytes(ctx, &data);
    node_free_bytes(ctx, &key);
    node_free_bytes(ctx, &sigb);
    return result;
}

static JSValue js_node_crypto_pbkdf2(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    NodeBytes password, salt;
    const char *digest;
    int32_t iterations, keylen;
    mbedtls_md_type_t type;
    const mbedtls_md_info_t *info;
    unsigned char *out;
    JSValue result;

    if (node_get_bytes(ctx, argv[0], &password))
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &salt)) {
        node_free_bytes(ctx, &password);
        return JS_EXCEPTION;
    }
    digest = node_cstr(ctx, argv[4]);
    if (!digest) {
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_EXCEPTION;
    }
    if (JS_ToInt32(ctx, &iterations, argv[2]) ||
        JS_ToInt32(ctx, &keylen, argv[3])) {
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_EXCEPTION;
    }
    if (iterations < 1 || keylen < 1) {
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_ThrowRangeError(ctx, "Invalid PBKDF2 parameters");
    }
    type = node_md_type(digest);
    info = type == MBEDTLS_MD_NONE ? NULL : mbedtls_md_info_from_type(type);
    if (!info) {
        JSValue err = JS_ThrowTypeError(ctx, "Digest method not supported: %s",
                                        digest);
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return err;
    }
    out = js_malloc(ctx, (size_t)keylen);
    if (!out) {
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (mbedtls_pkcs5_pbkdf2_hmac_ext(type, password.data, password.len,
                                      salt.data, salt.len,
                                      (uint32_t)iterations, (uint32_t)keylen,
                                      out) != 0) {
        js_free(ctx, out);
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_ThrowPlainError(ctx, "PBKDF2 failed");
    }
    result = JS_NewUint8ArrayCopy(ctx, out, (size_t)keylen);
    js_free(ctx, out);
    JS_FreeCString(ctx, digest);
    node_free_bytes(ctx, &password);
    node_free_bytes(ctx, &salt);
    return result;
}

static JSValue js_node_crypto_hkdf(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    NodeBytes ikm, salt, info_b;
    const char *digest;
    int32_t keylen;
    mbedtls_md_type_t type;
    const mbedtls_md_info_t *info;
    unsigned char *out;
    JSValue result;
    const uint8_t *saltp = NULL, *infop = NULL;
    size_t saltlen = 0, infolen = 0;

    memset(&salt, 0, sizeof(salt));
    salt.abuf = JS_UNDEFINED;
    memset(&info_b, 0, sizeof(info_b));
    info_b.abuf = JS_UNDEFINED;

    if (node_get_bytes(ctx, argv[1], &ikm))
        return JS_EXCEPTION;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        if (node_get_bytes(ctx, argv[2], &salt)) {
            node_free_bytes(ctx, &ikm);
            return JS_EXCEPTION;
        }
        saltp = salt.data;
        saltlen = salt.len;
    }
    if (argc > 3 && !JS_IsUndefined(argv[3]) && !JS_IsNull(argv[3])) {
        if (node_get_bytes(ctx, argv[3], &info_b)) {
            node_free_bytes(ctx, &ikm);
            node_free_bytes(ctx, &salt);
            return JS_EXCEPTION;
        }
        infop = info_b.data;
        infolen = info_b.len;
    }
    digest = node_cstr(ctx, argv[0]);
    if (!digest) {
        node_free_bytes(ctx, &ikm);
        node_free_bytes(ctx, &salt);
        node_free_bytes(ctx, &info_b);
        return JS_EXCEPTION;
    }
    if (JS_ToInt32(ctx, &keylen, argv[4]) || keylen < 1) {
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &ikm);
        node_free_bytes(ctx, &salt);
        node_free_bytes(ctx, &info_b);
        return JS_ThrowRangeError(ctx, "Invalid HKDF key length");
    }
    type = node_md_type(digest);
    info = type == MBEDTLS_MD_NONE ? NULL : mbedtls_md_info_from_type(type);
    if (!info) {
        JSValue err = JS_ThrowTypeError(ctx, "Digest method not supported: %s",
                                        digest);
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &ikm);
        node_free_bytes(ctx, &salt);
        node_free_bytes(ctx, &info_b);
        return err;
    }
    out = js_malloc(ctx, (size_t)keylen);
    if (!out) {
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &ikm);
        node_free_bytes(ctx, &salt);
        node_free_bytes(ctx, &info_b);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (mbedtls_hkdf(info, saltp, saltlen, ikm.data, ikm.len,
                     infop, infolen, out, (size_t)keylen) != 0) {
        js_free(ctx, out);
        JS_FreeCString(ctx, digest);
        node_free_bytes(ctx, &ikm);
        node_free_bytes(ctx, &salt);
        node_free_bytes(ctx, &info_b);
        return JS_ThrowPlainError(ctx, "HKDF failed");
    }
    result = JS_NewUint8ArrayCopy(ctx, out, (size_t)keylen);
    js_free(ctx, out);
    JS_FreeCString(ctx, digest);
    node_free_bytes(ctx, &ikm);
    node_free_bytes(ctx, &salt);
    node_free_bytes(ctx, &info_b);
    return result;
}

/* ---- scrypt (Salsa20/8 + PBKDF2-HMAC-SHA256, RFC 7914) ---- */

static uint32_t node_rotl32(uint32_t x, int n)
{
    return (x << n) | (x >> (32 - n));
}

static void node_salsa20_8(uint32_t out[16], const uint32_t in[16])
{
    uint32_t x[16];
    int i;

    memcpy(x, in, sizeof(x));
    for (i = 0; i < 8; i += 2) {
        x[ 4] ^= node_rotl32(x[ 0] + x[12],  7);
        x[ 8] ^= node_rotl32(x[ 4] + x[ 0],  9);
        x[12] ^= node_rotl32(x[ 8] + x[ 4], 13);
        x[ 0] ^= node_rotl32(x[12] + x[ 8], 18);
        x[ 9] ^= node_rotl32(x[ 5] + x[ 1],  7);
        x[13] ^= node_rotl32(x[ 9] + x[ 5],  9);
        x[ 1] ^= node_rotl32(x[13] + x[ 9], 13);
        x[ 5] ^= node_rotl32(x[ 1] + x[13], 18);
        x[14] ^= node_rotl32(x[10] + x[ 6],  7);
        x[ 2] ^= node_rotl32(x[14] + x[10],  9);
        x[ 6] ^= node_rotl32(x[ 2] + x[14], 13);
        x[10] ^= node_rotl32(x[ 6] + x[ 2], 18);
        x[ 3] ^= node_rotl32(x[15] + x[11],  7);
        x[ 7] ^= node_rotl32(x[ 3] + x[15],  9);
        x[11] ^= node_rotl32(x[ 7] + x[ 3], 13);
        x[15] ^= node_rotl32(x[11] + x[ 7], 18);
        x[ 1] ^= node_rotl32(x[ 0] + x[ 3],  7);
        x[ 2] ^= node_rotl32(x[ 1] + x[ 0],  9);
        x[ 3] ^= node_rotl32(x[ 2] + x[ 1], 13);
        x[ 0] ^= node_rotl32(x[ 3] + x[ 2], 18);
        x[ 6] ^= node_rotl32(x[ 5] + x[ 4],  7);
        x[ 7] ^= node_rotl32(x[ 6] + x[ 5],  9);
        x[ 4] ^= node_rotl32(x[ 7] + x[ 6], 13);
        x[ 5] ^= node_rotl32(x[ 4] + x[ 7], 18);
        x[11] ^= node_rotl32(x[10] + x[ 9],  7);
        x[ 8] ^= node_rotl32(x[11] + x[10],  9);
        x[ 9] ^= node_rotl32(x[ 8] + x[11], 13);
        x[10] ^= node_rotl32(x[ 9] + x[ 8], 18);
        x[12] ^= node_rotl32(x[15] + x[14],  7);
        x[13] ^= node_rotl32(x[12] + x[15],  9);
        x[14] ^= node_rotl32(x[13] + x[12], 13);
        x[15] ^= node_rotl32(x[14] + x[13], 18);
    }
    for (i = 0; i < 16; i++)
        out[i] = x[i] + in[i];
}

static void node_scrypt_blockmix(uint32_t *B, uint32_t *Y, uint32_t r)
{
    uint32_t X[16], T[16];
    uint32_t i, j;

    memcpy(X, B + (2 * r - 1) * 16, sizeof(X));
    for (i = 0; i < 2 * r; i++) {
        for (j = 0; j < 16; j++)
            X[j] ^= B[i * 16 + j];
        node_salsa20_8(T, X);
        memcpy(X, T, sizeof(X));
        memcpy(Y + i * 16, X, sizeof(X));
    }
    for (i = 0; i < r; i++) {
        memcpy(B + i * 16, Y + (2 * i) * 16, sizeof(X));
        memcpy(B + (i + r) * 16, Y + (2 * i + 1) * 16, sizeof(X));
    }
}

static void node_scrypt_romix(uint32_t *X, uint32_t *V, uint32_t *Y,
                              uint32_t N, uint32_t r)
{
    uint32_t blocks = 2 * r, words = blocks * 16;
    uint32_t i, j, k;

    for (i = 0; i < N; i++) {
        memcpy(V + (size_t)i * words, X, (size_t)words * sizeof(uint32_t));
        node_scrypt_blockmix(X, Y, r);
    }
    for (i = 0; i < N; i++) {
        j = X[(blocks - 1) * 16] % N;
        for (k = 0; k < words; k++)
            X[k] ^= V[(size_t)j * words + k];
        node_scrypt_blockmix(X, Y, r);
    }
}

static JSValue js_node_crypto_scrypt(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    NodeBytes password, salt;
    int32_t keylen, N, r, p, maxmem;
    uint8_t *B = NULL, *out = NULL;
    uint32_t *V = NULL, *Y = NULL;
    size_t blocklen, blen, vlen;
    JSValue result = JS_EXCEPTION;

    if (node_get_bytes(ctx, argv[0], &password))
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &salt)) {
        node_free_bytes(ctx, &password);
        return JS_EXCEPTION;
    }
    if (JS_ToInt32(ctx, &keylen, argv[2]) ||
        JS_ToInt32(ctx, &N, argv[3]) ||
        JS_ToInt32(ctx, &r, argv[4]) ||
        JS_ToInt32(ctx, &p, argv[5]) ||
        JS_ToInt32(ctx, &maxmem, argv[6])) {
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_EXCEPTION;
    }
    if (keylen < 1 || N < 2 || (N & (N - 1)) != 0 || r < 1 || p < 1 ||
        maxmem < 1) {
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_ThrowRangeError(ctx, "Invalid scrypt parameters");
    }
    blocklen = 128u * (size_t)r;
    blen = blocklen * (size_t)p;
    vlen = blocklen * (size_t)N;
    if (vlen > (size_t)maxmem) {
        node_free_bytes(ctx, &password);
        node_free_bytes(ctx, &salt);
        return JS_ThrowRangeError(ctx, "scrypt memory limit exceeded");
    }

    B = js_malloc(ctx, blen);
    V = js_malloc(ctx, vlen);
    Y = js_malloc(ctx, blocklen);
    out = js_malloc(ctx, (size_t)keylen);
    if (!B || !V || !Y || !out) {
        JS_ThrowOutOfMemory(ctx);
        goto done;
    }
    if (mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, password.data,
                                      password.len, salt.data, salt.len, 1,
                                      (uint32_t)blen, B) != 0) {
        JS_ThrowPlainError(ctx, "scrypt failed");
        goto done;
    }
    for (int i = 0; i < p; i++)
        node_scrypt_romix((uint32_t *)(B + (size_t)i * blocklen), V, Y,
                          (uint32_t)N, (uint32_t)r);
    if (mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, password.data,
                                      password.len, B, blen, 1,
                                      (uint32_t)keylen, out) != 0) {
        JS_ThrowPlainError(ctx, "scrypt failed");
        goto done;
    }
    result = JS_NewUint8ArrayCopy(ctx, out, (size_t)keylen);

done:
    if (B) js_free(ctx, B);
    if (V) js_free(ctx, V);
    if (Y) js_free(ctx, Y);
    if (out) js_free(ctx, out);
    node_free_bytes(ctx, &password);
    node_free_bytes(ctx, &salt);
    return result;
}

/* ---------------- native object ---------------- */

/* Request that the current worker stop its event loop. Unlike qjsstd.exit()
   this never terminates the whole process. */
static JSValue js_node_worker_exit(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int32_t code = 0;
    if (argc > 0 && !JS_IsUndefined(argv[0]))
        JS_ToInt32(ctx, &code, argv[0]);
    js_std_worker_request_exit(ctx, code);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry js_node_funcs[] = {
    JS_CFUNC_DEF("getpid", 0, js_node_getpid),
    JS_CFUNC_DEF("getppid", 0, js_node_getppid),
    JS_CFUNC_DEF("getuid", 0, js_node_getuid),
    JS_CFUNC_DEF("getgid", 0, js_node_getgid),
    JS_CFUNC_DEF("umask", 0, js_node_umask),
    JS_CFUNC_DEF("kill", 2, js_node_kill),
    JS_CFUNC_DEF("abort", 0, js_node_abort),
    JS_CFUNC_DEF("cwd", 0, js_node_cwd),
    JS_CFUNC_DEF("chdir", 1, js_node_chdir),
    JS_CFUNC_DEF("hrtime", 0, js_node_hrtime),
    JS_CFUNC_DEF("hostname", 0, js_node_hostname),
    JS_CFUNC_DEF("exepath", 0, js_node_exepath),
    JS_CFUNC_DEF("randomBytes", 1, js_node_random_bytes),
    JS_CFUNC_DEF("stdoutWrite", 1, js_node_stdout_write),
    JS_CFUNC_DEF("stderrWrite", 1, js_node_stderr_write),

    JS_CFUNC_DEF("readFile", 1, js_node_read_file),
    JS_CFUNC_DEF("writeFile", 4, js_node_write_file),
    JS_CFUNC_DEF("stat", 2, js_node_stat),
    JS_CFUNC_DEF("fstat", 1, js_node_fstat),
    JS_CFUNC_DEF("readdir", 1, js_node_readdir),
    JS_CFUNC_DEF("mkdir", 2, js_node_mkdir),
    JS_CFUNC_DEF("rmdir", 1, js_node_rmdir),
    JS_CFUNC_DEF("unlink", 1, js_node_unlink),
    JS_CFUNC_DEF("rename", 2, js_node_rename),
    JS_CFUNC_DEF("realpath", 1, js_node_realpath),
    JS_CFUNC_DEF("readlink", 1, js_node_readlink),
    JS_CFUNC_DEF("symlink", 2, js_node_symlink),
    JS_CFUNC_DEF("chmod", 2, js_node_chmod),
    JS_CFUNC_DEF("chown", 3, js_node_chown),
    JS_CFUNC_DEF("utimes", 3, js_node_utimes),
    JS_CFUNC_DEF("truncate", 2, js_node_truncate),
    JS_CFUNC_DEF("copyFile", 2, js_node_copyfile),
    JS_CFUNC_DEF("access", 2, js_node_access),
    JS_CFUNC_DEF("open", 3, js_node_open),
    JS_CFUNC_DEF("read", 2, js_node_read),
    JS_CFUNC_DEF("write", 2, js_node_write),
    JS_CFUNC_DEF("sendto", 4, js_node_sendto),
    JS_CFUNC_DEF("recvfrom", 2, js_node_recvfrom),
    JS_CFUNC_DEF("disconnect", 1, js_node_disconnect),
    JS_CFUNC_DEF("poll1", 2, js_node_poll1),
    JS_CFUNC_DEF("close", 1, js_node_close),
    JS_CFUNC_DEF("fsync", 1, js_node_fsync),
    JS_CFUNC_DEF("ftruncate", 2, js_node_ftruncate),
    JS_CFUNC_DEF("dup", 1, js_node_dup),
    JS_CFUNC_DEF("pipe", 0, js_node_pipe),
    JS_CFUNC_DEF("isatty", 1, js_node_isatty),
    JS_CFUNC_DEF("setNonblock", 1, js_node_set_nonblock),
    JS_CFUNC_DEF("environ", 0, js_node_environ),
    JS_CFUNC_DEF("uname", 0, js_node_uname),
    JS_CFUNC_DEF("cpuCount", 0, js_node_cpu_count),
    JS_CFUNC_DEF("meminfo", 0, js_node_meminfo),
    JS_CFUNC_DEF("memoryUsage", 0, js_node_memory_usage),
    JS_CFUNC_DEF("rusage", 0, js_node_rusage),
    JS_CFUNC_DEF("utf8Decode", 1, js_node_utf8_decode),
    JS_CFUNC_DEF("utf8Encode", 1, js_node_utf8_encode),

    JS_CFUNC_DEF("socket", 3, js_node_socket),
    JS_CFUNC_DEF("bind", 3, js_node_bind),
    JS_CFUNC_DEF("listen", 2, js_node_listen),
    JS_CFUNC_DEF("accept", 1, js_node_accept),
    JS_CFUNC_DEF("connect", 3, js_node_connect),
    JS_CFUNC_DEF("setsockopt", 4, js_node_setsockopt),
    JS_CFUNC_DEF("getsockopt", 3, js_node_getsockopt),
    JS_CFUNC_DEF("getsockname", 1, js_node_getsockname),
    JS_CFUNC_DEF("getpeername", 1, js_node_getpeername),
    JS_CFUNC_DEF("shardAddress", 2, js_node_shard_address),
    JS_CFUNC_DEF("shardIndex", 1, js_node_shard_index),
    JS_CFUNC_DEF("shutdown", 2, js_node_shutdown),
    JS_CFUNC_DEF("isVirtualFd", 1, js_node_is_virtual_fd),
    JS_CFUNC_DEF("netstackInfo", 0, js_node_netstack_info),
    JS_CFUNC_DEF("netstackPump", 0, js_node_netstack_pump),
    JS_CFUNC_DEF("netstackTick", 0, js_node_netstack_tick),
    JS_CFUNC_DEF("dns", 1, js_node_dns),

    JS_CFUNC_DEF("spawn", 6, js_node_spawn),
    JS_CFUNC_DEF("waitpid", 2, js_node_waitpid),
    JS_CFUNC_DEF("requireEsm", 1, js_node_require_esm),
    JS_CFUNC_DEF("zlibCompress", 5, js_node_zlib_compress),
    JS_CFUNC_DEF("zlibDecompress", 2, js_node_zlib_decompress),
    JS_CFUNC_DEF("zlibInflateStart", 1, js_node_zlib_inflate_start),
    JS_CFUNC_DEF("zlibInflateWrite", 2, js_node_zlib_inflate_write),
    JS_CFUNC_DEF("zlibInflateEnd", 1, js_node_zlib_inflate_end),
    JS_CFUNC_DEF("crc32", 2, js_node_crc32),
    JS_CFUNC_DEF("tlsClientInit", 5, js_node_tls_client_init),
    JS_CFUNC_DEF("tlsServerContext", 3, js_node_tls_server_context),
    JS_CFUNC_DEF("tlsAccept", 2, js_node_tls_accept),
    JS_CFUNC_DEF("tlsHandshake", 1, js_node_tls_handshake),
    JS_CFUNC_DEF("tlsRead", 2, js_node_tls_read),
    JS_CFUNC_DEF("tlsWrite", 2, js_node_tls_write),
    JS_CFUNC_DEF("tlsShutdown", 1, js_node_tls_shutdown),
    JS_CFUNC_DEF("tlsFree", 1, js_node_tls_free),
    JS_CFUNC_DEF("tlsFreeContext", 1, js_node_tls_free_context),
    JS_CFUNC_DEF("tlsPeerCert", 1, js_node_tls_peer_cert),
    JS_CFUNC_DEF("tlsInfo", 1, js_node_tls_info),
    JS_CFUNC_DEF("digest", 2, js_node_digest),
    JS_CFUNC_DEF("cryptoKeyInfo", 2, js_node_crypto_key_info),
    JS_CFUNC_DEF("cryptoExportKey", 3, js_node_crypto_export_key),
    JS_CFUNC_DEF("cryptoGenerateKeyPair", 4, js_node_crypto_generate_key_pair),
    JS_CFUNC_DEF("cryptoSign", 4, js_node_crypto_sign),
    JS_CFUNC_DEF("cryptoVerify", 5, js_node_crypto_verify),
    JS_CFUNC_DEF("cryptoPbkdf2", 5, js_node_crypto_pbkdf2),
    JS_CFUNC_DEF("cryptoHkdf", 5, js_node_crypto_hkdf),
    JS_CFUNC_DEF("cryptoScrypt", 7, js_node_crypto_scrypt),
    JS_CFUNC_DEF("workerExit", 1, js_node_worker_exit),
};

/* ---------------- module loading ---------------- */

static JSValue node_call_global(JSContext *ctx, const char *name,
                                int argc, JSValueConst *argv)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, global, name);
    JS_FreeValue(ctx, global);
    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        JS_ThrowReferenceError(ctx, "qnode bootstrap is not initialized");
        return JS_EXCEPTION;
    }
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    JS_FreeValue(ctx, fn);
    return ret;
}

/* Builtin ES modules: build a C module that re-exports the properties of
   the object returned by __qnode_esm_builtin(name), and CommonJS modules
   imported from ESM, which use the same shape. */
static int node_esm_init(JSContext *ctx, JSModuleDef *m)
{
    JSValue obj = JS_GetModulePrivateValue(ctx, m);
    JSPropertyEnum *tab = NULL;
    uint32_t len = 0;
    int ret = -1;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, obj,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY))
        return -1;
    for (uint32_t i = 0; i < len; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        if (!name)
            goto done;
        JSValue v = JS_GetProperty(ctx, obj, tab[i].atom);
        if (JS_IsException(v)) {
            JS_FreeCString(ctx, name);
            goto done;
        }
        if (JS_SetModuleExport(ctx, m, name, v))
            JS_FreeValue(ctx, v);
        JS_FreeCString(ctx, name);
    }
    if (JS_SetModuleExport(ctx, m, "default", JS_DupValue(ctx, obj)))
        goto done;
    ret = 0;
done:
    JS_FreePropertyEnum(ctx, tab, len);
    return ret;
}

/* Wrap the object returned by a bootstrap global in a synthetic ES module. */
static JSModuleDef *node_wrap_module(JSContext *ctx, const char *name,
                                     const char *global, int require_object)
{
    JSValue arg = JS_NewString(ctx, name);
    JSValue obj = node_call_global(ctx, global, 1, &arg);
    JS_FreeValue(ctx, arg);
    if (JS_IsException(obj))
        return NULL;
    if (require_object && !JS_IsObject(obj)) {
        JS_FreeValue(ctx, obj);
        JS_ThrowTypeError(ctx, "CommonJS module '%s' did not export an object",
                          name);
        return NULL;
    }

    JSModuleDef *m = JS_NewCModule(ctx, name, node_esm_init);
    if (!m) {
        JS_FreeValue(ctx, obj);
        return NULL;
    }
    JSPropertyEnum *tab = NULL;
    uint32_t len = 0;
    if (!JS_GetOwnPropertyNames(ctx, &tab, &len, obj,
                                JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
        for (uint32_t i = 0; i < len; i++) {
            const char *n = JS_AtomToCString(ctx, tab[i].atom);
            if (n) {
                JS_AddModuleExport(ctx, m, n);
                JS_FreeCString(ctx, n);
            }
        }
        JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_AddModuleExport(ctx, m, "default");
    JS_SetModulePrivateValue(ctx, m, obj);
    return m;
}

static JSModuleDef *node_builtin_module(JSContext *ctx, const char *name)
{
    return node_wrap_module(ctx, name, "__qnode_esm_builtin", 0);
}

static JSModuleDef *node_cjs_module(JSContext *ctx, const char *path)
{
    return node_wrap_module(ctx, path, "__qnode_import_cjs", 1);
}

static char *node_normalize(JSContext *ctx, const char *base,
                            const char *spec, void *opaque)
{
    (void)opaque;
    if (!strncmp(spec, "qjs:", 4))
        return js_strdup(ctx, spec);

    JSValue args[3];
    args[0] = JS_NewString(ctx, spec);
    args[1] = JS_NewString(ctx, base ? base : "");
    args[2] = JS_NewString(ctx, "import");
    JSValue ret = node_call_global(ctx, "__qnode_resolve", 3, args);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[2]);
    if (JS_IsException(ret))
        return NULL;
    if (!JS_IsString(ret)) {
        JS_FreeValue(ctx, ret);
        return NULL;
    }
    const char *s = JS_ToCString(ctx, ret);
    char *out = s ? js_strdup(ctx, s) : NULL;
    if (s)
        JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, ret);
    return out;
}

static JSModuleDef *node_load(JSContext *ctx, const char *module_name,
                              void *opaque, JSValueConst attributes)
{
    (void)opaque;
    if (!strncmp(module_name, "qnode:", 6))
        return node_builtin_module(ctx, module_name);

    if (js__has_suffix(module_name, ".so")) {
        JS_ThrowReferenceError(ctx,
            "native addons are not supported yet: '%s'", module_name);
        return NULL;
    }

    JSValue arg = JS_NewString(ctx, module_name);
    JSValue kindv = node_call_global(ctx, "__qnode_module_kind", 1, &arg);
    JS_FreeValue(ctx, arg);
    if (JS_IsException(kindv))
        return NULL;
    const char *kind = JS_ToCString(ctx, kindv);
    JSModuleDef *m = NULL;
    if (kind) {
        if (!strcmp(kind, "cjs")) {
            m = node_cjs_module(ctx, module_name);
        } else if (!strcmp(kind, "json")) {
            /* JSON is not an ES module in quickjs-ng; expose it through a
               synthetic module like CommonJS. */
            m = node_cjs_module(ctx, module_name);
        } else {
            m = js_module_load(ctx, module_name, opaque, attributes,
                               js_load_file);
        }
        JS_FreeCString(ctx, kind);
    }
    JS_FreeValue(ctx, kindv);
    return m;
}

/* ---------------- init / CLI ---------------- */

static JSValue js_node_set_argv(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue arr = JS_NewArray(ctx);
    for (int i = 0; i < argc; i++)
        JS_SetPropertyUint32(ctx, arr, i, JS_DupValue(ctx, argv[i]));
    JS_SetPropertyStr(ctx, global, "__qnode_argv", arr);
    /* The bootstrap is evaluated before the CLI arguments are known, so its
       `process.argv` initially points at an empty array. Publish the real
       argument vector on the process object once it is available. */
    JSValue proc = JS_GetPropertyStr(ctx, global, "process");
    if (JS_IsObject(proc))
        JS_SetPropertyStr(ctx, proc, "argv", JS_DupValue(ctx, arr));
    JS_FreeValue(ctx, proc);
    JS_FreeValue(ctx, global);
    return JS_UNDEFINED;
}

/* The embedded byte array has no trailing NUL, and the lexer may read one
   byte past the end of its input. Keep a NUL-terminated copy around. */
static const char *node_bootstrap_source(void)
{
    static char *src;
    if (!src) {
        src = malloc((size_t)node_bootstrap_js_len + 1);
        if (!src)
            return NULL;
        memcpy(src, node_bootstrap_js, node_bootstrap_js_len);
        src[node_bootstrap_js_len] = '\0';
    }
    return src;
}

static JSValue js_node_init_js(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *src = node_bootstrap_source();
    if (!src)
        return JS_ThrowOutOfMemory(ctx);
    JSValue ret = JS_Eval(ctx, src, node_bootstrap_js_len, "<qnode:bootstrap>",
                          JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(ret))
        return ret;
    if (js_module_set_import_meta(ctx, ret, false, false) < 0) {
        JS_FreeValue(ctx, ret);
        return JS_EXCEPTION;
    }
    if (JS_ResolveModule(ctx, ret) < 0) {
        JS_FreeValue(ctx, ret);
        return JS_EXCEPTION;
    }
    /* JS_EvalFunction takes ownership of the compiled module object. */
    return JS_EvalFunction(ctx, ret);
}

int js_node_init(JSContext *ctx, JSRuntime *rt)
{
    /* qjs: builtin modules used by the bootstrap */
    js_init_module_std(ctx, "qjs:std");
    js_init_module_os(ctx, "qjs:os");

    if (js_wasm_init(ctx) < 0)
        return -1;

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue native = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, native, js_node_funcs,
                               countof(js_node_funcs));
    JS_SetPropertyStr(ctx, global, "__qnode_native", native);

    /* constants */
    JSValue c = JS_NewObject(ctx);
#define NC(name, value) JS_SetPropertyStr(ctx, c, name, JS_NewInt32(ctx, value))
    NC("AF_INET", AF_INET);
    NC("AF_INET6", AF_INET6);
    NC("AF_UNSPEC", AF_UNSPEC);
    NC("SOCK_STREAM", SOCK_STREAM);
    NC("SOCK_DGRAM", SOCK_DGRAM);
    NC("SOL_SOCKET", SOL_SOCKET);
    NC("SO_REUSEADDR", SO_REUSEADDR);
    NC("SO_REUSEPORT", SO_REUSEPORT);
    NC("SO_KEEPALIVE", SO_KEEPALIVE);
    NC("SO_ERROR", SO_ERROR);
    NC("SO_BROADCAST", SO_BROADCAST);
    NC("TCP_NODELAY", TCP_NODELAY);
    NC("IPPROTO_TCP", IPPROTO_TCP);
    NC("IPPROTO_IPV6", IPPROTO_IPV6);
#ifdef IPV6_V6ONLY
    NC("IPV6_V6ONLY", IPV6_V6ONLY);
#endif
#ifdef IPV6_FREEBIND
    NC("IPV6_FREEBIND", IPV6_FREEBIND);
#endif
#ifdef IP_FREEBIND
    NC("IP_FREEBIND", IP_FREEBIND);
#endif
    NC("SHUT_RD", SHUT_RD);
    NC("SHUT_WR", SHUT_WR);
    NC("SHUT_RDWR", SHUT_RDWR);
    NC("EINPROGRESS", EINPROGRESS);
    NC("EAGAIN", EAGAIN);
    NC("EWOULDBLOCK", EWOULDBLOCK);
    NC("EINTR", EINTR);
    NC("ENOENT", ENOENT);
    NC("ENOTDIR", ENOTDIR);
    NC("EISDIR", EISDIR);
    NC("EEXIST", EEXIST);
    NC("ENOTEMPTY", ENOTEMPTY);
    NC("EACCES", EACCES);
    NC("EPERM", EPERM);
    NC("EPIPE", EPIPE);
    NC("ECONNRESET", ECONNRESET);
    NC("ECONNREFUSED", ECONNREFUSED);
    NC("EADDRINUSE", EADDRINUSE);
    NC("EADDRNOTAVAIL", EADDRNOTAVAIL);
    NC("EDESTADDRREQ", EDESTADDRREQ);
    NC("EMSGSIZE", EMSGSIZE);
    NC("ENOTCONN", ENOTCONN);
    NC("EOPNOTSUPP", EOPNOTSUPP);
    NC("EINVAL", EINVAL);
    NC("EAFNOSUPPORT", EAFNOSUPPORT);
    NC("EPROTONOSUPPORT", EPROTONOSUPPORT);
    NC("WNOHANG", WNOHANG);
    NC("WIFEXITED", 0); /* helpers in JS use the macros below */
    NC("O_RDONLY", O_RDONLY);
    NC("O_WRONLY", O_WRONLY);
    NC("O_RDWR", O_RDWR);
    NC("O_CREAT", O_CREAT);
    NC("O_TRUNC", O_TRUNC);
    NC("O_APPEND", O_APPEND);
    NC("O_EXCL", O_EXCL);
    NC("F_OK", F_OK);
    NC("R_OK", R_OK);
    NC("W_OK", W_OK);
    NC("X_OK", X_OK);
    NC("SIGTERM", SIGTERM);
    NC("SIGKILL", SIGKILL);
    NC("SIGINT", SIGINT);
    NC("SIGCHLD", SIGCHLD);
    NC("TLS_WANT_READ", 1001);
    NC("TLS_WANT_WRITE", 1002);
#undef NC
    JS_SetPropertyStr(ctx, global, "__qnode_consts", c);

    JSValue set_argv = JS_NewCFunction(ctx, js_node_set_argv,
                                       "__qnode_set_argv", 1);
    JS_SetPropertyStr(ctx, global, "__qnode_set_argv", set_argv);

    JS_FreeValue(ctx, global);

    JS_SetModuleLoaderFunc2(rt, node_normalize, node_load,
                            js_module_check_attributes, NULL);

    return 0;
}

int js_node_start(JSContext *ctx)
{
    /* Run the bootstrap module. It installs process/require/fs/... and
       returns a promise. */
    JSValue ret = js_node_init_js(ctx, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(ret))
        return -1;
    ret = js_std_await(ctx, ret);
    if (JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        return -1;
    }
    JS_FreeValue(ctx, ret);
    return 0;
}

static void node_worker_rejection_tracker(JSContext *ctx,
                                          JSValueConst promise,
                                          JSValueConst reason,
                                          bool is_handled, void *opaque)
{
    JSValue global, fn, args[3], r;
    (void)opaque;
    global = JS_GetGlobalObject(ctx);
    fn = JS_GetPropertyStr(ctx, global, "__qnode_track_rejection");
    if (JS_IsFunction(ctx, fn)) {
        args[0] = JS_DupValue(ctx, promise);
        args[1] = JS_DupValue(ctx, reason);
        args[2] = JS_NewBool(ctx, is_handled);
        r = JS_Call(ctx, fn, JS_UNDEFINED, 3, args);
        if (JS_IsException(r))
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        JS_FreeValue(ctx, args[2]);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
}

/* Worker exit hook: release thread-local TLS state before the runtime is
   torn down. */
static void node_worker_exit_func(JSContext *ctx, int exit_code, void *opaque)
{
    (void)ctx;
    (void)exit_code;
    (void)opaque;
    node_tls_thread_cleanup();
}

/* Worker start hook: install the qnode runtime pieces, publish the startup
   value and evaluate the regular bootstrap. The bootstrap detects worker
   mode and imports the user script itself. */
static void node_worker_start_func(JSContext *ctx, const char *basename,
                                   const char *filename, void *opaque)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSValue startup, global;
    (void)basename;
    (void)opaque;

    JS_SetMaxStackSize(rt, 2 << 20);
    JS_SetHostPromiseRejectionTracker(rt, node_worker_rejection_tracker, NULL);

    if (js_node_init(ctx, rt) < 0)
        return;

    startup = js_std_worker_startup(ctx);
    if (JS_IsException(startup)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        startup = JS_UNDEFINED;
    }
    global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__qnode_worker_startup", startup);
    JS_SetPropertyStr(ctx, global, "__qnode_worker_filename",
                      JS_NewString(ctx, filename ? filename : ""));
    JS_SetPropertyStr(ctx, global, "__qnode_worker_mode", JS_TRUE);
    JS_FreeValue(ctx, global);

    js_node_start(ctx);
}

void js_node_install_worker_hooks(void)
{
    js_std_set_worker_start_func(node_worker_start_func, NULL);
    js_std_set_worker_exit_func(node_worker_exit_func, NULL);
}

JSValue js_node_run_main(JSContext *ctx, const char *path)
{
    JSValue arg = JS_NewString(ctx, path);
    JSValue kindv = node_call_global(ctx, "__qnode_module_kind", 1, &arg);
    if (JS_IsException(kindv)) {
        JS_FreeValue(ctx, arg);
        return JS_EXCEPTION;
    }
    const char *kind = JS_ToCString(ctx, kindv);
    JSValue ret = JS_EXCEPTION;
    if (kind) {
        if (!strcmp(kind, "cjs")) {
            ret = node_call_global(ctx, "__qnode_run_cjs", 1, &arg);
        } else {
            uint8_t *buf;
            size_t len;
            buf = js_load_file(ctx, &len, path);
            if (!buf) {
                JS_ThrowReferenceError(ctx, "cannot load '%s'", path);
            } else {
                JSValue obj = JS_Eval(ctx, (const char *)buf, len, path,
                                      JS_EVAL_TYPE_MODULE |
                                          JS_EVAL_FLAG_COMPILE_ONLY);
                js_free(ctx, buf);
                if (!JS_IsException(obj)) {
                    if (js_module_set_import_meta(ctx, obj, true, true) < 0) {
                        JS_FreeValue(ctx, obj);
                    } else if (JS_ResolveModule(ctx, obj) < 0) {
                        JS_FreeValue(ctx, obj);
                    } else {
                        /* takes ownership of obj */
                        ret = JS_EvalFunction(ctx, obj);
                    }
                }
            }
        }
        JS_FreeCString(ctx, kind);
    }
    JS_FreeValue(ctx, kindv);
    JS_FreeValue(ctx, arg);
    return ret;
}
