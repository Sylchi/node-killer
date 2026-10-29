/* Streaming fetch and WHATWG body types. Run with qnode, not qjs. */
"use strict";

const assert = require("assert");
const http = require("http");
const net = require("net");
const zlib = require("zlib");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(sock, text) {
  const buf = typeof text === "string" ? Buffer.from(text, "latin1") : Buffer.from(text);
  sock.write(buf.length.toString(16) + "\r\n");
  sock.write(buf);
  sock.write("\r\n");
}

/* Raw HTTP server: the qnode http server buffers writes until end(), so use
   a raw socket here to exercise incremental delivery. */
function startStreamServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (data) => {
        buf += data.toString("latin1");
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0)
          return;
        const path = buf.slice(0, buf.indexOf("\r\n")).split(" ")[1];
        buf = "";
        if (path === "/plain") {
          sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n" +
                     "transfer-encoding: chunked\r\nconnection: close\r\n\r\n");
          chunk(sock, "first\n");
          setTimeout(() => chunk(sock, "second\n"), 150);
          setTimeout(() => { sock.write("0\r\n\r\n"); sock.end(); }, 260);
        } else if (path === "/gzip") {
          const first = Buffer.from("gzip-first\n".repeat(40));
          const second = Buffer.from("gzip-second\n".repeat(40));
          const gz = zlib.gzipSync(Buffer.concat([first, second]));
          const cut = Math.floor(gz.length * 0.6);
          sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n" +
                     "content-encoding: gzip\r\ntransfer-encoding: chunked\r\n" +
                     "connection: close\r\n\r\n");
          chunk(sock, gz.subarray(0, cut).toString("latin1"));
          setTimeout(() => chunk(sock, gz.subarray(cut).toString("latin1")), 150);
          setTimeout(() => { sock.write("0\r\n\r\n"); sock.end(); }, 260);
        } else if (path === "/head") {
          sock.write("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n" +
                     "content-type: text/plain\r\nconnection: close\r\n\r\n");
          sock.end();
        } else if (path === "/abort") {
          sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n" +
                     "transfer-encoding: chunked\r\nconnection: close\r\n\r\n");
          chunk(sock, "partial\n");
          /* keep the connection open so the client has to abort */
        } else {
          sock.write("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n" +
                     "connection: close\r\n\r\n");
          sock.end();
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.url === "/json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, method: req.method }));
        } else if (req.url === "/echo") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-transfer-encoding": req.headers["transfer-encoding"] || "",
          });
          res.end(JSON.stringify({
            text: body.toString(),
            len: body.length,
            contentType: req.headers["content-type"] || "",
          }));
        } else if (req.url === "/form") {
          res.writeHead(200, {
            "content-type": req.headers["content-type"] || "",
          });
          res.end(body);
        } else if (req.url === "/redirect") {
          res.writeHead(302, { location: "/json" });
          res.end();
        } else if (req.url === "/redirect303") {
          res.writeHead(303, { location: "/json" });
          res.end();
        } else {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("missing");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function testBlobAndFile() {
  const blob = new Blob(["hello ", new Uint8Array([119, 111, 114, 108, 100])],
                        { type: "TEXT/PLAIN" });
  assert.strictEqual(blob.size, 11);
  assert.strictEqual(blob.type, "text/plain");
  assert.strictEqual(await blob.text(), "hello world");
  assert.deepStrictEqual(Array.from(await blob.bytes()),
                         Array.from(Buffer.from("hello world")));
  assert.strictEqual(await new Response(blob.stream()).text(), "hello world");

  const sliced = blob.slice(6);
  assert.strictEqual(await sliced.text(), "world");
  assert.strictEqual(sliced.type, "");
  assert.strictEqual(await blob.slice(-5).text(), "world");
  assert.strictEqual(blob.slice(2, 2).size, 0);

  const file = new File(["abc"], "a.txt",
                        { type: "text/plain", lastModified: 1234 });
  assert.ok(file instanceof Blob);
  assert.strictEqual(file.name, "a.txt");
  assert.strictEqual(file.lastModified, 1234);
  assert.strictEqual(await file.text(), "abc");
  assert.strictEqual(file.type, "text/plain");

  const ex = new DOMException("boom", "AbortError");
  assert.ok(ex instanceof Error);
  assert.strictEqual(ex.name, "AbortError");
  assert.strictEqual(ex.code, 20);
  assert.strictEqual(DOMException.ABORT_ERR, 20);
}

async function testFormData() {
  const fd = new FormData();
  fd.append("a", "1");
  fd.append("a", "2");
  fd.append("file", new File(["body"], "x.txt", { type: "text/plain" }));
  assert.strictEqual(fd.get("a"), "1");
  assert.deepStrictEqual(fd.getAll("a"), ["1", "2"]);
  assert.ok(fd.has("file"));
  fd.set("a", "3");
  assert.deepStrictEqual(fd.getAll("a"), ["3"]);
  fd.delete("a");
  assert.strictEqual(fd.has("a"), false);
  assert.deepStrictEqual([...fd.keys()], ["file"]);
  assert.strictEqual(fd.get("file").name, "x.txt");

  const withName = new FormData();
  withName.append("f", new Blob(["x"]), "renamed.bin");
  assert.ok(withName.get("f") instanceof File);
  assert.strictEqual(withName.get("f").name, "renamed.bin");
}

async function testResponseBody() {
  const res = new Response("abcdef", {
    status: 201,
    headers: { "content-type": "text/plain" },
  });
  assert.strictEqual(res.status, 201);
  assert.ok(res.ok);
  assert.strictEqual(res.bodyUsed, false);
  assert.ok(res.body instanceof ReadableStream);
  assert.strictEqual(await res.text(), "abcdef");
  assert.strictEqual(res.bodyUsed, true);
  await assert.rejects(res.text(), /unusable/);

  const json = new Response('{"a":1}');
  assert.deepStrictEqual(await json.json(), { a: 1 });

  const bytes = new Response(new Uint8Array([1, 2, 3]));
  assert.deepStrictEqual(Array.from(await bytes.bytes()), [1, 2, 3]);

  const blob = new Response("hello", {
    headers: { "content-type": "text/plain" },
  });
  const out = await blob.blob();
  assert.ok(out instanceof Blob);
  assert.strictEqual(out.type, "text/plain");
  assert.strictEqual(await out.text(), "hello");

  const original = new Response("shared");
  const copy = original.clone();
  assert.strictEqual(await original.text(), "shared");
  assert.strictEqual(await copy.text(), "shared");

  const empty = new Response(null, { status: 204 });
  assert.strictEqual(empty.body, null);
  assert.strictEqual(await empty.text(), "");
}

async function testConsumers() {
  const consumers = require("stream/consumers");
  const buffer = require("buffer");
  assert.strictEqual(buffer.Blob, Blob);
  assert.strictEqual(buffer.File, File);

  assert.strictEqual(await consumers.text(new Response("hello")), "hello");
  assert.deepStrictEqual(await consumers.json(new Response('{"a":1}')),
                         { a: 1 });

  const buf = await consumers.buffer(new Response(new Uint8Array([1, 2, 3])));
  assert.ok(Buffer.isBuffer(buf));
  assert.deepStrictEqual(Array.from(buf), [1, 2, 3]);

  const ab = await consumers.arrayBuffer(new Blob(["xyz"]));
  assert.deepStrictEqual(Array.from(new Uint8Array(ab)), [120, 121, 122]);

  const blob = await consumers.blob(new Response("hi", {
    headers: { "content-type": "text/plain" },
  }));
  assert.ok(blob instanceof Blob);
  assert.strictEqual(blob.type, "text/plain");
  assert.strictEqual(await blob.text(), "hi");

  const stream = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from("a"));
      c.enqueue(Buffer.from("b"));
      c.close();
    },
  });
  assert.strictEqual(await consumers.text(stream), "ab");
  assert.strictEqual(await consumers.buffer("nope").catch((e) => e.name),
                     "TypeError");
}

async function testRequest() {
  const req = new Request("http://example.test/x", {
    method: "post",
    body: "payload",
    headers: { "x-a": "1" },
  });
  assert.strictEqual(req.method, "POST");
  assert.strictEqual(req.headers.get("x-a"), "1");
  assert.strictEqual(req.headers.get("content-type"),
                     "text/plain;charset=UTF-8");
  assert.strictEqual(await req.text(), "payload");

  assert.throws(() => new Request("http://example.test/", {
    method: "GET", body: "nope",
  }), /cannot have body/);

  await assert.rejects(fetch("http://127.0.0.1:1/", {
    method: "POST",
    body: new ReadableStream({ start(c) { c.close(); } }),
  }), /duplex/);
}

async function testStreamingResponse(base) {
  const t0 = Date.now();
  const res = await fetch(base + "/plain");
  assert.strictEqual(res.status, 200);
  assert.ok(res.body instanceof ReadableStream);
  const reader = res.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now() - t0;
  assert.strictEqual(Buffer.from(first.value).toString(), "first\n");
  let text = "";
  for (;;) {
    const part = await reader.read();
    if (part.done)
      break;
    text += Buffer.from(part.value).toString();
  }
  const total = Date.now() - t0;
  assert.strictEqual(text, "second\n");
  assert.ok(firstAt < total - 60,
            "first chunk should arrive before the body completes (" +
            firstAt + "ms vs " + total + "ms)");
  assert.strictEqual(res.bodyUsed, true);
}

async function testStreamingGzip(base) {
  const t0 = Date.now();
  const res = await fetch(base + "/gzip");
  const reader = res.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now() - t0;
  assert.ok(!first.done);
  let text = Buffer.from(first.value).toString();
  for (;;) {
    const part = await reader.read();
    if (part.done)
      break;
    text += Buffer.from(part.value).toString();
  }
  const total = Date.now() - t0;
  assert.strictEqual(text, "gzip-first\n".repeat(40) + "gzip-second\n".repeat(40));
  assert.ok(firstAt < total - 60,
            "inflated output should stream (" + firstAt + "ms vs " +
            total + "ms)");
}

async function testStreamingUpload(base) {
  let step = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (step === 0) {
        step = 1;
        controller.enqueue(Buffer.from("abc"));
      } else if (step === 1) {
        step = 2;
        return new Promise((resolve) => {
          setTimeout(() => {
            controller.enqueue(Buffer.from("def"));
            controller.close();
            resolve();
          }, 20);
        });
      }
    },
  });
  const res = await fetch(base + "/echo", {
    method: "POST", body, duplex: "half",
  });
  assert.strictEqual(res.headers.get("x-transfer-encoding"), "chunked");
  const out = await res.json();
  assert.strictEqual(out.text, "abcdef");
  assert.strictEqual(out.len, 6);

  const params = await (await fetch(base + "/echo", {
    method: "POST", body: new URLSearchParams({ a: "1", b: "two" }),
  })).json();
  assert.strictEqual(params.text, "a=1&b=two");
  assert.match(params.contentType, /application\/x-www-form-urlencoded/);
}

async function testMultipart(base) {
  const fd = new FormData();
  fd.append("name", "qnode");
  fd.append("file", new File(["file-body"], "a.txt", { type: "text/plain" }));
  const res = await fetch(base + "/form", { method: "POST", body: fd });
  assert.match(res.headers.get("content-type"), /multipart\/form-data/);
  const out = await res.formData();
  assert.strictEqual(out.get("name"), "qnode");
  const file = out.get("file");
  assert.ok(file instanceof File);
  assert.strictEqual(file.name, "a.txt");
  assert.strictEqual(file.type, "text/plain");
  assert.strictEqual(await file.text(), "file-body");
}

async function testRedirects(base) {
  const followed = await fetch(base + "/redirect");
  assert.strictEqual(followed.status, 200);
  assert.strictEqual(followed.redirected, true);
  assert.deepStrictEqual(await followed.json(), { ok: true, method: "GET" });

  const manual = await fetch(base + "/redirect", { redirect: "manual" });
  assert.strictEqual(manual.status, 302);
  assert.strictEqual(manual.redirected, false);

  const post = await fetch(base + "/redirect303", {
    method: "POST", body: "data",
  });
  assert.strictEqual(post.status, 200);
  assert.strictEqual((await post.json()).method, "GET");
}

async function testHead(base) {
  const res = await fetch(base + "/head", { method: "HEAD" });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, null);
  assert.strictEqual(await res.text(), "");
}

async function testAbort(base) {
  const controller = new AbortController();
  const res = await fetch(base + "/abort", { signal: controller.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.strictEqual(Buffer.from(first.value).toString(), "partial\n");
  controller.abort();
  await assert.rejects(reader.read(), (err) =>
    err && (err.name === "AbortError" || /abort/i.test(err.message)));

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(fetch(base + "/plain", { signal: pre.signal }),
                       (err) => err && /abort/i.test(err.message || err.name));
}

async function main() {
  const streamServer = await startStreamServer();
  const httpServer = await startHttpServer();
  const streamBase = "http://127.0.0.1:" + streamServer.address().port;
  const base = "http://127.0.0.1:" + httpServer.address().port;

  const tests = [
    testBlobAndFile,
    testFormData,
    testResponseBody,
    testConsumers,
    testRequest,
    () => testStreamingResponse(streamBase),
    () => testStreamingGzip(streamBase),
    () => testStreamingUpload(base),
    () => testMultipart(base),
    () => testRedirects(base),
    () => testHead(streamBase),
    () => testAbort(streamBase),
  ];
  try {
    for (const test of tests) {
      if (process.env.QNODE_TEST_VERBOSE)
        console.error("fetch test:", test.name);
      await test();
    }
  } finally {
    httpServer.close();
    streamServer.close();
  }
  console.log("fetch_web: all tests passed");
}

main().then(() => process.exit(0), (err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
