"use client";

import {
  Camera,
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
import { cn } from "@/lib/utils";
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
  muted = false,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2.5",
        muted && "opacity-60",
      )}
    >
      <Label className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </Label>
      {children}
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
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
      <SettingsSection title={t.layers}>
        <SettingRow
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t.viewModeSectors}
          muted={!sectorsAvailable}
        >
          <Switch
            checked={viewMode === "sectors"}
            disabled={!sectorsAvailable}
            onCheckedChange={(v) => setViewMode(v ? "sectors" : "normal")}
          />
        </SettingRow>

        {environmentAvailable && (
          <SettingRow icon={<Map className="h-3.5 w-3.5" />} label={t.terrain}>
            <Switch
              checked={environmentEnabled && environmentTerrain}
              onCheckedChange={(enabled) => {
                setEnvironmentEnabled(enabled);
                setEnvironmentTerrain(enabled);
              }}
            />
          </SettingRow>
        )}

        <SettingRow
          icon={<Mountain className="h-3.5 w-3.5" />}
          label={t.elevations}
          muted={terrainModeActive}
        >
          <Switch
            checked={!terrainModeActive && elevationEnabled}
            disabled={terrainModeActive}
            onCheckedChange={setElevationEnabled}
          />
        </SettingRow>
        {terrainModeActive && (
          <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            {t.elevationTerrainModeHint}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t.track}>
        <SettingRow
          icon={<Spline className="h-3.5 w-3.5" />}
          label={t.realWidth}
          muted={!realWidthAvailable}
        >
          <Switch
            checked={realWidthActive}
            disabled={!realWidthAvailable}
            onCheckedChange={setRealWidthEnabled}
          />
        </SettingRow>

        {!realWidthAvailable && (
          <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            {t.widthUnavailable}
          </div>
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
            className="mt-4 h-1 w-full cursor-pointer accent-[#e10600] disabled:cursor-not-allowed disabled:opacity-40"
          />
          {realWidthActive && (
            <div className="mt-3 space-y-1.5">
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
      </SettingsSection>

      <SettingsSection title={t.camera}>
        <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Camera className="h-3.5 w-3.5" />
            {t.camera}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-border bg-background/30 p-1">
            {(["top", "iso", "side"] as CameraPreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onCameraPreset(preset)}
                className="rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          <Switch
            checked={autoRotate}
            onCheckedChange={setAutoRotate}
          />
        </SettingRow>
      </SettingsSection>

      <div className="mt-auto h-6" />
    </div>
  );
}
