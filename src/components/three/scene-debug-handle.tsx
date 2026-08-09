"use client";

import { useEffect } from "react";
import { useStore } from "@react-three/fiber";

/** Publishes the R3F store on `window.__f1three` during development. */
export default function SceneDebugHandle() {
  const store = useStore();

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    (window as unknown as Record<string, unknown>).__f1three = store;
    return () => {
      delete (window as unknown as Record<string, unknown>).__f1three;
    };
  }, [store]);

  return null;
}
