# Worker threads

Status: implemented on top of the quickjs-ng `qjs:os` pthread worker.
Each worker gets a fresh `JSRuntime` and runs the qnode bootstrap before it
imports the user script, so `require`, `process`, timers and the builtin
modules behave as they do in the main thread.

## Supported API

```js
const { Worker, parentPort, workerData, threadId, isMainThread } =
  require("node:worker_threads");

if (isMainThread) {
  const worker = new Worker("./child.js", {
    workerData: { n: 42 },
    argv: ["--child"],
  });
  worker.on("message", (msg) => console.log(msg));
  worker.on("error", (err) => console.error(err));
  worker.on("exit", (code) => console.log("exit", code));
  worker.postMessage("hello");
} else {
  parentPort.on("message", (msg) => {
    parentPort.postMessage({ msg, workerData, threadId });
    process.exit(0);
  });
}
```

- `new Worker(filename, options)` loads a CommonJS, ESM or JSON file.
  Relative paths are resolved against the current working directory.
- `new Worker(source, { eval: true })` evaluates `source` in the worker.
- `workerData` is structured-cloned through the worker startup value, so
  objects, typed arrays and `SharedArrayBuffer` values are supported.
- `argv` becomes `process.argv.slice(2)` in the worker.
- `process.exit(code)` stops the worker with `code`; it never exits the
  main process. Uncaught errors and unhandled rejections are reported to
  the parent as an `error` event followed by `exit`.
- `worker.terminate()` asks a running worker to exit and resolves with its
  exit code.
- `getEnvironmentData()` / `setEnvironmentData()` are copied into the
  worker at startup.

## Limits

- Workers cannot create nested workers.
- `terminate()` is cooperative: it is delivered as a message, so a worker
  that never returns to its event loop cannot be interrupted.
- `transferList` is accepted but ignored. `MessageChannel` and
  `receiveMessageOnPort` only work in-process; ports cannot be sent to a
  worker.
- `stdout`, `stderr`, `stdin`, `resourceLimits` and `execArgv` are not
  implemented.
- Control messages use the reserved object key `__qnodeWorkerControl`.
  User messages should not contain that key at the top level.
