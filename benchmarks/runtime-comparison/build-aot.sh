#!/bin/sh
# Build standalone QuickJS executables with `qjs -c` (bytecode embedded in a
# copy of the interpreter; no parsing at startup, but no native codegen).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
QJS=${QJS:-"$ROOT/build/qjs"}
OUT=${OUT:-"$HERE/aot-build"}

mkdir -p "$OUT"
for name in bench-aot hello-aot; do
  "$QJS" -c "$HERE/$name.js" -o "$OUT/$name"
done
echo "built: $OUT/bench-aot $OUT/hello-aot"
