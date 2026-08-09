"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/** Monkey-patches Element.prototype.releasePointerCapture to silently no-op on invalid pointer ids (fixes React 19 + mobile touch + drei OrbitControls). */
let pointerCapturePatchInstalled = false;

function installPointerCapturePatch() {
  if (pointerCapturePatchInstalled) return;
  if (typeof window === "undefined") return;
  if (!("Element" in window) || !Element.prototype.releasePointerCapture) {
    return;
  }

  const original = Element.prototype.releasePointerCapture;
  // Save a reference so we can detect re-entrancy / re-installation.
  (Element.prototype as any).__originalReleasePointerCapture = original;

  Element.prototype.releasePointerCapture = function patchedReleasePointerCapture(
    this: Element,
    pointerId: number,
  ) {
    try {
      // hasPointerCapture is supported in all modern browsers.
      if (
        typeof (this as any).hasPointerCapture === "function" &&
        !(this as any).hasPointerCapture(pointerId)
      ) {
        return;
      }
      original.call(this, pointerId);
    } catch (e) {
      // Swallow "Invalid pointer id" specifically.
    }
  };

  pointerCapturePatchInstalled = true;
}

/** Error boundary that catches the spurious "Element.releasePointerCapture. */
export default class PointerCaptureBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  componentDidMount() {
    installPointerCapturePatch();
  }

  static getDerivedStateFromError(error: unknown): State | null {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    if (/pointer id|pointerId|releasePointerCapture/i.test(msg)) {
      return { hasError: false };
    }
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
      return;
    }
    console.error("[TrackViewer] unhandled error:", error);
  }

  render() {
    return this.props.children;
  }
}
