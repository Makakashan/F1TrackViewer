"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  countryFlag,
  countryFromId,
  type CircuitLocation,
} from "@/lib/f1-circuits";
import { useAppPref } from "@/components/app-pref-provider";

export interface CircuitListProps {
  circuits: CircuitLocation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function CircuitList({
  circuits,
  selectedId,
  onSelect,
}: CircuitListProps) {
  const [query, setQuery] = useState("");
  const { t } = useAppPref();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return circuits;
    return circuits.filter((c) => {
      return (
        c.name.toLowerCase().includes(q) ||
        c.location.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    });
  }, [circuits, query]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="shrink-0 space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t.circuits}
        </h2>
        <p className="text-[11px] text-muted-foreground/70">
          {t.circuitsCount(circuits.length)}
        </p>
      </div>
      <Input
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="shrink-0 bg-muted/50 border-border"
      />
      {/* Native overflow container — more reliable than shadcn ScrollArea in
          a flex sidebar, and we style it via the .f1tv-scroll class. */}
      <div className="f1tv-scroll min-h-0 flex-1 overflow-y-auto pr-1">
        <ul className="flex flex-col gap-1">
          {filtered.map((c) => {
            const iso = countryFromId(c.id);
            const flag = countryFlag(iso);
            const active = c.id === selectedId;
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "group w-full text-left px-3 py-2 rounded-md border transition-colors",
                    "flex items-center gap-3",
                    active
                      ? "bg-primary/15 border-primary/60 text-foreground"
                      : "bg-card/40 border-transparent text-foreground/80 hover:bg-accent/60 hover:border-border",
                  )}
                >
                  <span className="text-lg leading-none">{flag}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">
                      {c.name}
                    </span>
                    <span className="block text-[11px] text-muted-foreground truncate">
                      {c.location} · {c.id}
                    </span>
                  </span>
                  {active && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_2px_rgba(225,6,0,0.5)]" />
                  )}
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t.noResults}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
