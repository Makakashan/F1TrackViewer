"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, animate, motion, useMotionValue, type Transition } from "motion/react";
import { Eye, EyeOff, Move, MousePointer2, MousePointerClick, MoveDiagonal2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import {
  HUD_HIDEABLE,
  overlaps,
  placementOf,
  snapped,
  useHudLayout,
  type Anchor,
  type FormFactor,
  type HudItem,
  type Placement,
  type Rect,
} from "@/lib/race/hud-layout";
import { teamById } from "@/lib/race/f1-teams";

const SPRING = { type: "spring", stiffness: 420, damping: 32 } as const;

/** Where on the stage a placement puts the box, before any drag moves it. */
function slotStyle({ anchor, x, y }: Placement): CSSProperties {
  const style: CSSProperties = { position: "absolute" };
  const shift: string[] = [];
  if (anchor[1] === "l") style.left = x;
  else if (anchor[1] === "r") style.right = x;
  else {
    style.left = `calc(50% + ${x}px)`;
    shift.push("translateX(-50%)");
  }
  if (anchor[0] === "t") style.top = y;
  else if (anchor[0] === "b") style.bottom = y;
  else {
    style.top = `calc(50% + ${y}px)`;
    shift.push("translateY(-50%)");
  }
  if (shift.length) style.transform = shift.join(" ");
  return style;
}

/** The box a piece is seen as: the tower scales itself, so its layout box is not it. */
function visualBox(slot: Element): Rect {
  return (slot.querySelector("[data-hud-box]") ?? slot.firstElementChild ?? slot).getBoundingClientRect();
}

function inside(box: Rect, stage: Rect): boolean {
  return (
    box.left >= stage.left - 2 &&
    box.top >= stage.top - 2 &&
    box.right <= stage.right + 2 &&
    box.bottom <= stage.bottom + 2
  );
}

export interface HudSlotProps {
  item: HudItem;
  form: FormFactor;
  placement: Placement;
  stage: RefObject<HTMLDivElement | null>;
  editing: boolean;
  /** Free dragging is a desktop gesture; the list sets placements everywhere else. */
  draggable: boolean;
  hidden: boolean;
  /** The tower takes clicks on its parts while it is edited; the rest are only moved. */
  partsClickable?: boolean;
  className?: string;
  children: ReactNode;
}

/** One piece of the HUD, where its placement puts it, and draggable while the HUD is edited. */
export function HudSlot({
  item,
  form,
  placement,
  stage,
  editing,
  draggable,
  hidden,
  partsClickable = false,
  className,
  children,
}: HudSlotProps) {
  const place = useHudLayout((s) => s.place);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const slot = useRef<HTMLDivElement>(null);
  // Where the box sits with no drag on it, so a new placement can glide from the old one.
  const base = useRef<{ left: number; top: number } | null>(null);
  const dragging = useRef(false);

  const measureBase = () => {
    const element = slot.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left - x.get(), top: rect.top - y.get() };
  };

  useEffect(() => {
    const onResize = () => {
      base.current = measureBase();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // The new placement moves the box at once; this hands that jump back to the motion
  // values and lets a spring take it out, so the piece slides to its place.
  useLayoutEffect(() => {
    const now = measureBase();
    const previous = base.current;
    base.current = now;
    if (!now || !previous) return;
    const dx = previous.left - now.left;
    const dy = previous.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    x.set(x.get() + dx);
    y.set(y.get() + dy);
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
  }, [placement.anchor, placement.x, placement.y, form, hidden]);

  if (hidden && !editing) return null;

  const onDragEnd = () => {
    const stageElement = stage.current;
    const element = slot.current;
    if (!stageElement || !element) return;
    const stageBox = stageElement.getBoundingClientRect();
    const box = visualBox(element);
    const others = [...stageElement.querySelectorAll("[data-hud-slot]")]
      .filter((other) => other !== element && other.getAttribute("data-hud-hidden") !== "true")
      .map(visualBox);
    if (!inside(box, stageBox) || others.some((other) => overlaps(box, other))) {
      animate(x, 0, SPRING);
      animate(y, 0, SPRING);
      return;
    }
    place(form, item, snapped(placementOf(item, form, box, stageBox)));
  };

  return (
    <div style={slotStyle(placement)} className={className}>
      <motion.div
        ref={slot}
        data-hud-slot={item}
        data-hud-hidden={hidden}
        style={{ x, y }}
        drag={editing && draggable}
        dragMomentum={false}
        onDragStart={() => {
          dragging.current = true;
        }}
        onDragEnd={() => {
          onDragEnd();
          // The click that ends a drag is not a click on whatever is under it.
          window.setTimeout(() => {
            dragging.current = false;
          }, 0);
        }}
        onClickCapture={(event) => {
          if (!dragging.current) return;
          event.stopPropagation();
          event.preventDefault();
        }}
        animate={{ opacity: hidden ? 0.3 : 1 }}
        transition={SPRING}
        className={cn(
          editing && "pointer-events-auto touch-none",
          editing && draggable && "cursor-grab active:cursor-grabbing",
        )}
      >
        <div className={cn(editing && !partsClickable && "pointer-events-none")}>{children}</div>
      </motion.div>
    </div>
  );
}

interface Box extends Rect {
  item: HudItem;
  hidden: boolean;
}

/** The corner of a box furthest from where it is anchored, which is where it grows from. */
function freeCorner(anchor: Anchor, box: Rect): { x: number; y: number } {
  return {
    x: anchor[1] === "r" ? box.left : box.right,
    y: anchor[0] === "b" ? box.top : box.bottom,
  };
}

function anchorPoint(anchor: Anchor, box: Rect): { x: number; y: number } {
  return {
    x: anchor[1] === "l" ? box.left : anchor[1] === "r" ? box.right : (box.left + box.right) / 2,
    y: anchor[0] === "t" ? box.top : anchor[0] === "b" ? box.bottom : (box.top + box.bottom) / 2,
  };
}

/** The three beats of the demo: the cursor comes in, clicks, the column goes dashed, then all of it resets. */
const DEMO: Transition = { duration: 3.4, repeat: Infinity, times: [0, 0.3, 0.38, 0.86, 1], ease: "easeInOut" };

/** Whether the demo column is off at each beat. */
const OFF_ON = [false, false, true, true, false];

const DEMO_ROWS = [
  { place: 1, code: "ANT", gap: null, team: "mercedes", tyre: "#ffd12e", compound: "M" },
  { place: 2, code: "COL", gap: "+0.8", team: "alpine", tyre: "#f2f2f2", compound: "H" },
  { place: 3, code: "SAI", gap: "+1.4", team: "williams", tyre: "#ff3b3b", compound: "S" },
].map((row) => ({ ...row, colour: teamById(row.team)?.timingColour ?? "#ffffff" }));

/** Where the cursor clicks: the tyre cell of the second row, in the demo tower's pixels. */
const CLICK_X = 131;
const CLICK_Y = 50;

/** Our tower in three rows, and a cursor that keeps clicking its tyre column off and on. */
function HintDemo() {
  const { t } = useAppPref();
  return (
    <div className="mb-4 flex h-36 items-center justify-center overflow-hidden rounded-lg bg-[#2b2f36]">
      <div
        className="relative w-[144px] scale-[1.5] rounded-[3px] bg-[#15151e] text-white shadow-lg"
        style={{ fontFamily: "var(--font-timing), system-ui, sans-serif" }}
      >
        <div className="flex h-[18px] items-baseline justify-center gap-1 border-b border-white/10 bg-[#1a1a24] pt-0.5">
          <span className="text-[10px] font-normal uppercase tracking-[0.4px] text-white/90">{t.raceLap}</span>
          <span className="text-[12px] font-bold">1</span>
          <span className="text-[10px] font-normal text-white/80">/ 78</span>
        </div>
        {DEMO_ROWS.map((row, index) => (
          <div key={row.code} className="flex h-[22px] items-center">
            <span
              className={cn(
                "flex h-[calc(100%-4px)] w-5 shrink-0 items-center justify-center text-[11px] font-black",
                index === 0 && "bg-[#e10600]",
              )}
            >
              {row.place}
            </span>
            <span className="flex w-[18px] shrink-0 justify-center">
              <span className="h-[10px] w-[8px] -skew-x-[18deg] rounded-[1px]" style={{ backgroundColor: row.colour }} />
            </span>
            <span className="w-[34px] shrink-0 pl-1 text-[11px] font-bold tracking-[0.3px]">{row.code}</span>
            <span
              className={cn(
                "w-[46px] shrink-0 text-right tabular-nums",
                index === 0 ? "text-[9px] font-normal" : "text-[11px] font-medium",
              )}
            >
              {row.gap ?? t.raceInterval}
            </span>
            <motion.span
              animate={{
                opacity: OFF_ON.map((off) => (off ? 0.25 : 1)),
                outlineColor: OFF_ON.map((off) => (off ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0)")),
              }}
              transition={DEMO}
              className="ml-1 flex h-full w-[18px] shrink-0 items-center justify-center text-[11px] font-bold outline-dashed outline-1 -outline-offset-1"
              style={{ color: row.tyre }}
            >
              {row.compound}
            </motion.span>
          </div>
        ))}
        <motion.span
          aria-hidden
          animate={{ x: [40, 0, 0, 0, 40], y: [34, 0, 0, 0, 34], scale: [1, 1, 0.8, 1, 1] }}
          transition={DEMO}
          className="absolute text-white drop-shadow"
          style={{ left: CLICK_X - 3, top: CLICK_Y - 2 }}
        >
          <MousePointer2 className="h-5 w-5 fill-white" />
        </motion.span>
      </div>
    </div>
  );
}

const HINT_WIDTH = 300;

/** The how-to card, set beside the tower so the demo sits next to the real thing. */
function HudHint({ tower, stageWidth }: { tower: Box | undefined; stageWidth: number }) {
  const { t } = useAppPref();
  const dismiss = useHudLayout((s) => s.dismissHint);
  const onLeft = !tower || (tower.left + tower.right) / 2 < stageWidth / 2;
  const style: CSSProperties = !tower || tower.hidden
    ? { left: "50%", top: 24, marginLeft: -HINT_WIDTH / 2 }
    : onLeft
      ? { left: tower.right + 24, top: Math.max(0, tower.top + 40) }
      : { left: tower.left - 24 - HINT_WIDTH, top: Math.max(0, tower.top + 40) };
  const tips = [
    [MousePointerClick, t.hudHintClick],
    [Move, t.hudHintDrag],
    [MoveDiagonal2, t.hudHintResize],
    [EyeOff, t.hudHintEye],
  ] as const;

  return (
    <motion.div
      initial={{ opacity: 0, x: onLeft ? -12 : 12, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 360, damping: 26 }}
      style={{ ...style, width: HINT_WIDTH }}
      className="pointer-events-auto absolute z-10 rounded-xl border border-border bg-background p-4 text-sm shadow-2xl"
    >
      <HintDemo />
      <ul className="flex flex-col gap-2.5">
        {tips.map(([Icon, text]) => (
          <li key={text} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="leading-snug">{text}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={dismiss}
        className="mt-4 w-full rounded-md bg-foreground py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90"
      >
        {t.hudHintOk}
      </button>
    </motion.div>
  );
}

export interface HudEditOverlayProps {
  stage: RefObject<HTMLDivElement | null>;
  towerAnchor: Anchor;
}

/**
 * Outlines over every piece, the eye that hides it and the handle that sizes the tower.
 * It follows the pieces frame by frame while the editor is open, and only then.
 */
export function HudEditOverlay({ stage, towerAnchor }: HudEditOverlayProps) {
  const { t } = useAppPref();
  const toggleItem = useHudLayout((s) => s.toggleItem);
  const setTowerScale = useHudLayout((s) => s.setTowerScale);
  const hint = useHudLayout((s) => s.hint);
  const [boxes, setBoxes] = useState<Box[]>([]);

  useEffect(() => {
    let frame = 0;
    let last = "";
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const stageElement = stage.current;
      if (!stageElement) return;
      const origin = stageElement.getBoundingClientRect();
      const next = [...stageElement.querySelectorAll<HTMLElement>("[data-hud-slot]")].map(
        (slot) => {
          const box = visualBox(slot);
          return {
            item: slot.dataset.hudSlot as HudItem,
            hidden: slot.dataset.hudHidden === "true",
            left: box.left - origin.left,
            top: box.top - origin.top,
            right: box.right - origin.left,
            bottom: box.bottom - origin.top,
          };
        },
      );
      const key = next
        .map((box) => `${box.item}${box.hidden}${box.left | 0},${box.top | 0},${box.right | 0},${box.bottom | 0}`)
        .join(";");
      if (key === last) return;
      last = key;
      setBoxes(next);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  const startScale = (event: React.PointerEvent, box: Box) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const origin = stage.current?.getBoundingClientRect();
    if (!origin) return;
    const pivot = anchorPoint(towerAnchor, box);
    const distance = (clientX: number, clientY: number) =>
      Math.hypot(clientX - origin.left - pivot.x, clientY - origin.top - pivot.y);
    const from = distance(event.clientX, event.clientY) || 1;
    const scale = useHudLayout.getState().layout.towerScale;
    const onMove = (move: PointerEvent) => {
      setTowerScale((scale * distance(move.clientX, move.clientY)) / from);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      {boxes.map((box) => {
        const corner = box.item === "tower" ? freeCorner(towerAnchor, box) : null;
        return (
          <div key={box.item}>
            <div
              className="absolute rounded-md border border-dashed border-white/70"
              style={{
                left: box.left - 4,
                top: box.top - 4,
                width: box.right - box.left + 8,
                height: box.bottom - box.top + 8,
              }}
            />
            {HUD_HIDEABLE[box.item] && (
              <button
                type="button"
                onClick={() => toggleItem(box.item)}
                title={box.hidden ? t.hudShow : t.hudHide}
                aria-label={box.hidden ? t.hudShow : t.hudHide}
                className="pointer-events-auto absolute flex h-6 w-6 items-center justify-center rounded-full border border-white/30 bg-[#0f1219] text-white shadow-lg transition-transform hover:scale-110"
                style={{ left: box.right - 8, top: box.top - 16 }}
              >
                {box.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            )}
            {corner && !box.hidden && (
              <button
                type="button"
                onPointerDown={(event) => startScale(event, box)}
                title={t.hudScale}
                aria-label={t.hudScale}
                className="pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize touch-none items-center justify-center rounded-full border border-white/30 bg-[#0f1219] text-white shadow-lg"
                style={{ left: corner.x, top: corner.y }}
              >
                <MoveDiagonal2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
      <AnimatePresence>
        {hint && boxes.length > 0 && (
          <HudHint
            tower={boxes.find((box) => box.item === "tower")}
            stageWidth={stage.current?.clientWidth ?? 0}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
