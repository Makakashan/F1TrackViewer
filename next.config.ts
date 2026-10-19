import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Cloudflare Pages serves the static export; `next start` serves the standalone build.
const isStaticExport = process.env.STATIC_EXPORT === "true";

export default function config(phase: string): NextConfig {
  return {
    output: isStaticExport ? "export" : "standalone",
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
