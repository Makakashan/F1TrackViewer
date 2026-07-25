"use client";

import { Canvas } from "@react-three/fiber";
import { Eye, EyeOff, Flag, List, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import GlobeEarth from "./globe-earth";
import GlobeInfoCard from "./globe-info-card";
import type { GlobeCircuit } from "./globe-marker";
import { useAppPref } from "@/components/app-pref-provider";
import { countryFlag, countryFromId } from "@/lib/f1-circuits";
import {
	continentCentroid,
	getCircuitYear,
	getContinent,
	isCurrentCalendar,
	type Continent,
} from "@/lib/circuit-meta";

type FilterChip = "all" | Continent | "classic";
type SortMode = "name" | "continent" | "season";

const FILTER_CHIPS: { id: FilterChip; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "europe", label: "Europe" },
	{ id: "americas", label: "Americas" },
	{ id: "asia", label: "Asia" },
	{ id: "classic", label: "Classic" },
];

const SORT_MODES: { id: SortMode; label: string }[] = [
	{ id: "name", label: "A–Z" },
	{ id: "continent", label: "Continent" },
	{ id: "season", label: "Season" },
];

const CONTINENT_ORDER: Record<Continent, number> = {
	europe: 0,
	americas: 1,
	asia: 2,
};

const CONTINENT_LABELS: Record<Continent, string> = {
	europe: "Europe",
	americas: "Americas",
	asia: "Asia",
};

const DEFAULT_CAMERA_CONTINENT: Continent = "europe";

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
	const { resolvedTheme } = useAppPref();
	const [circuits, setCircuits] = useState<GlobeCircuit[]>([]);
	const [loading, setLoading] = useState(true);
	const [earthReady, setEarthReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [filterChip, setFilterChip] = useState<FilterChip>("all");
	const [sortMode, setSortMode] = useState<SortMode>("name");
	// Where the globe faces — defaults to Europe and only changes when the
	// user picks a continent chip. "All"/"Classic" narrow the list without
	// moving the camera.
	const [cameraContinent, setCameraContinent] = useState<Continent>(
		DEFAULT_CAMERA_CONTINENT,
	);
	const [selectedCircuit, setSelectedCircuit] = useState<GlobeCircuit | null>(
		null,
	);
	const [hoveredCircuit, setHoveredCircuit] = useState<GlobeCircuit | null>(
		null,
	);
	const [cardTopPx, setCardTopPx] = useState(0);

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
	const focusRegion = useMemo(
		() => continentCentroid(circuits, cameraContinent),
		[circuits, cameraContinent],
	);

	const handleFilterChip = useCallback((chip: FilterChip) => {
		setFilterChip(chip);
		if (chip !== "all" && chip !== "classic") {
			setCameraContinent(chip);
		}
	}, []);
	const filteredCircuits = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		let list = normalizedQuery
			? circuits.filter((circuit) =>
					[circuit.name, circuit.shortName, circuit.country, circuit.id].some(
						(value) => value.toLowerCase().includes(normalizedQuery),
					),
				)
			: circuits;

		if (filterChip === "classic") {
			list = list.filter((circuit) => !isCurrentCalendar(circuit.id));
		} else if (filterChip !== "all") {
			list = list.filter((circuit) => getContinent(circuit.id) === filterChip);
		}

		const sorted = [...list];
		if (sortMode === "name") {
			sorted.sort((a, b) => a.shortName.localeCompare(b.shortName));
		} else if (sortMode === "continent") {
			sorted.sort((a, b) => {
				const continentA =
					CONTINENT_ORDER[getContinent(a.id) as Continent] ?? 3;
				const continentB =
					CONTINENT_ORDER[getContinent(b.id) as Continent] ?? 3;
				if (continentA !== continentB) return continentA - continentB;
				return a.shortName.localeCompare(b.shortName);
			});
		} else {
			sorted.sort(
				(a, b) => (getCircuitYear(a.id) ?? 0) - (getCircuitYear(b.id) ?? 0),
			);
		}
		return sorted;
	}, [circuits, query, filterChip, sortMode]);
	const showLoading = loading || !earthReady;
	const effectiveCardTop = activeCircuit && !mobileMenuOpen ? cardTopPx : 0;

	const handleSelectCircuit = useCallback((circuit: GlobeCircuit | null) => {
		setSelectedCircuit(circuit);
		if (circuit) setHoveredCircuit(null);
	}, []);

	const handleOpenCircuit = useCallback((circuit: GlobeCircuit) => {
		window.location.href = openCircuitSearch(circuit);
	}, []);

	return (
		<main className="relative h-screen w-screen overflow-hidden bg-background text-foreground">
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
						<div className="hidden text-[10px] uppercase tracking-[0.22em] text-foreground/45 sm:block">
							Globe Circuit Selector
						</div>
					</div>
				</div>
				<div className="hidden rounded-md border border-foreground/10 bg-foreground/4 px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-foreground/50 backdrop-blur md:block">
					Drag to rotate
				</div>
			</header>

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
			</Canvas>

			{sidebarOpen ? (
				<aside className="absolute bottom-4 left-4 top-24 z-20 hidden w-75 flex-col overflow-hidden rounded-md border border-foreground/10 bg-background/58 shadow-2xl shadow-black/40 backdrop-blur-xl md:flex">
					<div className="flex items-center justify-between border-b border-foreground/10 px-3 py-3">
						<div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground/62">
							<List className="h-3.5 w-3.5 text-red-300" />
							Circuits
						</div>
						<button
							className="flex h-8 w-8 items-center justify-center rounded-md text-foreground/52 hover:bg-foreground/10 hover:text-foreground"
							onClick={() => setSidebarOpen(false)}
							aria-label="Hide circuit menu"
						>
							<EyeOff className="h-4 w-4" />
						</button>
					</div>
					<div className="space-y-2 border-b border-foreground/10 p-3">
						<div className="relative">
							<Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/34" />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search circuit"
								className="h-9 w-full rounded-md border border-foreground/10 bg-foreground/4 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-foreground/32 focus:border-red-400/60"
							/>
						</div>
						<div className="flex flex-wrap items-center gap-1">
							{FILTER_CHIPS.filter((chip) => chip.id !== "classic").map(
								(chip) => (
									<button
										key={chip.id}
										onClick={() => handleFilterChip(chip.id)}
										className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide transition ${
											filterChip === chip.id
												? "border-red-500/50 bg-red-950/50 text-white"
												: "border-foreground/12 text-foreground/52 hover:border-foreground/25 hover:text-foreground"
										}`}
									>
										{chip.label}
									</button>
								),
							)}
							<button
								onClick={() =>
									handleFilterChip(filterChip === "classic" ? "all" : "classic")
								}
								className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide transition ${
									filterChip === "classic"
										? "border-amber-400/50 bg-amber-950/40 text-amber-200"
										: "border-foreground/12 text-foreground/52 hover:border-amber-400/30 hover:text-amber-200/80"
								}`}
							>
								Classic
							</button>
						</div>
						<div className="grid grid-cols-3 gap-1 rounded-md border border-foreground/10 bg-foreground/3 p-1">
							{SORT_MODES.map((mode) => (
								<button
									key={mode.id}
									onClick={() => setSortMode(mode.id)}
									className={`rounded px-1.5 py-1 text-[10px] font-medium transition ${
										sortMode === mode.id
											? "bg-foreground/12 text-foreground"
											: "text-foreground/48 hover:text-foreground/80"
									}`}
								>
									{mode.label}
								</button>
							))}
						</div>
					</div>
					<div className="f1tv-scroll min-h-0 flex-1 overflow-y-auto p-2">
						{filteredCircuits.map((circuit, index) => {
							const selected = selectedCircuit?.id === circuit.id;
							const classic = !isCurrentCalendar(circuit.id);
							const continent = getContinent(circuit.id);
							const prevContinent =
								index > 0 ? getContinent(filteredCircuits[index - 1].id) : null;
							const showContinentHeader =
								sortMode === "continent" && continent !== prevContinent;
							return (
								<div key={circuit.id}>
									{showContinentHeader && (
										<div className="mb-1 mt-3 flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-foreground/38 first:mt-1">
											{continent ? CONTINENT_LABELS[continent] : "Other"}
											<span className="h-px flex-1 bg-foreground/10" />
										</div>
									)}
									<button
										className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition ${
											selected
												? "border border-red-500/45 bg-red-950/42 text-white"
												: "border border-transparent text-foreground/72 hover:bg-foreground/6 hover:text-foreground"
										}`}
										onClick={() => handleSelectCircuit(circuit)}
										onMouseEnter={() => setHoveredCircuit(circuit)}
										onMouseLeave={() => setHoveredCircuit(null)}
									>
										<span className="w-5 text-base leading-none">
											{countryFlag(countryFromId(circuit.id))}
										</span>
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-1.5">
												<span className="block truncate text-sm font-medium">
													{circuit.shortName}
												</span>
												{classic && (
													<span className="shrink-0 rounded-sm border border-amber-400/30 bg-amber-400/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300/80">
														Classic
													</span>
												)}
											</span>
											<span className="block truncate text-xs text-foreground/42">
												{circuit.name}
											</span>
										</span>
									</button>
								</div>
							);
						})}
					</div>
				</aside>
			) : (
				<button
					className="absolute left-4 top-24 z-20 hidden h-10 items-center gap-2 rounded-md border border-foreground/10 bg-background/58 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-foreground/62 backdrop-blur-xl hover:bg-foreground/10 hover:text-foreground md:flex"
					onClick={() => setSidebarOpen(true)}
				>
					<Eye className="h-4 w-4" />
					Circuits
				</button>
			)}

			<button
				className="absolute left-4 top-24 z-20 flex h-10 items-center gap-2 rounded-md border border-foreground/10 bg-background/58 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-foreground/68 backdrop-blur-xl active:bg-foreground/10 md:hidden"
				onClick={() => setMobileMenuOpen(true)}
			>
				<List className="h-4 w-4 text-red-300" />
				Circuits
			</button>

			{mobileMenuOpen && (
				<div className="absolute inset-x-3 bottom-3 top-20 z-40 flex flex-col overflow-hidden rounded-md border border-foreground/12 bg-background/82 shadow-2xl shadow-black/50 backdrop-blur-xl md:hidden">
					<div className="flex items-center justify-between border-b border-foreground/10 px-3 py-3">
						<div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground/68">
							<List className="h-3.5 w-3.5 text-red-300" />
							Circuits
						</div>
						<button
							className="flex h-9 w-9 items-center justify-center rounded-md text-foreground/58 active:bg-foreground/10 active:text-foreground"
							onClick={() => setMobileMenuOpen(false)}
							aria-label="Close circuit menu"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
					<div className="space-y-2 border-b border-foreground/10 p-3">
						<div className="relative">
							<Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/34" />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search circuit"
								className="h-11 w-full rounded-md border border-foreground/10 bg-foreground/5 pl-9 pr-3 text-base text-foreground outline-none placeholder:text-foreground/32 focus:border-red-400/60"
							/>
						</div>
						<div className="flex flex-wrap items-center gap-1">
							{FILTER_CHIPS.filter((chip) => chip.id !== "classic").map(
								(chip) => (
									<button
										key={chip.id}
										onClick={() => handleFilterChip(chip.id)}
										className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition ${
											filterChip === chip.id
												? "border-red-500/50 bg-red-950/50 text-white"
												: "border-foreground/12 text-foreground/52 active:border-foreground/25"
										}`}
									>
										{chip.label}
									</button>
								),
							)}
							<span className="mx-0.5 h-4 w-px shrink-0 bg-foreground/12" />
							<button
								onClick={() =>
									handleFilterChip(filterChip === "classic" ? "all" : "classic")
								}
								className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition ${
									filterChip === "classic"
										? "border-amber-400/50 bg-amber-950/40 text-amber-200"
										: "border-foreground/12 text-foreground/52 active:border-amber-400/30"
								}`}
							>
								Classic
							</button>
						</div>
						<div className="grid grid-cols-3 gap-1 rounded-md border border-foreground/10 bg-foreground/3 p-1">
							{SORT_MODES.map((mode) => (
								<button
									key={mode.id}
									onClick={() => setSortMode(mode.id)}
									className={`rounded px-1.5 py-1.5 text-[11px] font-medium transition ${
										sortMode === mode.id
											? "bg-foreground/12 text-foreground"
											: "text-foreground/48 active:text-foreground/80"
									}`}
								>
									{mode.label}
								</button>
							))}
						</div>
					</div>
					<div className="f1tv-scroll min-h-0 flex-1 overflow-y-auto p-2">
						{filteredCircuits.map((circuit, index) => {
							const selected = selectedCircuit?.id === circuit.id;
							const classic = !isCurrentCalendar(circuit.id);
							const continent = getContinent(circuit.id);
							const prevContinent =
								index > 0 ? getContinent(filteredCircuits[index - 1].id) : null;
							const showContinentHeader =
								sortMode === "continent" && continent !== prevContinent;
							return (
								<div key={circuit.id}>
									{showContinentHeader && (
										<div className="mb-1 mt-3 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground/38 first:mt-1">
											{continent ? CONTINENT_LABELS[continent] : "Other"}
											<span className="h-px flex-1 bg-foreground/10" />
										</div>
									)}
									<button
										className={`flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition ${
											selected
												? "border border-red-500/45 bg-red-950/42 text-white"
												: "border border-transparent text-foreground/74 active:bg-foreground/8"
										}`}
										onClick={() => {
											handleSelectCircuit(circuit);
											setMobileMenuOpen(false);
										}}
									>
										<span className="w-6 text-lg leading-none">
											{countryFlag(countryFromId(circuit.id))}
										</span>
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-1.5">
												<span className="block truncate text-base font-medium">
													{circuit.shortName}
												</span>
												{classic && (
													<span className="shrink-0 rounded-sm border border-amber-400/30 bg-amber-400/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300/80">
														Classic
													</span>
												)}
											</span>
											<span className="block truncate text-xs text-foreground/42">
												{circuit.name}
											</span>
										</span>
									</button>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{showLoading && (
				<div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/72 text-foreground backdrop-blur-sm">
					<div className="relative flex h-48 w-48 items-center justify-center">
						<div className="absolute inset-0 rounded-full border border-foreground/10 shadow-[0_0_70px_rgba(225,6,0,0.14)]" />
						<div className="absolute inset-4 rounded-full border border-dashed border-foreground/14" />
						<div className="absolute inset-0 rounded-full border border-transparent border-b-primary/65 border-r-primary/25" />
						<div className="absolute inset-0 animate-spin [animation-duration:1.35s]">
							<div className="relative mx-auto h-8 w-12 -translate-y-3">
								<div className="absolute left-1/2 top-5 h-1.5 w-10 -translate-x-1/2 rounded-full bg-primary/35 blur-sm" />
								<div className="absolute left-1/2 top-3 h-2 w-9 -translate-x-1/2 rounded-[999px_999px_5px_5px] bg-primary shadow-[0_0_18px_rgba(225,6,0,0.75)]" />
								<div className="absolute left-1/2 top-1 h-4 w-4 -translate-x-1/2 rounded-t-full border-t border-foreground/60 bg-foreground/20" />
								<div className="absolute left-0 top-4 h-2 w-2 rounded-full bg-foreground/82 shadow-[0_0_8px_rgba(255,255,255,0.45)]" />
								<div className="absolute right-0 top-4 h-2 w-2 rounded-full bg-foreground/82 shadow-[0_0_8px_rgba(255,255,255,0.45)]" />
								<div className="absolute left-1/2 top-2 h-7 w-0.5 -translate-x-1/2 rounded-full bg-foreground/75" />
							</div>
						</div>
						<div className="text-center">
							<div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-primary">
								F1 Track Studio
							</div>
							<div className="mt-2 text-sm font-semibold text-foreground/88">
								{loading ? "Loading circuits" : "Preparing globe"}
							</div>
							<div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-foreground/38">
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
				onRectChange={(rect) => {
					setCardTopPx(rect.top);
				}}
			/>
		</main>
	);
}
