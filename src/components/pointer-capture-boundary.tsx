"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/**
 * Tiny error boundary that catches the spurious
 * "Element.releasePointerCapture: Invalid pointer id" error thrown by
 * @react-three/drei's OrbitControls under React 19.
 *
 * Root cause: React 19 changes how it handles pointer capture, and
 * OrbitControls calls `domElement.releasePointerCapture(pointerId)` on
 * pointerup even when no capture is active — which throws a DOMException
 * in some browsers. R3F surfaces that exception to React, which would
 * otherwise unmount the whole Canvas.
 *
 * This boundary swallows ONLY that specific error and re-renders the
 * children unchanged. Any other error propagates normally.
 */
export default class PointerCaptureBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: unknown): State | null {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    if (/pointer id|pointerId|releasePointerCapture/i.test(msg)) {
      // Swallow — this is the known R19 + drei race condition
      return { hasError: false };
    }
    // Real error — let it propagate
    return null;
  }

  componentDidCatch(error: unknown) {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    if (/pointer id|pointerId|releasePointerCapture/i.test(msg)) {
      // Silently ignore — known issue, no need to log
      return;
    }
    console.error("[TrackViewer] unhandled error:", error);
  }

  render() {
    return this.props.children;
  }
}
