#!/bin/sh
# Writes server.properties from the environment, then runs the server in the foreground.
set -eu

if [ "${EULA:-}" != "true" ]; then
  echo "Set EULA=true to accept the Minecraft EULA (https://aka.ms/MinecraftEULA)." >&2
  exit 1
fi
: "${RCON_PASSWORD:?RCON_PASSWORD is required}"

# RESTRICT_TO_OWN_SUBNET=true: refuse connections to the game and RCON ports from outside the container's own
# network. Rootless podman routes between the bridges of a compose project even when they are isolated, so a
# container on another network can reach this one by IP address. Its connections arrive translated to the
# gateway address of this network (netavark gives the gateway the first address), so the gateway is refused too.
# The container needs the NET_ADMIN capability.
if [ "${RESTRICT_TO_OWN_SUBNET:-}" = "true" ]; then
  subnet=$(ip -4 route show scope link | awk '{ print $1; exit }')
  : "${subnet:?cannot find the container's network}"
  gateway=$(echo "$subnet" | awk -F'[./]' '{ printf "%d.%d.%d.%d", $1, $2, $3, $4 + 1 }')
  nft -f - <<EOF
table inet guard {
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "lo" accept
    ip saddr ${gateway} tcp dport { 25565, 25575 } drop
    ip saddr ${subnet} accept
    tcp dport { 25565, 25575 } drop
  }
}
EOF
  echo "[entrypoint] only ${subnet} (not its gateway ${gateway}) may connect to ports 25565 and 25575" >&2
fi

cd /opt/minecraft
echo "eula=true" > eula.txt
cat > server.properties <<EOF
online-mode=false
server-port=25565
enable-rcon=true
rcon.port=25575
rcon.password=${RCON_PASSWORD}
broadcast-rcon-to-ops=false
level-seed=${LEVEL_SEED:-}
level-type=${LEVEL_TYPE:-minecraft:normal}
difficulty=${DIFFICULTY:-easy}
gamemode=${GAMEMODE:-survival}
spawn-protection=0
view-distance=${VIEW_DISTANCE:-8}
simulation-distance=${SIMULATION_DISTANCE:-8}
max-players=${MAX_PLAYERS:-8}
motd=minebot bench
EOF

exec java -Xmx"${MEMORY:-2G}" -jar server.jar --nogui
