// The bot host's world: the state directory, the built-in routines on offer, the routine library and its
// bindings, the wiki, and the Body, served through the route table. Everything a program reads synchronously lives here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { HostInit, EventSink } from "../protocol/host.ts";
import type { SaveRoutineResponse } from "../protocol/index.ts";
import { Wiki } from "../wiki/wiki.ts";
import { Bindings } from "./bindings.ts";
import { Body, type RunRecorder } from "./body.ts";
import { Builtins } from "./routines/builtins.ts";
import { RoutineLibrary } from "./routines/library.ts";
import { RoutineLoader, setOfferGate } from "./routines/loader.ts";
import { KitStats } from "./routines/stats.ts";
import { type ApiRequest, bodyRoutes, serve } from "./routes.ts";
import { BodyState } from "./state.ts";
import { typeCheckRoutine } from "./typecheck.ts";

export interface World {
  readonly body: Body;
  /** Answers one API request. */
  serve(request: ApiRequest): Promise<{ status: number; body: unknown }>;
  /** Joins the server. */
  start(): void;
  /** Closes the body and writes the call counts still buffered. */
  close(): void;
}

/** Builds the world from the host's init. Throws with the reason when it cannot (an unknown built-in module, an unreadable state). */
export function buildWorld(options: HostInit, io: { events: EventSink; recorder: RunRecorder }): World {
  const state = new BodyState(options.stateDir);
  // Per-routine call counts live in the state directory; this one instance takes the built-in routines' counts.
  const stats = new KitStats(state.kitStats);
  const builtins = new Builtins({ offer: options.builtins, stats });
  setOfferGate(builtins.allows);

  // A body without routines has no library, no loader, and no bindings file.
  const routinesDir = options.routines === false ? undefined : (options.routinesDir ?? state.routinesDir);
  if (routinesDir) mkdirSync(routinesDir, { recursive: true });
  const routineLibrary = routinesDir ? new RoutineLibrary({ dir: routinesDir, savedBy: options.name }) : undefined;

  const wiki = options.wikiMode === "off" ? null : Wiki.load(options.wikiDir, options.lessonsDir);
  const body = new Body({
    username: options.username,
    auth: options.auth,
    authCacheDir: path.join(options.stateDir, "auth"),
    host: options.host,
    port: options.port,
    state,
    builtins,
    wiki,
    wikiMode: options.wikiMode,
    milestonesEnabled: options.milestonesEnabled,
    triggersEnabled: options.triggers ?? true,
    routines: routinesDir ? new RoutineLoader(routinesDir) : undefined,
    events: io.events,
    recorder: io.recorder,
    startedAt: options.startedAt,
    deaths: options.deaths,
    reconnects: options.reconnects,
    triggerFailures: options.triggerFailures,
    lostFiring: options.lostFiring,
  });
  if (options.applyMilestones && options.milestones) body.setMilestones(options.milestones);

  const routines = routineLibrary && {
    library: routineLibrary,
    bindings: new Bindings({ store: state.bindings, library: routineLibrary, triggers: body.triggers, events: io.events }),
    // The type check never blocks a save: it reports.
    save: async (name: string, source: string): Promise<SaveRoutineResponse> => {
      const routine = await routineLibrary.save(name, source);
      return { routine, typeCheck: await typeCheckRoutine(routineLibrary.dir, name) };
    },
  };
  const routes = bodyRoutes({ body, builtins, recorder: io.recorder, routines });
  return {
    body,
    serve: (request) => serve(routes, body, request),
    start: () => body.start(),
    close: () => {
      try {
        body.close();
      } finally {
        builtins.flush();
      }
    },
  };
}
