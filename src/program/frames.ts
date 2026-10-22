// How a stack line names the file and position its code is in: the one reading of stack frames in the
// host, for the errors a run reports (runner.ts) and for the crash report (host/main.ts). It imports
// only Node built-ins, so the host entry can load it before anything else.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A stack line that names a file and a position in it (see `locateFrame`). */
export interface FrameLocation {
  /** The file's path. A `file:` URL names it without what the URL adds (a query, a fragment), which names an evaluation and not a file. */
  file: string;
  /** `line:column`, or `line` alone for the first line of a compile error's source excerpt. */
  position: string;
  /** The stack line with its location written as `<file>:<position>`. */
  text: string;
}

// A stack line ends with `<url or path>:<line>:<column>`: in parentheses after the function's name, else
// all that follows `at ` (or `at async `), spaces and parentheses included; the first line of a compile
// error's excerpt is `<url>:<line>`. Each pattern captures what comes before the location, the location,
// the position, and what follows.
const FRAME_LINES = [
  /^(.*?\()(.+?):(\d+(?::\d+)?)(\))$/,
  /^( *at (?:async )?)(.+?):(\d+(?::\d+)?)()$/,
  /^()(file:\/\/\/.+?):(\d+)()$/,
];

/**
 * Where the stack line `line` says its code is: undefined for a line that names no file position, and for a
 * `file:` URL that names no path (`%zz`, an encoded `/`), which is not located.
 */
export function locateFrame(line: string): FrameLocation | undefined {
  for (const pattern of FRAME_LINES) {
    const match = pattern.exec(line);
    if (!match) continue;
    const [, before = "", target = "", position = "", after = ""] = match;
    let file = target;
    if (target.startsWith("file:")) {
      try {
        file = fileURLToPath(target);
      } catch {
        return undefined;
      }
    }
    return { file, position, text: `${before}${file}:${position}${after}` };
  }
  return undefined;
}

/** `dir`'s real path ending in a separator, so a file is inside `dir` when its path starts with it. A directory gone since has none to resolve: its own path serves. */
export function insideDir(dir: string): string {
  let real = path.resolve(dir);
  try {
    real = realpathSync(real);
  } catch {}
  return path.join(real, path.sep);
}
