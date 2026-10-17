"use client";

import { Car, Flag, LogOut, Mountain, PencilRuler, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import F1TrackApp from "@/components/track/f1-track-app";
import CarModelLab from "@/components/admin/car-model-lab";
import FleetLab from "@/components/admin/fleet-lab";
import TrackEditorLauncher from "@/components/admin/track-editor-launcher";
import { cn } from "@/lib/utils";

export type AdminSection = "models" | "fleet" | "calibration" | "terrain" | "editor";

const SECTIONS: {
  id: AdminSection;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "models",
    label: "Car models",
    hint: "Inspect published .glb assets",
    icon: <Car className="h-3.5 w-3.5" />,
  },
  {
    id: "fleet",
    label: "Fleet",
    hint: "Twenty cars, instanced from one model",
    icon: <Users className="h-3.5 w-3.5" />,
  },
  {
    id: "calibration",
    label: "Calibration",
    hint: "Start/finish marker editor",
    icon: <Flag className="h-3.5 w-3.5" />,
  },
  {
    id: "terrain",
    label: "Terrain",
    hint: "The baked ground, with nothing standing on it",
    icon: <Mountain className="h-3.5 w-3.5" />,
  },
  // A local tool: saving writes into the source tree, which only `next dev` can do.
  ...(process.env.NODE_ENV === "development"
    ? [
        {
          id: "editor" as const,
          label: "Track editor",
          hint: "Local corrections to width, barriers and kerbs",
          icon: <PencilRuler className="h-3.5 w-3.5" />,
        },
      ]
    : []),
];

export default function AdminShell({ onSignOut }: { onSignOut: () => void }) {
  const [section, setSection] = useState<AdminSection>("models");
  const active = SECTIONS.find((s) => s.id === section);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:px-6">
        <div className="flex items-center gap-2.5" title={active?.hint}>
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <span className="hidden text-sm font-semibold sm:inline">Admin</span>
          <span className="hidden h-2 w-2 bg-red-600 sm:inline-block" />
        </div>

        <nav className="ml-2 flex items-center gap-1">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                section === item.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <button
          type="button"
          onClick={onSignOut}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </header>

      {section === "models" ? (
        <div className="min-h-0 flex-1">
          <CarModelLab />
        </div>
      ) : section === "fleet" ? (
        <div className="min-h-0 flex-1">
          <FleetLab />
        </div>
      ) : section === "terrain" ? (
        <div className="min-h-0 flex-1 overflow-hidden [&>div]:h-full! [&>div]:w-full!">
          <F1TrackApp terrainOnly />
        </div>
      ) : section === "editor" ? (
        <div className="min-h-0 flex-1">
          <TrackEditorLauncher />
        </div>
      ) : (
        // F1TrackApp sizes itself to the viewport, so the admin page gives it a fixed box.
        <div className="min-h-0 flex-1 overflow-hidden [&>div]:h-full! [&>div]:w-full!">
          <F1TrackApp startFinishCalibration />
        </div>
      )}
    </div>
  );
}
