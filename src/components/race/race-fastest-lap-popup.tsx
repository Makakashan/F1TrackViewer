"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";

export interface RaceFastestLapPopupProps {
  /** The current fastest lap. A new one pops the card; null clears it. */
  fastestLap?: { code: string; time: number } | null;
  className?: string;
}

/** How long the card stays up after a time is set. */
const SHOW_MS = 5000;

/** m:ss.mmm, the way a lap time is written everywhere else in the sport. */
function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

/**
 * The fastest lap, announced under the lights and then gone.
 *
 * It is an event, not a status: the tower already carries who holds it, on the
 * row that holds it, and a panel repeating that all race long is one more thing
 * on screen that never changes. This appears when the time is set and leaves on
 * its own.
 */
export default function RaceFastestLapPopup({
  fastestLap,
  className,
}: RaceFastestLapPopupProps) {
  const { t } = useAppPref();
  // What the card has already had its turn showing. Storing the retired key
  // rather than the visible one keeps every state write inside the timeout —
  // setting state straight from an effect body turns one arrival from the
  // simulation into a second render pass, five times a second.
  const [retired, setRetired] = useState<string | null>(null);

  // Keyed on the time rather than the object: the simulation hands over a new
  // object on every tick, and re-popping the card on each of them would leave
  // it up permanently.
  const key = fastestLap ? `${fastestLap.code}:${fastestLap.time}` : null;
  useEffect(() => {
    if (key == null) return;
    const timer = window.setTimeout(() => setRetired(key), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  const shown = key != null && retired !== key ? fastestLap : null;

  if (!shown) return null;

  return (
    <div
      className={cn(
        "pointer-events-none flex items-center gap-2 rounded-lg border border-[#c400ff]/40 bg-[#1b0d26]/95 px-3 py-2 shadow-xl backdrop-blur-md",
        "duration-300 animate-in fade-in slide-in-from-top-2",
        className,
      )}
      role="status"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] bg-[#c400ff] text-white">
        <Timer className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className="leading-none">
        <span className="block text-[8px] font-bold uppercase tracking-[1px] text-[#c9a3ff]">
          {t.raceFastestLap}
        </span>
        <span className="mt-1 block whitespace-nowrap text-[13px] font-black tabular-nums text-[#e2c9ff]">
          {shown.code} {formatLapTime(shown.time)}
        </span>
      </span>
    </div>
  );
}
