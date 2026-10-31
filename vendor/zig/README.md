# Vendored zig toolchain

zig 0.16.0 for x86-64 Linux, used to build qnode and the prebuilt archives in
`vendor/prebuilt/` without depending on a host compiler or libc.

| | |
|---|---|
| Version | 0.16.0 |
| Source | https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz |
| SHA-256 | `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00` |
| License | MIT, see `LICENSE` |
| Executable | `zig` (statically linked, stripped) |

`lib/` is trimmed to what `zig cc -target x86_64-linux-musl` needs: the C
headers (`lib/include`), the musl headers and sources (`lib/libc/musl`,
`lib/libc/include/{any-linux-any,generic-musl,x86_64-linux-musl}`),
`compiler_rt`, `std`, `c`, and the top-level `*.zig` support files. Darwin,
Windows, glibc, the C++ runtimes and the docs are not included, so this copy
only targets Linux musl. `zig build` projects and non-Linux targets need the
full upstream tarball instead.

CMake picks `vendor/zig/zig` automatically on x86-64 Linux when no compiler was
specified; other hosts fall back to a `zig` on `PATH`, then to the system
compiler with qnode disabled.

The pre-commit `act` hook mounts a host directory at `/zig-cache` and sets
`ZIG_GLOBAL_CACHE_DIR` so container runs reuse zig's generated libc and
compiler_rt objects. The directory defaults to
`${XDG_CACHE_HOME:-~/.cache}/qnode-act/zig`; set `ACT_PRECOMMIT_ZIG_CACHE` to
move it.

To update, extract the official tarball and copy the executable, `LICENSE`,
and the required `lib/` pieces into this directory.
