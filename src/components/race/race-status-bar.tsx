"use client";

import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import StartLightsStrip from "@/components/race/start-lights-strip";
import type { RacePhase } from "@/lib/race/race-session";

export interface RaceStatusBarProps {
  lit: number;
  phase: RacePhase;
  className?: string;
}

/** Lights and session state. */
export default function RaceStatusBar({
  lit,
  phase,
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
        // On a phone the strip competes with the tower for one narrow row.
        "pointer-events-none flex items-center gap-2 rounded-lg border border-border bg-background/80 px-2 py-1.5 shadow-xl backdrop-blur-md sm:gap-3 sm:px-3 sm:py-2",
        className,
      )}
    >
      <StartLightsStrip lit={lit} />

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
