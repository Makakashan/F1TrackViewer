"use client";

import dynamic from "next/dynamic";
import { Activity, Boxes, Layers, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  carModelUrl,
  fetchCarLibrary,
  formatBytes,
  formatCount,
  type CarModelEntry,
} from "@/lib/car-library";
import { GRID_SIZE, TEAMS_2025 } from "@/lib/f1-teams";
import type { CarFleetStats } from "@/components/three/car-fleet";
import { cn } from "@/lib/utils";

const FleetViewport = dynamic(() => import("./fleet-viewport"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#111318] text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      <span className="font-mono text-xs uppercase tracking-widest">
        Loading viewport
      </span>
    </div>
  ),
});

/**
 * Where a grid stops being a rendering question and becomes a hardware one.
 * Roughly a million triangles: comfortable on a discrete GPU, already heavy on
 * integrated graphics, and the point at which the base model needs simplifying
 * rather than the renderer needing tuning.
 */
const TRIANGLE_WARNING = 1_000_000;

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-card/60 px-3 py-2.5">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[15px] font-semibold tabular-nums leading-none",
          accent ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[10.5px] leading-tight text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}

export default function FleetLab() {
  const [models, setModels] = useState<CarModelEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Opens small on purpose. The base models are full-detail — 227k triangles
  // each — so a tab that defaulted to a twenty-car grid would put four and a
  // half million triangles on screen the instant it was clicked, which is
  // enough to hang a GPU rather than merely run slowly. Raise it deliberately.
  const [count, setCount] = useState(4);
  const [stats, setStats] = useState<CarFleetStats | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchCarLibrary().then((library) => {
      if (cancelled) return;
      setModels(library.models);
      setSelectedId(
        (current) =>
          current ??
          // Prefer a painted team car: the runtime overrides bodywork and rims
          // only, so everything else keeps whatever the base model was built
          // with. An unpainted base would give twenty cars with white floors.
          library.models.find((model) => model.id.startsWith("f1_"))?.id ??
          library.models[0]?.id ??
          null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => models?.find((model) => model.id === selectedId) ?? null,
    [models, selectedId],
  );

  const handleStats = useCallback((next: CarFleetStats) => setStats(next), []);
  const handleFps = useCallback((next: number) => setFps(next), []);

  const totalTriangles = stats ? stats.trianglesPerCar * count : 0;
  // What the same fleet would cost drawn as individual scene graphs — the
  // number this whole approach exists to avoid.
  const naiveDrawCalls = stats ? stats.drawCalls * count : 0;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-card/40 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Base model
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            One geometry, tinted per team at runtime.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {models === null && (
            <p className="px-2 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Reading manifest…
            </p>
          )}
          <ul className="space-y-1">
            {models?.map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(model.id)}
                  className={cn(
                    "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                    model.id === selectedId
                      ? "border-primary/50 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-accent/50",
                  )}
                >
                  <span className="block truncate text-[12.5px] font-medium text-foreground">
                    {model.name}
                  </span>
                  <span className="mt-1 block font-mono text-[10px] tabular-nums text-muted-foreground">
                    {formatBytes(model.gzipBytes || model.bytes)} gz
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-border px-4 py-3">
          <label
            htmlFor="fleet-count"
            className="flex items-baseline justify-between font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground"
          >
            <span>Cars</span>
            <span className="text-[13px] font-semibold tabular-nums text-foreground">
              {count}
            </span>
          </label>
          <input
            id="fleet-count"
            type="range"
            min={1}
            max={GRID_SIZE}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
            className="mt-2 w-full accent-[var(--primary)]"
          />
          {totalTriangles > TRIANGLE_WARNING && (
            <p className="mt-2 rounded border border-primary/40 bg-primary/5 px-2 py-1.5 text-[10.5px] leading-tight text-foreground">
              {formatCount(totalTriangles)} triangles. This base model is
              full-detail; a grid this size needs a simplified one.
            </p>
          )}
        </div>
      </aside>

      <div className="relative min-h-[320px] flex-1 bg-[#111318]">
        {selected ? (
          <>
            <FleetViewport
              url={carModelUrl(selected)}
              count={count}
              onStats={handleStats}
              onFps={handleFps}
            />
            <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/45 px-3 py-1.5 backdrop-blur-sm">
              <div className="text-[12.5px] font-semibold leading-none text-white">
                {count} car{count === 1 ? "" : "s"} · {stats?.drawCalls ?? "—"}{" "}
                draw calls
              </div>
              <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/50">
                {selected.name}
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-white/10 bg-black/45 px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45 backdrop-blur-sm">
              LMB rotate · RMB pan · wheel zoom
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="font-mono text-[11px] uppercase tracking-widest text-white/40">
              {models === null ? "Loading…" : "No model"}
            </p>
          </div>
        )}
      </div>

      <aside className="min-h-0 shrink-0 overflow-y-auto border-t border-border bg-card/40 lg:w-80 lg:border-l lg:border-t-0">
        <div className="space-y-5 p-4">
          <section>
            <div className="mb-2.5 flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-primary" />
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Cost
              </h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Metric
                label="Draw calls"
                value={formatCount(stats?.drawCalls ?? 0)}
                hint="whole fleet"
                accent
              />
              <Metric
                label="Frame rate"
                value={fps ? `${fps} fps` : "—"}
                hint={`${count} cars`}
              />
              <Metric
                label="Triangles"
                value={formatCount(totalTriangles)}
                hint={`${formatCount(stats?.trianglesPerCar ?? 0)} per car`}
              />
              <Metric
                label="Without instancing"
                value={formatCount(naiveDrawCalls)}
                hint="draw calls avoided"
              />
            </div>
          </section>

          <section>
            <div className="mb-2.5 flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-primary" />
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Grid
              </h3>
            </div>
            <ul className="grid grid-cols-2 gap-1">
              {TEAMS_2025.map((team) => (
                <li
                  key={team.id}
                  className="flex items-center gap-2 rounded-md border border-border/70 bg-card/60 px-2 py-1.5"
                >
                  <span className="flex shrink-0 overflow-hidden rounded border border-border">
                    <span
                      className="h-4 w-4"
                      style={{ background: team.livery.body }}
                    />
                    <span
                      className="h-4 w-2"
                      style={{ background: team.livery.accent }}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                    {team.name}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {stats && (
            <section>
              <div className="mb-2.5 flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-primary" />
                <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Parts
                </h3>
                <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                  {stats.parts.length}
                </span>
              </div>
              <ul className="space-y-1">
                {stats.parts.map((part) => (
                  <li
                    key={part.name}
                    className="flex items-center gap-2 rounded-md border border-border/70 bg-card/60 px-2.5 py-1.5"
                  >
                    <Boxes className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                      {part.name}
                    </span>
                    {part.slot && (
                      <span className="shrink-0 rounded border border-primary/40 px-1 font-mono text-[8.5px] uppercase tracking-wider text-primary">
                        {part.slot}
                      </span>
                    )}
                    <span className="w-16 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
                      {formatCount(part.triangles)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
