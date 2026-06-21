"use client";

import { Layers } from "lucide-react";
import TrackSettingsPanel, {
  type TrackSettingsPanelProps,
} from "@/components/track-settings-panel";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useAppPref } from "@/components/app-pref-provider";

export default function MobileLayersSheet(props: TrackSettingsPanelProps) {
  const { t } = useAppPref();

  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className="absolute right-4 top-4 z-10 h-10 w-10 rounded-full shadow-lg md:hidden"
          aria-label={t.layers}
          title={t.layers}
        >
          <Layers className="h-4 w-4" />
        </Button>
      </DrawerTrigger>
      <DrawerContent className="max-h-[82vh] bg-sidebar">
        <DrawerHeader className="pb-2 text-left">
          <DrawerTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-primary" />
            {t.layers}
          </DrawerTitle>
        </DrawerHeader>
        <TrackSettingsPanel {...props} />
      </DrawerContent>
    </Drawer>
  );
}
