/* Direct memory access: native.allocMemory() hands back a C-heap-backed
 * ArrayBuffer that JS can read and write byte-wise, with the block released
 * automatically once the ArrayBuffer becomes unreachable. Run with qnode. */
"use strict";

const assert = require("assert");

const native = globalThis.__qnode_native;

function testAllocMemory() {
  const size = 8;
  const ab = native.allocMemory(size);
  assert.ok(ab instanceof ArrayBuffer);
  assert.strictEqual(ab.byteLength, size);

  const buf = new Buffer(ab, 0, size);
  for (let i = 0; i < size; i++)
    buf[i] = (i * 7) & 0xff;
  assert.strictEqual(buf.toString("hex"), "00070e151c232a31");

  /* A second view over the same backing block must see the same bytes. */
  const view = new Uint8Array(ab, 0, size);
  assert.strictEqual(view[7], 0x31);

  /* Native consumers can pull the raw pointer out of the same buffer. */
  const nativeBuf = native.randomBytes(size);
  const nativeView = new Uint8Array(nativeBuf.buffer, nativeBuf.byteOffset,
                                   nativeBuf.byteLength);
  nativeView[0] = 0xab;
  assert.strictEqual(nativeBuf[0], 0xab);
}

(async () => {
  await testAllocMemory();
  console.log("direct_memory: all tests passed");
})().then(() => process.exit(0), (err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
