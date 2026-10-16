"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useAppPref } from "@/components/app-pref-provider";

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
 * Lets the top of the globe rise from the bottom right while the start screen is up, and
 * eases it into the middle when Start is pressed. A view offset rather than a
 * moved camera, so the globe's own framing — which continent it faces, how far
 * it sits — is the same before and after.
 */
export function GlobeStage({ started }: { started: boolean | null }) {
  const away = useRef<number | null>(null);
  const idle = useRef(true);

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
    // Settled in the middle: nothing to do. Waiting, it follows the window's size.
    if (away.current === 0 && target === 0 && !camera.view?.enabled) return;
    away.current = THREE.MathUtils.damp(away.current, target, SETTLE_RATE, delta);
    if (Math.abs(away.current - target) < 1e-3) away.current = target;
    const k = away.current;
    camera.zoom = 1 - (1 - WAITING_ZOOM) * k;
    if (k === 0) {
      camera.clearViewOffset();
    } else {
      // Centre past the bottom edge, so only the crown shows. Landscape: also past the right edge.
      const portrait = size.height > size.width;
      const right = portrait ? 0 : 0.32 * size.width;
      const down = (portrait ? 0.72 : 0.55) * size.height;
      camera.setViewOffset(size.width, size.height, -right * k, -down * k, size.width, size.height);
    }
    camera.updateProjectionMatrix();
  });
  return null;
}

/** A strip of chequered flag, drawn rather than shipped as an image. */
const CHEQUER = {
  backgroundImage: "repeating-conic-gradient(currentColor 0 25%, transparent 0 50%)",
  backgroundSize: "8px 8px",
};
/** Each line of the title block rises in after the one above it. */
const RISE = "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-700";
const after = (ms: number) => ({ animationDelay: `${ms}ms` });

/** The title, what the app holds, and the Start button, over the globe on the left. */
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
  const facts = [
    { value: circuitCount > 0 ? String(circuitCount) : "··", label: t.startFactCircuits },
    { value: "3D", label: t.startFactTerrain },
    { value: "LIVE", label: t.startFactRace },
  ];
  return (
    <div
      className={`absolute inset-0 z-30 flex items-start px-6 pt-[12vh] transition-opacity duration-700 md:items-center md:px-[8vw] md:pt-0 ${
        waiting ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <button
        className={`${RISE} absolute right-5 top-5 flex items-center gap-2 rounded-full border border-foreground/15 bg-background/60 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-foreground/75 backdrop-blur transition hover:border-red-600/60 hover:text-foreground md:right-8 md:top-8`}
        style={after(600)}
        onClick={onWhatsNew}
      >
        {whatsNewUnseen && <span className="size-2 rounded-full bg-red-600" />}
        {t.whatsNewButton}
      </button>
      <div className="max-w-xl md:-mt-[10vh]">
        <div className={`${RISE} flex items-center gap-3`}>
          <span className="h-3 w-10 -skew-x-12 text-foreground/80" style={CHEQUER} />
          <span className="font-mono text-[11px] uppercase tracking-[0.35em] text-foreground/55">
            {t.startKicker}
          </span>
        </div>
        <h1
          className={`${RISE} mt-5 font-(family-name:--font-timing) text-5xl font-black italic leading-[0.88] tracking-tight md:text-8xl`}
          style={after(100)}
        >
          <span className="text-red-600">F1</span> TRACK
          <br />
          <span className="text-transparent [-webkit-text-stroke:2px_var(--foreground)]">STUDIO</span>
        </h1>
        <div className={`${RISE} mt-6 flex items-center gap-1.5`} style={after(200)}>
          <span className="h-1 w-24 -skew-x-12 bg-red-600" />
          <span className="h-1 w-6 -skew-x-12 bg-red-600/60" />
          <span className="h-1 w-3 -skew-x-12 bg-red-600/30" />
        </div>
        <p className={`${RISE} mt-5 max-w-md text-base text-foreground/65`} style={after(250)}>{t.startTagline}</p>
        <dl className={`${RISE} mt-8 flex gap-8`} style={after(350)}>
          {facts.map((fact) => (
            <div key={fact.label} className="border-l-2 border-red-600/70 pl-3">
              <dt className="sr-only">{fact.label}</dt>
              <dd className="font-(family-name:--font-timing) text-3xl font-black italic leading-none">
                {fact.value}
              </dd>
              <dd className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/50">
                {fact.label}
              </dd>
            </div>
          ))}
        </dl>
        <button
          className={`${RISE} group mt-10 flex -skew-x-12 items-center gap-4 bg-red-600 py-4 pl-8 pr-6 text-white shadow-[0_12px_40px_rgba(225,6,0,0.35)] transition hover:bg-red-500 hover:shadow-[0_16px_50px_rgba(225,6,0,0.5)] active:scale-[0.98]`}
          style={after(450)}
          onClick={onStart}
        >
          <span className="skew-x-12 text-base font-black uppercase italic tracking-[0.25em]">
            {t.startButton}
          </span>
          <span className="skew-x-12 transition-transform group-hover:translate-x-1">→</span>
        </button>
      </div>
    </div>
  );
}
