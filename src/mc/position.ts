// Positions as kit arguments (an {x, y, z} object or a [x, y, z] tuple) and as the wire reports them.
import { Vec3 } from "vec3";
import { z } from "zod";
import type { Vec } from "../protocol/index.ts";

/** A point as the wire carries it: what actions that return a location declare in `returns` (a Vec3 satisfies it). */
export const Point = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof Point>;

export const Position = z.union([Point, z.tuple([z.number(), z.number(), z.number()])]);
export type Position = z.infer<typeof Position>;

export function toVec3(p: Position): Vec3 {
  return Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z);
}

/** Rounds to two decimals, the precision observations and events report. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A position as the wire reports it. */
export function vec(v: Vec): Vec {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}
