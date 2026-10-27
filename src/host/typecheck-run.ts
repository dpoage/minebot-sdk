// The pure half of the run check (typecheck.ts runs the compiler): how a run's source becomes the text that is
// checked, which of the compiler's diagnostics refuse the run, and how they read to the agent.
import { suggestBotMember } from "./suggest.ts";

/** The run's file in the check's project: it has a dot, so no routine of the library is named so. */
export const RUN_CHECK_FILE = "routine.run.ts";

/** The compiler's diagnostic for the run's file, positions as the compiler counts them (1-based line and column). */
export interface Diagnostic {
  line: number;
  column: number;
  code: number;
  /** The first line of the compiler's message. */
  message: string;
}

/**
 * The names the check adds to the run's module. They are `$`-prefixed so they do not meet the agent's own,
 * and a diagnostic that names one is the check's, not the agent's.
 */
const CONTEXT_TYPES = [
  'import type { RoutineContext as $RC } from "minebot-sdk/routine";',
  // A default export that is not a function is the run's result itself, so the type admits every other value.
  "type $R = ((ctx: $RC, args: any) => unknown) | object | string | number | boolean | bigint | symbol | null | undefined;",
].join("\n");

/** The declaration that replaces `export default`: the same number of characters, so no position of the run's source moves. */
const ANNOTATION = "const $r:$R=";

/** Characters after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX: Record<string, true> = Object.fromEntries(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"].map((c) => [c, true]));
const KEYWORDS_BEFORE_REGEX: Record<string, true> = Object.fromEntries(
  ["return", "typeof", "case", "do", "else", "void", "in", "of", "delete", "throw", "new", "instanceof", "yield", "await"].map((word) => [word, true]),
);
const EXPORT_DEFAULT = /^export[ \t]+default(?![\w$])/;

/**
 * The offset of the `export default` that is code at the top level of `source`: not in a comment, a
 * string, a template, or a regular expression. (Agents write the phrase in their comments.)
 */
function defaultExportAt(source: string): number | undefined {
  const n = source.length;
  // The brace depth at which each open template substitution `${` began.
  const templates: number[] = [];
  let braces = 0;
  let previous = "";
  let previousWord = "";
  let i = 0;
  /** Skips template text from `i` up to the end of the template or the start of a substitution. */
  const templateText = () => {
    while (i < n) {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "`") return void i++;
      else if (c === "$" && source[i + 1] === "{") {
        templates.push(braces);
        return void (i += 2);
      } else i++;
    }
  };
  while (i < n) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i++;
      previous = c;
      previousWord = "";
    } else if (c === "`") {
      i++;
      templateText();
      previous = "`";
      previousWord = "";
    } else if (c === "/" && (BEFORE_REGEX[previous] || KEYWORDS_BEFORE_REGEX[previousWord])) {
      i++;
      for (let inClass = false; i < n && source[i] !== "\n" && (inClass || source[i] !== "/"); i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
      }
      i++;
      previous = "/";
      previousWord = "";
    } else if (/[\p{ID_Start}$_]/u.test(c)) {
      const start = i;
      while (i < n && /[\p{ID_Continue}$\u200C\u200D]/u.test(source[i]!)) i++;
      const word = source.slice(start, i);
      if (word === "export" && braces === 0 && templates.length === 0 && previous !== "." && EXPORT_DEFAULT.test(source.slice(start, start + 64))) return start;
      previous = word.at(-1)!;
      previousWord = word;
    } else {
      if (c === "{") braces++;
      else if (c === "}") {
        if (templates.length > 0 && braces === templates.at(-1)) {
          templates.pop();
          i++;
          templateText();
          previous = "`";
          previousWord = "";
          continue;
        }
        braces--;
      }
      previous = c;
      previousWord = "";
      i++;
    }
  }
  return undefined;
}

/**
 * The text the compiler checks for run `source`: the source with the default export typed as the run's
 * function `(ctx: RoutineContext, args: any)`, so a parameter of a default function that has no
 * annotation is typed as the run calls it. `export default` becomes a declaration of the same length,
 * and the names it needs come after the source, so every position of the source is the agent's own.
 * A `function` declaration is an expression there, so its name is declared again after the source (an
 * `any`: the check types the parameters, not the uses of the name). A default export that is a class or a
 * declaration of types is left as it is.
 */
export function checkedText(source: string): string {
  const at = defaultExportAt(source);
  const found = at === undefined ? undefined : EXPORT_DEFAULT.exec(source.slice(at, at + 64));
  if (at === undefined || found === null || found === undefined) return source;
  const after = source.slice(at + found[0].length);
  if (/^\s*(?:class|abstract|interface|enum|type|namespace|declare)(?![\w$])/.test(after)) return source;
  const name = /^\s*(?:async\s+)?function\b\s*\*?\s*([\p{ID_Start}$_][\p{ID_Continue}$]*)/u.exec(after)?.[1];
  const text = source.slice(0, at) + ANNOTATION.padEnd(found[0].length) + after;
  return `${text}\n${CONTEXT_TYPES}\n${name === undefined ? "" : `declare const ${name}: any;\n`}`;
}

/** The diagnostics of file `file` in the compiler's `--pretty false` output (`file(line,col): error TSnnnn: message`). */
export function parseDiagnostics(lines: readonly string[], file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const text of lines) {
    if (!text.startsWith(`${file}(`)) continue;
    const found = /^[^(]*\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(text);
    if (found) out.push({ line: Number(found[1]), column: Number(found[2]), code: Number(found[3]), message: found[4]! });
  }
  return out;
}

/** The line and column (1-based, as the compiler counts them) of `offset` in `text`, whose line breaks are the compiler's. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const breaks = /\r\n|[\n\r\u2028\u2029]/g;
  let line = 1;
  let start = 0;
  for (let found = breaks.exec(text); found !== null && found.index < offset; found = breaks.exec(text)) {
    line++;
    start = found.index + found[0].length;
  }
  return { line, column: offset - start + 1 };
}

/** The offset in `text` of 1-based `line` and `column` (the compiler's line breaks: \n, \r\n, \r, \u2028, \u2029; columns in UTF-16 units), or undefined past its end. */
function offsetOf(text: string, line: number, column: number): number | undefined {
  const breaks = /\r\n|[\n\r\u2028\u2029]/g;
  let start = 0;
  for (let l = 1; l < line; l++) {
    breaks.lastIndex = start;
    const found = breaks.exec(text);
    if (!found) return undefined;
    start = found.index + found[0].length;
  }
  return start + column - 1 <= text.length ? start + column - 1 : undefined;
}

/** Codes whose diagnostic refuses a run: a value that is not callable, a call with the wrong number of arguments, a key the object's type does not have. */
const REFUSED_CODES: Record<number, true> = { 2349: true, 2554: true, 2353: true };
/** Codes of a member that the type does not have; they refuse only where the member is called. */
const MISSING_MEMBER_CODES: Record<number, true> = { 2339: true, 2551: true };
/** The code of a name that is not defined: it refuses a run, except where the name is only asked for with `typeof`. */
const UNDEFINED_NAME = 2304;

/**
 * The offset in `text` where a missing member (diagnostic `d`, code 2339 or 2551) is named, and its name,
 * when the member is called there: `.name(`, `.name!(` or ``.name` `` (a tagged template).
 */
function calledMember(d: Diagnostic, text: string): { at: number; name: string } | undefined {
  const name = /^Property '([^']+)' does not exist/.exec(d.message)?.[1];
  const at = offsetOf(text, d.line, d.column);
  if (name === undefined || at === undefined || !text.startsWith(name, at)) return undefined;
  return /^(?:!?\(|`)/.test(text.slice(at + name.length, at + name.length + 2)) ? { at, name } : undefined;
}

/**
 * Whether a diagnostic of an undefined name (`UNDEFINED_NAME`) is the direct operand of a `typeof` expression,
 * as in `typeof triggers`: `typeof` answers "undefined" for a name that does not exist instead of throwing, so
 * that diagnostic predicts no failure. A member access is not protected (`typeof x.y` throws when `x` is not
 * defined), and neither is any other use of the name.
 */
function typeofOperand(d: Diagnostic, text: string): boolean {
  const name = /^Cannot find name '([^']+)'/.exec(d.message)?.[1];
  const at = offsetOf(text, d.line, d.column);
  if (name === undefined || at === undefined || !text.startsWith(name, at)) return false;
  return /typeof\s+$/.test(text.slice(0, at)) && !/^\s*(?:\.|\[)/.test(text.slice(at + name.length));
}

/**
 * Whether diagnostic `d` refuses a run: the classes that predict a failure at run time (see
 * `REFUSED_CODES`), a member that is missing where it is called, and an undefined name that is used for
 * more than a `typeof` probe. A diagnostic that names one of the names the check adds is the check's.
 */
function refuses(d: Diagnostic, text: string): boolean {
  if (/\$(?:RC|R|r)\b/.test(d.message)) return false;
  if (d.code === UNDEFINED_NAME) return !typeofOperand(d, text);
  if (MISSING_MEMBER_CODES[d.code]) return calledMember(d, text) !== undefined;
  return REFUSED_CODES[d.code] === true;
}

/**
 * The diagnostics that refuse a run, from those of its file: the classes that predict a failure at run
 * time (see `refuses`), outside the names the check adds, in the order of the source. Anything else (an
 * unresolved module, a type mismatch) leaves the run to run. `text` is `checkedText` of the run's source.
 *
 * A source that does not parse refuses nothing: Node's parser answers a grammar error with its own hints,
 * and the diagnostics of a half-parsed file (which recovery invents) do not describe the code the agent
 * meant.
 */
export function refusing(diagnostics: readonly Diagnostic[], text: string): Diagnostic[] {
  if (diagnostics.some((d) => d.code >= 1000 && d.code < 2000)) return [];
  return diagnostics
    .filter((d) => refuses(d, text))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * The dotted member path after `bot.` of the member `name` at offset `at` of `text`, when the expression
 * there is `bot.<path>` or `ctx.bot.<path>` (`ctx.bot.inventory.findItem` is `inventory.findItem`), or
 * undefined for any other receiver. A `!` of a non-null assertion is stepped over.
 */
function botMemberPath(text: string, at: number, name: string): string | undefined {
  const segments = [name];
  let i = at;
  for (;;) {
    if (i === 0 || text[i - 1] !== ".") break;
    i--;
    while (i > 0 && text[i - 1] === "!") i--;
    const end = i;
    while (i > 0 && /[\p{ID_Continue}$\u200C\u200D]/u.test(text[i - 1]!)) i--;
    if (i === end) return undefined;
    segments.unshift(text.slice(i, end));
  }
  const [root, second] = segments;
  if (root === "bot" && segments.length > 1) return segments.slice(1).join(".");
  if (root === "ctx" && second === "bot" && segments.length > 2) return segments.slice(2).join(".");
  return undefined;
}

/** `suggestBotMember`'s line for a missing bot member that is called here, or undefined (never the bot itself: a check has none). */
function suggestionFor(d: Diagnostic, text: string): string | undefined {
  const member = calledMember(d, text);
  if (member === undefined) return undefined;
  const path = botMemberPath(text, member.at, member.name);
  return path === undefined ? undefined : suggestBotMember(path);
}

/**
 * How a refusing diagnostic reads to the agent: `line L:C <message>`, in the agent's own coordinates, and
 * under it `  <suggestion line>` when the diagnostic is a called member of `bot` whose real member is known.
 * The suggestion replaces TypeScript's own "Did you mean", which names a member of the wrong library.
 */
export function renderRefusal(d: Diagnostic, text: string): string {
  const suggestion = MISSING_MEMBER_CODES[d.code] ? suggestionFor(d, text) : undefined;
  const message = suggestion === undefined ? d.message : d.message.replace(/ Did you mean .*\?$/, "");
  const line = `line ${d.line}:${d.column} ${message}`;
  return suggestion === undefined ? line : `${line}\n  ${suggestion}`;
}
