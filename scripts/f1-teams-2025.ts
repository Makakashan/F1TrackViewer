/**
 * Build-side view of the team palette.
 *
 * The table itself lives in src/lib/f1-teams.ts because the runtime needs it
 * too — one shared model is tinted per team rather than ten files being
 * downloaded. Keeping a second copy here would guarantee they drift.
 */

export {
  TEAMS_2025,
  type Livery,
  type Team,
} from "../src/lib/race/f1-teams";
