import { TEAMS_2025, teamById, type Team } from "./f1-teams";

/**
 * The twenty drivers of the 2025 Formula 1 season.
 *
 * Names, numbers and codes are facts about the season, and a timing tower
 * without them is a mockup rather than a UI. Nothing here is a trademark of a
 * team or of the championship; the liveries those drivers race in live in
 * f1-teams.ts, deliberately as approximations.
 *
 * Where a seat changed hands mid-season the driver who finished the year in it
 * is the one listed, so the grid is one consistent snapshot rather than a mix.
 */

export interface Driver {
  /** Car number. */
  number: number;
  /** Three-letter code, as used on timing screens. */
  code: string;
  firstName: string;
  lastName: string;
  teamId: string;
}

export const DRIVERS_2025: Driver[] = [
  { number: 1, code: "VER", firstName: "Max", lastName: "Verstappen", teamId: "red-bull" },
  { number: 22, code: "TSU", firstName: "Yuki", lastName: "Tsunoda", teamId: "red-bull" },
  { number: 4, code: "NOR", firstName: "Lando", lastName: "Norris", teamId: "mclaren" },
  { number: 81, code: "PIA", firstName: "Oscar", lastName: "Piastri", teamId: "mclaren" },
  { number: 16, code: "LEC", firstName: "Charles", lastName: "Leclerc", teamId: "ferrari" },
  { number: 44, code: "HAM", firstName: "Lewis", lastName: "Hamilton", teamId: "ferrari" },
  { number: 63, code: "RUS", firstName: "George", lastName: "Russell", teamId: "mercedes" },
  { number: 12, code: "ANT", firstName: "Andrea Kimi", lastName: "Antonelli", teamId: "mercedes" },
  { number: 14, code: "ALO", firstName: "Fernando", lastName: "Alonso", teamId: "aston-martin" },
  { number: 18, code: "STR", firstName: "Lance", lastName: "Stroll", teamId: "aston-martin" },
  { number: 10, code: "GAS", firstName: "Pierre", lastName: "Gasly", teamId: "alpine" },
  { number: 43, code: "COL", firstName: "Franco", lastName: "Colapinto", teamId: "alpine" },
  { number: 23, code: "ALB", firstName: "Alexander", lastName: "Albon", teamId: "williams" },
  { number: 55, code: "SAI", firstName: "Carlos", lastName: "Sainz", teamId: "williams" },
  { number: 6, code: "HAD", firstName: "Isack", lastName: "Hadjar", teamId: "racing-bulls" },
  { number: 30, code: "LAW", firstName: "Liam", lastName: "Lawson", teamId: "racing-bulls" },
  { number: 27, code: "HUL", firstName: "Nico", lastName: "Hülkenberg", teamId: "kick-sauber" },
  { number: 5, code: "BOR", firstName: "Gabriel", lastName: "Bortoleto", teamId: "kick-sauber" },
  { number: 31, code: "OCO", firstName: "Esteban", lastName: "Ocon", teamId: "haas" },
  { number: 87, code: "BEA", firstName: "Oliver", lastName: "Bearman", teamId: "haas" },
];

export interface DriverWithTeam extends Driver {
  team: Team;
}

/** Every driver with their team resolved; drops any whose team id is unknown. */
export function driversWithTeams(): DriverWithTeam[] {
  return DRIVERS_2025.flatMap((driver) => {
    const team = teamById(driver.teamId);
    return team ? [{ ...driver, team }] : [];
  });
}

/** Sanity guard for the two lists agreeing: two seats per constructor. */
export const EXPECTED_GRID_SIZE = TEAMS_2025.length * 2;
