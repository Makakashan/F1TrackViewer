"use client";

import { useEffect, useState } from "react";
import { TRACK_OVERRIDES } from "@/data/track-overrides";
import { fetchCircuitIndex, type CircuitLocation } from "@/lib/f1-circuits";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Opens a circuit in race view with the track editor on. Local only: the tab exists under `next dev`. */
export default function TrackEditorLauncher() {
  const [circuits, setCircuits] = useState<CircuitLocation[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="h-full overflow-y-auto p-4">
      <p className="mb-3 max-w-2xl text-xs text-muted-foreground">
        Opens the circuit in race view with the editor panel. Click the road to add a point, set width,
        barrier and kerbs, then save: the corrections are written to{" "}
        <code className="font-mono">src/data/track-overrides/</code> and go into git like any other change.
      </p>
      {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {circuits.map((circuit) => {
          const edits = TRACK_OVERRIDES[circuit.id]?.points.length ?? 0;
          return (
            <a
              key={circuit.id}
              href={`${BASE_PATH}/?track=${encodeURIComponent(circuit.id)}&race=1&edit=1`}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs hover:border-primary/50 hover:bg-primary/5"
            >
              <span>
                <span className="block font-medium text-foreground">{circuit.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{circuit.id}</span>
              </span>
              {edits > 0 && (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                  {edits} {edits === 1 ? "point" : "points"}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
