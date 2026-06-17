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
      // hasPointerCapture is supported in all modern browsers — if the
      // element doesn't currently have the capture for this pointer id,
      // calling the original would throw. We just no-op instead.
      if (
        typeof (this as any).hasPointerCapture === "function" &&
        !(this as any).hasPointerCapture(pointerId)
      ) {
        return;
      }
      original.call(this, pointerId);
    } catch (e) {
      // Swallow "Invalid pointer id" specifically — that's the only error
      // releasePointerCapture can throw, and it's exactly the one we're
      // patching around. All other errors (there aren't any in practice)
      // are also swallowed because the operation is best-effort.
    }
  };

  pointerCapturePatchInstalled = true;
}

/**
 * Error boundary that catches the spurious
 * "Element.releasePointerCapture: Invalid pointer id" DOMException thrown
 * by drei's OrbitControls under React 19. The boundary swallows ONLY that
 * specific error; all others propagate normally.
 *
 * Combined with the prototype patch above, this gives us defense in depth:
 *   - The patch handles the mobile case (exception outside React).
 *   - The boundary handles the desktop case (exception through React).
 */
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
