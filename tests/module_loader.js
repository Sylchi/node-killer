/* Module loader interop tests: builtin ESM imports, ESM/CJS cross-imports,
 * relative imports and package.json "type" resolution. Run with qnode. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = path.join(os.tmpdir(),
                      "qnode-modules-" + process.pid + "-" + Date.now());

function write(name, contents) {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

async function main() {
  fs.mkdirSync(tmp);

  /* Builtin modules are importable both as a default and as named exports. */
  const fsns = await import("fs");
  assert.strictEqual(typeof fsns.readFileSync, "function");
  assert.strictEqual(typeof fsns.default.readFileSync, "function");
  const crypto = await import("crypto");
  assert.strictEqual(typeof crypto.createHash, "function");
  assert.strictEqual(typeof crypto.createHmac, "function");

  /* Relative ESM imports. */
  write("b.mjs", "export const b = 41;\n");
  const a = write("a.mjs",
    'import { b } from "./b.mjs";\n' +
    "export const a = b + 1;\n" +
    "export default a * 2;\n");
  const ans = await import(a);
  assert.strictEqual(ans.a, 42);
  assert.strictEqual(ans.default, 84);

  /* CommonJS imported from ESM, including named exports. */
  write("c.cjs", "module.exports = { c: 5, d: 6 };\n");
  const d = write("d.mjs",
    'import m from "./c.cjs";\n' +
    'import { c } from "./c.cjs";\n' +
    "export const total = m.c + m.d + c;\n");
  assert.strictEqual((await import(d)).total, 16);

  /* ESM required from CommonJS returns the module namespace. */
  const ns = require(a);
  assert.strictEqual(ns.a, 42);
  assert.strictEqual(ns.default, 84);

  /* package.json "type": "module" makes .js files ESM. */
  write("pkg/package.json", '{"type":"module"}\n');
  const pkg = write("pkg/main.js", 'export const kind = "esm-pkg";\n');
  assert.strictEqual((await import(pkg)).kind, "esm-pkg");

  /* JSON is loadable through both loaders. */
  const json = write("data.json", '{"value": 7}\n');
  assert.strictEqual(require(json).value, 7);
  const jsonNs = await import(json);
  assert.strictEqual(jsonNs.default.value, 7);
  assert.strictEqual(jsonNs.value, 7);
}

main().then(() => {
  cleanup();
  console.log("module_loader: all tests passed");
  process.exit(0);
}, (err) => {
  cleanup();
  console.error(err && err.stack || err);
  process.exit(1);
});
