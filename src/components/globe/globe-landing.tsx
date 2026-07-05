"use client";

import { Canvas } from "@react-three/fiber";
import { Eye, EyeOff, Flag, List, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import GlobeEarth from "./globe-earth";
import GlobeInfoCard from "./globe-info-card";
import type { GlobeCircuit } from "./globe-marker";
import { countryFlag, countryFromId } from "@/lib/f1-circuits";

interface CircuitsIndex {
  schemaVersion: number;
  circuits: GlobeCircuit[];
}

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function openCircuitSearch(circuit: GlobeCircuit) {
  const params = new URLSearchParams();
  params.set("track", circuit.id);
  params.set("width", "7");
  params.set("elevation", "1");
  params.set("sectors", "0");
  params.set("realwidth", "0");
  if (circuit.hasEnvironment) {
    params.set("environment", "1");
    params.set("terrain", "1");
  }
  return `?${params.toString()}`;
}

export default function GlobeLanding() {
  const [circuits, setCircuits] = useState<GlobeCircuit[]>([]);
  const [loading, setLoading] = useState(true);
  const [earthReady, setEarthReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedCircuit, setSelectedCircuit] = useState<GlobeCircuit | null>(
    null,
  );
  const [hoveredCircuit, setHoveredCircuit] = useState<GlobeCircuit | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${PUBLIC_BASE_PATH}/circuits-index.json`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load circuit index: ${response.status}`);
        }
        return response.json() as Promise<CircuitsIndex>;
      })
      .then((index) => {
        if (cancelled) return;
        setCircuits(index.circuits);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeCircuit = useMemo(
    () => hoveredCircuit ?? selectedCircuit,
    [hoveredCircuit, selectedCircuit],
  );
  const filteredCircuits = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return circuits;
    return circuits.filter((circuit) =>
      [circuit.name, circuit.shortName, circuit.country, circuit.id].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }, [circuits, query]);
  const showLoading = loading || !earthReady;

  const handleSelectCircuit = useCallback((circuit: GlobeCircuit | null) => {
    setSelectedCircuit(circuit);
    if (circuit) setHoveredCircuit(null);
  }, []);

  const handleOpenCircuit = useCallback((circuit: GlobeCircuit) => {
    window.location.href = openCircuitSearch(circuit);
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#03050a] text-white">
      <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_50%_45%,transparent_0%,rgba(3,5,10,0.08)_45%,rgba(3,5,10,0.72)_100%)]" />
      <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-4 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-linear-to-br from-red-600 to-orange-600 shadow-[0_0_24px_rgba(225,6,0,0.45)]">
            <Flag className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight">
              F1 Track Studio
            </div>
            <div className="hidden text-[10px] uppercase tracking-[0.22em] text-white/45 sm:block">
              Globe Circuit Selector
            </div>
          </div>
        </div>
        <div className="hidden rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-white/50 backdrop-blur md:block">
          Drag to rotate
        </div>
      </header>

      <Canvas
        camera={{ position: [0, 0.6, 5.2], fov: 42 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
        onPointerMissed={() => {
          setSelectedCircuit(null);
          setHoveredCircuit(null);
        }}
      >
        <GlobeEarth
          circuits={circuits}
          selectedCircuit={selectedCircuit}
          hoveredCircuit={hoveredCircuit}
          focusCircuit={selectedCircuit}
          onHoverCircuit={setHoveredCircuit}
          onSelectCircuit={handleSelectCircuit}
          onClearHover={() => setHoveredCircuit(null)}
          onEarthReady={() => setEarthReady(true)}
        />
      </Canvas>

      {sidebarOpen ? (
        <aside className="absolute bottom-4 left-4 top-24 z-20 hidden w-[300px] flex-col overflow-hidden rounded-md border border-white/10 bg-black/58 shadow-2xl shadow-black/40 backdrop-blur-xl md:flex">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/62">
              <List className="h-3.5 w-3.5 text-red-300" />
              Circuits
            </div>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-white/52 hover:bg-white/10 hover:text-white"
              onClick={() => setSidebarOpen(false)}
              aria-label="Hide circuit menu"
            >
              <EyeOff className="h-4 w-4" />
            </button>
          </div>
          <div className="border-b border-white/10 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/34" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search circuit"
                className="h-9 w-full rounded-md border border-white/10 bg-white/[0.04] pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/32 focus:border-red-400/60"
              />
            </div>
          </div>
          <div className="f1tv-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {filteredCircuits.map((circuit) => {
              const selected = selectedCircuit?.id === circuit.id;
              return (
                <button
                  key={circuit.id}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition ${
                    selected
                      ? "border border-red-500/45 bg-red-950/42 text-white"
                      : "border border-transparent text-white/72 hover:bg-white/[0.06] hover:text-white"
                  }`}
                  onClick={() => handleSelectCircuit(circuit)}
                >
                  <span className="w-5 text-base leading-none">
                    {countryFlag(countryFromId(circuit.id))}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {circuit.shortName}
                    </span>
                    <span className="block truncate text-xs text-white/42">
                      {circuit.name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      ) : (
        <button
          className="absolute left-4 top-24 z-20 hidden h-10 items-center gap-2 rounded-md border border-white/10 bg-black/58 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/62 backdrop-blur-xl hover:bg-white/10 hover:text-white md:flex"
          onClick={() => setSidebarOpen(true)}
        >
          <Eye className="h-4 w-4" />
          Circuits
        </button>
      )}

      <button
        className="absolute left-4 top-24 z-20 flex h-10 items-center gap-2 rounded-md border border-white/10 bg-black/58 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/68 backdrop-blur-xl active:bg-white/10 md:hidden"
        onClick={() => setMobileMenuOpen(true)}
      >
        <List className="h-4 w-4 text-red-300" />
        Circuits
      </button>

      {mobileMenuOpen && (
        <div className="absolute inset-x-3 bottom-3 top-20 z-40 flex flex-col overflow-hidden rounded-md border border-white/12 bg-black/82 shadow-2xl shadow-black/50 backdrop-blur-xl md:hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/68">
              <List className="h-3.5 w-3.5 text-red-300" />
              Circuits
            </div>
            <button
              className="flex h-9 w-9 items-center justify-center rounded-md text-white/58 active:bg-white/10 active:text-white"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close circuit menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="border-b border-white/10 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/34" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search circuit"
                className="h-11 w-full rounded-md border border-white/10 bg-white/[0.05] pl-9 pr-3 text-base text-white outline-none placeholder:text-white/32 focus:border-red-400/60"
              />
            </div>
          </div>
          <div className="f1tv-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {filteredCircuits.map((circuit) => {
              const selected = selectedCircuit?.id === circuit.id;
              return (
                <button
                  key={circuit.id}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition ${
                    selected
                      ? "border border-red-500/45 bg-red-950/42 text-white"
                      : "border border-transparent text-white/74 active:bg-white/[0.08]"
                  }`}
                  onClick={() => {
                    handleSelectCircuit(circuit);
                    setMobileMenuOpen(false);
                  }}
                >
                  <span className="w-6 text-lg leading-none">
                    {countryFlag(countryFromId(circuit.id))}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-base font-medium">
                      {circuit.shortName}
                    </span>
                    <span className="block truncate text-xs text-white/42">
                      {circuit.name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showLoading && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#03050a]/72 text-white backdrop-blur-sm">
          <div className="relative flex h-48 w-48 items-center justify-center">
            <div className="absolute inset-0 rounded-full border border-white/10 shadow-[0_0_70px_rgba(225,6,0,0.14)]" />
            <div className="absolute inset-4 rounded-full border border-dashed border-white/14" />
            <div className="absolute inset-0 rounded-full border border-transparent border-b-primary/65 border-r-primary/25" />
            <div className="absolute inset-0 animate-spin [animation-duration:1.35s]">
              <div className="relative mx-auto h-8 w-12 -translate-y-3">
                <div className="absolute left-1/2 top-5 h-1.5 w-10 -translate-x-1/2 rounded-full bg-primary/35 blur-sm" />
                <div className="absolute left-1/2 top-3 h-2 w-9 -translate-x-1/2 rounded-[999px_999px_5px_5px] bg-primary shadow-[0_0_18px_rgba(225,6,0,0.75)]" />
                <div className="absolute left-1/2 top-1 h-4 w-4 -translate-x-1/2 rounded-t-full border-t border-white/60 bg-white/20" />
                <div className="absolute left-0 top-4 h-2 w-2 rounded-full bg-white/82 shadow-[0_0_8px_rgba(255,255,255,0.45)]" />
                <div className="absolute right-0 top-4 h-2 w-2 rounded-full bg-white/82 shadow-[0_0_8px_rgba(255,255,255,0.45)]" />
                <div className="absolute left-1/2 top-2 h-7 w-0.5 -translate-x-1/2 rounded-full bg-white/75" />
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-primary">
                F1 Track Studio
              </div>
              <div className="mt-2 text-sm font-semibold text-white/88">
                {loading ? "Loading circuits" : "Preparing globe"}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-white/38">
                telemetry map
              </div>
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute left-3 right-3 top-20 z-30 rounded-md border border-red-500/35 bg-red-950/70 px-3 py-2 text-sm text-red-100 backdrop-blur md:left-6 md:right-auto">
          {error}
        </div>
      )}

      <GlobeInfoCard
        circuit={mobileMenuOpen ? null : activeCircuit}
        onOpen={handleOpenCircuit}
      />
    </main>
  );
}
