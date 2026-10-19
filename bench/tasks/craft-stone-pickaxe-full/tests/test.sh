#!/bin/sh
set -eu
exec node /opt/verifier/bench/verify/check.ts /tests/milestones.json
