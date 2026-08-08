"use client";

import { Gauge, Map, Ruler, SlidersHorizontal } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import type { QualityMode } from "@/lib/url-state";

export interface RaceSceneSettingsProps {
  environmentAvailable: boolean;
  environmentEnabled: boolean;
  setEnvironmentEnabled: (v: boolean) => void;
  setEnvironmentTerrain: (v: boolean) => void;
  environmentTerrain: boolean;
  realWidthAvailable: boolean;
  realWidthEnabled: boolean;
  setRealWidthEnabled: (v: boolean) => void;
  qualityMode: QualityMode;
  setQualityMode: (v: QualityMode) => void;
}

/**
 * Three scene switches, in a popover.
 *
 * Race mode inherits the viewer's saved preferences, and silently inheriting
 * them is how someone arrives with terrain off and concludes the mode is
 * broken. Small and out of the way, but reachable.
 */
export default function RaceSceneSettings(props: RaceSceneSettingsProps) {
  const { t } = useAppPref();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <SlidersHorizontal className="h-4 w-4" />
          <span className="hidden sm:inline">{t.raceScene}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <RaceSceneFields {...props} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The switches without the popover around them, so a phone's single overflow
 * menu can show them inline. A popover nested in a popover closes its parent
 * the moment it takes focus, which is how one tap dismisses both.
 */
export function RaceSceneFields({
  environmentAvailable,
  environmentEnabled,
  setEnvironmentEnabled,
  setEnvironmentTerrain,
  environmentTerrain,
  realWidthAvailable,
  realWidthEnabled,
  setRealWidthEnabled,
  qualityMode,
  setQualityMode,
}: RaceSceneSettingsProps) {
  const { t } = useAppPref();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2">
        <Label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Map className="h-3.5 w-3.5" />
          {t.terrain}
        </Label>
        <Switch
          checked={environmentAvailable && environmentEnabled && environmentTerrain}
          disabled={!environmentAvailable}
          onCheckedChange={(enabled) => {
            setEnvironmentEnabled(enabled);
            setEnvironmentTerrain(enabled);
          }}
        />
      </div>

      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2",
          !realWidthAvailable && "opacity-60",
        )}
      >
        <Label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Ruler className="h-3.5 w-3.5" />
          {t.realWidth}
        </Label>
        <Switch
          checked={realWidthAvailable && realWidthEnabled}
          disabled={!realWidthAvailable}
          onCheckedChange={setRealWidthEnabled}
        />
      </div>

      <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />
          {t.quality}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-border bg-background/30 p-1">
          {(["auto", "performance", "quality"] as QualityMode[]).map(
            (mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setQualityMode(mode)}
                className={cn(
                  // Three words of unequal length in three equal columns:
                  // without the clamp the long one prints over its neighbour.
                  "min-w-0 truncate rounded-md px-2 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  qualityMode === mode
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {mode === "auto"
                  ? t.qualityAuto
                  : mode === "performance"
                    ? t.qualityPerformance
                    : t.qualityHigh}
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
