// Reference text for kits, generated from each action's zod schema plus its doc: the call
// shape with argument names, and per-argument types and defaults. The same renderer serves
// built-in and agent kits, so docs can never drift from the validation that runs on every call.
import { z } from "zod";
import type { Kit } from "./kit.ts";

function typeName(schema: z.ZodType): string {
  if (schema instanceof z.ZodOptional) return typeName(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodDefault) return typeName(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodNullable) return typeName(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodEnum) return schema.options.join(" | ");
  if (schema instanceof z.ZodArray) return `${typeName(schema.element as z.ZodType)}[]`;
  if (schema instanceof z.ZodTuple) return `[${schema.def.items.map((item) => typeName(item as z.ZodType)).join(", ")}]`;
  if (schema instanceof z.ZodUnion) return schema.options.map((option) => typeName(option as z.ZodType)).join(" | ");
  if (schema instanceof z.ZodObject) {
    return `{ ${Object.entries(schema.shape)
      .map(([key, value]) => `${key}: ${typeName(value as z.ZodType)}`)
      .join(", ")} }`;
  }
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

/** `kit.move.to({ position, range?, timeoutMs? })` — the call shape, from the schema's keys. */
function callShape(kitName: string, actionName: string, args: z.ZodObject): string {
  const names = Object.entries(args.shape).map(([name, schema]) => `${name}${schema.safeParse(undefined).success ? "?" : ""}`);
  return `kit.${kitName}.${actionName}({ ${names.join(", ")} })`;
}

/** One action's call shape and argument lines: what a validation error shows the caller. */
export function actionReference(kitName: string, actionName: string, args: z.ZodObject): string {
  return [callShape(kitName, actionName, args), ...Object.entries(args.shape).map(([arg, schema]) => argumentLine(arg, schema as z.ZodType))].join("\n");
}

/** The reference for one kit: header, description, uses, and one section per action. */
export function kitReference(kit: Kit): string {
  const uses = kit.uses.length > 0 ? `Uses: ${kit.uses.join(", ")}.` : "Uses no other kits.";
  const sections = Object.entries(kit.actions).map(([name, action]) =>
    [
      `### ${callShape(kit.name, name, action.args)}`,
      action.doc,
      ...Object.entries(action.args.shape).map(([arg, schema]) => argumentLine(arg, schema)),
    ].join("\n"),
  );
  return [`## ${kit.name}`, kit.description, uses, ...sections].join("\n");
}
