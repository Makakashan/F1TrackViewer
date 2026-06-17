import { useState, useEffect, useCallback } from "react";
import { fetchCircuitIndex, type CircuitLocation } from "@/lib/f1-circuits";
import { useAppPref } from "@/components/app-pref-provider";

export function useCircuits(setError: (msg: string | null) => void) {
	const { t } = useAppPref();
	const [circuits, setCircuits] = useState<CircuitLocation[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loadingIndex, setLoadingIndex] = useState(true);

	useEffect(() => {
		let canceled = false;
		fetchCircuitIndex()
			.then((list) => {
				if (canceled) return;
				list.sort((a, b) => a.name.localeCompare(b.name));
				setCircuits(list);
				const initial = list.find((c) => c.id === "mc-1929") ?? list[0] ?? null;
				if (initial) setSelectedId(initial.id);
			})
			.catch((e) => {
				if (!canceled) setError(`${t.errLoadCircuits}: ${String(e)}`);
			})
			.finally(() => !canceled && setLoadingIndex(false));
		return () => {
			canceled = true;
		};
	}, []);

	const onSelect = useCallback((id: string) => setSelectedId(id), []);

	return { circuits, selectedId, loadingIndex, onSelect, setSelectedId };
}
