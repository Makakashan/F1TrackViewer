"use client";

import { useState } from "react";
import { Globe2, LogOut, MoreHorizontal } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAppPref } from "@/components/app-pref-provider";
import { SettingsFields } from "@/components/settings-menu";
import {
  RaceSceneFields,
  type RaceSceneSettingsProps,
} from "@/components/race/race-scene-settings";

export interface RaceHeaderMenuProps extends RaceSceneSettingsProps {
  onBackToGlobe: () => void;
  onExit: () => void;
  className?: string;
}

/** Everything on the right of the race header, folded into one button. */
export default function RaceHeaderMenu({
  onBackToGlobe,
  onExit,
  className,
  ...scene
}: RaceHeaderMenuProps) {
  const { t } = useAppPref();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={className}
          aria-label={t.raceMore}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      {/* Long enough to overflow a short phone once the scene switches and
          both preference lists are stacked, so it scrolls rather than runs
          off the bottom. */}
      <PopoverContent
        align="end"
        className="max-h-[70dvh] w-64 overflow-y-auto p-0"
      >
        <div className="flex flex-col gap-1 p-3">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start gap-2"
            onClick={() => {
              setOpen(false);
              onBackToGlobe();
            }}
          >
            <Globe2 className="h-4 w-4" />
            Earth
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start gap-2"
            onClick={() => {
              setOpen(false);
              onExit();
            }}
          >
            <LogOut className="h-4 w-4" />
            {t.raceExit}
          </Button>
        </div>

        <Separator />

        <div className="p-3">
          <RaceSceneFields {...scene} />
        </div>

        <Separator />

        <SettingsFields />
      </PopoverContent>
    </Popover>
  );
}
