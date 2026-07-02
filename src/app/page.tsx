import F1TrackApp from "@/components/f1-track-app";
import GlobeLanding from "@/components/globe/globe-landing";

interface HomeProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const track = params?.track;
  const hasTrack = Array.isArray(track) ? Boolean(track[0]) : Boolean(track);

  if (!hasTrack) {
    return <GlobeLanding />;
  }

  return <F1TrackApp />;
}
