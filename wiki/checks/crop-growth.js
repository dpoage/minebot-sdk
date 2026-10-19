// Holds while the crop and farmland block states match the farming pages.
const blocks = bot.registry.blocksByName;
const stateSize = (block, name) => blocks[block].states.find((s) => s.name === name)?.num_values;
const wanted = { wheat: ["age", 8], carrots: ["age", 8], potatoes: ["age", 8], beetroots: ["age", 4], nether_wart: ["age", 4], melon_stem: ["age", 8], pumpkin_stem: ["age", 8], farmland: ["moisture", 8] };
const wrong = Object.entries(wanted).filter(([block, [state, n]]) => stateSize(block, state) !== n).map(([block, [state]]) => `${block}.${state} has ${stateSize(block, state)} values`);
for (const name of ["wheat_seeds", "bone_meal", "wooden_hoe", "wheat", "carrot", "potato", "beetroot_seeds", "melon_seeds", "pumpkin_seeds"]) {
  if (!bot.registry.itemsByName[name]) wrong.push(`item ${name} is missing`);
}
if (wrong.length) throw new Error(wrong.join("; "));
return { crops: Object.keys(wanted).length };
