"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Globe2, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import BrandMark from "@/components/brand-mark";
import ErrorBanner from "@/components/error-banner";
import SettingsMenu from "@/components/settings-menu";
import { useAppPref } from "@/components/app-pref-provider";
import { useCircuits } from "@/hooks/use-circuits";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTrackData } from "@/hooks/use-track-data";
import { useCircuitScene } from "@/hooks/use-circuit-scene";
import { useRaceSimulation } from "@/hooks/use-race-simulation";
import { raceGridOrder, raceLapCount, raceTyreChoices } from "@/lib/race-session";
import { useUrlState } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import RaceBetaNotice from "@/components/race/race-beta-notice";
import RaceCircuitPicker from "@/components/race/race-circuit-picker";
import RaceControls from "@/components/race/race-controls";
import RaceFastestLapPopup from "@/components/race/race-fastest-lap-popup";
import RaceHeaderMenu from "@/components/race/race-header-menu";
import RaceSceneSettings from "@/components/race/race-scene-settings";
import RaceStatusBar from "@/components/race/race-status-bar";
import RaceResults from "@/components/race/race-results";
import TimingTower from "@/components/race/timing-tower";

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
  const isMobile = useIsMobile();

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

  const tyres = useMemo(
    () =>
      selectedId
        ? raceTyreChoices(selectedId, gridNonce, order.length)
        : undefined,
    [selectedId, gridNonce, order.length],
  );

  // Gaps only mean something once the cars are moving. Through the lights the
  // field is stationary on a grid whose slots are eight meters apart, and
  // reporting that spacing as an interval is a number about the tarmac.
  const gapsLive = race.phase === "racing" || race.phase === "finished";

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
        // A popover is already using this key to close itself; leaving the
        // mode as well means one press dismisses a menu and the race behind
        // it. The popper wrapper only exists while something is open.
        if (document.querySelector("[data-radix-popper-content-wrapper]")) {
          return;
        }
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
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* The bar is 3.5rem of content plus whatever the status bar takes —
          the page reaches under it now, and a header that ignored that would
          hand the notch its first row of buttons. */}
      <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center justify-between gap-2 border-b border-border bg-background/80 px-3 pt-[env(safe-area-inset-top)] backdrop-blur md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
          <BrandMark className="h-6 w-auto shrink-0" title={t.appName} />
          <div className="hidden leading-none sm:block">
            <div className="text-sm font-bold tracking-tight">
              {t.raceModeTitle}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t.appName}
            </div>
          </div>
          <span className="hidden rounded bg-[#e10600]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#e10600] sm:inline">
            {t.raceBeta}
          </span>
          <RaceCircuitPicker
            circuits={circuits}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </div>

        {/* A phone gets one button here; the four the desktop shows leave the
            circuit name no width and end up drawn over it. */}
        <RaceHeaderMenu
          className="shrink-0 sm:hidden"
          onBackToGlobe={handleBackToGlobe}
          onExit={exitRace}
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

        <div className="hidden shrink-0 items-center gap-2 sm:flex">
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

        {/* Absolutely positioned children resolve against this box's padding
            edge, so the insets belong here once rather than on each of them.
            The scene underneath keeps the whole screen; only the overlay
            steps back from the cutouts. */}
        <div className="pointer-events-none absolute inset-0 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]">
          {/* One tower, sized by the viewport rather than two towers hidden
              from each other by a media query: the second copy still mounts,
              still re-renders five times a second and still measures its rows
              for the slide animation, and it pays that out of the frame budget
              the race is drawn with. */}
          <TimingTower
            compact={isMobile}
            className={cn(
              isMobile ? "absolute left-2 top-2" : "absolute left-4 top-4",
              // A phone has no room for both; the classification is what the
              // race was building toward, so the tower steps out of its way.
              isMobile && showResults && "hidden",
            )}
            order={order}
            standings={race.standings}
            selectedIndex={selectedDriver}
            onSelect={selectDriver}
            onShuffle={() => setGridNonce((nonce) => nonce + 1)}
            fastestLapIndex={race.fastestLap?.index ?? null}
            tyres={tyres}
            lap={leaderLap}
            totalLaps={totalLaps}
            started={gapsLive}
          />

          <RaceStatusBar
            className="absolute right-2 top-2 sm:left-1/2 sm:right-auto sm:top-4 sm:-translate-x-1/2"
            lit={race.lit}
            phase={race.phase}
          />

          {/* Under the lights, where the eye already is when something has
              just happened on track — which is the right edge on a phone and
              the centre on a desktop, because that is where the lights are. */}
          <RaceFastestLapPopup
            className={cn(
              "absolute right-2 top-14 sm:left-1/2 sm:right-auto sm:top-20 sm:-translate-x-1/2",
              showResults && "hidden",
            )}
            fastestLap={
              race.fastestLap
                ? {
                    code: order[race.fastestLap.index]?.code ?? "",
                    time: race.fastestLap.time,
                  }
                : null
            }
          />

          {showResults && (
            <button
              type="button"
              aria-label={t.raceClose}
              onClick={() => setShowResults(false)}
              className="pointer-events-auto absolute inset-0 z-10 bg-black/55 backdrop-blur-[2px] sm:hidden"
            />
          )}

          {showResults && (
            <RaceResults
              className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
              order={order}
              standings={race.standings}
              fastestLap={race.fastestLap}
              onClose={() => setShowResults(false)}
            />
          )}

          <RaceControls
            className="absolute bottom-4 left-1/2 w-max max-w-full -translate-x-1/2 sm:bottom-6"
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
