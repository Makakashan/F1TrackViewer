"use client";

import { useEffect, useState } from "react";
import { lookSettingsJson, useLookLab, type LookSettings } from "@/lib/look-lab";
import { cn } from "@/lib/utils";

/** Development tool for the scene-look spike; English only, like the admin labs. */

type KeysOf<T> = { [K in keyof LookSettings]: LookSettings[K] extends T ? K : never }[keyof LookSettings];

const SLIDERS: { key: KeysOf<number>; label: string; min: number; max: number; step: number }[] = [
  { key: "heliHeightM", label: "Heli height, m", min: 10, max: 160, step: 1 },
  { key: "heliBackM", label: "Heli behind, m", min: -80, max: 120, step: 1 },
  { key: "heliLateralM", label: "Heli aside, m", min: -80, max: 80, step: 1 },
  { key: "heliFovDeg", label: "FOV, °", min: 10, max: 60, step: 1 },
  { key: "sunAzimuthDeg", label: "Sun azimuth, °", min: 0, max: 360, step: 1 },
  { key: "sunElevationDeg", label: "Sun elevation, °", min: 5, max: 85, step: 1 },
  { key: "sunIntensity", label: "Sun", min: 0, max: 8, step: 0.1 },
  { key: "skyIntensity", label: "Sky fill", min: 0, max: 4, step: 0.05 },
  { key: "exposure", label: "Exposure", min: 0.4, max: 2, step: 0.01 },
  { key: "shadowSoftness", label: "Shadow softness", min: 0, max: 8, step: 0.1 },
  { key: "shadowNormalBias", label: "Shadow bias", min: 0, max: 0.3, step: 0.005 },
];

const TOGGLES: { key: KeysOf<boolean>; label: string }[] = [
  { key: "asphalt", label: "Asphalt texture" },
  { key: "rubber", label: "Rubber" },
  { key: "barriers", label: "Barriers" },
  { key: "fences", label: "Fences" },
  { key: "ground", label: "Ground plane" },
  { key: "city", label: "City" },
];

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.tagName === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox";
  }
  return element.tagName === "TEXTAREA" || element.isContentEditable;
}

export default function LookLabPanel({ className }: { className?: string }) {
  const look = useLookLab();
  const load = useLookLab((s) => s.load);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  // L flips the A/B switch without taking the eye off the frame.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "KeyL" || event.repeat || isTyping(event.target)) return;
      const state = useLookLab.getState();
      state.set({ enabled: !state.enabled });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lookSettingsJson());
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard refused; the values are still in localStorage.
    }
  };

  return (
    <div
      className={cn(
        "pointer-events-auto w-60 rounded-lg border border-white/10 bg-black/75 p-2.5 font-mono text-[11px] text-white shadow-lg backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-widest text-white/60">Look lab</span>
        <button type="button" className="text-white/60 hover:text-white" onClick={() => setOpen((v) => !v)}>
          {open ? "–" : "+"}
        </button>
      </div>

      <button
        type="button"
        onClick={() => look.set({ enabled: !look.enabled })}
        className={cn(
          "mt-2 w-full rounded py-1.5 font-semibold uppercase tracking-wider",
          look.enabled ? "bg-[#e10600] text-white" : "bg-white/15 text-white/80",
        )}
      >
        {look.enabled ? "B · new look" : "A · as it was"} <span className="opacity-60">(L)</span>
      </button>

      {open && (
        <>
          <div className="mt-2 space-y-1.5">
            {SLIDERS.map(({ key, label, min, max, step }) => (
              <label key={key} className="block">
                <div className="flex justify-between text-white/70">
                  <span>{label}</span>
                  <span className="text-white">{look[key]}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={look[key]}
                  onChange={(event) => look.set({ [key]: Number(event.target.value) })}
                  className="w-full accent-[#e10600]"
                />
              </label>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-1">
            {TOGGLES.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-1.5 text-white/80">
                <input
                  type="checkbox"
                  checked={look[key]}
                  onChange={(event) => look.set({ [key]: event.target.checked })}
                  className="accent-[#e10600]"
                />
                {label}
              </label>
            ))}
          </div>

          <div className="mt-2 flex gap-1">
            <button type="button" onClick={copy} className="flex-1 rounded bg-white/15 py-1 hover:bg-white/25">
              {copied ? "Copied" : "Copy values"}
            </button>
            <button type="button" onClick={look.reset} className="flex-1 rounded bg-white/15 py-1 hover:bg-white/25">
              Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
