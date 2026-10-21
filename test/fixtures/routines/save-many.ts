// A second body for routine-library.test.ts: its own process and its own RoutineLibrary on a shared
// directory. Reports `ready`; for each routine name it is sent, saves `count` distinct sources of it
// at once and reports `done`. The parent sends the same name to every body together, so they save
// at the same time.
import { RoutineLibrary } from "../../../src/host/routines/library.ts";

const [dir, who, count] = process.argv.slice(2) as [string, string, string];
const library = new RoutineLibrary({ dir, savedBy: who });

process.on("message", async (name: string) => {
  await Promise.all(Array.from({ length: Number(count) }, (_, i) => library.save(name, `export default "${who}-${i}";\n`)));
  process.send!("done");
});
process.on("disconnect", () => process.exit(0));
process.send!("ready");
