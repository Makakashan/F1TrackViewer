"use client";

import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import StartLightsStrip from "@/components/race/start-lights-strip";
import type { RacePhase } from "@/lib/race-session";

export interface RaceStatusBarProps {
  lit: number;
  phase: RacePhase;
  /** Fastest lap so far: holder's code and the time. */
  fastestLap?: { code: string; time: number } | null;
  className?: string;
}

/** m:ss.mmm, the way a lap time is written everywhere else in the sport. */
function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

/**
 * Lights, session state and the fastest lap.
 *
 * The lap counter used to live here and now belongs to the tower's lap band,
 * where the broadcast puts it — two counters on one screen only invite the
 * reader to check whether they agree.
 */
export default function RaceStatusBar({
  lit,
  phase,
  fastestLap,
  className,
}: RaceStatusBarProps) {
  const { t } = useAppPref();
  const status =
    phase === "finished"
      ? t.raceFinished
      : phase === "racing"
        ? t.raceRunning
        : phase === "lights"
          ? t.raceLightsOut
          : t.raceStandby;

  return (
    <div
      className={cn(
        // On a phone the strip competes with the tower for one narrow row, so
        // it keeps only what changes during a race: the lights and the lap.
        // The phase is implied by both, and the fastest lap is already the
        // purple mark in the tower.
        "pointer-events-none flex items-center gap-2 rounded-lg border border-border bg-background/80 px-2 py-1.5 shadow-xl backdrop-blur-md sm:gap-3 sm:px-3 sm:py-2",
        className,
      )}
    >
      <StartLightsStrip lit={lit} />

      {fastestLap && (
        <div className="hidden leading-none sm:block">
          <div className="text-[9px] uppercase tracking-[0.18em] text-[#b955ff]">
            {t.raceFastestLap}
          </div>
          <div className="mt-1 text-sm font-bold tabular-nums text-[#b955ff]">
            {fastestLap.code} {formatLapTime(fastestLap.time)}
          </div>
        </div>
      )}

      <div
        className={cn(
          "hidden rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] sm:block",
          phase === "racing"
            ? "bg-[#00d084]/15 text-[#00d084]"
            : "bg-muted text-muted-foreground",
        )}
      >
        {status}
      </div>
    </div>
  );
}
