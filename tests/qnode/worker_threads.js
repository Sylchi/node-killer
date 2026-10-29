/* worker_threads integration tests. Run with qnode, not qjs. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  Worker,
  isMainThread,
  threadId,
  workerData,
  setEnvironmentData,
  getEnvironmentData,
  MessageChannel,
  receiveMessageOnPort,
} = require("worker_threads");

const tmp = path.join(os.tmpdir(),
                      "qnode-worker-" + process.pid + "-" + Date.now());
fs.mkdirSync(tmp);
const childFiles = [];

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  for (const file of childFiles) {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

function waitEvent(emitter, name, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for '" + name + "'"));
    }, ms || 8000);
    const onEvent = (...args) => {
      clearTimeout(timer);
      emitter.removeListener(name, onEvent);
      emitter.removeListener("error", onError);
      resolve(args);
    };
    const onError = (err) => {
      /* A worker error is followed by an exit event, so an exit waiter must
         not reject just because the worker reported an error first. */
      if (name === "error" || name === "exit")
        return;
      clearTimeout(timer);
      emitter.removeListener(name, onEvent);
      emitter.removeListener("error", onError);
      reject(err);
    };
    emitter.once(name, onEvent);
    emitter.on("error", onError);
  });
}

async function testEvalWorkerDataAndMessages() {
  const worker = new Worker(`
    const { parentPort, workerData, isMainThread, threadId } =
      require("node:worker_threads");
    parentPort.on("message", (value) => {
      parentPort.postMessage({
        value,
        data: workerData,
        isMainThread,
        threadId,
      });
      process.exit(0);
    });
  `, { eval: true, workerData: { n: 7 }, argv: ["--child"] });

  const exit = waitEvent(worker, "exit");
  worker.postMessage({ x: 1 });
  const [message] = await waitEvent(worker, "message");
  assert.deepStrictEqual(message.value, { x: 1 });
  assert.deepStrictEqual(message.data, { n: 7 });
  assert.strictEqual(message.isMainThread, false);
  assert.strictEqual(message.threadId, worker.threadId);
  assert.strictEqual((await exit)[0], 0);
}

async function testFileWorkerAndExitCode() {
  const file = path.join(tmp, "file-worker.js");
  fs.writeFileSync(file, `
    const { parentPort, workerData } = require("worker_threads");
    parentPort.postMessage({ file: true, data: workerData });
    process.exit(4);
  `);
  childFiles.push(file);

  const worker = new Worker(file, { workerData: { ok: true } });
  const exit = waitEvent(worker, "exit");
  const [message] = await waitEvent(worker, "message");
  assert.deepStrictEqual(message, { file: true, data: { ok: true } });
  assert.strictEqual((await exit)[0], 4);
}

async function testEsmWorker() {
  const file = path.join(tmp, "esm-worker.mjs");
  fs.writeFileSync(file, `
    import { parentPort, workerData } from "worker_threads";
    parentPort.postMessage({ esm: true, n: workerData.n });
    process.exit(0);
  `);
  childFiles.push(file);

  const worker = new Worker(file, { workerData: { n: 9 } });
  const exit = waitEvent(worker, "exit");
  const [message] = await waitEvent(worker, "message");
  assert.deepStrictEqual(message, { esm: true, n: 9 });
  assert.strictEqual((await exit)[0], 0);
}

async function testErrorPropagation() {
  const worker = new Worker('throw new Error("worker boom");', { eval: true });
  const error = waitEvent(worker, "error");
  const exit = waitEvent(worker, "exit");
  const [err] = await error;
  assert.strictEqual(err.name, "Error");
  assert.strictEqual(err.message, "worker boom");
  assert.strictEqual((await exit)[0], 1);
}

async function testTerminate() {
  const worker = new Worker(`
    const { parentPort } = require("worker_threads");
    parentPort.on("message", () => {});
  `, { eval: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const exit = waitEvent(worker, "exit");
  const code = await worker.terminate();
  assert.strictEqual(typeof code, "number");
  assert.strictEqual((await exit)[0], code);
}

async function testSharedArrayBuffer() {
  const sab = new SharedArrayBuffer(8);
  const worker = new Worker(`
    const { parentPort, workerData } = require("worker_threads");
    const view = new Uint8Array(workerData.sab);
    view[0] = 99;
    parentPort.postMessage({ shared: workerData.sab instanceof SharedArrayBuffer });
    process.exit(0);
  `, { eval: true, workerData: { sab } });
  const exit = waitEvent(worker, "exit");
  const [message] = await waitEvent(worker, "message");
  assert.deepStrictEqual(message, { shared: true });
  assert.strictEqual(new Uint8Array(sab)[0], 99);
  assert.strictEqual((await exit)[0], 0);
}

async function testMultipleWorkers() {
  const workers = [];
  const exits = [];
  const results = new Map();
  for (let i = 0; i < 3; i++) {
    const worker = new Worker(`
      const { parentPort, workerData, threadId } = require("worker_threads");
      parentPort.postMessage({ id: workerData.id, threadId });
      process.exit(0);
    `, { eval: true, workerData: { id: i } });
    workers.push(worker);
    exits.push(waitEvent(worker, "exit"));
    const message = waitEvent(worker, "message");
    message.then(([value]) => results.set(value.id, value.threadId));
  }
  for (const exit of exits)
    assert.strictEqual((await exit)[0], 0);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(typeof results.get(i), "number");
    assert.ok(results.get(i) > 0);
  }
  assert.strictEqual(new Set(results.values()).size, 3);
  assert.strictEqual(new Set(workers.map((w) => w.threadId)).size, 3);
}

async function testProcessArgvAndEnvironment() {
  setEnvironmentData("qnode-worker-test", { value: 123 });
  const worker = new Worker(`
    const { parentPort } = require("worker_threads");
    parentPort.postMessage({
      argv: process.argv,
      env: require("worker_threads").getEnvironmentData("qnode-worker-test"),
    });
    process.exit(0);
  `, { eval: true, argv: ["--x"] });
  const exit = waitEvent(worker, "exit");
  const [message] = await waitEvent(worker, "message");
  assert.strictEqual(message.argv[0], process.execPath);
  assert.deepStrictEqual(message.argv.slice(2), ["--x"]);
  assert.deepStrictEqual(message.env, { value: 123 });
  assert.strictEqual((await exit)[0], 0);
  assert.deepStrictEqual(getEnvironmentData("qnode-worker-test"), { value: 123 });
}

async function testNaturalExit() {
  const worker = new Worker("setTimeout(() => {}, 1);", { eval: true });
  assert.strictEqual((await waitEvent(worker, "exit"))[0], 0);
}

function testInProcessChannel() {
  const channel = new MessageChannel();
  const result = receiveMessageOnPort(channel.port1);
  assert.strictEqual(result, undefined);
  channel.port2.postMessage({ hello: "world" });
  assert.deepStrictEqual(receiveMessageOnPort(channel.port1),
                         { message: { hello: "world" } });
  channel.port1.close();
  channel.port2.close();
}

async function main() {
  assert.strictEqual(isMainThread, true);
  assert.strictEqual(threadId, 0);
  assert.strictEqual(workerData, undefined);

  testInProcessChannel();
  const tests = [
    testEvalWorkerDataAndMessages,
    testFileWorkerAndExitCode,
    testEsmWorker,
    testErrorPropagation,
    testTerminate,
    testSharedArrayBuffer,
    testMultipleWorkers,
    testProcessArgvAndEnvironment,
    testNaturalExit,
  ];
  for (const test of tests) {
    if (process.env.QNODE_TEST_VERBOSE)
      console.error("worker test:", test.name);
    await test();
  }
  console.log("worker_threads: all tests passed");
}

main().then(() => {
  cleanup();
  process.exit(0);
}, (err) => {
  cleanup();
  console.error(err && err.stack || err);
  process.exit(1);
});
