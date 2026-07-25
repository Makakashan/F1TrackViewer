/**
 * Index of car models published under public/cars/.
 *
 * Written by scripts/generate-car-manifest.ts. The site is exported statically
 * for GitHub Pages, so a directory cannot be listed at runtime — the manifest
 * is how the admin model browser knows what exists and what it weighs before
 * downloading anything.
 */

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const CAR_LIBRARY_URL = `${PUBLIC_BASE_PATH}/cars/index.json`;

export interface CarModelEntry {
  id: string;
  file: string;
  name: string;
  bytes: number;
  /** Size after gzip — the real transfer cost, since hosts compress responses. */
  gzipBytes: number;
  modifiedAt: string;
}

export interface CarLibrary {
  version: number;
  generatedAt: string;
  models: CarModelEntry[];
}

export function carModelUrl(entry: CarModelEntry): string {
  return `${PUBLIC_BASE_PATH}/cars/${entry.file}`;
}

/**
 * Returns an empty library rather than throwing when no manifest is published.
 * A missing manifest is the normal state of a fresh checkout — `cars/` is
 * gitignored — and the browser should say "nothing here" rather than error.
 */
export async function fetchCarLibrary(): Promise<CarLibrary> {
  const empty: CarLibrary = {
    version: 1,
    generatedAt: "",
    models: [],
  };
  try {
    const response = await fetch(CAR_LIBRARY_URL);
    if (!response.ok) return empty;
    const data = (await response.json()) as CarLibrary;
    if (!Array.isArray(data?.models)) return empty;
    return data;
  } catch {
    return empty;
  }
}

/** "26989788" -> "25.7 MB". Binary units, which is what file managers show. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
