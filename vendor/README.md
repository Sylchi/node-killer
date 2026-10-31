# Vendored dependencies

These source trees supply the headers and code qnode builds against, so a
checkout has all of its build dependencies and needs no system packages or
network access.

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
build. The archives are plain static objects; `scripts/build.js` links them
with the JavaScript C compiler and never invokes a native compiler.

| Archive | Built from | Objects |
|---|---|---|
| `libqnode_zlib.a` | zlib core `*.c` | 15 |
| `libqnode_mbedtls.a` | `mbedtls/library/*.c` | 109 |
| `libqnode_sodium.a` | `libsodium/src/libsodium/**/*.c` | 119 |
| `libqnode_libev.a` | `libev/ev.c` | 1 |
| `libqnode_wasm3.a` | `wasm3/source/*.c` | 15 |
| `libqjs.a` | `quickjs.c`, `dtoa.c`, `libregexp.c`, `libunicode.c`, `qjs-wasm.c` | 5 |

Current archives:

| Directory | Platform |
|---|---|
| `prebuilt/linux-x86_64/` | Linux x86-64 |

They are not freestanding objects: zlib, mbedTLS, libsodium, libev and wasm3
call the C library (`malloc`, `pthread_*`, `epoll_*`, `fopen`, `getrandom`, …),
so they need a libc at link time. `scripts/cc.js` supplies the host static C
library when it links the executable.

The public headers stay in `vendor/` because qnode includes them directly.
Regenerating or upgrading an archive is a maintenance task performed outside
the normal build; `scripts/build.js` treats the archives as build inputs.
