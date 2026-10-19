/** Tunnel portals, the cut they need in the hill, and the bore behind them. */

import type { HeightField } from "./heightfield";
import { addFlatQuad, addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { ScenePlane } from "./plane";
import type { Ground } from "./ground";
import type { TunnelMask } from "./tunnels";

/** Half the opening. Wider than the road, the way a real portal is. */
const PORTAL_HALF_WIDTH_M = 7;
/** Springing height of the arch, and the crown above it. */
const PORTAL_WALL_M = 3;
const PORTAL_ARCH_M = 3.5;
/** Least width of the headwall around the opening — what makes it read as a
 *  portal — and how far it may grow looking for the ground to meet. */
const PORTAL_SURROUND_M = 2.5;
/**
 * Half width of the void at a mouth and the face that closes it. The real hole runs
 * half a cell wider, so the face must be bigger.
 */
const PORTAL_VOID_HALF_M = PORTAL_HALF_WIDTH_M;
const PORTAL_FACE_HALF_M = PORTAL_HALF_WIDTH_M + 5;
/** Same margin fore and aft: the void starts inside the front face and ends
 *  before the back one. */
const PORTAL_VOID_PAD_M = 3;
/**
 * How far the cutting runs out in front of a mouth, at road level. Without it the
 * hill buries the arch's lower half.
 */
const PORTAL_APPROACH_M = 16;
/** How far the cutting's floor reaches past the void it fills — half a core cell,
 *  plus a little, since a cell is dropped on its centre. */
const PORTAL_CUT_MARGIN_M = 2.5;
/**
 * How far the sleeve stands out of the face. The ramp to the hill can start up to
 * a cell early, so the collar covers it.
 */
const PORTAL_OUT_M = 5;
/** Wall thickness of the sleeve — what the ring at the mouth shows of itself. */
const PORTAL_RING_M = 0.8;
/**
 * The sleeve reaches past the pit it stands in, so the mouth shows dark tube
 * instead of the pit's lit far wall.
 */
const PORTAL_IN_M = 14;
const PORTAL_ARCH_SEGMENTS = 8;
/** How finely the lid over the cutting follows the hill it replaces. */
const PORTAL_LID_STEPS = 4;

/**
 * A portal is a short arched sleeve at each mouth. A height field cannot hold a
 * cavity, so the opening is what sells the tunnel.
 */
/** Half an arch section: up the wall, then over the crown. Shared with the bore
 *  so the mouth and what is behind it are the same shape. */
export function portalSection(): { offset: number; height: number }[] {
  const profile: { offset: number; height: number }[] = [];
  profile.push({ offset: -PORTAL_HALF_WIDTH_M, height: 0 });
  profile.push({ offset: -PORTAL_HALF_WIDTH_M, height: PORTAL_WALL_M });
  for (let i = 0; i <= PORTAL_ARCH_SEGMENTS; i++) {
    const angle = Math.PI * (i / PORTAL_ARCH_SEGMENTS);
    profile.push({
      offset: -PORTAL_HALF_WIDTH_M * Math.cos(angle),
      height: PORTAL_WALL_M + PORTAL_ARCH_M * Math.sin(angle),
    });
  }
  profile.push({ offset: PORTAL_HALF_WIDTH_M, height: PORTAL_WALL_M });
  profile.push({ offset: PORTAL_HALF_WIDTH_M, height: 0 });
  return profile;
}

/**
 * Cells the terrain must not fill over the arch. The ground between the cut floor and
 * the hill is drawn as a ramp through the opening, so it has to go.
 */
const PORTAL_VOID_IN_M = 8;

/** A portal's own keep-out: a rectangle along the mouth's axis, open at the front. */
export interface PortalCut {
  x: number;
  z: number;
  ux: number;
  uz: number;
  halfM: number;
  frontM: number;
  backM: number;
}

/** Where the terrain stops, and how deep the cutting under it goes. */
export interface PortalHollow {
  at(x: number, z: number): boolean;
  /** Where the sleeve runs: ground walled across here would stand in the bore. */
  boreAt(x: number, z: number): boolean;
  /** Cuttings that buildings must stay out of. A block stands over Monaco's inland mouth. */
  cuts: PortalCut[];
  /** The cutting's floor — the road at the nearest mouth. */
  floorAt(x: number, z: number): number;
}

export function portalVoids(
  vaults: VaultedRuns,
  hill: HeightField,
  plane: ScenePlane,
): PortalHollow {
  const { coords, elevations } = hill.trackProfile;
  const boxes: { x: number; z: number; ux: number; uz: number; roadY: number }[] = [];
  for (const run of vaults.runs) {
    for (const end of [
      { index: run[0], into: 1 },
      { index: run[run.length - 1], into: -1 },
    ]) {
      const neighbour = end.index + end.into;
      if (neighbour < 0 || neighbour >= coords.length) continue;
      const x = plane.x(coords[end.index][0]);
      const z = plane.z(coords[end.index][1]);
      let ux = plane.x(coords[neighbour][0]) - x;
      let uz = plane.z(coords[neighbour][1]) - z;
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      boxes.push({ x, z, ux: ux / length, uz: uz / length, roadY: elevations[end.index] });
    }
  }
  const inside = (x: number, z: number) => {
    for (const box of boxes) {
      const dx = x - box.x;
      const dz = z - box.z;
      const along = dx * box.ux + dz * box.uz;
      if (along < -PORTAL_APPROACH_M || along > PORTAL_VOID_IN_M - PORTAL_VOID_PAD_M) {
        continue;
      }
      if (Math.abs(dx * -box.uz + dz * box.ux) <= PORTAL_VOID_HALF_M) return box;
    }
    return null;
  };

  // The sleeve's own footprint, which is narrower than the cutting and runs
  // further in. A pit rim that crosses it would be a wall built across the road,
  // and it is exactly what the eye meets looking into the mouth.
  const inBore = (x: number, z: number) => {
    for (const box of boxes) {
      const dx = x - box.x;
      const dz = z - box.z;
      const along = dx * box.ux + dz * box.uz;
      if (along < -PORTAL_APPROACH_M || along > PORTAL_IN_M) continue;
      if (Math.abs(dx * -box.uz + dz * box.ux) <= PORTAL_HALF_WIDTH_M) return true;
    }
    return false;
  };

  const cuts: PortalCut[] = boxes.map((box) => ({
    x: box.x,
    z: box.z,
    ux: box.ux,
    uz: box.uz,
    halfM: PORTAL_VOID_HALF_M + PORTAL_CUT_MARGIN_M,
    frontM: -PORTAL_APPROACH_M - PORTAL_CUT_MARGIN_M,
    backM: PORTAL_VOID_IN_M,
  }));

  return {
    at: (x, z) => inside(x, z) !== null,
    boreAt: inBore,
    cuts,
    floorAt: (x, z) => {
      const box = inside(x, z);
      if (box && !Number.isNaN(box.roadY)) return box.roadY;
      // Off the void the question is not asked; a nearest-mouth answer keeps a
      // caller that rounds to a cell centre from falling through to nothing.
      let best = Number.NaN;
      let bestDistance = Infinity;
      for (const candidate of boxes) {
        const distance = Math.hypot(x - candidate.x, z - candidate.z);
        if (distance < bestDistance && !Number.isNaN(candidate.roadY)) {
          bestDistance = distance;
          best = candidate.roadY;
        }
      }
      return best;
    },
  };
}

export function bakePortals(
  vaults: VaultedRuns,
  hill: HeightField,
  plane: ScenePlane,
): { sleeve: Mesh; surround: Mesh; road: Mesh } {
  const mesh = createMesh();
  const surround = createMesh();
  const road = createMesh();
  const profile = portalSection();

  const { coords, elevations } = hill.trackProfile;
  // Mouths sit where the vault does, not where the tag does — see vaultedRuns.
  for (const run of vaults.runs) {
    const ends: { index: number; into: number }[] = [
      { index: run[0], into: 1 },
      { index: run[run.length - 1], into: -1 },
    ];
    for (const end of ends) {
      const neighbour = end.index + end.into;
      if (neighbour < 0 || neighbour >= coords.length) continue;
      const x = plane.x(coords[end.index][0]);
      const z = plane.z(coords[end.index][1]);
      let ux = plane.x(coords[neighbour][0]) - x;
      let uz = plane.z(coords[neighbour][1]) - z;
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      ux /= length;
      uz /= length;
      const mouth = { x, z, ux, uz };
      const roadY = elevations[end.index];
      if (Number.isNaN(roadY)) continue;

      // Scale the arch to fit under the lowest cover the sleeve passes, measured inward
      // from the face only, or the crown pokes out of the slope.
      const crown = PORTAL_WALL_M + PORTAL_ARCH_M;
      let cover = Infinity;
      for (let along = 0; along <= PORTAL_IN_M; along += 2) {
        const probe = hill.heightAt(
          plane.lon(x + ux * along),
          plane.lat(z + uz * along),
        );
        if (Number.isNaN(probe)) continue;
        cover = Math.min(cover, probe - roadY);
      }
      const available = cover === Infinity ? Infinity : cover - PORTAL_SURROUND_M;
      const scale = Math.max(
        BORE_MIN_HEIGHT_M / crown,
        Math.min(1, available / crown),
      );
      // Right-hand normal of the direction: the arch spans across the road.
      const nx = -mouth.uz;
      const nz = mouth.ux;

      const at = (index: number, along: number) => {
        const point = profile[index];
        return {
          x: mouth.x + nx * point.offset + mouth.ux * along,
          y: roadY + point.height * scale,
          z: mouth.z + nz * point.offset + mouth.uz * along,
        };
      };

      const outside = -PORTAL_OUT_M;
      const inside = PORTAL_IN_M;
      for (let i = 0; i < profile.length - 1; i++) {
        const a = at(i, outside);
        const b = at(i + 1, outside);
        const c = at(i + 1, inside);
        const d = at(i, inside);
        // Wound so the faces look in at the road: the near side of the sleeve
        // is culled and the camera sees the dark far side through the opening.
        addFlatQuad(mesh, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }

      // Road under the sleeve. The bore's floor starts further in, so the mouth was black.
      {
        // As wide as the cutting, or the trench shows the sea. Wider than nominal because
        // cells drop by their centre.
        const left = -PORTAL_VOID_HALF_M - PORTAL_CUT_MARGIN_M;
        const right = PORTAL_VOID_HALF_M + PORTAL_CUT_MARGIN_M;
        const floor = (offset: number, along: number) => ({
          x: mouth.x + nx * offset + mouth.ux * along,
          y: roadY - BORE_FLOOR_DROP_M,
          z: mouth.z + nz * offset + mouth.uz * along,
        });
        const a = floor(left, -PORTAL_APPROACH_M - PORTAL_CUT_MARGIN_M);
        const b = floor(right, -PORTAL_APPROACH_M - PORTAL_CUT_MARGIN_M);
        const c = floor(right, inside);
        const d = floor(left, inside);
        addFlatQuad(road, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }

      // A second, outward skin joined by a flat ring at the front, so from outside the
      // portal reads as a tube with a hole instead of an invisible film.
      const ringAt = (index: number, along: number) => {
        const point = profile[index];
        const outward = point.offset === 0 ? 0 : Math.sign(point.offset);
        const spread = point.offset + outward * PORTAL_RING_M;
        return {
          x: mouth.x + nx * spread + mouth.ux * along,
          y: roadY + point.height * scale + PORTAL_RING_M,
          z: mouth.z + nz * spread + mouth.uz * along,
        };
      };
      // The outer skin runs the sleeve's whole length, so the eye does not land on the pit wall.
      const ringBack = inside;
      for (let i = 0; i < profile.length - 1; i++) {
        const a = ringAt(i, outside);
        const b = ringAt(i + 1, outside);
        const c = ringAt(i + 1, ringBack);
        const d = ringAt(i, ringBack);
        // The other way round from the sleeve: this skin faces the weather.
        addFlatQuad(surround, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
      for (let i = 0; i < profile.length - 1; i++) {
        const inner1 = at(i, outside);
        const inner2 = at(i + 1, outside);
        const outer1 = ringAt(i, outside);
        const outer2 = ringAt(i + 1, outside);
        addFlatQuad(
          surround,
          inner1.x, inner1.y, inner1.z,
          outer1.x, outer1.y, outer1.z,
          outer2.x, outer2.y, outer2.z,
          inner2.x, inner2.y, inner2.z,
        );
      }

      // The headwall closes the cutting and the void behind it: a face at each end with
      // the arch cut out, and a wall down each side.
      const archCentreHeight = PORTAL_WALL_M * scale;
      const groundOver = (offset: number, along: number) => {
        const fx = mouth.x + nx * offset + mouth.ux * along;
        const fz = mouth.z + nz * offset + mouth.uz * along;
        const over = hill.heightAt(plane.lon(fx), plane.lat(fz));
        return Number.isNaN(over) ? roadY : over;
      };
      const at3 = (offset: number, height: number, along: number) => ({
        x: mouth.x + nx * offset + mouth.ux * along,
        y: roadY + height,
        z: mouth.z + nz * offset + mouth.uz * along,
      });
      // Tall enough to reach the hill it is set into, and never below the arch.
      // Read across the face rather than at its centre: the hill falls away
      // sideways, and a face cut to the middle reading leaves its corners short.
      const topOf = (along: number) => {
        let top = crown * scale + PORTAL_SURROUND_M;
        for (const offset of [-PORTAL_FACE_HALF_M, 0, PORTAL_FACE_HALF_M]) {
          top = Math.max(top, groundOver(offset, along) - roadY);
        }
        return top;
      };
      /** Where a ray out of the arch's centre leaves the face's rectangle. */
      const outward = (index: number, top: number) => {
        const point = profile[index];
        const height = point.height * scale;
        const dx = point.offset;
        const dy = height - archCentreHeight;
        const length = Math.hypot(dx, dy) || 1;
        const ox = dx / length;
        const oy = dy / length;
        const toSide = ox > 0
          ? (PORTAL_FACE_HALF_M - point.offset) / ox
          : ox < 0
            ? (-PORTAL_FACE_HALF_M - point.offset) / ox
            : Infinity;
        const toCap = oy > 1e-6 ? (top - height) / oy : oy < -1e-6 ? -height / oy : Infinity;
        const reach = Math.max(0, Math.min(toSide, toCap));
        return { offset: point.offset + ox * reach, height: height + oy * reach };
      };
      const facePlane = (target: Mesh, along: number, flip: boolean) => {
        const top = topOf(along);
        for (let i = 0; i < profile.length - 1; i++) {
          const inner = [profile[i], profile[i + 1]];
          const a = at3(inner[0].offset, inner[0].height * scale, along);
          const b = at3(inner[1].offset, inner[1].height * scale, along);
          const oa = outward(i, top);
          const ob = outward(i + 1, top);
          const c = at3(ob.offset, ob.height, along);
          const d = at3(oa.offset, oa.height, along);
          if (flip) {
            addFlatQuad(target, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
          } else {
            addFlatQuad(target, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
          }
        }
      };
      const front = outside;
      const back = PORTAL_VOID_IN_M;
      // The sides run between the faces, so the void is closed all round.
      facePlane(surround, front, false);
      facePlane(surround, back, true);

      // A lid over the void that follows the hill, so from above the excavation is not a
      // black rectangle or a flat grey plate.
      {
        // The two end rows take the faces' own top, so lid and face meet along
        // one line: a face is flat-topped and the hill is not, and the gap that
        // left showed the void through the hilltop.
        const lidNode = (offset: number, along: number, end: number | null) => {
          if (end !== null) return at3(offset, end, along);
          const floor = crown * scale + PORTAL_SURROUND_M;
          return at3(offset, Math.max(floor, groundOver(offset, along) - roadY), along);
        };
        const endAt = (j: number) =>
          j === 0 ? topOf(front) : j === PORTAL_LID_STEPS ? topOf(back) : null;
        for (let i = 0; i < PORTAL_LID_STEPS; i++) {
          const o0 = -PORTAL_FACE_HALF_M + (2 * PORTAL_FACE_HALF_M * i) / PORTAL_LID_STEPS;
          const o1 = -PORTAL_FACE_HALF_M + (2 * PORTAL_FACE_HALF_M * (i + 1)) / PORTAL_LID_STEPS;
          for (let j = 0; j < PORTAL_LID_STEPS; j++) {
            const a0 = front + ((back - front) * j) / PORTAL_LID_STEPS;
            const a1 = front + ((back - front) * (j + 1)) / PORTAL_LID_STEPS;
            const p00 = lidNode(o0, a0, endAt(j));
            const p10 = lidNode(o1, a0, endAt(j));
            const p11 = lidNode(o1, a1, endAt(j + 1));
            const p01 = lidNode(o0, a1, endAt(j + 1));
            addFlatQuad(surround, p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
          }
        }
      }

      // Cap the sleeve's far end, or the eye runs through the culled hill to the sky.
      {
        const capAt = (index: number) => at(index, inside);
        const centre = {
          x: mouth.x + mouth.ux * inside,
          y: roadY + (PORTAL_WALL_M * 0.5) * scale,
          z: mouth.z + mouth.uz * inside,
        };
        for (let i = 0; i < profile.length - 1; i++) {
          const a = capAt(i);
          const b = capAt(i + 1);
          addFlatTriangle(mesh, centre.x, centre.y, centre.z, b.x, b.y, b.z, a.x, a.y, a.z);
        }
      }
    }
  }

  return { sleeve: mesh, surround, road };
}

/**
 * The buried stretch with real hill over it. Under buildings the DTM reads the ground,
 * not the roof, so the vault follows cover instead of the OSM tag.
 */
function coveredRuns(
  field: HeightField,
  tunnels: TunnelMask,
  clearanceM: number,
): number[][] {
  const { coords, elevations } = field.trackProfile;
  const runs: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < coords.length; i++) {
    const ground = tunnels.buried(coords[i][0], coords[i][1])
      ? field.heightAt(coords[i][0], coords[i][1])
      : Number.NaN;
    if (!Number.isNaN(ground) && ground - elevations[i] >= clearanceM) {
      current.push(i);
      continue;
    }
    if (current.length > 1) runs.push(current);
    current = [];
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

/** Cover a full-height portal needs: the crown, plus the headwall around it. */
const PORTAL_NEED_M = PORTAL_WALL_M + PORTAL_ARCH_M + PORTAL_SURROUND_M;
/** How far a mouth may be pushed into the hill looking for that cover. Past
 *  this the hill is not going to arrive and the arch is scaled instead. */
const PORTAL_SEEK_M = 30;

export interface VaultedRuns {
  /** Profile-index runs a vault is built along, mouth to mouth. */
  runs: number[][];
  /** True at a centreline sample a vault covers — the burn-in's hold-back. */
  covers(lon: number, lat: number): boolean;
  stats: { taggedSamples: number; vaultedSamples: number; cutM: number };
}

/**
 * Where the vault goes and the ground is left alone. Mouths move inward to where the
 * hill fits a full portal, without splitting the run in two.
 */
export function vaultedRuns(
  field: HeightField,
  plane: ScenePlane,
  tunnels: TunnelMask,
): VaultedRuns {
  const { coords, elevations } = field.trackProfile;
  const coverAt = (i: number) => {
    const ground = field.heightAt(coords[i][0], coords[i][1]);
    return Number.isNaN(ground) ? Number.NaN : ground - elevations[i];
  };
  const stepM = (a: number, b: number) =>
    Math.hypot(
      plane.x(coords[a][0]) - plane.x(coords[b][0]),
      plane.z(coords[a][1]) - plane.z(coords[b][1]),
    );

  let cutM = 0;
  const runs: number[][] = [];
  for (const run of coveredRuns(field, tunnels, BORE_MIN_HEIGHT_M + BORE_COVER_M)) {
    let from = 0;
    let to = run.length - 1;
    let sought = 0;
    while (from < to && coverAt(run[from]) < PORTAL_NEED_M && sought < PORTAL_SEEK_M) {
      sought += stepM(run[from], run[from + 1]);
      from++;
    }
    cutM += sought;
    sought = 0;
    while (to > from && coverAt(run[to]) < PORTAL_NEED_M && sought < PORTAL_SEEK_M) {
      sought += stepM(run[to], run[to - 1]);
      to--;
    }
    cutM += sought;
    if (to - from > 1) runs.push(run.slice(from, to + 1));
  }

  // Keyed on the sample itself. Both passes densify the same centreline with
  // the same step, so the profile is the same array of points either time.
  const covered = new Set<string>();
  for (const run of runs) for (const i of run) covered.add(`${coords[i][0]},${coords[i][1]}`);

  let taggedSamples = 0;
  for (const [lon, lat] of coords) if (tunnels.buried(lon, lat)) taggedSamples++;

  return {
    runs,
    covers: (lon, lat) => covered.has(`${lon},${lat}`),
    stats: {
      taggedSamples,
      vaultedSamples: covered.size,
      cutM: Math.round(cutM),
    },
  };
}

/** Metres between rings of the bore. Coarser than the profile: it is seen down
 *  its own length, where a ring every few metres is indistinguishable. */
const BORE_STEP_M = 9;
/** The floor sits a hair below the ribbon so the two never fight for depth. */
const BORE_FLOOR_DROP_M = 0.08;
/** Ground kept over the crown wherever there is ground to keep. */
const BORE_COVER_M = 0.5;
/** However little there is, the bore stays tall enough to be a road tunnel. */
const BORE_MIN_HEIGHT_M = 3.2;

/**
 * The bore: floor, walls and vault along the buried lap, swept along its axis since
 * it is only ever seen through a mouth.
 */
export function bakeTunnelBody(
  field: HeightField,
  plane: ScenePlane,
  vaults: VaultedRuns,
  section: { offset: number; height: number }[],
): { lining: Mesh; road: Mesh } {
  const mesh = createMesh();
  const road = createMesh();
  const { coords, elevations } = field.trackProfile;

  for (const run of vaults.runs) {
    // Rings at BORE_STEP_M, plus the last sample, so the bore reaches its mouth.
    const rings: {
      x: number;
      y: number;
      z: number;
      ux: number;
      uz: number;
      scale: number;
    }[] = [];
    let sinceLast = Infinity;
    for (let k = 0; k < run.length; k++) {
      const i = run[k];
      const x = plane.x(coords[i][0]);
      const z = plane.z(coords[i][1]);
      if (rings.length) {
        const previous = rings[rings.length - 1];
        sinceLast = Math.hypot(x - previous.x, z - previous.z);
        if (sinceLast < BORE_STEP_M && k < run.length - 1) continue;
      }
      // Direction from the neighbouring samples, so the section stays square to
      // the road through a curve.
      const before = run[Math.max(0, k - 1)];
      const after = run[Math.min(run.length - 1, k + 1)];
      let ux = plane.x(coords[after][0]) - plane.x(coords[before][0]);
      let uz = plane.z(coords[after][1]) - plane.z(coords[before][1]);
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      ux /= length;
      uz /= length;
      // The section ducks under whatever cover there is; a lower crown costs nothing seen
      // along the axis.
      const ground = field.heightAt(coords[i][0], coords[i][1]);
      const available = Number.isNaN(ground)
        ? Infinity
        : ground - elevations[i] - BORE_COVER_M;
      const crown = PORTAL_WALL_M + PORTAL_ARCH_M;
      const scale = Math.max(
        BORE_MIN_HEIGHT_M / crown,
        Math.min(1, available / crown),
      );
      rings.push({ x, y: elevations[i], z, ux, uz, scale });
    }
    if (rings.length < 2) continue;

    const at = (ring: (typeof rings)[number], point: { offset: number; height: number }) => ({
      x: ring.x - ring.uz * point.offset,
      y: ring.y + point.height * ring.scale,
      z: ring.z + ring.ux * point.offset,
    });

    for (let r = 0; r < rings.length - 1; r++) {
      const near = rings[r];
      const far = rings[r + 1];
      for (let i = 0; i < section.length - 1; i++) {
        const a = at(near, section[i]);
        const b = at(near, section[i + 1]);
        const c = at(far, section[i + 1]);
        const d = at(far, section[i]);
        // Seen from inside, so the faces look in at the road.
        addFlatQuad(mesh, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }
      // Floor, dropped a little so it never fights the ribbon for depth.
      const left = section[0];
      const right = section[section.length - 1];
      const nearLeft = at(near, { offset: left.offset, height: -BORE_FLOOR_DROP_M });
      const nearRight = at(near, { offset: right.offset, height: -BORE_FLOOR_DROP_M });
      const farLeft = at(far, { offset: left.offset, height: -BORE_FLOOR_DROP_M });
      const farRight = at(far, { offset: right.offset, height: -BORE_FLOOR_DROP_M });
      addFlatQuad(
        road,
        nearLeft.x, nearLeft.y, nearLeft.z,
        nearRight.x, nearRight.y, nearRight.z,
        farRight.x, farRight.y, farRight.z,
        farLeft.x, farLeft.y, farLeft.z,
      );
    }
  }

  return { lining: mesh, road };
}

/** The road's own height at a point, which under a hill only the profile knows. */
function trackHeightNear(field: HeightField, plane: ScenePlane, x: number, z: number): number {
  const { coords, elevations } = field.trackProfile;
  let best = Number.NaN;
  let bestDistance = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const distance = (plane.x(coords[i][0]) - x) ** 2 + (plane.z(coords[i][1]) - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = elevations[i];
    }
  }
  return best;
}
