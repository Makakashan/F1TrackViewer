# F1 Track Viewer

Interactive 3D viewer for Formula 1 circuits — Next.js 16 + Three.js + Tailwind CSS. Orbit any of 40+ tracks with real elevation profiles, adjustable track width, and light/dark themes.

---

## Features

- **40 circuits** from `bacinger/f1-circuits` (Monaco, Monza, Silverstone, Spa, Suzuka, Las Vegas, Jeddah, and more)
- **Extruded 3D track mesh** — solid ribbon with side walls, not a flat tube. Track width adjustable 3–15 m
- **Elevation profile** via [Open-Meteo](https://open-meteo.com/en/docs#elevation-api) — SRTM data smoothed for street circuits (Monaco, Baku)
- **Mean-subtracted altitude** — high-altitude tracks (Mexico, ~2200 m) stay grounded
- **OrbitControls** — left-drag to rotate, right-drag to pan, wheel to zoom
- **Auto-rotate** toggle, **Elevation** toggle, and **Width** slider
- **Light / Dark theme** — saved in localStorage
- **Russian / English UI** — auto-detected, switchable from Settings
- **Searchable circuit list** with country flags
- **Info panel** with track stats, SVG sparkline elevation profile, and geometry metadata
- **Responsive** — mobile layout with drawer menus, desktop 3-column layout

---

## Tech Stack

| Layer | What |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript 5 |
| 3D | three@0.184 + @react-three/fiber@9 + @react-three/drei@10 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| i18n | next-intl |
| State | Zustand |
| Track data | [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT) |
| Elevation | [Open-Meteo](https://open-meteo.com/en/docs#elevation-api) (CC-BY 4.0) + [OpenTopoData](https://opentopodata.org/) |

No backend, no API keys. Data fetched from public APIs at runtime.

---

## Local Development

### Prerequisites

- Node.js 20+ or [Bun](https://bun.sh) 1.1+
- Modern browser with WebGL

### Setup

```bash
git clone https://github.com/Makakashan/F1TrackViewer.git
cd F1TrackViewer

bun install    # or: npm install / pnpm install
bun run dev    # or: npm run dev
```

Open http://localhost:3000

### Scripts

| Command | Description |
|---|---|
| `bun run dev` | Dev server on port 3000 |
| `bun run build` | Production build |
| `bun run build:pages` | Static export for GitHub Pages |
| `bun run lint` | ESLint check |
| `bun run elevations:generate` | Pre-generate static elevation JSONs |

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx              # Main page — 3-column layout
│   └── layout.tsx            # Root layout with providers
├── hooks/
│   ├── use-circuits.ts       # Circuit index loading + selection
│   └── use-track-data.ts     # GeoJSON + elevation loading with retry
├── components/
│   ├── track-viewer.tsx      # Three.js Canvas + OrbitControls
│   ├── track-controls.tsx    # Autorotate, elevation, width controls
│   ├── track-overlay.tsx     # Circuit name + controls hint
│   ├── circuit-list.tsx      # Searchable circuit list
│   ├── circuit-sidebar.tsx   # Sidebar wrapper with skeleton
│   ├── mobile-menu.tsx       # Mobile hamburger drawer
│   ├── mobile-info-sheet.tsx # Mobile track info panel
│   ├── elevation-sparkline.tsx # SVG elevation profile
│   ├── error-banner.tsx      # Centered error display
│   └── ui/                   # shadcn/ui components
├── lib/
│   ├── geo-utils.ts          # WGS84 → metric, bounds, CatmullRom curve
│   ├── elevation.ts          # SRTM smoothing, normalization, stats
│   ├── elevation-api.ts      # Open-Meteo/OpenTopoData API + caching
│   ├── track-geometry.ts     # Three.js BufferGeometry builders
│   ├── f1-circuits.ts        # GitHub API helpers
│   └── i18n.ts               # Language dictionaries
└── docs/
    └── architecture.md       # Detailed architecture docs
```

---

## Roadmap

- [x] **MVP 1** — static 3D viewer + OrbitControls
- [x] **MVP 1.5** — elevation profile + ribbon mesh + i18n + theming
- [ ] **MVP 2** — [OpenF1](https://openf1.org/) / [Jolpica](https://jolpi.ca/): sessions, telemetry
- [ ] **MVP 3** — [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database): real track width
- [ ] **MVP 4** — animated car position from OpenF1

---

## Disclaimer

**Unofficial, non-commercial project.** Not affiliated with Formula 1, FIA, or data providers. "F1" and related marks are trademarks of Formula One Licensing B.V.

## Data Sources

| Source | Used for | License |
|---|---|---|
| [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) | Track geometry + metadata | MIT |
| [Open-Meteo](https://open-meteo.com/en/docs#elevation-api) | Elevation (SRTM-3) | CC-BY 4.0 |
| [OpenTopoData](https://opentopodata.org/) | Alternative elevation source | CC-BY 4.0 |
| [OpenF1](https://openf1.org/) | Session/telemetry data (planned) | Free |
| [Jolpica](https://jolpi.ca/) | F1 API fallback (planned) | AGPL-3.0 |
| [TUMFTM](https://github.com/TUMFTM/racetrack-database) | Track width data (planned) | LGPL-3.0 |

---

## License

MIT. See [LICENSE](LICENSE).
