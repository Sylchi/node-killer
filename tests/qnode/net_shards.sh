#!/bin/sh
# Run the node:net shard tests. When user namespaces are available the test
# gets a private /64 on loopback; otherwise it exercises the fallback paths
# only. Set QNODE to the qnode binary and QNODE_TEST_SUBNET to change the
# prefix.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QNODE=${QNODE:-"$here/../../build/qnode"}
SUBNET=${QNODE_TEST_SUBNET:-fd00:dead:beef:1::/64}
SCRIPT="$here/net_shards.js"

case "$QNODE" in
  /*) ;;
  *) QNODE=$(CDPATH= cd -- "$(dirname -- "$QNODE")" && pwd)/$(basename -- "$QNODE") ;;
esac

if [ ! -x "$QNODE" ]; then
  echo "qnode binary not found: $QNODE" >&2
  exit 1
fi

if [ "${QNODE_TEST_NO_UNSHARE:-0}" != 1 ] &&
   command -v unshare >/dev/null 2>&1 &&
   command -v ip >/dev/null 2>&1 &&
   unshare -rn true >/dev/null 2>&1; then
  exec unshare -rn sh -c '
    set -eu
    ip link set lo up 2>/dev/null || true
    if ip -6 addr add "$1" dev lo 2>/dev/null &&
       ip -6 route add local "$1" dev lo table local 2>/dev/null; then
      QNODE_TEST_SUBNET="$1" "$2" "$3"
    else
      QNODE_TEST_NO_SUBNET=1 "$2" "$3"
    fi
  ' sh "$SUBNET" "$QNODE" "$SCRIPT"
fi

exec "$QNODE" "$SCRIPT"
