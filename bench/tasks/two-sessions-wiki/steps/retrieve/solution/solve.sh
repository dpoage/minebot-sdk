#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
minebot run /solution/progression.ts --args '{"target":"retrieve_logs","builtins":false}' --timeout 900000
