// RSS over the lifetime of a JSON workload, for qjs / qjs -c.
// Run: qjs --std mem-aot.js   or   qjs -c mem-aot.js -o mem-aot && ./mem-aot
import * as std from "qjs:std";

function rssKB() {
  const status = std.loadFile("/proc/self/status");
  const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
  return m ? Number(m[1]) : -1;
}

function report(tag) {
  console.log("RSS " + tag + " " + rssKB());
}

report("baseline");

const a = [];
for (let i = 0; i < 300000; i++) {
  a.push({ id: i, name: "item-" + i, ok: (i & 1) === 0, v: i * 1.5 });
}
report("after-alloc");

const s = JSON.stringify(a);
report("after-stringify");

let b = JSON.parse(s);
report("after-parse");

a.length = 0;
b.length = 0;
if (typeof std.gc === "function") std.gc();
report("after-drop+gc");
