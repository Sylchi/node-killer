/* Owned UDP stack integration tests. Run with qnode, not qjs.
 *
 * `node:dgram` sockets created with `netstack: true`, or bound to an address
 * inside the managed prefixes, are handed out as eventfd-backed virtual
 * descriptors and served by the in-process UDP engine. Other destinations
 * transparently convert to kernel datagram sockets. Everything below happens
 * in one process, so the loopback link needs no TUN device or privileges. */
"use strict";

const assert = require("assert");
const dgram = require("dgram");
const net = require("net");

const info = net.netstackInfo();
if (!info.enabled) {
  console.log("netstack_dgram: skipped (netstack unavailable)");
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

function bind(sock, port, address) {
  return new Promise((resolve, reject) => {
    function onError(e) {
      sock.removeListener("listening", onListening);
      reject(e);
    }
    function onListening() {
      sock.removeListener("error", onError);
      resolve(sock.address());
    }
    sock.once("error", onError);
    sock.once("listening", onListening);
    sock.bind(port, address);
  });
}

function bindFailure(sock, port, address) {
  return new Promise((resolve, reject) => {
    function onError(e) {
      sock.removeListener("listening", onListening);
      resolve(e);
    }
    function onListening() {
      sock.removeListener("error", onError);
      reject(new Error("bind unexpectedly succeeded"));
    }
    sock.once("error", onError);
    sock.once("listening", onListening);
    sock.bind(port, address);
  });
}

function connect(sock, port, address) {
  return new Promise((resolve, reject) => {
    function onError(e) {
      sock.removeListener("connect", onConnect);
      reject(e);
    }
    function onConnect() {
      sock.removeListener("error", onError);
      resolve();
    }
    sock.once("error", onError);
    sock.once("connect", onConnect);
    sock.connect(port, address);
  });
}

function send(sock, msg, port, address) {
  return new Promise((resolve, reject) => {
    const cb = (err) => err ? reject(err) : resolve();
    if (address === undefined)
      sock.send(msg, cb);
    else
      sock.send(msg, port, address, cb);
  });
}

function sendFailure(sock, msg, port, address) {
  return new Promise((resolve, reject) => {
    const cb = (err) => err ? resolve(err)
                            : reject(new Error("send unexpectedly succeeded"));
    if (address === undefined)
      sock.send(msg, cb);
    else
      sock.send(msg, port, address, cb);
  });
}

function recv(sock) {
  return new Promise((resolve, reject) => {
    function onMessage(msg, rinfo) {
      sock.removeListener("error", onError);
      resolve({ msg, rinfo });
    }
    function onError(e) {
      sock.removeListener("message", onMessage);
      reject(e);
    }
    sock.once("message", onMessage);
    sock.once("error", onError);
  });
}

function recvMany(sock, count) {
  return new Promise((resolve, reject) => {
    const out = [];
    function onMessage(msg, rinfo) {
      out.push({ msg, rinfo });
      if (out.length === count) {
        sock.removeListener("error", onError);
        resolve(out);
      }
    }
    function onError(e) {
      sock.removeListener("message", onMessage);
      reject(e);
    }
    sock.on("message", onMessage);
    sock.once("error", onError);
  });
}

function close(sock) {
  return new Promise((resolve) => sock.close(resolve));
}

async function main() {
  ok("netstack reports IPv6 and IPv4 addresses", () => {
    assert.strictEqual(typeof ADDR, "string");
    assert.ok(ADDR.indexOf(":") >= 0, "expected an IPv6 address");
    assert.strictEqual(typeof ADDR4, "string");
    assert.ok(ADDR4.indexOf(".") >= 0, "expected an IPv4 address");
  });

  /* 1. Owned IPv4 datagram round-trip. */
  {
    const server = dgram.createSocket({ type: "udp4", netstack: true });
    const addr = await bind(server, 0, ADDR4);
    ok("IPv4 bind() reports the netstack address", () => {
      assert.strictEqual(addr.address, ADDR4);
      assert.strictEqual(addr.family, "IPv4");
      assert.ok(addr.port > 0);
    });

    const client = dgram.createSocket({ type: "udp4", netstack: true });
    await bind(client, 0, ADDR4);
    const got = recv(server);
    await send(client, Buffer.from("hello udp"), addr.port, addr.address);
    const { msg, rinfo } = await got;
    ok("IPv4 datagram round-trip", () => {
      assert.strictEqual(msg.toString(), "hello udp");
      assert.strictEqual(rinfo.address, ADDR4);
      assert.strictEqual(rinfo.family, "IPv4");
      assert.strictEqual(rinfo.port, client.address().port);
      assert.strictEqual(rinfo.size, 9);
    });
    await close(client);
    await close(server);
  }

  /* 1b. Owned IPv6 datagram round-trip. */
  {
    const server = dgram.createSocket({ type: "udp6", netstack: true });
    const addr = await bind(server, 0, ADDR);
    ok("IPv6 bind() reports the netstack address", () => {
      assert.strictEqual(addr.address, ADDR);
      assert.strictEqual(addr.family, "IPv6");
      assert.ok(addr.port > 0);
    });

    const client = dgram.createSocket({ type: "udp6", netstack: true });
    await bind(client, 0, ADDR);
    const got = recv(server);
    await send(client, Buffer.from("hello udp6"), addr.port, addr.address);
    const { msg, rinfo } = await got;
    ok("IPv6 datagram round-trip", () => {
      assert.strictEqual(msg.toString(), "hello udp6");
      assert.strictEqual(rinfo.address, ADDR);
      assert.strictEqual(rinfo.family, "IPv6");
      assert.strictEqual(rinfo.port, client.address().port);
    });
    await close(client);
    await close(server);
  }

  /* 1c. Datagrams spanning multiple IP fragments are reassembled. */
  for (const family of [4, 6]) {
    const type = family === 4 ? "udp4" : "udp6";
    const host = family === 4 ? ADDR4 : ADDR;
    const server = dgram.createSocket({ type, netstack: true });
    const addr = await bind(server, 0, host);
    const client = dgram.createSocket({ type, netstack: true });
    await bind(client, 0, host);
    const payload = Buffer.alloc(6000);
    for (let i = 0; i < payload.length; i++)
      payload[i] = (i * 7 + family) & 0xff;
    const got = recv(server);
    await send(client, payload, addr.port, addr.address);
    const { msg } = await got;
    ok(type + " fragmented datagram round-trip", () => {
      assert.strictEqual(msg.length, payload.length);
      assert.ok(msg.equals(payload), "payload mismatch after reassembly");
    });
    await close(client);
    await close(server);
  }

  /* 2. The managed address alone selects the owned stack. */
  {
    const server = dgram.createSocket("udp4");
    const addr = await bind(server, 0, ADDR4);
    const client = dgram.createSocket("udp4");
    await bind(client, 0, ADDR4);
    const got = recv(server);
    await send(client, "auto4", addr.port, addr.address);
    const { msg } = await got;
    ok("auto-selects netstack by IPv4 address", () => {
      assert.strictEqual(msg.toString(), "auto4");
    });
    await close(client);
    await close(server);
  }

  /* 2b. Sending first auto-binds on the owned engine, like the kernel does,
     and the wildcard socket can still receive the reply. */
  {
    const server = dgram.createSocket({ type: "udp4", netstack: true });
    const addr = await bind(server, 0, ADDR4);
    const client = dgram.createSocket({ type: "udp4", netstack: true });
    const got = recv(server);
    await send(client, "send-first", addr.port, addr.address);
    const first = await got;
    const local = client.address();
    ok("send() auto-binds an unbound owned socket", () => {
      assert.strictEqual(first.msg.toString(), "send-first");
      assert.strictEqual(local.address, "0.0.0.0");
      assert.ok(local.port > 0);
      assert.strictEqual(first.rinfo.port, local.port);
    });

    const reply = recv(client);
    await send(server, "reply-first", local.port, ADDR4);
    const back = await reply;
    ok("auto-bound wildcard socket receives replies", () => {
      assert.strictEqual(back.msg.toString(), "reply-first");
      assert.strictEqual(back.rinfo.port, addr.port);
    });
    await close(client);
    await close(server);
  }

  /* 3. Datagram boundaries and ordering are preserved for queued traffic. */
  {
    const server = dgram.createSocket({ type: "udp4", netstack: true });
    const addr = await bind(server, 0, ADDR4);
    const client = dgram.createSocket({ type: "udp4", netstack: true });
    await bind(client, 0, ADDR4);
    const receiving = recvMany(server, 6);
    for (let i = 0; i < 6; i++)
      await send(client, Buffer.from("msg-" + i), addr.port, addr.address);
    const messages = await receiving;
    ok("six queued datagrams arrive in order", () => {
      assert.strictEqual(messages.length, 6);
      for (let i = 0; i < messages.length; i++)
        assert.strictEqual(messages[i].msg.toString(), "msg-" + i);
    });
    await close(client);
    await close(server);
  }

  /* 4. Connected sockets send without repeating the destination, filter
     datagrams from other peers, and can be disconnected again. */
  {
    const server = dgram.createSocket({ type: "udp4", netstack: true });
    const addr = await bind(server, 0, ADDR4);
    const client = dgram.createSocket({ type: "udp4", netstack: true });
    await connect(client, addr.port, addr.address);

    ok("connect() exposes the peer", () => {
      const peer = client.remoteAddress();
      assert.strictEqual(peer.address, addr.address);
      assert.strictEqual(peer.port, addr.port);
      assert.strictEqual(peer.family, "IPv4");
    });

    const got = recv(server);
    await new Promise((resolve, reject) => {
      client.send(Buffer.from("connected"), (err) =>
        err ? reject(err) : resolve());
    });
    const first = await got;
    ok("connected send() uses the stored peer", () => {
      assert.strictEqual(first.msg.toString(), "connected");
      assert.strictEqual(first.rinfo.port, client.address().port);
    });

    const reply = recv(client);
    await send(server, Buffer.from("reply"), first.rinfo.port,
               first.rinfo.address);
    const back = await reply;
    ok("replies from the connected peer arrive", () => {
      assert.strictEqual(back.msg.toString(), "reply");
      assert.strictEqual(back.rinfo.port, addr.port);
    });

    /* A second server socket is bound to the same address but a different
       port, so its datagrams must be filtered out by the connected socket. */
    const impostor = dgram.createSocket({ type: "udp4", netstack: true });
    const other = await bind(impostor, 0, ADDR4);
    await send(impostor, "nope", client.address().port, ADDR4);

    /* Let the loop turn once; nothing should have been delivered. */
    await new Promise((resolve) => setTimeout(resolve, 50));

    client.disconnect();
    ok("disconnect() clears the peer", () => {
      assert.throws(() => client.remoteAddress(),
                    (e) => e.code === "ERR_SOCKET_DGRAM_NOT_CONNECTED");
    });

    const err = await sendFailure(client, "x");
    ok("send() without a destination after disconnect fails", () => {
      assert.strictEqual(err.code, "ERR_SOCKET_DGRAM_NOT_CONNECTED");
    });

    const now = recv(client);
    await send(impostor, "now", client.address().port, ADDR4);
    const delivered = await now;
    ok("disconnected socket accepts other peers", () => {
      assert.strictEqual(delivered.msg.toString(), "now");
      assert.strictEqual(delivered.rinfo.port, other.port);
    });

    await close(impostor);
    await close(client);
    await close(server);
  }

  /* 5. Unmanaged addresses still convert to kernel datagram sockets. */
  {
    const server = dgram.createSocket({ type: "udp4", netstack: false });
    const addr = await bind(server, 0, "127.0.0.1");
    const client = dgram.createSocket({ type: "udp4", netstack: false });
    await bind(client, 0, "127.0.0.1");
    const got = recv(server);
    await send(client, "kernel4", addr.port, addr.address);
    const { msg, rinfo } = await got;
    ok("unmanaged IPv4 stays on kernel UDP", () => {
      assert.strictEqual(msg.toString(), "kernel4");
      assert.strictEqual(rinfo.address, "127.0.0.1");
    });
    await close(client);
    await close(server);
  }

  {
    const server = dgram.createSocket({ type: "udp6", netstack: false });
    const addr = await bind(server, 0, "::1");
    const client = dgram.createSocket({ type: "udp6", netstack: false });
    await bind(client, 0, "::1");
    const got = recv(server);
    await send(client, "kernel6", addr.port, addr.address);
    const { msg, rinfo } = await got;
    ok("unmanaged IPv6 stays on kernel UDP", () => {
      assert.strictEqual(msg.toString(), "kernel6");
      assert.strictEqual(rinfo.address, "::1");
    });
    await close(client);
    await close(server);
  }

  /* 6. netstack: true forces a foreign address onto the owned engine. */
  {
    const server = dgram.createSocket({ type: "udp4", netstack: true });
    const addr = await bind(server, 0, "127.0.0.1");
    const client = dgram.createSocket({ type: "udp4", netstack: true });
    await bind(client, 0, "127.0.0.1");
    const got = recv(server);
    await send(client, "forced4", addr.port, addr.address);
    const { msg } = await got;
    ok("netstack: true forces IPv4 onto the owned UDP engine", () => {
      assert.strictEqual(msg.toString(), "forced4");
    });
    await close(client);
    await close(server);
  }

  /* 7. Socket error paths. */
  {
    const fresh = dgram.createSocket("udp4");
    ok("address() before bind throws", () => {
      assert.throws(() => fresh.address(),
                    (e) => e.code === "ERR_SOCKET_DGRAM_NOT_RUNNING");
      assert.throws(() => fresh.remoteAddress(),
                    (e) => e.code === "ERR_SOCKET_DGRAM_NOT_CONNECTED");
    });
    fresh.close();

    const first = dgram.createSocket({ type: "udp4", netstack: true });
    const addr = await bind(first, 0, ADDR4);
    const second = dgram.createSocket({ type: "udp4", netstack: true });
    const e = await bindFailure(second, addr.port, ADDR4);
    ok("binding a used netstack port reports EADDRINUSE", () => {
      assert.strictEqual(e.code, "EADDRINUSE");
    });
    second.close();

    const client = dgram.createSocket({ type: "udp4", netstack: true });
    await bind(client, 0, ADDR4);
    /* 65507 is the IPv4 UDP payload maximum; the next byte cannot be
       represented on the wire and is rejected instead of fragmented. */
    const big = await sendFailure(client, Buffer.alloc(65508), addr.port,
                                  addr.address);
    ok("datagrams past the IPv4 maximum report EMSGSIZE", () => {
      assert.strictEqual(big.code, "EMSGSIZE");
    });
    await close(client);
    await close(first);
  }

  if (failures) {
    console.log("netstack_dgram: " + failures + " failure(s)");
    process.exit(1);
  }
  console.log("netstack_dgram: all tests passed");
}

const guard = setTimeout(() => {
  console.log("netstack_dgram: timed out");
  process.exit(2);
}, 30000);
main().then(() => {
  clearTimeout(guard);
  process.exit(failures ? 1 : 0);
}, (e) => {
  clearTimeout(guard);
  console.log("netstack_dgram: " + (e && e.stack || e));
  process.exit(1);
});
