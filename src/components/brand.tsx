/** The brand: the Boxlane mark, and the repository it links to. */

import { useId } from "react";

export const REPO_URL = "https://github.com/Makakashan/F1TrackViewer";

/** Boxlane: a front tyre rolling out of the box, its marks trailing behind. Light tile on the light theme, dark on the dark one. */
export function BrandMark({ className = "h-7 w-7" }: { className?: string }) {
  const clip = useId();
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <clipPath id={clip}>
          <rect width="64" height="64" rx="15" />
        </clipPath>
      </defs>
      <rect width="64" height="64" rx="15" className="fill-background"/>
      <g clipPath={`url(#${clip})`} strokeLinecap="round" strokeLinejoin="round">
      <path d="M27.00 50.80 C41.00 49.80 52.00 44.00 66 42.00 L66 44.40 C52.00 46.60 41.00 54.00 27.00 54.00 Z" className="fill-foreground"/>
      <path d="M27.00 45.00 C41.00 44.00 52.00 36.50 66 34.50 L66 36.60 C52.00 38.80 41.00 47.60 27.00 47.60 Z" className="fill-foreground"/>
      <ellipse cx="18" cy="34" rx="12.00" ry="20" className="fill-foreground"/>
      <rect x="18" y="14" width="18" height="40" className="fill-foreground"/>
      <ellipse cx="36" cy="34" rx="12.00" ry="20" className="fill-foreground stroke-background" strokeWidth="1.6"/>
      <g transform="translate(36 34) scale(0.6 1)">
      <circle r="17.00" fill="none" className="stroke-background" strokeWidth="2.83" strokeDasharray="38.5 15.0" transform="rotate(-60)"/>
      </g><ellipse cx="36" cy="34" rx="7.20" ry="12" className="fill-background"/>
      <ellipse cx="36" cy="34" rx="6.24" ry="10.4" fill="none" className="stroke-foreground" strokeWidth="1.3"/>
      <path d="M36 34 L36.00 23.60" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L39.67 25.59" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L41.93 30.79" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L41.93 37.21" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L39.67 42.41" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L36.00 44.40" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L32.33 42.41" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L30.07 37.21" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L30.07 30.79" className="stroke-foreground" strokeWidth="2.1"/>
      <path d="M36 34 L32.33 25.59" className="stroke-foreground" strokeWidth="2.1"/>
      <ellipse cx="36" cy="34" rx="2.52" ry="4.2" className="fill-foreground"/>
      <ellipse cx="36" cy="34" rx="0.96" ry="1.6" className="fill-background"/>
      </g>
    </svg>
  );
}

export function GithubMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

