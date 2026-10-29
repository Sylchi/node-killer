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

`mbedtls/` contains the upstream `include/` and `library/` trees; the test
suites, programs and documentation are not vendored. `libsodium/` contains
the upstream `src/libsodium/` tree. `zlib/` contains the upstream core
sources.

When updating mbedtls or zlib, replace the corresponding directory with the
new release and rebuild. The only integration points are the source lists in
the top-level `CMakeLists.txt`.
