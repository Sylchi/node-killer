# qnode vs Node.js vs Bun

Snapshot: 2026-10-29. This is a like-for-like smoke comparison, not a
benchmark suite for choosing a production runtime. All numbers come from the
scripts in this directory on one machine.

| | [qnode](../../) | Node.js | Bun |
|---|---|---|---|
| Version | `v20.11.0-qnode.0.1.0` (QuickJS-ng 0.17.0, `dac3d6e`) | `v24.22.1` | `1.4.4` (reports `process.version` `v26.3.0` for compatibility) |
| Engine | QuickJS-ng interpreter | V8 with JIT | JavaScriptCore with JIT |
| Implementation | C | C++ | Zig/C++ |
| Binary, stripped | **3.2 MB** (static-pie, mbedTLS) | 52 MB (dynamic) | 101 MB (dynamic) |
| Idle RSS | **5.6 MB** | 47.9 MB | 26.1 MB |
| Startup, `-e ""` | 23.7 ms | 54.9 ms | **2.3 ms** |
| Startup, load `fs/http/os/path` + write | **24.4 ms** | 87.9 ms | 29.6 ms |

Machine: AMD Ryzen 7 7840U (16 threads), Alpine Linux 3.24 (musl), kernel
6.18 on WSL2, x86-64. qnode built with GCC 15.2, `Release`, static CLI,
vendored libev with epoll. The qnode binary size was re-measured after the
switch from OpenSSL to mbedTLS; the startup and RSS figures were not
re-measured after that swap.

## TL;DR

- **qnode is small and starts fast.** 3.2 MB stripped, 5.6 MB idle RSS,
  ~24 ms startup. It beats Node on every startup test and beats Bun once a
  realistic CommonJS prelude is loaded.
- **qnode is 2–13x slower on CPU-bound JavaScript** than Node, and up to
  ~57x slower than Bun on a tight integer loop. Expected: QuickJS is an
  interpreter, Node and Bun have JITs.
- **`qjs -c` standalone binaries start in ~1.3 ms and are 1.5 MB stripped**,
  beating Node and Bun on startup and footprint. They are native ELF
  executables, but the JavaScript inside is still interpreted bytecode — CPU
  speed matches `qjs`/`qnode`, not Bun's JIT.
- **qnode's I/O is competitive for a small runtime.** HTTP keep-alive is
  ~2.0x slower than Node and ~3.4x slower than Bun; file I/O is ~2.2x slower
  than Node and ~5.8x slower than Bun.
- **Feature coverage is the main gap.** qnode implements a useful Node
  subset (fs, http/https, net, tls, zlib, crypto, dns, child_process, streams,
  ESM/CJS) but has no WebSocket, Web Streams, WebCrypto, HTTP/2, `node:test`,
  worker threads, native addons, or TypeScript.

## Features

Legend: ✅ available, ⚠️ partial/stub, ❌ not available.

| Capability | Node.js 24 | Bun 1.4 | qnode |
|---|:---:|:---:|:---:|
| CommonJS | ✅ | ✅ | ✅ |
| ESM | ✅ | ✅ | ✅ |
| Top-level await | ✅ | ✅ | ✅ |
| Import attributes (`with { type: "json" }`) | ✅ | ✅ | ✅ |
| `node:` module prefix | ✅ | ✅ | ✅ for implemented modules |
| TypeScript (`.ts`) | ✅ erasable syntax only | ✅ full | ❌ |
| JSX / TSX | ❌ | ✅ | ❌ |
| `fetch`, `Headers`, `Request`, `Response` | ✅ | ✅ | ✅ |
| `WebSocket` | ✅ | ✅ | ❌ |
| Web Streams | ✅ | ✅ | ❌ |
| Web Crypto (`crypto.subtle`) | ✅ | ✅ | ❌ (only `randomUUID`, `getRandomValues`) |
| WebAssembly | ✅ | ✅ | ❌ |
| HTTP/1.1 server and client | ✅ | ✅ | ✅ |
| HTTP/2 | ✅ | ✅ | ❌ |
| TLS | ✅ | ✅ | ✅ |
| `zlib` | ✅ | ✅ | ✅ |
| `dns` | ✅ | ✅ | ✅ |
| `child_process` | ✅ | ✅ | ✅ |
| `cluster` | ✅ | ✅ | ❌ |
| `dgram` (UDP) | ✅ | ✅ | ❌ |
| `worker_threads` | ✅ | ✅ | ⚠️ module loads, `new Worker` throws |
| `node:test` | ✅ | ✅ (`bun:test`) | ❌ |
| Watch mode | ✅ | ✅ | ❌ |
| Bundler | ❌ | ✅ (`bun build`) | ❌ |
| Package manager | npm | `bun install` | `qnode install` (minimal npm client) |
| Standalone executable | ✅ SEA | ✅ `--compile` | ❌ |
| Native addons (N-API) | ✅ | ⚠️ partial | ❌ |
| Built-in SQLite | ✅ `node:sqlite` | ✅ `bun:sqlite` | ❌ |
| Inspector / debugger | ✅ | ✅ | ❌ |
| WASI | ✅ | ✅ | ❌ |
| REPL | ✅ | ✅ | ❌ |

### Modules qnode does not provide

`cluster`, `dgram`, `domain`, `http2`, `inspector`, `repl`, `test`, `wasi`,
`sqlite`, `sea`. `worker_threads` resolves but is a stub.

### Language features

All three pass the tested ES2020+ features: optional chaining, nullish
coalescing, class fields, private fields, logical assignment, `Array.fromAsync`,
`Object.groupBy`, `Promise.withResolvers`, Set methods, iterator helpers,
`toSorted`, `using`, `RegExp` `v`/`d` flags, and import attributes. None
supports decorators. Bun adds `Temporal` and `ShadowRealm`.

## Benchmarks

Method: five runs per CPU benchmark, median reported. Each benchmark runs in
a fresh process. HTTP and filesystem use three runs. Times are milliseconds,
lower is better; "—" means not measured.

| Benchmark | Node.js | Bun | qnode | qnode vs Node |
|---|---:|---:|---:|---:|
| `fib(30)` recursion | 9.5 | 7.1 | 80.8 | 8.5x slower |
| 30M integer loop | 142.3 | 11.5 | 654.5 | 4.6x slower |
| 30M float loop | 55.0 | 55.3 | 735.7 | 13.4x slower |
| JSON stringify+parse, 200k objects | 204.3 | 202.9 | 732.9 | 3.6x slower |
| 300k regex tests | 17.4 | 11.6 | 233.1 | 13.4x slower |
| Sort 300k numbers | 76.9 | 68.6 | 191.8 | 2.5x slower |
| map+filter+reduce, 1M items | 60.9 | 40.8 | 152.3 | 2.5x slower |
| 200k string appends | 13.5 | 4.2 | 29.3 | 2.2x slower |
| Create 300k objects | 57.6 | 46.9 | 168.3 | 2.9x slower |
| HTTP keep-alive, 10k req, C=16 | 1113.1 | 667.1 | 2239.0 | 2.0x slower |
| 8 MiB write+read, 40 iterations | 379.3 | 140.3 | 817.0 | 2.2x slower |

Derived throughput:

| Path | Node.js | Bun | qnode |
|---|---:|---:|---:|
| HTTP requests/sec (single process, keep-alive, C=16) | 8,984 | 14,990 | 4,466 |
| File I/O (MB/s, 640 MiB total, warm cache) | 1,770 | 4,783 | 821 |

Startup and memory:

| Metric | Node.js | Bun | qnode |
|---|---:|---:|---:|
| `runtime -e ""` | 54.9 ms | 2.3 ms | 23.7 ms |
| Load `fs`, `path`, `os`, `http` + write a file | 87.9 ms | 29.6 ms | 24.4 ms |
| Idle RSS | 47.9 MB | 26.1 MB | 5.6 MB |
| Peak RSS, JSON 200k workload | 189.7 MB | 149.1 MB | 166.4 MB |

### Reading the numbers

- The integer loop is Bun's best case: JavaScriptCore eliminates most of the
  work, while QuickJS executes every iteration. Do not read 57x as a general
  Bun-vs-qnode ratio.
- Float loop, regex, and `fib` show the cost of interpretation most clearly
  (8–13x vs Node).
- JSON, sorting, array/object churn, and I/O are "only" 2–4x slower, because
  those paths spend more time in C helpers or syscalls than in bytecode.
- qnode's HTTP result is good for an interpreter: ~4.5k req/s with client and
  server in the same single-threaded process. The earlier uncommitted
  keep-alive/epoll work in this tree is included.
- Startup is qnode's strongest result. Its bootstrap is a 274 KB JavaScript
  file parsed on every launch, so ~24 ms is mostly fixed cost. Node's ~55 ms
  and Bun's ~2 ms bare startup are very different shapes; once real modules
  are loaded, qnode wins this test.

## AOT: `qjs -c` standalone executables

`qjs -c script.js -o app` produces a real native ELF executable, but it does
**not** translate JavaScript to machine code. It compiles the script to
QuickJS bytecode, embeds that byte array in the interpreter binary, and adds a
tiny trailer that loads it. At runtime the bytecode is still executed by the
QuickJS interpreter. Startup no longer parses or compiles source; CPU-bound
code is unchanged.

The apk-installed `qjs` 0.11.0 shows exactly what the output is:

```sh
$ qjs -c hello.js -o hello
$ file hello
ELF 64-bit LSB pie executable ... dynamically linked ...
$ ls -l hello /usr/bin/qjs
108664 hello          # interpreter + 104-byte bytecode trailer
108560 /usr/bin/qjs
$ ldd hello
libqjs.so.0 => /usr/lib/libqjs.so.0
```

The repo build produces a self-contained static-pie binary instead, but the
same rule applies: native container, interpreted payload.

### Compiled vs interpreted, same engine

Using apk `qjs` 0.11.0, `qjs -c` vs `qjs script.js`, median of 3–7 runs:

| Benchmark | `qjs -c` | interpreted | delta |
|---|---:|---:|---:|
| `fib(30)` | 197.9 ms | 199.6 ms | -0.9% |
| 30M integer loop | 2452 ms | 2485 ms | -1.3% |
| 300k regex tests | 671 ms | 706 ms | -4.8% |
| JSON 200k objects | 1142 ms | 1344 ms | -15% |
| Create 300k objects | 333–446 ms | 333–446 ms | noise |

The spread is run-to-run/GC variance, not code generation. JSON is
consistently a few percent faster, likely because the parse-time allocations
are gone; it is not a 2x or 10x effect. The 200k string-append test takes
>30 s in 0.11 on both paths (old QuickJS has quadratic concatenation), which
is why it is excluded here.

For reference, the repo's QuickJS-ng 0.17.0 is much faster than apk's 0.11.0:
30M loop 2452 ms → 699 ms, regex 671 ms → 251 ms, `fib(30)` 198 ms → 83 ms.

### Repository build with `qjs -c`

| Metric | Node.js | Bun | qnode | `qjs -c` |
|---|---:|---:|---:|---:|
| Startup, hello world | 51.9 ms | 2.2 ms | 22.5 ms | **1.3 ms** |
| Binary, stripped | 52 MB | 101 MB | 3.2 MB | **1.5 MB** |
| Idle RSS | 47.9 MB | 26.1 MB | 5.6 MB | **1.5 MB** |

CPU benchmarks, same workloads as above (ms, lower is better):

| Benchmark | Node.js | Bun | qnode | `qjs -c` |
|---|---:|---:|---:|---:|
| `fib(30)` | 9.5 | 7.1 | 81.7 | 82.6 |
| 30M integer loop | 142.3 | 11.5 | 647.2 | 699.4 |
| 30M float loop | 55.0 | 55.3 | 722.9 | 729.4 |
| JSON 200k objects | 204.3 | 202.9 | 614.2 | 642.6 |
| 300k regex tests | 17.4 | 11.6 | 235.9 | 250.6 |
| Sort 300k numbers | 76.9 | 68.6 | 193.6 | 190.8 |
| map+filter+reduce 1M | 60.9 | 40.8 | 153.9 | 155.6 |
| 200k string appends | 13.5 | 4.2 | 29.5 | 31.2 |
| Create 300k objects | 57.6 | 46.9 | 163.9 | 170.4 |

The deltas between qnode and `qjs -c` are run-to-run noise, not a codegen
advantage. A manual `qjsc` + `cc -O3` build lands in the same range (e.g.
82 ms vs 83 ms on `fib(30)`).

What gets faster with `qjs -c`:

- **Startup:** ~22.5 ms → ~1.3 ms, because the 274 KB qnode bootstrap and all
  source parsing disappear.
- **Footprint:** ~3.2 MB → ~1.5 MB stripped, ~5.6 MB → ~1.5 MB idle RSS.
- **Deployment:** one self-contained executable, no `node_modules` or runtime
  install.

What does not get faster:

- **CPU-bound JavaScript.** Bytecode is still interpreted. The 30M integer
  loop is ~11.5 ms on Bun (JIT) versus ~700 ms for QuickJS bytecode.
- **Node compatibility.** A `qjs -c` binary contains the `qjs:std` / `qjs:os`
  runtime, not qnode's Node API surface (no `fs`, `http`, npm packages), so
  this is not a drop-in way to ship a qnode app today.


### Is the memory footprint static?

Two different things are easy to conflate here:

- **Static linkage:** yes for this repo's build — `qjs -c` emits a
  `static-pie` binary with no `libqjs.so` dependency. The apk build is
  dynamically linked to `libqjs.so.0`. Neither affects how the JS heap grows.
- **Static memory usage:** no. The ~1.5 MB figure is the idle floor (code pages
  touched, runtime structures, empty heap). RSS grows with live JavaScript
  data and does not immediately return to the floor after a workload.

RSS through the JSON workload (300k objects → stringify → parse → drop):

| Stage | qjs / `qjs -c` | qnode | Bun | Node |
|---|---:|---:|---:|---:|
| Baseline | **1.6 MB** | 5.5 MB | 26.6 MB | 48.6 MB |
| After allocating 300k objects | 66.1 MB | 68.4 MB | 79.9 MB | 113.5 MB |
| After `JSON.stringify` | 82.7 MB | 84.6 MB | 130.5 MB | 138.8 MB |
| After `JSON.parse` | 162.6 MB | 162.6 MB | 146.9 MB | 178.8 MB |
| After dropping refs + GC | 27.8 MB | 31.0 MB | 54.1 MB | 169.4 MB |

Compiled and interpreted QuickJS are identical at every stage (162,648 KB vs
162,664 KB at peak), which is another confirmation that `qjs -c` changes
loading, not execution.

The practical takeaway: the standalone binary is cheap to *start* (1.5 MB
baseline) but it is not a fixed-memory runtime. A JSON workload peaks around
163 MB, the same as qnode, because the live objects and strings dominate. The
low baseline comes from QuickJS being small — not from static linking.

Also note that RSS is not binary size: a 2.4 MB static binary only keeps its
touched code pages resident (baseline 1.6 MB). Large unused sections are not
charged to RSS until accessed.

### Caveats

- QuickJS has no JIT. Comparing it to V8/JSC on CPU benchmarks measures the
  design difference, not implementation quality.
- The HTTP benchmark runs client and server in the same process, so it
  measures the event loop and HTTP stack, not multi-core server throughput.
  Keep-alive and warm caches favor all three runtimes equally.
- The filesystem test writes to `/tmp` on ext4 with a warm page cache.
- Peak RSS is a single workload, not a memory-efficiency verdict.
- qnode is pre-1.0 and has known parity gaps; the feature table reflects the
  commit above, not a promise.

## Reproduce

```sh
# from this directory
QNODE=../../build/qnode python3 run.py

# startup (uses hyperfine)
hyperfine --warmup 3 --runs 20 \
  'node -e ""' 'bun -e ""' '../../build/qnode -e ""'
hyperfine --warmup 2 --runs 10 \
  'node startup.js' 'bun startup.js' '../../build/qnode startup.js'

# feature probes
node features.js > features-node.json
bun features.js > features-bun.json
../../build/qnode features.js > features-qnode.json

# qjs -c standalone executables (repo build, static)
sh build-aot.sh
BENCH=fib ./aot-build/bench-aot
./aot-build/hello-aot

# same test with apk's qjs 0.11 (dynamic, needs libqjs.so.0)
qjs -c bench-aot.js -o /tmp/bench-sys && BENCH=fib /tmp/bench-sys
```

Files: `bench.js` (CPU), `bench-aot.js` (same workloads for `qjs -c`),
`fsbench.js`, `httpconc.js`, `startup.js`, `hello-aot.js`, `build-aot.sh`,
`mem-aot.js` / `mem-runtime.js` (RSS stages), `features.js`, `run.py`.
Results are written to `results.json`, `results-aot.json`, and
`results-aot-011.json`.
