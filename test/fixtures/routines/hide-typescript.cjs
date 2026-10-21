// Preloaded (`--require`) by typecheck.test.ts: makes `typescript` unresolvable, as in a body whose
// package has no compiler next to it.
const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "typescript" || request.startsWith("typescript/")) {
    throw Object.assign(new Error(`Cannot find module '${request}'`), { code: "MODULE_NOT_FOUND" });
  }
  return resolve.call(this, request, ...rest);
};
