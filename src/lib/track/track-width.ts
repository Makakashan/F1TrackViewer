/** Real track-width profiles derived from the TUMFTM racetrack-database. */

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export interface TrackWidthProfile {
  version: number;
  source: string;
  license?: string;
  circuitId: string;
  tumftmTrack?: string;
  meanWidthMeters: number;
  minWidthMeters: number;
  maxWidthMeters: number;
  /** Full track width (m) at normalized arc positions i / samples.length. */
  samples: number[];
}

/** Circuits that ship a real-width profile under public/track-widths/. */
export const TRACK_WIDTH_CIRCUIT_IDS = new Set([
  "ae-2009",
  "at-1969",
  "au-1953",
  "be-1925",
  "bh-2002",
  "br-1940",
  "ca-1978",
  "cn-2004",
  "de-1927",
  "de-1932",
  "es-1991",
  "gb-1948",
  "hu-1986",
  "it-1922",
  "jp-1962",
  "mx-1962",
  "my-1999",
  "nl-1948",
  "ru-2014",
  "us-2012",
]);

export function hasTrackWidthProfile(circuitId: string): boolean {
  return TRACK_WIDTH_CIRCUIT_IDS.has(circuitId);
}

/** Fetch the real-width profile for a circuit. */
export async function fetchTrackWidthProfile(
  circuitId: string,
): Promise<TrackWidthProfile | null> {
  if (!TRACK_WIDTH_CIRCUIT_IDS.has(circuitId)) return null;
  try {
    const res = await fetch(
      `${PUBLIC_BASE_PATH}/track-widths/${encodeURIComponent(circuitId)}.json`,
      { cache: "no-cache" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as TrackWidthProfile;
    if (!Array.isArray(data.samples) || data.samples.length < 2) return null;
    return data;
  } catch {
    return null;
  }
}

/** Sample the full track width (meters) at a normalized arc position s ∈ [0, 1). */
export function sampleWidthAt(profile: TrackWidthProfile, s: number): number {
  const samples = profile.samples;
  const n = samples.length;
  const wrapped = ((s % 1) + 1) % 1;
  const pos = wrapped * n;
  const i0 = Math.floor(pos) % n;
  const i1 = (i0 + 1) % n;
  const f = pos - Math.floor(pos);
  return samples[i0] + (samples[i1] - samples[i0]) * f;
}
