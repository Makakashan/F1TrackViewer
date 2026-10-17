"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TRACK_OVERRIDES } from "@/data/track-overrides";
import { fetchCircuitIndex, type CircuitLocation } from "@/lib/f1-circuits";
import { cn } from "@/lib/utils";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const editsOf = (id: string) => TRACK_OVERRIDES[id]?.points.length ?? 0;

/** Opens a circuit in race view with the track editor on. Local only: the tab exists under `next dev`. */
export default function TrackEditorLauncher() {
  const [circuits, setCircuits] = useState<CircuitLocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editedOnly, setEditedOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCircuitIndex()
      .then((list) => {
        if (!cancelled) setCircuits([...list].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const edited = circuits.filter((circuit) => editsOf(circuit.id) > 0).length;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return circuits.filter(
      (circuit) =>
        (!editedOnly || editsOf(circuit.id) > 0) &&
        (!needle || `${circuit.name} ${circuit.location} ${circuit.id}`.toLowerCase().includes(needle)),
    );
  }, [circuits, query, editedOnly]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="relative mx-auto max-w-6xl border-x border-border px-6 pb-16 pt-12 md:px-10">
        <Cross className="-left-[5px] top-0" />
        <Cross className="-right-[5px] top-0" />

        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="h-2.5 w-2.5 bg-red-600" />
          Track editor
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Pick a circuit</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          It opens in race view with the editor panel. Click the road to add a point, set the width, barrier and
          kerbs, then save — the corrections are written to{" "}
          <code className="font-mono text-[12.5px] text-foreground">src/data/track-overrides/</code> and committed
          like any other change.
        </p>
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{circuits.length}</span> circuits
          <span>·</span>
          <span className="font-mono text-red-600">{edited}</span> edited
        </div>

        <div className="mt-8 overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex items-center gap-3 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, place or id"
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex shrink-0 rounded-md border border-border p-0.5 text-xs">
              {(
                [
                  [false, "All"],
                  [true, "Edited"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setEditedOnly(value)}
                  className={cn(
                    "rounded px-2.5 py-1 transition-colors",
                    editedOnly === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}

          {/* Each cell draws its right and bottom hairline; the panel clips the outer ones. */}
          <div className="-mb-px -mr-px grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
            {shown.map((circuit) => (
              <CircuitCell key={circuit.id} circuit={circuit} edits={editsOf(circuit.id)} />
            ))}
          </div>

          {circuits.length > 0 && shown.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing matches.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The corner mark where two of the page's hairlines meet. */
function Cross({ className }: { className: string }) {
  return (
    <span aria-hidden className={cn("absolute h-[11px] w-[11px] text-muted-foreground/60", className)}>
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-current" />
      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-current" />
    </span>
  );
}

function CircuitCell({ circuit, edits }: { circuit: CircuitLocation; edits: number }) {
  return (
    <a
      href={`${BASE_PATH}/?track=${encodeURIComponent(circuit.id)}&race=1&edit=1`}
      className="group relative flex flex-col border-b border-r border-border px-4 pb-3.5 pt-4 transition-colors hover:bg-muted/50"
    >
      {edits > 0 && <span className="absolute inset-x-0 top-0 h-0.5 bg-red-600" />}
      <div className="h-24">
        <TrackOutline id={circuit.id} />
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-medium">{circuit.name}</span>
        {edits > 0 && <span className="shrink-0 font-mono text-[11px] text-red-600">{edits} pts</span>}
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{circuit.location}</span>
        <span className="shrink-0 font-mono text-[11px]">{circuit.id}</span>
      </div>
    </a>
  );
}

/** The circuit's centreline as a thumbnail, north up. */
function TrackOutline({ id }: { id: string }) {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/circuits/${id}.geojson`)
      .then((res) => res.json())
      .then((geojson) => {
        const coords: [number, number][] = geojson.features?.[0]?.geometry?.coordinates ?? [];
        if (!cancelled && coords.length > 1) setPath(outlinePath(coords));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
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
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-foreground/70 transition-colors group-hover:stroke-red-600"
        />
      )}
    </svg>
  );
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
  const scale = Math.min(96 / width, 56 / height);
  const offsetX = (100 - width * scale) / 2;
  const offsetY = (60 - height * scale) / 2;
  return points
    .map(([x, y], i) => `${i ? "L" : "M"}${(offsetX + (x - minX) * scale).toFixed(2)} ${(offsetY + (y - minY) * scale).toFixed(2)}`)
    .join("");
}
