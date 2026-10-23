#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
minebot routines save /solution/progression.ts
minebot bind action oracle progression
minebot run /solution/run-saved.ts --args '{"target":"wooden_pickaxe","builtins":true}' --timeout 900000
