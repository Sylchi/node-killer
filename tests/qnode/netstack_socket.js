/* Owned TCP stack (netstack) integration tests. Run with qnode, not qjs.
 *
 * These exercise the node:net path end to end: AF_INET and AF_INET6 sockets
 * inside the managed prefixes are handed out as eventfd-backed virtual
 * descriptors and served by the in-process TCP engine. Everything happens in
 * one process, so the loopback link needs no TUN device or privileges. */
"use strict";

const assert = require("assert");
const net = require("net");

const info = net.netstackInfo();
if (!info.enabled) {
  console.log("netstack_socket: skipped (netstack unavailable)");
  process.exit(0);
}
const ADDR = info.address;
const ADDR4 = info.address4;

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

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.removeListener("error", reject);
      resolve(server.address());
    });
  });
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(options);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

function readAll(sock) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    sock.on("data", (d) => chunks.push(Buffer.from(d)));
    sock.on("end", () => resolve(Buffer.concat(chunks)));
    sock.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  ok("netstack reports IPv6 and IPv4 addresses", () => {
    assert.strictEqual(typeof ADDR, "string");
    assert.ok(ADDR.indexOf(":") >= 0, "expected an IPv6 address");
    assert.strictEqual(typeof ADDR4, "string");
    assert.ok(ADDR4.indexOf(".") >= 0, "expected an IPv4 address");
  });

  /* 1. Plain echo over the owned stack. */
  {
    const server = net.createServer({ netstack: true }, (sock) => {
      sock.on("data", (d) => sock.write(d));
    });
    const addr = await listen(server, { port: 0, host: ADDR, netstack: true,
                                       family: 6 });
    ok("listen() reports the netstack address", () => {
      assert.strictEqual(addr.address, ADDR);
      assert.ok(addr.port > 0);
    });

    const sock = await connect({ port: addr.port, host: ADDR,
                                 netstack: true, family: 6 });
    ok("client sees a local netstack address", () => {
      assert.strictEqual(sock.localAddress, ADDR);
      assert.strictEqual(sock.remoteAddress, ADDR);
      assert.strictEqual(sock.remotePort, addr.port);
    });

    const echoed = readAll(sock);
    sock.write("hello owned tcp");
    sock.end();
    const data = await echoed;
    ok("echo round-trip", () => {
      assert.strictEqual(data.toString(), "hello owned tcp");
    });
    await closeServer(server);
  }

  /* 1b. Plain IPv4 echo over the owned stack. */
  {
    const server = net.createServer({ netstack: true }, (sock) => {
      sock.on("data", (d) => sock.write(d));
    });
    const addr = await listen(server, { port: 0, host: ADDR4,
                                       netstack: true, family: 4 });
    ok("IPv4 listen() reports the netstack address", () => {
      assert.strictEqual(addr.address, ADDR4);
      assert.strictEqual(addr.family, "IPv4");
      assert.ok(addr.port > 0);
    });

    const sock = await connect({ port: addr.port, host: ADDR4,
                                 netstack: true, family: 4 });
    ok("IPv4 client sees netstack addresses", () => {
      assert.strictEqual(sock.localAddress, ADDR4);
      assert.strictEqual(sock.remoteAddress, ADDR4);
      assert.strictEqual(sock.remotePort, addr.port);
    });

    const echoed = readAll(sock);
    sock.write("hello owned ipv4");
    sock.end();
    const data = await echoed;
    ok("IPv4 echo round-trip", () => {
      assert.strictEqual(data.toString(), "hello owned ipv4");
    });
    await closeServer(server);
  }

  /* 2. The address is enough to select netstack without an explicit flag. */
  {
    const server = net.createServer((sock) => {
      sock.on("data", (d) => sock.write("auto:" + d.toString()));
    });
    const addr = await listen(server, { port: 0, host: ADDR, family: 6 });
    const sock = await connect({ port: addr.port, host: ADDR, family: 6 });
    const echoed = readAll(sock);
    sock.end("ping");
    const data = await echoed;
    ok("auto-selects netstack by address", () => {
      assert.strictEqual(data.toString(), "auto:ping");
    });
    await closeServer(server);
  }

  /* 2b. The managed IPv4 address also auto-selects the owned stack. */
  {
    const server = net.createServer((sock) => {
      sock.on("data", (d) => sock.write("auto4:" + d.toString()));
    });
    const addr = await listen(server, { port: 0, host: ADDR4, family: 4 });
    const sock = await connect({ port: addr.port, host: ADDR4, family: 4 });
    const echoed = readAll(sock);
    sock.end("ping");
    const data = await echoed;
    ok("auto-selects netstack by IPv4 address", () => {
      assert.strictEqual(data.toString(), "auto4:ping");
    });
    await closeServer(server);
  }

  /* 3. Concurrent connections each get their own connection state. */
  {
    const server = net.createServer({ netstack: true }, (sock) => {
      let n = 0;
      sock.on("data", (d) => {
        n += d.length;
        if (n >= 5)
          sock.end("got " + n);
      });
    });
    const addr = await listen(server, { port: 0, host: ADDR, netstack: true,
                                       family: 6 });
    const clients = [];
    for (let i = 0; i < 8; i++)
      clients.push(connect({ port: addr.port, host: ADDR, netstack: true,
                             family: 6 }));
    const sockets = await Promise.all(clients);
    const results = sockets.map((s) => {
      const p = readAll(s);
      s.end("12345");
      return p;
    });
    const out = await Promise.all(results);
    ok("8 concurrent connections", () => {
      for (const b of out)
        assert.strictEqual(b.toString(), "got 5");
    });
    await closeServer(server);
  }

  /* 4. Binary data and large writes (multiple MSS segments). */
  {
    const payload = Buffer.alloc(200 * 1024);
    for (let i = 0; i < payload.length; i++)
      payload[i] = i & 0xff;
    let received = Buffer.alloc(0);
    const server = net.createServer({ netstack: true }, (sock) => {
      sock.on("data", (d) => { received = Buffer.concat([received, d]); });
      sock.on("end", () => sock.end());
    });
    const addr = await listen(server, { port: 0, host: ADDR, netstack: true,
                                       family: 6 });
    const sock = await connect({ port: addr.port, host: ADDR,
                                 netstack: true, family: 6 });
    const done = readAll(sock);
    let off = 0;
    await new Promise((resolve, reject) => {
      function pump() {
        if (off >= payload.length) {
          sock.end();
          resolve();
          return;
        }
        const chunk = payload.subarray(off, off + 32768);
        off += chunk.length;
        sock.write(chunk, (err) => err ? reject(err) : pump());
      }
      pump();
    });
    await done;
    ok("200 KiB binary round-trip", () => {
      assert.strictEqual(received.length, payload.length);
      assert.ok(received.equals(payload), "payload mismatch");
    });
    await closeServer(server);
  }

  /* 4b. IPv4 binary data spanning several segments. */
  {
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i++)
      payload[i] = (i * 7 + 3) & 0xff;
    let received = Buffer.alloc(0);
    const server = net.createServer({ netstack: true }, (sock) => {
      sock.on("data", (d) => { received = Buffer.concat([received, d]); });
      sock.on("end", () => sock.end());
    });
    const addr = await listen(server, { port: 0, host: ADDR4,
                                       netstack: true, family: 4 });
    const sock = await connect({ port: addr.port, host: ADDR4,
                                 netstack: true, family: 4 });
    const done = readAll(sock);
    let off = 0;
    await new Promise((resolve, reject) => {
      function pump() {
        if (off >= payload.length) {
          sock.end();
          resolve();
          return;
        }
        const chunk = payload.subarray(off, off + 32768);
        off += chunk.length;
        sock.write(chunk, (err) => err ? reject(err) : pump());
      }
      pump();
    });
    await done;
    ok("IPv4 binary round-trip", () => {
      assert.strictEqual(received.length, payload.length);
      assert.ok(received.equals(payload), "payload mismatch");
    });
    await closeServer(server);
  }

  /* 5. IPv6 addresses outside the managed prefix convert to kernel sockets,
     on both the listener and client side. */
  {
    const server = net.createServer((sock) => sock.end("kernel6"));
    const addr = await listen(server, { port: 0, host: "::1", family: 6 });
    const sock = await connect({ port: addr.port, host: "::1", family: 6 });
    const data = await readAll(sock);
    ok("unmanaged IPv6 falls back to the kernel", () => {
      assert.strictEqual(data.toString(), "kernel6");
    });
    await closeServer(server);
  }

  /* 6. Unmanaged IPv4 remains on kernel sockets, i.e. the fallback still
     works now that AF_INET sockets can also be virtual. */
  {
    const server = net.createServer((sock) => sock.end("kernel"));
    const addr = await listen(server, { port: 0, host: "127.0.0.1",
                                       family: 4 });
    const sock = await connect({ port: addr.port, host: "127.0.0.1",
                                 family: 4 });
    const data = await readAll(sock);
    ok("unmanaged IPv4 falls back to the kernel", () => {
      assert.strictEqual(data.toString(), "kernel");
    });
    await closeServer(server);
  }

  /* 7. netstack: true on an explicit IPv4 host forces the owned stack. */
  {
    const server = net.createServer({ netstack: true }, (sock) => {
      sock.on("data", (d) => sock.write("forced4:" + d.toString()));
      sock.on("end", () => sock.end());
    });
    const addr = await listen(server, { port: 0, host: "127.0.0.1",
                                       netstack: true, family: 4 });
    const sock = await connect({ port: addr.port, host: "127.0.0.1",
                                 netstack: true, family: 4 });
    const echoed = readAll(sock);
    sock.end("yes");
    const data = await echoed;
    ok("netstack: true forces IPv4 onto the owned stack", () => {
      assert.strictEqual(data.toString(), "forced4:yes");
    });
    await closeServer(server);
  }

  if (failures) {
    console.log("netstack_socket: " + failures + " failure(s)");
    process.exit(1);
  }
  console.log("netstack_socket: all tests passed");
}

const guard = setTimeout(() => {
  console.log("netstack_socket: timed out");
  process.exit(2);
}, 30000);
main().then(() => {
  clearTimeout(guard);
  process.exit(failures ? 1 : 0);
}, (e) => {
  clearTimeout(guard);
  console.log("netstack_socket: " + (e && e.stack || e));
  process.exit(1);
});
