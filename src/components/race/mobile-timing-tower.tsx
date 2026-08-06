"use client";

import { useState } from "react";
import { ChevronUp, Shuffle } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import TimingTower from "@/components/race/timing-tower";
import type { DriverWithTeam } from "@/lib/f1-drivers";
import type { RaceStanding } from "@/lib/race-sim";

export interface MobileTimingTowerProps {
  order: DriverWithTeam[];
  standings?: RaceStanding[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onShuffle: () => void;
  className?: string;
}

/**
 * The tower on a phone: one line, expanding into the full list.
 *
 * Twenty rows would take the screen, and hiding the order entirely leaves the
 * mode looking empty. A single row answers "who is on pole" — the question a
 * glance is asking — and a tap answers the rest.
 */
export default function MobileTimingTower({
  order,
  standings,
  selectedIndex,
  onSelect,
  onShuffle,
  className,
}: MobileTimingTowerProps) {
  const { t } = useAppPref();
  const [open, setOpen] = useState(false);
  // On track the chip shows who is actually leading, not who started there.
  const leader = standings?.length ? order[standings[0].index] : order[0];
  if (!leader) return null;

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className={cn(
            "pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/85 px-3 py-2 shadow-xl backdrop-blur-md",
            className,
          )}
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            P1
          </span>
          <span
            aria-hidden
            className="h-4 w-1 rounded-full"
            style={{ backgroundColor: leader.team.livery.body }}
          />
          <span className="text-xs font-bold tracking-wide">{leader.code}</span>
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DrawerTrigger>

      <DrawerContent>
        <DrawerHeader className="flex-row items-center justify-between pb-2">
          <DrawerTitle className="text-sm">{t.raceGridOrder}</DrawerTitle>
          <button
            type="button"
            onClick={onShuffle}
            aria-label={t.raceShuffle}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground active:bg-accent active:text-foreground"
          >
            <Shuffle className="h-4 w-4" />
          </button>
        </DrawerHeader>
        <div className="px-3 pb-6">
          <TimingTower
            className="w-full shadow-none"
            order={order}
            standings={standings}
            selectedIndex={selectedIndex}
            onSelect={(index) => {
              onSelect(index);
              setOpen(false);
            }}
            onShuffle={onShuffle}
            showHeader={false}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
