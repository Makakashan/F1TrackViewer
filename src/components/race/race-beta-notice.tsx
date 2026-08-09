"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppPref } from "@/components/app-pref-provider";

/** Shown once, the first time someone enters race mode. */
const SEEN_KEY = "f1tv:raceBeta:v1";

export default function RaceBetaNotice() {
  const { t } = useAppPref();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setOpen(localStorage.getItem(SEEN_KEY) !== "1");
      } catch {
        setOpen(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function acknowledge() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // A blocked storage only costs the user seeing this again next time.
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="race-beta-title"
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2 text-[#e10600]">
          <FlaskConical className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">
            {t.raceBeta}
          </span>
        </div>
        <h2 id="race-beta-title" className="mt-2 text-lg font-bold">
          {t.raceBetaTitle}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t.raceBetaBody}
        </p>
        <div className="mt-5 flex justify-end">
          <Button autoFocus size="sm" onClick={acknowledge}>
            {t.raceBetaAck}
          </Button>
        </div>
      </div>
    </div>
  );
}
