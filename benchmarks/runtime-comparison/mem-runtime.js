// Same JSON workload as mem-aot.js for Node/Bun/qnode.
function rssMB() {
  return (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
}
function report(tag) {
  console.log('RSS ' + tag + ' ' + rssMB() + ' MB');
}
report('baseline');

const a = [];
for (let i = 0; i < 300000; i++) {
  a.push({ id: i, name: 'item-' + i, ok: (i & 1) === 0, v: i * 1.5 });
}
report('after-alloc');

const s = JSON.stringify(a);
report('after-stringify');

let b = JSON.parse(s);
report('after-parse');

a.length = 0;
b.length = 0;
if (typeof global.gc === 'function') global.gc();
report('after-drop+gc');
