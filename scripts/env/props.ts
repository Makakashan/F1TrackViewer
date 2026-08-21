/**
 * Props placed by coordinate (docs/city-generation.md D10, D16, P4.2).
 *
 * Everything else in the bake is derived from a measurement: the terrain from
 * the raster, the buildings from their footprints, the coast from a surveyed
 * line. A prop is the opposite — it is there because somebody says it is, and
 * the whole question is where.
 *
 * So there are two ways in and one way out. A placement either comes from the
 * overrides file, where a human wrote the coordinate down, or it is derived
 * from geometry the bake already trusts — the yachts are berthed along the
 * pontoons the harbour survey gave us, not typed in one by one. Both end up as
 * the same record, and the same builder turns it into triangles.
 *
 * The geometry is parametric rather than modelled. A prop that reads correctly
 * at 100 m is a silhouette, and a silhouette costs about seventy triangles;
 * modelling it would cost an asset pipeline, a licence and a megabyte. Where a
 * real model is wanted, a placement may name a `.glb` instead and it is merged
 * in as it stands.
 */

import { readFile } from "node:fs/promises";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

import type { HeightField } from "./heightfield";
import { addFlatQuad, addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { PierResult } from "./piers";
import type { ScenePlane } from "./plane";

export type PropKind = "yacht" | "crane" | "grandstand";

export interface PropPlacement {
  kind?: PropKind;
  /** A `.glb` under the repo root, placed instead of a parametric shape. */
  model?: string;
  lon: number;
  lat: number;
  /** Degrees clockwise from north, the way a compass bearing reads. */
  headingDeg?: number;
  /** Overall length along the heading. Each kind has its own default. */
  lengthM?: number;
  /**
   * Multiplier on a model's own units. glTF says metres and files disagree —
   * the repo's own car is authored 6 cm long — so the placement says what one
   * unit of this file is worth. Ignored by the parametric kinds, which take
   * `lengthM` instead.
   */
  scale?: number;
  note?: string;
}

export interface PropResult {
  /** Below the waterline and the road: hulls, tower legs, stand frames. */
  dark: Mesh;
  /** Above it: superstructure, jibs, seating decks. */
  light: Mesh;
  stats: {
    placed: number;
    berthed: number;
    fromOverrides: number;
    fromModels: number;
    skippedAground: number;
    byKind: Record<string, number>;
  };
}

// ─── berthing ──────────────────────────────────────────────────────────────

/** Least deck a boat is worth berthing along. Shorter is a landing stage. */
const MIN_BERTH_DECK_M = 25;
/** Clear water a hull needs, measured from the pontoon it is tied to. */
const BERTH_CLEAR_M = 1.5;
/** Gap between neighbouring hulls, on top of their beam. */
const BERTH_GAP_M = 3;
/** Both ends of a pontoon are left free — that is where it meets the quay. */
const BERTH_MARGIN_M = 8;
const YACHT_MIN_M = 18;
const YACHT_MAX_M = 46;

/**
 * The long axis of a deck, and how far it runs each way.
 *
 * A pontoon is a long thin ring, so its principal axis is its length — found
 * from the covariance of its own points rather than from the first and last,
 * which on a surveyed ring are wherever the mapper started drawing.
 */
function deckAxis(ring: { x: number; z: number }[]) {
  let cx = 0;
  let cz = 0;
  for (const point of ring) {
    cx += point.x;
    cz += point.z;
  }
  cx /= ring.length;
  cz /= ring.length;

  let xx = 0;
  let xz = 0;
  let zz = 0;
  for (const point of ring) {
    const dx = point.x - cx;
    const dz = point.z - cz;
    xx += dx * dx;
    xz += dx * dz;
    zz += dz * dz;
  }
  // Leading eigenvector of a symmetric 2x2, in closed form.
  const trace = xx + zz;
  const det = xx * zz - xz * xz;
  const eigen = trace / 2 + Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
  let ux = xz;
  let uz = eigen - xx;
  if (Math.hypot(ux, uz) < 1e-6) {
    ux = 1;
    uz = 0;
  }
  const length = Math.hypot(ux, uz);
  ux /= length;
  uz /= length;

  let halfLength = 0;
  let halfWidth = 0;
  for (const point of ring) {
    const dx = point.x - cx;
    const dz = point.z - cz;
    halfLength = Math.max(halfLength, Math.abs(dx * ux + dz * uz));
    halfWidth = Math.max(halfWidth, Math.abs(dx * -uz + dz * ux));
  }
  return { cx, cz, ux, uz, halfLength, halfWidth };
}

/** Repeatable pseudo-randomness: the same berth gets the same boat every bake. */
function hashed(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Yachts moored stern-to along the pontoons, the way the Mediterranean does it.
 *
 * Nothing here is typed in. The berths come from the decks P4.0d already
 * extrudes from the harbour survey, and a boat is only placed where the field
 * agrees there is water under it — which is what keeps them out of the quay
 * behind the pontoon and off the moles.
 */
export function berthYachts(
  piers: PierResult,
  field: HeightField,
  plane: ScenePlane,
): PropPlacement[] {
  const berths: PropPlacement[] = [];
  let seed = 1;
  for (const deck of piers.decks) {
    if (deck.kind !== "pier") continue;
    const axis = deckAxis(deck.ring);
    if (axis.halfLength * 2 < MIN_BERTH_DECK_M) continue;

    for (const side of [-1, 1]) {
      const nx = -axis.uz * side;
      const nz = axis.ux * side;
      let along = -axis.halfLength + BERTH_MARGIN_M;
      while (along <= axis.halfLength - BERTH_MARGIN_M) {
        seed++;
        const lengthM = YACHT_MIN_M + hashed(seed) * (YACHT_MAX_M - YACHT_MIN_M);
        const beam = lengthM / 4.6;
        const offset = axis.halfWidth + BERTH_CLEAR_M;
        const sternX = axis.cx + axis.ux * along + nx * offset;
        const sternZ = axis.cz + axis.uz * along + nz * offset;
        along += beam + BERTH_GAP_M;

        // Water under the whole hull, or the boat is sitting on the quay behind
        // the pontoon. Checked across the beam as well as along the keel: a
        // centreline test passed boats whose shoulder was over the rocks, and
        // the audit counted them.
        let afloat = true;
        for (let t = 0; t <= 1.0001 && afloat; t += 0.125) {
          for (const across of [-beam / 2, 0, beam / 2]) {
            const x = sternX + nx * lengthM * t + axis.ux * across;
            const z = sternZ + nz * lengthM * t + axis.uz * across;
            if (!field.isWater(plane.lon(x), plane.lat(z))) {
              afloat = false;
              break;
            }
          }
        }
        if (!afloat) continue;

        berths.push({
          kind: "yacht",
          lon: plane.lon(sternX),
          lat: plane.lat(sternZ),
          headingDeg: (Math.atan2(nx, nz) * 180) / Math.PI,
          lengthM,
        });
      }
    }
  }
  return berths;
}

// ─── parametric shapes ─────────────────────────────────────────────────────

interface Frame {
  /** Origin, at the stern for a boat and at the centre for anything else. */
  x: number;
  y: number;
  z: number;
  /** Along the heading, and across it to the right. */
  ux: number;
  uz: number;
  nx: number;
  nz: number;
}

function at(frame: Frame, along: number, across: number, up: number) {
  return {
    x: frame.x + frame.ux * along + frame.nx * across,
    y: frame.y + up,
    z: frame.z + frame.uz * along + frame.nz * across,
  };
}

function box(
  mesh: Mesh,
  frame: Frame,
  from: number,
  to: number,
  halfWidth: number,
  base: number,
  top: number,
) {
  const corners = [
    [from, -halfWidth],
    [to, -halfWidth],
    [to, halfWidth],
    [from, halfWidth],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const [a0, a1] = corners[i];
    const [b0, b1] = corners[(i + 1) % 4];
    const a = at(frame, a0, a1, base);
    const b = at(frame, b0, b1, base);
    const c = at(frame, b0, b1, top);
    const d = at(frame, a0, a1, top);
    addFlatQuad(mesh, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
  }
  const [p, q, r, s] = corners.map(([a0, a1]) => at(frame, a0, a1, top));
  addFlatQuad(mesh, p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z, s.x, s.y, s.z);
}

/**
 * A hull, lofted from five stations: square transom, full amidships, fine bow.
 *
 * Read from the quay a boat is a waterline, a sheer and a deckhouse, and this
 * is those three. The stations are the ratios a displacement motor yacht
 * actually carries, so a 40 m boat comes out 8.7 m in the beam rather than
 * whatever a box would have given.
 */
const HULL_STATIONS: [number, number][] = [
  [0.0, 0.44],
  [0.18, 0.5],
  [0.5, 0.5],
  [0.78, 0.38],
  [1.0, 0.05],
];

function yacht(dark: Mesh, light: Mesh, frame: Frame, lengthM: number) {
  const beam = lengthM / 4.6;
  const freeboard = lengthM * 0.075;
  const draught = lengthM * 0.03;
  /** Sheer: the deck rises toward the bow. Without it the hull is a wedge of
   *  paper — the first version read as a barge from the quay. */
  const sheerAt = (t: number) => freeboard * (1 + 0.45 * t * t);

  for (let i = 0; i < HULL_STATIONS.length - 1; i++) {
    const [t0, w0] = HULL_STATIONS[i];
    const [t1, w1] = HULL_STATIONS[i + 1];
    const a0 = t0 * lengthM;
    const a1 = t1 * lengthM;
    const h0 = w0 * beam;
    const h1 = w1 * beam;
    const y0 = sheerAt(t0);
    const y1 = sheerAt(t1);
    for (const side of [-1, 1]) {
      const a = at(frame, a0, h0 * side, y0);
      const b = at(frame, a1, h1 * side, y1);
      const c = at(frame, a1, h1 * side * 0.35, -draught);
      const d = at(frame, a0, h0 * side * 0.35, -draught);
      if (side < 0) {
        addFlatQuad(dark, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      } else {
        addFlatQuad(dark, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }
    }
    // The deck, closing the sheer over each pair of stations.
    const p = at(frame, a0, -h0, y0);
    const q = at(frame, a1, -h1, y1);
    const r = at(frame, a1, h1, y1);
    const s = at(frame, a0, h0, y0);
    addFlatQuad(light, p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z, s.x, s.y, s.z);
  }

  // A deckhouse, set back from both ends and narrower than the beam, so the
  // silhouette is a boat rather than a container on a raft.
  box(
    light,
    frame,
    lengthM * 0.26,
    lengthM * 0.56,
    beam * 0.3,
    freeboard,
    freeboard + lengthM * 0.07,
  );
}

/** A harbour crane: a tower on the quay and a jib reaching over the water. */
function crane(dark: Mesh, light: Mesh, frame: Frame, lengthM: number) {
  const leg = lengthM * 0.15;
  box(dark, frame, -leg, leg, leg, 0, lengthM * 0.86);
  box(light, frame, -leg * 0.7, lengthM * 0.9, leg * 0.35, lengthM * 0.86, lengthM);
}

/** A grandstand: a bank of seating raked back from the track. */
function grandstand(dark: Mesh, light: Mesh, frame: Frame, lengthM: number) {
  const depth = lengthM * 0.28;
  const height = lengthM * 0.22;
  box(dark, frame, -lengthM / 2, lengthM / 2, depth / 2, 0, height * 0.25);
  // The rake: a single sloped face is what reads as seating at this distance.
  const a = at(frame, -lengthM / 2, -depth / 2, height * 0.25);
  const b = at(frame, lengthM / 2, -depth / 2, height * 0.25);
  const c = at(frame, lengthM / 2, depth / 2, height);
  const d = at(frame, -lengthM / 2, depth / 2, height);
  addFlatQuad(light, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
  for (const [end, side] of [[-lengthM / 2, -1], [lengthM / 2, 1]] as const) {
    const p = at(frame, end, -depth / 2, height * 0.25);
    const q = at(frame, end, depth / 2, height * 0.25);
    const r = at(frame, end, depth / 2, height);
    if (side < 0) addFlatTriangle(light, p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    else addFlatTriangle(light, p.x, p.y, p.z, r.x, r.y, r.z, q.x, q.y, q.z);
  }
}

const DEFAULT_LENGTH_M: Record<PropKind, number> = {
  yacht: 30,
  crane: 28,
  grandstand: 40,
};

// ─── models ────────────────────────────────────────────────────────────────

/**
 * A `.glb` merged in where it is placed.
 *
 * The parametric kinds cover what can be described in a sentence. Anything with
 * a name — the Casino, a particular sculpture — is a model somebody drew, and
 * this is the door for it. Its own transforms are baked down first, so what
 * arrives is triangles in the file's own metres, and only the placement moves
 * them.
 */
async function readModel(path: string): Promise<Mesh> {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const document: Document = await io.readBinary(new Uint8Array(await readFile(path)));
  const mesh = createMesh();
  for (const node of document.getRoot().listNodes()) {
    const source = node.getMesh();
    if (!source) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of source.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      if (!position || !indices) continue;
      const v = [0, 0, 0];
      const world = (index: number) => {
        position.getElement(index, v);
        return [
          matrix[0] * v[0] + matrix[4] * v[1] + matrix[8] * v[2] + matrix[12],
          matrix[1] * v[0] + matrix[5] * v[1] + matrix[9] * v[2] + matrix[13],
          matrix[2] * v[0] + matrix[6] * v[1] + matrix[10] * v[2] + matrix[14],
        ];
      };
      for (let i = 0; i < indices.getCount(); i += 3) {
        const a = world(indices.getScalar(i));
        const b = world(indices.getScalar(i + 1));
        const c = world(indices.getScalar(i + 2));
        addFlatTriangle(mesh, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      }
    }
  }
  return mesh;
}

function placeModel(target: Mesh, source: Mesh, frame: Frame, scale: number) {
  const base = target.positions.length / 3;
  for (let i = 0; i < source.positions.length; i += 3) {
    const along = source.positions[i + 2] * scale;
    const across = source.positions[i] * scale;
    const point = at(frame, along, across, source.positions[i + 1] * scale);
    target.positions.push(point.x, point.y, point.z);
    const nAlong = source.normals[i + 2];
    const nAcross = source.normals[i];
    target.normals.push(
      frame.ux * nAlong + frame.nx * nAcross,
      source.normals[i + 1],
      frame.uz * nAlong + frame.nz * nAcross,
    );
  }
  for (const index of source.indices) target.indices.push(base + index);
}

// ─── build ─────────────────────────────────────────────────────────────────

export async function buildProps(
  placements: PropPlacement[],
  field: HeightField,
  plane: ScenePlane,
  repoRoot: string,
): Promise<PropResult> {
  const dark = createMesh();
  const light = createMesh();
  const stats: PropResult["stats"] = {
    placed: 0,
    berthed: 0,
    fromOverrides: 0,
    fromModels: 0,
    skippedAground: 0,
    byKind: {},
  };

  const models = new Map<string, Mesh>();
  for (const placement of placements) {
    if (!placement.model || models.has(placement.model)) continue;
    models.set(placement.model, await readModel(`${repoRoot}/${placement.model}`));
  }

  for (const placement of placements) {
    const x = plane.x(placement.lon);
    const z = plane.z(placement.lat);
    const heading = ((placement.headingDeg ?? 0) * Math.PI) / 180;
    // A boat floats at the datum; everything else stands on the ground, and
    // where there is no ground there is nothing to stand on.
    const floats = placement.kind === "yacht";
    const ground = field.heightAt(placement.lon, placement.lat);
    if (!floats && Number.isNaN(ground)) {
      stats.skippedAground++;
      continue;
    }
    const frame: Frame = {
      x,
      y: floats ? 0 : ground,
      z,
      ux: Math.sin(heading),
      uz: Math.cos(heading),
      nx: Math.cos(heading),
      nz: -Math.sin(heading),
    };

    const model = placement.model ? models.get(placement.model) : undefined;
    if (model) {
      placeModel(light, model, frame, placement.scale ?? 1);
      stats.fromModels++;
    } else {
      const kind = placement.kind ?? "yacht";
      const lengthM = placement.lengthM ?? DEFAULT_LENGTH_M[kind];
      if (kind === "yacht") yacht(dark, light, frame, lengthM);
      else if (kind === "crane") crane(dark, light, frame, lengthM);
      else grandstand(dark, light, frame, lengthM);
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    }
    stats.placed++;
  }

  return { dark, light, stats };
}
