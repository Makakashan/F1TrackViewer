"use client";

import { Gauge, Mountain, CalendarDays, Flag, Ruler } from "lucide-react";
import { type CircuitProperties } from "@/lib/f1-circuits";

export interface TrackInfoProps {
  properties: CircuitProperties | null;
  loading?: boolean;
  pointCount?: number;
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

export default function TrackInfo({
  properties,
  loading,
  pointCount,
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
          label="Высота"
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
          MVP 1 · Static viewer
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
          Трасса построена из GeoJSON LineString через CatmullRomCurve3 +
          TubeGeometry. Крути мышкой — OrbitControls включён.
        </p>
      </div>
    </div>
  );
}
