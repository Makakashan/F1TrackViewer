import { useState, useEffect } from "react";
import { CircuitGeoJSON, fetchCircuitGeoJson } from "@/lib/f1-circuits";
import { fetchElevations } from "@/lib/elevation-api";
import { useAppPref } from "@/components/app-pref-provider";

const ELEVATION_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

export function useTrackData(
	selectedId: string | null,
	setError: (msg: string | null) => void,
) {
	const { t } = useAppPref();
	const [loadingTrack, setLoadingTrack] = useState(false);
	const [elevations, setElevations] = useState<number[] | null>(null);
	const [loadingElevations, setLoadingElevations] = useState(false);
	const [geojson, setGeojson] = useState<CircuitGeoJSON | null>(null);

	useEffect(() => {
		if (!selectedId) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setLoadingTrack(true);
		setLoadingElevations(true);
		setElevations(null);
		setError(null);

		async function loadElevationsWithRetry(
			coords: [number, number][],
			attempt: number,
		) {
			setLoadingElevations(true);
			const result = await fetchElevations(coords, selectedId!);
			if (cancelled) return;

			if (result !== null) {
				setElevations(result);
				setLoadingElevations(false);
				return;
			}

			setElevations([]);
			setLoadingElevations(false);

			const delay = ELEVATION_RETRY_DELAYS_MS[attempt];
			if (delay == null) return;

			retryTimer = setTimeout(() => {
				void loadElevationsWithRetry(coords, attempt + 1);
			}, delay);
		}

		fetchCircuitGeoJson(selectedId!)
			.then((g) => {
				if (cancelled) return;
				setGeojson(g);
				const coords = g.features[0]?.geometry.coordinates ?? [];
				void loadElevationsWithRetry(coords, 0);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(`${t.errLoadTrack} ${selectedId}: ${String(e)}`);
					setLoadingElevations(false);
				}
			})
			.finally(() => {
				if (cancelled) return;
				setLoadingTrack(false);
			});
		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [selectedId]);
	return { geojson, loadingTrack, elevations, loadingElevations };
}
