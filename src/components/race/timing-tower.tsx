"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import type { DriverWithTeam } from "@/lib/f1-drivers";
import type { RaceStanding } from "@/lib/race-sim";
import type { TyreCompound } from "@/lib/race-session";

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
  /** Compound per car, indexed like `order`. */
  tyres?: TyreCompound[];
  /** Leader's lap and the distance, shown in the header band. */
  lap?: number;
  totalLaps?: number;
  /** False until the cars actually move, where a gap column would be lying. */
  started?: boolean;
  /** Phone-sized: half the width, tighter rows. */
  compact?: boolean;
  className?: string;
}

/** How long a row shows its arrow after its car changes position. */
const MOVE_FLASH_MS = 2200;
/**
 * How long a row takes to slide to its new place.
 *
 * Short on purpose: two rows crossing overlap for the length of the slide, and
 * a reshuffle at sixteen times speed produces several at once.
 */
const SLIDE_MS = 240;

/** Compound colours, as the tyre walls are marked. */
const TYRE_COLOUR: Record<TyreCompound, string> = {
  S: "#e10600",
  M: "#ffd12e",
  H: "#f2f2f2",
};

/**
 * Gaps the way a broadcast writes them: tenths under a minute, m:ss.t over it.
 *
 * Two cars alongside each other are "+0.0" and not a dash — nought point nought
 * is a fact about the race, a dash reads as missing data.
 */
function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return "+0.0";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `+${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
  }
  return `+${Math.max(0, seconds).toFixed(1)}`;
}

/**
 * The running order, drawn as the television tower it is imitating: a lap band
 * on top, then one row per car — position, the team's colour, the driver's
 * code, the gap and the compound.
 *
 * Two sizes, one component, and neither carries surnames: the code is the name
 * on a timing screen, and the column those surnames took is the scene's.
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
  tyres,
  lap,
  totalLaps,
  started = false,
  compact = false,
  className,
}: TimingTowerProps) {
  const { t } = useAppPref();
  const [moved, setMoved] = useState<Record<number, "up" | "down">>({});
  const lastPlaces = useRef<Map<number, number>>(new Map());
  const timers = useRef<Set<number>>(new Set());
  const list = useRef<HTMLOListElement>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const rowTops = useRef<Map<string, number>>(new Map());
  const rowOrder = useRef("");

  const rows = standings?.length
    ? standings.map((row) => ({ row, driver: order[row.index] }))
    : order.map((driver, index) => ({ row: null, driver, index }));

  // A position change is worth calling out: twenty rows reshuffling silently is
  // the one thing a timing tower must not do. The row says which way it went
  // rather than lighting up — a colour that means "something happened" is
  // worth less than an arrow that means "this car gained a place".
  //
  // The arrow is scheduled rather than set outright: standings arrive from the
  // simulation, and turning one arrival straight into a render inside an
  // effect is the cascading-render pattern React warns about.
  useEffect(() => {
    if (!standings?.length) {
      lastPlaces.current.clear();
      return;
    }
    const changed: Array<[number, "up" | "down"]> = [];
    for (const row of standings) {
      const previous = lastPlaces.current.get(row.index);
      if (previous != null && previous !== row.place) {
        changed.push([row.index, row.place < previous ? "up" : "down"]);
      }
      lastPlaces.current.set(row.index, row.place);
    }
    if (!changed.length) return;

    window.requestAnimationFrame(() => {
      setMoved((current) => {
        const next = { ...current };
        for (const [index, direction] of changed) next[index] = direction;
        return next;
      });
    });
    // The expiry timer must outlive this effect run. Standings arrive five
    // times a second, so a timer cancelled by the effect's own cleanup would
    // never fire — which is how every row ends up marked and none of the marks
    // ever clear. Only unmount cancels them, and only this batch expires:
    // clearing the whole map would cut short a swap from half a second ago.
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setMoved((current) => {
        const next = { ...current };
        for (const [index] of changed) delete next[index];
        return next;
      });
    }, MOVE_FLASH_MS);
    timers.current.add(timer);
  }, [standings]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // Rows slide to their new place instead of teleporting: measure where each
  // one was, let React reorder them, then animate the difference away. Without
  // it a swap is a single frame in which two codes trade cells, which reads as
  // a glitch rather than as an overtake.
  useLayoutEffect(() => {
    // Reading a row's offset forces layout, and standings arrive five times a
    // second — so the measuring only happens on the renders that can possibly
    // have moved anything.
    const key = rows.map((entry) => entry.driver?.code ?? "").join(",");
    if (key === rowOrder.current) return;
    rowOrder.current = key;

    const tops = new Map<string, number>();
    for (const [code, element] of rowRefs.current) {
      const top = element.offsetTop;
      tops.set(code, top);
      const previous = rowTops.current.get(code);
      if (previous == null || previous === top) continue;
      element.style.transition = "none";
      element.style.transform = `translateY(${previous - top}px)`;
      element.style.zIndex = "1";
      requestAnimationFrame(() => {
        element.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        element.style.transform = "";
      });
    }
    rowTops.current = tops;
  });

  // When the list is shorter than the grid, the selected car has to be the row
  // you can see. Keyed on the selection alone: following it as it changes
  // position would fight the user's own scrolling every few seconds.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[data-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div
      className={cn(
        // Broadcast graphics are dark in every theme: the tower is styled
        // after the television overlay, not after the app.
        "pointer-events-auto overflow-hidden rounded-md bg-[#0d0d14]/92 text-white shadow-2xl shadow-black/60 backdrop-blur-md",
        compact ? "w-[106px]" : "w-[168px]",
        className,
      )}
    >
      {/* The brand bar and the lap band, in the broadcast's own order. The
          logo that sits here on television is a trademark, so the bar carries
          the colour and nothing else; the counter is centred and is the
          largest thing in the graphic, because it is the headline. */}
      <div aria-hidden className="h-[3px] w-full bg-[#e10600]" />
      <div
        className={cn(
          "relative flex items-baseline justify-center gap-1.5 border-b border-white/10 bg-black/45",
          compact ? "py-1" : "py-1.5",
        )}
      >
        <span
          className={cn(
            "font-bold uppercase tracking-[0.2em] text-white/45",
            compact ? "text-[8px]" : "text-[10px]",
          )}
        >
          {t.raceLap}
        </span>
        <span
          className={cn(
            "font-extrabold tabular-nums",
            compact ? "text-[14px]" : "text-[18px]",
          )}
        >
          {lap ?? 1}
          <span
            className={cn(
              "font-bold text-white/40",
              compact ? "text-[9px]" : "text-[11px]",
            )}
          >
            /{totalLaps || "—"}
          </span>
        </span>
        <button
          type="button"
          onClick={onShuffle}
          title={t.raceShuffle}
          aria-label={t.raceShuffle}
          className={cn(
            "absolute flex shrink-0 items-center justify-center rounded text-white/30 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e10600]",
            compact ? "right-0.5 top-0.5 h-4 w-4" : "right-1 top-1 h-5 w-5",
          )}
        >
          <Shuffle className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
        </button>
      </div>

      {/* The full grid, unscrolled: twenty rows is the content, not a slice of
          it, and a tower that cuts off at P19 makes the reader wonder who is
          missing. Scrolling is left as the fallback for viewports too short to
          hold the field at all. */}
      <ol
        ref={list}
        className={cn(
          "f1tv-scroll overflow-y-auto",
          compact ? "max-h-[calc(100dvh-8.5rem)]" : "max-h-[calc(100vh-8rem)]",
        )}
      >
        {rows.map((entry, position) => {
          const driver = entry.driver;
          if (!driver) return null;
          const index = entry.row ? entry.row.index : position;
          const selected = index === selectedIndex;
          const direction = moved[index];
          const leader = position === 0;
          // A lapped car's gap in seconds is a lie by omission — the honest
          // number is how many laps down it is. Before the cars move there is
          // no gap at all, so the column carries the car number instead of a
          // figure the race has not produced yet.
          const gap = !started || !entry.row
            ? `${driver.number}`
            : leader
              ? t.raceLeaderGap
              : entry.row.lapsDown > 0
                ? `+${entry.row.lapsDown} ${t.raceLapsDown}`
                : formatGap(entry.row.gapToAhead);
          const holdsFastest = fastestLapIndex != null && fastestLapIndex === index;
          const tyre = tyres?.[index];

          return (
            <li
              key={driver.code}
              ref={(element) => {
                if (element) rowRefs.current.set(driver.code, element);
                else rowRefs.current.delete(driver.code);
              }}
              className="relative"
            >
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-current={selected}
                data-selected={selected}
                className={cn(
                  // Fixed height, not padding: the arrow and the number are
                  // different glyphs at different sizes, and a row that
                  // measures itself from its content changes height the moment
                  // a car moves — which makes the whole tower jump every time
                  // it has something to report.
                  "flex w-full items-center border-b border-white/[0.06] text-left transition-colors",
                  compact ? "h-[22px]" : "h-[27px]",
                  selected
                    ? "bg-white/15"
                    : "odd:bg-white/[0.03] hover:bg-white/10",
                )}
              >
                {/* The leader's box is filled, the way the broadcast marks the
                    car everything else is measured against. A car that has
                    just moved shows the arrow in that cell instead: the place
                    it now holds is already the row it is sitting in. */}
                <span
                  className={cn(
                    "flex h-full shrink-0 items-center justify-center font-extrabold tabular-nums",
                    compact ? "w-4 text-[10px]" : "w-[22px] text-[12px]",
                    direction === "up"
                      ? "bg-[#00b04f] text-white"
                      : direction === "down"
                        ? "bg-[#e10600] text-white"
                        : leader
                          ? "bg-[#e10600] text-white"
                          : "text-white/90",
                  )}
                >
                  {direction ? (
                    <span aria-hidden className="text-[8px] leading-none">
                      {direction === "up" ? "▲" : "▼"}
                    </span>
                  ) : (
                    position + 1
                  )}
                </span>
                <span
                  aria-hidden
                  className={cn("h-full shrink-0", compact ? "mx-1 w-[3px]" : "mx-1.5 w-[4px]")}
                  style={{ backgroundColor: driver.team.livery.body }}
                />
                <span
                  className={cn(
                    "shrink-0 font-extrabold tracking-tight",
                    compact ? "w-[26px] text-[11px]" : "w-[33px] text-[14px]",
                  )}
                >
                  {driver.code}
                </span>
                {holdsFastest && (
                  <span
                    aria-hidden
                    title={t.raceFastestLap}
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#b955ff]"
                  />
                )}
                {/* The gap takes the slack rather than a margin doing it: the
                    column has to end where the compound begins, with a space
                    between them, and the code has to sit against its colour
                    block whatever the tower is wide. */}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-right tabular-nums",
                    compact ? "text-[9px]" : "text-[11px]",
                    started ? "text-white/85" : "text-white/40",
                  )}
                >
                  {gap}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-center font-extrabold",
                    compact ? "ml-1 mr-1 w-2.5 text-[8px]" : "ml-2 mr-1.5 w-3 text-[10px]",
                  )}
                  style={tyre ? { color: TYRE_COLOUR[tyre] } : undefined}
                  title={tyre}
                >
                  {tyre ?? ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
