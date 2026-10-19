"use client";

import { useCallback } from "react";
import { Flag } from "lucide-react";
import { useAppPref } from "@/components/app-pref-provider";
import { buttons } from "@/components/site-header";
import { isCurrentCalendar } from "@/lib/circuit-meta";
import type { GlobeCircuit } from "./globe-marker";

/** The way into race mode from the globe: a header button that starts a race on a circuit of the season. */
export default function RaceModeButton({ circuits }: { circuits: GlobeCircuit[] }) {
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
    <button type="button" onClick={openRandom} title={t.raceBannerCta} className={buttons.primary}>
      <Flag className="h-3.5 w-3.5" /> <span className="max-sm:hidden">{t.raceModeTitle}</span>
    </button>
  );
}
