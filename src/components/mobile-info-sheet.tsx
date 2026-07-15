"use client";

import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import TrackInfo from "@/components/track-info";
import { useAppPref } from "@/components/app-pref-provider";
import type { CircuitProperties } from "@/lib/f1-circuits";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";

interface MobileInfoSheetProps {
	properties: CircuitProperties | null;
	loadingTrack: boolean;
	pointCount: number | undefined;
	elevations: number[] | null;
	elevationEnabled: boolean;
	markers?: TrackMarkers | null;
	viewMode?: TrackViewMode;
	trackWidth?: number;
	realWidthAvailable?: boolean;
	realWidthEnabled?: boolean;
	meanWidthMeters?: number | null;
	minWidthMeters?: number | null;
	maxWidthMeters?: number | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	showTrigger?: boolean;
}

export default function MobileInfoSheet({
	properties,
	loadingTrack,
	pointCount,
	elevations,
	elevationEnabled,
	markers,
	viewMode,
	trackWidth,
	realWidthAvailable,
	realWidthEnabled,
	meanWidthMeters,
	minWidthMeters,
	maxWidthMeters,
	open,
	onOpenChange,
	showTrigger = true,
}: MobileInfoSheetProps) {
	const { t } = useAppPref();

	if (!properties) return null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			{showTrigger && (
				<SheetTrigger asChild>
					<Button
						variant="secondary"
						size="sm"
						className="absolute bottom-4 right-4 z-10 md:hidden"
					>
						{t.circuit}
					</Button>
				</SheetTrigger>
			)}
			<SheetContent
				side="right"
				className="w-80 p-0 bg-sidebar overflow-y-auto"
			>
				<SheetHeader className="px-4 pt-4 pb-2">
					<SheetTitle className="text-sm uppercase tracking-wider text-muted-foreground">
						{t.circuit}
					</SheetTitle>
				</SheetHeader>
				<TrackInfo
					properties={properties}
					loading={loadingTrack}
					pointCount={pointCount}
					elevations={elevations}
					elevationEnabled={elevationEnabled}
					markers={markers}
					viewMode={viewMode}
					trackWidth={trackWidth}
					realWidthAvailable={realWidthAvailable}
					realWidthEnabled={realWidthEnabled}
					meanWidthMeters={meanWidthMeters}
					minWidthMeters={minWidthMeters}
					maxWidthMeters={maxWidthMeters}
				/>
			</SheetContent>
		</Sheet>
	);
}
