"use client";

import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import StartLightsStrip from "@/components/race/start-lights-strip";
import type { RacePhase } from "@/lib/race-session";

export interface RaceStatusBarProps {
  lap: number;
  totalLaps: number;
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

/** Lights, lap counter and session state — the top-centre strip of the HUD. */
export default function RaceStatusBar({
  lap,
  totalLaps,
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
        "pointer-events-none flex items-center gap-3 rounded-lg border border-border bg-background/80 px-3 py-2 shadow-xl backdrop-blur-md",
        className,
      )}
    >
      <StartLightsStrip lit={lit} />

      <div className="leading-none">
        <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          {t.raceLap}
        </div>
        <div className="mt-1 text-sm font-bold tabular-nums">
          {lap}
          <span className="text-muted-foreground">/{totalLaps || "—"}</span>
        </div>
      </div>

      {fastestLap && (
        <div className="leading-none">
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
          "rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
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
