#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
{ echo 'const TARGET = "diamond_pickaxe";'; cat /solution/progression.js; } \
  | minebot run --timeout 900000
# The pickaxe is made and the player is walled in. Keep it alive until the server's clock passes the end of the first night.
cat > /tmp/dawn.js <<'EOF'
while (bot.time.day < 1) {
  const foe = bot.nearestEntity((e) => e.kind === "Hostile mobs" && e.position.distanceTo(bot.entity.position) < 3.5);
  if (foe) bot.attack(foe);
  await sleep(1000);
}
return bot.time.time;
EOF
minebot run --timeout 1800000 /tmp/dawn.js
