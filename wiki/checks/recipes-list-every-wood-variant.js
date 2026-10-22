// Holds while Mineflayer expands "any planks" recipes into one recipe per wood type.
export default async ({ bot }) => {
  const id = bot.registry.itemsByName.wooden_pickaxe.id;
  const planks = new Set(
    bot.recipesAll(id, null, true).flatMap((r) =>
      r.delta.filter((d) => d.count < 0).map((d) => bot.registry.items[d.id].name).filter((n) => n.endsWith("_planks")),
    ),
  );
  if (planks.size < 2) throw new Error(`expected recipes for several plank types, got: ${[...planks].join(", ")}`);
  return [...planks];
};
