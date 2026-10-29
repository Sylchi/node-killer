/*
 * node:net IPv6 shard dispatch tests.
 *
 * Run through tests/net_shards.sh so a private /64 can be configured first.
 * Without a usable subnet the script still checks the fallback path and
 * exits successfully, so the suite works on hosts without IPv6 setup.
 */
const assert = require("assert");
const { createServer, createConnection, shardAddress, shardIndex } =
  require("net");

const SUBNET = process.env.QNODE_TEST_SUBNET || "";
const SHARDS = 4;

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

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function roundTrip(options, payload = "ping") {
  return new Promise((resolve, reject) => {
    const sock = createConnection(options, () => sock.end(payload));
    const chunks = [];
    sock.on("data", (chunk) => chunks.push(chunk));
    sock.on("end", () => {
      sock.destroy();
      resolve(Buffer.concat(chunks).toString());
    });
    sock.on("error", reject);
  });
}

function testShardAddress() {
  if (!SUBNET)
    return "skip (no subnet)";
  const a0 = shardAddress(SUBNET, 0);
  const a1 = shardAddress(SUBNET, 1);
  const a255 = shardAddress(SUBNET, 255);
  assert.notEqual(a0, a1);
  assert.equal(shardIndex(a0), 0);
  assert.equal(shardIndex(a1), 1);
  assert.equal(shardIndex(a255), 255);
  assert.equal(shardIndex("not-an-address"), -1);
  assert.throws(() => shardAddress(SUBNET, -1), RangeError);
  assert.throws(() => shardAddress(SUBNET, 256), RangeError);
  assert.throws(() => shardAddress("fd00::/48", 1), RangeError);
  return "ok";
}

async function testShardedServer() {
  if (!SUBNET)
    return "skip (no subnet)";
  const observed = [];
  const server = createServer((sock) => {
    observed.push({ shard: sock.shard, local: sock.localAddress,
                    remote: sock.remoteAddress });
    sock.on("data", () => {});
    sock.on("end", () => sock.end("shard:" + sock.shard));
  });
  await listen(server, {
    port: 0, subnet: SUBNET, shards: SHARDS, freeBind: true,
  });
  if (!server.sharded) {
    await close(server);
    return "skip (subnet not usable: " +
      (server.fallbackReason && server.fallbackReason.code) + ")";
  }
  try {
    assert.equal(server.shardCount, SHARDS);
    assert.equal(server.fallbackReason, null);
    const addresses = server.addresses();
    assert.equal(addresses.length, SHARDS);
    const port = server.address().port;
    for (let i = 0; i < SHARDS; i++) {
      assert.equal(addresses[i].shard, i);
      assert.equal(addresses[i].family, "IPv6");
      assert.equal(addresses[i].port, port);
      assert.equal(shardIndex(addresses[i].address), i);
      const text = await roundTrip({ host: SUBNET, port, shard: i });
      assert.equal(text, "shard:" + i);
    }
    for (let i = 0; i < SHARDS; i++) {
      assert.equal(observed[i].shard, i);
      assert.equal(observed[i].local, shardAddress(SUBNET, i));
    }

    /* A client can bind a source address from the same /64. The server then
       sees that address instead of the kernel-selected default. */
    const source = shardAddress(SUBNET, 250);
    const text = await roundTrip({
      host: SUBNET, port, shard: 1, localAddress: source, freeBind: true,
    });
    assert.equal(text, "shard:1");
    const last = observed[observed.length - 1];
    assert.equal(last.remote, source);

    await close(server);
    assert.equal(server.addresses().length, 0);
    assert.equal(server.address(), null);
    return "ok";
  } finally {
    if (server.listening)
      await close(server);
  }
}

async function testSingleShard() {
  if (!SUBNET)
    return "skip (no subnet)";
  const server = createServer((sock) => {
    sock.on("data", () => {});
    sock.on("end", () => sock.end("one"));
  });
  /* A subnet enables shard addressing even without an explicit count. */
  await listen(server, { port: 0, subnet: SUBNET, freeBind: true });
  if (!server.sharded) {
    await close(server);
    return "skip (subnet not usable: " +
      (server.fallbackReason && server.fallbackReason.code) + ")";
  }
  try {
    assert.equal(server.shardCount, 1);
    const entry = server.addresses()[0];
    assert.equal(entry.shard, 0);
    assert.equal(entry.address, shardAddress(SUBNET, 0));
    const text = await roundTrip({ host: SUBNET, port: entry.port, shard: 0 });
    assert.equal(text, "one");
    return "ok";
  } finally {
    if (server.listening)
      await close(server);
  }
}

async function testShardedHTTP() {
  if (!SUBNET)
    return "skip (no subnet)";
  const http = require("http");
  const server = http.createServer((req, res) => {
    res.end("shard:" + req.socket.shard);
  });
  await listen(server, {
    port: 0, subnet: SUBNET, shards: SHARDS, freeBind: true,
  });
  if (!server._server.sharded) {
    await close(server);
    return "skip (subnet not usable: " +
      (server._server.fallbackReason && server._server.fallbackReason.code) +
      ")";
  }
  try {
    const port = server.address().port;
    const bodies = await Promise.all(Array.from({ length: SHARDS }, (_, i) =>
      new Promise((resolve, reject) => {
        /* `host` stays the logical name used by HTTP; `subnet` and `shard`
           select the destination address. */
        const req = http.get({ host: "shard.test", subnet: SUBNET, shard: i,
                               port }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on("error", reject);
      })));
    for (let i = 0; i < SHARDS; i++)
      assert.equal(bodies[i], "shard:" + i);
    return "ok";
  } finally {
    await close(server);
  }
}

async function testFallback() {
  /* 2001:db8::/32 is documentation space. It is normally not assigned, so
     binding the shard addresses fails and the server must fall back to one
     listener. If the environment does route it, skip instead of failing. */
  const server = createServer((sock) => {
    sock.on("data", () => {});
    sock.on("end", () => sock.end("fallback"));
  });
  await listen(server, {
    port: 0,
    subnet: "2001:db8:ffff:1::/64",
    shards: 2,
    fallbackHost: "::1",
  });
  if (server.sharded) {
    await close(server);
    return "skip (2001:db8 prefix is routed)";
  }
  try {
    assert.ok(server.fallbackReason, "fallbackReason is set");
    assert.equal(server.fallbackReason.code, "EADDRNOTAVAIL");
    assert.equal(server.addresses().length, 1);
    assert.equal(server.addresses()[0].shard, undefined);
    const text = await roundTrip({ host: "::1", port: server.address().port });
    assert.equal(text, "fallback");
    return "ok";
  } finally {
    await close(server);
  }
}

async function testFallbackDisabled() {
  const server = createServer();
  const outcome = await new Promise((resolve) => {
    const onError = (err) => {
      server.off("error", onError);
      resolve({ err });
    };
    server.once("error", onError);
    server.listen({
      port: 0,
      subnet: "2001:db8:fffe:1::/64",
      shards: 2,
      fallback: false,
    }, () => {
      server.off("error", onError);
      resolve({ listening: true });
    });
  });
  if (outcome.err) {
    assert.equal(outcome.err.code, "EADDRNOTAVAIL");
    return "ok";
  }
  await close(server);
  return "skip (2001:db8 prefix is routed)";
}

async function testSingleIPv6() {
  const server = createServer((sock) => {
    assert.equal(sock.shard, undefined);
    sock.on("data", () => {});
    sock.on("end", () => sock.end("single"));
  });
  try {
    await listen(server, { port: 0, host: "::1" });
  } catch (err) {
    if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")
      return "skip (" + err.code + ")";
    throw err;
  }
  try {
    assert.equal(server.address().family, "IPv6");
    assert.equal(server.sharded, false);
    assert.equal(server.shardCount, 0);
    assert.equal(server.addresses().length, 1);
    const text = await roundTrip({ host: "::1", port: server.address().port });
    assert.equal(text, "single");
    return "ok";
  } finally {
    await close(server);
  }
}

const tests = [
  ["shard address helpers", testShardAddress],
  ["single IPv6 listener", testSingleIPv6],
  ["sharded IPv6 listener", testShardedServer],
  ["single shard listener", testSingleShard],
  ["sharded HTTP dispatch", testShardedHTTP],
  ["sharded fallback", testFallback],
  ["fallback disabled", testFallbackDisabled],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      const result = await fn();
      console.log("ok - " + name +
                  (result.startsWith("skip") ? " (" + result + ")" : ""));
    } catch (err) {
      failed++;
      console.error("not ok - " + name);
      console.error(err && err.stack || err);
    }
  }
  if (failed) {
    console.error(failed + " test(s) failed");
    process.exit(1);
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
