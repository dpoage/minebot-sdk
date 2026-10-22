// The built-in routine modules a body offers: which ones (the closure of `--builtins` over each
// module's `uses`), how a call name finds a routine, the reference text, search, and source an agent
// reads them by, and the count of every call into kit-stats.json. Everything is derived from the
// catalog's routine metadata (src/routines/index.ts), never from evaluating a library module.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ActionStats, BuiltinInfo, BuiltinSearchHit } from "../../protocol/index.ts";
import { countTokens, rankFields } from "../../rank.ts";
import { type Routine, type RoutineCallObserver, metaOf } from "../../routine/define.ts";
import { BUILTIN_MODULES, type BuiltinModule } from "../../routines/index.ts";
import type { KitStats } from "./stats.ts";

/** The specifier prefix of a built-in module: `minebot-sdk/routines/<module>`. */
const SPECIFIER_PREFIX = "minebot-sdk/routines/";

/** Neither counts nor reports: what the observer answers for a call it does not count. */
const NOT_COUNTED = () => {};

function typeName(schema: z.ZodType): string {
  if (schema instanceof z.ZodOptional) return typeName(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodDefault) return typeName(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodNullable) return `${typeName(schema.unwrap() as z.ZodType)} | null`;
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodEnum) return schema.options.join(" | ");
  if (schema instanceof z.ZodArray) {
    const element = typeName(schema.element as z.ZodType);
    return element.includes(" | ") ? `(${element})[]` : `${element}[]`;
  }
  if (schema instanceof z.ZodTuple) return `[${schema.def.items.map((item) => typeName(item as z.ZodType)).join(", ")}]`;
  if (schema instanceof z.ZodUnion) return schema.options.map((option) => typeName(option as z.ZodType)).join(" | ");
  if (schema instanceof z.ZodObject) {
    return `{ ${Object.entries(schema.shape)
      .map(([key, value]) => `${key}${(value as z.ZodType).safeParse(undefined).success ? "?" : ""}: ${typeName(value as z.ZodType)}`)
      .join(", ")} }`;
  }
  if (schema instanceof z.ZodRecord) return `Record<${typeName(schema.keyType as z.ZodType)}, ${typeName(schema.valueType as z.ZodType)}>`;
  if (schema instanceof z.ZodNull) return "null";
  if (schema instanceof z.ZodVoid || schema instanceof z.ZodUndefined) return "void";
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return "unknown";
  return "value";
}

/** One argument's reference line: `- name: type` with `?` when it may be omitted and the default when it has one. */
function argumentLine(name: string, schema: z.ZodType): string {
  const mayBeOmitted = schema.safeParse(undefined).success;
  const withoutOptional = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
  const hasDefault = withoutOptional instanceof z.ZodDefault;
  const core = hasDefault ? (withoutOptional.unwrap() as z.ZodType) : withoutOptional;
  const parsed = schema.safeParse(undefined);
  const fallback = hasDefault && parsed.success && parsed.data !== undefined ? ` (default ${JSON.stringify(parsed.data)})` : "";
  return `- ${name}${mayBeOmitted ? "?" : ""}: ${typeName(core)}${fallback}`;
}

/** The keys of a routine's argument object, as [name, schema]; empty when it declares no object schema. */
function argumentsOf(routine: Routine): [string, z.ZodType][] {
  const args = metaOf(routine)?.args;
  return args instanceof z.ZodObject ? Object.entries(args.shape).map(([name, schema]) => [name, schema as z.ZodType]) : [];
}

/** `move.to(ctx, { position, range?, timeoutMs? })`: the call shape, from the schema's keys; a routine that takes no arguments is `move.stop(ctx)`. */
function callShape(module: string, name: string, routine: Routine): string {
  const args = metaOf(routine)?.args;
  if (args === undefined) return `${module}.${name}(ctx)`;
  if (!(args instanceof z.ZodObject)) return `${module}.${name}(ctx, args)`;
  const keys = argumentsOf(routine).map(([key, schema]) => `${key}${schema.safeParse(undefined).success ? "?" : ""}`);
  return keys.length === 0 ? `${module}.${name}(ctx)` : `${module}.${name}(ctx, { ${keys.join(", ")} })`;
}

/** What a routine declares it returns, in the notation of its argument lines: `nothing` for a void result. */
function returnShape(returns: z.ZodType): string {
  return returns instanceof z.ZodVoid || returns instanceof z.ZodUndefined ? "nothing" : typeName(returns);
}

/** The reference for one module: header, description, uses, and one section per routine. */
function moduleReference(module: BuiltinModule): string {
  const uses = module.uses.length > 0 ? `Uses: ${module.uses.join(", ")}.` : "Uses no other built-in modules.";
  const sections = Object.entries(module.routines).map(([name, routine]) => {
    const meta = metaOf(routine);
    const args = meta?.args;
    return [
      `### ${callShape(module.name, name, routine)}`,
      meta?.description ?? "",
      ...(args !== undefined && !(args instanceof z.ZodObject) ? [`- args: ${typeName(args)}`] : argumentsOf(routine).map(([arg, schema]) => argumentLine(arg, schema))),
      ...(meta?.returns ? [`Returns: ${returnShape(meta.returns)}`] : []),
    ]
      .filter((line) => line !== "")
      .join("\n");
  });
  return [`## ${module.name}`, module.description, uses, ...sections].join("\n");
}

/** One searchable unit: a module as a whole, or one of its routines. */
interface Document {
  module: string;
  routine?: string;
  /** What a hit shows: the module's description, or the first line of the routine's description. */
  text: string;
  fields: { weight: number; text: string }[];
}

/**
 * Lowercase word tokens. `collectDrops` yields `collect` and `drops`, `*_log` yields `log`, and a
 * plural loses its `s`, so "logs" finds "log".
 */
function terms(text: string): string[] {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

const MAX_TEXT_LENGTH = 200;

/** What a hit shows of a description: its first line, cut to a length that reads in a list. */
function summary(text: string): string {
  const line = text.split("\n")[0]!;
  return line.length > MAX_TEXT_LENGTH ? `${line.slice(0, MAX_TEXT_LENGTH - 3)}...` : line;
}

/** The documents of the modules, in catalog order: per module, the module, then its routines in the order it declares them. A routine also carries its module's description, so a query about the module's purpose finds its routines. */
function documentsOf(modules: readonly BuiltinModule[]): Document[] {
  return modules.flatMap((module) => [
    {
      module: module.name,
      text: summary(module.description),
      fields: [
        { weight: 4, text: module.name },
        { weight: 3, text: module.description },
        { weight: 1, text: Object.keys(module.routines).join(" ") },
      ],
    },
    ...Object.entries(module.routines).map(([name, routine]) => {
      const description = metaOf(routine)?.description ?? "";
      return {
        module: module.name,
        routine: name,
        text: summary(description),
        fields: [
          { weight: 4, text: name },
          { weight: 2, text: description },
          { weight: 1, text: `${module.name} ${module.description} ${argumentsOf(routine).map(([key]) => key).join(" ")}` },
        ],
      };
    }),
  ]);
}

/** Documents that match the query, best first. A term counts by where it occurs and how few documents have it. */
function rank(documents: readonly Document[], query: string): { document: Document; score: number }[] {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];
  const counted = documents.map((document) => ({
    document,
    fields: document.fields.map((field) => ({ weight: field.weight, counts: countTokens(terms(field.text)) })),
  }));
  return rankFields(counted, queryTerms).map(({ document, score }) => ({ document: document.document, score }));
}

/** The modules `names` lists and everything they use, in catalog order. Throws naming a module the catalog does not have. */
function closureOf(names: readonly string[]): BuiltinModule[] {
  const byName = new Map(BUILTIN_MODULES.map((module) => [module.name, module] as const));
  const wanted = new Set<string>();
  const visit = (name: string): void => {
    if (wanted.has(name)) return;
    const module = byName.get(name);
    if (!module) throw new Error(`unknown built-in module "${name}"; available: ${[...byName.keys()].join(", ")}`);
    wanted.add(name);
    for (const dep of module.uses) visit(dep);
  };
  for (const name of names) visit(name);
  return BUILTIN_MODULES.filter((module) => wanted.has(module.name));
}

export interface BuiltinsOptions {
  /** The modules to offer, with everything they use; undefined offers every built-in module and an empty list none. */
  offer?: readonly string[];
  /** The host's one stats instance: the counts of every call of an offered routine are recorded into it. */
  stats: KitStats;
}

export class Builtins {
  readonly #modules: ReadonlyMap<string, BuiltinModule>;
  readonly #identity: ReadonlyMap<Routine, { module: string; routine: string }>;
  readonly #stats: KitStats;
  #reported = false;

  /** Names of the offered modules, in catalog order (primitives first). */
  readonly offered: readonly string[];
  /** The directory the offered modules' sources are in: what an error of one of their routines reports frames from. */
  readonly dir: string = path.dirname(BUILTIN_MODULES[0]!.file);

  /** Throws, naming the module and listing the catalog, when `offer` names a module that is not a built-in. */
  constructor({ offer, stats }: BuiltinsOptions) {
    const offered = offer === undefined ? BUILTIN_MODULES : closureOf(offer);
    this.#modules = new Map(offered.map((module) => [module.name, module]));
    this.#identity = new Map(offered.flatMap((module) => Object.entries(module.routines).map(([routine, value]) => [value, { module: module.name, routine }] as const)));
    this.#stats = stats;
    this.offered = offered.map((module) => module.name);
  }

  /** The routine `callName` (`<module>.<routine>`) names, when its module is offered. */
  routine(callName: string): Routine | undefined {
    const dot = callName.indexOf(".");
    if (dot < 0) return undefined;
    const routines = this.#modules.get(callName.slice(0, dot))?.routines;
    const name = callName.slice(dot + 1);
    return routines !== undefined && Object.hasOwn(routines, name) ? routines[name] : undefined;
  }

  /** The offered modules, each with how often its routines succeeded and failed on this body. */
  list(): BuiltinInfo[] {
    return [...this.#modules.values()].map((module) => ({
      name: module.name,
      description: module.description,
      uses: [...module.uses],
      routines: Object.keys(module.routines),
      stats: this.#stats.forKit(module.name),
    }));
  }

  /** Reference text for the named modules, or for every offered module when `names` is empty. Throws naming a module that is not offered. */
  docs(names: readonly string[] = []): string {
    const selected = names.length > 0 ? [...new Set(names)] : this.offered;
    return selected
      .map((name) => {
        const module = this.#modules.get(name);
        if (!module) throw new Error(`unknown built-in module "${name}"; offered: ${this.offered.join(", ")}`);
        return moduleReference(module);
      })
      .join("\n\n");
  }

  /** Ranks the offered modules and routines against `query`: names, descriptions, and argument names. */
  search(query: string, limit = 5): BuiltinSearchHit[] {
    return rank(documentsOf([...this.#modules.values()]), query)
      .slice(0, limit)
      .map(({ document, score }) => {
        const stats: ActionStats | undefined = document.routine === undefined ? undefined : this.#stats.forKit(document.module)[document.routine];
        return {
          module: document.module,
          ...(document.routine !== undefined && { routine: document.routine }),
          score: Math.round(score * 100) / 100,
          text: document.text,
          ...(stats && { stats }),
        };
      });
  }

  /** The source file of an offered module, as the package ships it. */
  source(module: string): string | undefined {
    const found = this.#modules.get(module);
    return found === undefined ? undefined : readFileSync(found.file, "utf8");
  }

  /**
   * Counts the end of every call of an offered built-in routine, nested calls included: installed in the
   * context of every run. A routine is told apart by its identity in the catalog, so a routine of an agent
   * that names itself `move.to` is not counted. A failure after the run was aborted (stop, timeout,
   * preemption) is not a failure of the routine. It never throws: a throw would replace the call's outcome.
   */
  readonly observe: RoutineCallObserver = ({ routine }) => {
    const id = this.#identity.get(routine);
    if (id === undefined) return NOT_COUNTED;
    return (end) => {
      if (!end.ok && end.aborted) return;
      try {
        this.#stats.record(id.module, id.routine, end.ok ? undefined : { message: end.message });
      } catch (err) {
        if (this.#reported) return;
        this.#reported = true;
        console.error(`[minebot] built-in call counts cannot be recorded: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  };

  /** Whether a library module may import `specifier`: false for `minebot-sdk/routines/<module>` of a built-in module this body does not offer. */
  readonly allows = (specifier: string): boolean => {
    if (!specifier.startsWith(SPECIFIER_PREFIX)) return true;
    const name = specifier.slice(SPECIFIER_PREFIX.length);
    return this.#modules.has(name) || !BUILTIN_MODULES.some((module) => module.name === name);
  };

  /** Writes the counts now, also when there are none. The host calls this when it closes. */
  flush(): void {
    this.#stats.flush();
  }
}
