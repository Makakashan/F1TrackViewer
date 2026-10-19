import { create } from "zustand";
import { readPref, writePref } from "@/lib/local-pref";

/** The race HUD's movable pieces. The classification is a modal and stays where it is. */
export type HudItem = "tower" | "status" | "fastestLap" | "controls";

export const HUD_ITEMS: readonly HudItem[] = ["tower", "status", "fastestLap", "controls"];

/** The controls start and stop the race, so there is no hiding them. */
export const HUD_HIDEABLE: Record<HudItem, boolean> = {
  tower: true,
  status: true,
  fastestLap: true,
  controls: false,
};

/** Top, middle, bottom × left, centre, right. */
export type Anchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

/** The places each piece makes sense in: a tall tower hugs a side, nothing sits mid-screen over the cars. */
export const ALLOWED_ANCHORS: Record<FormFactor, Record<HudItem, readonly Anchor[]>> = {
  desktop: {
    tower: ["ml", "mr"],
    status: ["tl", "tc", "tr", "bl", "bc", "br"],
    fastestLap: ["tl", "tc", "tr", "bl", "bc", "br"],
    controls: ["bl", "bc", "br"],
  },
  mobile: {
    tower: ["tl", "tr"],
    status: ["tl", "tc", "tr", "bl", "bc", "br"],
    fastestLap: ["tl", "tc", "tr", "bl", "bc", "br"],
    controls: ["bl", "bc", "br"],
  },
};

/** Offsets point inward from the anchored edge, so a placement survives the window resizing. */
export interface Placement {
  anchor: Anchor;
  x: number;
  y: number;
}

export type TowerPart = "brand" | "lap" | "gapMode" | "team" | "number" | "gap" | "tyres" | "shuffle";

export const TOWER_PARTS: readonly TowerPart[] = [
  "brand",
  "lap",
  "shuffle",
  "gapMode",
  "number",
  "team",
  "gap",
  "tyres",
];

export type FormFactor = "desktop" | "mobile";

export type FormFactorPlacements = Record<HudItem, Placement>;

export interface HudLayout {
  /** A phone and a desktop have different room, so each keeps its own placements. */
  placement: Record<FormFactor, Record<HudItem, Placement>>;
  hidden: Record<HudItem, boolean>;
  /** Multiplies the tower's own fit to the screen height. */
  towerScale: number;
  towerHidden: Record<TowerPart, boolean>;
}

export const TOWER_SCALE_MIN = 0.6;
export const TOWER_SCALE_MAX = 1.6;

export const HUD_DEFAULTS: HudLayout = {
  placement: {
    desktop: {
      // Set in from the edge, where the broadcast hangs its tower.
      tower: { anchor: "ml", x: 40, y: 0 },
      status: { anchor: "tc", x: 0, y: 0 },
      fastestLap: { anchor: "tc", x: 0, y: 64 },
      controls: { anchor: "bc", x: 0, y: 8 },
    },
    mobile: {
      tower: { anchor: "tl", x: 0, y: 0 },
      status: { anchor: "tr", x: 0, y: 0 },
      fastestLap: { anchor: "tr", x: 0, y: 48 },
      controls: { anchor: "bc", x: 0, y: 8 },
    },
  },
  hidden: { tower: false, status: false, fastestLap: false, controls: false },
  towerScale: 1,
  towerHidden: {
    brand: false,
    lap: false,
    gapMode: true,
    team: false,
    number: true,
    gap: false,
    tyres: false,
    shuffle: false,
  },
};

const STORAGE_KEY = "f1tv:hud:v1";
const HINT_KEY = "f1tv:hud:hintSeen";

export type HudEditView = "visual" | "list";

interface HudLayoutState {
  layout: HudLayout;
  /** Null outside the editor; otherwise what Cancel goes back to. */
  before: HudLayout | null;
  view: HudEditView;
  /** The how-to card over the visual editor, shown until it has been dismissed once. */
  hint: boolean;
  showHint: () => void;
  dismissHint: () => void;
  load: () => void;
  begin: (view: HudEditView) => void;
  setView: (view: HudEditView) => void;
  done: () => void;
  cancel: () => void;
  reset: () => void;
  place: (form: FormFactor, item: HudItem, placement: Placement) => void;
  toggleItem: (item: HudItem) => void;
  toggleTowerPart: (part: TowerPart) => void;
  setTowerScale: (scale: number) => void;
  /** Applies a preset's pieces over the layout, leaving what it does not mention. */
  apply: (patch: Partial<HudLayout>) => void;
}

/** Stored placements, with any that point somewhere this piece may no longer go put back to the default. */
function allowed(form: FormFactor, stored: Partial<FormFactorPlacements> | undefined): FormFactorPlacements {
  const placements = { ...HUD_DEFAULTS.placement[form] };
  for (const item of HUD_ITEMS) {
    const placement = stored?.[item];
    if (placement && ALLOWED_ANCHORS[form][item].includes(placement.anchor)) placements[item] = placement;
  }
  return placements;
}

/** A stored layout from an older build may lack keys this one has. */
function merged(stored: Partial<HudLayout>): HudLayout {
  return {
    placement: {
      desktop: allowed("desktop", stored.placement?.desktop),
      mobile: allowed("mobile", stored.placement?.mobile),
    },
    hidden: { ...HUD_DEFAULTS.hidden, ...stored.hidden, controls: false },
    towerScale: clampScale(stored.towerScale ?? HUD_DEFAULTS.towerScale),
    towerHidden: { ...HUD_DEFAULTS.towerHidden, ...stored.towerHidden },
  };
}

export function clampScale(scale: number): number {
  return Math.min(TOWER_SCALE_MAX, Math.max(TOWER_SCALE_MIN, scale));
}

export const useHudLayout = create<HudLayoutState>((set, get) => {
  const edit = (change: (layout: HudLayout) => HudLayout) =>
    set({ layout: change(get().layout) });

  return {
    layout: HUD_DEFAULTS,
    before: null,
    view: "visual",
    hint: false,
    showHint: () => set({ hint: true }),
    dismissHint: () => {
      writePref(HINT_KEY, true);
      set({ hint: false });
    },
    load: () =>
      set({
        layout: merged(readPref<Partial<HudLayout>>(STORAGE_KEY, {})),
        hint: !readPref<boolean>(HINT_KEY, false),
      }),
    begin: (view) => set({ before: get().layout, view }),
    setView: (view) => set({ view }),
    done: () => {
      writePref(STORAGE_KEY, get().layout);
      set({ before: null });
    },
    cancel: () => {
      const before = get().before;
      if (before) set({ layout: before, before: null });
    },
    reset: () => set({ layout: HUD_DEFAULTS }),
    place: (form, item, placement) =>
      edit((layout) => ({
        ...layout,
        placement: {
          ...layout.placement,
          [form]: { ...layout.placement[form], [item]: placement },
        },
      })),
    toggleItem: (item) => {
      if (!HUD_HIDEABLE[item]) return;
      edit((layout) => ({
        ...layout,
        hidden: { ...layout.hidden, [item]: !layout.hidden[item] },
      }));
    },
    toggleTowerPart: (part) =>
      edit((layout) => ({
        ...layout,
        towerHidden: { ...layout.towerHidden, [part]: !layout.towerHidden[part] },
      })),
    setTowerScale: (scale) => edit((layout) => ({ ...layout, towerScale: clampScale(scale) })),
    apply: (patch) => edit((layout) => ({ ...layout, ...patch })),
  };
});

/** The point of a box that stays put when it is scaled about its anchor. */
export function anchorOrigin(anchor: Anchor): string {
  const vertical = anchor[0] === "t" ? "top" : anchor[0] === "b" ? "bottom" : "center";
  const horizontal = anchor[1] === "l" ? "left" : anchor[1] === "r" ? "right" : "center";
  return `${horizontal} ${vertical}`;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function offsetsFor(anchor: Anchor, box: Rect, stage: Rect): Placement {
  const width = stage.right - stage.left;
  const height = stage.bottom - stage.top;
  const cx = (box.left + box.right) / 2 - stage.left;
  const cy = (box.top + box.bottom) / 2 - stage.top;
  const x =
    anchor[1] === "l"
      ? box.left - stage.left
      : anchor[1] === "r"
        ? stage.right - box.right
        : cx - width / 2;
  const y =
    anchor[0] === "t"
      ? box.top - stage.top
      : anchor[0] === "b"
        ? stage.bottom - box.bottom
        : cy - height / 2;
  return { anchor, x: Math.round(x), y: Math.round(y) };
}

const ROW = { t: 0, m: 1, b: 2 } as const;
const COLUMN = { l: 0, c: 1, r: 2 } as const;

/**
 * Where a dropped box lands: the third of the stage its centre is in, moved to the
 * nearest place this piece is allowed, and how far it sits from that anchor.
 */
export function placementOf(item: HudItem, form: FormFactor, box: Rect, stage: Rect): Placement {
  const width = stage.right - stage.left;
  const height = stage.bottom - stage.top;
  const cx = (box.left + box.right) / 2 - stage.left;
  const cy = (box.top + box.bottom) / 2 - stage.top;
  const column = cx / width;
  const row = cy / height;
  let best = ALLOWED_ANCHORS[form][item][0];
  let bestDistance = Infinity;
  for (const anchor of ALLOWED_ANCHORS[form][item]) {
    const ax = (COLUMN[anchor[1] as "l" | "c" | "r"] + 0.5) / 3;
    const ay = (ROW[anchor[0] as "t" | "m" | "b"] + 0.5) / 3;
    const distance = Math.hypot(ax - column, ay - row);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  const placement = offsetsFor(best, box, stage);
  // A side the box was pulled away from still holds it: the tower dropped mid-screen goes to the edge.
  if (best[1] !== "c" && placement.x > width / 3) placement.x = 0;
  return placement;
}

/** Within this many pixels of its anchor's line, a box lands on it. */
export const SNAP_PX = 20;

export function snapped(placement: Placement): Placement {
  return {
    ...placement,
    x: Math.abs(placement.x) < SNAP_PX ? 0 : placement.x,
    y: Math.abs(placement.y) < SNAP_PX ? 0 : placement.y,
  };
}

export function overlaps(a: Rect, b: Rect, margin = 4): boolean {
  return (
    a.left < b.right + margin &&
    b.left < a.right + margin &&
    a.top < b.bottom + margin &&
    b.top < a.bottom + margin
  );
}
