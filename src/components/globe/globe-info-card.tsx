"use client";

import { ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppPref } from "@/components/app-pref-provider";
import { buttons } from "@/components/site-header";
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

export default function GlobeInfoCard({
  circuit,
  onOpen,
  onRectChange,
}: GlobeInfoCardProps) {
  const { t } = useAppPref();
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

  const rows = [
    [t.circuitType, formatType(circuit.type)],
    [t.city, circuit.hasEnvironment ? t.ready : t.notYet],
    [t.terrain, circuit.hasTerrain ? t.ready : t.notYet],
  ];
  return (
    <aside
      ref={ref}
      className="pointer-events-auto fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-[calc(0.75rem+env(safe-area-inset-left))] right-[calc(0.75rem+env(safe-area-inset-right))] z-20 md:inset-x-auto md:bottom-auto md:right-4 md:top-[73px] md:w-80"
    >
      <div className="rounded-[14px] border border-border bg-background/90 p-4 backdrop-blur-md">
        <div className="text-[13px] text-muted-foreground">{circuit.country}</div>
        <h2 className="mt-0.5 text-xl font-semibold tracking-[-0.02em]">{circuit.shortName}</h2>
        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{circuit.name}</p>
        <dl className="mt-4 divide-y divide-border border-y border-border text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between py-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <button onClick={() => onOpen(circuit)} className={`${buttons.primary} mt-4 h-10 w-full text-sm font-semibold`}>
          {t.openCircuit} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
