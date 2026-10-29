/* Concurrent TLS use from worker threads. Run with qnode, not qjs. */
"use strict";

const assert = require("assert");
const tls = require("tls");
const { Worker } = require("worker_threads");

/* Self-signed EC certificate for localhost/127.0.0.1. Embedding it keeps the
   test independent of openssl and of the working directory. */
const cert = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUVfEXiY+ph77/fo/bugKPjxkoe9IwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyOTE0NDcwMFoYDzIxMjYxMDA1
MTQ0NzAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQqFgwn6fWkM4MvbDCfgaOXgX5VeJvX9gYtHfIV4t78hLtBh8dXlwee
4DjC5auPTNkKWrS9umb75Papez9k2WT8o28wbTAdBgNVHQ4EFgQUvaEZ9R9Jgz9S
sMotONaTRNOFWT4wHwYDVR0jBBgwFoAUvaEZ9R9Jgz9SsMotONaTRNOFWT4wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgFVNM/qFyxJqParQpyjIQa9ETbp6oX7Z9iQfkC9kYWqoCIAeb
282pmwXTZ8I1rF+3cxJl842PdAni8nZDSTz9paDK
-----END CERTIFICATE-----
`;

const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRJVK8I4H6dS50Pkp
mI7C0kbMJGy2mdnhKQSrqjyzPqChRANCAAQqFgwn6fWkM4MvbDCfgaOXgX5VeJvX
9gYtHfIV4t78hLtBh8dXlwee4DjC5auPTNkKWrS9umb75Papez9k2WT8
-----END PRIVATE KEY-----
`;

/* Each worker creates its own server context and connections, then talks to
   both its own server and the main thread's server. Distinct workers doing
   this at the same time exercises per-thread context/connection registries
   and RNG state. */
const workerSource = `
"use strict";
const tls = require("node:tls");
const { parentPort, workerData } = require("node:worker_threads");
const { cert, key, id, mainPort, rounds } = workerData;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", netstack: false }, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function echoRound(port, payload) {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      netstack: false,
      ca: cert,
      servername: "localhost",
    }, () => socket.write(payload));
    socket.on("data", (buf) => {
      data += buf.toString();
      if (data.length >= payload.length) {
        socket.end();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
}

(async () => {
  /* Register before doing any work: the main thread may send "finish" as soon
     as it has seen the listening message. */
  const finish = new Promise((resolve) => parentPort.once("message", resolve));
  const server = tls.createServer({ cert, key }, (socket) => {
    socket.on("data", (buf) => socket.write(buf));
  });
  const port = await listen(server);
  parentPort.postMessage({ phase: "listening", id, port });

  for (let i = 0; i < rounds; i++) {
    const payload = "worker-" + id + "-" + i;
    assertEcho(await echoRound(port, payload), payload);
    assertEcho(await echoRound(mainPort, payload), payload);
  }

  /* Keep the server open until the main thread has connected to it. The
     process exit hook still runs the TLS cleanup path. */
  await finish;
  parentPort.postMessage({ ok: true, id });
  process.exit(0);
})().catch((e) => {
  parentPort.postMessage({ ok: false, id, error: String(e && e.stack || e) });
});

function assertEcho(got, want) {
  if (got !== want)
    throw new Error("bad echo from worker " + id + ": " + got);
}
`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", netstack: false }, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function echoRound(port, payload) {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      netstack: false,
      ca: cert,
      servername: "localhost",
    }, () => socket.write(payload));
    socket.on("data", (buf) => {
      data += buf.toString();
      if (data.length >= payload.length) {
        socket.end();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
}

function waitEvent(emitter, name, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for '" + name + "'"));
    }, ms || 10000);
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

async function testWorkerTLS() {
  const workers = [];
  const mainServer = tls.createServer({ cert, key }, (socket) => {
    socket.on("data", (buf) => socket.write(buf));
  });

  try {
    const mainPort = await listen(mainServer);
    const jobs = [];

    for (let i = 0; i < 3; i++) {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { id: i, cert, key, mainPort, rounds: 3 },
      });
      workers.push(worker);
      jobs.push({
        worker,
        listening: waitEvent(worker, "message"),
        exit: waitEvent(worker, "exit"),
      });
    }

    /* Wait until every worker has its own server up, then connect to each of
       them from the main thread while the workers are also connecting out. */
    const ports = await Promise.all(jobs.map(async (job) => {
      const [message] = await job.listening;
      assert.strictEqual(message.phase, "listening");
      return message.port;
    }));
    const echoes = await Promise.all(ports.map((port, i) =>
      echoRound(port, "main-" + i)));
    for (let i = 0; i < echoes.length; i++)
      assert.strictEqual(echoes[i], "main-" + i);

    /* Release the worker servers, then collect their results. */
    const results = jobs.map((job) => waitEvent(job.worker, "message"));
    for (const job of jobs)
      job.worker.postMessage("finish");
    for (let i = 0; i < jobs.length; i++) {
      const [message] = await results[i];
      if (!message.ok)
        throw new Error("worker " + i + " failed: " + message.error);
      assert.strictEqual(message.id, i);
    }
    for (const job of jobs)
      assert.strictEqual((await job.exit)[0], 0);
  } finally {
    for (const worker of workers)
      worker.terminate();
    await close(mainServer);
  }
}

testWorkerTLS().then(() => {
  console.log("tls_workers: all tests passed");
  process.exit(0);
}, (err) => {
  console.error("tls_workers failed:", err && err.name, err && err.message);
  console.error(err && err.stack || err);
  process.exit(1);
});
