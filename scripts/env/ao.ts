/**
 * Ambient occlusion baked into vertex colours: the city and sun are static, so pay
 * once at bake time instead of a screen-space pass every frame.
 */

import type { HeightField } from "./heightfield";
import type { Mesh } from "./mesh";
import type { ScenePlane } from "./plane";

/** Resolution of the occluder height map. Fine enough for a street, coarse
 *  enough to sweep in a second. */
const CELL_M = 4;
/** Sixteen directions, offset half a step, or shade comes out square on the grid axes. */
const AZIMUTHS = 16;
const AZIMUTH_OFFSET = Math.PI / AZIMUTHS;
const RANGES_M = [2, 3, 5, 8, 12, 18, 26, 38];
/** Full shade never goes below this: an unlit crevice is a hole, not a shadow. */
const FLOOR = 0.62;
/** Raw sky visibility barely shades a street, so a curve deepens enclosed places. */
const CONTRAST = 1.7;

export interface Occluders {
  heights: Float32Array;
  width: number;
  height: number;
  minX: number;
  minZ: number;
  cellM: number;
}

/** The skyline as a grid: terrain plus the buildings just built. */
export function buildOccluders(
  field: HeightField,
  plane: ScenePlane,
  standing: Mesh[],
  /** The ground as it is drawn: the raw field's ripple and spikes cast shade the mesh has not got. */
  groundAt: (x: number, z: number) => number,
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
      const ground = groundAt(minX + (col + 0.5) * CELL_M, minZ + (row + 0.5) * CELL_M);
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
          // Only the cells the triangle reaches: its bounding box stamped a
          // diagonal wall's whole rectangle, and the open ground beside it went grey.
          const x = minX + (col + 0.5) * CELL_M;
          const z = minZ + (row + 0.5) * CELL_M;
          if (planDistance(x, z, mesh.positions, a, b, c) > CELL_REACH_M) continue;
          const index = row * width + col;
          if (top > heights[index]) heights[index] = top;
        }
      }
    }
  }

  return { heights, width, height, minX, minZ, cellM: CELL_M };
}

/** A cell is touched by a triangle that comes within its half-diagonal of its centre. */
const CELL_REACH_M = CELL_M * Math.SQRT1_2;

/** Distance in plan from (x, z) to triangle a, b, c; zero inside it. A wall's triangle is a line in plan. */
function planDistance(x: number, z: number, positions: number[], a: number, b: number, c: number): number {
  const ax = positions[a], az = positions[a + 2];
  const bx = positions[b], bz = positions[b + 2];
  const cx = positions[c], cz = positions[c + 2];
  const side = (px: number, pz: number, qx: number, qz: number) => (qx - px) * (z - pz) - (qz - pz) * (x - px);
  const d1 = side(ax, az, bx, bz);
  const d2 = side(bx, bz, cx, cz);
  const d3 = side(cx, cz, ax, az);
  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (area !== 0 && ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0))) return 0;
  return Math.min(
    segmentDistance(x, z, ax, az, bx, bz),
    segmentDistance(x, z, bx, bz, cx, cz),
    segmentDistance(x, z, cx, cz, ax, az),
  );
}

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

/** Interpolate the skyline between cells, or shadows step along the grid. */
function heightAt(occluders: Occluders, x: number, z: number): number {
  const { heights, width, height, minX, minZ, cellM } = occluders;
  const fx = (x - minX) / cellM - 0.5;
  const fz = (z - minZ) / cellM - 0.5;
  const col = Math.floor(fx);
  const row = Math.floor(fz);
  if (col < -1 || row < -1 || col >= width || row >= height) return 0;
  const u = fx - col;
  const v = fz - row;
  const at = (r: number, c: number): number => {
    if (r < 0 || c < 0 || r >= height || c >= width) return 0;
    return heights[r * width + c];
  };
  const top = at(row, col) * (1 - u) + at(row, col + 1) * u;
  const bottom = at(row + 1, col) * (1 - u) + at(row + 1, col + 1) * u;
  return top * (1 - v) + bottom * v;
}

/** The grey a point at (x, y, z) takes from the sky it sees: 1 open, `FLOOR` walled in. */
function openSky(occluders: Occluders, x: number, y: number, z: number): number {
  let blocked = 0;
  for (let a = 0; a < AZIMUTHS; a++) {
    const angle = (2 * Math.PI * a) / AZIMUTHS + AZIMUTH_OFFSET;
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
  return FLOOR + (1 - FLOOR) * Math.max(0, Math.min(1, openness)) ** CONTRAST;
}

/** A grey per vertex, 1 for open sky down to `FLOOR`. glTF multiplies it into the base colour. */
export function applyAmbientOcclusion(mesh: Mesh, occluders: Occluders): void {
  const count = mesh.positions.length / 3;
  const colors = new Array<number>(count * 3);
  for (let i = 0; i < count; i++) {
    const shade = openSky(occluders, mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  const flats = mesh.flats ?? [];
  for (let f = 0; f < flats.length; f += 2) {
    let sum = 0;
    for (let i = flats[f]; i < flats[f + 1]; i++) sum += colors[i * 3];
    const shade = sum / Math.max(1, flats[f + 1] - flats[f]);
    for (let i = flats[f] * 3; i < flats[f + 1] * 3; i++) colors[i] = shade;
  }
  mesh.colors = colors;
}

/** Below this the ground is flat enough to leave alone. */
const FLAT_DEG = 12;
/** At and beyond this it is as dark as ground gets. */
const STEEP_DEG = 55;
/** What the steepest ground keeps of its own colour. */
const STEEP_SHADE = 0.78;
/** The steepest ground's warmth, as a multiplier per channel. */
const ROCK_TINT: [number, number, number] = [1, 0.985, 0.96];
/** How far the shade is spread over the ground, and how hard. */
const SHADE_BLUR_PASSES = 3;
const SHADE_BLUR_STRENGTH = 0.7;

/** Slope darkens and warms what AO left lit, so open hillside still shows relief. */
function slopeShade(grey: number, slopeDeg: number): [number, number, number] {
  const flat = Math.cos((FLAT_DEG * Math.PI) / 180);
  const steep = Math.cos((STEEP_DEG * Math.PI) / 180);
  const up = Math.cos((Math.min(89, slopeDeg) * Math.PI) / 180);
  if (up >= flat) return [grey, grey, grey];
  const t = Math.max(0, Math.min(1, (flat - up) / (flat - steep)));
  // Smoothstep, or the first degree past flat shows as a band.
  const k = t * t * (3 - 2 * t) * Math.max(0, Math.min(1, (grey - FLOOR) / (1 - FLOOR)));
  const shade = grey * (1 - (1 - STEEP_SHADE) * k);
  return ROCK_TINT.map((tint) => shade * (1 + (tint - 1) * k)) as [number, number, number];
}

export interface GroundShade {
  /** The ground's colour at a point, blurred to the mesh's cell. Null if no ground is near. */
  at(x: number, z: number, cell: number): [number, number, number] | null;
  /** Lattice nodes the slope darkened, for the report. */
  sloped: number;
}

/**
 * Ground shade worked out once on a lattice and read by every belt, so seams don't show as
 * patches.
 */
export function buildGroundShade(
  occluders: Occluders,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  groundAt: (x: number, z: number) => number,
  slopeDegAt: (x: number, z: number) => number,
): GroundShade {
  const width = Math.ceil((bounds.maxX - bounds.minX) / CELL_M) + 1;
  const height = Math.ceil((bounds.maxZ - bounds.minZ) / CELL_M) + 1;
  const raw = new Float32Array(width * height * 3).fill(Number.NaN);
  let sloped = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = bounds.minX + col * CELL_M;
      const z = bounds.minZ + row * CELL_M;
      const y = groundAt(x, z);
      if (Number.isNaN(y)) continue;
      const grey = openSky(occluders, x, y, z);
      const rgb = slopeShade(grey, slopeDegAt(x, z));
      if (rgb[0] < grey) sloped++;
      raw.set(rgb, (row * width + col) * 3);
    }
  }

  // Grey in, grey out: the blur moves one number and keeps each node's tint.
  const blur = (from: Float32Array, passes: number): Float32Array => {
    let colour = from;
    for (let pass = 0; pass < passes; pass++) {
      const next = colour.slice();
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const i = (row * width + col) * 3;
          const here = colour[i];
          if (Number.isNaN(here)) continue;
          let sum = here;
          let count = 1;
          for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const r = row + dr;
            const c = col + dc;
            if (r < 0 || c < 0 || r >= height || c >= width) continue;
            const other = colour[(r * width + c) * 3];
            if (Number.isNaN(other)) continue;
            sum += other;
            count++;
          }
          const shade = here + (sum / count - here) * SHADE_BLUR_STRENGTH;
          next[i] = shade;
          next[i + 1] = (colour[i + 1] / here) * shade;
          next[i + 2] = (colour[i + 2] / here) * shade;
        }
      }
      colour = next;
    }
    return colour;
  };
  // A diffusion spreads with the square root of its passes, so twice the cell
  // takes four times the passes.
  const levels = new Map<number, Float32Array>();
  let reached = blur(raw, SHADE_BLUR_PASSES);
  let passes = SHADE_BLUR_PASSES;
  for (const cell of [CELL_M, 2 * CELL_M, 4 * CELL_M]) {
    const wanted = SHADE_BLUR_PASSES * (cell / CELL_M) ** 2;
    reached = blur(reached, wanted - passes);
    passes = wanted;
    levels.set(cell, reached);
  }

  const at = (x: number, z: number, cell: number): [number, number, number] | null => {
    const colour = levels.get(cell) ?? levels.get(CELL_M)!;
    const fx = (x - bounds.minX) / CELL_M;
    const fz = (z - bounds.minZ) / CELL_M;
    const col = Math.floor(fx);
    const row = Math.floor(fz);
    const u = fx - col;
    const v = fz - row;
    const out: [number, number, number] = [0, 0, 0];
    let weight = 0;
    // Bilinear over whichever corners are ground, so the waterline reads the land.
    for (const [dr, dc, w] of [[0, 0, (1 - u) * (1 - v)], [0, 1, u * (1 - v)], [1, 0, (1 - u) * v], [1, 1, u * v]]) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= height || c >= width || w === 0) continue;
      const i = (r * width + c) * 3;
      if (Number.isNaN(colour[i])) continue;
      for (let k = 0; k < 3; k++) out[k] += colour[i + k] * w;
      weight += w;
    }
    return weight > 0 ? (out.map((value) => value / weight) as [number, number, number]) : null;
  };

  return { at, sloped };
}

/** Paint a belt's ground from the shared field; vertices beyond it shade themselves. */
export function paintGround(
  mesh: Mesh,
  shade: GroundShade,
  occluders: Occluders,
  slopeDegAt: (x: number, z: number) => number,
  /** The mesh scale a point is read at; see `BeltBlocks.coarsestCellAt`. */
  cellAt: (x: number, z: number) => number,
): void {
  const count = mesh.positions.length / 3;
  const colors = new Array<number>(count * 3);
  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    const rgb = shade.at(x, z, cellAt(x, z)) ?? slopeShade(openSky(occluders, x, y, z), slopeDegAt(x, z));
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  mesh.colors = colors;
}

/** Multiply a model's own colour back in after AO, which writes `colors` from scratch. */
export function applyAlbedo(mesh: Mesh, tone: [number, number, number]): number {
  if (!mesh.colors || !mesh.albedo) return 0;
  const count = Math.min(mesh.colors.length, mesh.albedo.length) / 3;
  for (let i = 0; i < count; i++) {
    const r = mesh.albedo[i * 3];
    const g = mesh.albedo[i * 3 + 1];
    const b = mesh.albedo[i * 3 + 2];
    // Keep the tone (roof versus wall), drop most of the kit's chroma toward the city's hue.
    const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    mesh.colors[i * 3] *= (grey + (r - grey) * CHROMA_KEPT) * tone[0];
    mesh.colors[i * 3 + 1] *= (grey + (g - grey) * CHROMA_KEPT) * tone[1];
    mesh.colors[i * 3 + 2] *= (grey + (b - grey) * CHROMA_KEPT) * tone[2];
  }
  return count;
}

/** How much of a merged model's own colour survives. */
const CHROMA_KEPT = 0.35;
