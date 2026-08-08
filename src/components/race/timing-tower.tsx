"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftRight, Shuffle, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import BrandMark from "@/components/brand-mark";
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
  /** Which car holds the fastest lap — its row carries the violet chip. */
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
 * How long a row takes to slide to its new place, and on what curve.
 *
 * Long enough to read as a car moving past another rather than as a cut, and
 * eased so that it leaves and arrives slowly — a linear slide of this length
 * reads as a scroll. Two rows crossing overlap for the whole slide, which is
 * the cost of making the swap legible at sixteen times speed.
 */
const SLIDE_MS = 460;

/** Row heights, in pixels. The marker layer positions itself off these. */
const ROW_H = 30;
const ROW_H_COMPACT = 22;
const SLIDE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

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
  // Which gap the column reports. Local to the tower: it is a way of reading
  // the same race, not a fact about it, so it does not belong in race state.
  const [gapMode, setGapMode] = useState<"leader" | "ahead">("ahead");
  const [moved, setMoved] = useState<Record<number, "up" | "down">>({});
  // Only read when the list actually scrolls, which it does on viewports too
  // short for the field.
  const [scrollTop, setScrollTop] = useState(0);
  const lastPlaces = useRef<Map<number, number>>(new Map());
  const timers = useRef<Set<number>>(new Set());
  const list = useRef<HTMLOListElement>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const rowTops = useRef<Map<string, number>>(new Map());
  const rowOrder = useRef("");

  const rows = standings?.length
    ? standings.map((row) => ({ row, driver: order[row.index] }))
    : order.map((driver, index) => ({ row: null, driver, index }));

  const rowHeight = compact ? ROW_H_COMPACT : ROW_H;
  const fastestRow =
    fastestLapIndex == null
      ? -1
      : rows.findIndex((entry) =>
          entry.row ? entry.row.index === fastestLapIndex : false,
        );

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
        element.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASING}`;
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
      style={{ fontFamily: "var(--font-timing), system-ui, sans-serif" }}
      className={cn(
        // Broadcast graphics are dark in every theme: the tower is styled after
        // the television overlay, not after the app. Chips hang off the right
        // edge, so the panel cannot clip its own children.
        "pointer-events-auto rounded-sm bg-[#14161a]/92 text-white shadow-[0_8px_24px_rgba(0,0,0,0.4)]",
        compact ? "w-[142px]" : "w-[210px]",
        className,
      )}
    >
      {/* The mark and the series, set to the left the way the graphic sets
          them — a logo centred over a column of numbers reads as a title, and
          this is a header. */}
      <div
        className={cn(
          "flex items-center border-b-2 border-[#2a2d33] bg-linear-to-b from-[#1c1f24] to-[#0f1114]",
          compact ? "gap-1.5 px-2 pb-2 pt-2.5" : "gap-2.5 px-4 pb-3 pt-4",
        )}
      >
        <BrandMark
          className={compact ? "h-[13px] w-auto shrink-0" : "h-[16px] w-auto shrink-0"}
          title={t.appName}
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "whitespace-nowrap font-black uppercase leading-tight",
              compact ? "text-[10px] tracking-[0.6px]" : "text-[14px] tracking-[1.2px]",
            )}
          >
            {t.brandLiveTiming}
          </div>
          <div className={cn("mt-px flex items-center", compact ? "gap-1" : "gap-1.5")}>
            <span
              className={cn(
                "font-black",
                compact ? "text-[8px] tracking-[0.4px]" : "text-[10px] tracking-[0.8px]",
              )}
            >
              RUI
            </span>
            {!compact && (
              <span className="whitespace-nowrap text-[8.5px] font-semibold tracking-[0.4px] text-[#9aa0a8]">
                {t.brandSanction}
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "relative flex items-baseline justify-center border-b border-[#2a2d33] bg-[#16181c]",
          compact ? "gap-1.5 px-2 py-1" : "gap-2 px-4 py-1",
        )}
      >
        <span
          className={cn(
            "font-semibold uppercase text-[#e8eaed]",
            compact ? "text-[13px] tracking-[0.6px]" : "text-[19px] tracking-[1px]",
          )}
        >
          {t.raceLap}
        </span>
        <span
          className={cn("font-black tabular-nums", compact ? "text-[16px]" : "text-[22px]")}
        >
          {lap ?? 1}
        </span>
        <span
          className={cn(
            "font-semibold tabular-nums text-[#9aa0a8]",
            compact ? "text-[11px]" : "text-[15px]",
          )}
        >
          / {totalLaps || "\u2014"}
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

      {/* Which gap the column is showing, said in the control that changes it.
          Neither answer is the right one on its own: the interval says who is
          catching whom, the leader gap says how the field has strung out, and
          the broadcast switches between them for exactly that reason. */}
      <button
        type="button"
        onClick={() => setGapMode(gapMode === "leader" ? "ahead" : "leader")}
        aria-pressed={gapMode === "ahead"}
        className={cn(
          "flex w-full items-center justify-center border-b border-[#2a2d33] bg-[#101216] font-bold uppercase text-[#9aa0a8] transition-colors hover:bg-[#1b1e23] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#e10600]",
          compact ? "gap-1 py-[3px] text-[7px] tracking-[0.6px]" : "gap-1.5 py-1 text-[9px] tracking-[1px]",
        )}
      >
        <ArrowLeftRight className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} />
        {gapMode === "leader" ? t.raceLeaderGap : t.raceInterval}
      </button>

      {/* The full grid, unscrolled: twenty rows is the content, not a slice of
          it, and a tower that cuts off at P19 makes the reader wonder who is
          missing. Scrolling is left as the fallback for viewports too short to
          hold the field at all. */}
      {/* The list scrolls, so nothing inside it may stick out sideways: a box
          that scrolls on one axis clips or scrolls on the other, which is
          where the stray horizontal bar under the tower came from. Markers
          that belong beside a row therefore live in their own layer next to
          the list, positioned off the row height. */}
      <div className="relative">
      <ol
        ref={list}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className={cn(
          "f1tv-scroll overflow-y-auto",
          // Leaves the control bar its own room at the bottom of the screen —
          // dvh rather than vh because a phone browser's chrome eats into the
          // viewport without changing what vh reports.
          compact ? "max-h-[calc(100dvh-17rem)]" : "max-h-[calc(100dvh-15rem)]",
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
          // figure the race has not produced yet. The leader's own cell names
          // the mode, because the leader has no gap to report in either.
          const gap = !started || !entry.row
            ? `${driver.number}`
            : leader
              ? gapMode === "leader"
                ? t.raceLeaderGap
                : t.raceInterval
              : entry.row.lapsDown > 0
                ? `+${entry.row.lapsDown} ${t.raceLapsDown}`
                : formatGap(
                    gapMode === "leader"
                      ? entry.row.gapToLeader
                      : entry.row.gapToAhead,
                  );
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
                  "relative flex w-full items-center border-b border-white/[0.04] text-left transition-colors duration-500",
                  compact ? "h-[22px] pr-1" : "h-[30px] pr-1.5",
                  selected
                    ? "bg-white/20"
                    : "odd:bg-[#1a1d22] even:bg-[#15171b] hover:bg-white/10",
                )}
              >
                {/* The place fills its own cell rather than sitting in a plate:
                    the leader's cell is red, a car that has just gained or lost
                    a place is green or red with an arrow for as long as the
                    change is news, and everyone else is grey on the row. */}
                <span
                  className={cn(
                    "flex h-full shrink-0 items-center justify-center font-black tabular-nums transition-colors duration-500",
                    compact ? "w-[22px] text-[11px]" : "w-[34px] text-[15px]",
                    direction === "up"
                      ? "bg-[#00b04f] text-white"
                      : direction === "down"
                        ? "bg-[#e10600] text-white"
                        : leader
                          ? "bg-[#e10600] text-white"
                          : "text-[#b6babd]",
                  )}
                >
                  {direction ? (
                    <span aria-hidden className={compact ? "text-[9px]" : "text-[12px]"}>
                      {direction === "up" ? "\u25b2" : "\u25bc"}
                    </span>
                  ) : (
                    position + 1
                  )}
                </span>
                <span
                  aria-hidden
                  className={cn("h-full shrink-0", compact ? "w-1" : "w-1.5")}
                  style={{ backgroundColor: driver.team.livery.body }}
                />
                {/* Where the constructor badge goes on television. That badge
                    is a trademark and the liveries here are approximations, so
                    the disc carries the team's colour and nothing else. */}
                <span
                  className={cn(
                    "flex shrink-0 justify-center",
                    compact ? "w-3.5" : "w-6",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("rounded-full opacity-85", compact ? "h-2 w-2" : "h-3.5 w-3.5")}
                    style={{ backgroundColor: driver.team.livery.body }}
                  />
                </span>
                <span
                  className={cn(
                    "shrink-0 font-bold",
                    compact ? "w-[26px] pl-px text-[11px] tracking-[0.3px]" : "w-9 pl-0.5 text-[14px] tracking-[0.5px]",
                  )}
                >
                  {driver.code}
                </span>
                <span className="flex-1" />
                <span
                  className={cn(
                    "whitespace-nowrap text-right font-semibold leading-none tabular-nums",
                    compact ? "text-[11px] tracking-[0.3px]" : "text-[15px] tracking-[0.5px]",
                    started ? "text-white" : "text-[#75787d]",
                  )}
                >
                  {gap}
                </span>
                {/* The compound is the letter in its own colour, which is how
                    the tower prints it — a drawn tyre at this size is a blob
                    with something illegible inside it. */}
                <span
                  className={cn(
                    "shrink-0 text-right font-black leading-none",
                    compact ? "ml-1 mt-px w-3 text-[10px]" : "ml-1.5 mt-0.5 w-[15px] text-[13px]",
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

      {fastestRow >= 0 && (
        <span
          title={t.raceFastestLap}
          style={{
            top: fastestRow * rowHeight + 3 - scrollTop,
            transition: `top ${SLIDE_MS}ms ${SLIDE_EASING}`,
          }}
          className={cn(
            "pointer-events-none absolute flex items-center justify-center rounded-[2px] bg-[#c400ff] text-white",
            // Flush with the panel, so it reads as bolted to the tower rather
            // than floating beside it.
            compact ? "-right-2.5 h-3.5 w-2.5" : "-right-[13px] h-5 w-[13px]",
          )}
        >
          <Timer className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} strokeWidth={3} />
        </span>
      )}
      </div>

    </div>
  );
}
