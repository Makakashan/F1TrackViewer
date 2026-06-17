import { distanceMeters } from "./geo-utils";

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function localMedian(values: number[], index: number, radius: number): number {
  const n = values.length;
  const window: number[] = [];
  for (let offset = -radius; offset <= radius; offset++) {
    window.push(values[(index + offset + n) % n]);
  }
  return median(window);
}

function segmentDistances(
  count: number,
  coords?: [number, number][],
): number[] {
  return Array.from({ length: count }, (_, i) => {
    const next = (i + 1) % count;
    if (!coords?.[i] || !coords[next]) return 20;
    const d = distanceMeters(coords[i], coords[next]);
    return d > 0.01 ? d : 0.01;
  });
}

function smoothByTrackDistance(
  values: number[],
  segments: number[],
  radiusMeters: number,
  passes: number,
): number[] {
  const n = values.length;
  let cur = values.slice();

  for (let pass = 0; pass < passes; pass++) {
    const next = new Array<number>(n);

    for (let i = 0; i < n; i++) {
      let weightedSum = cur[i];
      let totalWeight = 1;

      let dist = 0;
      for (let step = 1; step < n; step++) {
        const segmentIndex = (i - step + n) % n;
        dist += segments[segmentIndex];
        if (dist > radiusMeters) break;
        const weight = 1 - dist / radiusMeters;
        weightedSum += cur[(i - step + n) % n] * weight;
        totalWeight += weight;
      }

      dist = 0;
      for (let step = 1; step < n; step++) {
        const segmentIndex = (i + step - 1) % n;
        dist += segments[segmentIndex];
        if (dist > radiusMeters) break;
        const weight = 1 - dist / radiusMeters;
        weightedSum += cur[(i + step) % n] * weight;
        totalWeight += weight;
      }

      next[i] = weightedSum / totalWeight;
    }

    cur = next;
  }

  return cur;
}

function limitTrackGrade(values: number[], segments: number[]): number[] {
  const n = values.length;
  let cur = values.slice();
  const maxGrade = 0.2;

  for (let pass = 0; pass < 4; pass++) {
    for (const direction of [1, -1]) {
      const indices =
        direction === 1
          ? Array.from({ length: n }, (_, i) => i)
          : Array.from({ length: n }, (_, i) => n - 1 - i);

      for (const i of indices) {
        const prev = (i - direction + n) % n;
        const segmentIndex = direction === 1 ? prev : i;
        const maxDelta = Math.max(0.5, segments[segmentIndex] * maxGrade);
        const delta = cur[i] - cur[prev];
        if (Math.abs(delta) > maxDelta) {
          cur[i] = cur[prev] + Math.sign(delta) * maxDelta;
        }
      }
    }
  }

  return cur;
}

/** Smooth SRTM elevation data — removes spikes from grid-cell jumps on tight street circuits (Monaco etc). */
export function normalizeElevationProfile(
  elevations: number[],
  coords?: [number, number][],
): number[] {
  if (elevations.length < 3) return elevations.slice();

  const finite = elevations.filter(Number.isFinite);
  const fallback = median(finite);
  let cur = elevations.map((value) =>
    Number.isFinite(value) ? value : fallback,
  );
  const n = cur.length;
  const segments = segmentDistances(n, coords);

  const globalMedian = median(cur);
  const mad = median(cur.map((value) => Math.abs(value - globalMedian)));
  const statisticalLimit = Math.max(6, Math.min(14, 2.5 * mad));

  for (let pass = 0; pass < 3; pass++) {
    const next = cur.slice();
    for (let i = 0; i < n; i++) {
      const local = localMedian(cur, i, 4);
      const gradeLimit =
        Math.max(1.25, segments[(i - 1 + n) % n] * 0.18) +
        Math.max(1.25, segments[i] * 0.18);
      const limit = Math.min(statisticalLimit, gradeLimit);

      if (Math.abs(cur[i] - local) > limit) {
        next[i] = local;
      }
    }
    cur = next;
  }

  cur = smoothByTrackDistance(cur, segments, 45, 1);
  cur = limitTrackGrade(cur, segments);

  return cur;
}

function withoutClosingDuplicate(coords: [number, number][]): [number, number][] {
  if (coords.length < 2) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return coords.slice(0, -1);
  }
  return coords;
}

function cumulativeDistances(coords: [number, number][]): number[] {
  const distances = new Array<number>(coords.length).fill(0);
  for (let i = 1; i < coords.length; i++) {
    distances[i] = distances[i - 1] + distanceMeters(coords[i - 1], coords[i]);
  }
  return distances;
}

export function sampleElevationCoords(coords: [number, number][]): {
  coords: [number, number][];
  distances: number[];
  fullDistances: number[];
  hasClosingDuplicate: boolean;
} {
  const hasClosingDuplicate =
    coords.length > 1 &&
    coords[0][0] === coords[coords.length - 1][0] &&
    coords[0][1] === coords[coords.length - 1][1];
  const uniqueCoords = withoutClosingDuplicate(coords);
  const fullDistances = cumulativeDistances(uniqueCoords);
  const sampleCount = Math.min(uniqueCoords.length, 64);
  const indexes = Array.from({ length: sampleCount }, (_, i) => {
    if (sampleCount === 1) return 0;
    return Math.round((i / (sampleCount - 1)) * (uniqueCoords.length - 1));
  });
  const uniqueIndexes = [...new Set(indexes)].sort((a, b) => a - b);

  return {
    coords: uniqueIndexes.map((index) => uniqueCoords[index]),
    distances: uniqueIndexes.map((index) => fullDistances[index]),
    fullDistances,
    hasClosingDuplicate,
  };
}

export function interpolateElevations(
  sampleDistances: number[],
  sampleElevations: number[],
  fullDistances: number[],
  hasClosingDuplicate: boolean,
): number[] {
  if (!sampleElevations.length) return [];
  if (sampleElevations.length === 1) {
    const values = fullDistances.map(() => sampleElevations[0]);
    return hasClosingDuplicate ? [...values, values[0]] : values;
  }

  const values = fullDistances.map((distance) => {
    let hi = sampleDistances.findIndex((sampleDistance) => sampleDistance >= distance);
    if (hi <= 0) return sampleElevations[0];
    if (hi === -1) return sampleElevations[sampleElevations.length - 1];

    const lo = hi - 1;
    const span = sampleDistances[hi] - sampleDistances[lo];
    if (span <= 0) return sampleElevations[lo];

    const t = (distance - sampleDistances[lo]) / span;
    return sampleElevations[lo] + (sampleElevations[hi] - sampleElevations[lo]) * t;
  });

  return hasClosingDuplicate ? [...values, values[0]] : values;
}

/**
 * Compute simple stats over an elevation array — min, max, total climb
 * (sum of all uphill deltas between consecutive samples). Used by the info
 * panel.
 */
export function elevationStats(elevations: number[]): {
  min: number;
  max: number;
  range: number;
  climb: number;
  descent: number;
  mean: number;
} {
  if (!elevations.length) {
    return { min: 0, max: 0, range: 0, climb: 0, descent: 0, mean: 0 };
  }
  let min = Infinity,
    max = -Infinity,
    sum = 0;
  for (const e of elevations) {
    if (e < min) min = e;
    if (e > max) max = e;
    sum += e;
  }
  let climb = 0,
    descent = 0;
  for (let i = 0; i < elevations.length; i++) {
    const a = elevations[i];
    const b = elevations[(i + 1) % elevations.length];
    const d = b - a;
    if (d > 0) climb += d;
    else descent -= d;
  }
  return {
    min,
    max,
    range: max - min,
    climb,
    descent,
    mean: sum / elevations.length,
  };
}
