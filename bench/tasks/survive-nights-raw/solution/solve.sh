#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
{ echo 'const TARGET = "shelter";'; cat /solution/progression.js; } \
  | minebot run --timeout 900000
# The shelter is built. Wait for the dawn that ends each night: each `day` event is one. A wait that times out counts for nothing.
nights=0
while [ "$nights" -lt 2 ]; do
  out=$(minebot wait --types day --timeout 1500000 || true)
  echo "$out"
  case "$out" in
    *"timed out"*) ;;
    *) nights=$((nights + 1)) ;;
  esac
done
