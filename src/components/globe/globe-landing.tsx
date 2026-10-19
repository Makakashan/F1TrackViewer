"use client";

import { Canvas } from "@react-three/fiber";
import { List } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import GlobeEarth from "./globe-earth";
import GlobeInfoCard from "./globe-info-card";
import RaceModeButton from "./race-mode-button";
import { CircuitPicker } from "./circuit-picker";
import { GlobeStage, StartScreen, useStarted } from "./start-screen";
import { WhatsNew, useWhatsNew } from "./whats-new";
import type { GlobeCircuit } from "./globe-marker";
import { useAppPref } from "@/components/app-pref-provider";
import { BrandMark } from "@/components/brand";
import { SiteHeader, buttons } from "@/components/site-header";
import { continentCentroid, type Continent } from "@/lib/circuit-meta";

const DEFAULT_CAMERA_CONTINENT: Continent = "europe";

interface CircuitsIndex {
	schemaVersion: number;
	circuits: GlobeCircuit[];
}

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
	const { resolvedTheme, t } = useAppPref();
	const [started, start] = useStarted();
	const whatsNew = useWhatsNew();
	const [circuits, setCircuits] = useState<GlobeCircuit[]>([]);
	const [loading, setLoading] = useState(true);
	const [earthReady, setEarthReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedCircuit, setSelectedCircuit] = useState<GlobeCircuit | null>(
		null,
	);
	const [hoveredCircuit, setHoveredCircuit] = useState<GlobeCircuit | null>(
		null,
	);
	const [cardTopPx, setCardTopPx] = useState(0);

	useEffect(() => {
		let cancelled = false;
		fetch("/circuits-index.json")
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
	const focusRegion = useMemo(
		() => continentCentroid(circuits, DEFAULT_CAMERA_CONTINENT),
		[circuits],
	);
	const filteredCircuits = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = needle
			? circuits.filter((circuit) =>
					[circuit.name, circuit.shortName, circuit.country, circuit.id].some(
						(value) => value.toLowerCase().includes(needle),
					),
				)
			: circuits;
		return [...list].sort((a, b) => a.shortName.localeCompare(b.shortName));
	}, [circuits, query]);
	// The start screen stands in for the loader until Start is pressed.
	const showLoading = started === true && (loading || !earthReady);
	const effectiveCardTop = activeCircuit && !mobileMenuOpen ? cardTopPx : 0;

	const handleSelectCircuit = useCallback((circuit: GlobeCircuit | null) => {
		setSelectedCircuit(circuit);
		if (circuit) setHoveredCircuit(null);
	}, []);

	const handleOpenCircuit = useCallback((circuit: GlobeCircuit) => {
		window.location.href = openCircuitSearch(circuit);
	}, []);

	return (
		<main className="relative h-dvh w-screen overflow-hidden bg-background text-foreground [--picker-width:clamp(260px,32vw,720px)]">
			{/* The chrome waits for Start: before it the screen is the title and the globe. */}
			<div className={`transition-opacity duration-700 ${started ? "opacity-100" : "pointer-events-none opacity-0"}`}>
				<SiteHeader nav={<button onClick={whatsNew.show} className="hover:text-foreground">{t.whatsNewButton}</button>}>
					<button onClick={() => setMobileMenuOpen(true)} className={`${buttons.secondary} md:hidden`}>
						<List className="h-3.5 w-3.5" /> {t.circuits}
					</button>
					<RaceModeButton circuits={circuits} />
				</SiteHeader>
			</div>

			<Canvas
				camera={{ position: [0, 0.8, 6.5], fov: 42 }}
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
					focusRegion={focusRegion}
					cardTopPx={effectiveCardTop}
					theme={resolvedTheme}
					onHoverCircuit={setHoveredCircuit}
					onSelectCircuit={handleSelectCircuit}
					onClearHover={() => setHoveredCircuit(null)}
					onEarthReady={() => setEarthReady(true)}
				/>
				<GlobeStage started={started} />
			</Canvas>

			<StartScreen
				started={started}
				circuitCount={circuits.length}
				onStart={start}
				whatsNewUnseen={whatsNew.unseen}
				onWhatsNew={whatsNew.show}
			/>
			<WhatsNew open={whatsNew.open} onClose={whatsNew.close} />

			<div className={`transition-opacity duration-700 ${started ? "opacity-100" : "pointer-events-none opacity-0"}`}>
				<CircuitPicker
					circuits={filteredCircuits}
					query={query}
					setQuery={setQuery}
					selectedId={selectedCircuit?.id ?? null}
					onSelect={handleSelectCircuit}
					onHover={setHoveredCircuit}
				/>

				{mobileMenuOpen && (
					<CircuitPicker
						sheet
						onClose={() => setMobileMenuOpen(false)}
						circuits={filteredCircuits}
						query={query}
						setQuery={setQuery}
						selectedId={selectedCircuit?.id ?? null}
						onSelect={(circuit) => {
							handleSelectCircuit(circuit);
							setMobileMenuOpen(false);
						}}
						onHover={() => {}}
					/>
				)}
			</div>

			{showLoading && (
				<div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm">
					<BrandMark className="h-12 w-12 animate-pulse rounded-[12px] outline outline-1 -outline-offset-1 outline-border" />
					<div className="text-[13px] text-muted-foreground">
						{loading ? t.loadingCircuits : t.loadingGlobe}
					</div>
				</div>
			)}
			{error && (
				<div className="absolute left-3 right-3 top-[73px] z-30 rounded-[10px] border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive md:left-auto md:right-4">
					{error}
				</div>
			)}

			<GlobeInfoCard
				circuit={mobileMenuOpen || !started ? null : activeCircuit}
				onOpen={handleOpenCircuit}
				onRectChange={(rect) => {
					setCardTopPx(rect.top);
				}}
			/>
		</main>
	);
}
