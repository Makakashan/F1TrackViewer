"use client";

import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppPref } from "@/components/app-pref-provider";
import type { GlobeCircuit } from "./globe-marker";

const outlineCache = new Map<string, Promise<string | null>>();

function loadOutline(id: string): Promise<string | null> {
  let pending = outlineCache.get(id);
  if (!pending) {
    pending = fetch(`/circuits/${id}.geojson`)
      .then((res) => res.json())
      .then((geojson) => {
        const coords: [number, number][] = geojson.features?.[0]?.geometry?.coordinates ?? [];
        return coords.length > 1 ? outlinePath(coords) : null;
      })
      .catch(() => null);
    outlineCache.set(id, pending);
  }
  return pending;
}

function outlinePath(coords: [number, number][]): string {
  const squash = Math.cos((coords[0][1] * Math.PI) / 180);
  const points = coords.map(([lon, lat]) => [lon * squash, -lat]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  const scale = Math.min(92 / width, 52 / height);
  const ox = (100 - width * scale) / 2;
  const oy = (60 - height * scale) / 2;
  return points.map(([x, y], i) => `${i ? "L" : "M"}${(ox + (x - minX) * scale).toFixed(2)} ${(oy + (y - minY) * scale).toFixed(2)}`).join("");
}

function Outline({ id, active }: { id: string; active: boolean }) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadOutline(id).then((d) => live && setPath(d));
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <svg viewBox="0 0 100 60" className="h-full w-full" aria-hidden>
      {path && (
        <path
          d={path}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className={active ? "stroke-red-600" : "stroke-foreground/70 group-hover:stroke-red-600"}
        />
      )}
    </svg>
  );
}

/**
 * The circuits as a grid of outlines; hovering a cell turns the globe to it.
 * Docked left on a wide screen, as wide as a third of it; a sheet over the globe on a phone.
 */
export function CircuitPicker({
  circuits,
  query,
  setQuery,
  selectedId,
  onSelect,
  onHover,
  sheet = false,
  onClose,
}: {
  circuits: GlobeCircuit[];
  query: string;
  setQuery: (value: string) => void;
  selectedId: string | null;
  onSelect: (circuit: GlobeCircuit) => void;
  onHover: (circuit: GlobeCircuit | null) => void;
  sheet?: boolean;
  onClose?: () => void;
}) {
  const { t } = useAppPref();
  return (
    <aside
      className={
        sheet
          ? "absolute inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] top-[calc(69px+env(safe-area-inset-top))] z-40 flex flex-col overflow-hidden rounded-[14px] border border-border bg-background/80 backdrop-blur-xl md:hidden"
          : "absolute bottom-4 left-4 top-[73px] z-20 hidden w-(--picker-width) flex-col overflow-hidden rounded-[14px] border border-border bg-background/80 backdrop-blur-xl md:flex"
      }
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.searchPlaceholder}
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label={t.close}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Each cell draws its right and bottom hairline; the panel clips the outer ones. */}
        <div className="-mb-px -mr-px grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
          {circuits.map((circuit) => {
            const active = circuit.id === selectedId;
            return (
              <button
                key={circuit.id}
                onClick={() => onSelect(circuit)}
                onMouseEnter={() => onHover(circuit)}
                onMouseLeave={() => onHover(null)}
                className={`group relative flex min-w-0 flex-col border-b border-r border-border px-3 pb-2.5 pt-3 text-left transition-colors hover:bg-muted/60 ${active ? "bg-muted/60" : ""}`}
              >
                {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-red-600" />}
                <div className="aspect-[2/1] px-2">
                  <Outline id={circuit.id} active={active} />
                </div>
                <span className="mt-2 truncate text-sm font-medium">{circuit.shortName}</span>
                <span className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate">{circuit.country}</span>
                  <span className="shrink-0 font-mono">{circuit.id}</span>
                </span>
              </button>
            );
          })}
        </div>
        {circuits.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t.noResults}</p>}
      </div>
    </aside>
  );
}
