"use client";

import { useEffect } from "react";
import { useStore } from "@react-three/fiber";

/**
 * Publishes the R3F store on `window.__f1three` during development.
 *
 * The scene lives in its own reconciler, so nothing about it is reachable from
 * the DOM — no camera, no controls, no object positions. That makes every
 * visual check a screenshot and a guess. With the store exposed, a dev session
 * (or a browser-automation check) can place the camera precisely and read back
 * where things actually ended up.
 *
 * Rendered only when NODE_ENV is development; the production bundle drops it.
 */
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
