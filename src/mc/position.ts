// Positions as routine arguments (an {x, y, z} object or a [x, y, z] tuple) and as the wire reports them.
import { Vec3 } from "vec3";
import { z } from "zod";
import type { Vec } from "../protocol/index.ts";

/** A point as the wire carries it: what actions that return a location declare in `returns` (a Vec3 satisfies it). */
export const Point = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof Point>;

/**
 * A point as a routine argument: `{ x, y, z }` or three numbers in an array. Its input type admits any
 * `number[]` — agents compute `[x, y, z]` in a variable, and the runtime accepts it — while the schema
 * still checks that it holds exactly three numbers.
 */
export const Position: z.ZodType<Position, Point | number[]> = z.union([Point, z.tuple([z.number(), z.number(), z.number()])]) as z.ZodType<Position, Point | number[]>;
export type Position = Point | [number, number, number];

export function toVec3(p: Point | number[]): Vec3 {
  return Array.isArray(p) ? new Vec3(p[0]!, p[1]!, p[2]!) : new Vec3(p.x, p.y, p.z);
}

/** Rounds to two decimals, the precision observations and events report. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A position as the wire reports it. */
export function vec(v: Vec): Vec {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}
