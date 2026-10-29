# Sharded `node:net` accept benchmark

This benchmark measures how much the IPv6 shard listeners in
[`docs/sharded-net.md`](../../docs/sharded-net.md) help the connection
accept path. It is intentionally a small TCP echo workload, not an HTTP or
TLS throughput benchmark.

## Running

```sh
QNODE=/path/to/qnode benchmarks/net-shards/bench.sh
```

`bench.sh` needs Linux user namespaces (`unshare -rn`) and `ip` so it can
configure a private `/64` on loopback. It runs `run.sh`, which starts server
and client processes and prints one line per run plus a summary.

Useful environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `QNODE` | `build/qnode` | qnode binary |
| `SUBNET` | `fd00:dead:beef:20::/64` | private `/64` for the benchmark |
| `SHARDS` | `4` | shard listeners per sharded server process |
| `CLIENTS` | `8` | client processes |
| `TOTAL` | `3000` | connections per client process per run |
| `CONC` | `32` | concurrent connections per client process |
| `REPS` | `3` | runs of every scenario |
| `SCENARIOS` | see `run.sh` | `name:mode:servers:reuse` entries |

Each connection sends one byte and the server replies with one byte and
closes. Clients run a closed loop with fixed concurrency, so the metric is
connections per second through the full connect/read/write/close path.

## Scenarios

| Scenario | Server processes | Listeners | Description |
| --- | --- | --- | --- |
| `single-1p` | 1 | one `::` listener | baseline |
| `reuse-4p` | 4 | one `::` listener each, `SO_REUSEPORT` | multi-process baseline |
| `shard-1p` | 1 | one listener per shard address | single event loop with sharding |
| `shard-4p` | 4 | one listener per shard address each, `SO_REUSEPORT` | multi-process sharding |

`reuse-4p` is the important comparison: it is what a multi-process deployment
could already do before sharding.

## Example results

WSL2, 16 vCPUs, 8 client processes, 24,000 connections per run, 3 runs,
median:

| Scenario | Connections/s | Relative to baseline |
| --- | ---: | ---: |
| `single-1p` | 5,667 | 1.00x |
| `reuse-4p` | 15,709 | 2.77x |
| `shard-1p` | 5,486 | 0.97x |
| `shard-4p` | 16,519 | 2.91x |

With 8 server processes instead of 4 (20,000 connections per run, 2 runs),
both configurations reached roughly 19,000 connections/s:
`reuse-8p` 19,283, `shard-8p` 19,037.

Absolute numbers are machine-dependent; the relative result was stable across
runs.

## Interpretation

- **Single-process sharding does not increase throughput.** All listeners are
  still accepted and serviced by one event loop. In this accept-heavy test it
  is roughly 3% slower than a single listener because there are more
  descriptors to poll.
- **Multi-process scaling comes from using more cores.** Four server
  processes reach about 2.8-2.9x the single-process rate. `SO_REUSEPORT` alone
  already provides that scaling, so these numbers do not show sharding beating
  `reusePort`.
- **Sharding's value is deterministic steering, not raw single-process
  speed.** A client can choose a destination shard address, and a process can
  own the matching listener, instead of relying on the kernel's 4-tuple hash.
  That is useful for address-based affinity and for splitting a `/64` between
  processes or hosts.
- **To make one qnode process use more cores, the work still needs threads or
  child processes.** `worker_threads` is not implemented yet, so the supported
  way to scale this transport is multiple processes with distinct prefixes or
  `reusePort`.

Long-lived connections, HTTP keep-alive, and real application work will show
different absolute numbers, but the structural result is the same: adding
shard listeners to a single event loop does not add CPU capacity.
