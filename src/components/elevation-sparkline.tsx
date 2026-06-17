"use client";

import { useMemo } from "react";
import { elevationStats } from "@/lib/elevation";

interface ElevationSparklineProps {
  elevations: number[];
  stats: ReturnType<typeof elevationStats>;
}

export default function ElevationSparkline({
  elevations,
  stats,
}: ElevationSparklineProps) {
  const W = 280;
  const H = 80;
  const PAD = 6;

  const path = useMemo(() => {
    if (elevations.length < 2) return "";
    const min = stats.min;
    const max = stats.max;
    const span = Math.max(max - min, 1);
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
