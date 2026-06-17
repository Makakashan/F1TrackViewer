"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, RefreshCw, RotateCw, Flag, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import CircuitList from "@/components/circuit-list";
import TrackInfo from "@/components/track-info";
import {
  fetchCircuitIndex,
  fetchCircuitGeoJson,
  type CircuitLocation,
  type CircuitGeoJSON,
  type CircuitProperties,
} from "@/lib/f1-circuits";
import { fetchElevations } from "@/lib/geo-utils";

// Three.js scene must be client-only — no SSR for WebGL.
const TrackViewer = dynamic(() => import("@/components/track-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-500">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      Загрузка Three.js…
    </div>
  ),
});

export default function Home() {
  const [circuits, setCircuits] = useState<CircuitLocation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geojson, setGeojson] = useState<CircuitGeoJSON | null>(null);
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [loadingTrack, setLoadingTrack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [trackWidth, setTrackWidth] = useState(8);
  const [elevations, setElevations] = useState<number[] | null>(null);
  const [loadingElevations, setLoadingElevations] = useState(false);
  const [elevationEnabled, setElevationEnabled] = useState(true);
  const [elevationScale, setElevationScale] = useState(3);

  // Load circuit index once on mount.
  useEffect(() => {
    let cancelled = false;
    fetchCircuitIndex()
      .then((list) => {
        if (cancelled) return;
        // Sort by circuit name for predictable browsing
        list.sort((a, b) => a.name.localeCompare(b.name));
        setCircuits(list);
        // Auto-select Monaco for the very first impression — it's iconic and short
        const initial =
          list.find((c) => c.id === "mc-1929") ?? list[0] ?? null;
        if (initial) setSelectedId(initial.id);
      })
      .catch((e) => {
        if (!cancelled)
          setError(`Не удалось загрузить список трасс: ${String(e)}`);
      })
      .finally(() => !cancelled && setLoadingIndex(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the selected circuit's GeoJSON + elevation profile in parallel.
  // Both are independent requests, so we kick them off together and let them
  // settle on their own — the 3D viewer renders as soon as the GeoJSON lands,
  // then re-builds the curve when elevations arrive.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingTrack(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingElevations(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);

    fetchCircuitGeoJson(selectedId)
      .then((g) => {
        if (cancelled) return;
        setGeojson(g);
        // After GeoJSON is in hand, fetch elevations for its coordinates.
        // We do this in a chained .then() (rather than Promise.all) so the
        // 3D viewer can render the flat track immediately while elevation
        // data trickles in.
        const coords = g.features[0]?.geometry.coordinates ?? [];
        return fetchElevations(coords);
      })
      .then((e) => {
        if (cancelled) return;
        setElevations(e);
      })
      .catch((e) => {
        if (!cancelled)
          setError(`Не удалось загрузить трассу ${selectedId}: ${String(e)}`);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingTrack(false);
        setLoadingElevations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  const handleReload = useCallback(() => {
    if (selectedId) setSelectedId(null);
    requestAnimationFrame(() => setSelectedId(selectedId));
  }, [selectedId]);

  const properties: CircuitProperties | null =
    geojson?.features[0]?.properties ?? null;
  const pointCount = geojson?.features[0]?.geometry.coordinates.length;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      {/* === Top bar === */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-red-600 to-orange-600 shadow-[0_0_20px_rgba(255,30,30,0.4)]">
              <Flag className="h-4 w-4 text-white" />
            </div>
            <div className="leading-none">
              <div className="text-sm font-bold tracking-tight">
                F1 Track Studio
              </div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                3D Circuit Viewer · MVP 1
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 text-xs text-zinc-400 md:flex">
            <div className="flex items-center gap-2">
              <Switch
                id="autorotate"
                checked={autoRotate}
                onCheckedChange={setAutoRotate}
              />
              <Label htmlFor="autorotate" className="cursor-pointer">
                <RotateCw className="mr-1 inline h-3 w-3" />
                Auto-rotate
              </Label>
            </div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <Switch
                id="elevation"
                checked={elevationEnabled}
                onCheckedChange={setElevationEnabled}
              />
              <Label htmlFor="elevation" className="cursor-pointer">
                <Mountain className="mr-1 inline h-3 w-3" />
                Высоты
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="elevscale" className="text-zinc-500">
                ×
              </Label>
              <input
                id="elevscale"
                type="range"
                min={1}
                max={8}
                step={1}
                value={elevationScale}
                onChange={(e) => setElevationScale(Number(e.target.value))}
                className="h-1 w-20 cursor-pointer accent-red-600"
              />
              <span className="w-6 tabular-nums text-zinc-300">
                {elevationScale}
              </span>
            </div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <Label htmlFor="width" className="text-zinc-400">
                Ширина
              </Label>
              <input
                id="width"
                type="range"
                min={3}
                max={20}
                step={1}
                value={trackWidth}
                onChange={(e) => setTrackWidth(Number(e.target.value))}
                className="h-1 w-20 cursor-pointer accent-red-600"
              />
              <span className="w-10 tabular-nums text-zinc-300">
                {trackWidth}м
              </span>
            </div>
          </div>
          <Separator orientation="vertical" className="h-5" />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReload}
            disabled={!selectedId || loadingTrack}
            className="text-zinc-400 hover:text-zinc-100"
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${loadingTrack ? "animate-spin" : ""}`}
            />
            Reload
          </Button>
        </div>
      </header>

      {/* === Main 3-column layout === */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)_320px]">
        {/* Left: circuit list */}
        <aside className="hidden min-h-0 border-r border-zinc-800 bg-zinc-950/50 md:block">
          {loadingIndex ? (
            <div className="space-y-2 p-4">
              <div className="h-3 w-16 animate-pulse rounded bg-zinc-800" />
              <div className="h-9 w-full animate-pulse rounded bg-zinc-800" />
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="h-12 w-full animate-pulse rounded bg-zinc-900"
                />
              ))}
            </div>
          ) : (
            <CircuitList
              circuits={circuits}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          )}
        </aside>

        {/* Center: 3D viewer */}
        <main className="relative min-h-0 bg-zinc-950">
          {error && (
            <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-red-900/60 bg-red-950/80 px-4 py-2 text-xs text-red-200 backdrop-blur">
              {error}
            </div>
          )}
          {geojson ? (
            <TrackViewer
              key={`${selectedId}-${trackWidth}-${elevationEnabled}-${elevationScale}-${elevations?.length ?? 0}`}
              geojson={geojson}
              elevations={elevationEnabled ? elevations : null}
              elevationScale={elevationScale}
              trackWidth={trackWidth}
              autoRotate={autoRotate}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-zinc-500">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {loadingTrack ? "Загрузка трассы…" : "Выберите трассу"}
            </div>
          )}

          {/* Track name overlay (bottom-left) */}
          {properties && (
            <div className="pointer-events-none absolute bottom-4 left-4 z-10">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-red-500/80">
                <ChevronRight className="h-3 w-3" />
                Now viewing
              </div>
              <div className="mt-0.5 text-2xl font-bold text-white drop-shadow-lg">
                {properties.Name}
              </div>
              <div className="text-xs text-zinc-400">
                {properties.Location} · {(properties.length / 1000).toFixed(3)}{" "}
                км · opened {properties.opened}
              </div>
              {loadingElevations && (
                <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-400/80">
                  <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                  Загрузка профиля высот (Open-Meteo)…
                </div>
              )}
            </div>
          )}

          {/* Controls hint (bottom-right) */}
          <div className="pointer-events-none absolute bottom-4 right-4 z-10 rounded-md border border-zinc-800/80 bg-zinc-950/70 px-3 py-2 text-[10px] text-zinc-500 backdrop-blur">
            <div>
              <span className="text-zinc-300">ЛКМ</span> — вращать
            </div>
            <div>
              <span className="text-zinc-300">ПКМ</span> — панорамировать
            </div>
            <div>
              <span className="text-zinc-300">Колесо</span> — зум
            </div>
          </div>
        </main>

        {/* Right: track info */}
        <aside className="hidden min-h-0 border-l border-zinc-800 bg-zinc-950/50 md:block">
          <TrackInfo
            properties={properties}
            loading={loadingTrack}
            pointCount={pointCount}
            elevations={elevations}
            elevationEnabled={elevationEnabled}
          />
        </aside>
      </div>
    </div>
  );
}
