"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useAppPref } from "@/components/app-pref-provider";
import { BrandMark, GithubMark, REPO_URL } from "@/components/brand";
import { SiteHeader, buttons } from "@/components/site-header";

/** Once a session: a visitor who has pressed Start is not asked again until the tab closes. */
const SESSION_KEY = "f1tv-started";
/** How quickly the globe settles into the middle, per second. */
const SETTLE_RATE = 3.2;
/** OrbitControls' auto-rotate speed until the visitor first touches anything: a slow drift, not a spin. */
const IDLE_SPIN = 0.25;
/** Any of these, once past the start screen, means the visitor has taken over the globe. */
const INTERACTIONS = ["pointerdown", "wheel", "keydown"] as const;
/** How large the globe stands on the start screen, as a camera zoom. */
const WAITING_ZOOM = 1.25;
/** Below this width the circuit list is a sheet, not a panel beside the globe. */
const PANEL_MIN_WIDTH = 768;

/** The docked circuit list's width; `--picker-width` in globe-landing says the same in CSS. */
export const pickerWidth = (screenWidth: number) => Math.min(720, Math.max(260, 0.32 * screenWidth));

const noSubscription = () => () => {};
const seenThisSession = () => sessionStorage.getItem(SESSION_KEY) === "1";
// Unknown until hydration, so a reload past Start does not flash the start screen.
const unknownOnServer = () => null;

/** Whether the visitor is past the start screen (null until known), and the press that gets them there. */
export function useStarted(): [boolean | null, () => void] {
  const seen = useSyncExternalStore<boolean | null>(noSubscription, seenThisSession, unknownOnServer);
  const [pressed, setPressed] = useState(false);
  const start = () => {
    sessionStorage.setItem(SESSION_KEY, "1");
    setPressed(true);
  };
  return [seen === null ? null : seen || pressed, start];
}

/**
 * Lets the top of the globe rise from the bottom while the start screen is up, and
 * eases it into the space beside the circuit list when Start is pressed. A view
 * offset rather than a moved camera, so the globe's own framing — which continent
 * it faces, how far it sits — is the same before and after.
 */
export function GlobeStage({ started }: { started: boolean | null }) {
  const away = useRef<number | null>(null);
  const idle = useRef(true);
  const applied = useRef("");

  useEffect(() => {
    if (!started) return;
    const unlisten = () => {
      for (const type of INTERACTIONS) window.removeEventListener(type, stop);
    };
    const stop = () => {
      idle.current = false;
      unlisten();
    };
    for (const type of INTERACTIONS) window.addEventListener(type, stop);
    return unlisten;
  }, [started]);

  useFrame(({ camera: shared, controls, size }, delta) => {
    if (started === null) return;
    const orbit = controls as OrbitControlsImpl | null;
    if (orbit) {
      orbit.autoRotate = idle.current;
      orbit.autoRotateSpeed = IDLE_SPIN;
    }
    const camera = shared as THREE.PerspectiveCamera;
    const target = started ? 0 : 1;
    // The first known state is where the globe already stands, not somewhere it travels to.
    if (away.current === null) away.current = target;
    away.current = THREE.MathUtils.damp(away.current, target, SETTLE_RATE, delta);
    if (Math.abs(away.current - target) < 1e-3) away.current = target;
    const k = away.current;
    // Waiting: centred past the bottom edge, so only the crown shows. Started: centred in what the list leaves.
    const beside = size.width >= PANEL_MIN_WIDTH ? (pickerWidth(size.width) + 16) / 2 : 0;
    const right = beside * (1 - k);
    const down = (size.height > size.width ? 0.72 : 0.68) * size.height * k;
    const key = `${size.width}x${size.height}:${right.toFixed(1)}:${down.toFixed(1)}`;
    if (key === applied.current) return;
    applied.current = key;
    camera.zoom = 1 - (1 - WAITING_ZOOM) * k;
    if (right === 0 && down === 0) camera.clearViewOffset();
    else camera.setViewOffset(size.width, size.height, -right, -down, size.width, size.height);
    camera.updateProjectionMatrix();
  });
  return null;
}

/** The start screen: the mark, the name, one line and two buttons over the globe's crown. */
export function StartScreen({
  started,
  circuitCount,
  onStart,
  whatsNewUnseen,
  onWhatsNew,
}: {
  started: boolean | null;
  circuitCount: number;
  onStart: () => void;
  whatsNewUnseen: boolean;
  onWhatsNew: () => void;
}) {
  const { t } = useAppPref();
  const waiting = started === false;
  return (
    <div
      className={`absolute inset-0 z-30 flex flex-col transition-opacity duration-700 ${
        waiting ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <SiteHeader
        nav={
          <>
            <button onClick={onStart} className="hover:text-foreground">
              {t.circuits}
            </button>
            <button onClick={onWhatsNew} className="flex items-center gap-1.5 hover:text-foreground">
              {t.whatsNewButton}
              {whatsNewUnseen && <span className="size-1.5 rounded-full bg-red-600" />}
            </button>
          </>
        }
      >
        <button onClick={onStart} className={buttons.primary}>
          {t.startButton}
        </button>
      </SiteHeader>
      <div className="flex w-full flex-col items-center px-[clamp(20px,4vw,48px)] pb-12 pt-[calc(57px+clamp(40px,9vh,110px))] text-center">
        <BrandMark className="h-[clamp(56px,9vh,72px)] w-[clamp(56px,9vh,72px)] rounded-[17px] shadow-[0_32px_70px_-28px_rgb(0_0_0/0.5)] outline outline-1 -outline-offset-1 outline-border" />
        <h1 className="mt-7 text-[clamp(44px,7vw,84px)] font-semibold leading-none tracking-[-0.045em]">Boxlane</h1>
        <p className="mt-5 max-w-[620px] text-[clamp(15px,1.6vw,17px)] leading-[1.55] text-muted-foreground">
          {t.startLead(circuitCount)}
        </p>
        <div className="mt-10 flex gap-2.5 max-sm:w-full max-sm:max-w-xs max-sm:flex-col">
          <button onClick={onStart} className={`${buttons.primary} h-10 px-[18px] text-sm font-semibold`}>
            {t.startButton}
          </button>
          <a href={REPO_URL} className={`${buttons.secondary} h-10 px-[18px] text-sm font-medium text-foreground`}>
            <GithubMark /> {t.source}
          </a>
        </div>
      </div>
    </div>
  );
}
