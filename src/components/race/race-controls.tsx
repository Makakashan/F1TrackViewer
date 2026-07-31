"use client";

import { Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";

export interface RaceControlsProps {
  running: boolean;
  onRun: () => void;
  onReset: () => void;
  className?: string;
}

/**
 * The bottom bar. Only the start sequence is live — the label says so, because
 * a button called "Start" that does not start a race is a bug report waiting
 * to happen.
 */
export default function RaceControls({
  running,
  onRun,
  onReset,
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
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background/80 p-1.5 shadow-xl backdrop-blur-md">
        <Button size="sm" className="gap-2" disabled={running} onClick={onRun}>
          <Play className="h-3.5 w-3.5" />
          {t.raceStartDemo}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-2"
          onClick={onReset}
          aria-label={t.raceExit}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="rounded bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur">
        {t.raceStartDemoHint}
      </p>
    </div>
  );
}
