// qjsc-compiled mirror of bench.js. Uses qjs:os for timing because the
// standalone qjsc runtime has no `process`/`performance`.
// Build:
//   qjsc -e -s -s -o bench_aot.c bench-aot.js
//   cc -O3 -DNDEBUG -I<repo> bench_aot.c -o bench_aot ... -static
import * as os from "qjs:os";
import * as std from "qjs:std";

const name = std.getenv("BENCH");
if (!name) {
  console.log("usage: BENCH=<name> ./bench_aot");
  std.exit(2);
}

const now = () => os.now() / 1000; // os.now() is microseconds
let t0 = now();
function reset() {
  t0 = now();
}
function sink(v) {
  if (v === Symbol.for("never")) console.log(v);
}

let ops = 0;

const benches = {
  fib() {
    function fib(n) {
      return n < 2 ? n : fib(n - 1) + fib(n - 2);
    }
    fib(10);
    reset();
    sink(fib(30));
    ops = 1;
  },

  loop() {
    let x = 0;
    reset();
    for (let i = 0; i < 30_000_000; i++) x = (x + i) | 0;
    sink(x);
    ops = 30_000_000;
  },

  floatloop() {
    let x = 0.5;
    reset();
    for (let i = 0; i < 30_000_000; i++) x = x * 1.0000001 + 0.0000001;
    sink(x);
    ops = 30_000_000;
  },

  json() {
    const a = [];
    for (let i = 0; i < 200_000; i++) {
      a.push({ id: i, name: "item-" + i, ok: (i & 1) === 0, v: i * 1.5 });
    }
    reset();
    const s = JSON.stringify(a);
    const b = JSON.parse(s);
    sink(b.length);
    ops = a.length;
  },

  regex() {
    const re = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
    const good = "first.last+tag@example-domain.co.uk";
    let n = 0;
    reset();
    for (let i = 0; i < 300_000; i++) if (re.test(good)) n++;
    sink(n);
    ops = 300_000;
  },

  sort() {
    const a = new Array(300_000);
    let seed = 123456789;
    for (let i = 0; i < a.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      a[i] = seed;
    }
    reset();
    a.sort((x, y) => x - y);
    sink(a[0]);
    ops = a.length;
  },

  array() {
    const a = new Array(1_000_000);
    for (let i = 0; i < a.length; i++) a[i] = i;
    reset();
    const b = a.map((x) => x * 2).filter((x) => (x & 3) === 0);
    const c = b.reduce((s, x) => s + x, 0);
    sink(c);
    ops = a.length;
  },

  string() {
    let s = "";
    reset();
    for (let i = 0; i < 200_000; i++) s += "abc";
    sink(s.length);
    ops = 200_000;
  },

  object() {
    const a = new Array(300_000);
    reset();
    for (let i = 0; i < a.length; i++) {
      a[i] = { x: i, y: i + 1, z: "v" + i };
    }
    sink(a[0].x);
    ops = a.length;
  },
};

if (!benches[name]) {
  console.log("unknown bench: " + name);
  std.exit(2);
}

const start = now();
benches[name]();
console.log("BENCH " + name + " " + ops + " " + (now() - start).toFixed(3));
