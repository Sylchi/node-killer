/* Closed-loop TCP client for the sharded net benchmark.
 *
 *   client.js <port> <connections> <concurrency>
 *
 * Environment:
 *   SUBNET  IPv6 /64; empty targets ::1
 *   SHARDS  0 targets the single wildcard address, >0 targets each shard
 */
const net = require("net");

const port = Number(process.argv[2]);
const total = Number(process.argv[3]);
const concurrency = Number(process.argv[4]);
const subnet = process.env.SUBNET || "";
const shards = Number(process.env.SHARDS || 0);

const targets = [];
if (shards > 0) {
  for (let i = 0; i < shards; i++)
    targets.push(net.shardAddress(subnet, i));
} else {
  targets.push("::1");
}

let next = 0;
let done = 0;
let errors = 0;
let active = 0;
const start = process.hrtime.bigint();

function finish() {
  const ns = Number(process.hrtime.bigint() - start);
  console.log(JSON.stringify({ done, errors, ms: ns / 1e6 }));
  process.exit(errors ? 1 : 0);
}

function worker() {
  if (next >= total) {
    if (active === 0)
      finish();
    return;
  }
  const i = next++;
  const host = targets[i % targets.length];
  active++;
  let settled = false;
  const sock = net.createConnection({ host, port, noDelay: true });
  const settle = (err) => {
    if (settled)
      return;
    settled = true;
    if (err)
      errors++;
    sock.destroy();
    active--;
    done++;
    worker();
  };
  sock.on("connect", () => sock.write("x"));
  sock.on("data", () => {});
  sock.on("end", () => settle());
  sock.on("error", (err) => settle(err));
}

for (let i = 0; i < concurrency; i++)
  worker();
