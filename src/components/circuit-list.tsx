"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  countryFlag,
  countryFromId,
  type CircuitLocation,
} from "@/lib/f1-circuits";

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
      <div className="space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Circuits
        </h2>
        <p className="text-[11px] text-zinc-500">
          {circuits.length} трасс в датасете · bacinger/f1-circuits
        </p>
      </div>
      <Input
        placeholder="Поиск: Monaco, Monza, mc-1929…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="bg-zinc-900/60 border-zinc-800 text-zinc-200 placeholder:text-zinc-500"
      />
      <ScrollArea className="flex-1 -mx-1 pr-2">
        <ul className="flex flex-col gap-1 px-1">
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
                      ? "bg-red-600/15 border-red-600/60 text-white"
                      : "bg-zinc-900/40 border-transparent text-zinc-300 hover:bg-zinc-800/60 hover:border-zinc-700",
                  )}
                >
                  <span className="text-lg leading-none">{flag}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">
                      {c.name}
                    </span>
                    <span className="block text-[11px] text-zinc-500 truncate">
                      {c.location} · {c.id}
                    </span>
                  </span>
                  {active && (
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_2px_rgba(255,30,30,0.6)]" />
                  )}
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-zinc-500">
              Ничего не найдено
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  );
}
