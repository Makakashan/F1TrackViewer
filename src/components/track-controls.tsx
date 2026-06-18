"use client";

import { useState } from "react";
import { RotateCw, Mountain, Camera, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
        Popover,
        PopoverContent,
        PopoverTrigger,
} from "@/components/ui/popover";
import SettingsMenu from "@/components/settings-menu";
import { useAppPref } from "@/components/app-pref-provider";
import type { CameraPreset } from "@/components/track-viewer";
import type { TrackViewMode } from "@/lib/track-markers";

interface TrackControlsProps {
        autoRotate: boolean;
        setAutoRotate: (v: boolean) => void;
        elevationEnabled: boolean;
        setElevationEnabled: (v: boolean) => void;
        trackWidth: number;
        setTrackWidth: (v: number) => void;
        onCameraPreset: (preset: CameraPreset) => void;
        viewMode: TrackViewMode;
        setViewMode: (v: TrackViewMode) => void;
        sectorsAvailable: boolean;
}

export default function TrackControls({
        autoRotate,
        setAutoRotate,
        elevationEnabled,
        setElevationEnabled,
        trackWidth,
        setTrackWidth,
        onCameraPreset,
        viewMode,
        setViewMode,
        sectorsAvailable,
}: TrackControlsProps) {
        const { t } = useAppPref();
        const [menuOpen, setMenuOpen] = useState(false);

        return (
                <div className="flex items-center gap-2 md:gap-3">
                        {/* Sector mode toggle — always visible button */}
                        <Button
                                variant="ghost"
                                size="sm"
                                disabled={!sectorsAvailable}
                                onClick={() =>
                                        setViewMode(
                                                viewMode === "sectors" ? "normal" : "sectors",
                                        )
                                }
                                className={`h-8 gap-1.5 px-2.5 text-xs ${
                                        viewMode === "sectors"
                                                ? "bg-primary/15 text-primary hover:bg-primary/25"
                                                : "text-muted-foreground hover:text-foreground"
                                } ${!sectorsAvailable ? "opacity-40" : ""}`}
                                title={
                                        sectorsAvailable
                                                ? viewMode === "sectors"
                                                        ? t.viewModeNormal
                                                        : t.viewModeSectors
                                                : t.sectorUnavailable
                                }
                        >
                                <Layers className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">
                                        {viewMode === "sectors"
                                                ? t.viewModeSectors
                                                : t.viewMode}
                                </span>
                        </Button>

                        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                                <PopoverTrigger asChild>
                                        <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                                <Camera className="h-4 w-4" />
                                        </Button>
                                </PopoverTrigger>
                                <PopoverContent
                                        align="end"
                                        className="w-56 p-0 bg-popover border-border"
                                >
                                        {/* Camera presets */}
                                        <div className="p-3">
                                                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                                                        <Camera className="h-3 w-3" />
                                                        Camera
                                                </div>
                                                <div className="mt-2 flex gap-1">
                                                        {(["top", "iso", "side"] as CameraPreset[]).map(
                                                                (preset) => (
                                                                        <button
                                                                                key={preset}
                                                                                onClick={() => {
                                                                                        onCameraPreset(preset);
                                                                                        setMenuOpen(false);
                                                                                }}
                                                                                className="flex-1 rounded-md px-2 py-1.5 text-xs text-foreground/80 hover:bg-accent capitalize"
                                                                        >
                                                                                {preset}
                                                                        </button>
                                                                ),
                                                        )}
                                                </div>
                                        </div>

                                        {/* Elevation toggle */}
                                        <div className="border-t border-border p-3">
                                                <div className="flex items-center justify-between">
                                                        <Label
                                                                htmlFor="elevation-pop"
                                                                className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                                                        >
                                                                <Mountain className="h-3 w-3" />
                                                                {t.elevations}
                                                        </Label>
                                                        <Switch
                                                                id="elevation-pop"
                                                                checked={elevationEnabled}
                                                                onCheckedChange={setElevationEnabled}
                                                        />
                                                </div>
                                        </div>

                                        {/* Auto-rotate toggle */}
                                        <div className="border-t border-border p-3">
                                                <div className="flex items-center justify-between">
                                                        <Label
                                                                htmlFor="autorotate-pop"
                                                                className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                                                        >
                                                                <RotateCw className="h-3 w-3" />
                                                                {t.autoRotate}
                                                        </Label>
                                                        <Switch
                                                                id="autorotate-pop"
                                                                checked={autoRotate}
                                                                onCheckedChange={setAutoRotate}
                                                        />
                                                </div>
                                        </div>

                                        {/* Track width */}
                                        <div className="border-t border-border p-3">
                                                <div className="flex items-center justify-between">
                                                        <Label
                                                                htmlFor="width-pop"
                                                                className="text-xs text-muted-foreground"
                                                        >
                                                                {t.trackWidth}
                                                        </Label>
                                                        <span className="text-xs tabular-nums text-foreground">
                                                                {trackWidth}
                                                                {t.unitM}
                                                        </span>
                                                </div>
                                                <input
                                                        id="width-pop"
                                                        type="range"
                                                        min={3}
                                                        max={15}
                                                        step={1}
                                                        value={trackWidth}
                                                        onChange={(e) =>
                                                                setTrackWidth(Number(e.target.value))
                                                        }
                                                        className="mt-2 h-1 w-full cursor-pointer accent-[#e10600]"
                                                />
                                        </div>
                                </PopoverContent>
                        </Popover>

                        <SettingsMenu />
                </div>
        );
}
