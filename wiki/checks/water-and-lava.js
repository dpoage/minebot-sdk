// Holds while fluids have 16 levels, buckets stack as the page says, and obsidian is as hard as the page says.
export default async ({ bot }) => {
  const { blocksByName: blocks, itemsByName: items } = bot.registry;
  const wrong = [];
  for (const fluid of ["water", "lava"]) {
    const level = blocks[fluid].states.find((s) => s.name === "level");
    if (level?.num_values !== 16) wrong.push(`${fluid} level has ${level?.num_values} values`);
  }
  for (const [name, size] of [["bucket", 16], ["water_bucket", 1], ["lava_bucket", 1], ["milk_bucket", 1]]) {
    if (items[name]?.stackSize !== size) wrong.push(`${name} stacks to ${items[name]?.stackSize}`);
  }
  if (blocks.obsidian.hardness !== 50) wrong.push(`obsidian hardness is ${blocks.obsidian.hardness}`);
  if (typeof bot.activateItem !== "function") wrong.push("bot.activateItem is gone");
  if (wrong.length) throw new Error(wrong.join("; "));
  return { ok: true };
};
