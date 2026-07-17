"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const SESSION_KEY = "f1tv-intro-seen";
const THEME_STORAGE_KEY = "f1tv:theme";
const FADE_OUT_MS = 500;

function subscribeToSessionStorage() {
  return () => {};
}

function getClientIntroSeenSnapshot() {
  return sessionStorage.getItem(SESSION_KEY) === "1";
}

// Read synchronously (not via useAppPref/useEffect) so the iframe mounts
// with the right ?theme= on its very first render — changing an iframe's
// src after mount reloads it, which would restart the whole animation.
function resolveIntroTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "dark";
  }
}

function getServerIntroSeenSnapshot() {
  // Hide during SSR / the hydration-matching first paint; useSyncExternalStore
  // re-checks the real value on the client right after mount.
  return true;
}

interface IntroGateProps {
  children: React.ReactNode;
}

// Gates mounting of the real app behind the intro splash: the app tree
// below isn't rendered at all while the intro plays, so the heavy
// Three.js/globe init never runs in parallel with the animation. It only
// starts mounting (hidden, under the still-fading intro) once the intro's
// own "Enter Studio" button fires — a brief overlap instead of the full
// intro duration.
export default function IntroGate({ children }: IntroGateProps) {
  const seen = useSyncExternalStore(
    subscribeToSessionStorage,
    getClientIntroSeenSnapshot,
    getServerIntroSeenSnapshot,
  );
  const [dismissing, setDismissing] = useState(false);
  const [introGone, setIntroGone] = useState(false);
  const [introTheme] = useState(resolveIntroTheme);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const showIntro = !seen && !introGone;
  const showApp = seen || dismissing || introGone;

  useEffect(() => {
    if (seen || introGone) return;
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (
        typeof event.data === "object" &&
        event.data?.type === "f1-intro-enter"
      ) {
        sessionStorage.setItem(SESSION_KEY, "1");
        setDismissing(true);
        setTimeout(() => setIntroGone(true), FADE_OUT_MS);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [seen, introGone]);

  return (
    <>
      {showIntro && (
        <div
          className={`fixed inset-0 z-[9999] bg-background transition-opacity duration-500 ${
            dismissing ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <iframe
            ref={iframeRef}
            src={`${PUBLIC_BASE_PATH}/intro/f1-intro.html?theme=${introTheme}`}
            title="F1 Track Studio intro"
            className="absolute inset-0 h-[100dvh] w-full border-0"
            allow="autoplay"
          />
        </div>
      )}
      {showApp && children}
    </>
  );
}
