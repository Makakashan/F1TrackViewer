"use client";

import CircuitList from "@/components/circuit-list";
import type { CircuitLocation } from "@/lib/f1-circuits";
import { useAppPref } from "@/components/app-pref-provider";

interface CircuitSidebarProps {
  circuits: CircuitLocation[];
  selectedId: string | null;
  loadingIndex: boolean;
  onSelect: (id: string) => void;
}

export default function CircuitSidebar({
  circuits,
  selectedId,
  loadingIndex,
  onSelect,
}: CircuitSidebarProps) {
  const { t } = useAppPref();

  if (loadingIndex) {
    return (
      <div className="space-y-2 p-4">
        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
        <div className="h-9 w-full animate-pulse rounded bg-muted" />
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="h-12 w-full animate-pulse rounded bg-muted/60"
          />
        ))}
        <div className="text-[11px] text-muted-foreground">
          {t.loadingCircuits}
        </div>
      </div>
    );
  }

  return (
    <CircuitList
      circuits={circuits}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}
