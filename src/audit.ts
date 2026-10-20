// Audit of the programs agents run. Programs execute in a node:vm context, which is not a security
// boundary: `bot.constructor.constructor("return process")()` reaches the host process. The body does
// not try to stop that. It scans every program's source for the usual ways out and records the matches
// in the program history, and the benchmark verifier fails a trial that ran such a program.
// The scan is an audit, not a defense: code that builds these names at run time (`bot["const" + "ructor"]`) passes it.

/** Whitespace and comments: what JavaScript allows between `import` or `require` and the `(` of the call. */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`;

/** Source patterns that reach outside the program environment, by the name recorded in the history. */
const ESCAPE_PATTERNS: Record<string, RegExp> = {
  "constructor.constructor": /\bconstructor\s*\.\s*constructor\b|\[\s*(["'`])constructor\1\s*\]/,
  process: /\bprocess\b/,
  getBuiltinModule: /\bgetBuiltinModule\b/,
  "require(": new RegExp(`\\brequire${GAP}\\(`),
  "import(": new RegExp(`\\bimport${GAP}\\(`),
  "globalThis.constructor": /\bglobalThis\s*\.\s*constructor\b/,
  "Function(": /\bFunction\s*\(/,
};

/** Names of the escape patterns that appear in a program's source. Empty for a program that stays in the environment. */
export function findEscapeAttempts(code: string): string[] {
  return Object.entries(ESCAPE_PATTERNS)
    .filter(([, pattern]) => pattern.test(code))
    .map(([name]) => name);
}
