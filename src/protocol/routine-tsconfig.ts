// The compiler options a routine is type-checked with, shared by the body's check when a routine is saved
// (host/typecheck.ts) and the tsconfig `minebot init` writes (client/init.ts), so `npx tsc` in a workspace
// and the body answer alike. It lives here because the client may not import the host.

/**
 * The options that make a routine type-check as the body loads it: ES TypeScript that Node only strips of
 * types. `verbatimModuleSyntax` rejects `import { Bot } from "mineflayer"` (a type imported as a value,
 * which the runtime cannot load) and `erasableSyntaxOnly` rejects enums, namespaces with code, and
 * parameter properties. `lib` is esnext: Node 24 has `Promise.withResolvers`, which the built-in routines use.
 */
export const ROUTINE_COMPILER_OPTIONS = {
  target: "esnext",
  module: "nodenext",
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  lib: ["esnext"],
  moduleDetection: "force",
  // Files import each other by their .ts names.
  allowImportingTsExtensions: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
} as const;
