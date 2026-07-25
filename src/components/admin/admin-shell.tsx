"use client";

import { Car, Flag, LogOut, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import F1TrackApp from "@/components/f1-track-app";
import CarModelLab from "@/components/admin/car-model-lab";
import FleetLab from "@/components/admin/fleet-lab";
import { cn } from "@/lib/utils";

export type AdminSection = "models" | "fleet" | "calibration";

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
];

export default function AdminShell({ onSignOut }: { onSignOut: () => void }) {
  const [section, setSection] = useState<AdminSection>("models");
  const active = SECTIONS.find((s) => s.id === section);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-3 backdrop-blur md:px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-linear-to-br from-red-600 to-orange-600 shadow-[0_0_16px_rgba(225,6,0,0.35)]">
            <ShieldCheck className="h-4 w-4 text-white" />
          </div>
          <div className="hidden leading-none sm:block">
            <div className="text-[13px] font-semibold">Admin</div>
            <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              {active?.hint}
            </div>
          </div>
        </div>

        <nav className="ml-2 flex items-center gap-1">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors",
                section === item.id
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
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
          className="ml-auto flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
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
      ) : (
        // F1TrackApp sizes itself to the viewport (h-screen) because it owns
        // the whole page on the public route. Inside the admin shell it has to
        // fit under the header instead, so its root is pinned to this box
        // rather than editing the shared component.
        <div className="min-h-0 flex-1 overflow-hidden [&>div]:h-full! [&>div]:w-full!">
          <F1TrackApp startFinishCalibration />
        </div>
      )}
    </div>
  );
}
