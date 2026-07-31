"use client";

import { Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import type { DriverWithTeam } from "@/lib/f1-drivers";

export interface TimingTowerProps {
  order: DriverWithTeam[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onShuffle: () => void;
  /** The drawer supplies its own title bar, so it turns this one off. */
  showHeader?: boolean;
  className?: string;
}

/**
 * The running order, read the way a broadcast shows it: position, a bar in the
 * team's colour, car number, driver code.
 *
 * The interval column is a dash until there is a simulation to fill it. Tyre
 * and pit columns are deliberately absent rather than empty — a column that
 * will never hold anything is worse than one that is not there.
 */
export default function TimingTower({
  order,
  selectedIndex,
  onSelect,
  onShuffle,
  showHeader = true,
  className,
}: TimingTowerProps) {
  const { t } = useAppPref();

  return (
    <div
      className={cn(
        "pointer-events-auto w-[248px] overflow-hidden rounded-lg border border-border bg-background/80 shadow-xl backdrop-blur-md",
        className,
      )}
    >
      {showHeader && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {t.raceGridOrder}
          </span>
          <button
            type="button"
            onClick={onShuffle}
            title={t.raceShuffle}
            aria-label={t.raceShuffle}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Shuffle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Sized to hold a full grid without scrolling: twenty rows is the
          content, not an arbitrary slice of it, and a tower that cuts off at
          P19 makes the reader wonder who is missing. The cap only bites on
          short viewports, where scrolling is the honest answer. */}
      <ol className="f1tv-scroll max-h-[calc(100vh-7rem)] overflow-y-auto">
        {order.map((driver, index) => {
          const selected = index === selectedIndex;
          return (
            <li key={driver.code}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-current={selected}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <span className="w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span
                  aria-hidden
                  className="h-5 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: driver.team.livery.body }}
                />
                <span className="w-6 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {driver.number}
                </span>
                <span className="shrink-0 text-xs font-bold tracking-wide">
                  {driver.code}
                </span>
                <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground xl:block">
                  {driver.lastName}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  —
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
