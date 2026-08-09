"use client";

import { useState } from "react";
import {
  Flag,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Video,
  Move3d,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import { RACE_SPEED_OPTIONS, type RaceSpeed } from "@/hooks/use-race-simulation";

/** The speed steps a phone's bar has room to show. */
const PHONE_SPEEDS: readonly RaceSpeed[] = [1, 4, 16];

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

/** The bottom bar: start, pause, back to the grid, and how fast time runs. */
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
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div
      className={cn(
        "pointer-events-auto flex flex-col items-center gap-1.5",
        className,
      )}
    >
      {/* One row, always. The bar sits over the scene at the bottom of the
          screen, and a second row appearing the moment the race starts moves
          the buttons under the thumb that just pressed one of them. */}
      <div className="flex max-w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background/80 p-1.5 shadow-xl backdrop-blur-md sm:gap-2">
        {started ? (
          <Button size="sm" className="shrink-0 gap-2" onClick={onTogglePause}>
            {paused ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            {paused ? t.raceResume : t.racePause}
          </Button>
        ) : (
          <Button size="sm" className="shrink-0 gap-2" onClick={onStart}>
            <Play className="h-3.5 w-3.5" />
            {t.raceStart}
          </Button>
        )}

        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
          {RACE_SPEED_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onSpeed(option)}
              aria-pressed={option === speed}
              aria-label={`${t.raceSpeed} ${option}x`}
              className={cn(
                "rounded px-1.5 py-1 text-[11px] font-semibold tabular-nums transition-colors sm:px-2",
                option === speed
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                // A phone gets the three steps that differ enough to be worth a tap.
                PHONE_SPEEDS.includes(option) || option === speed
                  ? undefined
                  : "hidden sm:block",
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
            className="hidden shrink-0 gap-2 sm:inline-flex"
            onClick={onFinish}
            title={t.raceFinishNow}
          >
            <Flag className="h-3.5 w-3.5" />
            {t.raceFinishNow}
          </Button>
        )}

        {/* Which camera the user has, said in the control that changes it —
            an indicator and a switch as one element cannot contradict
            each other. */}
        <Button
          size="sm"
          variant={cameraFollow ? "secondary" : "outline"}
          className="shrink-0 gap-2"
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
          className="hidden shrink-0 gap-2 sm:inline-flex"
          onClick={onReset}
          title={t.raceReset}
          aria-label={t.raceReset}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>

        {/* The two that end the race rather than run it, behind one button on
            a phone: they are the rarest presses here and the most expensive
            to hit by accident. */}
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 gap-2 sm:hidden"
              aria-label={t.raceMore}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-52 p-1.5">
            <div className="flex flex-col gap-1">
              {canFinish && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-start gap-2"
                  onClick={() => {
                    setMoreOpen(false);
                    onFinish();
                  }}
                >
                  <Flag className="h-3.5 w-3.5" />
                  {t.raceFinishNow}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="justify-start gap-2"
                onClick={() => {
                  setMoreOpen(false);
                  onReset();
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t.raceReset}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {/* Keyboard hints on a touch screen are noise about keys that do not
          exist. */}
      <p className="hidden rounded bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur sm:block">
        {started ? t.raceCamHint : t.raceStartHint}
      </p>
    </div>
  );
}
