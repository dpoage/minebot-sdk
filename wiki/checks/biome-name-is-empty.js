// Holds while prismarine-block leaves biome names empty and the registry resolves the id.
const here = bot.entity.position.floored();
const fromBlock = bot.blockAt(here).biome.name;
const fromRegistry = bot.registry.biomes[bot.world.getBiome(here)]?.name;
if (fromBlock !== "") throw new Error(`block biome name is now "${fromBlock}"; the quirk is gone`);
if (!fromRegistry) throw new Error("the registry did not resolve the biome id");
return { fromRegistry };
