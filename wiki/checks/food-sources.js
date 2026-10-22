// Holds while the food values on the page match the registry.
export default async ({ bot }) => {
  const foods = bot.registry.foodsByName;
  const table = {
    cooked_beef: [8, 12.8], cooked_porkchop: [8, 12.8], cooked_mutton: [6, 9.6], cooked_chicken: [6, 7.2], cooked_salmon: [6, 9.6], cooked_cod: [5, 6],
    baked_potato: [5, 6], bread: [5, 6], beef: [3, 1.8], porkchop: [3, 1.8], mutton: [2, 1.2], chicken: [2, 1.2], rotten_flesh: [4, 0.8],
    apple: [4, 2.4], carrot: [3, 3.6], golden_carrot: [6, 14.4], cookie: [2, 0.4], melon_slice: [2, 1.2], sweet_berries: [2, 0.4], pumpkin_pie: [8, 4.8],
  };
  const wrong = Object.entries(table).filter(([name, [points, saturation]]) => {
    const f = foods[name];
    return !f || f.foodPoints !== points || Math.abs(f.saturation - saturation) > 0.01;
  }).map(([name]) => `${name} is ${JSON.stringify(foods[name] && [foods[name].foodPoints, foods[name].saturation])}`);
  if (wrong.length) throw new Error(`food values differ from the page: ${wrong.join("; ")}`);
  if (typeof bot.consume !== "function") throw new Error("bot.consume is gone");
  return { foods: Object.keys(table).length };
};
