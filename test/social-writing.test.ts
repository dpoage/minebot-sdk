import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Block, Item } from "minebot-sdk/routine";
import { createHarness, type HarnessOptions } from "minebot-sdk/testing";
import * as social from "../src/routines/social.ts";

type Side = "front" | "back";
const SIGN_AT = [2, 64, 0] as const;
const APPLICATORS = ["honeycomb", "red_dye", "ink_sac", "glow_ink_sac"] as const;

interface StringTag {
  type: "string";
  value: string;
}
interface ByteTag {
  type: "byte";
  value: number;
}
const str = (value: string): StringTag => ({ type: "string", value });
const byte = (value: number): ByteTag => ({ type: "byte", value });

/** One side of a sign as the server's block entity data carries it. */
interface SignFaceNbt {
  type: "compound";
  value: { messages: { type: "list"; value: { type: "string"; value: string[] } }; color: StringTag; has_glowing_text: ByteTag };
}
/** The block entity a 26.1 server sends for a sign. */
interface SignNbt {
  type: "compound";
  name: string;
  value: { is_waxed: ByteTag; front_text: SignFaceNbt; back_text: SignFaceNbt };
}
const signSide = (lines: readonly string[]): SignFaceNbt => ({
  type: "compound",
  value: { messages: { type: "list", value: { type: "string", value: [...lines] } }, color: str("black"), has_glowing_text: byte(0) },
});
const signEntity = (front: readonly string[], back: readonly string[], waxed = 0): SignNbt => ({
  type: "compound",
  name: "",
  value: { is_waxed: byte(waxed), front_text: signSide(front), back_text: signSide(back) },
});

/** What Mineflayer's client makes of a character outside the BMP in the NBT it reads: six replacement characters. */
const clientRead = (text: string) => text.replace(/[\u{10000}-\u{10FFFF}]/gu, "\uFFFD".repeat(6));

interface SignOptions extends Pick<HarnessOptions, "inventory" | "equipment" | "position"> {
  block?: string;
  at?: readonly [number, number, number];
  front?: readonly string[];
  back?: readonly string[];
  waxed?: boolean;
  /** What the server does with an edit: take it as sent, drop it, or change it. */
  server?: "keeps" | "drops" | ((line: string) => string);
  /** The server never opens the editor. */
  silent?: boolean;
}

/**
 * The harness bot has no sign editor. This gives it the members the routine reaches for, and plays the server's part: the server lets the held item
 * act on the sign first, so honeycomb waxes it, a dye or an ink sac changes its text, and a hanging sign in hand on a wall hanging sign tries to hang
 * another sign there and opens nothing; a ceiling hanging sign, a bare hand, or any other item opens the editor (`signOpen`).
 */
function signWorld(options: SignOptions = {}) {
  const at = options.at ?? SIGN_AT;
  const h = createHarness({
    blocks: [{ at, name: options.block ?? "oak_sign" }],
    inventory: options.inventory ?? {},
    ...(options.equipment && { equipment: options.equipment }),
    ...(options.position && { position: options.position }),
  });
  const { bot } = h;
  const entity = signEntity(options.front ?? ["", "", "", ""], options.back ?? ["", "", "", ""], options.waxed ? 1 : 0);
  Object.assign(h.blockAt(at), { entity });
  const hands: (string | undefined)[] = [];
  const updates: { text: string; back: boolean | undefined }[] = [];
  let editing = false;
  Object.assign(bot, {
    async activateBlock(block: Block) {
      const held = bot.heldItem?.name;
      hands.push(held);
      if (held === "honeycomb") entity.value.is_waxed = byte(1);
      else if (held && /_dye$/.test(held)) entity.value.front_text.value.color = str("blue");
      else if (held === "glow_ink_sac") entity.value.front_text.value.has_glowing_text = byte(1);
      else if (held === "ink_sac") entity.value.front_text.value.has_glowing_text = byte(0);
      else if (held && /hanging_sign$/.test(held) && /wall_hanging_sign$/.test(block.name)) {
        // tries to hang another sign there: this sign is untouched and no editor opens
      }
      else if (!options.silent && entity.value.is_waxed.value === 0) {
        editing = true;
        bot.emit("signOpen", block);
      }
    },
    updateSign(_block: Block, text: string, back?: boolean) {
      updates.push({ text, back });
      if (!editing || options.server === "drops") return;
      const edit = options.server === undefined || options.server === "keeps" ? (line: string) => line : options.server;
      const lines = text.split("\n").map((line) => clientRead(edit(line)));
      entity.value[back ? "back_text" : "front_text"].value.messages.value.value = Array.from({ length: 4 }, (_, i) => lines[i] ?? "");
    },
    setQuickBarSlot(slot: number) {
      (bot.inventory as unknown as { quickBarSlot: number }).quickBarSlot = slot;
    },
    async moveSlotItem(from: number, to: number) {
      const inv = bot.inventory as unknown as { slots: (Item | null)[]; set(slot: number, item: Item | null): void };
      inv.set(to, inv.slots[from] ?? null);
      inv.set(from, null);
    },
  });
  const read = (side: Side) => [...entity.value[`${side}_text`].value.messages.value.value];
  return { h, hands, updates, entity, read, at: { x: at[0], y: at[1], z: at[2] } };
}

describe("social.sign: the text on the sign is the text the server kept", () => {
  const cases: { kind: string; block: string; side?: Side }[] = [
    { kind: "standing", block: "oak_sign" },
    { kind: "standing", block: "oak_sign", side: "front" },
    { kind: "standing", block: "oak_sign", side: "back" },
    { kind: "wall", block: "oak_wall_sign" },
    { kind: "wall", block: "oak_wall_sign", side: "back" },
    { kind: "hanging", block: "oak_hanging_sign", side: "back" },
  ];
  for (const { kind, block, side } of cases) {
    it(`${kind} ${block}, ${side ?? "default side"}: returns the four lines the sign shows on that side, and leaves the other side alone`, async () => {
      const world = signWorld({ block, front: ["f1", "", "", ""], back: ["b1", "", "", ""] });
      for (const lines of [["Shop"], ["a", "b"], ["x".repeat(45), "", "c"], ["1", "2", "3", "4"], ["", "", "", "last"]]) {
        const result = await world.h.run(social.sign, { at: world.at, lines, ...(side && { side }) });
        const wanted = Array.from({ length: 4 }, (_, i) => lines[i] ?? "");
        const written: Side = side ?? "front";
        assert.deepEqual(result, { at: world.at, side: written, lines: wanted });
        assert.deepEqual(world.read(written), wanted);
        assert.deepEqual(world.read(written === "front" ? "back" : "front"), written === "front" ? ["b1", "", "", ""] : ["f1", "", "", ""]);
      }
      assert.ok(world.updates.every((u) => u.back === (side === "back")), "the side went to the server as given");
    });
  }

  it("takes the position as a tuple, and floors a fractional one", async () => {
    const world = signWorld();
    assert.deepEqual((await world.h.run(social.sign, { at: [2.7, 64.2, 0.9], lines: ["hi"] })).at, world.at);
  });

  it("sends the lines joined for the server's editor and nothing else", async () => {
    const world = signWorld();
    await world.h.run(social.sign, { at: world.at, lines: ["a", "", "c"] });
    assert.deepEqual(world.updates, [{ text: "a\n\nc", back: false }]);
  });

  it("characters outside the BMP (emoji) are written, and read back as the client decodes them", async () => {
    const world = signWorld();
    const result = await world.h.run(social.sign, { at: world.at, lines: ["gold 🪙 ünï", "🐉"] });
    assert.deepEqual(result.lines, ["gold 🪙 ünï", "🐉", "", ""]);
  });
});

describe("social.sign: errors say the cause and the fix", () => {
  async function refused(options: SignOptions, args: Record<string, unknown>, message: RegExp) {
    const world = signWorld(options);
    await assert.rejects(world.h.run(social.sign, { at: world.at, lines: ["x"], ...args } as never), message);
    return world;
  }

  it("no sign: names the block there and the place call", async () => {
    const world = await refused({ block: "stone" }, {}, /no sign at \(2, 64, 0\).*the block there is stone.*place\.place\(\{ at: \{ x: 2, y: 64, z: 0 \}, item: "oak_sign" \}\)/);
    assert.deepEqual([world.hands.length, world.updates.length], [0, 0]);
  });

  it("nothing but air there names air", async () => {
    const h = createHarness();
    await assert.rejects(h.run(social.sign, { at: [5, 64, 5], lines: ["x"] }), /there is no sign at \(5, 64, 5\).*the block there is air/);
  });

  it("a waxed sign: names waxed and the fresh-sign fix, recommends no call that does not work, and never uses the sign", async () => {
    const world = signWorld({ waxed: true });
    const message = await world.h.run(social.sign, { at: world.at, lines: ["x"] }).then(
      () => "wrote a waxed sign",
      (error: Error) => error.message,
    );
    assert.match(message, /oak_sign at \(2, 64, 0\) is waxed.*never be edited.*fresh sign.*social\.sign/);
    assert.doesNotMatch(message, /dig\.dig/, "dig.dig cannot break a sign (it returns {block:null} and leaves it)");
    assert.doesNotMatch(message, /item: "/, "wall sign blocks are not items");
    assert.deepEqual([world.hands.length, world.updates.length], [0, 0]);
  });

  it("out of reach: names the distance and says to walk", async () => {
    const world = await refused({ at: [12, 64, 0] }, { at: { x: 12, y: 64, z: 0 } }, /is 12\.\d blocks from the bot's eyes.*4\.5.*move\.to/);
    assert.deepEqual([world.hands.length, world.updates.length], [0, 0]);
  });

  it("a server that does not open the editor: says so and why, and writes nothing", async () => {
    const world = await refused({ silent: true }, {}, /did not open the oak_sign at \(2, 64, 0\) for editing within 3 s/);
    assert.equal(world.updates.length, 0);
  });

  it("a server that takes the edit but leaves the sign unchanged is an error naming what the sign shows", async () => {
    const world = await refused({ server: "drops", front: ["old", "", "", ""] }, { lines: ["new"] }, /front of the sign at \(2, 64, 0\) shows \["old","","",""\] instead of \["new","","",""\]/);
    assert.equal(world.updates.length, 1);
  });

  it("a server that changes the text is an error naming what it kept", async () => {
    await refused({ server: (line) => line.replaceAll("§", "") }, { lines: ["pre §4red"] }, /shows \["pre 4red","","",""\] instead of \["pre §4red","","",""\]/);
  });

  it("the lines schema names each limit", async () => {
    const world = signWorld();
    const refuse = (lines: unknown, message: RegExp) => assert.rejects(world.h.run(social.sign, { at: world.at, lines } as never), message);
    await refuse([], /give 1 to 4 lines/);
    await refuse(["a", "b", "c", "d", "e"], /at most|4 lines at most/);
    await refuse(["x".repeat(46)], /holds at most 45 characters/);
    await refuse(["a\nb"], /cannot contain a line break/);
    await assert.rejects(world.h.run(social.sign, { at: world.at, lines: ["x"], side: "left" } as never), /front.*back/);
    assert.equal(world.updates.length, 0);
    await world.h.run(social.sign, { at: world.at, lines: ["x".repeat(45), "b", "c", "d"] });
  });

  it("the line limit counts characters as the server does: 45 UTF-16 units pass, an emoji in the 46th unit is refused", async () => {
    const world = signWorld();
    const emoji = "\u{1F600}";
    await world.h.run(social.sign, { at: world.at, lines: [`${emoji.repeat(22)}x`] });
    await assert.rejects(world.h.run(social.sign, { at: world.at, lines: [emoji.repeat(23)] }), /a sign line holds at most 45 characters as the server counts them \(an emoji counts as 2\)/);
    assert.equal(world.updates.length, 1, "the refused line never reached the server");
  });
});

describe("social.sign: the write uses a hand the server will open the editor for", () => {
  const heldCases: { held: string; block: string; hand: string }[] = [
    ...APPLICATORS.map((held) => ({ held, block: "oak_sign", hand: "bread" })),
    { held: "oak_hanging_sign", block: "oak_wall_hanging_sign", hand: "bread" },
    { held: "oak_hanging_sign", block: "oak_hanging_sign", hand: "oak_hanging_sign" },
    { held: "bread", block: "oak_sign", hand: "bread" },
    { held: "oak_sign", block: "oak_sign", hand: "oak_sign" },
    { held: "dirt", block: "oak_wall_hanging_sign", hand: "dirt" },
  ];
  for (const { held, block, hand } of heldCases) {
    it(`${held} in the main hand on a ${block}: the sign is used with ${hand} in hand, written, unwaxed and uncolored, and everything restored`, async () => {
      const world = signWorld({ block, inventory: { [held]: 1, bread: 2 }, equipment: { hand: held } });
      assert.equal(world.h.bot.heldItem?.name, held);
      const heldBefore = world.h.count(held);
      const result = await world.h.run(social.sign, { at: world.at, lines: ["board"] });
      assert.deepEqual(result.lines, ["board", "", "", ""]);
      assert.deepEqual(world.hands, [hand], "the sign is used with a hand the server opens its editor for");
      assert.equal(world.entity.value.is_waxed.value, 0);
      assert.equal(world.entity.value.front_text.value.color.value, "black");
      assert.equal(world.entity.value.front_text.value.has_glowing_text.value, 0);
      assert.equal(world.h.bot.quickBarSlot, 0, "the selected hotbar slot is restored");
      assert.equal(world.h.bot.heldItem?.name, held);
      assert.equal(world.h.count(held), heldBefore);
    });
  }

  it("all 36 slots hold the held item: an ordinary item still opens the editor, so the sign is written with nothing set aside", async () => {
    for (const [item, count] of [
      ["dirt", 2304],
      ["oak_sign", 576],
    ] as const) {
      const world = signWorld({ inventory: { [item]: count }, equipment: { hand: item } });
      const result = await world.h.run(social.sign, { at: world.at, lines: ["full"] });
      assert.deepEqual(result.lines, ["full", "", "", ""]);
      assert.deepEqual(world.hands, [item], "the held item is used as it is");
      assert.equal(world.h.bot.quickBarSlot, 0);
      assert.equal(world.h.count(item), count);
    }
  });

  it("an inventory full of hanging signs, on a ceiling hanging sign: the held item is used as it is and the sign is written", async () => {
    const world = signWorld({ block: "oak_hanging_sign", inventory: { oak_hanging_sign: 576 }, equipment: { hand: "oak_hanging_sign" } });
    const result = await world.h.run(social.sign, { at: world.at, lines: ["ceiling"] });
    assert.deepEqual(result.lines, ["ceiling", "", "", ""]);
    assert.deepEqual(world.hands, ["oak_hanging_sign"], "a hanging sign item opens a ceiling hanging sign's editor");
    assert.equal(world.h.bot.quickBarSlot, 0);
    assert.equal(world.h.count("oak_hanging_sign"), 576);
    assert.equal(world.entity.value.is_waxed.value, 0);
  });

  it("the same full inventory on a wall hanging sign: no choice opens the editor, so it throws naming the stacks", async () => {
    const world = signWorld({ block: "oak_wall_hanging_sign", inventory: { oak_hanging_sign: 576 }, equipment: { hand: "oak_hanging_sign" } });
    await assert.rejects(
      world.h.run(social.sign, { at: world.at, lines: ["x"] }),
      /every hotbar stack holds one of \["oak_hanging_sign"\], which acts on the oak_wall_hanging_sign instead of opening its editor.*Free one hotbar slot \(inventory\.toss\)/,
    );
    assert.deepEqual([world.hands.length, world.updates.length], [0, 0]);
    assert.equal(world.entity.value.is_waxed.value, 0);
  });

  it("every hotbar stack acts on the sign, with the main grid free: the held stack waits there and comes back to its slot", async () => {
    const stuff = { honeycomb: 1, ink_sac: 1, glow_ink_sac: 1, red_dye: 1, blue_dye: 1, green_dye: 1, black_dye: 1, white_dye: 1, yellow_dye: 1 };
    const world = signWorld({ inventory: stuff, equipment: { hand: "honeycomb" } });
    const slot = world.h.bot.quickBarSlot;
    await world.h.run(social.sign, { at: world.at, lines: ["x"] });
    assert.deepEqual(world.hands, [undefined], "the held stack is moved out of the hand entirely");
    assert.equal(world.h.bot.quickBarSlot, slot);
    assert.equal(world.h.bot.heldItem?.name, "honeycomb");
    const inv = world.h.bot.inventory as unknown as { slots: (Item | null)[] };
    assert.ok(inv.slots.slice(9, 36).every((stack) => stack === null), "the main grid is empty again");
  });

  it("a full inventory whose held stack acts on the sign: another hotbar stack stands in and the hand is restored", async () => {
    const world = signWorld({ block: "oak_wall_hanging_sign", inventory: { oak_hanging_sign: 1, dirt: 2240 }, equipment: { hand: "oak_hanging_sign" } });
    const result = await world.h.run(social.sign, { at: world.at, lines: ["swap"] });
    assert.deepEqual(result.lines, ["swap", "", "", ""]);
    assert.deepEqual(world.hands, ["dirt"], "an ordinary hotbar stack is switched to for the write");
    assert.equal(world.h.bot.quickBarSlot, 0, "the selected hotbar slot is restored");
    assert.equal(world.h.bot.heldItem?.name, "oak_hanging_sign");
  });

  it("36 slots of honeycomb: no choice opens the editor, so it throws naming it and touches nothing", async () => {
    const world = signWorld({ inventory: { honeycomb: 2304 }, equipment: { hand: "honeycomb" } });
    await assert.rejects(
      world.h.run(social.sign, { at: world.at, lines: ["x"] }),
      /every hotbar stack holds one of \["honeycomb"\], which acts on the oak_sign instead of opening its editor.*no free slot to set one aside in.*Free one hotbar slot \(inventory\.toss\)/,
    );
    assert.deepEqual([world.hands.length, world.updates.length], [0, 0]);
    assert.equal(world.entity.value.is_waxed.value, 0);
  });

  it("a full inventory whose whole hotbar acts on the sign: throws naming every stack, and touches nothing", async () => {
    const filler = [
      "honeycomb", "ink_sac", "glow_ink_sac", "white_dye", "light_gray_dye", "gray_dye", "black_dye", "brown_dye", "red_dye",
      "orange_dye", "yellow_dye", "lime_dye", "green_dye", "cyan_dye", "light_blue_dye", "blue_dye", "purple_dye", "magenta_dye",
      "pink_dye", "bread", "apple", "stick", "coal", "charcoal", "dirt", "cobblestone", "sand", "gravel", "oak_log", "birch_log",
      "spruce_log", "stone", "granite", "diorite", "andesite", "iron_ingot",
    ];
    const world = signWorld({ inventory: Object.fromEntries(filler.map((name) => [name, 1])), equipment: { hand: "honeycomb" } });
    await assert.rejects(
      world.h.run(social.sign, { at: world.at, lines: ["x"] }),
      /every hotbar stack holds one of \["honeycomb","ink_sac","glow_ink_sac","white_dye","light_gray_dye","gray_dye","black_dye","brown_dye","red_dye"\].*no free slot to set one aside in/,
    );
    assert.deepEqual([world.hands.length, world.updates.length], [0, 0]);
    assert.equal(world.entity.value.is_waxed.value, 0);
  });
});

// ---- books

/** The component an item holds its pages in, in the two shapes the server sends. */
const writableContent = (pages: readonly string[]) => ({ type: "writable_book_content", data: { pages: pages.map((content) => ({ content })) } });
const writtenContent = (title: string, author: string, pages: readonly string[]) => ({
  type: "written_book_content",
  data: { rawTitle: title, author, pages: pages.map((page) => ({ content: str(clientRead(page)) })) },
});

interface BookOptions {
  /** The slot the book starts in (a grid slot makes Mineflayer move it to the hotbar and back). */
  slot?: number;
  holds?: readonly string[];
  /** The custom name the book carries. */
  named?: string;
  /** More writable_books, each in its own slot. */
  others?: readonly { slot: number; holds?: readonly string[]; named?: string }[];
  /** What the server does with an edit. */
  server?: "keeps" | "drops" | "other-author" | "other-title" | "trims";
  noBook?: boolean;
}

function bookWorld(options: BookOptions = {}) {
  const h = createHarness({ inventory: options.noBook ? { bread: 1, book: 1, feather: 1 } : { bread: 1 } });
  const inv = h.bot.inventory as unknown as { make(name: string, count: number): Item; set(slot: number, item: Item | null): void; slots: (Item | null)[] };
  const slot = options.slot ?? 10;
  const put = (at: number, holds: readonly string[] = [], named?: string) => {
    const stack = inv.make("writable_book", 1);
    Object.assign(stack, { componentMap: new Map([["writable_book_content", writableContent(holds)]]) });
    if (named !== undefined) stack.customName = { type: "string", value: named } as unknown as string;
    inv.set(at, stack);
  };
  if (!options.noBook) put(slot, options.holds, options.named);
  for (const other of options.others ?? []) put(other.slot, other.holds, other.named);
  const calls: { call: "writeBook" | "signBook"; slot: number; pages: string[]; author?: string; title?: string }[] = [];
  Object.assign(h.bot, {
    async writeBook(at: number, pages: string[]) {
      calls.push({ call: "writeBook", slot: at, pages });
      const stack = inv.slots[at];
      if (!stack || options.server === "drops") return;
      // Mineflayer carries the book to the hotbar to edit it and back, and the stack's own slot follows it.
      stack.slot = 36;
      const kept = options.server === "trims" ? pages.map((page) => page.trim().slice(0, 3)) : pages;
      Object.assign(stack, { componentMap: new Map([["writable_book_content", writableContent(kept)]]) });
    },
    async signBook(at: number, pages: string[], author: string, title: string) {
      calls.push({ call: "signBook", slot: at, pages, author, title });
      const stack = inv.slots[at];
      if (!stack || options.server === "drops") return;
      stack.slot = 36;
      const signed = inv.make("written_book", 1);
      const [keptAuthor, keptTitle] = [options.server === "other-author" ? "someone" : author, options.server === "other-title" ? "Other" : title];
      Object.assign(signed, { componentMap: new Map([["written_book_content", writtenContent(keptTitle, keptAuthor, pages)]]) });
      inv.set(at, signed);
    },
  });
  const held = (at = options.slot ?? 10) => inv.slots[at];
  return { h, calls, held };
}

const pagesOf = (stack: Item | null | undefined): string[] => {
  const data = (stack as unknown as { componentMap: Map<string, { data: { pages: { content: unknown }[] } }> }).componentMap.values().next().value?.data;
  return (data?.pages ?? []).map((page) => (typeof page.content === "string" ? page.content : String((page.content as { value: string }).value)));
};

describe("social.book: the book holds what was written", () => {
  for (const slot of [10, 40]) {
    it(`unsigned, book in slot ${slot}: stays a writable_book with exactly these pages`, async () => {
      const { h, calls, held } = bookWorld({ slot });
      const pages = ["Entry one\nline two", "§a second", "x".repeat(1024)];
      const result = await h.run(social.book, { pages });
      assert.deepEqual(result, { item: "writable_book", pages: 3 });
      assert.equal(held(slot)?.name, "writable_book");
      assert.deepEqual(pagesOf(held(slot)), pages);
      assert.deepEqual(calls, [{ call: "writeBook", slot, pages }]);
    });

    it(`signed, book in slot ${slot}: becomes a written_book with the title, the bot as author, and these pages`, async () => {
      const { h, calls, held } = bookWorld({ slot });
      const result = await h.run(social.book, { pages: ["One", "Two"], title: "Ledger of Rivet" });
      assert.deepEqual(result, { item: "written_book", title: "Ledger of Rivet", pages: 2 });
      assert.equal(held(slot)?.name, "written_book");
      assert.deepEqual(pagesOf(held(slot)), ["One", "Two"]);
      assert.deepEqual(calls, [{ call: "signBook", slot, pages: ["One", "Two"], author: "harness", title: "Ledger of Rivet" }]);
      const written = (held(slot) as unknown as { componentMap: Map<string, { data: { rawTitle: string; author: string } }> }).componentMap.get("written_book_content")?.data;
      assert.deepEqual([written?.rawTitle, written?.author], ["Ledger of Rivet", "harness"]);
    });
  }

  it("a signed book whose pages hold emoji: the client's decoding of them is not a mismatch", async () => {
    const { h } = bookWorld();
    assert.deepEqual(await h.run(social.book, { pages: ["Dragon 🐉 hoard"], title: "Hoard" }), { item: "written_book", title: "Hoard", pages: 1 });
  });

  it("a book that already holds these pages is done without an edit the server would never answer", async () => {
    const { h, calls } = bookWorld({ holds: ["same", "pages"] });
    assert.deepEqual(await h.run(social.book, { pages: ["same", "pages"], book: "first" }), { item: "writable_book", pages: 2 });
    assert.equal(calls.length, 0);
  });

  it("the same pages with a title still sign the book", async () => {
    const { h, calls } = bookWorld({ holds: ["same"] });
    await h.run(social.book, { pages: ["same"], title: "T", book: "first" });
    assert.equal(calls.length, 1);
  });

  it('book: "first" rewrites a ledger with new pages', async () => {
    const { h, held } = bookWorld({ slot: 12, holds: ["old"] });
    await h.run(social.book, { pages: ["new 1", "new 2"], book: "first" });
    assert.deepEqual(pagesOf(held(12)), ["new 1", "new 2"]);
  });
});

describe("social.book: the default writes a blank book and never changes one that holds writing", () => {
  it("the incident: a ledger, then a signed contract, land in two different books", async () => {
    const { h, calls, held } = bookWorld({ slot: 10, others: [{ slot: 11 }] });
    assert.deepEqual(await h.run(social.book, { pages: ["ledger entry"] }), { item: "writable_book", pages: 1 });
    assert.deepEqual(await h.run(social.book, { pages: ["the contract"], title: "Contract" }), { item: "written_book", title: "Contract", pages: 1 });
    assert.deepEqual(calls.map(({ call, slot }) => [call, slot]), [["writeBook", 10], ["signBook", 11]]);
    assert.equal(held(10)?.name, "writable_book");
    assert.deepEqual(pagesOf(held(10)), ["ledger entry"]);
    assert.equal(held(11)?.name, "written_book");
  });

  it('book: "new" is the default: naming it changes nothing', async () => {
    const { h, calls } = bookWorld({ slot: 10, holds: ["writing"], others: [{ slot: 12 }] });
    await h.run(social.book, { pages: ["p"], book: "new" });
    assert.deepEqual(calls.map(({ slot }) => slot), [12]);
  });

  it("a book of only empty pages is blank; a page of spaces is writing", async () => {
    const empty = bookWorld({ slot: 10, holds: ["", ""], others: [{ slot: 11 }] });
    await empty.h.run(social.book, { pages: ["p"] });
    assert.deepEqual(empty.calls.map(({ slot }) => slot), [10]);
    const spaces = bookWorld({ slot: 10, holds: ["   "], others: [{ slot: 11 }] });
    await spaces.h.run(social.book, { pages: ["p"] });
    assert.deepEqual(spaces.calls.map(({ slot }) => slot), [11]);
  });

  it("every book holds writing: throws naming the fix and the book first would rewrite, and changes nothing", async () => {
    const { h, calls, held } = bookWorld({ slot: 12, holds: ["debts", "owed"], named: "Ledger", others: [{ slot: 40, holds: ["x"] }] });
    await assert.rejects(
      h.run(social.book, { pages: ["p"], title: "Contract" }),
      /no blank book and quill.*all 2 writable_books.*craft\.craft: book \+ ink_sac \+ feather.*book: "first".*the book and quill named "Ledger" \(2 pages\) in slot 12.*main inventory grid, then the hotbar/,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(pagesOf(held(12)), ["debts", "owed"]);
    assert.deepEqual(pagesOf(held(40)), ["x"]);
  });

  it("an unnamed book that holds writing is named as unnamed, with its page count", async () => {
    const { h } = bookWorld({ holds: ["only page"] });
    await assert.rejects(h.run(social.book, { pages: ["p"] }), /would rewrite the unnamed book and quill \(1 page\) in slot 10/);
  });

  it("a book and quill in the off-hand is not searched", async () => {
    const { h, calls } = bookWorld({ noBook: true, others: [{ slot: 45 }] });
    await assert.rejects(h.run(social.book, { pages: ["p"] }), /no writable_book/);
    assert.equal(calls.length, 0);
  });
});

describe('social.book: book: "first" rewrites the first unsigned writable_book, main grid before hotbar', () => {
  const boundary = () => bookWorld({ slot: 12, holds: ["debts"], named: "Ledger", others: [{ slot: 36 }] });

  it("boundary: a renamed Ledger in the main grid and a blank book in the hotbar: first picks the Ledger and returns its name", async () => {
    const { h, calls, held } = boundary();
    assert.deepEqual(await h.run(social.book, { pages: ["new debts"], book: "first" }), { item: "writable_book", name: "Ledger", pages: 1 });
    assert.deepEqual(calls.map(({ slot }) => slot), [12]);
    assert.deepEqual(pagesOf(held(12)), ["new debts"]);
  });

  it("boundary: the default picks the blank hotbar book and returns no name", async () => {
    const { h, calls, held } = boundary();
    assert.deepEqual(await h.run(social.book, { pages: ["fresh"] }), { item: "writable_book", pages: 1 });
    assert.deepEqual(calls.map(({ slot }) => slot), [36]);
    assert.deepEqual(pagesOf(held(12)), ["debts"]);
  });

  it("first with a title signs the first book and returns its name", async () => {
    const { h, calls } = boundary();
    assert.deepEqual(await h.run(social.book, { pages: ["done"], title: "Contract", book: "first" }), { item: "written_book", title: "Contract", name: "Ledger", pages: 1 });
    assert.deepEqual(calls.map(({ call, slot }) => [call, slot]), [["signBook", 12]]);
  });

  it("the lowest slot wins inside the main grid and inside the hotbar", async () => {
    const grid = bookWorld({ slot: 30, others: [{ slot: 9 }, { slot: 20 }] });
    await grid.h.run(social.book, { pages: ["p"], book: "first" });
    assert.deepEqual(grid.calls.map(({ slot }) => slot), [9]);
    const bar = bookWorld({ slot: 44, others: [{ slot: 38 }] });
    await bar.h.run(social.book, { pages: ["p"], book: "first" });
    assert.deepEqual(bar.calls.map(({ slot }) => slot), [38]);
  });

  it("an argument other than new or first is refused", async () => {
    const { h, calls } = bookWorld();
    await assert.rejects(h.run(social.book, { pages: ["p"], book: "last" } as never), /book/);
    assert.equal(calls.length, 0);
  });
});

describe("social.book: a write the server did not keep is an error", () => {
  it("a server that takes the edit and leaves the book unchanged: names what the book holds", async () => {
    const { h } = bookWorld({ server: "drops", holds: ["old page"] });
    await assert.rejects(h.run(social.book, { pages: ["new page"], book: "first" }), /slot 10 holds a writable_book with 1 page \["old page"\] instead of the writable_book that was written/);
  });

  it("a signing the server did not take: says the book is still a writable_book", async () => {
    const { h } = bookWorld({ server: "drops" });
    await assert.rejects(h.run(social.book, { pages: ["p"], title: "T" }), /holds a writable_book with 0 pages.*instead of the written_book/);
  });

  it("pages the server changed: names what it kept", async () => {
    const { h } = bookWorld({ server: "trims" });
    await assert.rejects(h.run(social.book, { pages: ["  padded page  "] }), /holds a writable_book with 1 page \["pad"\]/);
  });

  it("a signed book with another author or title is not the book that was asked for", async () => {
    await assert.rejects(bookWorld({ server: "other-author" }).h.run(social.book, { pages: ["p"], title: "T" }), /by "someone"/);
    await assert.rejects(bookWorld({ server: "other-title" }).h.run(social.book, { pages: ["p"], title: "T" }), /titled "Other"/);
  });

  it("a write Mineflayer gives up on: names the cause and says the book was not written", async () => {
    const { h } = bookWorld();
    Object.assign(h.bot, {
      async writeBook() {
        throw new Error("Event updateSlot:36 did not fire within timeout of 20000ms");
      },
    });
    await assert.rejects(h.run(social.book, { pages: ["p"] }), /did not confirm the book edit \(Event updateSlot:36 did not fire.*the book was not written/);
  });
});

describe("social.book: errors say the cause and the fix", () => {
  it("no writable_book: names it and the recipe, and writes nothing", async () => {
    const { h, calls } = bookWorld({ noBook: true });
    await assert.rejects(h.run(social.book, { pages: ["p"] }), /no writable_book.*book \+ ink_sac \+ feather/);
    assert.equal(calls.length, 0);
  });

  it("the schema names each limit and no refused call writes", async () => {
    const { h, calls } = bookWorld();
    const refuse = (args: Record<string, unknown>, message: RegExp) => assert.rejects(h.run(social.book, args as never), message);
    await refuse({ pages: [] }, /at least 1 page/);
    await refuse({ pages: Array.from({ length: 101 }, () => "x") }, /at most 100 pages/);
    await refuse({ pages: [""] }, /page cannot be empty/);
    await refuse({ pages: ["x".repeat(1025)] }, /page holds at most 1024 characters/);
    await refuse({ pages: ["p"], title: "t".repeat(33) }, /title holds at most 32 characters/);
    await refuse({ pages: ["p"], title: "   " }, /title is blank/);
    await refuse({ pages: ["p"], title: "" }, /title is blank/);
    await refuse({ pages: "not a list" }, /pages/);
    assert.equal(calls.length, 0);
  });

  it("the page and title limits count characters as the server does: an emoji counts as 2", async () => {
    const { h, calls } = bookWorld({ others: [{ slot: 11 }] });
    const emoji = "\u{1F600}";
    const refuse = (args: Record<string, unknown>, message: RegExp) => assert.rejects(h.run(social.book, args as never), message);
    await h.run(social.book, { pages: [emoji.repeat(512)] });
    await h.run(social.book, { pages: ["p"], title: `${emoji.repeat(15)}xx` });
    await refuse({ pages: [emoji.repeat(513)] }, /a book page holds at most 1024 characters as the server counts them \(an emoji counts as 2\)/);
    await refuse({ pages: [emoji.repeat(600)] }, /a book page holds at most 1024 characters as the server counts them \(an emoji counts as 2\)/);
    await refuse({ pages: ["p"], title: emoji.repeat(17) }, /a book title holds at most 32 characters as the server counts them \(an emoji counts as 2\)/);
    assert.equal(calls.length, 2, "the refused pages and titles never reached the server");
  });

  it("the limits themselves are accepted", async () => {
    const { h } = bookWorld();
    assert.equal((await h.run(social.book, { pages: Array.from({ length: 100 }, () => "x".repeat(1024)) })).pages, 100);
    assert.equal((await bookWorld().h.run(social.book, { pages: ["p"], title: "t".repeat(32) })).title, "t".repeat(32));
  });
});
