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

interface MobileInfoSheetProps {
	properties: CircuitProperties | null;
	loadingTrack: boolean;
	pointCount: number | undefined;
	elevations: number[] | null;
	elevationEnabled: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export default function MobileInfoSheet({
	properties,
	loadingTrack,
	pointCount,
	elevations,
	elevationEnabled,
	open,
	onOpenChange,
}: MobileInfoSheetProps) {
	const { t } = useAppPref();

	if (!properties) return null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetTrigger asChild>
				<Button
					variant="secondary"
					size="sm"
					className="absolute bottom-4 right-4 z-10 md:hidden"
				>
					{t.circuit}
				</Button>
			</SheetTrigger>
			<SheetContent
				side="right"
				className="w-[320px] p-0 bg-sidebar overflow-y-auto"
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
				/>
			</SheetContent>
		</Sheet>
	);
}
