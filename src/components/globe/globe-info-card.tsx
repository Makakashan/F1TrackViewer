"use client";

import { ExternalLink, Map, Mountain, Route, Trees } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { GlobeCircuit } from "./globe-marker";

interface GlobeInfoCardProps {
  circuit: GlobeCircuit | null;
  onOpen: (circuit: GlobeCircuit) => void;
  onRectChange?: (rect: { top: number; height: number }) => void;
}

function formatType(type: string) {
  return type
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function StatusChip({
  active,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`rounded-full border px-2 py-1 text-[10px] font-medium leading-none ${
        active
          ? "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300 shadow-[0_0_18px_rgba(225,6,0,0.12)]"
          : "border-foreground/10 bg-foreground/4 text-foreground/42"
      }`}
    >
      {children}
    </span>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-foreground/10 bg-foreground/[0.035] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/38">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-foreground/82">{value}</div>
    </div>
  );
}

export default function GlobeInfoCard({
  circuit,
  onOpen,
  onRectChange,
}: GlobeInfoCardProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !onRectChange) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      onRectChange({ top: rect.top, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("orientationchange", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("orientationchange", update);
    };
  }, [circuit, onRectChange]);

  if (!circuit) return null;

  return (
    <aside
      ref={ref}
      className="pointer-events-auto fixed inset-x-3 bottom-3 z-20 md:inset-x-auto md:bottom-auto md:right-6 md:top-24 md:w-90"
    >
      <div className="space-y-3 rounded-2xl border border-foreground/10 bg-background/58 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <div className="rounded-2xl border border-foreground/10 bg-background/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_18px_50px_rgba(0,0,0,0.18)]">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-red-400">
              <Route className="h-3.5 w-3.5" />
              Circuit
            </div>
            <h2 className="text-2xl font-bold leading-tight text-foreground">
              {circuit.shortName}
            </h2>
            <p className="text-sm text-foreground/52">
              {circuit.name} · {circuit.country}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <StatusChip active>{formatType(circuit.type)}</StatusChip>
            <StatusChip active={circuit.hasEnvironment}>Environment</StatusChip>
            <StatusChip active={circuit.hasTerrain}>Terrain</StatusChip>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <InfoRow
            icon={<Map className="h-3.5 w-3.5" />}
            label="Country"
            value={circuit.country}
          />
          <InfoRow
            icon={<Route className="h-3.5 w-3.5" />}
            label="Type"
            value={formatType(circuit.type)}
          />
          <InfoRow
            icon={<Trees className="h-3.5 w-3.5" />}
            label="Env"
            value={circuit.hasEnvironment ? "Ready" : "Basic"}
          />
          <InfoRow
            icon={<Mountain className="h-3.5 w-3.5" />}
            label="Terrain"
            value={circuit.hasTerrain ? "Ready" : "Flat"}
          />
        </div>

        <Button
          className="h-11 w-full gap-2 rounded-lg bg-red-600 text-sm font-semibold text-white shadow-[0_0_18px_rgba(225,6,0,0.18)] hover:bg-red-500"
          onClick={() => onOpen(circuit)}
        >
          <ExternalLink className="h-4 w-4" />
          Open Circuit
        </Button>
      </div>
    </aside>
  );
}
