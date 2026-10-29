#!/bin/sh
# Optional TUN integration test for the owned TCP stack.
#
# It runs in a private user+network namespace so it needs no host privileges,
# but it still requires user namespaces, /dev/net/tun and ip(8). When any of
# those are unavailable the test prints a skip and succeeds.

set -e

QNODE=${QNODE:-$(pwd)/build/qnode}
if [ ! -x "$QNODE" ]; then
    echo "netstack_tun: skipped (qnode not found at $QNODE)"
    exit 0
fi
if ! command -v unshare >/dev/null 2>&1 ||
   ! command -v ip >/dev/null 2>&1 ||
   [ ! -e /dev/net/tun ]; then
    echo "netstack_tun: skipped (unshare, ip or /dev/net/tun unavailable)"
    exit 0
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/qnode-tun.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/server.js" <<'EOF'
const dgram = require("dgram");
const net = require("net");
const echo = (sock) => {
  sock.on("data", (d) => sock.write(d));
  sock.on("end", () => sock.end());
};
const s6 = net.createServer({ netstack: true }, echo);
const s4 = net.createServer({ netstack: true }, echo);
const u6 = dgram.createSocket({ type: "udp6", netstack: true });
const u4 = dgram.createSocket({ type: "udp4", netstack: true });
u6.on("message", (msg, rinfo) => u6.send(msg, rinfo.port, rinfo.address));
u4.on("message", (msg, rinfo) => u4.send(msg, rinfo.port, rinfo.address));
let ready = 0;
function announce() {
  if (++ready === 4)
    console.log("READY " + net.netstackAddress() + " " +
                net.netstackAddress(4));
}
s6.listen({ port: 7000, host: net.netstackAddress(), netstack: true },
          announce);
s4.listen({ port: 7001, host: net.netstackAddress(4), netstack: true,
            family: 4 }, announce);
u6.bind(7002, net.netstackAddress(), announce);
u4.bind(7003, net.netstackAddress(4), announce);
s6.on("error", (e) => { console.error(e); process.exit(1); });
s4.on("error", (e) => { console.error(e); process.exit(1); });
u6.on("error", (e) => { console.error(e); process.exit(1); });
u4.on("error", (e) => { console.error(e); process.exit(1); });
setTimeout(() => process.exit(3), 15000);
EOF

cat >"$tmp/client6.js" <<'EOF'
const net = require("net");
const c = net.connect({
  host: "fd00:dead:beef:99::1",
  port: 7000,
  family: 6,
  localAddress: "fd00:dead:beef:99::2",
  netstack: false,
});
let got = "";
c.on("connect", () => c.end("tun-hello"));
c.on("data", (d) => { got += d; });
c.on("end", () => process.exit(got === "tun-hello" ? 0 : 4));
c.on("error", () => process.exit(1));
setTimeout(() => process.exit(2), 10000);
EOF

cat >"$tmp/client4.js" <<'EOF'
const net = require("net");
const c = net.connect({
  host: "10.254.0.1",
  port: 7001,
  family: 4,
  localAddress: "10.254.0.2",
  netstack: false,
});
let got = "";
c.on("connect", () => c.end("tun-v4"));
c.on("data", (d) => { got += d; });
c.on("end", () => process.exit(got === "tun-v4" ? 0 : 4));
c.on("error", () => process.exit(1));
setTimeout(() => process.exit(2), 10000);
EOF

cat >"$tmp/client6udp.js" <<'EOF'
const dgram = require("dgram");
const s = dgram.createSocket({ type: "udp6", netstack: false });
s.on("message", (msg) => process.exit(msg.toString() === "tun-udp6" ? 0 : 4));
s.on("error", () => process.exit(1));
s.bind(0, "fd00:dead:beef:99::2", () => {
  s.send("tun-udp6", 7002, "fd00:dead:beef:99::1");
});
setTimeout(() => process.exit(2), 10000);
EOF

cat >"$tmp/client4udp.js" <<'EOF'
const dgram = require("dgram");
const s = dgram.createSocket({ type: "udp4", netstack: false });
s.on("message", (msg) => process.exit(msg.toString() === "tun-udp4" ? 0 : 4));
s.on("error", () => process.exit(1));
s.bind(0, "10.254.0.2", () => {
  s.send("tun-udp4", 7003, "10.254.0.1");
});
setTimeout(() => process.exit(2), 10000);
EOF

cat >"$tmp/client6udpbig.js" <<'EOF'
const dgram = require("dgram");
const payload = Buffer.alloc(6000, 0x5a);
const s = dgram.createSocket({ type: "udp6", netstack: false });
s.on("message", (msg) => process.exit(msg.equals(payload) ? 0 : 4));
s.on("error", () => process.exit(1));
s.bind(0, "fd00:dead:beef:99::2", () => {
  s.send(payload, 7002, "fd00:dead:beef:99::1");
});
setTimeout(() => process.exit(2), 10000);
EOF

cat >"$tmp/client4udpbig.js" <<'EOF'
const dgram = require("dgram");
const payload = Buffer.alloc(6000, 0x5a);
const s = dgram.createSocket({ type: "udp4", netstack: false });
s.on("message", (msg) => process.exit(msg.equals(payload) ? 0 : 4));
s.on("error", () => process.exit(1));
s.bind(0, "10.254.0.2", () => {
  s.send(payload, 7003, "10.254.0.1");
});
setTimeout(() => process.exit(2), 10000);
EOF

QNODE=$(cd "$(dirname "$QNODE")" && pwd)/$(basename "$QNODE")
export QNODE
set +e
unshare -rn sh -c '
  ip link set lo up
  ip tuntap add dev qn0 mode tun || exit 125
  ip link set qn0 up
  ip -6 addr add fd00:dead:beef:99::2/64 dev qn0 nodad
  ip addr add 10.254.0.2/16 dev qn0

  QNODE_NETSTACK_TUN=1 QNODE_NETSTACK_TUN_NAME=qn0 \
    "$QNODE" "$1/server.js" >"$1/server.out" 2>&1 &
  spid=$!
  for i in $(seq 1 50); do
    grep -q READY "$1/server.out" 2>/dev/null && break
    sleep 0.1
  done
  grep -q READY "$1/server.out" || { cat "$1/server.out"; kill $spid 2>/dev/null; exit 1; }

  "$QNODE" "$1/client6.js"
  rc6=$?
  "$QNODE" "$1/client4.js"
  rc4=$?
  "$QNODE" "$1/client6udp.js"
  rcu6=$?
  "$QNODE" "$1/client4udp.js"
  rcu4=$?
  "$QNODE" "$1/client6udpbig.js"
  rcub6=$?
  "$QNODE" "$1/client4udpbig.js"
  rcub4=$?

  if command -v ping >/dev/null 2>&1; then
    ping -c 2 -w 5 -4 10.254.0.1 >"$1/ping4.out" 2>&1
    rcp4=$?
    ping -c 2 -w 5 -6 fd00:dead:beef:99::1 >"$1/ping6.out" 2>&1
    rcp6=$?
    ping -c 1 -w 5 -4 -s 4000 10.254.0.1 >"$1/ping4big.out" 2>&1
    rcp4big=$?
    ping -c 1 -w 5 -6 -s 4000 fd00:dead:beef:99::1 >"$1/ping6big.out" 2>&1
    rcp6big=$?
  else
    rcp4=0
    rcp6=0
    rcp4big=0
    rcp6big=0
    echo "netstack_tun: ping not found, skipping ICMP echo checks"
  fi

  kill $spid 2>/dev/null
  wait $spid 2>/dev/null
  [ "$rc6" -ne 0 ] && exit $rc6
  [ "$rc4" -ne 0 ] && exit $rc4
  [ "$rcu6" -ne 0 ] && exit $rcu6
  [ "$rcu4" -ne 0 ] && exit $rcu4
  [ "$rcub6" -ne 0 ] && exit $rcub6
  [ "$rcub4" -ne 0 ] && exit $rcub4
  [ "$rcp4" -ne 0 ] && { cat "$1/ping4.out"; exit $rcp4; }
  [ "$rcp6" -ne 0 ] && { cat "$1/ping6.out"; exit $rcp6; }
  [ "$rcp4big" -ne 0 ] && { cat "$1/ping4big.out"; exit $rcp4big; }
  [ "$rcp6big" -ne 0 ] && { cat "$1/ping6big.out"; exit $rcp6big; }
  exit 0
' sh "$tmp"
rc=$?
set -e

if [ "$rc" -eq 125 ]; then
    echo "netstack_tun: skipped (TUN device could not be created)"
    exit 0
fi
if [ "$rc" -ne 0 ]; then
    echo "netstack_tun: failed ($rc)"
    exit "$rc"
fi
echo "netstack_tun: ok"
