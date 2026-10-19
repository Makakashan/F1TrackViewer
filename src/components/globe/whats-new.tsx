"use client";

import { X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAppPref } from "@/components/app-pref-provider";

/** Bumped with each release the panel describes, so a returning visitor sees the next one once. */
const RELEASE = "2026-10-race-screen";
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

type Strings = ReturnType<typeof useAppPref>["t"];

/** One release: two views to flip between, each a before/after pair, and what changed. */
type Release = {
  id: string;
  title: string;
  lead: string;
  views: { key: string; label: string }[];
  changes: [string, string][];
};

/** Newest first; the panel opens on the first and keeps the rest under "Earlier". */
const releases = (t: Strings): Release[] => [
  {
    id: "race",
    title: t.whatsNewRaceTitle,
    lead: t.whatsNewRaceLead,
    views: [
      { key: "tower", label: t.whatsNewViewTower },
      { key: "editor", label: t.whatsNewViewEditor },
    ],
    changes: [
      [t.whatsNewTowerTitle, t.whatsNewTowerText],
      [t.whatsNewEditorTitle, t.whatsNewEditorText],
      [t.whatsNewMovesTitle, t.whatsNewMovesText],
      [t.whatsNewSpaceTitle, t.whatsNewSpaceText],
      [t.whatsNewTunnelTitle, t.whatsNewTunnelText],
      [t.whatsNewAddressTitle, t.whatsNewAddressText],
    ],
  },
  {
    id: "boxlane",
    title: t.whatsNewBoxlaneTitle,
    lead: t.whatsNewBoxlaneLead,
    views: [
      { key: "start", label: t.whatsNewViewStart },
      { key: "track", label: t.whatsNewViewTrack },
    ],
    changes: [
      [t.whatsNewNameTitle, t.whatsNewNameText],
      [t.whatsNewChromeTitle, t.whatsNewChromeText],
      [t.whatsNewPickerTitle, t.whatsNewPickerText],
      [t.whatsNewCitiesTitle, t.whatsNewCitiesText],
    ],
  },
  {
    id: "monaco",
    title: t.whatsNewMonacoTitle,
    lead: t.whatsNewMonacoLead,
    views: [
      { key: "iso", label: t.whatsNewViewIso },
      { key: "top", label: t.whatsNewViewTop },
    ],
    changes: [
      [t.whatsNewCityTitle, t.whatsNewCityText],
      [t.whatsNewHarbourTitle, t.whatsNewHarbourText],
      [t.whatsNewStartTitle, t.whatsNewStartText],
      [t.whatsNewPhonesTitle, t.whatsNewPhonesText],
    ],
  },
];

/** What each release changed, newest on top, with before/after shots to flip between. */
export function WhatsNew({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useAppPref();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const [latest, ...earlier] = releases(t);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm animate-in fade-in duration-300 md:p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="relative max-h-full w-full max-w-5xl overflow-y-auto rounded-[14px] border border-border bg-background animate-in zoom-in-95 slide-in-from-bottom-4 duration-500"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          aria-label={t.whatsNewClose}
          className="absolute right-4 top-4 rounded-[10px] p-2 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>

        <div className="px-5 pb-5 pt-5 md:px-8 md:pt-7">
          <div className="text-[13px] text-muted-foreground">{t.whatsNewKicker}</div>
          <ReleaseBlock release={latest} headingId="whats-new-title" />

          {earlier.map((release) => (
            <section key={release.id} className="mt-8 border-t border-border pt-6">
              <div className="text-[13px] text-muted-foreground">{t.whatsNewEarlier}</div>
              <ReleaseBlock release={release} />
            </section>
          ))}

          <div className="mt-6 flex justify-end">
            <button
              className="inline-flex h-10 items-center rounded-[10px] bg-primary px-[18px] text-sm font-semibold text-primary-foreground hover:opacity-90"
              onClick={onClose}
            >
              {t.whatsNewDone}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReleaseBlock({ release, headingId }: { release: Release; headingId?: string }) {
  const { t } = useAppPref();
  const [view, setView] = useState(release.views[0].key);
  const shots = [
    { label: t.whatsNewBefore, after: false },
    { label: t.whatsNewAfter, after: true },
  ];
  return (
    <>
      <h2 id={headingId} className="mt-1 text-2xl font-semibold tracking-[-0.03em] md:text-4xl">
        {release.title}
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-[15px]">{release.lead}</p>

      <div className="mt-5 flex w-full gap-1 rounded-[10px] border border-border p-1 text-[13px] md:w-fit">
        {release.views.map(({ key, label }) => (
          <button
            key={key}
            className={`flex-1 rounded-[7px] px-3 py-1.5 transition md:flex-none ${
              view === key ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {shots.map((shot) => (
          <figure key={shot.label} className="relative overflow-hidden rounded-[10px] border border-border">
            <img
              src={`/whats-new/${release.id}-${view}-${shot.after ? "after" : "before"}.webp`}
              alt={`${release.title} — ${shot.label}`}
              className="aspect-[16/10] w-full object-cover"
            />
            <figcaption
              className={`absolute left-2.5 top-2.5 rounded-md px-2 py-0.5 text-xs font-medium ${
                shot.after ? "bg-primary text-primary-foreground" : "border border-border bg-background/90 text-muted-foreground"
              }`}
            >
              {shot.label}
            </figcaption>
          </figure>
        ))}
      </div>

      <dl className="mt-5 grid gap-x-8 md:grid-cols-2">
        {release.changes.map(([title, text]) => (
          <div key={title} className="border-t border-border py-3">
            <dt className="text-sm font-medium">{title}</dt>
            <dd className="mt-0.5 text-sm text-muted-foreground">{text}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
