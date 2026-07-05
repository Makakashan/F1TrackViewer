"use client";

import { ChevronRight, RefreshCw } from "lucide-react";
import { useAppPref } from "@/components/app-pref-provider";
import type { CircuitProperties } from "@/lib/f1-circuits";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";

interface TrackOverlayProps {
  properties: CircuitProperties | null;
  loadingElevations: boolean;
  startFinishStatus?: string | null;
  viewMode?: TrackViewMode;
  markers?: TrackMarkers | null;
  environmentActive?: boolean;
  onOpenCircuit?: () => void;
}

export default function TrackOverlay({
  properties,
  loadingElevations,
  startFinishStatus,
  viewMode = "normal",
  markers,
  environmentActive = false,
  onOpenCircuit,
}: TrackOverlayProps) {
  const { t } = useAppPref();

  if (!properties) return null;

  return (
    <>
      {/* Track name overlay — compact mobile bottom card */}
      <div className="pointer-events-auto absolute bottom-3 left-3 right-3 z-20 md:hidden">
        <div className="rounded-2xl border border-white/10 bg-background/82 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-primary/80">
                <ChevronRight className="h-3 w-3" />
                {t.nowViewing}
              </div>
              <div className="mt-1 line-clamp-2 text-xl font-bold leading-tight text-foreground drop-shadow-lg">
                {properties.Name}
              </div>
              <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                {properties.Location} · {(properties.length / 1000).toFixed(3)}{" "}
                {t.unitKm} · {t.opened.toLowerCase()} {properties.opened}
              </div>
            </div>

            {onOpenCircuit && (
              <button
                type="button"
                onClick={onOpenCircuit}
                className="shrink-0 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:bg-white/15 active:bg-white/20"
              >
                {t.circuit}
              </button>
            )}
          </div>

          {(startFinishStatus || loadingElevations) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {startFinishStatus && (
                <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[10px] uppercase tracking-wider text-primary/85">
                  Start/Finish: {startFinishStatus}
                </span>
              )}
              {loadingElevations && (
                <span className="flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-500/85">
                  <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                  {t.loadingElevations}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sector unavailable notice */}
      {viewMode === "sectors" && !markers?.sectors?.length && (
        <div className="pointer-events-none absolute bottom-32 left-3 right-3 z-20 rounded-md border border-amber-500/30 bg-background/80 px-3 py-2 backdrop-blur md:bottom-4 md:left-4 md:right-auto">
          <div className="text-[11px] text-amber-500/80">
            {t.sectorUnavailable}
          </div>
        </div>
      )}

      {/* Controls hint — desktop only */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10 hidden rounded-md border border-border/80 bg-background/70 px-3 py-2 text-[10px] text-muted-foreground backdrop-blur md:block">
        <div>
          <span className="text-foreground">{t.controlsLMB.split(" — ")[0]}</span>
          {" — "}
          {t.controlsLMB.split(" — ")[1]}
        </div>
        <div>
          <span className="text-foreground">{t.controlsRMB.split(" — ")[0]}</span>
          {" — "}
          {t.controlsRMB.split(" — ")[1]}
        </div>
        <div>
          <span className="text-foreground">
            {t.controlsWheel.split(" — ")[0]}
          </span>
          {" — "}
          {t.controlsWheel.split(" — ")[1]}
        </div>
      </div>

      {/* OSM attribution — required by ODbL when the diorama is shown. */}
      {environmentActive && (
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer noopener"
          className="pointer-events-auto absolute right-4 top-16 z-10 rounded-md border border-border/80 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur hover:text-foreground md:top-4"
        >
          © OpenStreetMap contributors
        </a>
      )}
    </>
  );
}
