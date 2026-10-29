/* Minimal accept-path server for the sharded net benchmark.
 *
 *   server.js single  <port>
 *   server.js sharded <port>
 *
 * Environment:
 *   SUBNET  IPv6 /64 for shard addresses
 *   SHARDS  number of shard listeners
 *   REUSE   set to 1 to enable SO_REUSEPORT (multiple server processes)
 */
const net = require("net");

const mode = process.argv[2];
const port = Number(process.argv[3]);
const subnet = process.env.SUBNET || "";
const shards = Number(process.env.SHARDS || 4);
const reusePort = process.env.REUSE === "1";

const server = net.createServer((sock) => {
  /* One request per connection keeps the benchmark focused on accept,
     read, write, and close rather than application work. */
  sock.once("data", () => sock.end("x"));
  sock.on("error", () => {});
});
server.on("error", (err) => {
  console.error("server error:", err.code, err.message);
  process.exit(1);
});

const options = { port, reusePort };
if (mode === "sharded")
  Object.assign(options, { subnet, shards, freeBind: true });
else
  options.host = "::";

server.listen(options, () => {
  console.log("READY " + process.pid + " " + server.address().port);
});
