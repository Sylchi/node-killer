# Vendored dependencies

These source trees are compiled into qnode so that a checkout has all of its
build dependencies and no system packages or network access are needed.

| Directory | Version | Source |
|---|---|---|
| `libev/` | 4.33 | https://github.com/enki/libev |
| `libsodium/` | 1.0.20 | https://github.com/jedisct1/libsodium/releases/tag/1.0.20-RELEASE |
| `mbedtls/` | 3.6.7 | https://github.com/Mbed-TLS/mbedtls/releases/tag/mbedtls-3.6.7 |
| `wasm3/` | 0.9.2 | https://github.com/wasm3/wasm3 |
| `zlib/` | 1.3.2 | https://zlib.net/zlib-1.3.2.tar.gz |

`mbedtls/` contains the upstream `include/` tree; `libsodium/` contains the
upstream `src/libsodium/include/` tree. The library sources and test suites are
not vendored, see the prebuilt archives below.

## Prebuilt qnode libraries

qnode links zlib, mbedTLS, libsodium, libev, wasm3 and quickjs from static
archives checked into `prebuilt/<system>-<arch>/`. These libraries do not change
with qnode, so they are kept precompiled instead of rebuilding them on every
build. `libev` and `wasm3` keep their sources because they are also compiled for
WASI, Emscripten, Windows and macOS; those targets fall back to the source trees
when no archive matches, so cross-platform builds keep working. QuickJS keeps
its sources as the canonical copy; `libqjs.a` is a build cache of them, and
`-DQNODE_USE_PREBUILT_QJS=OFF` compiles them instead.

| Archive | Built from | Objects |
|---|---|---|
| `libqnode_zlib.a` | zlib core `*.c` | 15 |
| `libqnode_mbedtls.a` | `mbedtls/library/*.c` | 109 |
| `libqnode_sodium.a` | `libsodium/src/libsodium/**/*.c` | 119 |
| `libqnode_libev.a` | `libev/ev.c` | 1 |
| `libqnode_wasm3.a` | `wasm3/source/*.c` | 15 |
| `libqjs.a` | `quickjs.c`, `dtoa.c`, `libregexp.c`, `libunicode.c`, `qjs-wasm.c` | 5 |

Current archives:

| Directory | Toolchain |
|---|---|
| `prebuilt/linux-x86_64/` | `zig cc -target x86_64-linux-musl` |

The archives are compiled with zig for `<arch>-linux-musl`, the same target
zig uses for qnode itself. That target is an implementation detail: the
archives are plain static objects, named only after the OS and architecture,
and qnode links them into one static binary on glibc and musl hosts alike.
They are not freestanding objects: zlib, mbedTLS, libsodium, libev and wasm3
call the C library (`malloc`, `pthread_*`, `epoll_*`, `fopen`, `getrandom`, …),
so they need a libc at link time. CMake selects zig automatically on Linux
when no compiler was specified and disables qnode when zig is missing or no
archive matches the target.

The libsodium archives are compiled with `CONFIGURED=1`, little-endian, the
`HAVE_*` feature macros, `TLS=_Thread_local`, and `_GNU_SOURCE`, exactly as the
previous in-tree build. libev is compiled with `EV_STANDALONE`,
`QJS_HAVE_LIBEV`, and `EV_USE_EPOLL=1`; wasm3 with `d_m3HasWASI`,
`d_m3HasFloat=1`, `_GNU_SOURCE` and `-fPIC`. Debug info is stripped
(`strip -g`) to keep the repository small. The public headers stay in
`vendor/` because qnode includes them directly.

### Regenerating libqjs.a

`libqjs.a` is the only archive built from sources that live in this repository.
Regenerate it after changing any of the five QuickJS sources or a header they
include:

```sh
vendor/zig/zig cc -target x86_64-linux-musl -O3 -DNDEBUG -DEV_STANDALONE \
    -DEV_USE_EPOLL=1 -DQJS_BUILD_WASM3 -DQJS_HAVE_LIBEV -D_GNU_SOURCE \
    -I. -Ivendor/libev -Ivendor/wasm3/source \
    -std=gnu11 -fvisibility=hidden -funsigned-char \
    -c quickjs.c dtoa.c libregexp.c libunicode.c qjs-wasm.c
strip -g quickjs.o dtoa.o libregexp.o libunicode.o qjs-wasm.o
ar rcs libqjs.a dtoa.o libregexp.o libunicode.o quickjs.o qjs-wasm.o
mv libqjs.a vendor/prebuilt/linux-x86_64/
```

The archive contains only those five objects; libev, wasm3 and the C library
are linked separately. During QuickJS work, configure with
`-DQNODE_USE_PREBUILT_QJS=OFF` to compile the sources instead.

### Regenerating the archives

Replacing a version means: restore the upstream source tree, build the
`qnode_zlib`, `qnode_mbedtls` and `qnode_sodium` targets with zig, then compile
libev and wasm3 and copy the resulting `libqnode_*.a` into
`prebuilt/<system>-<arch>/`:

```sh
cmake -S . -B build-vendor -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$PWD/vendor/zig/zig" -DCMAKE_C_COMPILER_ARG1=cc \
    -DCMAKE_C_FLAGS="-target x86_64-linux-musl"
cmake --build build-vendor --target qnode_zlib qnode_mbedtls qnode_sodium

vendor/zig/zig cc -target x86_64-linux-musl -O3 -DNDEBUG -DEV_STANDALONE \
    -DEV_USE_EPOLL=1 -DQJS_HAVE_LIBEV -D_GNU_SOURCE -Ivendor/libev \
    -c vendor/libev/ev.c -o ev.o
ar rcs libqnode_libev.a ev.o

for f in vendor/wasm3/source/*.c; do
    vendor/zig/zig cc -target x86_64-linux-musl -O3 -DNDEBUG -fPIC -Dd_m3HasWASI \
        -Dd_m3HasFloat=1 -D_GNU_SOURCE -Ivendor/wasm3/source \
        -c "$f" -o "$(basename "$f" .c).o"
done
ar rcs libqnode_wasm3.a m3_*.o

strip -g libqnode_*.a
```

The `qnode_zlib`, `qnode_mbedtls` and `qnode_sodium` targets only exist in
revisions that still contain the library sources, which is not the case in a
normal checkout. Generate the archives from such a revision (the commit before
the sources were removed, or a worktree of it with the upstream trees
restored), then copy them into `prebuilt/`.
