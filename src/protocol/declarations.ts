// TypeScript declarations derived from the wire contract: KitRegistry entries for kits from their
// JSON Schemas, and the program globals a body offers. `minebot types` writes them into a workspace;
// the body type-checks kit source against the registry part. Kits that ship with the package are
// typed by the package itself. The output depends only on its inputs, so regenerating without a
// change is a no-op.
import { CAPABILITY_GATES, type ActionSchema, type BodyFeatures, type KitSchema } from "./index.ts";

type Json = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `text` has a `|` or `&` outside brackets and string literals: it needs parentheses before `[]`. */
function isCompound(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // A JSON string literal: skip to its closing quote.
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch !== undefined && "({[<".includes(ch)) depth++;
    else if (ch !== undefined && ")}]>".includes(ch)) depth--;
    else if ((ch === "|" || ch === "&") && depth === 0) return true;
  }
  return false;
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** A doc comment for `text` at `indent`; empty when there is none. */
function comment(text: unknown, indent: string): string {
  if (typeof text !== "string" || text.trim() === "") return "";
  const lines = text.trim().replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

/** Prints the TypeScript type of a JSON Schema (draft 2020-12, as zod emits it). Anything it cannot express becomes `unknown`. */
class TypePrinter {
  readonly #root: Json;
  readonly #resolving: string[] = [];

  constructor(root: Json) {
    this.#root = root;
  }

  print(schema: unknown, indent: string): string {
    if (schema === true) return "unknown";
    if (schema === false) return "never";
    if (!isJson(schema)) return "unknown";
    if (typeof schema.$ref === "string") return this.#ref(schema.$ref, indent);
    if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
    if (Array.isArray(schema.enum)) return schema.enum.length === 0 ? "never" : schema.enum.map((v) => JSON.stringify(v)).join(" | ");
    if (Array.isArray(schema.anyOf)) return this.#join(schema.anyOf, " | ", indent);
    if (Array.isArray(schema.oneOf)) return this.#join(schema.oneOf, " | ", indent);
    if (Array.isArray(schema.allOf)) return this.#join(schema.allOf, " & ", indent);
    if (Array.isArray(schema.type)) return this.#join(schema.type.map((type) => ({ ...schema, type })), " | ", indent);
    switch (schema.type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return this.#array(schema, indent);
      case "object":
        return this.#object(schema, indent);
      default:
        return isJson(schema.properties) ? this.#object(schema, indent) : "unknown";
    }
  }

  #ref(ref: string, indent: string): string {
    // Recursive schemas are cut at the second visit: the type system gets `unknown` there.
    if (this.#resolving.includes(ref)) return "unknown";
    let target: unknown = this.#root;
    if (ref !== "#") {
      const [, defs, name] = ref.split("/");
      if (defs !== "$defs" || name === undefined || !isJson(this.#root.$defs)) return "unknown";
      target = this.#root.$defs[name];
    }
    this.#resolving.push(ref);
    try {
      return this.print(target, indent);
    } finally {
      this.#resolving.pop();
    }
  }

  #join(parts: unknown[], separator: string, indent: string): string {
    const printed = [...new Set(parts.map((part) => this.print(part, indent)))];
    if (printed.length === 0) return "never";
    return printed.map((part) => (isCompound(part) && printed.length > 1 ? `(${part})` : part)).join(separator);
  }

  #array(schema: Json, indent: string): string {
    if (Array.isArray(schema.prefixItems)) {
      const items = schema.prefixItems.map((item) => this.print(item, indent));
      const rest = schema.items === undefined || schema.items === false ? [] : [`...${this.#list(schema.items, indent)}`];
      return `[${[...items, ...rest].join(", ")}]`;
    }
    return this.#list(schema.items, indent);
  }

  #list(items: unknown, indent: string): string {
    const element = this.print(items, indent);
    return `${isCompound(element) ? `(${element})` : element}[]`;
  }

  #object(schema: Json, indent: string): string {
    const properties = isJson(schema.properties) ? Object.entries(schema.properties) : [];
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const inner = `${indent}  `;
    const members = properties.map(([name, value]) => {
      const description = isJson(value) ? value.description : undefined;
      return `${comment(description, inner)}${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${this.print(value, inner)};`;
    });
    const extra = schema.additionalProperties;
    if (isJson(extra)) members.push(`${inner}[key: string]: ${this.print(extra, inner)};`);
    else if (schema.properties === undefined && extra !== false) members.push(`${inner}[key: string]: unknown;`);
    if (members.length === 0) return "{}";
    return `{\n${members.join("\n")}\n${indent}}`;
  }
}

/** The TypeScript type text of a JSON Schema, with continuation lines indented from `indent`. */
export function schemaToType(schema: Json, indent = ""): string {
  return new TypePrinter(schema).print(schema, indent);
}

/** True when a call may leave the argument out: no property of its object is required. */
function argsOptional(args: Json): boolean {
  return !(Array.isArray(args.required) && args.required.length > 0);
}

function actionMember(name: string, action: ActionSchema, indent: string): string {
  const args = schemaToType(action.args, indent);
  const returns = action.returns === undefined ? "unknown" : schemaToType(action.returns, indent);
  return `${comment(action.doc, indent)}${indent}readonly ${propertyKey(name)}: (args${argsOptional(action.args) ? "?" : ""}: ${args}) => Promise<${returns}>;`;
}

/** A `declare module "minebot-sdk/kit"` block that adds `kits` to KitRegistry, typed from their schemas. */
export function registryBlock(kits: readonly KitSchema[]): string {
  const entries = kits.map((kit) => {
    const actions = Object.entries(kit.actions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const members = actions.map(([name, action]) => actionMember(name, action, "      "));
    return `${comment(kit.description, "    ")}    ${propertyKey(kit.name)}: {\n${members.join("\n")}\n    };`;
  });
  return `declare module "minebot-sdk/kit" {\n  interface KitRegistry {\n${entries.join("\n")}\n  }\n}\n`;
}

const NOTES = `  /** Your notepad on this body; it survives body restarts. Keys are lowercase, e.g. "plan" or "places/base". */
  const notes: {
    list(): { key: string; text: string; updated: string }[];
    get(key: string): string | undefined;
    set(key: string, text: string): unknown;
    delete(key: string): unknown;
  };`;

function globalsBlock(features: BodyFeatures, active: readonly string[]): string {
  const caps = {
    kits: CAPABILITY_GATES.kits(features),
    kitSwitching: CAPABILITY_GATES.kitSwitching(features),
    agentKits: CAPABILITY_GATES.agentKits(features),
    wiki: CAPABILITY_GATES.wiki(features),
    lessons: CAPABILITY_GATES.lessons(features),
    milestones: CAPABILITY_GATES.milestones(features),
    triggers: CAPABILITY_GATES.triggers(features),
  };
  const out: string[] = [
    "  /** The mineflayer Bot. The pathfinder plugin is loaded: bot.pathfinder.goto(goal). */",
    '  const bot: import("minebot-sdk/kit").Bot;',
    '  const goals: typeof import("minebot-sdk/kit").goals;',
    '  const Movements: typeof import("minebot-sdk/kit").Movements;',
    '  const Vec3: typeof import("minebot-sdk/kit").Vec3;',
    "  /** Appends to the program output. */",
    "  function log(...args: unknown[]): void;",
    "  /** Resolves after ms; rejects when the program is aborted. */",
    "  function sleep(ms: number): Promise<void>;",
    "  /** Fires on timeout or stop; check signal.aborted in long loops. */",
    "  const signal: AbortSignal;",
    "  /** Subscribes to a bot event. When the program ends or is aborted, the body removes the handlers that exist at that moment. */",
    "  function on(event: string, handler: (...args: any[]) => void): void;",
    NOTES,
    `  /** Deaths and reconnects${caps.milestones ? ", and progress toward the body's milestones" : ""}. */`,
    `  function status(): Promise<{ deaths: number; reconnects: number${caps.milestones ? "; milestones: unknown" : ""} }>;`,
  ];
  if (caps.kits) {
    const names = active.length > 0 ? active.map((name) => JSON.stringify(name)).join(" | ") : "never";
    out.push(
      "  /** The active kits' actions, namespaced by kit: await kit.move.to({ position }). */",
      `  const kit: { [K in Extract<keyof KitRegistry, ${names}>]: KitRegistry[K] };`,
    );
    const controller = [
      "    readonly active: string[];",
      "    readonly locked: boolean;",
      "    available(): { name: string; description: string; uses: string[]; active: boolean; agent: boolean; actions: string[] }[];",
      "    docs(...names: string[]): string;",
      "    search(query: string, limit?: number): { kit: string; action?: string; score: number; text: string; active: boolean }[];",
    ];
    if (caps.kitSwitching) controller.push("    use(...names: string[]): string[];");
    if (caps.agentKits) {
      controller.push(
        "    save(source: string): Promise<unknown>;",
        "    remove(name: string): Promise<void>;",
        "    source(name: string): string;",
        "    versions(name: string): Promise<unknown>;",
        "    revert(name: string, version: number): Promise<unknown>;",
        "    try(source: string, run: { action: string; args?: unknown }): Promise<unknown>;",
      );
    }
    out.push("  /** Kit management: what is active, the action reference, search. */", `  const kits: {\n${controller.join("\n")}\n  };`);
  }
  if (caps.wiki) {
    const wiki = [
      "    search(query: string, limit?: number): { id: string; title: string; status: string; score: number; snippet: string }[];",
      "    read(id: string): string;",
      "    list(section?: string): { id: string; title: string; status: string }[];",
    ];
    if (caps.lessons) wiki.push("    addLesson(lesson: { title: string; tags?: string[]; body: string }): Promise<unknown>;");
    out.push("  /** Notes on mechanics, flows, and quirks. */", `  const wiki: {\n${wiki.join("\n")}\n  };`);
  }
  if (caps.triggers) {
    out.push(
      "  /** Reflexes the body runs when an event arrives; they persist across body restarts. */",
      "  const triggers: {",
      "    add(trigger: { name: string; on: string[]; run: string; from?: string; match?: string; when?: string; cooldownMs?: number; timeoutMs?: number; enabled?: boolean; preempt?: boolean; priority?: number }): Promise<unknown>;",
      "    remove(name: string): Promise<unknown>;",
      "    enable(name: string): Promise<unknown>;",
      "    disable(name: string): Promise<unknown>;",
      "    list(): unknown[];",
      "  };",
    );
  }
  return `declare global {\n${out.join("\n")}\n}\n`;
}

/**
 * The declaration file for a body: KitRegistry entries for the kits the package does not ship
 * (those `agent` kits), and the program globals typed for what `features` offers and the kits
 * that are `active`.
 */
export function generateEnv(features: BodyFeatures, kits: readonly KitSchema[]): string {
  const caps = CAPABILITY_GATES.kits(features);
  const extra = caps ? kits.filter((kit) => kit.agent).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [];
  const active = caps ? kits.filter((kit) => kit.active).map((kit) => kit.name).sort() : [];
  return [
    "// Generated by `minebot types`; regenerate it after the body's kits change. Do not edit.",
    caps ? 'import type { KitRegistry } from "minebot-sdk/kit";' : "export {};",
    "",
    ...(extra.length > 0 ? [registryBlock(extra)] : []),
    globalsBlock(features, active),
  ].join("\n");
}
