---
sidebar_position: 2
---

# Building

`scripts/build.js` is the only build system. It compiles and links qnode with
the JavaScript C compiler in `scripts/cc/`, so the build needs Node.js 18 or
newer and nothing else: no CMake, make, zig, system C compiler, assembler or
linker.

The compiler targets Linux on x86-64. The prebuilt dependency archives under
`vendor/prebuilt/linux-x86_64/` are checked in, so no download step is needed.

## Getting the source

```bash
git clone https://github.com/quickjs-ng/quickjs.git
cd quickjs
```

## Compiling qnode

```bash
node scripts/build.js
```

This writes `build/qnode`, a Node.js-compatible runtime. zlib, mbedTLS,
libsodium, libev, wasm3 and QuickJS itself are linked from the checked-in
static archives under `vendor/`.

## Build targets

```bash
node scripts/build.js          # build qnode (default)
node scripts/build.js qjsc     # build the QuickJS compiler
node scripts/build.js codegen  # regenerate builtin-*.h with qjsc
node scripts/build.js clean    # remove the build directory
```

`--build-dir`, `--jobs` (or `-j`) and `--verbose` are accepted:

```bash
node scripts/build.js --build-dir=out -j 8
BUILD_DIR=out node scripts/build.js
```

Each target is also an npm script, so `npm run build`, `npm run qjsc`,
`npm run codegen`, `npm run clean` and `npm test` work too.

## Tests

```bash
node scripts/build.js qnode-test        # all qnode suites
node scripts/build.js net-test          # net_shards only
node scripts/build.js netstack-tun-test
node scripts/build.js netstack-tap-test
```

## Big Endian architecture support

The bundled bytecode is endian dependent and the shipped headers contain little
endian bytecode. Regenerate it with the JavaScript compiler before building for
a big endian target:

```bash
node scripts/build.js codegen
```

## The C compiler

The compiler driver is `scripts/cc.js`; the preprocessor, parser, code
generator, ELF object writer and linker live in `scripts/cc/`. It can also be
used directly:

```bash
node scripts/cc.js hello.c -o hello
```

See [the compiler notes](../JS_C_COMPILER) for details.
