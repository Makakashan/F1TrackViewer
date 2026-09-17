"use client";

import { EDITOR_SIDE_COLORS } from "@/components/three/track-editor-markers";
import { useTrackEditor } from "@/lib/track/track-editor-store";
import type { OverrideKey } from "@/lib/track/track-overrides";
import { cn } from "@/lib/utils";

/** Development tool: hand corrections to a circuit, saved into the source tree. English only, like the labs. */

const FIELDS: {
  key: OverrideKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Where the slider starts when the value is first set. */
  start: number;
  color?: string;
}[] = [
  { key: "widthM", label: "Road width, m", min: 3, max: 20, step: 0.1, start: 10 },
  { key: "smoothM", label: "Smooth centreline, m", min: 0, max: 120, step: 2, start: 30 },
  { key: "barrierPlusM", label: "Barrier from edge, m", min: 0.95, max: 40, step: 0.05, start: 1, color: EDITOR_SIDE_COLORS.plus },
  { key: "barrierMinusM", label: "Barrier from edge, m", min: 0.95, max: 40, step: 0.05, start: 1, color: EDITOR_SIDE_COLORS.minus },
  { key: "kerbPlusM", label: "Kerb width, m", min: 0, max: 3, step: 0.05, start: 1.9, color: EDITOR_SIDE_COLORS.plus },
  { key: "kerbMinusM", label: "Kerb width, m", min: 0, max: 3, step: 0.05, start: 1.9, color: EDITOR_SIDE_COLORS.minus },
];

export default function TrackEditorPanel({ className }: { className?: string }) {
  const {
    overrides,
    selectedId,
    dirty,
    status,
    message,
    markersVisible,
    select,
    update,
    clear,
    remove,
    save,
    toggleMarkers,
  } = useTrackEditor();
  // Already in lap order from the start line; sorting here would undo that.
  const points = overrides?.points ?? [];
  const point = points.find((p) => p.id === selectedId) ?? null;

  return (
    <div
      className={cn(
        "pointer-events-auto w-72 rounded-lg border border-white/10 bg-black/80 p-2.5 font-mono text-[11px] text-white shadow-lg backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-widest text-white/60">
          Track editor · {overrides?.circuitId}
        </span>
        {dirty && <span className="text-[#e10600]">unsaved</span>}
      </div>
      <p className="mt-1 text-white/50">
        Click the road to add a point. <span style={{ color: EDITOR_SIDE_COLORS.plus }}>Orange</span> is the + side,{" "}
        <span style={{ color: EDITOR_SIDE_COLORS.minus }}>blue</span> the − side.
      </p>

      {points.length > 0 && (
        <div className="mt-2 max-h-28 space-y-0.5 overflow-y-auto">
          {points.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => select(p.id)}
              className={cn(
                "block w-full rounded px-1.5 py-0.5 text-left",
                p.id === selectedId ? "bg-[#e10600] text-white" : "bg-white/10 hover:bg-white/20",
              )}
            >
              {p.id} · s {p.s.toFixed(4)} · {p.lengthM} m
            </button>
          ))}
        </div>
      )}

      {point && (
        <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
          <label className="block">
            <div className="flex justify-between text-white/70">
              <span>Position</span>
              <span className="text-white">{point.s.toFixed(4)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.0005}
              value={point.s}
              onChange={(e) => update(point.id, { s: Number(e.target.value) })}
              className="w-full accent-[#e10600]"
            />
          </label>
          <label className="block">
            <div className="flex justify-between text-white/70">
              <span>Stretch, m</span>
              <span className="text-white">{point.lengthM}</span>
            </div>
            <input
              type="range"
              min={5}
              max={300}
              step={5}
              value={point.lengthM}
              onChange={(e) => update(point.id, { lengthM: Number(e.target.value) })}
              className="w-full accent-[#e10600]"
            />
          </label>

          {FIELDS.map((field) => {
            const value = point[field.key];
            const set = value !== undefined;
            return (
              <div key={field.key}>
                <div className="flex items-center justify-between text-white/70">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={set}
                      onChange={(e) =>
                        e.target.checked
                          ? update(point.id, { [field.key]: field.start })
                          : clear(point.id, field.key)
                      }
                      className="accent-[#e10600]"
                    />
                    {field.color && (
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: field.color }} />
                    )}
                    {field.label}
                  </label>
                  <span className="text-white">{set ? value : "auto"}</span>
                </div>
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value ?? field.start}
                  disabled={!set}
                  onChange={(e) => update(point.id, { [field.key]: Number(e.target.value) })}
                  className="w-full accent-[#e10600] disabled:opacity-30"
                />
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => remove(point.id)}
            className="w-full rounded bg-white/10 py-1 hover:bg-white/20"
          >
            Delete point
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2">
        <button
          type="button"
          onClick={toggleMarkers}
          className="rounded bg-white/15 px-2 py-1.5 hover:bg-white/25"
        >
          {markersVisible ? "Hide poles" : "Show poles"}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || status === "saving"}
          className="flex-1 rounded bg-[#e10600] py-1.5 font-semibold uppercase tracking-wider disabled:bg-white/15 disabled:text-white/50"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        <span className={cn("text-white/60", status === "error" && "text-[#e10600]")}>
          {status === "saved" ? "saved" : status === "error" ? "failed" : ""}
        </span>
      </div>
      {status === "error" && message && <p className="mt-1 break-words text-[#e10600]">{message}</p>}
    </div>
  );
}
