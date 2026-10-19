// Holds while the registry's harvest tools and drops match the tier table on the page.
const reg = bot.registry;
// Strength of each pickaxe tier. Gold digs like wood, and copper like stone.
const level = { wooden: 0, golden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 };
const needs = {
  stone: 0, cobblestone: 0, coal_ore: 0,
  iron_ore: 1, copper_ore: 1, lapis_ore: 1,
  gold_ore: 2, diamond_ore: 2, emerald_ore: 2, redstone_ore: 2,
  obsidian: 3, ancient_debris: 3,
};
const tools = (name) => Object.keys(reg.blocksByName[name].harvestTools ?? {}).map((id) => reg.items[id].name).sort().join();
const problems = [];
for (const [name, min] of Object.entries(needs)) {
  const want = Object.keys(level).filter((t) => level[t] >= min).map((t) => `${t}_pickaxe`).sort().join();
  if (tools(name) !== want) problems.push(`${name}: registry says ${tools(name)}; page says ${want}`);
  const deep = reg.blocksByName[`deepslate_${name}`];
  if (deep && tools(`deepslate_${name}`) !== tools(name)) problems.push(`deepslate_${name} needs ${tools(`deepslate_${name}`)}`);
}
const drops = { iron_ore: "raw_iron", copper_ore: "raw_copper", gold_ore: "raw_gold", stone: "cobblestone", coal_ore: "coal", diamond_ore: "diamond" };
for (const [name, item] of Object.entries(drops)) {
  const got = reg.blocksByName[name].drops.map((id) => reg.items[id].name).join();
  if (got !== item) problems.push(`${name} drops ${got}, not ${item}`);
}
for (const name of ["oak_log", "dirt", "sand", "gravel", "oak_leaves"]) {
  if (reg.blocksByName[name].harvestTools) problems.push(`${name} now needs a tool`);
}
if (problems.length) throw new Error(problems.join("; "));
return { checked: Object.keys(needs).length };
