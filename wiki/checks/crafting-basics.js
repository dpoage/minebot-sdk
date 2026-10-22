// Holds while the recipes in the crafting page's table match the registry.
export default async ({ bot }) => {
  const reg = bot.registry;
  const id = (name) => reg.itemsByName[name].id;
  // Ingredient counts of one recipe, and the grid it needs.
  const cost = (r) => r.delta.filter((d) => d.count < 0).map((d) => ({ name: reg.items[d.id].name, count: -d.count }));
  const made = (r) => r.delta.find((d) => d.count > 0).count;
  const total = (r, test) => cost(r).filter((c) => test(c.name)).reduce((n, c) => n + c.count, 0);
  const problems = [];
  const expect = (what, ok) => { if (!ok) problems.push(what); };
  const one = (name) => bot.recipesAll(id(name), null, true);
  const any = (name, test) => one(name).some(test);
  expect("oak_planks: 1 log -> 4, 2x2", any("oak_planks", (r) => !r.requiresTable && made(r) === 4 && total(r, (n) => n === "oak_log") === 1));
  expect("stick: 2 planks -> 4, 2x2", any("stick", (r) => !r.requiresTable && made(r) === 4 && total(r, (n) => n.endsWith("_planks")) === 2));
  expect("crafting_table: 4 planks, 2x2", any("crafting_table", (r) => !r.requiresTable && total(r, (n) => n.endsWith("_planks")) === 4));
  expect("torch: 4 from coal or charcoal + stick, 2x2", any("torch", (r) => !r.requiresTable && made(r) === 4 && total(r, (n) => n === "stick") === 1 && total(r, (n) => n === "coal" || n === "charcoal") === 1));
  for (const [tool, head] of [["pickaxe", 3], ["axe", 3], ["shovel", 1], ["sword", 2]]) {
    expect(`wooden_${tool}: ${head} planks + stick, 3x3`, any(`wooden_${tool}`, (r) => r.requiresTable && total(r, (n) => n.endsWith("_planks")) === head));
    expect(`iron_${tool}: ${head} iron_ingot`, any(`iron_${tool}`, (r) => r.requiresTable && total(r, (n) => n === "iron_ingot") === head));
  }
  expect("stick count of a pickaxe is 2", any("wooden_pickaxe", (r) => total(r, (n) => n === "stick") === 2));
  expect("sword takes 1 stick", any("wooden_sword", (r) => total(r, (n) => n === "stick") === 1));
  expect("furnace: 8 cobblestone, 3x3", any("furnace", (r) => r.requiresTable && total(r, (n) => n === "cobblestone") === 8));
  expect("chest: 8 planks, 3x3", any("chest", (r) => r.requiresTable && total(r, (n) => n.endsWith("_planks")) === 8));
  if (problems.length) throw new Error(problems.join("; "));
  return { checked: "planks, stick, table, torch, four tools in two tiers, furnace, chest" };
};
