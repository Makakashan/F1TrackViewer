"use client";

interface CalibrationPanelProps {
  circuitId: string;
  displayedS: number;
  currentMarkerExport: string;
  allMarkerExport: string;
  onUpdate: (s: number) => void;
  onReset: () => void;
}

export default function CalibrationPanel({
  circuitId,
  displayedS,
  currentMarkerExport,
  allMarkerExport,
  onUpdate,
  onReset,
}: CalibrationPanelProps) {
  return (
    <div className="absolute left-4 top-4 z-20 max-h-[calc(100vh-2rem)] w-[min(360px,calc(100vw-2rem))] overflow-y-auto rounded-md border border-border/80 bg-background/90 p-3 text-xs shadow-lg backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-foreground">
            Start/finish calibration
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {circuitId}: {displayedS.toFixed(5)}
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Reset
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.0005}
        value={displayedS}
        onChange={(event) => onUpdate(Number(event.target.value))}
        className="mt-3 h-1 w-full cursor-pointer accent-[#e10600]"
      />
      <div className="mt-2 rounded-sm bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
        &quot;{circuitId}&quot;: {displayedS.toFixed(5)}
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Click the correct point on the track, then fine-tune with the
        slider if needed.
      </div>
      <div className="mt-3 space-y-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Current marker JSON
        </div>
        <textarea
          readOnly
          value={currentMarkerExport}
          className="h-28 w-full resize-none rounded-sm border border-border bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
        />
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Local overrides export
        </div>
        <textarea
          readOnly
          value={allMarkerExport}
          className="h-40 w-full resize-none rounded-sm border border-border bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
        />
      </div>
    </div>
  );
}
