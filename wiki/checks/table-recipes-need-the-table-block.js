// Holds while 3x3 recipes are hidden without a crafting table.
const id = bot.registry.itemsByName.wooden_pickaxe.id;
const without = bot.recipesAll(id, null, null).length;
const withTable = bot.recipesAll(id, null, true);
if (without !== 0) throw new Error(`expected no wooden_pickaxe recipes without a table, got ${without}`);
if (withTable.length === 0 || !withTable.every((r) => r.requiresTable)) throw new Error("expected table recipes for wooden_pickaxe");
return { withTable: withTable.length };
