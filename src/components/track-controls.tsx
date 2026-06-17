"use client";

import { RefreshCw, RotateCw, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import SettingsMenu from "@/components/settings-menu";
import { useAppPref } from "@/components/app-pref-provider";

interface TrackControlsProps {
	autoRotate: boolean;
	setAutoRotate: (v: boolean) => void;
	elevationEnabled: boolean;
	setElevationEnabled: (v: boolean) => void;
	trackWidth: number;
	setTrackWidth: (v: number) => void;
	loadingTrack: boolean;
	selectedId: string | null;
	onReload: () => void;
}

export default function TrackControls({
	autoRotate,
	setAutoRotate,
	elevationEnabled,
	setElevationEnabled,
	trackWidth,
	setTrackWidth,
	loadingTrack,
	selectedId,
	onReload,
}: TrackControlsProps) {
	const { t } = useAppPref();

	return (
		<div className="flex items-center gap-2 md:gap-3">
			{/* Desktop-only controls */}
			<div className="hidden items-center gap-3 text-xs text-muted-foreground md:flex">
				<div className="flex items-center gap-2">
					<Switch
						id="autorotate"
						checked={autoRotate}
						onCheckedChange={setAutoRotate}
					/>
					<Label htmlFor="autorotate" className="cursor-pointer">
						<RotateCw className="mr-1 inline h-3 w-3" />
						{t.autoRotate}
					</Label>
				</div>
				<Separator orientation="vertical" className="h-5" />
				<div className="flex items-center gap-2">
					<Switch
						id="elevation"
						checked={elevationEnabled}
						onCheckedChange={setElevationEnabled}
					/>
					<Label htmlFor="elevation" className="cursor-pointer">
						<Mountain className="mr-1 inline h-3 w-3" />
						{t.elevations}
					</Label>
				</div>
				<Separator orientation="vertical" className="h-5" />
				<div className="flex items-center gap-2">
					<Label htmlFor="width" className="text-muted-foreground">
						{t.trackWidth}
					</Label>
					<input
						id="width"
						type="range"
						min={3}
						max={15}
						step={1}
						value={trackWidth}
						onChange={(e) => setTrackWidth(Number(e.target.value))}
						className="h-1 w-20 cursor-pointer accent-[#e10600]"
					/>
					<span className="w-10 tabular-nums text-foreground">
						{trackWidth}
						{t.unitM}
					</span>
				</div>
			</div>

			{/* Mobile: compact toggles */}
			<div className="flex items-center gap-2 md:hidden">
				<Switch
					id="autorotate-m"
					checked={autoRotate}
					onCheckedChange={setAutoRotate}
				/>
				<Label htmlFor="autorotate-m" className="cursor-pointer text-xs">
					<RotateCw className="inline h-3 w-3" />
				</Label>
				<Switch
					id="elevation-m"
					checked={elevationEnabled}
					onCheckedChange={setElevationEnabled}
				/>
				<Label htmlFor="elevation-m" className="cursor-pointer text-xs">
					<Mountain className="inline h-3 w-3" />
				</Label>
			</div>

			<Separator orientation="vertical" className="h-5" />
			<Button
				variant="ghost"
				size="sm"
				onClick={onReload}
				disabled={!selectedId || loadingTrack}
				className="text-muted-foreground hover:text-foreground"
			>
				<RefreshCw
					className={`h-3.5 w-3.5 ${loadingTrack ? "animate-spin" : ""}`}
				/>
				<span className="hidden ml-1.5 md:inline">{t.btnReload}</span>
			</Button>
			<SettingsMenu />
		</div>
	);
}
