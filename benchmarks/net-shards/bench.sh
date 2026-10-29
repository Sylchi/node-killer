#!/bin/sh
# Set up a private IPv6 /64 and run benchmarks/net-shards/run.sh.
# Requires unshare(1) with user namespaces and ip(1).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
Q=${QNODE:-"$HERE/../../build/qnode"}
SUBNET=${SUBNET:-fd00:dead:beef:20::/64}

if ! command -v unshare >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1; then
  echo "bench.sh needs unshare and ip" >&2
  exit 1
fi
if ! unshare -rn true >/dev/null 2>&1; then
  echo "bench.sh needs user namespaces (unshare -rn)" >&2
  exit 1
fi

exec unshare -rn sh -c '
  set -eu
  ip link set lo up 2>/dev/null || true
  ip -6 addr add "$1" dev lo
  ip -6 route add local "$1" dev lo table local
  QNODE="$2" SUBNET="$1" "$3"
' sh "$SUBNET" "$Q" "$HERE/run.sh"
