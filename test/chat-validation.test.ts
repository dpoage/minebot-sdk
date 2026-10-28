// Chat is validated before it is sent, on both paths that send it: POST /chat (what send_chat and the
// client reach) and social.say. A message the 26.1 server would disconnect the body for — a control
// character, U+007F, the section sign — is refused with the character and its position; a message past
// the 256-unit limit is refused with the count in the units the server counts (UTF-16, an emoji is 2),
// the whisper prefix included.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import { bodyRoutes, serve, type RouteDeps } from "../src/host/routes.ts";
import { ChatInput, type BodyFeatures } from "../src/protocol/index.ts";
import * as social from "../src/routines/social.ts";

const FEATURES: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };

/** The real route table over a body that records what it was asked to say, so a refused message never reaches `chat`. */
function chatApi() {
  const sent: string[] = [];
  const body = { features: FEATURES, chat: (message: string) => void sent.push(message) } as unknown as RouteDeps["body"];
  const routes = bodyRoutes({ body, builtins: {} as RouteDeps["builtins"], recorder: {} as RouteDeps["recorder"] });
  const post = (message: string) => serve(routes, body, { id: 1, method: "POST", url: "/chat", body: JSON.stringify({ message }), tooLarge: false });
  return { sent, post };
}

/** The one error message of a 400 answer, or the status of any other answer. */
async function refusal(answer: Promise<{ status: number; body: unknown }>): Promise<string> {
  const { status, body } = await answer;
  assert.equal(status, 400, JSON.stringify(body));
  const { error } = body as { error: string };
  return error;
}

describe("POST /chat refuses what the server would disconnect the body for", () => {
  it("names a tab and its index, and sends nothing", async () => {
    const api = chatApi();
    const error = await refusal(api.post("a\tb"));
    assert.match(error, /\\u0009/);
    assert.match(error, /U\+0009/);
    assert.match(error, /index 1/);
    assert.deepEqual(api.sent, []);
  });

  it("names the section sign, a newline, and U+007F by code point", async () => {
    const api = chatApi();
    assert.match(await refusal(api.post("color §c red")), /§.*U\+00A7.*index 6/);
    assert.match(await refusal(api.post("one\ntwo")), /\\u000A.*U\+000A.*index 3/);
    assert.match(await refusal(api.post("x\u007fy")), /\\u007F.*U\+007F.*index 1/);
    assert.match(await refusal(api.post("\u0001bell")), /\\u0001.*U\+0001.*index 0/);
    assert.deepEqual(api.sent, []);
  });

  it("sends ordinary text, emoji and a leading / command unchanged", async () => {
    const api = chatApi();
    for (const message of ["hi there", "gold 🪙 for sale", "/time set day"]) {
      assert.deepEqual(await api.post(message), { status: 200, body: { sent: true } });
    }
    assert.deepEqual(api.sent, ["hi there", "gold 🪙 for sale", "/time set day"]);
  });
});

describe("the 256 limit is counted in UTF-16 code units", () => {
  it("keeps ChatInput.shape.message.maxLength at 256 (C3: mcp.ts reads it)", () => {
    assert.equal(ChatInput.shape.message.maxLength, 256);
  });

  it("accepts 256 units and refuses 260, naming both the count and the limit in units", async () => {
    const api = chatApi();
    assert.deepEqual(await api.post("🚀".repeat(128)), { status: 200, body: { sent: true } }, "128 emoji are 256 UTF-16 units");
    const error = await refusal(api.post("🚀".repeat(130)));
    assert.match(error, /260 UTF-16 code units/);
    assert.match(error, /limit of 256 UTF-16 code units/);
    assert.equal(api.sent.length, 1);
  });

  it("counts the `/msg <to> ` prefix of a whisper toward the limit", async () => {
    const api = chatApi();
    const prefix = "/msg ana_1 ";
    assert.equal(prefix.length, 11);
    assert.deepEqual(await api.post(prefix + "🚀".repeat(122)), { status: 200, body: { sent: true } }, "11 + 244 = 255 units");
    const error = await refusal(api.post(prefix + "🚀".repeat(130)));
    assert.match(error, /271 UTF-16 code units/);
    assert.match(error, /limit of 256 UTF-16 code units/);
    assert.deepEqual(api.sent, [prefix + "🚀".repeat(122)]);
  });
});

describe("POST /chat and social.say answer the same on the boundary", () => {
  it("both accept and refuse the same messages", async () => {
    const api = chatApi();
    const h = createHarness();
    const cases = ["hi", "🚀".repeat(128), "🚀".repeat(129), "x".repeat(256), "x".repeat(257), "a\tb", "§", "x\u007fy", "\u0000", "🚀a\t"];
    for (const message of cases) {
      const posted = await api.post(message);
      const said = await h.run(social.say, { message }).then(() => true, () => false);
      assert.equal(posted.status === 200, said, `${JSON.stringify(message.slice(0, 12))}: POST /chat answered ${posted.status}, social.say ${said ? "accepted" : "refused"}`);
    }
    assert.equal(api.sent.length, h.chat.length, "the two paths sent the same lines");
  });
});

describe("social.say validates with the same rule, before chat", () => {
  it("refuses a tab, naming it and its index, and sends nothing", async () => {
    const h = createHarness();
    await assert.rejects(h.run(social.say, { message: "a\tb" }), (error: Error) => {
      assert.match(error.message, /routine "under test" arguments/);
      assert.match(error.message, /\\u0009/);
      assert.match(error.message, /U\+0009/);
      assert.match(error.message, /index 1/);
      return true;
    });
    assert.deepEqual(h.chat, []);
  });

  it("refuses 130 emoji (260 units) and sends an accepted line", async () => {
    const h = createHarness();
    await assert.rejects(h.run(social.say, { message: "🚀".repeat(130) }), /260 UTF-16 code units.*limit of 256 UTF-16 code units/s);
    assert.deepEqual(h.chat, []);
    await h.run(social.say, { message: "hello" });
    assert.deepEqual(h.chat, ["hello"]);
  });
});
