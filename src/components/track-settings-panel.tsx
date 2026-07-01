"use client";

import {
  Camera,
  Flag,
  Layers,
  Map,
  Mountain,
  RotateCw,
  Ruler,
  Spline,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppPref } from "@/components/app-pref-provider";
import type { CameraPreset } from "@/components/track-viewer";
import type { TrackViewMode } from "@/lib/track-markers";

export interface TrackSettingsPanelProps {
  autoRotate: boolean;
  setAutoRotate: (v: boolean) => void;
  elevationEnabled: boolean;
  setElevationEnabled: (v: boolean) => void;
  trackWidth: number;
  setTrackWidth: (v: number) => void;
  onCameraPreset: (preset: CameraPreset) => void;
  viewMode: TrackViewMode;
  setViewMode: (v: TrackViewMode) => void;
  sectorsAvailable: boolean;
  environmentAvailable: boolean;
  environmentEnabled: boolean;
  setEnvironmentEnabled: (v: boolean) => void;
  environmentTerrain: boolean;
  setEnvironmentTerrain: (v: boolean) => void;
  realWidthAvailable: boolean;
  realWidthEnabled: boolean;
  setRealWidthEnabled: (v: boolean) => void;
  meanWidthMeters: number | null;
  minWidthMeters: number | null;
  maxWidthMeters: number | null;
}

function SettingRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5">
      <Label className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </Label>
      {children}
    </div>
  );
}

export default function TrackSettingsPanel({
  autoRotate,
  setAutoRotate,
  elevationEnabled,
  setElevationEnabled,
  trackWidth,
  setTrackWidth,
  onCameraPreset,
  viewMode,
  setViewMode,
  sectorsAvailable,
  environmentAvailable,
  environmentEnabled,
  setEnvironmentEnabled,
  environmentTerrain,
  setEnvironmentTerrain,
  realWidthAvailable,
  realWidthEnabled,
  setRealWidthEnabled,
  meanWidthMeters,
  minWidthMeters,
  maxWidthMeters,
}: TrackSettingsPanelProps) {
  const { t } = useAppPref();
  const realWidthActive = realWidthAvailable && realWidthEnabled;
  const terrainModeActive =
    environmentAvailable && environmentEnabled && environmentTerrain;

  return (
    <div className="f1tv-scroll flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-primary/80">
          {t.trackSettings}
        </div>
        <h2 className="text-lg font-bold leading-tight text-foreground">
          {t.displaySettings}
        </h2>
      </div>

      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t.layers}
        </div>
        <SettingRow
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t.viewModeSectors}
        >
          <Switch
            checked={viewMode === "sectors"}
            disabled={!sectorsAvailable}
            onCheckedChange={(v) => setViewMode(v ? "sectors" : "normal")}
          />
        </SettingRow>

        {environmentAvailable && (
          <SettingRow icon={<Flag className="h-3.5 w-3.5" />} label={t.diorama}>
            <Switch
              checked={environmentEnabled}
              onCheckedChange={setEnvironmentEnabled}
            />
          </SettingRow>
        )}

        {environmentAvailable && (
          <SettingRow icon={<Map className="h-3.5 w-3.5" />} label={t.terrain}>
            <Switch
              checked={environmentEnabled && environmentTerrain}
              disabled={!environmentEnabled}
              onCheckedChange={setEnvironmentTerrain}
            />
          </SettingRow>
        )}

        <SettingRow icon={<Mountain className="h-3.5 w-3.5" />} label={t.elevations}>
          <Switch
            checked={!terrainModeActive && elevationEnabled}
            disabled={terrainModeActive}
            onCheckedChange={setElevationEnabled}
          />
        </SettingRow>
        {terrainModeActive && (
          <p className="px-1 text-[10px] leading-snug text-muted-foreground">
            {t.elevationTerrainModeHint}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t.track}
        </div>

        <SettingRow
          icon={<Spline className="h-3.5 w-3.5" />}
          label={t.realWidth}
        >
          <Switch
            checked={realWidthActive}
            disabled={!realWidthAvailable}
            onCheckedChange={setRealWidthEnabled}
          />
        </SettingRow>

        {!realWidthAvailable && (
          <p className="px-1 text-[10px] leading-snug text-muted-foreground">
            {t.widthUnavailable}
          </p>
        )}

        <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="sidebar-track-width"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Ruler className="h-3.5 w-3.5" />
              {t.trackWidth}
            </Label>
            <span className="text-xs tabular-nums text-foreground">
              {realWidthActive && meanWidthMeters != null
                ? `~${meanWidthMeters}${t.unitM}`
                : `${trackWidth}${t.unitM}`}
            </span>
          </div>
          <input
            id="sidebar-track-width"
            type="range"
            min={3}
            max={15}
            step={1}
            value={trackWidth}
            disabled={realWidthActive}
            onChange={(event) => setTrackWidth(Number(event.target.value))}
            className="mt-3 h-1 w-full cursor-pointer accent-[#e10600] disabled:cursor-not-allowed disabled:opacity-40"
          />
          {realWidthActive && (
            <div className="mt-3 space-y-1.5">
              <div className="h-1.5 rounded-full bg-gradient-to-r from-amber-500 to-cyan-400" />
              <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
                <span>
                  {t.widthNarrow}: {minWidthMeters?.toFixed(1)}{t.unitM}
                </span>
                <span>
                  {t.widthWide}: {maxWidthMeters?.toFixed(1)}{t.unitM}
                </span>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {t.realWidthHint}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t.camera}
        </div>
        <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Camera className="h-3.5 w-3.5" />
            {t.camera}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1">
            {(["top", "iso", "side"] as CameraPreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onCameraPreset(preset)}
                className="rounded-md border border-border bg-background/40 px-2 py-1.5 text-xs text-foreground/80 hover:bg-accent hover:text-foreground"
              >
                {preset === "top"
                  ? t.cameraTop
                  : preset === "iso"
                    ? t.cameraIso
                    : t.cameraSide}
              </button>
            ))}
          </div>
        </div>

        <SettingRow icon={<RotateCw className="h-3.5 w-3.5" />} label={t.autoRotate}>
          <Switch checked={autoRotate} onCheckedChange={setAutoRotate} />
        </SettingRow>
      </section>
    </div>
  );
}
