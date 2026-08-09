"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import type { DriverWithTeam } from "@/lib/race/f1-drivers";
import type { RaceStanding } from "@/lib/race/race-sim";

export interface RaceResultsProps {
  order: DriverWithTeam[];
  standings: RaceStanding[];
  fastestLap: { index: number; time: number } | null;
  onClose: () => void;
  className?: string;
}

function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

function formatResultGap(row: RaceStanding): string {
  if (row.place === 1) return "";
  if (row.lapsDown > 0) return `+${row.lapsDown} L`;
  const gap = row.gapToLeader;
  if (!Number.isFinite(gap) || gap <= 0) return "";
  if (gap >= 60) {
    const minutes = Math.floor(gap / 60);
    return `+${minutes}:${(gap - minutes * 60).toFixed(3).padStart(6, "0")}`;
  }
  return `+${gap.toFixed(3)}`;
}

/**
 * The classification, shown once the flag has fallen.
 *
 * Same broadcast styling as the timing tower — this is the graphic the race
 * was building toward, not another app panel. Closing it only hides it; the
 * result stays in the tower until the next reset.
 */
export default function RaceResults({
  order,
  standings,
  fastestLap,
  onClose,
  className,
}: RaceResultsProps) {
  const { t } = useAppPref();
  const fastestDriver =
    fastestLap != null ? order[fastestLap.index] : undefined;

  return (
    <div
      className={cn(
        "pointer-events-auto w-[min(320px,calc(100vw-1.5rem))] overflow-hidden rounded-md bg-[#15151e]/95 text-white shadow-2xl shadow-black/60 backdrop-blur-md",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-white/10 bg-black/40 py-2 pl-0 pr-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-6 w-1 bg-[#e10600]" />
          <span className="text-[12px] font-extrabold uppercase italic tracking-[0.16em]">
            {t.raceResults}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.raceClose}
          className="flex h-6 w-6 items-center justify-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e10600]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <ol className="f1tv-scroll max-h-[min(65dvh,480px)] overflow-y-auto">
        {standings.map((row) => {
          const driver = order[row.index];
          if (!driver) return null;
          const holdsFastest = fastestLap?.index === row.index;
          return (
            <li
              key={driver.code}
              className="flex items-center gap-0 border-b border-white/5 odd:bg-white/[0.03]"
            >
              <span className="w-8 shrink-0 py-1.5 text-center text-xs font-extrabold italic tabular-nums">
                {row.place}
              </span>
              <span
                aria-hidden
                className="mr-2 h-4 w-[3px] shrink-0 rounded-sm"
                style={{ backgroundColor: driver.team.livery.body }}
              />
              <span className="shrink-0 text-xs font-extrabold tracking-wider">
                {driver.code}
              </span>
              <span className="ml-2 min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-white/40">
                {driver.lastName}
              </span>
              {holdsFastest && (
                <span
                  aria-hidden
                  title={t.raceFastestLap}
                  className="mr-1 h-2 w-2 shrink-0 rounded-full bg-[#b955ff]"
                />
              )}
              <span className="shrink-0 pr-2 text-[11px] tabular-nums text-white/70">
                {formatResultGap(row)}
              </span>
            </li>
          );
        })}
      </ol>

      {fastestLap && fastestDriver && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-black/30 px-2 py-1.5 text-[10px]">
          <span className="h-2 w-2 rounded-full bg-[#b955ff]" />
          <span className="uppercase tracking-wider text-[#b955ff]">
            {t.raceFastestLap}
          </span>
          <span className="font-bold">{fastestDriver.code}</span>
          <span className="ml-auto font-bold tabular-nums text-[#b955ff]">
            {formatLapTime(fastestLap.time)}
          </span>
        </div>
      )}
    </div>
  );
}
