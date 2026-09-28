"use client";

import { X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAppPref } from "@/components/app-pref-provider";

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
/** Bumped with each release the panel describes, so a returning visitor sees the next one once. */
const RELEASE = "2026-10-monaco";
const SEEN_KEY = "f1tv-whats-new";

const noSubscription = () => () => {};
const unseenHere = () => localStorage.getItem(SEEN_KEY) !== RELEASE;
const seenOnServer = () => false;

/** Whether the panel is up — on its own once per release, and on demand after that. */
export function useWhatsNew(): { open: boolean; show: () => void; close: () => void; unseen: boolean } {
  const unseen = useSyncExternalStore(noSubscription, unseenHere, seenOnServer);
  const [dismissed, setDismissed] = useState(false);
  const [asked, setAsked] = useState(false);
  return {
    open: asked || (unseen && !dismissed),
    unseen: unseen && !dismissed,
    show: () => setAsked(true),
    close: () => {
      localStorage.setItem(SEEN_KEY, RELEASE);
      setDismissed(true);
      setAsked(false);
    },
  };
}

const VIEWS = ["iso", "top"] as const;
type View = (typeof VIEWS)[number];

/** Monaco on `main` beside Monaco now, from one camera preset, and what else changed. */
export function WhatsNew({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useAppPref();
  const [view, setView] = useState<View>("iso");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const shots = [
    { label: t.whatsNewBefore, src: `${PUBLIC_BASE_PATH}/whats-new/monaco-${view}-before.webp`, after: false },
    { label: t.whatsNewAfter, src: `${PUBLIC_BASE_PATH}/whats-new/monaco-${view}-after.webp`, after: true },
  ];
  const changes = [
    [t.whatsNewCityTitle, t.whatsNewCityText],
    [t.whatsNewHarbourTitle, t.whatsNewHarbourText],
    [t.whatsNewStartTitle, t.whatsNewStartText],
    [t.whatsNewPhonesTitle, t.whatsNewPhonesText],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm animate-in fade-in duration-300 md:p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="relative max-h-full w-full max-w-5xl overflow-y-auto rounded-2xl border border-foreground/10 bg-background shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-500"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="h-1.5 w-full bg-red-600" />
        <button
          aria-label={t.whatsNewClose}
          className="absolute right-4 top-5 rounded-full p-2 text-foreground/50 transition hover:bg-foreground/10 hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-5" />
        </button>

        <div className="px-5 pb-5 pt-5 md:px-8">
          <div className="flex items-center gap-3">
            <span
              className="h-3 w-10 -skew-x-12 text-foreground/80"
              style={{
                backgroundImage: "repeating-conic-gradient(currentColor 0 25%, transparent 0 50%)",
                backgroundSize: "8px 8px",
              }}
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.35em] text-red-600">{t.whatsNewKicker}</span>
          </div>
          <h2
            id="whats-new-title"
            className="mt-3 text-3xl font-black italic tracking-tight md:text-5xl"
          >
            {t.whatsNewTitle}
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-foreground/65 md:text-base">{t.whatsNewLead}</p>

          <div className="mt-5 flex gap-1 rounded-lg bg-foreground/5 p-1 text-xs font-semibold uppercase tracking-[0.15em] md:w-fit">
            {VIEWS.map((key) => (
              <button
                key={key}
                className={`flex-1 rounded-md px-4 py-2 transition md:flex-none ${
                  view === key ? "bg-background text-foreground shadow-sm" : "text-foreground/50 hover:text-foreground"
                }`}
                onClick={() => setView(key)}
              >
                {key === "iso" ? t.whatsNewViewIso : t.whatsNewViewTop}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {shots.map((shot) => (
              <figure
                key={shot.label}
                className={`relative overflow-hidden rounded-xl border ${
                  shot.after ? "border-red-600/60 shadow-[0_10px_40px_rgba(225,6,0,0.18)]" : "border-foreground/10"
                }`}
              >
                <img src={shot.src} alt={`Monaco — ${shot.label}`} className="aspect-[16/10] w-full object-cover" />
                <figcaption
                  className={`absolute left-3 top-3 -skew-x-12 px-3 py-1 text-[11px] font-black uppercase italic tracking-[0.2em] ${
                    shot.after ? "bg-red-600 text-white" : "bg-background/85 text-foreground/70"
                  }`}
                >
                  <span className="inline-block skew-x-12">{shot.label}</span>
                </figcaption>
              </figure>
            ))}
          </div>

          <ul className="mt-5 grid gap-x-8 gap-y-3 md:grid-cols-2">
            {changes.map(([title, text]) => (
              <li key={title} className="border-l-2 border-red-600/70 pl-3">
                <div className="text-sm font-bold">{title}</div>
                <div className="mt-0.5 text-sm text-foreground/60">{text}</div>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex justify-end">
            <button
              className="flex -skew-x-12 items-center gap-3 bg-red-600 px-7 py-3 text-white shadow-[0_10px_30px_rgba(225,6,0,0.3)] transition hover:bg-red-500 active:scale-[0.98]"
              onClick={onClose}
            >
              <span className="skew-x-12 text-sm font-black uppercase italic tracking-[0.2em]">{t.whatsNewDone}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
