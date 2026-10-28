'use strict';
// Filesystem + buffer throughput: write/read an 8 MiB file, 40 iterations.
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(os.tmpdir(), 'runtime-compare-' + process.pid + '.bin');
const buf = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < buf.length; i += 4096) buf[i] = i & 0xff;

// warmup
fs.writeFileSync(file, buf);
fs.readFileSync(file);

const t0 = performance.now();
let sum = 0;
for (let i = 0; i < 40; i++) {
  fs.writeFileSync(file, buf);
  const r = fs.readFileSync(file);
  sum += r.length + r[0];
}
const ms = performance.now() - t0;
try { fs.unlinkSync(file); } catch (e) {}
console.log('FS ' + (40 * 2 * buf.length) + ' ' + ms.toFixed(3) + ' ' + sum);
