import {
  HUD_DEFAULTS,
  HUD_ITEMS,
  TOWER_PARTS,
  type FormFactor,
  type HudLayout,
  type TowerPart,
} from "@/lib/race/hud-layout";

export type TowerDensity = "full" | "compact" | "minimal";

/** What each density leaves out of the tower. */
const DENSITY_HIDES: Record<TowerDensity, readonly TowerPart[]> = {
  // The broadcast tower carries no car numbers and no gap switch; both stay one click away in the editor.
  full: ["number", "gapMode"],
  compact: ["brand", "shuffle", "gapMode", "number"],
  minimal: ["brand", "shuffle", "gapMode", "number", "tyres"],
};

export const TOWER_DENSITIES: readonly TowerDensity[] = ["full", "compact", "minimal"];

export function towerPartsFor(density: TowerDensity): HudLayout["towerHidden"] {
  const hidden = { ...HUD_DEFAULTS.towerHidden };
  for (const part of DENSITY_HIDES[density]) hidden[part] = true;
  return hidden;
}

export function densityOf(towerHidden: HudLayout["towerHidden"]): TowerDensity | null {
  return (
    TOWER_DENSITIES.find((density) => {
      const expected = towerPartsFor(density);
      return TOWER_PARTS.every((part) => !!towerHidden[part] === expected[part]);
    }) ?? null
  );
}

export type TowerSize = "s" | "m" | "l";

export const TOWER_SIZES: Record<TowerSize, number> = { s: 0.85, m: 1, l: 1.2 };

export function sizeOf(scale: number): TowerSize | null {
  return (
    (Object.keys(TOWER_SIZES) as TowerSize[]).find(
      (size) => Math.abs(TOWER_SIZES[size] - scale) < 0.01,
    ) ?? null
  );
}

export type HudPresetId = "broadcast" | "mirror" | "compact" | "minimal" | "cinema";

export const HUD_PRESET_IDS: readonly HudPresetId[] = [
  "broadcast",
  "mirror",
  "compact",
  "minimal",
  "cinema",
];

const SHOWN = { tower: false, status: false, fastestLap: false, controls: false };

/** Whole screens, each one look rather than a set of knobs. */
export const HUD_PRESETS: Record<HudPresetId, HudLayout> = {
  broadcast: HUD_DEFAULTS,
  mirror: {
    ...HUD_DEFAULTS,
    placement: {
      desktop: { ...HUD_DEFAULTS.placement.desktop, tower: { anchor: "mr", x: 40, y: 0 } },
      mobile: {
        tower: { anchor: "tr", x: 0, y: 0 },
        status: { anchor: "tl", x: 0, y: 0 },
        fastestLap: { anchor: "tl", x: 0, y: 48 },
        controls: { anchor: "bc", x: 0, y: 8 },
      },
    },
  },
  compact: {
    placement: {
      desktop: {
        tower: { anchor: "ml", x: 40, y: 0 },
        status: { anchor: "tr", x: 0, y: 0 },
        fastestLap: { anchor: "tr", x: 0, y: 64 },
        controls: { anchor: "br", x: 0, y: 8 },
      },
      mobile: {
        tower: { anchor: "tl", x: 0, y: 0 },
        status: { anchor: "tr", x: 0, y: 0 },
        fastestLap: { anchor: "tr", x: 0, y: 48 },
        controls: { anchor: "br", x: 0, y: 8 },
      },
    },
    hidden: SHOWN,
    towerScale: TOWER_SIZES.s,
    towerHidden: towerPartsFor("compact"),
  },
  minimal: {
    placement: {
      desktop: { ...HUD_DEFAULTS.placement.desktop, fastestLap: { anchor: "tc", x: 0, y: 0 } },
      mobile: { ...HUD_DEFAULTS.placement.mobile, fastestLap: { anchor: "tr", x: 0, y: 0 } },
    },
    hidden: { ...SHOWN, status: true },
    towerScale: TOWER_SIZES.s,
    towerHidden: towerPartsFor("minimal"),
  },
  cinema: {
    ...HUD_DEFAULTS,
    hidden: { tower: true, status: true, fastestLap: true, controls: false },
  },
};

function samePlace(a: HudLayout, b: HudLayout, form: FormFactor, item: (typeof HUD_ITEMS)[number]) {
  const pa = a.placement[form][item];
  const pb = b.placement[form][item];
  return pa.anchor === pb.anchor && pa.x === pb.x && pa.y === pb.y;
}

/** The preset the layout is, on this form factor, or null for a layout of the user's own. */
export function presetOf(layout: HudLayout, form: FormFactor): HudPresetId | null {
  return (
    HUD_PRESET_IDS.find((id) => {
      const preset = HUD_PRESETS[id];
      return (
        HUD_ITEMS.every(
          (item) =>
            !!layout.hidden[item] === !!preset.hidden[item] &&
            (preset.hidden[item] || samePlace(layout, preset, form, item)),
        ) &&
        (preset.hidden.tower ||
          (Math.abs(layout.towerScale - preset.towerScale) < 0.01 &&
            densityOf(layout.towerHidden) === densityOf(preset.towerHidden)))
      );
    }) ?? null
  );
}
