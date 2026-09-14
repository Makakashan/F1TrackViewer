import * as THREE from "three";
import { apronRoomAt, type ApronRoom } from "@/lib/track/track-apron";
import { halfWidthAt, type HalfWidth } from "@/lib/track/track-geometry";
import { FENCE_TILE_M } from "@/lib/track/surface-textures";
import { reachLimitAt, type ReachLimit } from "@/lib/track/track-reach-limit";

/** The barrier and catch fence lining a street circuit, built along the centreline the way the kerbs are. */

export const BARRIER_HEIGHT_M = 1.1;
export const BARRIER_THICKNESS_M = 0.3;
/** Sunk a little, so the wall meets whatever surface is under it without a gap. */
const BARRIER_FOOT_M = 0.4;
/** Just past the paving's edge, so the wall stands on it rather than in it. */
const BARRIER_SETBACK_M = 0.15;
/** Where a straight has barely a verge, the wall still stands clear of the white line. */
export const BARRIER_MIN_CLEARANCE_M = 0.8;
/** One hoarding's length. */
const BOARD_RUN_M = 48;
/** Blank boards: colour blocks, no text. */
const BOARD_COLORS = ["#1d4f91", "#1f6b3a", "#3a2c5c", "#26292e", "#e6e8eb", "#0f3d63", "#6b1f2a"].map(
  (hex) => new THREE.Color(hex),
);
const STEEL = new THREE.Color("#8f959c");

export const FENCE_HEIGHT_M = 2.8;
const POST_SPACING_M = 4;
const POST_HALF_M = 0.05;
const RAIL_M = 0.08;

export interface BarrierGeometry {
  /** The wall with its board face, vertex-coloured. */
  wall: THREE.BufferGeometry;
  /** Fence posts and the top rail. */
  frame: THREE.BufferGeometry;
  /** The wire between the posts, UV-mapped in `FENCE_TILE_M` tiles. */
  wire: THREE.BufferGeometry;
}

interface Buffers {
  positions: number[];
  normals: number[];
  colors: number[];
  uvs: number[];
}

function buffers(): Buffers {
  return { positions: [], normals: [], colors: [], uvs: [] };
}

function vertex(
  b: Buffers,
  p: THREE.Vector3,
  n: THREE.Vector3,
  color?: THREE.Color,
  u?: number,
  v?: number,
) {
  b.positions.push(p.x, p.y, p.z);
  b.normals.push(n.x, n.y, n.z);
  if (color) b.colors.push(color.r, color.g, color.b);
  if (u !== undefined && v !== undefined) b.uvs.push(u, v);
}

/** Two triangles over a strip cell: a0–a1 along the bottom, b0–b1 along the top. */
function quad(
  b: Buffers,
  corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
  normals: [THREE.Vector3, THREE.Vector3],
  color?: THREE.Color,
  uv?: [number, number, number, number],
) {
  const [a0, a1, b0, b1] = corners;
  const [n0, n1] = normals;
  const [u0, u1, v0, v1] = uv ?? [];
  vertex(b, a0, n0, color, u0, v0);
  vertex(b, a1, n1, color, u1, v0);
  vertex(b, b0, n0, color, u0, v1);
  vertex(b, b0, n0, color, u0, v1);
  vertex(b, a1, n1, color, u1, v0);
  vertex(b, b1, n1, color, u1, v1);
}

function toGeometry(b: Buffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(b.normals, 3));
  if (b.colors.length) geometry.setAttribute("color", new THREE.Float32BufferAttribute(b.colors, 3));
  if (b.uvs.length) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(b.uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function boardColor(distance: number, sign: number): THREE.Color {
  const run = Math.floor(distance / BOARD_RUN_M);
  const hash = (Math.imul(run + (sign > 0 ? 7919 : 0), 2654435761) >>> 0) % BOARD_COLORS.length;
  return BOARD_COLORS[hash];
}

/** The inner face of the wall on one side, measured from the centreline. */
export function barrierOffsetAt(
  halfWidth: HalfWidth,
  room: ApronRoom | null,
  s: number,
  sign: number,
  reach?: ReachLimit | null,
): number {
  const paving = room ? apronRoomAt(room, s, sign) : 0;
  const offset = halfWidthAt(halfWidth, s) + Math.max(paving, BARRIER_MIN_CLEARANCE_M) + BARRIER_SETBACK_M;
  // Inside a hairpin, or facing another leg, the wall stops short, outer face included.
  return reach ? Math.min(offset, reachLimitAt(reach, s, sign) - BARRIER_THICKNESS_M) : offset;
}

export function buildBarrierGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  /** Height of the driving surface above the curve. */
  raise: number,
  samples: number,
  room: ApronRoom | null,
  /** Stretches the ribbon is not drawn on; see `buildExtrudedTrack`. */
  hiddenAt?: (s: number) => boolean,
  reach?: ReachLimit | null,
): BarrierGeometry | null {
  const n = samples;
  if (n < 8) return null;
  const totalLength = curve.getLength();
  if (!(totalLength > 0)) return null;

  const up = new THREE.Vector3(0, 1, 0);
  const points = curve.getSpacedPoints(n);
  const across: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const v = new THREE.Vector3().crossVectors(curve.getTangentAt((i % n) / n), up);
    if (v.lengthSq() < 1e-6) v.set(1, 0, 0);
    across.push(v.normalize());
  }

  const wall = buffers();
  const frame = buffers();
  const wire = buffers();

  const at = (p: THREE.Vector3, v: THREE.Vector3, offset: number, y: number) =>
    new THREE.Vector3(p.x + v.x * offset, y, p.z + v.z * offset);

  for (const sign of [1, -1]) {
    const offsets: number[] = [];
    for (let i = 0; i <= n; i++) offsets.push(barrierOffsetAt(halfWidth, room, i / n, sign, reach));

    for (let i = 0; i < n; i++) {
      if (hiddenAt?.((i + 0.5) / n)) continue;
      const j = i + 1;
      const pi = points[i];
      const pj = points[j];
      const vi = across[i].clone().multiplyScalar(sign);
      const vj = across[j].clone().multiplyScalar(sign);
      const oi = offsets[i];
      const oj = offsets[j];
      const footI = pi.y + raise - BARRIER_FOOT_M;
      const footJ = pj.y + raise - BARRIER_FOOT_M;
      const topI = pi.y + raise + BARRIER_HEIGHT_M;
      const topJ = pj.y + raise + BARRIER_HEIGHT_M;
      const inward: [THREE.Vector3, THREE.Vector3] = [vi.clone().negate(), vj.clone().negate()];
      const outward: [THREE.Vector3, THREE.Vector3] = [vi, vj];

      const board = boardColor(((i + 0.5) / n) * totalLength, sign);
      quad(wall, [at(pi, vi, oi, footI), at(pj, vj, oj, footJ), at(pi, vi, oi, topI), at(pj, vj, oj, topJ)], inward, board);
      quad(
        wall,
        [
          at(pi, vi, oi, topI),
          at(pj, vj, oj, topJ),
          at(pi, vi, oi + BARRIER_THICKNESS_M, topI),
          at(pj, vj, oj + BARRIER_THICKNESS_M, topJ),
        ],
        [up, up],
        STEEL,
      );
      quad(
        wall,
        [
          at(pi, vi, oi + BARRIER_THICKNESS_M, footI),
          at(pj, vj, oj + BARRIER_THICKNESS_M, footJ),
          at(pi, vi, oi + BARRIER_THICKNESS_M, topI),
          at(pj, vj, oj + BARRIER_THICKNESS_M, topJ),
        ],
        outward,
        STEEL,
      );

      // The fence stands on the wall's centre line.
      const ci = oi + BARRIER_THICKNESS_M / 2;
      const cj = oj + BARRIER_THICKNESS_M / 2;
      const u0 = ((i / n) * totalLength) / FENCE_TILE_M;
      const u1 = ((j / n) * totalLength) / FENCE_TILE_M;
      quad(
        wire,
        [at(pi, vi, ci, topI), at(pj, vj, cj, topJ), at(pi, vi, ci, topI + FENCE_HEIGHT_M), at(pj, vj, cj, topJ + FENCE_HEIGHT_M)],
        inward,
        undefined,
        [u0, u1, 0, FENCE_HEIGHT_M / FENCE_TILE_M],
      );
      quad(
        frame,
        [
          at(pi, vi, ci, topI + FENCE_HEIGHT_M - RAIL_M),
          at(pj, vj, cj, topJ + FENCE_HEIGHT_M - RAIL_M),
          at(pi, vi, ci, topI + FENCE_HEIGHT_M),
          at(pj, vj, cj, topJ + FENCE_HEIGHT_M),
        ],
        inward,
      );
    }

    const tangent = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let d = 0; d < totalLength; d += POST_SPACING_M) {
      const s = d / totalLength;
      if (hiddenAt?.(s)) continue;
      const p = curve.getPointAt(s);
      tangent.copy(curve.getTangentAt(s)).setY(0).normalize();
      v.crossVectors(tangent, up).normalize().multiplyScalar(sign);
      const centre = barrierOffsetAt(halfWidth, room, s, sign, reach) + BARRIER_THICKNESS_M / 2;
      const base = p.y + raise + BARRIER_HEIGHT_M;
      const top = base + FENCE_HEIGHT_M;
      const middle = at(p, v, centre, 0);
      const corner = (along: number, out: number, y: number) =>
        new THREE.Vector3(
          middle.x + tangent.x * along + v.x * out,
          y,
          middle.z + tangent.z * along + v.z * out,
        );
      const h = POST_HALF_M;
      const faces: [number, number, number, number, THREE.Vector3][] = [
        [-h, -h, h, -h, v.clone().negate()],
        [h, -h, h, h, tangent.clone()],
        [h, h, -h, h, v.clone()],
        [-h, h, -h, -h, tangent.clone().negate()],
      ];
      for (const [a0, o0, a1, o1, normal] of faces) {
        quad(
          frame,
          [corner(a0, o0, base), corner(a1, o1, base), corner(a0, o0, top), corner(a1, o1, top)],
          [normal, normal],
        );
      }
    }
  }

  if (wall.positions.length === 0) return null;
  return { wall: toGeometry(wall), frame: toGeometry(frame), wire: toGeometry(wire) };
}
