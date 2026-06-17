# F1 Track Studio

An interactive 3D viewer for Formula 1 circuit configurations, built with **Next.js 16 + Three.js**. Spin any of 40+ official circuits with your mouse, switch between them in one click, inspect track metadata (length, altitude, opening year), and toggle a real elevation profile powered by Open-Meteo.

This is **MVP 1.5** of a staged roadmap: a static 3D viewer on top of the `bacinger/f1-circuits` GeoJSON dataset, with elevation fetched per-coordinate. Next milestones add OpenF1 sessions/telemetry (MVP 2), real track width and racing line from TUMFTM (MVP 3), and animated car position from OpenF1 location data (MVP 4).

---

## Features (MVP 1.5)

- **40 circuits** from `bacinger/f1-circuits` (Monaco, Monza, Silverstone, Spa, Suzuka, Las Vegas, Jeddah, and more)
- **Flat ribbon mesh** built from a CatmullRomCurve3 — a real road surface, not a tube. Track width adjustable 3–15 m
- **Elevation profile** via [Open-Meteo Elevation API](https://open-meteo.com/en/docs#elevation-api) — no auth, no key, chunked by 100 points. Applied to the curve's Y with a configurable ×1–8 amplification
- **Mean-subtracted altitude** — high-altitude tracks (Mexico, ~2200 m) stay grounded; only relative elevation changes are visualized
- **OrbitControls** — left-drag to rotate, right-drag to pan, wheel to zoom
- **Auto-rotate** toggle, **Elevation** toggle, and **Width** slider in the top bar
- **Start/finish line** marker + thin red kerbs along both edges of the ribbon
- **Light / Dark / System theme** — saved in localStorage, applied at runtime
- **Russian / English UI** — auto-detected from `navigator.language`, switchable from the Settings menu
- **Searchable circuit list** with country flags (40 entries fit thanks to a slim custom scrollbar)
- **Info panel** with track stats, an SVG sparkline of the elevation profile (min/max/range/climb/descent), and geometry metadata

---

## Tech Stack

| Layer | What |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript 5 |
| 3D | three@0.184 + @react-three/fiber@9 + @react-three/drei@10 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) — custom F1-themed tokens for light & dark |
| i18n | Hand-rolled (no library) — flat key-value dictionaries in `src/lib/i18n.ts` |
| Track data | [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT) — GeoJSON LineString |
| Elevation | [Open-Meteo](https://open-meteo.com/en/docs#elevation-api) (CC-BY 4.0) — SRTM-3 arcsec |

GeoJSON and elevation data are fetched directly from public APIs at runtime — no backend, no API keys.

---

## Local Development

### Prerequisites

- Node.js 20+ (or [Bun](https://bun.sh) 1.1+ for faster installs)
- Any modern browser with WebGL support

### Setup

```bash
git clone https://github.com/Makakashan/F1TrackViewer.git
cd F1TrackViewer

# Pick one:
bun install    # fastest
npm install    # works everywhere
pnpm install   # also fine

# Start the dev server
bun run dev    # or: npm run dev / pnpm dev
```

Open http://localhost:3000 — Monaco loads by default.

### Useful scripts

| Command | What it does |
|---|---|
| `bun run dev` | Start Next.js dev server on port 3000 |
| `bun run build` | Production build |
| `bun run start` | Run the production build |
| `bun run lint` | ESLint check (TypeScript + Next.js rules) |

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx          # root layout — wraps everything in <AppPrefProvider>
│   ├── page.tsx            # main page: 3-column layout + top bar + footer
│   └── globals.css         # Tailwind tokens — light & dark F1-themed variants
├── components/
│   ├── app-pref-provider.tsx  # i18n + theme context (localStorage-backed)
│   ├── circuit-list.tsx       # left sidebar: searchable list of 40 circuits
│   ├── track-info.tsx         # right sidebar: metadata + elevation sparkline
│   ├── track-viewer.tsx       # center: Three.js Canvas + ribbon mesh + OrbitControls
│   ├── settings-menu.tsx      # popover: language + theme switcher
│   └── ui/                    # shadcn/ui components (Button, Input, Switch, Popover, …)
└── lib/
    ├── f1-circuits.ts      # types + fetch helpers for bacinger/f1-circuits
    ├── geo-utils.ts        # lon/lat → meters, buildTrackCurve, fetchElevations, elevationStats
    └── i18n.ts             # language & theme dictionaries (RU/EN, light/dark/system)
```

### Key files

- **`src/lib/geo-utils.ts`** — `lonLatToXZ()` converts WGS84 to local meters (1 unit = 1 m, bbox-centered). `buildTrackCurve()` builds a closed CatmullRomCurve3 with optional per-point elevations and a configurable vertical scale. `fetchElevations()` calls Open-Meteo in 100-point chunks. `elevationStats()` computes min/max/range/climb/descent for the info panel.
- **`src/components/track-viewer.tsx`** — `buildRibbon()` constructs a flat BufferGeometry from the curve (two vertices per sample, side vector from `cross(tangent, world-up)`, triangle-strip indices). The ribbon is raised 0.5 m above the curve to avoid z-fighting with the ground. Theme-aware colors for surface, kerbs, and ground.
- **`src/components/app-pref-provider.tsx`** — React context that holds the active language and theme, persists them to `localStorage`, applies the `.dark` / `.light` class to `<html>`, and listens to `prefers-color-scheme` changes when in System mode.

---

## Roadmap

- [x] **MVP 1** — static 3D viewer on bacinger/f1-circuits + Three.js + OrbitControls
- [x] **MVP 1.5** — elevation profile via Open-Meteo + flicker fix + ribbon mesh + i18n + theming
- [ ] **MVP 2** — wire up [OpenF1](https://openf1.org/) / [Jolpica](https://jolpi.ca/): season selector, Grand Prix picker, session list, corner numbers, mini-map
- [ ] **MVP 3** — switch to [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) for real track width and racing line; replace the fixed-width ribbon with a proper variable-width mesh
- [ ] **MVP 4** — animate a car along the track using the OpenF1 `location` endpoint (~3.7 Hz position updates)

---

## Disclaimer

**This is an unofficial, non-commercial project.** It is not affiliated with, endorsed by, or sponsored by Formula 1, Formula One Licensing B.V., the FIA, or any of the data providers listed below. "F1", "FORMULA ONE", and related marks are trademarks of Formula One Licensing B.V., used here for identification purposes only.

## Data Sources

| Source | Used for | License |
|---|---|---|
| [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) | Track geometry (GeoJSON LineString) + basic metadata (length, altitude, opening year) | MIT |
| [Open-Meteo Elevation API](https://open-meteo.com/en/docs#elevation-api) | Per-coordinate elevation (SRTM-3 arcsec) | CC-BY 4.0 |
| [OpenF1](https://openf1.org/) | F1 session/calendar/driver/lap/telemetry data (planned for MVP 2 & 4) | Free, no auth for historical data |
| [Jolpica F1 API](https://jolpi.ca/) | Alternative F1 API (Ergast successor, planned for MVP 2 fallback) | AGPL-3.0 |
| [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) | Centerline + left/right width + racing line for 20+ tracks (planned for MVP 3) | LGPL-3.0 |

---

## License

MIT. See [LICENSE](LICENSE).
