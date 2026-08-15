"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftRight, Shuffle, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import BrandMark from "@/components/brand-mark";
import { useAppPref } from "@/components/app-pref-provider";
import type { DriverWithTeam } from "@/lib/race/f1-drivers";
import type { RaceStanding } from "@/lib/race/race-sim";
import type { TyreCompound } from "@/lib/race/race-session";

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
/** How long a row takes to slide to its new place, and on what curve. */
const SLIDE_MS = 460;

/** Row height, in design pixels. The tower is drawn at broadcast proportions
    and then scaled as a whole, so this never changes with the viewport. */
const ROW_H = 30;
const ROW_H_COMPACT = 22;
/** What the tower leaves free above and below itself. */
const EDGE_GAP = 56;
const EDGE_GAP_COMPACT = 24;
/** How far the whole graphic may be scaled to reach the edges of the screen. */
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.5;
/** Room the phone layout keeps for the control bar under the tower. */
const CONTROLS_RESERVE_COMPACT = 128;
const SLIDE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** The keyline that keeps a coloured number crisp, selected row included. */
const NUMBER_OUTLINE = [
  "0 1px 0 rgba(0,0,0,0.7)",
  "0 -1px 0 rgba(0,0,0,0.7)",
  "1px 0 0 rgba(0,0,0,0.7)",
  "-1px 0 0 rgba(0,0,0,0.7)",
  "0 1px 3px rgba(0,0,0,0.55)",
].join(", ");

/** The slanted highlights across the header: two broad streaks over the mark,
    a narrow one hard against each edge. */
const HEADER_SHEEN = [
  "linear-gradient(105deg,",
  "transparent 0%, rgba(255,255,255,0.045) 1.5%, transparent 4%,",
  "transparent 16%, rgba(255,255,255,0.075) 20%, transparent 25%,",
  "transparent 30%, rgba(255,255,255,0.06) 34%, transparent 39%,",
  "transparent 86%, rgba(255,255,255,0.05) 89%, transparent 92%)",
].join(" ");

/** Compound colours, as the tyre walls are marked. */
const TYRE_COLOUR: Record<TyreCompound, string> = {
  S: "#e10600",
  M: "#ffd12e",
  H: "#f2f2f2",
};

/** The Pirelli marking: a coloured sidewall ring, black tread, the letter inside. */
function TyreBadge({ compound, size }: { compound: TyreCompound; size: number }) {
  const colour = TYRE_COLOUR[compound];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={compound}
      style={{ display: "block" }}
    >
      <circle cx="12" cy="12" r="11" fill="#0b0d12" />
      <circle cx="12" cy="12" r="9.6" fill="none" stroke={colour} strokeWidth="2.8" />
      <circle cx="12" cy="12" r="8.2" fill="#0b0d12" />
      {/* The ring is cut top and bottom, as the marking splits it. */}
      <rect x="10.7" y="0" width="2.6" height="5.4" fill="#0b0d12" />
      <rect x="10.7" y="18.6" width="2.6" height="5.4" fill="#0b0d12" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontSize="11"
        fontWeight="800"
        fontFamily="inherit"
      >
        {compound}
      </text>
    </svg>
  );
}


/** Gaps the way a broadcast writes them: tenths under a minute, m:ss.t over it. */
function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return "+0.0";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `+${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
  }
  return `+${Math.max(0, seconds).toFixed(1)}`;
}

/** The running order, drawn as the television tower it is imitating. */
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
  // Which gap the column reports.
  const [gapMode, setGapMode] = useState<"leader" | "ahead">("ahead");
  const [moved, setMoved] = useState<Record<number, "up" | "down">>({});
  // Only read when the list actually scrolls, which it does on viewports too short for the field.
  const [scrollTop, setScrollTop] = useState(0);
  const lastPlaces = useRef<Map<number, number>>(new Map());
  const timers = useRef<Set<number>>(new Set());
  const list = useRef<HTMLOListElement>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const rowTops = useRef<Map<string, number>>(new Map());
  const rowOrder = useRef("");
  // The chrome above the list is measured, not guessed: its height decides how
  // much screen the field has left to divide between itself.
  const panel = useRef<HTMLDivElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const [chromeHeight, setChromeHeight] = useState(0);
  // How much screen is left under the tower's own top edge, which sits below
  // whatever bar the page puts above it.
  const [spaceBelow, setSpaceBelow] = useState(0);

  const rows = standings?.length
    ? standings.map((row) => ({ row, driver: order[row.index] }))
    : order.map((driver, index) => ({ row: null, driver, index }));

  // The row height is whatever divides the screen between the twenty cars,
  // so the tower reaches top to bottom as the broadcast one does. Below the
  // floor the list goes back to scrolling.
  const edgeGap = compact ? EDGE_GAP_COMPACT : EDGE_GAP;
  const rowHeight = compact ? ROW_H_COMPACT : ROW_H;
  // The broadcast tower reaches both edges of the screen, and everything in it
  // — type, plates, tyres — grows together to do that. So does this one: it is
  // drawn once at its design size and scaled as a whole.
  const roomForTower = Math.max(
    0,
    spaceBelow - edgeGap * 2 - (compact ? CONTROLS_RESERVE_COMPACT : 0),
  );
  const naturalHeight = chromeHeight + rows.length * rowHeight;
  const scale =
    roomForTower && naturalHeight
      ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, roomForTower / naturalHeight))
      : 1;
  // Only a screen too short even at the smallest scale sends the list back to scrolling.
  const listHeight = roomForTower
    ? Math.min(
        rows.length * rowHeight,
        Math.max(rowHeight * 3, roomForTower / scale - chromeHeight),
      )
    : undefined;
  const fastestRow =
    fastestLapIndex == null
      ? -1
      : rows.findIndex((entry) =>
          entry.row ? entry.row.index === fastestLapIndex : false,
        );

  useEffect(() => {
    // The box the tower is scaled to fit, marked by whoever places it. Its own
    // wrapper hugs it, so measuring that would feed the answer back in.
    const box =
      (panel.current?.closest("[data-tower-space]") as HTMLElement | null) ??
      panel.current?.parentElement;
    if (!box) return;
    const measure = () => setSpaceBelow(box.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = chrome.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setChromeHeight(element.offsetHeight));
    observer.observe(element);
    setChromeHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, []);

  // A position change is worth calling out; a silent reshuffle is easy to miss.
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
    // The expiry timer must outlive this effect run.
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

  // Rows slide to their new place instead of teleporting.
  useLayoutEffect(() => {
    // Reading a row's offset forces layout, and standings arrive five times a second.
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

  // When the list is shorter than the grid, the selected car has to be the row you can see.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[data-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div
      ref={panel}
      style={{
        fontFamily: "var(--font-timing), system-ui, sans-serif",
        transform: `scale(${scale})`,
        transformOrigin: compact ? "left top" : "left center",
      }}
      className={cn(
        // Broadcast graphics are dark in every theme.
        "pointer-events-auto rounded-sm bg-[#0f1219]/78 text-white shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-[2px]",
        "w-fit",
        className,
      )}
    >
      <div ref={chrome}>
      {/* The mark and the series, set to the left the way the graphic sets
          them — a logo centred over a column of numbers reads as a title, and
          this is a header. The header is the one solid part of the tower, lit
          by the same slanted streaks the broadcast graphic carries: two broad
          ones over the mark and a narrow one at each edge. */}
      <div
        className={cn(
          "relative flex items-center overflow-hidden border-b border-white/20 bg-[#181c24]",
          compact ? "gap-1.5 px-2 pb-2 pt-2.5" : "gap-2.5 px-4 pb-3 pt-4",
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: HEADER_SHEEN }}
        />
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
              <span className="whitespace-nowrap text-[8.5px] font-semibold tracking-[0.4px] text-[#9299a5]">
                {t.brandSanction}
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "relative flex items-baseline justify-center border-b border-white/10 bg-[#181c24]",
          compact ? "gap-1.5 px-2 py-1" : "gap-2 px-4 py-1",
        )}
      >
        <span
          className={cn(
            "font-semibold uppercase text-[#eef1f6]",
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
            "font-semibold tabular-nums text-[#9299a5]",
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
          "flex w-full items-center justify-center border-b border-white/10 bg-[#141821] font-bold uppercase text-[#9299a5] transition-colors hover:bg-[#1b1f27] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#e10600]",
          compact ? "gap-1 py-[3px] text-[7px] tracking-[0.6px]" : "gap-1.5 py-1 text-[9px] tracking-[1px]",
        )}
      >
        <ArrowLeftRight className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} />
        {gapMode === "leader" ? t.raceLeaderGap : t.raceInterval}
      </button>
      </div>

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
        className="f1tv-scroll overflow-y-auto"
        style={{ height: listHeight }}
      >
        {rows.map((entry, position) => {
          const driver = entry.driver;
          if (!driver) return null;
          const index = entry.row ? entry.row.index : position;
          const selected = index === selectedIndex;
          const direction = moved[index];
          const leader = position === 0;
          // A lapped car's gap in seconds is a lie by omission — the honest number is how many laps down it is.
          const gap = !started || !entry.row
            ? ""
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
                  // Fixed height, not padding: the arrow and the number are different glyphs at different sizes.
                  // The rows carry no rule and no banding: the field reads as
                  // one block, and the only breaks in it are the gaps between
                  // the position plates.
                  "relative flex w-full items-center text-left transition-colors duration-500",
                  "pr-[2px]",
                  compact ? "h-[22px]" : "h-[30px]",
                  selected ? "bg-white/15" : "hover:bg-white/[0.07]",
                )}
              >
                {/* The place fills its own cell rather than sitting in a plate:
                    the leader's cell is red, a car that has just gained or lost
                    a place is green or red with an arrow for as long as the
                    change is news, and everyone else is grey on the row. */}
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center font-black tabular-nums transition-colors duration-500",
                    compact ? "h-[calc(100%-2px)] w-[20px] text-[11px]" : "h-[calc(100%-2px)] w-[26px] text-[15px]",
                    direction === "up"
                      ? "bg-[#00c46a] text-white"
                      : direction === "down"
                        ? "bg-[#e10600] text-white"
                        : leader
                          ? "bg-[#e10600] text-white"
                          : "bg-[#0b0d12] text-[#d0d3d8]",
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
                  className={cn("h-full shrink-0", compact ? "w-[3px]" : "w-1")}
                  style={{ backgroundColor: driver.team.livery.body }}
                />
                {/* The car number, where the broadcast puts it: its own column
                    ahead of the driver, italic, and in the team's colour, so
                    the number says who this is before the code does. */}
                <span
                  className={cn(
                    "shrink-0 text-right font-black italic leading-none tabular-nums",
                    compact ? "w-[18px] pl-1 text-[10px]" : "w-[26px] pl-1.5 text-[14px]",
                  )}
                  style={{ color: driver.team.numberColour, textShadow: NUMBER_OUTLINE }}
                >
                  {driver.number}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-bold",
                    compact ? "w-[26px] pl-1 text-[11px] tracking-[0.3px]" : "w-9 pl-2 text-[14px] tracking-[0.5px]",
                  )}
                >
                  {driver.code}
                </span>
                {/* The gap sits in a column of its own right after the code,
                    as the broadcast sets it: pushed to the far edge it leaves
                    a hole across every row that no number ever fills. */}
                <span
                  className={cn(
                    "shrink-0 whitespace-nowrap text-right font-semibold leading-none tabular-nums text-white",
                    compact ? "w-[46px] text-[11px] tracking-[0.3px]" : "w-[64px] text-[15px] tracking-[0.5px]",
                    // The leader's word is longer than any number under it.
                    leader && (compact ? "text-[9px]" : "text-[13px]"),
                  )}
                >
                  {gap}
                </span>
                {/* The compound wears its Pirelli marking rather than a bare
                    letter: the ring carries the colour at a glance, the letter
                    inside keeps it readable where the colour cannot be told. */}
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center",
                    compact ? "ml-1 w-[14px]" : "ml-1.5 w-[18px]",
                  )}
                  title={tyre}
                >
                  {tyre ? <TyreBadge compound={tyre} size={compact ? 14 : 18} /> : null}
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
            // Flush with the panel, so it reads as bolted to the tower rather than floating beside it.
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
