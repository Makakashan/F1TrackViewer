/**
 * Ambient occlusion, baked into vertex colours (docs/city-generation.md D9).
 *
 * The city and the sun are both static, so paying for occlusion once at
 * generation time and never again per frame is the only trade that makes sense
 * here — AGENTS.md puts frame rate first, and a screen-space pass costs a full
 * pass over every frame to compute something that never changes.
 *
 * What is computed is sky visibility: from each vertex, how much of the sky is
 * blocked by what stands around it. That is what darkens a courtyard, a street
 * canyon and the foot of a wall, which is the whole of the effect worth having.
 */

import type { HeightField } from "./heightfield";
import type { Mesh } from "./mesh";
import type { ScenePlane } from "./plane";

/** Resolution of the occluder height map. Fine enough for a street, coarse
 *  enough to sweep in a second. */
const CELL_M = 4;
/** Directions sampled around each vertex, and how far out along each. */
const AZIMUTHS = 8;
const RANGES_M = [2, 3, 5, 8, 12, 18, 26, 38];
/** Full shade never goes below this: an unlit crevice is a hole, not a shadow. */
const FLOOR = 0.45;
/**
 * Physical sky visibility is a gentle thing — a street with towers on two sides
 * still sees three quarters of the sky — and reads as no shading at all. The
 * curve keeps the open ground open and deepens the enclosed places, which is
 * what the effect is for.
 */
const CONTRAST = 2.6;

export interface Occluders {
  heights: Float32Array;
  width: number;
  height: number;
  minX: number;
  minZ: number;
  cellM: number;
}

/**
 * The skyline as a grid: the terrain, with whatever stands on it stamped on
 * top. Buildings come from the meshes that were just built, so nothing has to
 * agree twice about how tall they are.
 */
export function buildOccluders(
  field: HeightField,
  plane: ScenePlane,
  standing: Mesh[],
): Occluders {
  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat);
  const maxZ = plane.z(field.bbox.minLat);
  const width = Math.max(1, Math.ceil((maxX - minX) / CELL_M));
  const height = Math.max(1, Math.ceil((maxZ - minZ) / CELL_M));
  const heights = new Float32Array(width * height);

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const ground = field.heightAt(
        plane.lon(minX + (col + 0.5) * CELL_M),
        plane.lat(minZ + (row + 0.5) * CELL_M),
      );
      heights[row * width + col] = Number.isNaN(ground) ? 0 : ground;
    }
  }

  // Every triangle is rasterised, not just its corners. A wall carries vertices
  // only where its footprint turns, so stamping vertices alone lets a 40 m
  // block occlude two cells and leaves the street beside it in full sunlight.
  for (const mesh of standing) {
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i] * 3;
      const b = mesh.indices[i + 1] * 3;
      const c = mesh.indices[i + 2] * 3;
      const top = Math.max(mesh.positions[a + 1], mesh.positions[b + 1], mesh.positions[c + 1]);
      const colFrom = Math.max(0, Math.floor((Math.min(mesh.positions[a], mesh.positions[b], mesh.positions[c]) - minX) / CELL_M));
      const colTo = Math.min(width - 1, Math.ceil((Math.max(mesh.positions[a], mesh.positions[b], mesh.positions[c]) - minX) / CELL_M));
      const rowFrom = Math.max(0, Math.floor((Math.min(mesh.positions[a + 2], mesh.positions[b + 2], mesh.positions[c + 2]) - minZ) / CELL_M));
      const rowTo = Math.min(height - 1, Math.ceil((Math.max(mesh.positions[a + 2], mesh.positions[b + 2], mesh.positions[c + 2]) - minZ) / CELL_M));
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) {
          const index = row * width + col;
          if (top > heights[index]) heights[index] = top;
        }
      }
    }
  }

  return { heights, width, height, minX, minZ, cellM: CELL_M };
}

function heightAt(occluders: Occluders, x: number, z: number): number {
  const col = Math.floor((x - occluders.minX) / occluders.cellM);
  const row = Math.floor((z - occluders.minZ) / occluders.cellM);
  if (col < 0 || row < 0 || col >= occluders.width || row >= occluders.height) return 0;
  return occluders.heights[row * occluders.width + col];
}

/**
 * Writes a grey per vertex: 1 where the sky is open, `FLOOR` where it is walled
 * in. glTF multiplies vertex colour into the base colour, so the palette stays
 * the palette and this only shades it.
 */
export function applyAmbientOcclusion(mesh: Mesh, occluders: Occluders): void {
  const count = mesh.positions.length / 3;
  const colors = new Array<number>(count * 3);

  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];

    let blocked = 0;
    for (let a = 0; a < AZIMUTHS; a++) {
      const angle = (2 * Math.PI * a) / AZIMUTHS;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      let highest = 0;
      for (const range of RANGES_M) {
        const rise = heightAt(occluders, x + dx * range, z + dz * range) - y;
        if (rise <= 0) continue;
        // Elevation angle of the horizon in this direction, as a sine.
        const sine = rise / Math.hypot(rise, range);
        if (sine > highest) highest = sine;
      }
      blocked += highest;
    }

    const openness = 1 - blocked / AZIMUTHS;
    const shade = FLOOR + (1 - FLOOR) * Math.max(0, Math.min(1, openness)) ** CONTRAST;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }

  mesh.colors = colors;
}
