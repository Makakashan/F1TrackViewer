"use client";

import { useMemo } from "react";
import { Gauge, Mountain, CalendarDays, Flag, Ruler, TrendingUp, TrendingDown } from "lucide-react";
import { type CircuitProperties } from "@/lib/f1-circuits";
import { elevationStats } from "@/lib/geo-utils";

export interface TrackInfoProps {
  properties: CircuitProperties | null;
  loading?: boolean;
  pointCount?: number;
  /** Per-point elevations in meters (Open-Meteo). null while loading. */
  elevations?: number[] | null;
  /** Whether the 3D viewer is currently applying elevations to the curve. */
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
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-zinc-100 tabular-nums">
        {value}
        {unit && (
          <span className="ml-1 text-xs font-normal text-zinc-500">{unit}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Tiny SVG sparkline of the elevation profile. Width = 100% of container,
 * fixed height. The X axis is the sample index (proxy for distance along the
 * track), Y axis is elevation in meters.
 */
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
    // Close the loop visually by appending the first sample at the end.
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

  // Area under the curve for a nice filled look
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
          <stop offset="0%" stopColor="#ff4d4d" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ff4d4d" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {areaPath && <path d={areaPath} fill="url(#elev-grad)" stroke="none" />}
      {path && (
        <path
          d={path}
          fill="none"
          stroke="#ff4d4d"
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
  if (loading) {
    return (
      <div className="space-y-3 p-4">
        <div className="h-4 w-24 animate-pulse rounded bg-zinc-800" />
        <div className="h-8 w-full animate-pulse rounded bg-zinc-800" />
        <div className="grid grid-cols-2 gap-2">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded bg-zinc-800"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!properties) {
    return (
      <div className="p-4 text-sm text-zinc-500">
        Выберите трассу слева, чтобы увидеть метаданные.
      </div>
    );
  }

  const hasElev = !!elevations && elevations.length > 0;
  const stats = hasElev ? elevationStats(elevations!) : null;

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-red-500/80">
          Circuit
        </div>
        <h2 className="text-xl font-bold leading-tight text-white">
          {properties.Name}
        </h2>
        <p className="text-xs text-zinc-500">
          {properties.Location} · {properties.id}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat
          icon={<Ruler className="h-3 w-3" />}
          label="Длина"
          value={(properties.length / 1000).toFixed(3)}
          unit="км"
        />
        <Stat
          icon={<Gauge className="h-3 w-3" />}
          label="Высота (старт)"
          value={properties.altitude}
          unit="м"
        />
        <Stat
          icon={<CalendarDays className="h-3 w-3" />}
          label="Открыта"
          value={properties.opened}
        />
        <Stat
          icon={<Flag className="h-3 w-3" />}
          label="Первый ГП"
          value={properties.firstgp}
        />
      </div>

      {/* === Elevation profile === */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <Mountain className="h-3 w-3" />
            Профиль высот
          </div>
          <div className="text-[10px] text-zinc-500">
            {hasElev
              ? elevationEnabled
                ? "включён"
                : "выключен в viewer"
              : "загрузка…"}
          </div>
        </div>

        {hasElev && stats ? (
          <>
            <div className="mt-2">
              <ElevationSparkline elevations={elevations!} stats={stats} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div className="flex flex-col">
                <span className="text-zinc-500">min</span>
                <span className="font-semibold tabular-nums text-zinc-200">
                  {Math.round(stats.min)} м
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-zinc-500">max</span>
                <span className="font-semibold tabular-nums text-zinc-200">
                  {Math.round(stats.max)} м
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-zinc-500">перепад</span>
                <span className="font-semibold tabular-nums text-zinc-200">
                  {Math.round(stats.range)} м
                </span>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-zinc-800 pt-2 text-[11px]">
              <div className="flex items-center gap-1 text-emerald-400/80">
                <TrendingUp className="h-3 w-3" />
                подъём
                <span className="ml-1 font-semibold tabular-nums text-zinc-200">
                  {Math.round(stats.climb)} м
                </span>
              </div>
              <div className="flex items-center gap-1 text-sky-400/80">
                <TrendingDown className="h-3 w-3" />
                спуск
                <span className="ml-1 font-semibold tabular-nums text-zinc-200">
                  {Math.round(stats.descent)} м
                </span>
              </div>
            </div>
            <div className="mt-1 text-[10px] text-zinc-500">
              Источник: Open-Meteo Elevation API · SRTM-3 arcsec
            </div>
          </>
        ) : (
          <div className="mt-2 text-[11px] text-zinc-500">
            {elevations === null
              ? "Загрузка профиля высот…"
              : "Профиль недоступен"}
          </div>
        )}
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          Геометрия
        </div>
        <div className="mt-1 text-sm text-zinc-300">
          {pointCount ?? "—"} точек · LineString (замкнутая)
        </div>
        <div className="mt-1 text-[11px] text-zinc-500">
          Источник: bacinger/f1-circuits (MIT)
        </div>
      </div>

      <div className="mt-auto rounded-md border border-red-900/40 bg-gradient-to-br from-red-950/40 to-transparent px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-red-400/80">
          MVP 1 · Static viewer + elevation
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
          Трасса построена из GeoJSON LineString через CatmullRomCurve3 +
          TubeGeometry. Высоты подгружаются из Open-Meteo и применяются к
          Y-координатам curve с усилением ×N.
        </p>
      </div>
    </div>
  );
}
