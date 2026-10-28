#!/usr/bin/env python3
"""Run the runtime-comparison benchmarks and print a Markdown table.

Usage:
    NODE=node BUN=bun QNODE=./build/qnode python3 run.py

Each benchmark runs five times per runtime; the median is reported.
"""
import json
import os
import statistics
import subprocess

NODE = os.environ.get("NODE", "node")
BUN = os.environ.get("BUN", "bun")
QNODE = os.environ.get("QNODE", "./build/qnode")

RUNTIMES = {"Node.js": NODE, "Bun": BUN, "qnode": QNODE}
BENCHES = ["fib", "loop", "floatloop", "json", "regex", "sort", "array", "string", "object"]
RUNS = int(os.environ.get("RUNS", "5"))
HERE = os.path.dirname(os.path.abspath(__file__))


def run(exe, script, env=None, timeout=180):
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run(
        [exe, os.path.join(HERE, script)],
        capture_output=True, text=True, env=e, timeout=timeout, cwd=HERE,
    )


def median_of(exe, script, tag, env, runs=RUNS, column=3):
    values = []
    for _ in range(runs):
        p = run(exe, script, env)
        lines = [l for l in p.stdout.splitlines() if l.startswith(tag)]
        if lines:
            values.append(float(lines[-1].split()[column]))
    return statistics.median(values) if values else None


results = {}
for runtime, exe in RUNTIMES.items():
    results[runtime] = {}
    for bench in BENCHES:
        # qnode does not expose process.argv; pass the name via the environment.
        results[runtime][bench] = median_of(exe, "bench.js", "BENCH", {"BENCH": bench})
    results[runtime]["http"] = median_of(
        exe, "httpconc.js", "HTTPC", {"N": "10000", "C": "16"}, runs=3)
    results[runtime]["fs"] = median_of(exe, "fsbench.js", "FS", {}, runs=3, column=2)

print("| Benchmark | Node.js | Bun | qnode | unit |")
print("|---|---:|---:|---:|---|")
units = {
    "fib": "ms", "loop": "ms", "floatloop": "ms", "json": "ms", "regex": "ms",
    "sort": "ms", "array": "ms", "string": "ms", "object": "ms",
    "http": "ms / 10k req", "fs": "ms / 640 MiB",
}
labels = {
    "fib": "fib(30)", "loop": "30M int loop", "floatloop": "30M float loop",
    "json": "JSON 200k objects", "regex": "300k regex tests",
    "sort": "sort 300k numbers", "array": "map+filter+reduce 1M",
    "string": "200k string appends", "object": "create 300k objects",
    "http": "HTTP keep-alive, C=16", "fs": "8 MiB write+read x40",
}
for key in BENCHES + ["http", "fs"]:
    row = [labels[key]]
    for runtime in RUNTIMES:
        v = results[runtime][key]
        row.append("—" if v is None else f"{v:.1f}")
    row.append(units[key])
    print("| " + " | ".join(row) + " |")

with open(os.path.join(HERE, "results.json"), "w") as f:
    json.dump(results, f, indent=2)
print("\nSaved results.json")
