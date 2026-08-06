"use client";

import { useEffect, useRef, useState } from "react";
import { Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import type { DriverWithTeam } from "@/lib/f1-drivers";
import type { RaceStanding } from "@/lib/race-sim";

export interface TimingTowerProps {
  /** The grid, in starting order. Row content comes from here. */
  order: DriverWithTeam[];
  /** Live running order. Absent before the race starts. */
  standings?: RaceStanding[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onShuffle: () => void;
  /** Which car holds the fastest lap — its row gets the purple mark. */
  fastestLapIndex?: number | null;
  /** The drawer supplies its own title bar, so it turns this one off. */
  showHeader?: boolean;
  /** Phone-sized: narrower, smaller type, no driver names. */
  compact?: boolean;
  className?: string;
}

/** How long a row stays highlighted after its car changes position. */
const MOVE_FLASH_MS = 1200;

function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0.05) return "—";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `+${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
  }
  return `+${seconds.toFixed(1)}`;
}

/**
 * The running order, read the way a broadcast shows it: position, a bar in the
 * team's colour, car number, driver code, interval.
 *
 * The leader's column is the only one that means something different — every
 * other row is measured against the car in front, because that is the gap that
 * decides whether anything is about to happen.
 */
export default function TimingTower({
  order,
  standings,
  selectedIndex,
  onSelect,
  onShuffle,
  fastestLapIndex,
  showHeader = true,
  compact = false,
  className,
}: TimingTowerProps) {
  const { t } = useAppPref();
  const [moved, setMoved] = useState<Record<number, number>>({});
  const lastPlaces = useRef<Map<number, number>>(new Map());

  // A position change is worth a second of attention: twenty rows reshuffling
  // silently is the one thing a timing tower must not do.
  //
  // The flash is scheduled rather than set outright: standings arrive from the
  // simulation, and turning one arrival straight into a render inside an
  // effect is the cascading-render pattern React warns about.
  useEffect(() => {
    if (!standings?.length) {
      lastPlaces.current.clear();
      return;
    }
    const changed: number[] = [];
    for (const row of standings) {
      const previous = lastPlaces.current.get(row.index);
      if (previous != null && previous !== row.place) changed.push(row.index);
      lastPlaces.current.set(row.index, row.place);
    }
    if (!changed.length) return;

    const frame = window.requestAnimationFrame(() => {
      setMoved((current) => {
        const next = { ...current };
        for (const index of changed) next[index] = Date.now();
        return next;
      });
    });
    const timer = window.setTimeout(() => {
      setMoved((current) => {
        const next: Record<number, number> = {};
        for (const [key, value] of Object.entries(current)) {
          if (Date.now() - value < MOVE_FLASH_MS) next[Number(key)] = value;
        }
        return next;
      });
    }, MOVE_FLASH_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [standings]);

  const rows = standings?.length
    ? standings.map((row) => ({ row, driver: order[row.index] }))
    : order.map((driver, index) => ({ row: null, driver, index }));

  return (
    <div
      className={cn(
        // Broadcast graphics are dark in every theme: the tower is styled
        // after the F1 TV overlay, not after the app.
        "pointer-events-auto overflow-hidden rounded-md bg-[#15151e]/92 text-white shadow-2xl shadow-black/50 backdrop-blur-md",
        compact ? "w-[132px]" : "w-[248px]",
        className,
      )}
    >
      {showHeader && (
        <div
          className={cn(
            "flex items-center justify-between border-b border-white/10 bg-black/40 pl-0 pr-2",
            compact ? "py-1" : "py-1.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn("w-1 shrink-0 bg-[#e10600]", compact ? "h-5" : "h-6")}
            />
            <span
              className={cn(
                "truncate font-extrabold uppercase italic",
                compact
                  ? "text-[9px] tracking-[0.1em]"
                  : "text-[11px] tracking-[0.16em]",
              )}
            >
              {t.raceGridOrder}
            </span>
          </div>
          <button
            type="button"
            onClick={onShuffle}
            title={t.raceShuffle}
            aria-label={t.raceShuffle}
            className="flex h-6 w-6 items-center justify-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e10600]"
          >
            <Shuffle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Sized to hold a full grid without scrolling: twenty rows is the
          content, not an arbitrary slice of it, and a tower that cuts off at
          P19 makes the reader wonder who is missing. The cap only bites on
          short viewports, where scrolling is the honest answer. */}
      <ol
        className={cn(
          "f1tv-scroll overflow-y-auto",
          compact ? "max-h-[calc(100dvh-13rem)]" : "max-h-[calc(100vh-7rem)]",
        )}
      >
        {rows.map((entry, position) => {
          const driver = entry.driver;
          if (!driver) return null;
          const index = entry.row ? entry.row.index : position;
          const selected = index === selectedIndex;
          const flashing = moved[index] != null;
          // A lapped car's gap in seconds is a lie by omission — the honest
          // number is how many laps down it is.
          const gap = entry.row
            ? position === 0
              ? t.raceInterval
              : entry.row.lapsDown > 0
                ? `+${entry.row.lapsDown} L`
                : formatGap(entry.row.gapToAhead)
            : "";
          const holdsFastest = fastestLapIndex != null && fastestLapIndex === index;

          return (
            <li key={driver.code}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-current={selected}
                className={cn(
                  "flex w-full items-center gap-0 border-b border-white/5 text-left transition-colors",
                  selected
                    ? "bg-white/15"
                    : flashing
                      ? "bg-[#00d084]/20"
                      : "odd:bg-white/[0.03] hover:bg-white/10",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 text-center font-extrabold italic tabular-nums",
                    compact ? "w-5 py-1 text-[10px]" : "w-7 py-1.5 text-xs",
                  )}
                >
                  {position + 1}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "h-4 w-[3px] shrink-0 rounded-sm",
                    compact ? "mr-1.5" : "mr-2",
                  )}
                  style={{ backgroundColor: driver.team.livery.body }}
                />
                <span
                  className={cn(
                    "shrink-0 font-extrabold tracking-wider",
                    compact ? "text-[10px]" : "text-xs",
                  )}
                >
                  {driver.code}
                </span>
                {!compact && (
                  <span className="ml-2 hidden min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-white/40 xl:block">
                    {driver.lastName}
                  </span>
                )}
                {holdsFastest && (
                  <span
                    aria-hidden
                    title={t.raceFastestLap}
                    className="mr-1 h-2 w-2 shrink-0 rounded-full bg-[#b955ff]"
                  />
                )}
                <span
                  className={cn(
                    "ml-auto shrink-0 tabular-nums",
                    compact ? "pr-1.5 text-[9px]" : "pr-2 text-[11px]",
                    position === 0 && entry.row
                      ? cn(
                          "uppercase tracking-wider text-white/35",
                          compact ? "text-[7px]" : "text-[9px]",
                        )
                      : "text-white/70",
                  )}
                >
                  {gap}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
