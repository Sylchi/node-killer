#!/bin/sh
# Run the qnode-only test suite: tests that need the Node compatibility layer
# and therefore cannot run under qjs. Set QNODE to the binary under test.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QNODE=${QNODE:-"$here/../build/qnode"}

case "$QNODE" in
  /*) ;;
  *) QNODE=$(CDPATH= cd -- "$(dirname -- "$QNODE")" && pwd)/$(basename -- "$QNODE") ;;
esac

if [ ! -x "$QNODE" ]; then
  echo "qnode binary not found: $QNODE" >&2
  exit 1
fi

status=0
for file in "$here"/qnode/*.js; do
  name=$(basename "$file" .js)
  # net_shards is run through its wrapper below so a private subnet can be
  # configured first.
  [ "$name" = "net_shards" ] && continue
  echo "=== $name"
  if ! "$QNODE" "$file"; then
    echo "FAILED: $name" >&2
    status=1
  fi
done

# net_shards needs the wrapper to set up an optional private subnet.
echo "=== net_shards"
if ! QNODE="$QNODE" "$here/qnode/net_shards.sh"; then
  echo "FAILED: net_shards" >&2
  status=1
fi

exit "$status"
