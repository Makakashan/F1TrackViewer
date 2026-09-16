import { create } from "zustand";
import { TRACK_OVERRIDES } from "@/data/track-overrides";
import {
  emptyOverrides,
  type TrackOverridePoint,
  type TrackOverrides,
} from "@/lib/track/track-overrides";

/** Length a new point holds, in metres. */
const NEW_POINT_LENGTH_M = 40;
/** Click this close to a point and it is that point, not a new one beside it. */
const SNAP_M = 10;

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface TrackEditorState {
  overrides: TrackOverrides | null;
  selectedId: string | null;
  dirty: boolean;
  status: SaveStatus;
  message: string | null;
  /** The poles in the scene; the road is easier to judge without them. */
  markersVisible: boolean;
  /** Where the start line sits on the lap; the numbering counts from there. */
  startS: number;
  setStartS: (s: number) => void;
  toggleMarkers: () => void;
  open: (circuitId: string) => void;
  /** A click on the road: the point it lands on, or a new one there. */
  addPoint: (s: number, lapLengthM: number) => void;
  select: (id: string | null) => void;
  update: (id: string, patch: Partial<TrackOverridePoint>) => void;
  /** Hands one value back to the automatic one. */
  clear: (id: string, key: keyof TrackOverridePoint) => void;
  remove: (id: string) => void;
  save: () => Promise<void>;
}

/** How far past the start line a point sits, as a share of the lap. */
function fromStart(s: number, startS: number): number {
  return (((s - startS) % 1) + 1) % 1;
}

/** Points are numbered along the lap from the start line, so p3 always lies before p4. */
function numberFromStart(points: TrackOverridePoint[], startS: number): TrackOverridePoint[] {
  return [...points]
    .sort((a, b) => fromStart(a.s, startS) - fromStart(b.s, startS))
    .map((point, index) => ({ ...point, id: `p${index + 1}` }));
}

export const useTrackEditor = create<TrackEditorState>((set, get) => {
  /** Keeps the numbering and the selection together: renumbering moves ids under it. */
  const commit = (points: TrackOverridePoint[], keep: TrackOverridePoint | null) => {
    const overrides = get().overrides;
    if (!overrides) return;
    const numbered = numberFromStart(points, get().startS);
    const selected = keep ? numbered.find((p) => p.s === keep.s && p.lengthM === keep.lengthM) : null;
    set({
      overrides: { ...overrides, points: numbered },
      selectedId: selected?.id ?? null,
      dirty: true,
      status: "idle",
    });
  };

  const selectedPoint = () => {
    const { overrides, selectedId } = get();
    return overrides?.points.find((p) => p.id === selectedId) ?? null;
  };

  return {
    overrides: null,
    selectedId: null,
    dirty: false,
    status: "idle",
    message: null,
    markersVisible: true,
    startS: 0,

    toggleMarkers: () => set({ markersVisible: !get().markersVisible }),

    setStartS: (s) => {
      if (Math.abs(get().startS - s) < 1e-6) return;
      const overrides = get().overrides;
      if (!overrides) {
        set({ startS: s });
        return;
      }
      // Renumbering is not an edit: the file keeps whatever was saved.
      const keep = overrides.points.find((p) => p.id === get().selectedId) ?? null;
      const numbered = numberFromStart(overrides.points, s);
      set({
        startS: s,
        overrides: { ...overrides, points: numbered },
        selectedId: keep ? (numbered.find((p) => p.s === keep.s)?.id ?? null) : get().selectedId,
      });
    },

    open: (circuitId) => {
      if (get().overrides?.circuitId === circuitId) return;
      const saved = TRACK_OVERRIDES[circuitId];
      set({
        overrides: saved
          ? { ...structuredClone(saved), points: numberFromStart(saved.points, get().startS) }
          : emptyOverrides(circuitId),
        selectedId: null,
        dirty: false,
        status: "idle",
        message: null,
      });
    },

    addPoint: (s, lapLengthM) => {
      const overrides = get().overrides;
      if (!overrides) return;
      const near = overrides.points.find((point) => {
        const apart = Math.abs((((s - point.s) % 1) + 1) % 1);
        return Math.min(apart, 1 - apart) * lapLengthM <= SNAP_M;
      });
      if (near) {
        set({ selectedId: near.id });
        return;
      }
      const point: TrackOverridePoint = { id: "new", s, lengthM: NEW_POINT_LENGTH_M };
      commit([...overrides.points, point], point);
    },

    select: (id) => set({ selectedId: id }),

    update: (id, patch) => {
      const overrides = get().overrides;
      if (!overrides) return;
      const points = overrides.points.map((p) => (p.id === id ? { ...p, ...patch } : p));
      commit(points, points.find((p) => p.id === id) ?? null);
    },

    clear: (id, key) => {
      const overrides = get().overrides;
      if (!overrides) return;
      const points = overrides.points.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p };
        delete next[key];
        return next;
      });
      commit(points, points.find((p) => p.id === id) ?? null);
    },

    remove: (id) => {
      const overrides = get().overrides;
      if (!overrides) return;
      commit(
        overrides.points.filter((p) => p.id !== id),
        null,
      );
    },

    save: async () => {
      const overrides = get().overrides;
      if (!overrides) return;
      const keep = selectedPoint();
      set({ status: "saving", message: null });
      try {
        const res = await fetch(`/api/track-overrides/${encodeURIComponent(overrides.circuitId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...overrides, points: numberFromStart(overrides.points, get().startS) }),
        });
        if (!res.ok) throw new Error((await res.text()) || res.statusText);
        const numbered = numberFromStart(overrides.points, get().startS);
        set({
          overrides: { ...overrides, points: numbered },
          selectedId: keep ? (numbered.find((p) => p.s === keep.s)?.id ?? null) : null,
          status: "saved",
          dirty: false,
        });
      } catch (err) {
        set({ status: "error", message: String(err) });
      }
    },
  };
});
