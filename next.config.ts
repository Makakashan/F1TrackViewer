import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const isGithubPages = process.env.GITHUB_PAGES === "true";
const repoName = "F1TrackViewer";

export default function config(phase: string): NextConfig {
  return {
    output: isGithubPages ? "export" : "standalone",
    basePath: isGithubPages ? `/${repoName}` : "",
    assetPrefix: isGithubPages ? `/${repoName}/` : undefined,
    env: {
      NEXT_PUBLIC_BASE_PATH: isGithubPages ? `/${repoName}` : "",
    },
    images: { unoptimized: true },
    typescript: { ignoreBuildErrors: true },
    reactStrictMode: false,
    // A `*.dev.ts` route exists only under `next dev`: the track editor's save writes into the source tree.
    pageExtensions:
      phase === PHASE_DEVELOPMENT_SERVER
        ? ["dev.ts", "tsx", "ts", "jsx", "js"]
        : ["tsx", "ts", "jsx", "js"],
  };
}
