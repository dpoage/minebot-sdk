// Mineflayer is large; the harness implements the part kits' decision logic leans on. Everything
// else must fail loudly: a kit that reaches for `bot.attack` must not get `undefined` back and
// carry on as if the call worked.

/** Thrown for every Mineflayer API the harness does not implement. */
export class UnsupportedApiError extends Error {
  readonly api: string;
  constructor(api: string) {
    super(`not supported by minebot-sdk/testing: ${api}`);
    this.name = "UnsupportedApiError";
    this.api = api;
  }
}

/** Keys that probes (await, JSON, assertion libraries) read on any object; they are not API calls. */
const PROBES: Record<string, true> = { then: true, toJSON: true, asymmetricMatch: true, nodeType: true, $$typeof: true, _isMockFunction: true, inspect: true };

/**
 * Wraps `target` so that reading a member it does not have returns a function that throws
 * `UnsupportedApiError` naming `path.member` when called (or read further). Members the target
 * has pass through, and its methods and getters run on the target itself, so classes with private
 * fields work behind the wrapper. `path` is how the API reads in kit code: `bot`, `bot.pathfinder`, ...
 *
 * A missing member that Mineflayer holds data in, not a function (`bot.quickBarSlot`,
 * `bot.currentWindow`), would read as a truthy function here, so the harness defines such members
 * with their idle values on the target.
 */
export function strict<T extends object>(path: string, target: T): T {
  return new Proxy(target, {
    get(object, key) {
      if (typeof key === "symbol" || key in object || PROBES[key]) {
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      }
      const api = `${path}.${key}`;
      return new Proxy(() => {}, {
        apply: () => {
          throw new UnsupportedApiError(api);
        },
        construct: () => {
          throw new UnsupportedApiError(api);
        },
        get: (_, member) => {
          if (typeof member === "symbol" || PROBES[member] || member === "name" || member === "length") return undefined;
          throw new UnsupportedApiError(`${api}.${member}`);
        },
      });
    },
  });
}
