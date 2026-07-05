"use client";

import {
  Gauge,
  Mountain,
  CalendarDays,
  Flag,
  Ruler,
  TrendingUp,
  TrendingDown,
  Layers,
  Spline,
} from "lucide-react";
import { type CircuitProperties } from "@/lib/f1-circuits";
import { elevationStats } from "@/lib/elevation";
import { useAppPref } from "@/components/app-pref-provider";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";
import ElevationSparkline from "@/components/elevation-sparkline";

export interface TrackInfoProps {
  properties: CircuitProperties | null;
  loading?: boolean;
  pointCount?: number;
  elevations?: number[] | null;
  elevationEnabled?: boolean;
  markers?: TrackMarkers | null;
  viewMode?: TrackViewMode;
  trackWidth?: number;
  realWidthAvailable?: boolean;
  realWidthEnabled?: boolean;
  meanWidthMeters?: number | null;
  minWidthMeters?: number | null;
  maxWidthMeters?: number | null;
}

function Stat({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  unit?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 whitespace-nowrap text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">
        {value}
        {unit && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

export default function TrackInfo({
  properties,
  loading,
  pointCount,
  elevations,
  elevationEnabled,
  markers,
  viewMode = "normal",
  trackWidth = 7,
  realWidthAvailable = false,
  realWidthEnabled = false,
  meanWidthMeters,
  minWidthMeters,
  maxWidthMeters,
}: TrackInfoProps) {
  const { t } = useAppPref();
  const realWidthActive =
    realWidthAvailable && realWidthEnabled && meanWidthMeters != null;

  if (loading) {
    return (
      <div className="space-y-3 p-4">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-2 gap-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (!properties) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t.selectTrackHint}
      </div>
    );
  }

  const hasElev = !!elevations && elevations.length > 0;
  const stats = hasElev ? elevationStats(elevations!) : null;

  return (
    <div className="f1tv-scroll flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-primary/80">
          {t.circuit}
        </div>
        <h2 className="text-xl font-bold leading-tight text-foreground">
          {properties.Name}
        </h2>
        <p className="text-xs text-muted-foreground">
          {properties.Location} · {properties.id}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat
          icon={<Ruler className="h-3 w-3" />}
          label={t.length}
          value={(properties.length / 1000).toFixed(3)}
          unit={t.unitKm}
        />
        <Stat
          icon={<Gauge className="h-3 w-3" />}
          label={t.altitudeStart}
          value={properties.altitude}
          unit={t.unitM}
        />
        <Stat
          icon={<CalendarDays className="h-3 w-3" />}
          label={t.opened}
          value={properties.opened}
        />
        <Stat
          icon={<Flag className="h-3 w-3" />}
          label={t.firstGp}
          value={properties.firstgp}
        />
      </div>

      {/* Sector splits info */}
      {markers?.sectors?.length ? (
        <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Layers className="h-3 w-3" />
            {t.sectorLegend}
          </div>
          <div className="mt-2 space-y-1.5">
            {markers.sectors.map((sector) => {
              const fromKm = (sector.fromDistance / 1000).toFixed(2);
              const toKm = (sector.toDistance / 1000).toFixed(2);
              const len = sector.toDistance - sector.fromDistance;
              const lenKm = (len / 1000).toFixed(2);
              return (
                <div key={sector.id} className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-sm shrink-0"
                    style={{ backgroundColor: sector.color }}
                  />
                  <span className="text-[11px] font-medium text-foreground">
                    {t.sectorN(sector.id)}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {fromKm}–{toKm} {t.unitKm} ({lenKm} {t.unitKm})
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground/70">
            {markers.source === "fastf1-telemetry-derived"
              ? t.sectorSourceFastf1
              : markers.source === "equal-thirds"
                ? t.sectorSourceManual
                : markers.source === "manual"
                  ? t.sectorSourceManual
                  : t.sectorSourceEstimated}
            {markers.year ? ` · ${markers.year}` : ""}
            {markers.session ? ` ${markers.session}` : ""}
            {markers.driver ? ` · ${markers.driver}` : ""}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Layers className="h-3 w-3" />
            {t.sectorLegend}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t.sectorUnavailable}
          </div>
        </div>
      )}

      <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Mountain className="h-3 w-3" />
            {t.elevationProfile}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {hasElev
              ? elevationEnabled
                ? t.elevationOn
                : t.elevationOff
              : elevations === null
                ? t.elevationLoading
                : t.elevationUnavailable}
          </div>
        </div>

        {hasElev && stats ? (
          <>
            <div className="mt-2">
              <ElevationSparkline elevations={elevations!} stats={stats} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div className="flex flex-col">
                <span className="text-muted-foreground">{t.elevationMin}</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {Math.round(stats.min)} {t.unitM}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-muted-foreground">{t.elevationMax}</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {Math.round(stats.max)} {t.unitM}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-muted-foreground">{t.elevationRange}</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {Math.round(stats.range)} {t.unitM}
                </span>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-[11px]">
              <div className="flex items-center gap-1 text-emerald-500/80">
                <TrendingUp className="h-3 w-3" />
                {t.climb}
                <span className="ml-1 font-semibold tabular-nums text-foreground">
                  {Math.round(stats.climb)} {t.unitM}
                </span>
              </div>
              <div className="flex items-center gap-1 text-sky-500/80">
                <TrendingDown className="h-3 w-3" />
                {t.descent}
                <span className="ml-1 font-semibold tabular-nums text-foreground">
                  {Math.round(stats.descent)} {t.unitM}
                </span>
              </div>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {t.elevationSource}
            </div>
          </>
        ) : (
          <div className="mt-2 text-[11px] text-muted-foreground">
            {elevations === null ? t.elevationLoading : t.elevationUnavailable}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Spline className="h-3 w-3" />
          {t.widthTitle}
        </div>
        <div className="mt-1 text-sm text-foreground">
          {realWidthActive
            ? t.widthRealValue(
                meanWidthMeters!,
                minWidthMeters ?? meanWidthMeters!,
                maxWidthMeters ?? meanWidthMeters!,
              )
            : t.widthUniformValue(trackWidth * 2)}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {realWidthActive
            ? t.widthRealSource
            : realWidthAvailable
              ? t.realWidthHint
              : t.widthUnavailable}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t.geometry}
        </div>
        <div className="mt-1 text-sm text-foreground">
          {pointCount != null ? t.geometryDesc(pointCount) : t.trackEmpty}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t.geoSource}
        </div>
      </div>

      <div className="mt-auto rounded-md border border-primary/40 bg-gradient-to-br from-primary/10 to-transparent px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-primary/80">
          {t.mvpBadge}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t.mvpDesc}
        </p>
      </div>
    </div>
  );
}
