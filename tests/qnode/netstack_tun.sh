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
const net = require("net");
const s = net.createServer({ netstack: true }, (sock) => {
  sock.on("data", (d) => sock.write(d));
  sock.on("end", () => sock.end());
});
s.listen({ port: 7000, host: net.netstackAddress(), netstack: true },
         () => console.log("READY " + net.netstackAddress()));
s.on("error", (e) => { console.error(e); process.exit(1); });
setTimeout(() => process.exit(3), 15000);
EOF

cat >"$tmp/client.js" <<'EOF'
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

QNODE=$(cd "$(dirname "$QNODE")" && pwd)/$(basename "$QNODE")
export QNODE
set +e
unshare -rn sh -c '
  ip link set lo up
  ip tuntap add dev qn0 mode tun || exit 125
  ip link set qn0 up
  ip -6 addr add fd00:dead:beef:99::2/64 dev qn0 nodad

  QNODE_NETSTACK_TUN=1 QNODE_NETSTACK_TUN_NAME=qn0 \
    "$QNODE" "$1/server.js" >"$1/server.out" 2>&1 &
  spid=$!
  for i in $(seq 1 50); do
    grep -q READY "$1/server.out" 2>/dev/null && break
    sleep 0.1
  done
  grep -q READY "$1/server.out" || { cat "$1/server.out"; kill $spid 2>/dev/null; exit 1; }

  "$QNODE" "$1/client.js"
  rc=$?
  kill $spid 2>/dev/null
  wait $spid 2>/dev/null
  exit $rc
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
