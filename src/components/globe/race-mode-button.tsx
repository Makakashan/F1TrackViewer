"use client";

import { useCallback } from "react";
import { Flag } from "lucide-react";
import { useAppPref } from "@/components/app-pref-provider";
import { cn } from "@/lib/utils";
import { isCurrentCalendar } from "@/lib/circuit-meta";
import type { GlobeCircuit } from "./globe-marker";

export interface RaceModeBannerProps {
  circuits: GlobeCircuit[];
  /** Something else already holds the bottom of a phone screen. */
  stacked?: boolean;
}

/** The way into race mode from the globe. */
export default function RaceModeBanner({
  circuits,
  stacked = false,
}: RaceModeBannerProps) {
  const { t } = useAppPref();

  const openRandom = useCallback(() => {
    const pool = circuits.filter((circuit) => isCurrentCalendar(circuit.id));
    const candidates = pool.length ? pool : circuits;
    if (!candidates.length) return;

    const circuit = candidates[Math.floor(Math.random() * candidates.length)];
    const params = new URLSearchParams();
    params.set("track", circuit.id);
    params.set("race", "1");
    params.set("width", "7");
    params.set("elevation", "1");
    params.set("sectors", "0");
    if (circuit.hasEnvironment) {
      params.set("environment", "1");
      params.set("terrain", "1");
    }
    window.location.href = `?${params.toString()}`;
  }, [circuits]);

  if (!circuits.length) return null;

  return (
    <button
      type="button"
      onClick={openRandom}
      className={cn(
        // Fixed, not absolute: on a phone the page box outgrows the visible viewport.
        "fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-1/2 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-[14px] border border-border bg-background/90 py-2 pl-2 pr-4 text-left backdrop-blur-md transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        stacked && "hidden md:flex",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-border">
        <Flag className="h-4 w-4 text-red-600" />
      </span>
      <span className="leading-tight">
        <span className="flex items-center gap-2">
          <span className="whitespace-nowrap text-sm font-semibold">
            {t.raceModeTitle}
          </span>
          <span className="rounded-md border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            {t.raceBeta}
          </span>
        </span>
        <span className="block text-xs text-muted-foreground">
          {t.raceBannerCta}
        </span>
      </span>
    </button>
  );
}
