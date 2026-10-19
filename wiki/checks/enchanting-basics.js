// Holds while the enchantment levels on the page match the registry and the table API exists.
const reg = bot.registry;
const max = { sharpness: 5, efficiency: 5, protection: 4, unbreaking: 3, fortune: 3, looting: 3, silk_touch: 1, mending: 1, infinity: 1, power: 5 };
const wrong = Object.entries(max).filter(([name, level]) => reg.enchantmentsByName[name]?.maxLevel !== level).map(([name]) => `${name} max level is ${reg.enchantmentsByName[name]?.maxLevel}`);
if (reg.enchantmentsByName.mending?.treasureOnly !== true) wrong.push("mending is no longer treasure-only");
if (!reg.enchantmentsByName.sharpness.exclude.includes("smite")) wrong.push("sharpness no longer excludes smite");
if (!reg.blocksByName.enchanting_table || !reg.blocksByName.bookshelf) wrong.push("enchanting_table or bookshelf is missing");
if (typeof bot.openEnchantmentTable !== "function") wrong.push("bot.openEnchantmentTable is gone");
if (wrong.length) throw new Error(wrong.join("; "));
return { ok: true };
