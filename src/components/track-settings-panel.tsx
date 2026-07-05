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
        "group flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-white/20 hover:bg-white/[0.055]",
        muted && "opacity-60",
      )}
    >
      <Label className="flex items-center gap-2 text-xs text-muted-foreground transition-colors group-hover:text-foreground/80">
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
    <section className="rounded-xl border border-white/10 bg-black/[0.16] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function StatusChip({
  active,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-1 text-[10px] font-medium leading-none",
        active
          ? "border-primary/40 bg-primary/15 text-primary shadow-[0_0_18px_rgba(225,6,0,0.16)]"
          : "border-white/10 bg-white/[0.04] text-muted-foreground",
      )}
    >
      {children}
    </span>
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
    <div className="f1tv-scroll flex h-full flex-col gap-4 overflow-y-auto bg-[radial-gradient(circle_at_top_right,rgba(225,6,0,0.11),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.045),transparent_22%)] p-4">
      <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_18px_50px_rgba(0,0,0,0.18)]">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
            {t.trackSettings}
          </div>
          <h2 className="text-lg font-bold leading-tight text-foreground">
            {t.displaySettings}
          </h2>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <StatusChip active={viewMode === "sectors"}>{t.viewModeSectors}</StatusChip>
          <StatusChip active={terrainModeActive}>{t.terrain}</StatusChip>
          <StatusChip active={realWidthActive}>{t.realWidth}</StatusChip>
          <StatusChip>{`${realWidthActive && meanWidthMeters != null ? `~${meanWidthMeters}` : trackWidth}${t.unitM}`}</StatusChip>
        </div>
      </div>

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
            className="data-[state=checked]:shadow-[0_0_18px_rgba(225,6,0,0.38)]"
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
              className="data-[state=checked]:shadow-[0_0_18px_rgba(225,6,0,0.38)]"
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
            className="data-[state=checked]:shadow-[0_0_18px_rgba(225,6,0,0.38)]"
          />
        </SettingRow>
        {terrainModeActive && (
          <div className="rounded-lg border border-amber-400/10 bg-amber-400/[0.035] px-3 py-2 text-[10px] leading-snug text-muted-foreground">
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
            className="data-[state=checked]:shadow-[0_0_18px_rgba(225,6,0,0.38)]"
          />
        </SettingRow>

        {!realWidthAvailable && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[10px] leading-snug text-muted-foreground">
            {t.widthUnavailable}
          </div>
        )}

        <div className="rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="sidebar-track-width"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Ruler className="h-3.5 w-3.5" />
              {t.trackWidth}
            </Label>
            <span className="rounded-full border border-white/10 bg-black/30 px-2 py-1 text-[10px] font-semibold tabular-nums text-foreground">
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
              <div className="h-1.5 rounded-full bg-gradient-to-r from-red-600 via-amber-500 to-cyan-400 shadow-[0_0_18px_rgba(225,6,0,0.18)]" />
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
        <div className="rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Camera className="h-3.5 w-3.5" />
            {t.camera}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/25 p-1">
            {(["top", "iso", "side"] as CameraPreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onCameraPreset(preset)}
                className="rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="data-[state=checked]:shadow-[0_0_18px_rgba(225,6,0,0.38)]"
          />
        </SettingRow>
      </SettingsSection>

      <div className="mt-auto h-6" />
    </div>
  );
}
