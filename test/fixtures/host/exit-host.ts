// A host that dies while it builds its world: exits with code 3 on `init`, never reporting ready.
process.on("message", () => process.exit(3));
