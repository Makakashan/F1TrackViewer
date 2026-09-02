/**
 * Roof shapes (docs/city-generation.md D8).
 *
 * Flat prisms read as a block model, so a roof gets a form. Only 72 of Monaco's
 * 4 792 buildings carry `roof:shape`, so the tag decides where it exists and a
 * heuristic on size and height decides everywhere else.
 *
 * A pitched roof needs to know which way the building faces, which a footprint
 * ring does not say. The direction comes from the footprint's minimum-area
 * bounding rectangle, and a shape that does not fill its own rectangle — an L, a
 * courtyard block — keeps a flat roof, because a ridge across a plan like that
 * lands in mid-air.
 */

import { addFlatQuad, addFlatTriangle, type Mesh } from "./mesh";

export type RoofKind = "flat" | "gabled" | "hipped" | "pyramidal" | "skillion";

export interface XZ {
  x: number;
  z: number;
}

export interface OrientedBox {
  centre: XZ;
  /** Unit vector along the long side, and its perpendicular. */
  along: XZ;
  across: XZ;
  lengthM: number;
  widthM: number;
  areaM2: number;
}

export interface RoofPlan {
  kind: RoofKind;
  /** How much of the building's height the roof takes from the top. */
  heightM: number;
  box: OrientedBox | null;
}

export interface RoofTags {
  "roof:shape"?: string;
  "roof:height"?: string;
  "roof:levels"?: string;
  building?: string;
}

/** A footprint this far from filling its own rectangle keeps a flat roof. */
const RECTANGULARITY = 0.72;
/** Pitched roofs above this are towers with plant rooms, not houses. */
const MAX_PITCHED_HEIGHT_M = 12;
/** And above this footprint they are blocks, not houses. */
const MAX_PITCHED_AREA_M2 = 900;
const STOREY_M = 3.1;
/** Parapet on a flat roof: the rim that makes it read as a roof and not a lid. */
export const PARAPET_M = 0.9;

// ─── oriented bounding box ─────────────────────────────────────────────────

function convexHull(points: XZ[]): XZ[] {
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
  if (sorted.length < 3) return sorted;
  const cross = (o: XZ, a: XZ, b: XZ) =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower: XZ[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: XZ[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Rotating calipers: the rectangle of least area shares an edge with the hull. */
export function orientedBox(ring: XZ[]): OrientedBox | null {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;

  let best: OrientedBox | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeLength = Math.hypot(b.x - a.x, b.z - a.z);
    if (edgeLength < 1e-6) continue;
    const ux = (b.x - a.x) / edgeLength;
    const uz = (b.z - a.z) / edgeLength;
    const vx = -uz;
    const vz = ux;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of hull) {
      const u = point.x * ux + point.z * uz;
      const v = point.x * vx + point.z * vz;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const depth = maxV - minV;
    const area = width * depth;
    if (best && area >= best.areaM2) continue;

    const centreU = (minU + maxU) / 2;
    const centreV = (minV + maxV) / 2;
    const centre = {
      x: ux * centreU + vx * centreV,
      z: uz * centreU + vz * centreV,
    };
    // "Along" is the long side, so a ridge runs the way the building does.
    const longIsU = width >= depth;
    best = {
      centre,
      along: longIsU ? { x: ux, z: uz } : { x: vx, z: vz },
      across: longIsU ? { x: vx, z: vz } : { x: ux, z: uz },
      lengthM: Math.max(width, depth),
      widthM: Math.min(width, depth),
      areaM2: area,
    };
  }
  return best;
}

export function ringArea(ring: XZ[]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twice) / 2;
}

// ─── planning ──────────────────────────────────────────────────────────────

const TAG_TO_KIND: Record<string, RoofKind> = {
  flat: "flat",
  gabled: "gabled",
  hipped: "hipped",
  half_hipped: "hipped",
  side_hipped: "hipped",
  gambrel: "gabled",
  mansard: "hipped",
  pyramidal: "pyramidal",
  skillion: "skillion",
  lean_to: "skillion",
  round: "hipped",
  dome: "pyramidal",
  many: "flat",
};

export function planRoof(ring: XZ[], tags: RoofTags, totalHeightM: number): RoofPlan {
  const box = orientedBox(ring);
  const fill = box && box.areaM2 > 0 ? ringArea(ring) / box.areaM2 : 0;

  const tagged = tags["roof:shape"] ? TAG_TO_KIND[tags["roof:shape"]] : undefined;
  let kind: RoofKind;
  if (tagged && totalHeightM <= MAX_PITCHED_HEIGHT_M) {
    kind = tagged;
  } else if (
    !tagged &&
    box &&
    fill >= RECTANGULARITY &&
    totalHeightM <= MAX_PITCHED_HEIGHT_M &&
    box.areaM2 <= MAX_PITCHED_AREA_M2
  ) {
    // A small, low, rectangular building is a house, and houses have pitches.
    kind = box.lengthM / Math.max(1, box.widthM) > 2.4 ? "gabled" : "hipped";
  } else {
    kind = "flat";
  }

  if (kind !== "flat" && (!box || fill < RECTANGULARITY)) kind = "flat";

  const taggedHeight = Number.parseFloat(tags["roof:height"] ?? "");
  const taggedLevels = Number.parseFloat(tags["roof:levels"] ?? "");
  let heightM: number;
  if (Number.isFinite(taggedHeight)) heightM = taggedHeight;
  else if (Number.isFinite(taggedLevels)) heightM = taggedLevels * STOREY_M;
  else if (kind === "flat") heightM = 0;
  else if (kind === "skillion") heightM = Math.min(3, (box?.widthM ?? 6) * 0.18);
  else if (kind === "pyramidal") heightM = Math.min(7, (box?.widthM ?? 8) * 0.45);
  else heightM = Math.min(5.5, (box?.widthM ?? 8) * 0.32);

  // A roof may not eat the building it sits on.
  heightM = Math.max(0, Math.min(heightM, totalHeightM * 0.45));
  return { kind, heightM, box };
}

// ─── geometry ──────────────────────────────────────────────────────────────

/** Corners of the box at a height, in the order they go round. */
function boxCorners(box: OrientedBox, y: number) {
  const halfLength = box.lengthM / 2;
  const halfWidth = box.widthM / 2;
  const corner = (a: number, b: number) => ({
    x: box.centre.x + box.along.x * a + box.across.x * b,
    y,
    z: box.centre.z + box.along.z * a + box.across.z * b,
  });
  return [
    corner(-halfLength, -halfWidth),
    corner(halfLength, -halfWidth),
    corner(halfLength, halfWidth),
    corner(-halfLength, halfWidth),
  ];
}

/**
 * Adds the roof above `baseY`. The flat case is handled by the caller, which
 * already caps the prism; everything else is built on the oriented box.
 */
export function buildRoof(mesh: Mesh, plan: RoofPlan, baseY: number): void {
  const { box, kind, heightM } = plan;
  if (!box || kind === "flat" || heightM <= 0.05) return;

  const [a, b, c, d] = boxCorners(box, baseY);
  const topY = baseY + heightM;
  const halfLength = box.lengthM / 2;
  const centre = box.centre;

  // Every face is wound the other way round from how this used to read them:
  // taken in the order the corners go round, each one came out facing into the
  // roof, so the whole cap was culled and you looked through it at the inside
  // of the far slope. Measured: 6 of 6 faces inward on a gable, 4 of 4 on a
  // pyramid, both windings of the ring.
  if (kind === "pyramidal") {
    const apex = { x: centre.x, y: topY, z: centre.z };
    for (const [p, q] of [[a, b], [b, c], [c, d], [d, a]] as const) {
      addFlatTriangle(mesh, q.x, q.y, q.z, p.x, p.y, p.z, apex.x, apex.y, apex.z);
    }
    return;
  }

  if (kind === "skillion") {
    // One long edge lifted: the a–b side stays down, the c–d side rises.
    const cUp = { ...c, y: topY };
    const dUp = { ...d, y: topY };
    addFlatQuad(mesh, dUp.x, dUp.y, dUp.z, cUp.x, cUp.y, cUp.z, b.x, b.y, b.z, a.x, a.y, a.z);
    addFlatTriangle(mesh, cUp.x, cUp.y, cUp.z, c.x, c.y, c.z, b.x, b.y, b.z);
    addFlatTriangle(mesh, dUp.x, dUp.y, dUp.z, a.x, a.y, a.z, d.x, d.y, d.z);
    return;
  }

  // Gabled and hipped share a ridge along the long axis; hipped pulls its ends
  // in by half the width, which is what turns the gable wall into a slope.
  const inset = kind === "hipped" ? Math.min(box.widthM / 2, halfLength * 0.9) : 0;
  const ridge = (t: number) => ({
    x: centre.x + box.along.x * t,
    y: topY,
    z: centre.z + box.along.z * t,
  });
  const ridgeA = ridge(-halfLength + inset);
  const ridgeB = ridge(halfLength - inset);

  addFlatQuad(mesh, ridgeA.x, ridgeA.y, ridgeA.z, ridgeB.x, ridgeB.y, ridgeB.z, b.x, b.y, b.z, a.x, a.y, a.z);
  addFlatQuad(mesh, ridgeB.x, ridgeB.y, ridgeB.z, ridgeA.x, ridgeA.y, ridgeA.z, d.x, d.y, d.z, c.x, c.y, c.z);

  // The ends: a hip closes with a slope, a gable with the wall that carries the
  // ridge. Both are the same three points here — what differs is the inset that
  // put the ridge short of the end above.
  addFlatTriangle(mesh, ridgeA.x, ridgeA.y, ridgeA.z, a.x, a.y, a.z, d.x, d.y, d.z);
  addFlatTriangle(mesh, ridgeB.x, ridgeB.y, ridgeB.z, c.x, c.y, c.z, b.x, b.y, b.z);
}
