"use client";

import dynamic from "next/dynamic";
import {
  Box,
  Boxes,
  Grid3x3,
  Image as ImageIcon,
  Layers,
  Maximize2,
  Palette,
  PlayCircle,
  RefreshCw,
  RotateCw,
  Ruler,
  Triangle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  carModelUrl,
  fetchCarLibrary,
  formatBytes,
  formatCount,
  type CarModelEntry,
} from "@/lib/car-library";
import { REFERENCE_CAR_LENGTH, type GltfStats } from "@/lib/gltf-stats";
import { cn } from "@/lib/utils";

const ModelViewer = dynamic(() => import("./model-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#111318] text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      <span className="font-mono text-xs uppercase tracking-widest">
        Loading viewer
      </span>
    </div>
  ),
});

/**
 * Models arrive authored in metres, centimetres or arbitrary units, so a fixed
 * two decimals renders a 0.0234-unit car as "0.02" — three identical-looking
 * numbers that say nothing. Precision follows magnitude instead.
 */
function formatUnit(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  if (magnitude >= 0.01) return value.toFixed(4);
  return value.toExponential(2);
}

// ── Small presentational pieces ─────────────────────────────────────

function SectionHeading({
  icon,
  children,
  trailing,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="text-primary">{icon}</span>
      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {children}
      </h3>
      {trailing && <span className="ml-auto">{trailing}</span>}
    </div>
  );
}

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

function ToolbarToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-white/10 bg-black/40 text-white/60 hover:border-white/25 hover:text-white/90",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// ── Stats panel ─────────────────────────────────────────────────────

function StatsPanel({
  entry,
  stats,
}: {
  entry: CarModelEntry;
  stats: GltfStats | null;
}) {
  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Reading model…
        </p>
      </div>
    );
  }

  const { footprint } = stats;
  const normalized = {
    length: footprint.length * stats.scaleToReference,
    width: footprint.width * stats.scaleToReference,
    height: footprint.height * stats.scaleToReference,
  };

  return (
    <div className="space-y-5 p-4">
      <section>
        <SectionHeading icon={<Boxes className="h-3.5 w-3.5" />}>
          Payload
        </SectionHeading>
        <div className="grid grid-cols-2 gap-2">
          {/* Judged on the gzipped size, not the file on disk: that is what a
              visitor actually downloads. */}
          <Metric
            label="Over the wire"
            value={formatBytes(entry.gzipBytes || entry.bytes)}
            accent={(entry.gzipBytes || entry.bytes) > 6 * 1024 * 1024}
            hint={`${formatBytes(entry.bytes)} on disk${
              (entry.gzipBytes || entry.bytes) > 6 * 1024 * 1024
                ? " · heavy"
                : ""
            }`}
          />
          <Metric
            label="Texture VRAM"
            value={formatBytes(stats.textureBytes)}
            hint={`${stats.textures.length} texture${stats.textures.length === 1 ? "" : "s"}, RGBA + mips`}
          />
        </div>
      </section>

      <section>
        <SectionHeading icon={<Triangle className="h-3.5 w-3.5" />}>
          Geometry
        </SectionHeading>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Triangles" value={formatCount(stats.triangles)} />
          <Metric label="Vertices" value={formatCount(stats.vertices)} />
          <Metric
            label="Draw calls"
            value={formatCount(stats.drawCalls)}
            hint={`${stats.meshes} mesh${stats.meshes === 1 ? "" : "es"}`}
          />
          <Metric label="Nodes" value={formatCount(stats.nodes)} />
        </div>
      </section>

      <section>
        <SectionHeading icon={<Ruler className="h-3.5 w-3.5" />}>
          Dimensions
        </SectionHeading>
        <div className="space-y-2">
          <div className="rounded-md border border-border/70 bg-card/60 px-3 py-2.5">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              Source units (L × W × H)
            </div>
            <div className="mt-1 font-mono text-[13px] font-semibold tabular-nums text-foreground">
              {formatUnit(footprint.length)} × {formatUnit(footprint.width)} ×{" "}
              {formatUnit(footprint.height)}
            </div>
          </div>
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              Scaled to {REFERENCE_CAR_LENGTH} m car
            </div>
            <div className="mt-1 font-mono text-[13px] font-semibold tabular-nums text-foreground">
              {normalized.length.toFixed(2)} × {normalized.width.toFixed(2)} ×{" "}
              {normalized.height.toFixed(2)} m
            </div>
            <div className="mt-1 text-[10.5px] leading-tight text-muted-foreground">
              Factor ×{stats.scaleToReference.toFixed(4)} — a real car is about
              2.0 m wide and 0.95 m tall.
            </div>
          </div>
        </div>
      </section>

      <section>
        <SectionHeading
          icon={<Palette className="h-3.5 w-3.5" />}
          trailing={
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {stats.materials.length}
            </span>
          }
        >
          Materials
        </SectionHeading>
        <ul className="space-y-1">
          {stats.materials.map((material, index) => (
            <li
              key={`${material.name}-${index}`}
              className="flex items-center gap-2.5 rounded-md border border-border/70 bg-card/60 px-2.5 py-1.5"
            >
              {/* Border is a theme token, not white: most car materials are
                  near-white, and a white-on-white swatch reads as missing. */}
              <span
                className="h-5 w-5 shrink-0 rounded border border-border"
                style={{ background: material.color ?? "transparent" }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-medium text-foreground">
                  {material.name}
                </span>
                <span className="block truncate font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  {material.maps.length
                    ? material.maps.join(" · ")
                    : "no textures"}
                </span>
              </span>
              {material.metalness !== null && material.roughness !== null && (
                <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  M{material.metalness.toFixed(2)} R
                  {material.roughness.toFixed(2)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {stats.textures.length > 0 && (
        <section>
          <SectionHeading
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            trailing={
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatBytes(stats.textureBytes)}
              </span>
            }
          >
            Textures
          </SectionHeading>
          <ul className="space-y-1">
            {stats.textures.map((texture, index) => (
              <li
                key={`${texture.name}-${index}`}
                className="flex items-center gap-2 rounded-md border border-border/70 bg-card/60 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                  {texture.name}
                </span>
                <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  {texture.width}×{texture.height}
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  {formatBytes(texture.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats.animations.length > 0 && (
        <section>
          <SectionHeading icon={<PlayCircle className="h-3.5 w-3.5" />}>
            Animations
          </SectionHeading>
          <ul className="space-y-1">
            {stats.animations.map((clip, index) => (
              <li
                key={`${clip.name}-${index}`}
                className="flex items-center justify-between rounded-md border border-border/70 bg-card/60 px-2.5 py-1.5"
              >
                <span className="truncate text-[11.5px] text-foreground">
                  {clip.name || `clip ${index + 1}`}
                </span>
                <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  {clip.duration.toFixed(2)}s
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── Screen ──────────────────────────────────────────────────────────

export default function CarModelLab() {
  const [models, setModels] = useState<CarModelEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [measured, setMeasured] = useState<{
    id: string;
    stats: GltfStats;
  } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [normalize, setNormalize] = useState(true);
  const [showGrid, setShowGrid] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchCarLibrary().then((library) => {
      if (cancelled) return;
      setModels(library.models);
      setSelectedId((current) => current ?? library.models[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => models?.find((model) => model.id === selectedId) ?? null,
    [models, selectedId],
  );

  // Stats are tagged with the model that produced them and matched against the
  // current selection, rather than cleared on change. While the next model is
  // still downloading the ids disagree and the panel reads as "measuring",
  // so the previous car's numbers can never be shown under a new car's name.
  const handleStats = useCallback(
    (next: GltfStats) => {
      if (selectedId) setMeasured({ id: selectedId, stats: next });
    },
    [selectedId],
  );

  const stats = measured?.id === selectedId ? measured.stats : null;

  const totalBytes = useMemo(
    () =>
      (models ?? []).reduce(
        (sum, model) => sum + (model.gzipBytes || model.bytes),
        0,
      ),
    [models],
  );

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Library rail */}
      <aside className="flex shrink-0 flex-col border-b border-border bg-card/40 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Library
          </h2>
          <p className="mt-1 font-mono text-[11px] tabular-nums text-foreground">
            {models?.length ?? 0} model{models?.length === 1 ? "" : "s"}
            <span className="text-muted-foreground">
              {" · "}
              {formatBytes(totalBytes)}
            </span>
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {models === null && (
            <p className="px-2 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Reading manifest…
            </p>
          )}

          {models?.length === 0 && (
            <div className="px-2 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
              <p className="mb-2 font-medium text-foreground">No models yet.</p>
              <p>
                Drop a <code className="font-mono text-[10.5px]">.glb</code>{" "}
                into <code className="font-mono text-[10.5px]">cars/</code> and
                run:
              </p>
              <p className="mt-2 rounded border border-border bg-background px-2 py-1.5 font-mono text-[10.5px] text-foreground">
                bun run cars:generate
              </p>
            </div>
          )}

          <ul className="space-y-1">
            {models?.map((model) => {
              const active = model.id === selectedId;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(model.id)}
                    className={cn(
                      "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                      active
                        ? "border-primary/50 bg-primary/10"
                        : "border-transparent hover:border-border hover:bg-accent/50",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Box
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          active ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                        {model.name}
                      </span>
                    </span>
                    <span className="mt-1 block pl-5.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatBytes(model.gzipBytes || model.bytes)} gz ·{" "}
                      {formatBytes(model.bytes)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      {/* Viewport */}
      <div className="relative min-h-[320px] flex-1 bg-[#111318]">
        {selected ? (
          <>
            <ModelViewer
              url={carModelUrl(selected)}
              wireframe={wireframe}
              autoRotate={autoRotate}
              normalize={normalize}
              showGrid={showGrid}
              onStats={handleStats}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="pointer-events-auto rounded-md border border-white/10 bg-black/45 px-3 py-1.5 backdrop-blur-sm">
                <div className="text-[12.5px] font-semibold leading-none text-white">
                  {selected.name}
                </div>
                <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/50">
                  {selected.file}
                </div>
              </div>
              <div className="pointer-events-auto flex flex-wrap gap-1.5">
                <ToolbarToggle
                  active={autoRotate}
                  onClick={() => setAutoRotate((v) => !v)}
                  icon={<RotateCw className="h-3 w-3" />}
                  label="Rotate"
                />
                <ToolbarToggle
                  active={wireframe}
                  onClick={() => setWireframe((v) => !v)}
                  icon={<Layers className="h-3 w-3" />}
                  label="Wire"
                />
                <ToolbarToggle
                  active={showGrid}
                  onClick={() => setShowGrid((v) => !v)}
                  icon={<Grid3x3 className="h-3 w-3" />}
                  label="Grid"
                />
                <ToolbarToggle
                  active={normalize}
                  onClick={() => setNormalize((v) => !v)}
                  icon={<Maximize2 className="h-3 w-3" />}
                  label="Scale"
                />
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-white/10 bg-black/45 px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45 backdrop-blur-sm">
              LMB rotate · RMB pan · wheel zoom
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="font-mono text-[11px] uppercase tracking-widest text-white/40">
              {models === null ? "Loading…" : "No model selected"}
            </p>
          </div>
        )}
      </div>

      {/* Stats */}
      <aside className="min-h-0 shrink-0 overflow-y-auto border-t border-border bg-card/40 lg:w-80 lg:border-l lg:border-t-0">
        {selected ? (
          <StatsPanel entry={selected} stats={stats} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              No selection
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
