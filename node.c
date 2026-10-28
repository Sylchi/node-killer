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
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/utsname.h>
#include <sys/uio.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <pwd.h>

#ifdef QNODE_HAVE_ZLIB
#include <zlib.h>
#endif

#ifdef QNODE_HAVE_OPENSSL
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include <openssl/pem.h>
#include <openssl/bio.h>
#endif

#include "cutils.h"
#include "quickjs.h"
#include "quickjs-libc.h"
#include "node.h"

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
    return JS_NewInt32(ctx, getuid());
}

static JSValue js_node_getgid(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, getgid());
}

static JSValue js_node_umask(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        int32_t mask;
        if (JS_ToInt32(ctx, &mask, argv[0]))
            return JS_EXCEPTION;
        return JS_NewInt32(ctx, umask(mask));
    }
    int old = umask(0);
    umask(old);
    return JS_NewInt32(ctx, old);
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
    char buf[256];
    if (gethostname(buf, sizeof(buf)))
        buf[0] = '\0';
    return JS_NewString(ctx, buf);
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

static JSValue js_node_random_bytes(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    int32_t len;
    if (JS_ToInt32(ctx, &len, argv[0]) || len < 0)
        return JS_ThrowRangeError(ctx, "invalid length");
    uint8_t *buf = js_malloc(ctx, len ? len : 1);
    if (!buf)
        return JS_EXCEPTION;
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
    do {
        n = position >= 0 ? pread(fd, buf, len, position) : read(fd, buf, len);
    } while (n < 0 && errno == EINTR);
    if (n < 0) {
        int err = errno;
        js_free(ctx, buf);
        return node_err(ctx, JS_NULL, err);
    }
    JSValue val = JS_NewUint8ArrayCopy(ctx, buf, n);
    js_free(ctx, buf);
    return node_ok(ctx, val);
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
    do {
        n = position >= 0 ? pwrite(fd, b.data, b.len, position)
                          : write(fd, b.data, b.len);
    } while (n < 0 && errno == EINTR);
    int err = n < 0 ? errno : 0;
    node_free_bytes(ctx, &b);
    if (n < 0)
        return node_err(ctx, JS_NULL, err);
    return node_ok(ctx, JS_NewInt64(ctx, n));
}

static JSValue js_node_close(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
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
}

static JSValue js_node_cpu_count(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return JS_NewInt32(ctx, n > 0 ? n : 1);
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
    int fl = fcntl(fd, F_GETFL);
    if (fl < 0)
        return JS_NewInt32(ctx, errno);
    return JS_NewInt32(ctx, fcntl(fd, F_SETFL, fl | O_NONBLOCK) ? errno : 0);
}

/* ---------------- sockets ---------------- */

static JSValue js_node_socket(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t domain = AF_INET, type = SOCK_STREAM, proto = 0;
    if (argc > 0 && !JS_IsUndefined(argv[0]))
        if (JS_ToInt32(ctx, &domain, argv[0])) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]))
        if (JS_ToInt32(ctx, &type, argv[1])) return JS_EXCEPTION;
    if (argc > 2 && !JS_IsUndefined(argv[2]))
        if (JS_ToInt32(ctx, &proto, argv[2])) return JS_EXCEPTION;
    int fd = socket(domain, type | SOCK_CLOEXEC, proto);
    if (fd < 0)
        return node_err(ctx, JS_NULL, errno);
    int fl = fcntl(fd, F_GETFL);
    if (fl >= 0)
        fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    return node_ok(ctx, JS_NewInt32(ctx, fd));
}

static int node_sockaddr(JSContext *ctx, const char *host, int port,
                         struct sockaddr_storage *ss, socklen_t *plen,
                         bool passive)
{
    struct addrinfo hints, *res = NULL;
    char portbuf[16];
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = passive ? AI_PASSIVE : 0;
    snprintf(portbuf, sizeof(portbuf), "%d", port);
    int r = getaddrinfo((host && host[0]) ? host : NULL, portbuf, &hints, &res);
    if (r != 0)
        return EADDRNOTAVAIL;
    memcpy(ss, res->ai_addr, res->ai_addrlen);
    *plen = res->ai_addrlen;
    freeaddrinfo(res);
    (void)ctx;
    return 0;
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
    if (!err && bind(fd, (struct sockaddr *)&ss, len))
        err = errno;
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
    if (!err && connect(fd, (struct sockaddr *)&ss, len))
        err = errno;
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

static JSValue js_node_getsockname(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
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
    return JS_NewInt32(ctx, shutdown(fd, how) ? errno : 0);
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
}

static JSValue js_node_waitpid(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
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
}

#ifdef QNODE_HAVE_ZLIB

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

#endif /* QNODE_HAVE_ZLIB */

#ifdef QNODE_HAVE_OPENSSL

#define NODE_TLS_MAX_CTX 256
#define NODE_TLS_MAX_CONN 1024
#define NODE_TLS_WANT_READ 1001
#define NODE_TLS_WANT_WRITE 1002

typedef struct {
    SSL_CTX *ctx;
    int used;
} NodeTLSContext;

typedef struct {
    SSL *ssl;
    SSL_CTX *own_ctx; /* client connections own their context */
    int used;
} NodeTLSConn;

static NodeTLSContext node_tls_contexts[NODE_TLS_MAX_CTX];
static NodeTLSConn node_tls_conns[NODE_TLS_MAX_CONN];
static int node_tls_initialized;

static void node_tls_init(void)
{
    if (!node_tls_initialized) {
        OPENSSL_init_ssl(0, NULL);
        node_tls_initialized = 1;
    }
}

static void node_tls_raise(JSContext *ctx, SSL *ssl, const char *what)
{
    unsigned long e = ERR_get_error();
    char errbuf[256] = "";
    long vr = ssl ? SSL_get_verify_result(ssl) : X509_V_OK;

    if (e)
        ERR_error_string_n(e, errbuf, sizeof(errbuf));
    ERR_clear_error();
    if (vr != X509_V_OK) {
        JS_ThrowPlainError(ctx, "%s: %s", what,
                              X509_verify_cert_error_string(vr));
    } else if (errbuf[0]) {
        JS_ThrowPlainError(ctx, "%s: %s", what, errbuf);
    } else {
        JS_ThrowPlainError(ctx, "%s failed", what);
    }
}

static int node_tls_add_ca(SSL_CTX *ctx, const char *pem)
{
    BIO *bio = BIO_new_mem_buf(pem, -1);
    X509_STORE *store = SSL_CTX_get_cert_store(ctx);
    int added = 0;
    X509 *x;

    if (!bio)
        return 0;
    for (;;) {
        x = PEM_read_bio_X509(bio, NULL, NULL, NULL);
        if (!x)
            break;
        if (X509_STORE_add_cert(store, x) == 1)
            added++;
        X509_free(x);
    }
    ERR_clear_error();
    BIO_free(bio);
    return added;
}

/* tlsClientInit(fd, hostname, verify, caPem|null, alpnWire|null) */
static JSValue js_node_tls_client_init(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    int32_t fd;
    SSL_CTX *c;
    SSL *ssl;
    int verify = 1;
    const char *host = NULL;
    const char *ca = NULL;
    NodeBytes alpn = { 0 };

    node_tls_init();
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

    if (verify)
        c = SSL_CTX_new(TLS_client_method());
    else
        c = SSL_CTX_new(TLS_client_method());
    if (!c)
        goto oom;

    SSL_CTX_set_min_proto_version(c, TLS1_2_VERSION);
    SSL_CTX_set_verify(c, verify ? SSL_VERIFY_PEER : SSL_VERIFY_NONE, NULL);
    if (verify) {
        if (ca && ca[0])
            node_tls_add_ca(c, ca);
        else
            SSL_CTX_set_default_verify_paths(c);
    }

    ssl = SSL_new(c);
    if (!ssl) {
        SSL_CTX_free(c);
        goto oom;
    }
    SSL_set_fd(ssl, fd);
    SSL_set_connect_state(ssl);
    if (host && host[0]) {
        SSL_set_tlsext_host_name(ssl, host);
        if (verify)
            SSL_set1_host(ssl, host);
    }
    if (alpn.len)
        SSL_set_alpn_protos(ssl, alpn.data, (unsigned int)alpn.len);

    node_free_bytes(ctx, &alpn);
    if (host) JS_FreeCString(ctx, host);
    if (ca) JS_FreeCString(ctx, ca);

    for (int i = 0; i < NODE_TLS_MAX_CONN; i++) {
        if (!node_tls_conns[i].used) {
            node_tls_conns[i].ssl = ssl;
            node_tls_conns[i].own_ctx = c;
            node_tls_conns[i].used = 1;
            return node_ok(ctx, JS_NewInt32(ctx, i));
        }
    }
    SSL_free(ssl);
    SSL_CTX_free(c);
    return node_err(ctx, JS_NULL, ENOMEM);

oom:
    ERR_clear_error();
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
    SSL_CTX *c;
    BIO *bio;
    X509 *x;
    EVP_PKEY *pkey;
    int id = -1;

    node_tls_init();
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

    c = SSL_CTX_new(TLS_server_method());
    if (!c)
        goto fail;

    SSL_CTX_set_min_proto_version(c, TLS1_2_VERSION);

    bio = BIO_new_mem_buf(cert, -1);
    if (!bio)
        goto fail;
    x = PEM_read_bio_X509(bio, NULL, NULL, NULL);
    if (!x) {
        BIO_free(bio);
        goto fail;
    }
    if (SSL_CTX_use_certificate(c, x) != 1) {
        X509_free(x);
        BIO_free(bio);
        goto fail;
    }
    X509_free(x);
    ERR_clear_error();
    while ((x = PEM_read_bio_X509(bio, NULL, NULL, NULL)) != NULL)
        SSL_CTX_add_extra_chain_cert(c, x);
    ERR_clear_error();
    BIO_free(bio);

    bio = BIO_new_mem_buf(key, -1);
    if (!bio)
        goto fail;
    pkey = PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (!pkey)
        goto fail;
    if (SSL_CTX_use_PrivateKey(c, pkey) != 1) {
        EVP_PKEY_free(pkey);
        goto fail;
    }
    EVP_PKEY_free(pkey);
    if (SSL_CTX_check_private_key(c) != 1)
        goto fail;
    if (ca && ca[0])
        node_tls_add_ca(c, ca);

    for (int i = 0; i < NODE_TLS_MAX_CTX; i++) {
        if (!node_tls_contexts[i].used) {
            node_tls_contexts[i].ctx = c;
            node_tls_contexts[i].used = 1;
            id = i;
            break;
        }
    }
    JS_FreeCString(ctx, cert);
    JS_FreeCString(ctx, key);
    if (ca) JS_FreeCString(ctx, ca);
    if (id < 0) {
        SSL_CTX_free(c);
        return node_err(ctx, JS_NULL, ENOMEM);
    }
    return node_ok(ctx, JS_NewInt32(ctx, id));

fail:
    if (c) SSL_CTX_free(c);
    node_tls_raise(ctx, NULL, "cannot create TLS context");
    JS_FreeCString(ctx, cert);
    JS_FreeCString(ctx, key);
    if (ca) JS_FreeCString(ctx, ca);
    return JS_EXCEPTION;
}

/* tlsAccept(ctxId, fd) -> conn id */
static JSValue js_node_tls_accept(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int32_t ctxid, fd;
    SSL *ssl;

    node_tls_init();
    if (JS_ToInt32(ctx, &ctxid, argv[0]) || JS_ToInt32(ctx, &fd, argv[1]))
        return JS_EXCEPTION;
    if (ctxid < 0 || ctxid >= NODE_TLS_MAX_CTX ||
        !node_tls_contexts[ctxid].used ||
        !node_tls_contexts[ctxid].ctx)
        return JS_ThrowRangeError(ctx, "invalid TLS context");

    ssl = SSL_new(node_tls_contexts[ctxid].ctx);
    if (!ssl)
        return JS_ThrowOutOfMemory(ctx);
    SSL_set_fd(ssl, fd);
    SSL_set_accept_state(ssl);

    for (int i = 0; i < NODE_TLS_MAX_CONN; i++) {
        if (!node_tls_conns[i].used) {
            node_tls_conns[i].ssl = ssl;
            node_tls_conns[i].own_ctx = NULL;
            node_tls_conns[i].used = 1;
            return node_ok(ctx, JS_NewInt32(ctx, i));
        }
    }
    SSL_free(ssl);
    return node_err(ctx, JS_NULL, ENOMEM);
}

static SSL *node_tls_ssl(JSContext *ctx, JSValueConst v)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, v)) {
        return NULL;
    }
    if (id < 0 || id >= NODE_TLS_MAX_CONN || !node_tls_conns[id].used) {
        JS_ThrowRangeError(ctx, "invalid TLS handle");
        return NULL;
    }
    return node_tls_conns[id].ssl;
}

/* tlsHandshake(id) -> 0 done, 1 want read, 2 want write */
static JSValue js_node_tls_handshake(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    SSL *ssl = node_tls_ssl(ctx, argv[0]);
    int r, err;

    if (!ssl)
        return JS_EXCEPTION;
    ERR_clear_error();
    r = SSL_do_handshake(ssl);
    if (r == 1)
        return node_ok(ctx, JS_NewInt32(ctx, 0));
    /* A failed peer verification is terminal: OpenSSL may keep reporting
       WANT_READ/WANT_WRITE after sending the alert, so surface it here. */
    if (SSL_get_verify_result(ssl) != X509_V_OK) {
        node_tls_raise(ctx, ssl, "TLS handshake failed");
        return JS_EXCEPTION;
    }
    err = SSL_get_error(ssl, r);
    if (err == SSL_ERROR_WANT_READ)
        return node_ok(ctx, JS_NewInt32(ctx, 1));
    if (err == SSL_ERROR_WANT_WRITE)
        return node_ok(ctx, JS_NewInt32(ctx, 2));
    node_tls_raise(ctx, ssl, "TLS handshake failed");
    return JS_EXCEPTION;
}

/* tlsRead(id, max) -> bytes; empty means EOF */
static JSValue js_node_tls_read(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    SSL *ssl = node_tls_ssl(ctx, argv[0]);
    int32_t len = 16384;
    uint8_t *buf;
    int r, err;

    if (!ssl)
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) &&
        JS_ToInt32(ctx, &len, argv[1]))
        return JS_EXCEPTION;
    if (len <= 0 || len > 16 * 1024 * 1024)
        return JS_ThrowRangeError(ctx, "invalid read length");

    buf = js_malloc(ctx, len);
    if (!buf)
        return JS_EXCEPTION;
    ERR_clear_error();
    r = SSL_read(ssl, buf, len);
    if (r > 0) {
        JSValue v = JS_NewUint8ArrayCopy(ctx, buf, r);
        js_free(ctx, buf);
        return node_ok(ctx, v);
    }
    js_free(ctx, buf);
    err = SSL_get_error(ssl, r);
    if (err == SSL_ERROR_WANT_READ)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_READ);
    if (err == SSL_ERROR_WANT_WRITE)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_WRITE);
    if (err == SSL_ERROR_ZERO_RETURN)
        return node_ok(ctx, JS_NewUint8ArrayCopy(ctx, (const uint8_t *)"", 0));
    if (err == SSL_ERROR_SYSCALL && (errno == EAGAIN || errno == EINTR))
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_READ);
    node_tls_raise(ctx, ssl, "TLS read failed");
    return JS_EXCEPTION;
}

/* tlsWrite(id, data) -> bytes written */
static JSValue js_node_tls_write(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    SSL *ssl = node_tls_ssl(ctx, argv[0]);
    NodeBytes b;
    int r, err;

    if (!ssl)
        return JS_EXCEPTION;
    if (node_get_bytes(ctx, argv[1], &b))
        return JS_EXCEPTION;
    ERR_clear_error();
    r = SSL_write(ssl, b.data, (int)b.len);
    node_free_bytes(ctx, &b);
    if (r > 0)
        return node_ok(ctx, JS_NewInt32(ctx, r));
    err = SSL_get_error(ssl, r);
    if (err == SSL_ERROR_WANT_READ)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_READ);
    if (err == SSL_ERROR_WANT_WRITE)
        return node_err(ctx, JS_NULL, NODE_TLS_WANT_WRITE);
    node_tls_raise(ctx, ssl, "TLS write failed");
    return JS_EXCEPTION;
}

static JSValue js_node_tls_shutdown(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    SSL *ssl = node_tls_ssl(ctx, argv[0]);
    if (!ssl)
        return JS_EXCEPTION;
    ERR_clear_error();
    SSL_shutdown(ssl);
    ERR_clear_error();
    return JS_UNDEFINED;
}

static JSValue js_node_tls_free(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    if (id >= 0 && id < NODE_TLS_MAX_CONN && node_tls_conns[id].used) {
        SSL_free(node_tls_conns[id].ssl);
        if (node_tls_conns[id].own_ctx)
            SSL_CTX_free(node_tls_conns[id].own_ctx);
        node_tls_conns[id].used = 0;
        node_tls_conns[id].ssl = NULL;
        node_tls_conns[id].own_ctx = NULL;
    }
    return JS_UNDEFINED;
}

static JSValue js_node_tls_free_context(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    if (id >= 0 && id < NODE_TLS_MAX_CTX && node_tls_contexts[id].used) {
        SSL_CTX_free(node_tls_contexts[id].ctx);
        node_tls_contexts[id].used = 0;
        node_tls_contexts[id].ctx = NULL;
    }
    return JS_UNDEFINED;
}

static JSValue node_tls_name_object(JSContext *ctx, X509_NAME *name)
{
    JSValue obj = JS_NewObject(ctx);
    int n = X509_NAME_entry_count(name);
    for (int i = 0; i < n; i++) {
        X509_NAME_ENTRY *e = X509_NAME_get_entry(name, i);
        ASN1_OBJECT *o = X509_NAME_ENTRY_get_object(e);
        ASN1_STRING *d = X509_NAME_ENTRY_get_data(e);
        const char *key = OBJ_nid2sn(OBJ_obj2nid(o));
        unsigned char *utf8 = NULL;
        int len = ASN1_STRING_to_UTF8(&utf8, d);
        if (len >= 0 && key) {
            JS_SetPropertyStr(ctx, obj, key,
                              JS_NewStringLen(ctx, (const char *)utf8, len));
        }
        OPENSSL_free(utf8);
    }
    return obj;
}

static JSValue node_tls_time_string(JSContext *ctx, const ASN1_TIME *t)
{
    BIO *bio = BIO_new(BIO_s_mem());
    BUF_MEM *mem = NULL;
    JSValue v = JS_NULL;
    if (!bio)
        return JS_NULL;
    ASN1_TIME_print(bio, t);
    BIO_get_mem_ptr(bio, &mem);
    if (mem)
        v = JS_NewStringLen(ctx, mem->data, mem->length);
    BIO_free(bio);
    return v;
}

static JSValue js_node_tls_peer_cert(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    SSL *ssl = node_tls_ssl(ctx, argv[0]);
    X509 *cert;
    JSValue obj;
    unsigned char *der = NULL, *pem = NULL;
    int derlen, pemlen;
    BIO *bio;
    BUF_MEM *mem;
    char hex[3];

    if (!ssl)
        return JS_EXCEPTION;
    cert = SSL_get1_peer_certificate(ssl);
    if (!cert)
        return JS_NULL;

    obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "subject",
                      node_tls_name_object(ctx, X509_get_subject_name(cert)));
    JS_SetPropertyStr(ctx, obj, "issuer",
                      node_tls_name_object(ctx, X509_get_issuer_name(cert)));
    JS_SetPropertyStr(ctx, obj, "valid_from",
                      node_tls_time_string(ctx, X509_get0_notBefore(cert)));
    JS_SetPropertyStr(ctx, obj, "valid_to",
                      node_tls_time_string(ctx, X509_get0_notAfter(cert)));

    derlen = i2d_X509(cert, &der);
    if (derlen > 0) {
        JSValue raw = JS_NewArrayBufferCopy(ctx, der, derlen);
        JS_SetPropertyStr(ctx, obj, "raw", raw);
        OPENSSL_free(der);
    }

    bio = BIO_new(BIO_s_mem());
    if (bio && PEM_write_bio_X509(bio, cert) == 1) {
        BIO_get_mem_ptr(bio, &mem);
        pem = (unsigned char *)mem->data;
        pemlen = (int)mem->length;
        JS_SetPropertyStr(ctx, obj, "pem",
                          JS_NewStringLen(ctx, (const char *)pem, pemlen));
    }
    if (bio)
        BIO_free(bio);

    /* SHA-256 fingerprint of the DER encoding */
    {
        unsigned char md[EVP_MAX_MD_SIZE];
        unsigned int mdlen = 0;
        char fp[EVP_MAX_MD_SIZE * 3];
        size_t off = 0;
        if (X509_digest(cert, EVP_sha256(), md, &mdlen) == 1) {
            for (unsigned int i = 0; i < mdlen; i++) {
                snprintf(hex, sizeof(hex), "%02X", md[i]);
                if (i)
                    fp[off++] = ':';
                fp[off++] = hex[0];
                fp[off++] = hex[1];
            }
            fp[off] = '\0';
            JS_SetPropertyStr(ctx, obj, "fingerprint256",
                              JS_NewString(ctx, fp));
        }
    }

    {
        BIGNUM *bn = ASN1_INTEGER_to_BN(X509_get_serialNumber(cert), NULL);
        if (bn) {
            char *s = BN_bn2hex(bn);
            if (s) {
                JS_SetPropertyStr(ctx, obj, "serialNumber",
                                  JS_NewString(ctx, s));
                OPENSSL_free(s);
            }
            BN_free(bn);
        }
    }

    X509_free(cert);
    return obj;
}

static JSValue js_node_tls_info(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    SSL *ssl = node_tls_ssl(ctx, argv[0]);
    JSValue obj;
    const unsigned char *alpn = NULL;
    unsigned int alpnlen = 0;

    if (!ssl)
        return JS_EXCEPTION;
    obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "protocol",
                      JS_NewString(ctx, SSL_get_version(ssl)));
    JS_SetPropertyStr(ctx, obj, "cipher",
                      JS_NewString(ctx, SSL_get_cipher_name(ssl)));
    SSL_get0_alpn_selected(ssl, &alpn, &alpnlen);
    if (alpn && alpnlen)
        JS_SetPropertyStr(ctx, obj, "alpnProtocol",
                          JS_NewStringLen(ctx, (const char *)alpn, alpnlen));
    else
        JS_SetPropertyStr(ctx, obj, "alpnProtocol", JS_FALSE);
    return obj;
}

#endif /* QNODE_HAVE_OPENSSL */

/* ---------------- native object ---------------- */

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

    JS_CFUNC_DEF("socket", 3, js_node_socket),
    JS_CFUNC_DEF("bind", 3, js_node_bind),
    JS_CFUNC_DEF("listen", 2, js_node_listen),
    JS_CFUNC_DEF("accept", 1, js_node_accept),
    JS_CFUNC_DEF("connect", 3, js_node_connect),
    JS_CFUNC_DEF("setsockopt", 4, js_node_setsockopt),
    JS_CFUNC_DEF("getsockopt", 3, js_node_getsockopt),
    JS_CFUNC_DEF("getsockname", 1, js_node_getsockname),
    JS_CFUNC_DEF("getpeername", 1, js_node_getpeername),
    JS_CFUNC_DEF("shutdown", 2, js_node_shutdown),
    JS_CFUNC_DEF("dns", 1, js_node_dns),

    JS_CFUNC_DEF("spawn", 6, js_node_spawn),
    JS_CFUNC_DEF("waitpid", 2, js_node_waitpid),
    JS_CFUNC_DEF("requireEsm", 1, js_node_require_esm),
#ifdef QNODE_HAVE_ZLIB
    JS_CFUNC_DEF("zlibCompress", 5, js_node_zlib_compress),
    JS_CFUNC_DEF("zlibDecompress", 2, js_node_zlib_decompress),
    JS_CFUNC_DEF("crc32", 2, js_node_crc32),
#endif
#ifdef QNODE_HAVE_OPENSSL
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
#endif
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
   the object returned by __qnode_esm_builtin(name). */
static int node_builtin_init(JSContext *ctx, JSModuleDef *m)
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

static JSModuleDef *node_builtin_module(JSContext *ctx, const char *name)
{
    JSValue arg = JS_NewString(ctx, name);
    JSValue obj = node_call_global(ctx, "__qnode_esm_builtin", 1, &arg);
    JS_FreeValue(ctx, arg);
    if (JS_IsException(obj))
        return NULL;

    JSModuleDef *m = JS_NewCModule(ctx, name, node_builtin_init);
    if (!m) {
        JS_FreeValue(ctx, obj);
        return NULL;
    }
    JSPropertyEnum *tab = NULL;
    uint32_t len = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, obj,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
        JS_FreeValue(ctx, obj);
        return NULL;
    }
    for (uint32_t i = 0; i < len; i++) {
        const char *n = JS_AtomToCString(ctx, tab[i].atom);
        if (n) {
            JS_AddModuleExport(ctx, m, n);
            JS_FreeCString(ctx, n);
        }
    }
    JS_FreePropertyEnum(ctx, tab, len);
    JS_AddModuleExport(ctx, m, "default");
    JS_SetModulePrivateValue(ctx, m, obj);
    return m;
}

/* CommonJS modules imported from ESM: evaluate the CJS module and expose
   its exports as a synthetic ES module. */
static int node_cjs_init(JSContext *ctx, JSModuleDef *m)
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

static JSModuleDef *node_cjs_module(JSContext *ctx, const char *path)
{
    JSValue arg = JS_NewString(ctx, path);
    JSValue obj = node_call_global(ctx, "__qnode_import_cjs", 1, &arg);
    JS_FreeValue(ctx, arg);
    if (JS_IsException(obj))
        return NULL;
    if (!JS_IsObject(obj)) {
        JS_FreeValue(ctx, obj);
        JS_ThrowTypeError(ctx, "CommonJS module '%s' did not export an object",
                          path);
        return NULL;
    }

    JSModuleDef *m = JS_NewCModule(ctx, path, node_cjs_init);
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
    NC("SO_KEEPALIVE", SO_KEEPALIVE);
    NC("SO_ERROR", SO_ERROR);
    NC("TCP_NODELAY", TCP_NODELAY);
    NC("IPPROTO_TCP", IPPROTO_TCP);
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
