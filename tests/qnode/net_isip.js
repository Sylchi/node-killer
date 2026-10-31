/* net.isIP() must agree with Node.js, and the connect path must classify the
 * same strings as literals (no DNS). Run with qnode. */
"use strict";

const assert = require("assert");
const net = require("net");

/* Expected values captured from Node.js 24 `net.isIP()`. */
const CASES = [
  ["127.0.0.1", 4],
  ["0.0.0.0", 4],
  ["255.255.255.255", 4],
  ["256.1.1.1", 0],
  ["1.2.3", 0],
  ["1.2.3.4.5", 0],
  ["01.2.3.4", 0],
  ["1.2.3.04", 0],
  ["", 0],
  ["::", 6],
  ["::1", 6],
  ["1::", 6],
  ["1:2:3:4:5:6:7:8", 6],
  ["1:2:3:4:5:6:7", 0],
  ["1:2:3:4:5:6:7:8:9", 0],
  [":::", 0],
  ["1:::2", 0],
  ["1::2::3", 0],
  ["::ffff:1.2.3.4", 6],
  ["1:2:3:4:5:6:1.2.3.4", 6],
  ["1:2:3:4:5:6:7:1.2.3.4", 0],
  ["1.2.3.4::", 0],
  ["fe80::1%eth0", 6],
  ["12345::", 0],
  ["::ffff:0:1.2.3.4", 6],
  ["abcd:ef01:2345:6789:abcd:ef01:2345:6789", 6],
  ["fd00:dead:beef:99::1", 6],
];

let failures = 0;
function ok(name, fn) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (e) {
    failures++;
    console.log("not ok - " + name + ": " + (e && e.message));
  }
}

for (const [input, want] of CASES) {
  ok("isIP(" + JSON.stringify(input) + ") === " + want, () => {
    assert.strictEqual(net.isIP(input), want);
  });
}

ok("isIPv4/isIPv6 agree with isIP", () => {
  for (const [input, want] of CASES) {
    assert.strictEqual(net.isIPv4(input), want === 4, input);
    assert.strictEqual(net.isIPv6(input), want === 6, input);
  }
});

ok("non-string inputs are coerced like Node", () => {
  assert.strictEqual(net.isIP(127), 0);
  assert.strictEqual(net.isIP(undefined), 0);
});

if (failures) {
  console.log("net_isip: " + failures + " failure(s)");
  process.exit(1);
}
console.log("net_isip: all passed");
