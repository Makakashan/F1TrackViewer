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
  className?: string;
}

/** Lights, lap counter and session state — the top-centre strip of the HUD. */
export default function RaceStatusBar({
  lap,
  totalLaps,
  lit,
  phase,
  className,
}: RaceStatusBarProps) {
  const { t } = useAppPref();
  const status = phase === "racing" ? t.raceLightsOut : t.raceStandby;

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
