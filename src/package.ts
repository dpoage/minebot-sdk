// Where the package's shipped assets live. This file sits one level below the package root in both
// layouts (src/ in the repository, dist/ in an installed package), so one relative step finds it.
import { fileURLToPath } from "node:url";

/** The package root: the directory with package.json, `src/kit/kits/` (the kit sources), and `wiki/`. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
