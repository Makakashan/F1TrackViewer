"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import CircuitList from "@/components/track/circuit-list";
import type { CircuitLocation } from "@/lib/f1-circuits";

export interface RaceCircuitPickerProps {
  circuits: CircuitLocation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Switching circuits without leaving race mode.
 *
 * Wraps the sidebar's circuit list rather than reimplementing it — that list
 * already searches by name, location and id, and takes no space while closed.
 */
export default function RaceCircuitPicker({
  circuits,
  selectedId,
  onSelect,
}: RaceCircuitPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = circuits.find((circuit) => circuit.id === selectedId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          // On a phone this is the only thing in the bar that can give, so it
          // takes the leftover width and truncates instead of pushing the
          // buttons beside it off their own row.
          className="min-w-0 flex-1 gap-2 sm:max-w-[200px] sm:flex-none"
        >
          <span className="truncate">{selected?.name ?? "—"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      {/* Sized against the viewport as well as its own content: a list taller
          than the phone it opens on scrolls the page instead of itself. */}
      <PopoverContent
        align="start"
        className="h-[min(420px,var(--radix-popover-content-available-height))] w-[min(300px,calc(100vw-1.5rem))] p-0"
      >
        <CircuitList
          circuits={circuits}
          selectedId={selectedId}
          onSelect={(id) => {
            onSelect(id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
