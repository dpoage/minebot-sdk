// Holds while the registry has no furnace recipes: nothing that makes an ingot takes raw iron.
export default async ({ bot }) => {
  const reg = bot.registry;
  const rawIron = reg.itemsByName.raw_iron.id;
  const recipes = bot.recipesAll(reg.itemsByName.iron_ingot.id, null, true);
  if (recipes.some((r) => r.delta.some((d) => d.id === rawIron && d.count < 0))) throw new Error("the registry now has a smelting recipe for raw_iron");
  if (recipes.length === 0) throw new Error("iron_ingot has no recipes at all; expected the nugget and block ones");
  const cooked = bot.recipesAll(reg.itemsByName.cooked_beef.id, null, true);
  if (cooked.length > 0) throw new Error("cooked_beef now has a recipe in the registry");
  return { ironIngotRecipes: recipes.length, cookedBeefRecipes: cooked.length };
};
