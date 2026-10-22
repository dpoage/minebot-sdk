// Holds while the items and blocks the smelting page names exist, and a furnace takes 8 cobblestone.
export default async ({ bot }) => {
  const reg = bot.registry;
  const items = ["raw_iron", "iron_ingot", "raw_copper", "copper_ingot", "raw_gold", "gold_ingot", "coal", "charcoal", "coal_block", "lava_bucket", "stick", "oak_log", "oak_planks", "beef", "cooked_beef"];
  const blocks = ["furnace", "blast_furnace", "smoker"];
  const missing = [...items.filter((n) => !reg.itemsByName[n]), ...blocks.filter((n) => !reg.blocksByName[n])];
  if (missing.length) throw new Error(`the registry lacks: ${missing.join(", ")}`);
  if (typeof bot.openFurnace !== "function") throw new Error("bot.openFurnace is gone");
  const eightCobble = bot.recipesAll(reg.itemsByName.furnace.id, null, true).some((r) => r.delta.some((d) => reg.items[d.id].name === "cobblestone" && d.count === -8));
  if (!eightCobble) throw new Error("no furnace recipe takes 8 cobblestone");
  return { furnaceRecipe: "8 cobblestone" };
};
