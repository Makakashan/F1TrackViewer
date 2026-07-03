import { useCallback, useMemo, useState } from "react";
import {
  createCircuitMarkerSchema,
  formatMarkerExport,
} from "@/lib/start-finish";
import { START_FINISH_STORAGE_KEY } from "@/lib/scene-config";

export interface StartFinishCalibrationState {
  calibratedOverrides: Record<string, number>;
  calibratedStartFinishS: number | null;
  displayedStartFinishS: number;
  exportOverrides: Record<string, number>;
  currentMarkerExport: string;
  allMarkerExport: string;
  updateCalibratedStartFinish: (s: number) => void;
  resetCalibratedStartFinish: () => void;
}

export function useStartFinishCalibration(
  circuitId: string | undefined,
  resolvedStartFinishS: number | null,
): StartFinishCalibrationState {
  const [calibratedOverrides, setCalibratedOverrides] = useState<
    Record<string, number>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(START_FINISH_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const calibratedStartFinishS =
    circuitId && calibratedOverrides[circuitId] != null
      ? calibratedOverrides[circuitId]
      : null;

  const displayedStartFinishS =
    calibratedStartFinishS ?? resolvedStartFinishS ?? 0;

  const exportOverrides = useMemo(() => {
    if (!circuitId) return calibratedOverrides;
    return {
      ...calibratedOverrides,
      [circuitId]: Number(displayedStartFinishS.toFixed(5)),
    };
  }, [calibratedOverrides, circuitId, displayedStartFinishS]);

  const currentMarkerExport = useMemo(() => {
    if (!circuitId) return "";
    return JSON.stringify(
      createCircuitMarkerSchema(
        circuitId,
        displayedStartFinishS,
        true,
        calibratedStartFinishS != null
          ? "local admin calibration"
          : "current effective marker",
      ),
      null,
      2,
    );
  }, [calibratedStartFinishS, circuitId, displayedStartFinishS]);

  const allMarkerExport = useMemo(
    () => formatMarkerExport(exportOverrides),
    [exportOverrides],
  );

  const updateCalibratedStartFinish = useCallback(
    (s: number) => {
      if (!circuitId || typeof window === "undefined") return;
      const next = {
        ...calibratedOverrides,
        [circuitId]: Number(s.toFixed(5)),
      };
      setCalibratedOverrides(next);
      window.localStorage.setItem(
        START_FINISH_STORAGE_KEY,
        JSON.stringify(next),
      );
    },
    [calibratedOverrides, circuitId],
  );

  const resetCalibratedStartFinish = useCallback(() => {
    if (!circuitId || typeof window === "undefined") return;
    const next = { ...calibratedOverrides };
    delete next[circuitId];
    setCalibratedOverrides(next);
    window.localStorage.setItem(
      START_FINISH_STORAGE_KEY,
      JSON.stringify(next),
    );
  }, [calibratedOverrides, circuitId]);

  return {
    calibratedOverrides,
    calibratedStartFinishS,
    displayedStartFinishS,
    exportOverrides,
    currentMarkerExport,
    allMarkerExport,
    updateCalibratedStartFinish,
    resetCalibratedStartFinish,
  };
}
