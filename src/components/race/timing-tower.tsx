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
  /** Leader's lap and the distance, shown in the header band. */
  lap?: number;
  totalLaps?: number;
  /** False on the grid, where a gap column would be inventing numbers. */
  started?: boolean;
  /** Phone-sized: half the width, no driver names, tighter rows. */
  compact?: boolean;
  className?: string;
}

/** How long a row stays highlighted after its car changes position. */
const MOVE_FLASH_MS = 1200;

/**
 * Gaps the way a broadcast writes them: tenths under a minute, m:ss.t over it.
 */
function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0.05) return "—";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `+${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
  }
  return `+${seconds.toFixed(1)}`;
}

/**
 * The running order, drawn as the television tower it is imitating: a lap band
 * on top, then one row per car — position, the team's colour, the driver's
 * code, and the gap.
 *
 * Two sizes, one component. The desktop tower can afford surnames and a gap
 * column wide enough for a minute-plus interval; the phone one keeps position,
 * code and gap and nothing else, because at that width every extra column is
 * taken from the scene behind it.
 *
 * What the tower cannot copy from the broadcast is the constructor badges —
 * those are trademarks, and the liveries in this app are deliberately
 * approximations. The colour block does that job instead.
 */
export default function TimingTower({
  order,
  standings,
  selectedIndex,
  onSelect,
  onShuffle,
  fastestLapIndex,
  lap,
  totalLaps,
  started = false,
  compact = false,
  className,
}: TimingTowerProps) {
  const { t } = useAppPref();
  const [moved, setMoved] = useState<Record<number, number>>({});
  const lastPlaces = useRef<Map<number, number>>(new Map());
  const list = useRef<HTMLOListElement>(null);

  // When the list is shorter than the grid, the selected car has to be the row
  // you can see. Keyed on the selection alone: following it as it changes
  // position would fight the user's own scrolling every few seconds.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[data-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

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
        // after the television overlay, not after the app.
        "pointer-events-auto overflow-hidden rounded-md bg-[#0d0d14]/92 text-white shadow-2xl shadow-black/60 backdrop-blur-md",
        compact ? "w-[116px]" : "w-[236px]",
        className,
      )}
    >
      {/* The lap band. It reads as the headline of the graphic rather than a
          panel title, which is why the counter is the largest text here. */}
      <div
        className={cn(
          "flex items-center gap-2 border-b border-white/10 bg-linear-to-r from-[#e10600]/25 to-transparent",
          compact ? "py-1 pl-1.5 pr-1" : "py-1.5 pl-2 pr-1.5",
        )}
      >
        <span
          aria-hidden
          className={cn("w-[3px] shrink-0 rounded-sm bg-[#e10600]", compact ? "h-4" : "h-5")}
        />
        <span
          className={cn(
            "font-extrabold uppercase italic tracking-[0.1em] text-white/50",
            compact ? "text-[8px]" : "text-[10px]",
          )}
        >
          {t.raceLap}
        </span>
        <span
          className={cn(
            "font-extrabold tabular-nums leading-none",
            compact ? "text-[13px]" : "text-[17px]",
          )}
        >
          {lap ?? 1}
          <span className={cn("font-bold text-white/45", compact ? "text-[9px]" : "text-[11px]")}>
            /{totalLaps || "—"}
          </span>
        </span>
        <button
          type="button"
          onClick={onShuffle}
          title={t.raceShuffle}
          aria-label={t.raceShuffle}
          className={cn(
            "ml-auto flex shrink-0 items-center justify-center rounded text-white/40 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e10600]",
            compact ? "h-4 w-4" : "h-5 w-5",
          )}
        >
          <Shuffle className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
        </button>
      </div>

      {/* Sized to hold a full grid without scrolling: twenty rows is the
          content, not an arbitrary slice of it, and a tower that cuts off at
          P19 makes the reader wonder who is missing. The cap only bites on
          short viewports, where scrolling is the honest answer. */}
      <ol
        ref={list}
        className={cn(
          "f1tv-scroll overflow-y-auto",
          // On a phone the full twenty rows would own half the screen, which
          // is the scene's half. It scrolls instead, and the selected car is
          // kept in view so the shorter window never hides the car being
          // watched.
          compact ? "max-h-[42dvh]" : "max-h-[calc(100vh-8rem)]",
        )}
      >
        {rows.map((entry, position) => {
          const driver = entry.driver;
          if (!driver) return null;
          const index = entry.row ? entry.row.index : position;
          const selected = index === selectedIndex;
          const flashing = moved[index] != null;
          const leader = position === 0;
          // A lapped car's gap in seconds is a lie by omission — the honest
          // number is how many laps down it is. On the grid there is no gap to
          // report at all, so the column carries the car number instead of a
          // figure the race has not produced yet.
          const gap = !started || !entry.row
            ? `${driver.number}`
            : leader
              ? t.raceLeaderGap
              : entry.row.lapsDown > 0
                ? `+${entry.row.lapsDown} ${t.raceLapsDown}`
                : formatGap(entry.row.gapToAhead);
          const holdsFastest = fastestLapIndex != null && fastestLapIndex === index;

          return (
            <li key={driver.code}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-current={selected}
                data-selected={selected}
                className={cn(
                  "flex w-full items-stretch border-b border-white/5 text-left transition-colors",
                  selected
                    ? "bg-white/15"
                    : flashing
                      ? "bg-[#00d084]/25"
                      : "bg-white/[0.02] hover:bg-white/10",
                )}
              >
                {/* The leader's box is filled, the way the broadcast marks the
                    car everything else is measured against. */}
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center font-extrabold tabular-nums",
                    compact ? "w-4 py-[3px] text-[10px]" : "w-6 py-1 text-[13px]",
                    leader ? "bg-[#e10600] text-white" : "text-white/90",
                  )}
                >
                  {position + 1}
                </span>
                <span
                  aria-hidden
                  className={cn("shrink-0", compact ? "ml-1 w-[3px]" : "ml-1.5 w-[4px]")}
                  style={{ backgroundColor: driver.team.livery.body }}
                />
                <span
                  className={cn(
                    "flex shrink-0 items-center font-extrabold tracking-wider",
                    compact ? "pl-1 text-[11px]" : "pl-2 text-[14px]",
                  )}
                >
                  {driver.code}
                </span>
                {!compact && (
                  <span className="ml-2 hidden min-w-0 flex-1 items-center truncate text-[10px] uppercase tracking-wide text-white/35 xl:flex">
                    {driver.lastName}
                  </span>
                )}
                {holdsFastest && (
                  <span
                    aria-hidden
                    title={t.raceFastestLap}
                    className="my-auto mr-1 h-2 w-2 shrink-0 rounded-full bg-[#b955ff]"
                  />
                )}
                <span
                  className={cn(
                    "ml-auto flex shrink-0 items-center justify-end tabular-nums text-white/85",
                    compact ? "pr-1.5 text-[9px]" : "pr-2 text-[12px]",
                    !started && "text-white/40",
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
