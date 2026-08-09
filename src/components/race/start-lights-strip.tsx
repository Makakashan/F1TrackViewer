"use client";

import { cn } from "@/lib/utils";
import { START_LIGHT_COLUMNS, START_LIGHT_ROWS } from "@/lib/race/start-lights";

export interface StartLightsStripProps {
  /** How many columns are lit, 0–5. */
  lit: number;
  className?: string;
}

/** The gantry's lights, repeated in the HUD. */
export default function StartLightsStrip({
  lit,
  className,
}: StartLightsStripProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1.5",
        className,
      )}
      role="img"
      aria-label={`${lit} of ${START_LIGHT_COLUMNS} start lights on`}
    >
      {Array.from({ length: START_LIGHT_COLUMNS }, (_, column) => (
        <div key={column} className="flex flex-col gap-1">
          {Array.from({ length: START_LIGHT_ROWS }, (_, row) => (
            <span
              key={row}
              className={cn(
                "h-2.5 w-2.5 rounded-full transition-colors duration-150",
                column < lit
                  ? "bg-[#ff1f1f] shadow-[0_0_8px_rgba(255,31,31,0.85)]"
                  : "bg-[#4a1c20]",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
