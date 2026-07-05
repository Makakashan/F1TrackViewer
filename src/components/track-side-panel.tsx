"use client";

import { Info, SlidersHorizontal } from "lucide-react";
import TrackInfo, { type TrackInfoProps } from "@/components/track-info";
import TrackSettingsPanel, {
  type TrackSettingsPanelProps,
} from "@/components/track-settings-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppPref } from "@/components/app-pref-provider";

export type TrackSidePanelProps = TrackInfoProps & TrackSettingsPanelProps;

export default function TrackSidePanel({
  properties,
  loading,
  pointCount,
  elevations,
  elevationEnabled,
  markers,
  viewMode,
  autoRotate,
  setAutoRotate,
  setElevationEnabled,
  trackWidth,
  setTrackWidth,
  onCameraPreset,
  setViewMode,
  sectorsAvailable,
  environmentAvailable,
  environmentEnabled,
  setEnvironmentEnabled,
  environmentTerrain,
  setEnvironmentTerrain,
  realWidthAvailable,
  realWidthEnabled,
  setRealWidthEnabled,
  meanWidthMeters,
  minWidthMeters,
  maxWidthMeters,
}: TrackSidePanelProps) {
  const { t } = useAppPref();
  const terrainModeActive =
    environmentAvailable && environmentEnabled && environmentTerrain;

  return (
    <Tabs defaultValue="info" className="h-full min-h-0 gap-0">
      <div className="border-b border-white/10 bg-black/20 p-3 backdrop-blur-xl">
        <TabsList className="grid h-10 w-full grid-cols-2 rounded-xl border border-white/10 bg-white/[0.045] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <TabsTrigger
            value="info"
            className="rounded-lg text-xs data-[state=active]:border-white/10 data-[state=active]:bg-white/10 data-[state=active]:shadow-[0_0_20px_rgba(255,255,255,0.06)]"
          >
            <Info className="h-3.5 w-3.5" />
            {t.info}
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="rounded-lg text-xs data-[state=active]:border-primary/20 data-[state=active]:bg-primary/15 data-[state=active]:text-foreground data-[state=active]:shadow-[0_0_24px_rgba(225,6,0,0.16)]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t.settings}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="info"
        className="min-h-0 overflow-hidden data-[state=inactive]:hidden"
      >
        <TrackInfo
          properties={properties}
          loading={loading}
          pointCount={pointCount}
          elevations={elevations}
          elevationEnabled={elevationEnabled && !terrainModeActive}
          markers={markers}
          viewMode={viewMode}
          trackWidth={trackWidth}
          realWidthAvailable={realWidthAvailable}
          realWidthEnabled={realWidthEnabled}
          meanWidthMeters={meanWidthMeters}
          minWidthMeters={minWidthMeters}
          maxWidthMeters={maxWidthMeters}
        />
      </TabsContent>

      <TabsContent
        value="settings"
        className="min-h-0 overflow-hidden data-[state=inactive]:hidden"
      >
        <TrackSettingsPanel
          autoRotate={autoRotate}
          setAutoRotate={setAutoRotate}
          elevationEnabled={!!elevationEnabled}
          setElevationEnabled={setElevationEnabled}
          trackWidth={trackWidth}
          setTrackWidth={setTrackWidth}
          onCameraPreset={onCameraPreset}
          viewMode={viewMode ?? "normal"}
          setViewMode={setViewMode}
          sectorsAvailable={sectorsAvailable}
          environmentAvailable={environmentAvailable}
          environmentEnabled={environmentEnabled}
          setEnvironmentEnabled={setEnvironmentEnabled}
          environmentTerrain={environmentTerrain}
          setEnvironmentTerrain={setEnvironmentTerrain}
          realWidthAvailable={realWidthAvailable}
          realWidthEnabled={realWidthEnabled}
          setRealWidthEnabled={setRealWidthEnabled}
          meanWidthMeters={meanWidthMeters}
          minWidthMeters={minWidthMeters}
          maxWidthMeters={maxWidthMeters}
        />
      </TabsContent>
    </Tabs>
  );
}
