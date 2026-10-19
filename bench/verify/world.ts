// Reads the containers out of a saved world: the block entities with an inventory, in every chunk of every region file.
// The snapshot (snapshot.ts) uses it after the server flushed its chunks, so the contents are the server's own record.
// It runs in the body's container, which mounts the world volume read-only; it is not part of the verifier image.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync, gunzipSync } from "node:zlib";
import nbt from "prismarine-nbt";
import { z } from "zod";
import type { ContainerFact } from "./checks.ts";

const SECTOR = 4096;
const CHUNKS_PER_REGION = 32 * 32;
const COMPRESSION_GZIP = 1;
const COMPRESSION_ZLIB = 2;
const COMPRESSION_NONE = 3;

/** Where the overworld's region files are in a 26.1 world. */
const REGION_DIR = path.join("dimensions", "minecraft", "overworld", "region");

/** The parts of a chunk's NBT that the containers need. A block entity without an inventory (a sign, a bed) has no `Items`. */
const Chunk = z.looseObject({
  block_entities: z
    .array(
      z.looseObject({
        id: z.string(),
        x: z.number().int(),
        y: z.number().int(),
        z: z.number().int(),
        Items: z.array(z.looseObject({ id: z.string(), count: z.number().int() })).optional(),
      }),
    )
    .default([]),
});

/** The decompressed NBT of each chunk in a region file's bytes. */
function* chunkPayloads(region: Buffer): Generator<Buffer> {
  for (let i = 0; i < CHUNKS_PER_REGION; i++) {
    // The location table: a 3-byte sector offset and a 1-byte sector count; an unwritten chunk has offset 0.
    if (region.length < (i + 1) * 4) return;
    const sector = region.readUIntBE(i * 4, 3);
    if (sector === 0) continue;
    const start = sector * SECTOR;
    const length = region.readInt32BE(start);
    const compression = region[start + 4]!;
    const data = region.subarray(start + 5, start + 4 + length);
    if (compression === COMPRESSION_ZLIB) yield inflateSync(data);
    else if (compression === COMPRESSION_GZIP) yield gunzipSync(data);
    else if (compression === COMPRESSION_NONE) yield data;
    else throw new Error(`chunk ${i} uses compression ${compression}; only deflate, gzip, and none are read (set region-file-compression=deflate)`);
  }
}

/** The containers in one region file's bytes. */
export async function containersInRegion(region: Buffer): Promise<ContainerFact[]> {
  const found: ContainerFact[] = [];
  for (const payload of chunkPayloads(region)) {
    const chunk = Chunk.parse(nbt.simplify((await nbt.parse(payload)).parsed));
    for (const entity of chunk.block_entities) {
      if (!entity.Items) continue;
      const items: Record<string, number> = {};
      for (const item of entity.Items) {
        const id = item.id.replace(/^minecraft:/, "");
        items[id] = (items[id] ?? 0) + item.count;
      }
      found.push({ block: entity.id.replace(/^minecraft:/, ""), position: [entity.x, entity.y, entity.z], items });
    }
  }
  return found;
}

/** The containers in the overworld of the world saved under `worldDir`. */
export async function readContainers(worldDir: string): Promise<ContainerFact[]> {
  const dir = path.join(worldDir, REGION_DIR);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".mca"));
  const found: ContainerFact[] = [];
  for (const file of files) found.push(...(await containersInRegion(await readFile(path.join(dir, file)))));
  return found;
}
