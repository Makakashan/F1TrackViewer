import * as THREE from "three";
import { gantryFrame } from "@/lib/track/start-finish";
import type { HalfWidth } from "@/lib/track/track-geometry";

/**
 * The FIA start lights, hung under the start/finish gantry.
 *
 * Five columns of two lamps, which is the real signal: the columns light left
 * to right one per second, then all ten go out together and the race is on.
 * The geometry is built here; what colour each lamp shows at a given moment is
 * the caller's business, so every lamp is its own geometry rather than one
 * merged mesh.
 */

const COLUMNS = 5;
const ROWS = 2;
/** Lamps per column pitch, and the panel's inner padding, in meters. */
const COLUMN_PITCH_M = 0.8;
const ROW_PITCH_M = 0.72;
const LAMP_RADIUS_M = 0.26;
const LAMP_SEGMENTS = 14;
const PANEL_PADDING_M = 0.3;
const PANEL_DEPTH_M = 0.25;

export interface StartLights {
  /** Dark backing panel the lamps are set into. */
  panel: THREE.BufferGeometry;
  /**
   * One disc per lamp, ordered column-major: index = column * ROWS + row, so
   * `lamps.slice(0, lit * ROWS)` is exactly the set that is on after `lit`
   * columns have come up.
   */
  lamps: THREE.BufferGeometry[];
  columns: number;
  rows: number;
}

export const START_LIGHT_COLUMNS = COLUMNS;
export const START_LIGHT_ROWS = ROWS;

/**
 * `directionSign` follows the TrackMarkers convention (+1 when lap distance
 * increases with s). The lamps face the oncoming cars, which is against the
 * direction of travel.
 */
export function buildStartLightsGeometry(
  curve: THREE.CatmullRomCurve3,
  s: number,
  halfWidth: HalfWidth,
  topRaise: number,
  directionSign: 1 | -1 = 1,
): StartLights {
  const frame = gantryFrame(curve, s, halfWidth, topRaise, "plain");
  const { center, tangent, across, up } = frame;

  const panelWidth = COLUMN_PITCH_M * COLUMNS + PANEL_PADDING_M;
  const panelHeight = ROW_PITCH_M * ROWS + PANEL_PADDING_M;
  // Hang the panel just under the beam, on the side the cars approach from so
  // it is never read through the beam itself.
  const facing = tangent.clone().multiplyScalar(-directionSign);
  const panelCenter = center
    .clone()
    .setY(frame.beamCenterY - frame.beamHeight / 2 - panelHeight / 2)
    .addScaledVector(facing, frame.beamDepth / 2 + PANEL_DEPTH_M / 2);

  const panel = boxGeometry(
    panelCenter,
    across,
    up,
    facing,
    panelWidth,
    panelHeight,
    PANEL_DEPTH_M,
  );

  const lamps: THREE.BufferGeometry[] = [];
  for (let column = 0; column < COLUMNS; column++) {
    const acrossOffset = (column - (COLUMNS - 1) / 2) * COLUMN_PITCH_M;
    for (let row = 0; row < ROWS; row++) {
      const upOffset = ((ROWS - 1) / 2 - row) * ROW_PITCH_M;
      const lampCenter = panelCenter
        .clone()
        .addScaledVector(across, acrossOffset)
        .addScaledVector(up, upOffset)
        // Proud of the panel face, so the lens never z-fights its housing.
        .addScaledVector(facing, PANEL_DEPTH_M / 2 + 0.02);
      lamps.push(discGeometry(lampCenter, across, up, LAMP_RADIUS_M));
    }
  }

  return { panel, lamps, columns: COLUMNS, rows: ROWS };
}

function discGeometry(
  center: THREE.Vector3,
  across: THREE.Vector3,
  up: THREE.Vector3,
  radius: number,
): THREE.BufferGeometry {
  const positions: number[] = [center.x, center.y, center.z];
  const indices: number[] = [];
  const point = new THREE.Vector3();

  for (let i = 0; i <= LAMP_SEGMENTS; i++) {
    const angle = (i / LAMP_SEGMENTS) * Math.PI * 2;
    point
      .copy(center)
      .addScaledVector(across, Math.cos(angle) * radius)
      .addScaledVector(up, Math.sin(angle) * radius);
    positions.push(point.x, point.y, point.z);
    if (i > 0) indices.push(0, i, i + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function boxGeometry(
  center: THREE.Vector3,
  across: THREE.Vector3,
  up: THREE.Vector3,
  facing: THREE.Vector3,
  width: number,
  height: number,
  depth: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const halfDepth = depth / 2;

  for (const [w, h, d] of [
    [-halfWidth, -halfHeight, -halfDepth],
    [halfWidth, -halfHeight, -halfDepth],
    [halfWidth, halfHeight, -halfDepth],
    [-halfWidth, halfHeight, -halfDepth],
    [-halfWidth, -halfHeight, halfDepth],
    [halfWidth, -halfHeight, halfDepth],
    [halfWidth, halfHeight, halfDepth],
    [-halfWidth, halfHeight, halfDepth],
  ]) {
    const corner = center
      .clone()
      .addScaledVector(across, w)
      .addScaledVector(up, h)
      .addScaledVector(facing, d);
    positions.push(corner.x, corner.y, corner.z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0,
    3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}
