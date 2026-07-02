"use client";

import { ExternalLink, Mountain, Route, Trees } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GlobeCircuit } from "./globe-marker";

interface GlobeInfoCardProps {
  circuit: GlobeCircuit | null;
  onOpen: (circuit: GlobeCircuit) => void;
}

function formatType(type: string) {
  return type
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function GlobeInfoCard({
  circuit,
  onOpen,
}: GlobeInfoCardProps) {
  if (!circuit) return null;

  return (
    <div className="pointer-events-auto fixed inset-x-3 bottom-3 z-20 rounded-md border border-white/15 bg-black/78 p-4 shadow-2xl shadow-red-950/40 backdrop-blur-xl md:inset-x-auto md:bottom-auto md:right-6 md:top-24 md:w-[340px]">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-red-300">
        <Route className="h-3.5 w-3.5" />
        Circuit Selected
      </div>
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight text-white md:text-3xl">
          {circuit.shortName}
        </h2>
        <p className="text-sm leading-snug text-white/78">{circuit.name}</p>
        <p className="text-xs uppercase tracking-[0.18em] text-white/48">
          {circuit.country}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
          <div className="text-white/42">Type</div>
          <div className="mt-1 font-medium text-white">
            {formatType(circuit.type)}
          </div>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
          <div className="flex items-center gap-1 text-white/42">
            <Trees className="h-3 w-3" />
            Env
          </div>
          <div className="mt-1 font-medium text-white">
            {circuit.hasEnvironment ? "Ready" : "Basic"}
          </div>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
          <div className="flex items-center gap-1 text-white/42">
            <Mountain className="h-3 w-3" />
            Terrain
          </div>
          <div className="mt-1 font-medium text-white">
            {circuit.hasTerrain ? "Ready" : "Flat"}
          </div>
        </div>
      </div>
      <Button
        className="mt-4 h-12 w-full gap-2 bg-red-600 text-sm font-semibold text-white hover:bg-red-500 md:h-10"
        onClick={() => onOpen(circuit)}
      >
        <ExternalLink className="h-4 w-4" />
        Open Circuit
      </Button>
    </div>
  );
}
