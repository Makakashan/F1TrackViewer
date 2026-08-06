"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Flag, Globe2, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import ErrorBanner from "@/components/error-banner";
import SettingsMenu from "@/components/settings-menu";
import { useAppPref } from "@/components/app-pref-provider";
import { useCircuits } from "@/hooks/use-circuits";
import { useTrackData } from "@/hooks/use-track-data";
import { useCircuitScene } from "@/hooks/use-circuit-scene";
import { useRaceSimulation } from "@/hooks/use-race-simulation";
import { raceGridOrder, raceLapCount } from "@/lib/race-session";
import { useUrlState } from "@/lib/url-state";
import RaceBetaNotice from "@/components/race/race-beta-notice";
import RaceCircuitPicker from "@/components/race/race-circuit-picker";
import RaceControls from "@/components/race/race-controls";
import RaceSceneSettings from "@/components/race/race-scene-settings";
import RaceStatusBar from "@/components/race/race-status-bar";
import RaceResults from "@/components/race/race-results";
import TimingTower from "@/components/race/timing-tower";
import MobileTimingTower from "@/components/race/mobile-timing-tower";

const TrackViewer = dynamic(() => import("@/components/track-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      Loading Three.js…
    </div>
  ),
});

/**
 * Race mode: the circuit as it looks on a race weekend, with the HUD a race
 * needs, and — for now — no race.
 *
 * A separate shell rather than a layer over the viewer. The two show the same
 * scene but answer different questions: the viewer is about a circuit's shape,
 * elevation and sectors, this is about twenty cars on a grid. Sharing one
 * component would mean a flag on every panel in it.
 */
export default function RaceApp() {
  const { t, resolvedTheme } = useAppPref();
  const [error, setError] = useState<string | null>(null);
  const { circuits, selectedId, onSelect } = useCircuits(setError);

  const {
    track: urlTrack,
    trackWidth,
    elevationEnabled,
    environmentEnabled,
    environmentTerrain,
    realWidthEnabled,
    qualityMode,
    hydrated,
    setEnvironmentEnabled: setUrlEnvironmentEnabled,
    setEnvironmentTerrain: setUrlEnvironmentTerrain,
    setRealWidthEnabled: setUrlRealWidthEnabled,
    setQualityMode: setUrlQualityMode,
    setRaceMode,
    hydrate,
    syncUrl,
  } = useUrlState();

  const { geojson, loadingTrack, elevations } = useTrackData(
    selectedId,
    setError,
  );
  const { markers, widthProfile, environmentBundle, environmentAvailable } =
    useCircuitScene(selectedId, environmentEnabled);

  const [gridNonce, setGridNonce] = useState(0);
  const [selectedDriver, setSelectedDriver] = useState(0);
  // Chase camera vs free flight. Owned here because the toggle button, the
  // rig, and "picking a driver re-attaches" all have to agree on it.
  const [cameraFollow, setCameraFollow] = useState(true);
  const [showResults, setShowResults] = useState(false);
  const detachCamera = useCallback(() => setCameraFollow(false), []);
  const selectDriver = useCallback((index: number) => {
    setSelectedDriver(index);
    setCameraFollow(true);
  }, []);
  const race = useRaceSimulation(qualityMode === "performance");

  const order = useMemo(
    () => (selectedId ? raceGridOrder(selectedId, gridNonce) : []),
    [selectedId, gridNonce],
  );

  // The fleet paints liveries per slot; feeding it the running order is what
  // makes the car on pole the one the tower lists as P1.
  const gridEntries = useMemo(
    () =>
      order.map((driver, index) => ({
        index,
        team: driver.team,
        seat: 0,
      })),
    [order],
  );

  const lapLength = geojson?.features[0]?.properties.length ?? 0;
  const totalLaps = selectedId ? raceLapCount(selectedId, lapLength) : 0;
  // The lap counter reads as the leader's, which is how a broadcast shows it.
  const leaderLap = Math.min(
    Math.max(1, (race.standings[0]?.laps ?? 0) + (race.complete ? 0 : 1)),
    Math.max(totalLaps, 1),
  );

  // ─── URL state, same contract as the viewer shell ────────────────
  const didHydrate = useRef(false);
  useEffect(() => {
    if (didHydrate.current) return;
    didHydrate.current = true;
    hydrate(circuits);
  }, [circuits, hydrate]);

  useEffect(() => {
    if (!hydrated || !selectedId) return;
    syncUrl({
      environmentBundleAvailable: !!environmentAvailable,
      widthProfileAvailable: !!widthProfile,
    });
  }, [
    hydrated,
    selectedId,
    trackWidth,
    elevationEnabled,
    environmentEnabled,
    environmentTerrain,
    realWidthEnabled,
    qualityMode,
    environmentAvailable,
    widthProfile,
    syncUrl,
  ]);

  const didApplyUrlTrack = useRef(false);
  useEffect(() => {
    if (didApplyUrlTrack.current) return;
    if (!circuits.length || !hydrated) return;
    didApplyUrlTrack.current = true;
    if (!urlTrack || selectedId === urlTrack) return;
    if (!circuits.some((c) => c.id === urlTrack)) return;
    const timer = window.setTimeout(() => onSelect(urlTrack), 0);
    return () => window.clearTimeout(timer);
  }, [circuits, hydrated, onSelect, selectedId, urlTrack]);

  useEffect(() => {
    if (selectedId && environmentAvailable === false && environmentEnabled) {
      const timer = window.setTimeout(() => setUrlEnvironmentEnabled(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, [
    environmentAvailable,
    environmentEnabled,
    selectedId,
    setUrlEnvironmentEnabled,
  ]);

  const exitRace = useCallback(() => {
    race.reset();
    setRaceMode(false);
  }, [race, setRaceMode]);

  // Everything that changes what is being raced puts the cars back on the
  // grid: a new circuit or a new order means the race in progress is about a
  // scene that no longer exists.
  const resetRace = race.reset;
  useEffect(() => {
    resetRace();
  }, [resetRace, selectedId, gridNonce]);

  // The classification appears when the flag falls and leaves when the race
  // state does. Closing it early is allowed; it comes back with the next race.
  const complete = race.complete;
  useEffect(() => {
    setShowResults(complete);
  }, [complete]);

  // Escape leaves the mode — the reflex out of anything that fills the screen.
  // The arrows walk the order, which is how you compare two cars without
  // hunting for their rows.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        exitRace();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.isContentEditable) return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setSelectedDriver((current) =>
        order.length ? (current + step + order.length) % order.length : 0,
      );
      setCameraFollow(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitRace, order.length]);

  const handleBackToGlobe = useCallback(() => {
    window.location.href = window.location.pathname || "/";
  }, []);

  const terrainModeActive =
    !!environmentBundle && environmentEnabled && environmentTerrain;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/80 px-3 backdrop-blur md:px-4">
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-linear-to-br from-red-600 to-orange-600 shadow-[0_0_20px_rgba(225,6,0,0.4)]">
            <Flag className="h-4 w-4 text-white" />
          </div>
          <div className="hidden leading-none sm:block">
            <div className="text-sm font-bold tracking-tight">
              {t.raceModeTitle}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t.appName}
            </div>
          </div>
          <span className="rounded bg-[#e10600]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#e10600]">
            {t.raceBeta}
          </span>
          <RaceCircuitPicker
            circuits={circuits}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <RaceSceneSettings
            environmentAvailable={!!environmentAvailable}
            environmentEnabled={environmentEnabled}
            setEnvironmentEnabled={setUrlEnvironmentEnabled}
            environmentTerrain={environmentTerrain}
            setEnvironmentTerrain={setUrlEnvironmentTerrain}
            realWidthAvailable={!!widthProfile}
            realWidthEnabled={realWidthEnabled}
            setRealWidthEnabled={setUrlRealWidthEnabled}
            qualityMode={qualityMode}
            setQualityMode={setUrlQualityMode}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleBackToGlobe}
          >
            <Globe2 className="h-4 w-4" />
            <span className="hidden sm:inline">Earth</span>
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={exitRace}>
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">{t.raceExit}</span>
          </Button>
          <SettingsMenu />
        </div>
      </header>

      <main className="relative min-h-0 flex-1 bg-background">
        {error && <ErrorBanner error={error} />}

        {geojson ? (
          <TrackViewer
            geojson={geojson}
            elevations={elevationEnabled ? elevations : null}
            trackWidth={trackWidth}
            autoRotate={false}
            resolvedTheme={resolvedTheme}
            cameraPreset={null}
            viewMode="realistic"
            markers={markers}
            environmentBundle={terrainModeActive ? environmentBundle ?? null : null}
            environmentTerrain={environmentTerrain}
            widthProfile={widthProfile ?? null}
            realWidthEnabled={realWidthEnabled}
            qualityMode={qualityMode}
            focusIndex={selectedDriver}
            startLightsLit={race.lit}
            gridEntries={gridEntries}
            raceSim={race.controller}
            raceLaps={totalLaps || 1}
            raceSeed={`${selectedId ?? "circuit"}:${gridNonce}`}
            cameraFollow={cameraFollow}
            onCameraDetach={detachCamera}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            {loadingTrack ? t.loadingTrack : t.selectTrack}
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 p-4">
          <TimingTower
            className="absolute left-4 top-4 hidden md:block"
            order={order}
            standings={race.standings}
            selectedIndex={selectedDriver}
            onSelect={selectDriver}
            onShuffle={() => setGridNonce((nonce) => nonce + 1)}
            fastestLapIndex={race.fastestLap?.index ?? null}
          />

          <RaceStatusBar
            className="absolute left-1/2 top-4 -translate-x-1/2"
            lap={leaderLap}
            totalLaps={totalLaps}
            lit={race.lit}
            phase={race.phase}
            fastestLap={
              race.fastestLap
                ? {
                    code: order[race.fastestLap.index]?.code ?? "",
                    time: race.fastestLap.time,
                  }
                : null
            }
          />

          <MobileTimingTower
            className="absolute bottom-6 left-4 md:hidden"
            order={order}
            standings={race.standings}
            selectedIndex={selectedDriver}
            onSelect={selectDriver}
            onShuffle={() => setGridNonce((nonce) => nonce + 1)}
          />

          {showResults && (
            <RaceResults
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              order={order}
              standings={race.standings}
              fastestLap={race.fastestLap}
              onClose={() => setShowResults(false)}
            />
          )}

          <RaceControls
            className="absolute bottom-6 left-1/2 -translate-x-1/2"
            started={race.phase !== "standby"}
            paused={race.paused}
            speed={race.speed}
            onStart={race.start}
            onTogglePause={race.togglePause}
            onReset={race.reset}
            onSpeed={race.setSpeed}
            canFinish={race.racing}
            onFinish={race.finish}
            cameraFollow={cameraFollow}
            onToggleCamera={() => setCameraFollow((value) => !value)}
          />
        </div>

        <RaceBetaNotice />
      </main>
    </div>
  );
}
