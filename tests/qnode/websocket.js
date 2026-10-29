/* WebSocket client/server tests. Run with qnode, not qjs. */
"use strict";

const assert = require("assert");
const http = require("http");
const net = require("net");
const { WebSocket, WebSocketServer } = require("node:websocket");

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server)
      return resolve();
    server.close(() => resolve());
  });
}

function closeWSS(wss) {
  return new Promise((resolve) => wss.close(resolve));
}

function onceEvent(target, type) {
  return new Promise((resolve) => {
    target.addEventListener(type, (event) => resolve(event), { once: true });
  });
}

function onceNode(emitter, type) {
  return new Promise((resolve) => {
    emitter.once(type, (...args) => resolve(args));
  });
}

function nextMessage(ws) {
  return onceEvent(ws, "message");
}

async function testHttpUpgrade() {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end("not a websocket");
  });
  const wss = new WebSocketServer({ server, protocols: ["chat"] });
  let serverWs = null;
  const serverMessages = [];
  wss.on("connection", (ws, req) => {
    serverWs = ws;
    assert.equal(req.headers.upgrade.toLowerCase(), "websocket");
    ws.on("message", (data, isBinary) => {
      serverMessages.push({ data, isBinary });
      if (isBinary)
        ws.send(data);
      else
        ws.send("echo:" + data);
    });
  });

  await listen(server, { port: 0, host: "127.0.0.1" });
  const port = server.address().port;
  const client = new WebSocket("ws://127.0.0.1:" + port + "/chat",
                               ["chat", "other"]);
  try {
    const open = await onceEvent(client, "open");
    assert.equal(open.type, "open");
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.equal(client.protocol, "chat");
    assert.equal(client.extensions, "");
    assert.ok(client.url.endsWith("/chat"));

    let pending = nextMessage(client);
    client.send("hello");
    let event = await pending;
    assert.ok(event instanceof MessageEvent);
    assert.equal(event.data, "echo:hello");
    assert.equal(serverMessages[0].isBinary, false);

    client.binaryType = "nodebuffer";
    pending = nextMessage(client);
    client.send(Buffer.from([1, 2, 3, 4]));
    event = await pending;
    assert.ok(Buffer.isBuffer(event.data));
    assert.deepEqual(Array.from(event.data), [1, 2, 3, 4]);
    assert.equal(serverMessages[1].isBinary, true);

    client.binaryType = "arraybuffer";
    pending = nextMessage(client);
    client.send(new Uint8Array([9, 8, 7]));
    event = await pending;
    assert.ok(event.data instanceof ArrayBuffer);
    assert.deepEqual(Array.from(new Uint8Array(event.data)), [9, 8, 7]);

    client.binaryType = "nodebuffer";
    pending = nextMessage(client);
    client.send(new Blob(["blob-data"]));
    event = await pending;
    assert.equal(event.data.toString(), "blob-data");

    const pong = onceEvent(client, "pong");
    client.ping("heartbeat");
    assert.equal((await pong).data.toString(), "heartbeat");

    const ping = onceEvent(client, "ping");
    const serverPong = new Promise((resolve) =>
      serverWs.once("pong", (data) => resolve(data)));
    serverWs.ping("server-ping");
    assert.equal((await ping).data.toString(), "server-ping");
    assert.equal((await serverPong).toString(), "server-ping");

    pending = nextMessage(client);
    client._sendFrame(1, Buffer.from("frag-"), false);
    client._sendFrame(0, Buffer.from("mented"), true);
    event = await pending;
    assert.equal(event.data, "echo:frag-mented");

    const closed = onceEvent(client, "close");
    client.close(4000, "bye");
    const closeEvent = await closed;
    assert.equal(closeEvent.code, 4000);
    assert.equal(closeEvent.reason, "bye");
    assert.equal(closeEvent.wasClean, true);
    assert.equal(client.readyState, WebSocket.CLOSED);
    assert.equal(client.bufferedAmount, 0);
    assert.equal(serverWs.readyState, WebSocket.CLOSED);
  } finally {
    client.terminate();
    await closeWSS(wss);
    await closeServer(server);
  }
}

async function testStandaloneServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send("standalone:" + data));
  });
  try {
    await onceNode(wss, "listening");
    const port = wss.address().port;
    const client = new WebSocket("ws://127.0.0.1:" + port + "/");
    try {
      await onceEvent(client, "open");
      const pending = nextMessage(client);
      client.send("one");
      assert.equal((await pending).data, "standalone:one");
      const closed = onceEvent(client, "close");
      client.close(1000, "done");
      assert.equal((await closed).code, 1000);
    } finally {
      client.terminate();
    }
  } finally {
    await closeWSS(wss);
  }
}

async function testNetServerAttach() {
  const server = net.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send("net:" + data));
  });
  await listen(server, { port: 0, host: "127.0.0.1" });
  const client = new WebSocket(
    "ws://127.0.0.1:" + server.address().port + "/raw");
  try {
    await onceEvent(client, "open");
    const pending = nextMessage(client);
    client.send("raw");
    assert.equal((await pending).data, "net:raw");
    const closed = onceEvent(client, "close");
    client.close(1000);
    await closed;
  } finally {
    client.terminate();
    await closeWSS(wss);
    await closeServer(server);
  }
}

async function testNoServerUpgrade() {
  const server = http.createServer((req, res) => res.end());
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send("manual:" + data));
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head,
      (ws) => wss.emit("connection", ws, req));
  });
  await listen(server, { port: 0, host: "127.0.0.1" });
  const client = new WebSocket(
    "ws://127.0.0.1:" + server.address().port + "/manual");
  try {
    await onceEvent(client, "open");
    const pending = nextMessage(client);
    client.send("upgrade");
    assert.equal((await pending).data, "manual:upgrade");
    const closed = onceEvent(client, "close");
    client.close(1000);
    await closed;
  } finally {
    client.terminate();
    await closeWSS(wss);
    await closeServer(server);
  }
}

async function testHandshakeFailure() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("plain http");
  });
  await listen(server, { port: 0, host: "127.0.0.1" });
  const client = new WebSocket(
    "ws://127.0.0.1:" + server.address().port + "/");
  const order = [];
  try {
    const closed = new Promise((resolve) => {
      client.addEventListener("error", () => order.push("error"));
      client.addEventListener("close", (event) => {
        order.push("close");
        resolve(event);
      });
    });
    const event = await closed;
    assert.deepEqual(order, ["error", "close"]);
    assert.equal(event.wasClean, false);
    assert.equal(event.code, 1006);
  } finally {
    client.terminate();
    await closeServer(server);
  }
}

async function main() {
  await testHttpUpgrade();
  await testStandaloneServer();
  await testNetServerAttach();
  await testNoServerUpgrade();
  await testHandshakeFailure();
  console.log("websocket: ok");
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
