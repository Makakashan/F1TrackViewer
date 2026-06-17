"use client";

import { useMemo } from "react";
import {
  Gauge,
  Mountain,
  CalendarDays,
  Flag,
  Ruler,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { type CircuitProperties } from "@/lib/f1-circuits";
import { elevationStats } from "@/lib/geo-utils";
import { useAppPref } from "@/components/app-pref-provider";

export interface TrackInfoProps {
  properties: CircuitProperties | null;
  loading?: boolean;
  pointCount?: number;
  elevations?: number[] | null;
  elevationEnabled?: boolean;
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
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
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

function ElevationSparkline({
  elevations,
  stats,
}: {
  elevations: number[];
  stats: ReturnType<typeof elevationStats>;
}) {
  const W = 280;
  const H = 80;
  const PAD = 6;

  const path = useMemo(() => {
    if (elevations.length < 2) return "";
    const min = stats.min;
    const max = stats.max;
    const span = Math.max(max - min, 1);
    const n = elevations.length;
    const samples = [...elevations, elevations[0]];
    const dx = (W - PAD * 2) / (samples.length - 1);
    return samples
      .map((e, i) => {
        const x = PAD + i * dx;
        const y = PAD + (H - PAD * 2) * (1 - (e - min) / span);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [elevations, stats]);

  const areaPath = path
    ? `${path} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`
    : "";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-20 w-full"
    >
      <defs>
        <linearGradient id="elev-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e10600" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#e10600" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {areaPath && <path d={areaPath} fill="url(#elev-grad)" stroke="none" />}
      {path && (
        <path
          d={path}
          fill="none"
          stroke="#e10600"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export default function TrackInfo({
  properties,
  loading,
  pointCount,
  elevations,
  elevationEnabled,
}: TrackInfoProps) {
  const { t } = useAppPref();

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
              : t.elevationLoading}
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
            {elevations === null ? t.elevationLoading : t.trackEmpty}
          </div>
        )}
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
