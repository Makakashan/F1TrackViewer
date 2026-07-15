/**
 * Loose circuit metadata derived from the id (`{countryCode}-{openedYear}`)
 * for sorting/filtering the globe circuit list. Continent grouping follows
 * common F1-broadcast convention (e.g. Turkey/Azerbaijan/Bahrain bucketed
 * under "Asia") rather than strict geography.
 */

export type Continent = "europe" | "americas" | "asia";

const CONTINENT_BY_COUNTRY_CODE: Record<string, Continent> = {
  at: "europe",
  be: "europe",
  de: "europe",
  es: "europe",
  fr: "europe",
  gb: "europe",
  hu: "europe",
  it: "europe",
  mc: "europe",
  nl: "europe",
  pt: "europe",
  ru: "europe",
  br: "americas",
  ca: "americas",
  mx: "americas",
  us: "americas",
  ae: "asia",
  au: "asia",
  az: "asia",
  bh: "asia",
  cn: "asia",
  jp: "asia",
  qa: "asia",
  sa: "asia",
  sg: "asia",
  tr: "asia",
};

/**
 * Circuits currently on the F1 race calendar. This list needs a manual
 * refresh every season — there's no live calendar data source wired up.
 * Everything else in the index is treated as a "classic" / former layout.
 */
const CURRENT_CALENDAR_IDS = new Set([
  "ae-2009",
  "at-1969",
  "au-1953",
  "az-2016",
  "be-1925",
  "bh-2002",
  "br-1940",
  "ca-1978",
  "cn-2004",
  "es-1991",
  "gb-1948",
  "hu-1986",
  "it-1922",
  "it-1953",
  "jp-1962",
  "mc-1929",
  "mx-1962",
  "nl-1948",
  "qa-2004",
  "sa-2021",
  "sg-2008",
  "us-2012",
  "us-2022",
  "us-2023",
]);

export function getContinent(circuitId: string): Continent | null {
  const code = circuitId.split("-")[0]?.toLowerCase();
  return CONTINENT_BY_COUNTRY_CODE[code] ?? null;
}

/**
 * Average lat/lon of every circuit in a continent bucket — a simple "nice
 * enough" point to rotate the globe toward when a continent filter is
 * picked, without maintaining a hand-tuned camera target per continent.
 */
export function continentCentroid(
  circuits: { id: string; lat: number; lon: number }[],
  continent: Continent,
): { lat: number; lon: number } | null {
  const matches = circuits.filter((c) => getContinent(c.id) === continent);
  if (!matches.length) return null;
  const lat = matches.reduce((sum, c) => sum + c.lat, 0) / matches.length;
  const lon = matches.reduce((sum, c) => sum + c.lon, 0) / matches.length;
  return { lat, lon };
}

export function isCurrentCalendar(circuitId: string): boolean {
  return CURRENT_CALENDAR_IDS.has(circuitId);
}

/**
 * The year embedded in the id is the layout's opening year, e.g.
 * "gb-1948" → 1948. Used as a proxy for "season" sorting.
 */
export function getCircuitYear(circuitId: string): number | null {
  const year = Number(circuitId.split("-")[1]);
  return Number.isFinite(year) ? year : null;
}
