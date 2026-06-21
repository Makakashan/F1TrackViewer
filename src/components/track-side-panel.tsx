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

  return (
    <Tabs defaultValue="info" className="h-full min-h-0 gap-0">
      <div className="border-b border-border p-3">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="info">
            <Info className="h-3.5 w-3.5" />
            {t.info}
          </TabsTrigger>
          <TabsTrigger value="settings">
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
        />
      </TabsContent>
    </Tabs>
  );
}
