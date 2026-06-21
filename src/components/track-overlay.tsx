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
}

export default function TrackOverlay({
        properties,
        loadingElevations,
        startFinishStatus,
        viewMode = "normal",
        markers,
        environmentActive = false,
}: TrackOverlayProps) {
        const { t } = useAppPref();

        if (!properties) return null;

        return (
                <>
                        {/* Track name overlay (bottom-left) */}
                        <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[72vw] md:hidden">
                                <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-primary/80">
                                        <ChevronRight className="h-3 w-3" />
                                        {t.nowViewing}
                                </div>
                                <div className="mt-0.5 text-xl font-bold text-foreground drop-shadow-lg md:text-2xl">
                                        {properties.Name}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                        {properties.Location} · {(properties.length / 1000).toFixed(3)}{" "}
                                        {t.unitKm} · {t.opened.toLowerCase()} {properties.opened}
                                </div>
                                {startFinishStatus && (
                                        <div className="mt-1 text-[10px] uppercase tracking-wider text-primary/80">
                                                Start/Finish: {startFinishStatus}
                                        </div>
                                )}
                                {loadingElevations && (
                                        <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-500/80">
                                                <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                                                {t.loadingElevations}
                                        </div>
                                )}
                        </div>

                        {/* Sector unavailable notice */}
                        {viewMode === "sectors" && !markers?.sectors?.length && (
                                <div className="pointer-events-none absolute bottom-4 left-4 z-10 mt-2 rounded-md border border-amber-500/30 bg-background/80 px-3 py-2 backdrop-blur">
                                        <div className="text-[11px] text-amber-500/80">
                                                {t.sectorUnavailable}
                                        </div>
                                </div>
                        )}

                        {/* Controls hint — desktop only */}
                        <div className="pointer-events-none absolute bottom-4 right-4 z-10 hidden rounded-md border border-border/80 bg-background/70 px-3 py-2 text-[10px] text-muted-foreground backdrop-blur md:block">
                                <div>
                                        <span className="text-foreground">
                                                {t.controlsLMB.split(" — ")[0]}
                                        </span>
                                        {" — "}
                                        {t.controlsLMB.split(" — ")[1]}
                                </div>
                                <div>
                                        <span className="text-foreground">
                                                {t.controlsRMB.split(" — ")[0]}
                                        </span>
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
