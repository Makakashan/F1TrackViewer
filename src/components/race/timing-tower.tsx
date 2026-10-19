"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeftRight, Shuffle, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/brand";
import { useAppPref } from "@/components/app-pref-provider";
import type { DriverWithTeam } from "@/lib/race/f1-drivers";
import type { RaceStanding } from "@/lib/race/race-sim";
import type { TyreCompound } from "@/lib/race/race-session";
import type { TowerPart } from "@/lib/race/hud-layout";

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
  /** The HUD editor is open: a click on a part hides or shows it instead of doing its job. */
  editing?: boolean;
  hiddenParts?: Partial<Record<TowerPart, boolean>>;
  onTogglePart?: (part: TowerPart) => void;
  /** Multiplies the fit to the screen. */
  userScale?: number;
  /** The point the tower scales about, which is the one its placement holds still. */
  origin?: string;
  className?: string;
}

/** How long a row shows its arrow after its car changes position. */
const MOVE_FLASH_MS = 3000;
/** How long a row takes to slide to its new place, and on what curve. */
const SLIDE_MS = 800;

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
const SLIDE_EASING = "cubic-bezier(0.45, 0, 0.2, 1)";
/** A hidden part while the editor is open: still there to be clicked back. */
const PART_GHOST = "opacity-25 outline-dashed outline-1 -outline-offset-1 outline-white/70";
const PART_HOVER = "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-white/60";

/** The keyline that keeps a coloured number crisp, selected row included. */
const NUMBER_OUTLINE = [
  "0 1px 0 rgba(0,0,0,0.7)",
  "0 -1px 0 rgba(0,0,0,0.7)",
  "1px 0 0 rgba(0,0,0,0.7)",
  "-1px 0 0 rgba(0,0,0,0.7)",
  "0 1px 3px rgba(0,0,0,0.55)",
].join(", ");

/** Compound letters in the colours the broadcast sets them in. */
const TYRE_COLOUR: Record<TyreCompound, string> = {
  S: "#ff3b3b",
  M: "#ffd12e",
  H: "#f2f2f2",
};

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
  editing = false,
  hiddenParts,
  onTogglePart,
  userScale = 1,
  origin,
  className,
}: TimingTowerProps) {
  const { t } = useAppPref();
  const shown = (part: TowerPart) => editing || !hiddenParts?.[part];
  const partClass = (part: TowerPart) =>
    editing ? (hiddenParts?.[part] ? cn(PART_GHOST, "cursor-pointer") : PART_HOVER) : undefined;
  const partClick = (part: TowerPart) =>
    editing
      ? (event: React.MouseEvent) => {
          event.stopPropagation();
          event.preventDefault();
          onTogglePart?.(part);
        }
      : undefined;
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
    (roomForTower && naturalHeight
      ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, roomForTower / naturalHeight))
      : 1) * userScale;
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
      data-hud-box
      style={{
        fontFamily: "var(--font-timing), system-ui, sans-serif",
        transform: `scale(${scale})`,
        transformOrigin: origin ?? (compact ? "left top" : "left center"),
      }}
      className={cn(
        // Broadcast graphics are dark in every theme.
        // One dark slab, square-cornered, as the broadcast draws it.
        "pointer-events-auto w-fit rounded-[2px] bg-[#13131a]/95 text-white shadow-[0_8px_24px_rgba(0,0,0,0.4)]",
        className,
      )}
    >
      <div ref={chrome}>
      <div className="border-b border-white/10 bg-gradient-to-b from-[#24242d] to-[#1a1a22]">
      {shown("brand") && (
      /* The mark centred over the series line, as the broadcast sets its own. */
      <div
        onClick={partClick("brand")}
        className={cn(
          "flex flex-col items-center border-b border-white/10",
          compact ? "gap-0.5 px-2 pb-1.5 pt-2" : "gap-1 px-4 pb-2.5 pt-3",
          partClass("brand"),
        )}
      >
        <span className={cn("dark flex items-center", compact ? "gap-1" : "gap-1.5")}>
          <BrandMark tile={false} className={compact ? "h-4 w-4" : "h-6 w-6"} />
          <span
            className={cn(
              "font-black uppercase italic leading-none",
              compact ? "text-[11px] tracking-[0.4px]" : "text-[17px] tracking-[0.6px]",
            )}
          >
            {t.appName}
          </span>
        </span>
        {!compact && (
          <span className="whitespace-nowrap text-[8px] font-semibold uppercase tracking-[0.6px] text-white/60">
            {t.brandSeries} · {t.brandSanction}
          </span>
        )}
      </div>
      )}

      {shown("lap") && (
      <div
        onClick={partClick("lap")}
        className={cn(
          "relative flex items-baseline justify-center",
          compact ? "gap-1.5 px-2 py-1" : "gap-2 px-4 py-1",
          partClass("lap"),
        )}
      >
        <span
          className={cn(
            "font-normal uppercase text-white/75",
            compact ? "text-[12px] tracking-[0.4px]" : "text-[17px] tracking-[0.6px]",
          )}
        >
          {t.raceLap}
        </span>
        <span
          className={cn("font-semibold tabular-nums", compact ? "text-[15px]" : "text-[20px]")}
        >
          {lap ?? 1}
        </span>
        <span
          className={cn(
            "font-semibold tabular-nums text-white/85",
            compact ? "text-[12px]" : "text-[17px]",
          )}
        >
          / {totalLaps || "\u2014"}
        </span>
        {shown("shuffle") && (
        <button
          type="button"
          onClick={partClick("shuffle") ?? onShuffle}
          title={t.raceShuffle}
          aria-label={t.raceShuffle}
          className={cn(
            "absolute flex shrink-0 items-center justify-center rounded text-white/30 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e10600]",
            compact ? "right-0.5 top-0.5 h-4 w-4" : "right-1 top-1 h-5 w-5",
            partClass("shuffle"),
          )}
        >
          <Shuffle className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
        </button>
        )}
      </div>
      )}

      {/* Which gap the column is showing, said in the control that changes it.
          Neither answer is the right one on its own: the interval says who is
          catching whom, the leader gap says how the field has strung out, and
          the broadcast switches between them for exactly that reason. */}
      {shown("gapMode") && (
      <button
        type="button"
        onClick={partClick("gapMode") ?? (() => setGapMode(gapMode === "leader" ? "ahead" : "leader"))}
        aria-pressed={gapMode === "ahead"}
        className={cn(
          "flex w-full items-center justify-center border-t border-white/10 font-bold uppercase text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#e10600]",
          compact ? "gap-1 py-[3px] text-[7px] tracking-[0.6px]" : "gap-1.5 py-1 text-[9px] tracking-[1px]",
          partClass("gapMode"),
        )}
      >
        <ArrowLeftRight className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} />
        {gapMode === "leader" ? t.raceLeaderGap : t.raceInterval}
      </button>
      )}
      </div>
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
                onClick={editing ? undefined : () => onSelect(index)}
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
                  selected ? "bg-white/[0.07]" : "hover:bg-white/[0.05]",
                )}
              >
                {/* The places run down a darker column of their own, each cell
                    a hair apart; the leader's is red. A car that has just moved
                    shows a green or red arrow there instead of its number for as
                    long as the change is news, as the broadcast does. */}
                <span
                  className={cn(
                    "relative flex shrink-0 items-center justify-center overflow-hidden font-medium tabular-nums",
                    compact ? "h-[calc(100%-2px)] w-[20px] text-[11px]" : "h-[calc(100%-2px)] w-[30px] text-[15px]",
                    leader ? "bg-[#e10600] text-white" : "bg-[#0d0d12] text-white/90",
                  )}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.span
                      key={direction ?? `place-${position}`}
                      initial={{ opacity: 0, y: direction === "down" ? -10 : 10, scale: direction ? 0.6 : 1 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.35 } }}
                      transition={{ type: "spring", stiffness: 180, damping: 22 }}
                      className="flex items-center justify-center"
                    >
                      {direction ? (
                        <svg
                          viewBox="0 0 10 7"
                          aria-hidden
                          className={compact ? "h-[6px] w-[9px]" : "h-[8px] w-[12px]"}
                          fill={direction === "up" ? "#22d36b" : "#ff2d2d"}
                        >
                          <path d={direction === "up" ? "M5 0 L10 7 H0 Z" : "M0 0 H10 L5 7 Z"} />
                        </svg>
                      ) : (
                        position + 1
                      )}
                    </motion.span>
                  </AnimatePresence>
                </span>
                {shown("team") && (
                <span
                  aria-hidden
                  onClick={partClick("team")}
                  className={cn(
                    "flex h-full shrink-0 items-center justify-center",
                    compact ? "w-[16px]" : "w-[24px]",
                    partClass("team"),
                  )}
                >
                  {/* The team in its colour, where the broadcast puts the team's badge. */}
                  <span
                    className={cn("-skew-x-[18deg] rounded-[1px]", compact ? "h-[9px] w-[7px]" : "h-[13px] w-[10px]")}
                    style={{ backgroundColor: driver.team.timingColour }}
                  />
                </span>
                )}
                {/* The car number, where the broadcast puts it: its own column
                    ahead of the driver, italic, and in the team's colour, so
                    the number says who this is before the code does. */}
                {shown("number") && (
                <span
                  onClick={partClick("number")}
                  className={cn(
                    "shrink-0 text-right font-black italic leading-none tabular-nums",
                    compact ? "w-[18px] pl-1 text-[10px]" : "w-[26px] pl-1.5 text-[14px]",
                    partClass("number"),
                  )}
                  style={{ color: driver.team.timingColour, textShadow: NUMBER_OUTLINE }}
                >
                  {driver.number}
                </span>
                )}
                <span
                  className={cn(
                    "shrink-0 font-semibold",
                    compact ? "w-[30px] pl-1 text-[11px] tracking-[0.5px]" : "w-[46px] pl-1.5 text-[15px] tracking-[0.9px]",
                  )}
                >
                  {driver.code}
                </span>
                {/* The gap sits in a column of its own right after the code,
                    as the broadcast sets it: pushed to the far edge it leaves
                    a hole across every row that no number ever fills. */}
                {shown("gap") && (
                <span
                  // The leader's word is the switch: it says which gap the column shows, and a click turns it over.
                  onClick={
                    partClick("gap") ??
                    (leader && started
                      ? (event: React.MouseEvent) => {
                          event.stopPropagation();
                          setGapMode(gapMode === "leader" ? "ahead" : "leader");
                        }
                      : undefined)
                  }
                  title={leader && started ? t.raceLeaderGap + " / " + t.raceInterval : undefined}
                  className={cn(
                    "shrink-0 self-stretch flex items-center justify-end whitespace-nowrap font-medium leading-none tabular-nums text-white",
                    leader && started && !editing && "cursor-pointer hover:text-white/70",
                    compact ? "w-[46px] text-[11px] tracking-[0.3px]" : "w-[64px] text-[15px] tracking-[0.5px]",
                    // The leader's word is longer than any number under it.
                    leader && (compact ? "text-[9px] font-normal" : "text-[13px] font-normal"),
                    partClass("gap"),
                  )}
                >
                  {gap}
                </span>
                )}
                {/* The compound as the broadcast writes it: its letter, in its colour. */}
                {shown("tyres") && (
                <span
                  onClick={partClick("tyres")}
                  className={cn(
                    "flex shrink-0 self-stretch items-center justify-center font-semibold",
                    compact ? "ml-1 w-[14px] text-[9px]" : "ml-1.5 w-[18px] text-[12px]",
                    partClass("tyres"),
                  )}
                  title={tyre}
                >
                  {tyre && <span style={{ color: TYRE_COLOUR[tyre] }}>{tyre}</span>}
                </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {fastestRow >= 0 && (
        // A window just past the tower's edge, so the chip slides out from behind it rather than over the row.
        <span
          title={t.raceFastestLap}
          style={{
            top: fastestRow * rowHeight + (rowHeight - (compact ? 14 : 20)) / 2 - scrollTop,
            transition: `top ${SLIDE_MS}ms ${SLIDE_EASING}`,
          }}
          className={cn(
            "pointer-events-none absolute overflow-hidden rounded-r-[3px]",
            compact ? "-right-3.5 h-3.5 w-3.5" : "-right-5 h-5 w-5",
          )}
        >
          {/* Keyed on the holder, so every new fastest lap comes out again, lit up as it lands. */}
          <motion.span
            key={fastestLapIndex}
            initial={{ x: "-100%", backgroundColor: "#e0b3ff" }}
            animate={{ x: 0, backgroundColor: "#8f2bd6" }}
            transition={{
              x: { type: "spring", stiffness: 420, damping: 28 },
              backgroundColor: { duration: 0.9, delay: 0.2, ease: "easeOut" },
            }}
            className="flex h-full w-full items-center justify-center text-white"
          >
            <Timer className={compact ? "h-2 w-2" : "h-3 w-3"} strokeWidth={2.5} />
          </motion.span>
        </span>
      )}
      </div>

    </div>
  );
}
