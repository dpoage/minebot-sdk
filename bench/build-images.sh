#!/bin/sh
# Builds the local images that benchmark tasks reference. Rerun after changing src/ or bench/.
# The names avoid the `localhost/` prefix on purpose: Harbor tears trials down with
# `compose down --rmi local`, and podman-compose treats every `localhost/` image as local and deletes it.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
engine=${CONTAINER_ENGINE:-podman}
mc_version=$(node --input-type=module -e "import { MC_VERSION } from 'file://$root/src/mc/version.ts'; process.stdout.write(MC_VERSION)")

"$engine" build -t "minebot.local/minebot-server:$mc_version" "$root/bench/images/server"
"$engine" build -t minebot.local/minebot:dev -f "$root/bench/images/minebot/Containerfile" "$root"
"$engine" build -t minebot.local/minebot-client:dev -f "$root/bench/images/client/Containerfile" "$root"
"$engine" build -t minebot.local/minebot-verifier:dev -f "$root/bench/images/verifier/Containerfile" "$root"
