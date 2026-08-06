"use client";

import { Flag, Pause, Play, RotateCcw, Video, Move3d } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import { RACE_SPEED_OPTIONS, type RaceSpeed } from "@/hooks/use-race-simulation";

export interface RaceControlsProps {
  /** True from the moment the lights sequence begins until the flag. */
  started: boolean;
  paused: boolean;
  speed: RaceSpeed;
  onStart: () => void;
  onTogglePause: () => void;
  onReset: () => void;
  onSpeed: (speed: RaceSpeed) => void;
  /** Race running and skippable — shows the to-the-flag button. */
  canFinish: boolean;
  onFinish: () => void;
  cameraFollow: boolean;
  onToggleCamera: () => void;
  className?: string;
}

/**
 * The bottom bar: start, pause, back to the grid, and how fast time runs.
 *
 * Speed lives here rather than in a panel of its own because it is a control
 * of the simulation, and this is the simulation's panel — a second box in a
 * corner would be one more rectangle over the scene for the sake of three
 * buttons.
 */
export default function RaceControls({
  started,
  paused,
  speed,
  onStart,
  onTogglePause,
  onReset,
  onSpeed,
  canFinish,
  onFinish,
  cameraFollow,
  onToggleCamera,
  className,
}: RaceControlsProps) {
  const { t } = useAppPref();

  return (
    <div
      className={cn(
        "pointer-events-auto flex flex-col items-center gap-1.5",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-lg border border-border bg-background/80 p-1.5 shadow-xl backdrop-blur-md sm:gap-2">
        {started ? (
          <Button size="sm" className="gap-2" onClick={onTogglePause}>
            {paused ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            {paused ? t.raceResume : t.racePause}
          </Button>
        ) : (
          <Button size="sm" className="gap-2" onClick={onStart}>
            <Play className="h-3.5 w-3.5" />
            {t.raceStart}
          </Button>
        )}

        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          {RACE_SPEED_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onSpeed(option)}
              aria-pressed={option === speed}
              aria-label={`${t.raceSpeed} ${option}x`}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-semibold tabular-nums transition-colors",
                option === speed
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}x
            </button>
          ))}
        </div>

        {canFinish && (
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={onFinish}
            title={t.raceFinishNow}
          >
            <Flag className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.raceFinishNow}</span>
          </Button>
        )}

        {/* Which camera the user has, said in the control that changes it —
            an indicator and a switch as one element cannot contradict
            each other. */}
        <Button
          size="sm"
          variant={cameraFollow ? "secondary" : "outline"}
          className="gap-2"
          onClick={onToggleCamera}
          title={t.raceCamHint}
        >
          {cameraFollow ? (
            <Video className="h-3.5 w-3.5" />
          ) : (
            <Move3d className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">
            {cameraFollow ? t.raceCamFollow : t.raceCamFree}
          </span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="gap-2"
          onClick={onReset}
          title={t.raceReset}
          aria-label={t.raceReset}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {/* Keyboard hints on a touch screen are noise about keys that do not
          exist. */}
      <p className="hidden rounded bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur sm:block">
        {started ? t.raceCamHint : t.raceStartHint}
      </p>
    </div>
  );
}
