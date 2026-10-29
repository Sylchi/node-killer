#!/bin/bash
# Compare accept-path throughput for single, SO_REUSEPORT, and sharded
# listeners. Run through bench.sh so a private /64 is configured first.
set -u

Q=${QNODE:-"$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)/build/qnode"}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SUBNET=${SUBNET:-fd00:dead:beef:20::/64}
SHARDS=${SHARDS:-4}
CLIENTS=${CLIENTS:-8}
TOTAL=${TOTAL:-3000}
CONC=${CONC:-32}
REPS=${REPS:-3}
PORT_BASE=${PORT_BASE:-41000}
SCENARIOS=${SCENARIOS:-"single-1p:single:1:0 reuse-4p:single:4:1 shard-1p:sharded:1:0 shard-4p:sharded:4:1"}

if [ ! -x "$Q" ]; then
  echo "qnode binary not found: $Q" >&2
  exit 1
fi

tmp=$(mktemp -d)
summary=$tmp/summary
: >"$summary"
server_pids=()

cleanup() {
  if [ "${#server_pids[@]}" -gt 0 ]; then
    kill "${server_pids[@]}" 2>/dev/null || true
    wait "${server_pids[@]}" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

run_one() {
  local name=$1 mode=$2 nservers=$3 reuse=$4 rep=$5 port=$6
  local sub="" sh=0
  if [ "$mode" = sharded ]; then
    sub=$SUBNET
    sh=$SHARDS
  fi
  local dir="$tmp/$name-$rep"
  mkdir -p "$dir"
  server_pids=()
  local i p
  for i in $(seq 0 $((nservers - 1))); do
    SUBNET=$sub SHARDS=$SHARDS REUSE=$reuse "$Q" "$HERE/server.js" \
      "$mode" "$port" >"$dir/server.$i" 2>&1 &
    server_pids+=($!)
  done

  local ready=0
  for i in $(seq 0 300); do
    ready=$(grep -l '^READY' "$dir"/server.* 2>/dev/null | wc -l)
    [ "$ready" -ge "$nservers" ] && break
    sleep 0.01
  done
  if [ "$ready" -lt "$nservers" ]; then
    echo "$name rep$rep: servers failed to start" >&2
    cat "$dir"/server.* >&2
    kill "${server_pids[@]}" 2>/dev/null || true
    wait "${server_pids[@]}" 2>/dev/null || true
    server_pids=()
    return 1
  fi

  local cstart cend
  cstart=$(date +%s%N)
  local client_pids=()
  for i in $(seq 1 "$CLIENTS"); do
    SUBNET=$sub SHARDS=$sh timeout 120 "$Q" "$HERE/client.js" \
      "$port" "$TOTAL" "$CONC" >"$dir/client.$i" 2>&1 &
    client_pids+=($!)
  done
  local failed=0
  for p in "${client_pids[@]}"; do
    wait "$p" || failed=1
  done
  cend=$(date +%s%N)

  kill "${server_pids[@]}" 2>/dev/null || true
  wait "${server_pids[@]}" 2>/dev/null || true
  server_pids=()

  if [ "$failed" -ne 0 ]; then
    echo "$name rep$rep: clients failed" >&2
    cat "$dir"/client.* >&2
    return 1
  fi

  local sum=0 errs=0 maxms=0 line done_n ms err
  for i in $(seq 1 "$CLIENTS"); do
    line=$(tail -n 1 "$dir/client.$i")
    done_n=$(echo "$line" | sed 's/.*"done":\([0-9]*\).*/\1/')
    err=$(echo "$line" | sed 's/.*"errors":\([0-9]*\).*/\1/')
    ms=$(echo "$line" | sed 's/.*"ms":\([0-9.]*\).*/\1/')
    sum=$((sum + done_n))
    errs=$((errs + err))
    maxms=$(awk -v a="$maxms" -v b="$ms" 'BEGIN{print (b>a)?b:a}')
  done
  local wall=$(( (cend - cstart) / 1000000 ))
  local rps
  rps=$(awk -v n="$sum" -v ms="$maxms" 'BEGIN{if(ms>0)printf "%.0f", n*1000/ms; else print 0}')
  echo "$name rep$rep conns=$sum errors=$errs client_max_ms=$maxms wall_ms=$wall rps=$rps"
  echo "$name $rps" >>"$summary"
}

run_seq=0
status=0
for rep in $(seq 1 "$REPS"); do
  for spec in $SCENARIOS; do
    IFS=: read -r name mode nservers reuse <<<"$spec"
    run_one "$name" "$mode" "$nservers" "$reuse" "$rep" \
      $((PORT_BASE + run_seq * 10 + rep)) || status=1
    run_seq=$((run_seq + 1))
  done
done

echo
echo "SUMMARY (runs=$REPS, clients=$CLIENTS, conns/client/run=$TOTAL, concurrency=$CONC)"
for name in $(cut -d' ' -f1 "$summary" | sort -u); do
  values=$(grep "^$name " "$summary" | cut -d' ' -f2 | sort -n)
  median=$(echo "$values" | awk '{a[NR]=$1} END{if(NR==0)print 0; else if(NR%2)print a[(NR+1)/2]; else print (a[NR/2]+a[NR/2+1])/2}')
  min=$(echo "$values" | head -n 1)
  max=$(echo "$values" | tail -n 1)
  echo "$name median_rps=$median min_rps=$min max_rps=$max"
done

exit "$status"
