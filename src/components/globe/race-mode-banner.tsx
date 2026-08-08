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

/**
 * The way into race mode from the globe.
 *
 * A strip rather than a second button on every circuit card: the mode is the
 * thing being advertised, not one more way to open a circuit. It picks a
 * circuit from the current calendar — the grid it puts on track is the 2025
 * one, and standing that on a layout last raced in 1909 is a joke the page
 * cannot explain.
 */
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
        // Fixed rather than absolute: on a phone the page box is taller than
        // the visible viewport while the browser chrome is up, and anything
        // pinned to the bottom of that box sits under the fold.
        "fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-1/2 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-red-500/25 bg-background/70 px-3 py-2 text-left shadow-2xl shadow-black/40 backdrop-blur-xl transition-colors hover:border-red-500/50 hover:bg-background/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60",
        stacked && "hidden md:flex",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-linear-to-br from-red-600 to-orange-600 shadow-[0_0_18px_rgba(225,6,0,0.45)]">
        <Flag className="h-4 w-4 text-white" />
      </span>
      <span className="leading-tight">
        <span className="flex items-center gap-2">
          <span className="whitespace-nowrap text-sm font-semibold">
            {t.raceModeTitle}
          </span>
          <span className="rounded bg-[#e10600]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#e10600]">
            {t.raceBeta}
          </span>
        </span>
        <span className="block text-[11px] text-foreground/55">
          {t.raceBannerCta}
        </span>
      </span>
    </button>
  );
}
