"use client";

import { useSearchParams } from "next/navigation";
import F1TrackApp from "@/components/f1-track-app";
import RaceApp from "@/components/race/race-app";
import GlobeLanding from "@/components/globe/globe-landing";
import { useUrlState } from "@/lib/url-state";

export default function HomeRouter() {
  const searchParams = useSearchParams();
  const track = searchParams.get("track");
  const raceParam = searchParams.get("race") === "1";
  const raceMode = useUrlState((state) => state.raceMode);
  const hydrated = useUrlState((state) => state.hydrated);

  // Before hydration the URL is the only thing that knows the mode; after it,
  // the store is, because entering and leaving race mode is a state change
  // (the URL follows via replaceState, which does not re-run useSearchParams).
  const showRace = hydrated ? raceMode : raceParam;

  if (!track) {
    return <GlobeLanding />;
  }

  return showRace ? <RaceApp /> : <F1TrackApp />;
}
