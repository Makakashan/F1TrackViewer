"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { motion, useDragControls } from "motion/react";
import {
  CircleHelp,
  GripHorizontal,
  LayoutDashboard,
  LayoutGrid,
  MousePointer2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import { useHudLayout, type FormFactor, type HudLayout, type Placement } from "@/lib/race/hud-layout";
import {
  HUD_PRESETS,
  HUD_PRESET_IDS,
  TOWER_DENSITIES,
  TOWER_SIZES,
  densityOf,
  presetOf,
  sizeOf,
  towerPartsFor,
  type HudPresetId,
  type TowerDensity,
  type TowerSize,
} from "@/lib/race/hud-presets";
import { TEAMS_2025 } from "@/lib/race/f1-teams";

/** What sits over the header while the HUD is edited: the view, and the ways out. */
export function HudEditToolbar({ allowVisual }: { allowVisual: boolean }) {
  const { t } = useAppPref();
  const view = useHudLayout((s) => s.view);
  const setView = useHudLayout((s) => s.setView);
  const reset = useHudLayout((s) => s.reset);
  const cancel = useHudLayout((s) => s.cancel);
  const done = useHudLayout((s) => s.done);
  const showHint = useHudLayout((s) => s.showHint);

  return (
    <div className="absolute inset-0 z-20 grid grid-cols-[1fr_auto_1fr] items-center gap-3 bg-background px-3 pt-[env(safe-area-inset-top)] animate-in fade-in slide-in-from-top-1 duration-200 md:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <LayoutDashboard className="h-4 w-4" />
        </span>
        <span className="hidden truncate text-sm font-semibold sm:block">{t.hudEdit}</span>
        {allowVisual && view === "visual" && (
          <button
            type="button"
            onClick={showHint}
            className="ml-1 flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground animate-in fade-in duration-200"
          >
            <CircleHelp className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{t.hudHelp}</span>
          </button>
        )}
      </div>

      <div className="flex items-center">
        {allowVisual && (
          <div className="flex rounded-lg bg-muted p-1">
            {(
              [
                ["visual", MousePointer2, t.hudVisual],
                ["list", LayoutGrid, t.hudPresets],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setView(value)}
                aria-pressed={view === value}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
                  view === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={reset}
          title={t.hudReset}
        >
          <RotateCcw className="h-4 w-4" />
          <span className="hidden lg:inline">{t.hudReset}</span>
        </Button>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <Button variant="outline" size="sm" onClick={cancel}>
          {t.hudCancel}
        </Button>
        <Button size="sm" className="px-4" onClick={done}>
          {t.hudDone}
        </Button>
      </div>
    </div>
  );
}

/** Team colours down the miniature tower, so it reads as a field rather than a grey block. */
const MINI_TEAMS = TEAMS_2025.map((team) => team.timingColour);
const MINI_TYRES = ["#ffd12e", "#f2f2f2", "#ff3b3b"];

/** How wide each column of the tower is, in the miniature's own units. */
const COLUMN_UNITS = { place: 14, team: 9, number: 11, code: 24, gap: 24, tyres: 9 };
/** The width of the full tower, which every other is drawn against. */
const FULL_UNITS = 80;

function towerUnits(hidden: HudLayout["towerHidden"]): number {
  return (
    COLUMN_UNITS.place +
    COLUMN_UNITS.code +
    (hidden.team ? 0 : COLUMN_UNITS.team) +
    (hidden.number ? 0 : COLUMN_UNITS.number) +
    (hidden.gap ? 0 : COLUMN_UNITS.gap) +
    (hidden.tyres ? 0 : COLUMN_UNITS.tyres)
  );
}

/** The tower drawn small: header, lap band, and a field of rows with the columns it shows. */
function MiniTower({ hidden, rows = 10 }: { hidden: HudLayout["towerHidden"]; rows?: number }) {
  const units = towerUnits(hidden);
  const share = (value: number) => `${(value / units) * 100}%`;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[2px] bg-[#15151e] shadow-md">
      {!hidden.brand && (
        <div className="flex h-[11%] shrink-0 flex-col items-center justify-center gap-[12%] bg-[#22222c]">
          <span className="flex h-[38%] w-full items-center justify-center gap-[5%]">
            <span className="aspect-square h-full rounded-[1px] bg-white" />
            <span className="h-[70%] w-[36%] rounded-[1px] bg-white/85" />
          </span>
          <span className="h-[14%] w-[46%] rounded-[1px] bg-white/40" />
        </div>
      )}
      {!hidden.lap && (
        <div className="flex h-[6%] shrink-0 items-center justify-center border-t border-white/10 bg-[#1a1a24]">
          <span className="h-[44%] w-[34%] rounded-[1px] bg-white/70" />
        </div>
      )}
      {!hidden.gapMode && <div className="h-[3%] shrink-0 border-t border-white/10" />}
      <div className="flex min-h-0 flex-1 flex-col justify-between py-[3%]">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-[7%] items-center">
            <span
              className="flex h-full shrink-0 items-center justify-center"
              style={{ width: share(COLUMN_UNITS.place) }}
            >
              <span className={cn("h-full", index === 0 ? "w-full bg-[#e10600]" : "w-[40%] bg-white/80")} />
            </span>
            {!hidden.team && (
              <span className="flex h-full shrink-0 items-center justify-center" style={{ width: share(COLUMN_UNITS.team) }}>
                <span
                  className="h-[80%] w-[45%] -skew-x-[18deg]"
                  style={{ backgroundColor: MINI_TEAMS[index] }}
                />
              </span>
            )}
            {!hidden.number && (
              <span
                className="flex h-full shrink-0 items-center justify-end"
                style={{ width: share(COLUMN_UNITS.number) }}
              >
                <span className="h-[55%] w-[60%] rounded-[1px]" style={{ backgroundColor: MINI_TEAMS[index] }} />
              </span>
            )}
            <span className="flex h-full shrink-0 items-center pl-[3%]" style={{ width: share(COLUMN_UNITS.code) }}>
              <span className="h-[60%] w-[80%] rounded-[1px] bg-white" />
            </span>
            {!hidden.gap && (
              <span
                className="flex h-full shrink-0 items-center justify-end"
                style={{ width: share(COLUMN_UNITS.gap) }}
              >
                <span className={cn("h-[45%] rounded-[1px] bg-white/60", index === 0 ? "w-[85%]" : "w-[55%]")} />
              </span>
            )}
            {!hidden.tyres && (
              <span
                className="flex h-full shrink-0 items-center justify-center"
                style={{ width: share(COLUMN_UNITS.tyres) }}
              >
                <span
                  className="h-[60%] w-[45%] rounded-[1px]"
                  style={{ backgroundColor: MINI_TYRES[index % MINI_TYRES.length] }}
                />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The screen a miniature stands for, so pixel offsets turn into its percentages. */
const MINI_SCREEN: Record<FormFactor, { width: number; height: number; margin: number }> = {
  desktop: { width: 1400, height: 780, margin: 2.5 },
  mobile: { width: 390, height: 760, margin: 3 },
};

/** Sizes of the small pieces on the miniature, in percent of it. */
const MINI_PIECE: Record<FormFactor, Record<"status" | "fastestLap" | "controls", [number, number]>> = {
  desktop: { status: [21, 9], fastestLap: [14, 7.5], controls: [36, 9] },
  mobile: { status: [34, 4], fastestLap: [26, 4], controls: [70, 5] },
};

function miniPosition({ anchor, x, y }: Placement, form: FormFactor): CSSProperties {
  const { width, height, margin } = MINI_SCREEN[form];
  const dx = (x / width) * 100;
  const dy = (y / height) * 100;
  const style: CSSProperties = { position: "absolute" };
  const shift: string[] = [];
  if (anchor[1] === "l") style.left = `${margin + dx}%`;
  else if (anchor[1] === "r") style.right = `${margin + dx}%`;
  else {
    style.left = `${50 + dx}%`;
    shift.push("translateX(-50%)");
  }
  if (anchor[0] === "t") style.top = `${margin + dy}%`;
  else if (anchor[0] === "b") style.bottom = `${margin + dy}%`;
  else {
    style.top = `${50 + dy}%`;
    shift.push("translateY(-50%)");
  }
  if (shift.length) style.transform = shift.join(" ");
  return style;
}

/** A whole HUD layout drawn as a thumbnail of the race screen. */
function MiniScreen({ layout, form }: { layout: HudLayout; form: FormFactor }) {
  const placements = layout.placement[form];
  const piece = MINI_PIECE[form];
  const towerWidth =
    (towerUnits(layout.towerHidden) / FULL_UNITS) * (form === "desktop" ? 15 : 40) * layout.towerScale;
  const towerHeight = (form === "desktop" ? 88 : 56) * Math.min(layout.towerScale, 1.05);
  const box = (item: "status" | "fastestLap" | "controls"): CSSProperties => ({
    ...miniPosition(placements[item], form),
    width: `${piece[item][0]}%`,
    height: `${piece[item][1]}%`,
  });

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-md",
        form === "desktop" ? "aspect-[16/9]" : "aspect-[9/17]",
      )}
      style={{
        background:
          "linear-gradient(118deg, #3d424b 0%, #3d424b 34%, #6b7079 34.6%, #25282e 35.2%, #25282e 57%, #6b7079 57.6%, #3d424b 58.2%, #3d424b 100%)",
      }}
    >
      {!layout.hidden.tower && (
        <div
          style={{
            ...miniPosition(placements.tower, form),
            width: `${towerWidth}%`,
            height: `${towerHeight}%`,
          }}
        >
          <MiniTower hidden={layout.towerHidden} />
        </div>
      )}
      {!layout.hidden.status && (
        <div
          style={box("status")}
          className="flex items-center justify-center gap-[6%] rounded-[3px] bg-white/85 px-[6%] shadow"
        >
          <span className="flex h-[52%] flex-1 items-center justify-around rounded-[2px] bg-[#3a3d44] px-[4%]">
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className="aspect-square h-[55%] rounded-full bg-[#7a1a1a]" />
            ))}
          </span>
          <span className="h-[30%] w-[38%] rounded-[1px] bg-[#c9ccd2]" />
        </div>
      )}
      {!layout.hidden.fastestLap && (
        <div
          style={box("fastestLap")}
          className="flex items-center gap-[8%] rounded-[3px] bg-[#1b0d26] px-[8%] shadow ring-1 ring-[#c400ff]/50"
        >
          <span className="aspect-square h-[55%] rounded-[1px] bg-[#c400ff]" />
          <span className="h-[36%] flex-1 rounded-[1px] bg-[#e2c9ff]/80" />
        </div>
      )}
      <div style={box("controls")} className="flex items-center gap-[4%] rounded-[3px] bg-white/85 px-[3%] shadow">
        <span className="h-[55%] w-[24%] rounded-[2px] bg-[#111]" />
        <span className="h-[30%] flex-1 rounded-[1px] bg-[#c9ccd2]" />
        <span className="h-[55%] w-[18%] rounded-[2px] bg-white ring-1 ring-black/10" />
      </div>
    </div>
  );
}

const PRESET_LABEL = {
  broadcast: "hudPresetBroadcast",
  mirror: "hudPresetMirror",
  compact: "hudPresetCompact",
  minimal: "hudPresetMinimal",
  cinema: "hudPresetCinema",
} as const satisfies Record<HudPresetId, string>;

const DENSITY_LABEL = {
  full: "hudDensityFull",
  compact: "hudDensityCompact",
  minimal: "hudDensityMinimal",
} as const satisfies Record<TowerDensity, string>;

/** A choice shown as what it looks like, with its name under it. */
function PictureChoice({
  selected,
  label,
  onClick,
  className,
  children,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group flex shrink-0 flex-col items-center gap-2 text-xs font-medium sm:text-sm",
        className,
      )}
    >
      <span
        className={cn(
          "block w-full rounded-lg p-1 ring-2 transition-all duration-200 group-hover:-translate-y-0.5",
          selected ? "ring-foreground" : "ring-transparent group-hover:ring-border",
        )}
      >
        {children}
      </span>
      <span className={selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}>
        {label}
      </span>
    </button>
  );
}

const SECTION_TITLE = "text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:text-sm";

/** The same choices as the visual editor, made by looking: whole screens, then the tower's look. */
export function HudListPanel({ form }: { form: FormFactor }) {
  const { t } = useAppPref();
  const layout = useHudLayout((s) => s.layout);
  const apply = useHudLayout((s) => s.apply);
  const area = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  const preset = presetOf(layout, form);
  const density = densityOf(layout.towerHidden);
  const size = sizeOf(layout.towerScale);
  const mobile = form === "mobile";
  const cardWidth = mobile ? "w-[84px]" : undefined;

  const body = (
    <>
      <section className="flex flex-col gap-3">
        <h3 className={SECTION_TITLE}>{t.hudLayout}</h3>
        <div className={mobile ? "-mx-4 flex gap-3 overflow-x-auto px-4 pb-1" : "grid grid-cols-3 gap-4"}>
          {HUD_PRESET_IDS.map((id) => (
            <PictureChoice
              key={id}
              selected={preset === id}
              label={t[PRESET_LABEL[id]]}
              onClick={() => apply(HUD_PRESETS[id])}
              className={cardWidth}
            >
              <MiniScreen layout={HUD_PRESETS[id]} form={form} />
            </PictureChoice>
          ))}
          {preset === null && (
            <PictureChoice selected label={t.hudPresetCustom} onClick={() => undefined} className={cardWidth}>
              <MiniScreen layout={layout} form={form} />
            </PictureChoice>
          )}
        </div>
      </section>

      {!layout.hidden.tower && (
        <section className="flex flex-col gap-3">
          <h3 className={SECTION_TITLE}>{t.hudTowerStyle}</h3>
          <div className="flex items-start gap-4 sm:gap-6">
            <div className="flex flex-1 gap-2 sm:gap-4">
              {TOWER_DENSITIES.map((option) => {
                const parts = towerPartsFor(option);
                return (
                  <PictureChoice
                    key={option}
                    selected={density === option}
                    label={t[DENSITY_LABEL[option]]}
                    onClick={() => apply({ towerHidden: parts })}
                    className="flex-1"
                  >
                    <span className="flex h-24 items-center justify-center rounded-md bg-[#2b2f36] p-2 sm:h-32 sm:p-3 2xl:h-40">
                      <span
                        className="block h-full"
                        style={{ aspectRatio: `${towerUnits(parts) / FULL_UNITS} / 1.9` }}
                      >
                        <MiniTower hidden={parts} rows={8} />
                      </span>
                    </span>
                  </PictureChoice>
                );
              })}
            </div>
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              <div className="flex h-[104px] items-end gap-1 rounded-lg bg-muted p-1 sm:h-[144px] sm:gap-1.5 sm:p-1.5 2xl:h-[176px]">
                {(Object.keys(TOWER_SIZES) as TowerSize[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => apply({ towerScale: TOWER_SIZES[option] })}
                    aria-pressed={size === option}
                    aria-label={`${t.hudScale} ${option.toUpperCase()}`}
                    className={cn(
                      "flex h-full w-9 flex-col items-center justify-end gap-1 rounded-md pb-1.5 text-[10px] font-bold transition-colors sm:w-12 sm:gap-1.5 sm:pb-2 sm:text-xs",
                      size === option
                        ? "bg-background text-foreground shadow"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "w-3 rounded-[2px] transition-colors sm:w-4",
                        size === option ? "bg-foreground" : "bg-muted-foreground/40",
                      )}
                      style={{ height: `${TOWER_SIZES[option] * 55}%` }}
                    />
                    {option.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="text-xs font-medium text-muted-foreground sm:text-sm">{t.hudScale}</span>
            </div>
          </div>
        </section>
      )}
    </>
  );

  if (mobile) {
    return (
      <div className="pointer-events-auto absolute inset-x-2 bottom-2 z-30 flex max-h-[62%] flex-col gap-5 overflow-y-auto rounded-xl border border-border bg-background/95 p-4 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-4 duration-300">
        {body}
      </div>
    );
  }

  // The panel can be dragged by its grip anywhere it fits, so it never has to sit on what it is changing.
  return (
    <div ref={area} className="absolute inset-0 z-30 flex items-center justify-center p-4">
      <motion.div
        drag
        dragListener={false}
        dragControls={drag}
        dragConstraints={area}
        dragElastic={0.06}
        dragMomentum={false}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="pointer-events-auto flex max-h-full w-[min(44rem,100%)] 2xl:w-[52rem] flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-md"
      >
        <div
          onPointerDown={(event) => drag.start(event)}
          className="flex shrink-0 cursor-grab touch-none items-center justify-center py-2.5 text-muted-foreground/60 active:cursor-grabbing"
        >
          <GripHorizontal className="h-5 w-5" />
        </div>
        <div className="flex flex-col gap-6 overflow-y-auto px-6 pb-6 2xl:gap-8 2xl:px-7 2xl:pb-7">{body}</div>
      </motion.div>
    </div>
  );
}
