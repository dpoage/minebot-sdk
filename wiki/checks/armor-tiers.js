// Holds while the durability, repair material, and recipe size of each armor piece match the page.
export default async ({ bot }) => {
  const items = bot.registry.itemsByName;
  const table = {
    leather: [55, 80, 75, 65, "leather"], golden: [77, 112, 105, 91, "gold_ingot"], chainmail: [165, 240, 225, 195, "iron_ingot"], iron: [165, 240, 225, 195, "iron_ingot"],
    diamond: [363, 528, 495, 429, "diamond"], netherite: [407, 592, 555, 481, "netherite_ingot"], copper: [121, 176, 165, 143, "copper_ingot"],
  };
  const wrong = [];
  for (const [tier, [h, c, l, b, repair]] of Object.entries(table)) {
    ["helmet", "chestplate", "leggings", "boots"].forEach((piece, i) => {
      const item = items[`${tier}_${piece}`];
      if (!item || item.maxDurability !== [h, c, l, b][i]) wrong.push(`${tier}_${piece}: durability ${item?.maxDurability}`);
      else if (item.repairWith?.[0] !== repair) wrong.push(`${tier}_${piece}: repaired with ${item.repairWith}`);
    });
  }
  // A set of iron takes 5, 8, 7, and 4 ingots.
  const ingots = ["helmet", "chestplate", "leggings", "boots"].map((piece) => {
    const recipe = bot.recipesAll(items[`iron_${piece}`].id, null, true)[0];
    return recipe.delta.filter((d) => d.count < 0).reduce((n, d) => n - d.count, 0);
  });
  if (ingots.join() !== "5,8,7,4") wrong.push(`iron armor takes ${ingots.join()} ingots`);
  if (wrong.length) throw new Error(`armor differs from the page: ${wrong.join(", ")}`);
  return { tiers: Object.keys(table).length, ironSet: ingots };
};
