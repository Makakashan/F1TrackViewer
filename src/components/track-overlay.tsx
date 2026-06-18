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
}

export default function TrackOverlay({
	properties,
	loadingElevations,
	startFinishStatus,
	viewMode = "normal",
	markers,
}: TrackOverlayProps) {
	const { t } = useAppPref();

	if (!properties) return null;

	const showSectors = viewMode === "sectors" && markers?.sectors?.length;

	return (
		<>
			{/* Track name overlay (bottom-left) */}
			<div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[60vw]">
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

				{/* Sector legend */}
				{showSectors && (
					<div className="mt-3 rounded-md border border-border/60 bg-background/80 px-3 py-2 backdrop-blur">
						<div className="text-[10px] uppercase tracking-wider text-muted-foreground">
							{t.sectorLegend}
						</div>
						<div className="mt-1.5 flex items-center gap-3">
							{markers!.sectors.map((sector) => (
								<div
									key={sector.id}
									className="flex items-center gap-1.5"
								>
									<div
										className="h-2.5 w-2.5 rounded-sm"
										style={{ backgroundColor: sector.color }}
									/>
									<span className="text-[11px] font-medium text-foreground">
										{t.sectorN(sector.id)}
									</span>
								</div>
							))}
						</div>
						{/* Source badge */}
						<div className="mt-1.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">
							{markers!.source === "fastf1-telemetry-derived"
								? t.sectorSourceFastf1
								: markers!.source === "manual"
									? t.sectorSourceManual
									: t.sectorSourceEstimated}
							{markers!.year ? ` · ${markers!.year}` : ""}
							{markers!.session ? ` ${markers!.session}` : ""}
						</div>
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
		</>
	);
}
