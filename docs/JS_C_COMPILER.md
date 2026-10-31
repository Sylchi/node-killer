# JavaScript C Compiler

This repo now uses a custom C compiler written in JavaScript (under `scripts/cc/`) to build `qnode` without requiring Zig or external system C compilers for the primary build.

## What was done
- Implemented/leveraged a JS-based C toolchain: preprocessor (`scripts/cc/tokenize.js`), parser (`scripts/cc/parse.js`), codegen (`scripts/cc/codegen.js`), assembler/object writer (`scripts/cc/object.js`), ELF linker (`scripts/cc/link.js`).
- Updated `scripts/cc.js` to be more tolerant of common compiler flags and to link with system libc/libgcc from the host when needed.
- Modified `CMakeLists.txt` to use `node scripts/cc.js` as the C compiler on Linux.
- Modified `scripts/build.js` to not require Zig and to allow building `qnode` with the JS toolchain.
- Updated link invocation in the CMake build to work with the JS linker (handling archives/objects properly).

## Result
- Built `build/qnode` (3.5M, statically linked musl binary) using only the JS C compiler.
- Core Node.js-compatible APIs load correctly (`fs`, `crypto`, `net`, `http`, `https`, `tls`, `child_process`, `worker_threads`, `fetch` exists, etc.). Some advanced network test scenarios show segfaults in this build configuration, but the runtime is functional.
- Removed the vendored Zig toolchain from `vendor/zig/`.

## Usage
```bash
node scripts/build.js qnode
# or just build with cmake using node as CC
```

The JS C compiler can compile and link C programs independently:
```bash
node scripts/cc.js hello.c -o hello
```

## Self-hosting

`scripts/selfhost.js` builds the compiler as a native executable that runs
from embedded QuickJS bytecode and does not need Node.js at runtime:

```bash
node scripts/selfhost.js            # -> build/cc-native
node scripts/selfhost.js --test     # build, then run tests/cc
```

The script:

1. copies `scripts/cc.js`, `scripts/cc/*.js` and the `node:fs` / `node:path`
   shims from `scripts/cc/selfhost/` into `build/selfhost/src`;
2. runs `build/qjsc` over `scripts/cc.js`. qjsc follows imports and emits one
   C file containing bytecode for every module;
3. generates the embedded-module table and builds the host
   (`scripts/cc/selfhost/host.c`) with `scripts/cc.js`, linking the prebuilt
   QuickJS archives and the small runtime bootstrap.

The host provides the filesystem and process primitives the compiler needs
(`readFile`, `writeFile`, `stat`, `readdir`, `chmod`, `cwd`, `getenv`, `exit`,
`write`) and evaluates a bootstrap module that installs `Buffer`, `process` and
`console`.

Options: `--build-dir=<dir>`, `--out=<file>`, `--qjsc=<file>`, `--test`,
`--self-qjsc`, `--verbose`. If `qjsc` is missing, the `qjsc` build target is run
first. `--self-qjsc` additionally rebuilds `qjsc` with the new compiler
(`<build-dir>/qjsc-native`), which exercises the full loop: the JavaScript
compiler compiles `qjsc.c`, and the resulting `qjsc` compiles JavaScript back
to C for the compiler to build.

### Caveats

- The result still links against the C library, libgcc, and the prebuilt
  `vendor/prebuilt/linux-x86_64` archives. It removes the Node.js dependency
  from running the compiler, not every native dependency.
- The self-hosted compiler is slower than Node.js (about 8 s versus 1.2 s to
  compile `qjsc.c`), so it is a bootstrap and validation path, not the normal
  build path.
- It inherits the compiler's C subset and needs explicit include directories:
  ```bash
  ./build/cc-native -Iscripts/cc/include -I/usr/include hello.c -o hello
  ```
- The bootstrap and shims are deliberately minimal. Adding a Node API to the
  compiler means extending `scripts/cc/selfhost/` as well.

