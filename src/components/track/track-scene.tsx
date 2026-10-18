"use client";

import { Box, Flag, Globe2, Layers, SlidersHorizontal, Square, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useAppPref } from "@/components/app-pref-provider";
import { SiteHeader, buttons } from "@/components/site-header";
import { elevationStats } from "@/lib/track/elevation";
import type { TrackMarkers, TrackViewMode } from "@/lib/track/track-markers";
import type { CameraPreset } from "@/components/track/track-viewer";

type SceneProps = {
  properties: { Name: string; Location: string; length: number; opened: number; firstgp: number; altitude: number; id: string } | null;
  elevations: number[] | null;
  markers: TrackMarkers | null | undefined;
  viewMode: TrackViewMode;
  setViewMode: (mode: TrackViewMode) => void;
  onCameraPreset: (preset: CameraPreset) => void;
  environmentAvailable: boolean;
  environmentEnabled: boolean;
  setEnvironmentEnabled: (on: boolean) => void;
  onRace: () => void;
  onEarth: () => void;
  /** Replaces Earth and Race in the header: the admin view has neither. */
  actions?: ReactNode;
  /** A line under the numbers: where start/finish came from, while calibrating it. */
  status?: string;
  settings: ReactNode;
};

const card = "rounded-[14px] border border-border bg-background/80 backdrop-blur-xl";

/** The scene edge to edge, and everything else floating on it as small cards and one dock. */
export function TrackScene({
  properties,
  elevations,
  markers,
  viewMode,
  setViewMode,
  onCameraPreset,
  environmentAvailable,
  environmentEnabled,
  setEnvironmentEnabled,
  onRace,
  onEarth,
  actions,
  status,
  settings,
}: SceneProps) {
  const { t } = useAppPref();
  const [panel, setPanel] = useState(false);
  const stats = useMemo(() => (elevations?.length ? elevationStats(elevations) : null), [elevations]);
  const profile = useMemo(() => {
    if (!elevations || elevations.length < 2 || !stats) return "";
    const span = Math.max(stats.max - stats.min, 1);
    return elevations
      .map((e, i) => `${i ? "L" : "M"}${((i / (elevations.length - 1)) * 240).toFixed(1)} ${(54 - ((e - stats.min) / span) * 48).toFixed(1)}`)
      .join("");
  }, [elevations, stats]);
  if (!properties) return null;

  const dockButton = (active: boolean) =>
    `flex h-8 shrink-0 items-center gap-2 rounded-[10px] px-3 text-sm transition-colors lg:h-9 lg:px-3.5 ${
      active ? "bg-secondary text-foreground ring-1 ring-border" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
    }`;

  return (
    <>
      <SiteHeader crumb={properties.Name} onBrand={onEarth}>
        {actions ?? (
          <>
            <button onClick={onEarth} className={buttons.secondary}>
              <Globe2 className="h-3.5 w-3.5" /> <span className="max-sm:hidden">{t.earth}</span>
            </button>
            <button onClick={onRace} className={buttons.primary}>
              <Flag className="h-3.5 w-3.5" /> {t.raceEnter}
            </button>
          </>
        )}
      </SiteHeader>

      {/* Under the header: where it is and the three numbers that describe it. */}
      <div className={`${card} absolute left-3 top-[calc(69px+env(safe-area-inset-top))] z-20 w-72 p-4 max-md:right-3 max-md:w-auto max-md:p-3 md:left-4 md:top-[73px]`}>
        <div className="text-[13px] font-medium">{properties.Location}</div>
        <dl className="mt-3 hidden grid-cols-3 gap-2 border-t border-border pt-3 text-xs md:grid">
          {[
            [t.length, `${(properties.length / 1000).toFixed(2)} km`],
            [t.opened, properties.opened],
            [t.firstGp, properties.firstgp],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-1 font-mono text-xs text-muted-foreground md:hidden">
          {(properties.length / 1000).toFixed(2)} km · {properties.firstgp}
        </div>
        {status && <div className="mt-2 font-mono text-[11px] text-muted-foreground">Start/finish: {status}</div>}
      </div>

      {/* Bottom right: the lap's profile, with the sectors under it. */}
      {stats && (
        <div className={`${card} absolute right-4 top-[73px] z-20 hidden w-72 p-4 md:block xl:bottom-4 xl:top-auto`}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">{t.elevationProfile}</span>
            <span className="font-mono">
              {stats.min.toFixed(0)}–{stats.max.toFixed(0)} m
            </span>
          </div>
          <svg viewBox="0 0 240 58" className="mt-2 h-14 w-full">
            <path d={`${profile}L240 58L0 58Z`} className="fill-red-600/10" />
            <path d={profile} fill="none" stroke="#e10600" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
          {markers?.sectors?.length ? (
            <div className="mt-3 flex gap-1">
              {markers.sectors.map((sector) => (
                <div key={sector.id} className="flex-1">
                  <div className="h-1 rounded-full" style={{ background: sector.color }} />
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{t.sectorN(sector.id)}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* Bottom centre: the dock. */}
      <div className={`${card} absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-1/2 z-20 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto p-1 md:bottom-4`}>
        <button className={dockButton(false)} onClick={() => onCameraPreset("iso")}>
          <Box className="h-4 w-4" /> <span className="hidden sm:inline">{t.cameraIso}</span>
        </button>
        <button className={dockButton(false)} onClick={() => onCameraPreset("top")}>
          <Square className="h-4 w-4" /> <span className="hidden sm:inline">{t.cameraTop}</span>
        </button>
        <span className="mx-1 h-6 w-px shrink-0 bg-border" />
        <button
          className={dockButton(viewMode === "sectors")}
          onClick={() => setViewMode(viewMode === "sectors" ? "normal" : "sectors")}
        >
          <Layers className="h-4 w-4" /> <span className="hidden sm:inline">{t.viewModeSectors}</span>
        </button>
        {environmentAvailable && (
          <button className={dockButton(environmentEnabled)} onClick={() => setEnvironmentEnabled(!environmentEnabled)}>
            {t.city}
          </button>
        )}
        <span className="mx-1 h-6 w-px shrink-0 bg-border" />
        <button className={dockButton(panel)} onClick={() => setPanel((open) => !open)} aria-label={t.trackSettings}>
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      </div>

      {panel && (
        <div className={`${card} absolute bottom-[calc(4rem+env(safe-area-inset-bottom))] left-1/2 z-20 max-h-[60%] w-[min(360px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-y-auto md:bottom-16 lg:bottom-[4.25rem]`}>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-sm font-medium">
            {t.trackSettings}
            <button onClick={() => setPanel(false)} className="text-muted-foreground hover:text-foreground" aria-label={t.close}>
              <X className="h-4 w-4" />
            </button>
          </div>
          {settings}
        </div>
      )}
    </>
  );
}
