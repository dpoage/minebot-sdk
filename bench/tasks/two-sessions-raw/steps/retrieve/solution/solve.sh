#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
{ echo 'const TARGET = "retrieve_logs";'; cat /solution/progression.js; } \
  | minebot run --timeout 900000
