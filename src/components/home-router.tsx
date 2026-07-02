"use client";

import { useSearchParams } from "next/navigation";
import F1TrackApp from "@/components/f1-track-app";
import GlobeLanding from "@/components/globe/globe-landing";

export default function HomeRouter() {
  const searchParams = useSearchParams();
  const track = searchParams.get("track");

  if (!track) {
    return <GlobeLanding />;
  }

  return <F1TrackApp />;
}
