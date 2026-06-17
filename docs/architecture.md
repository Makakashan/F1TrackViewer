# F1 Track Viewer — Architecture

## Overview

3D viewer for Formula 1 circuits. Built with Next.js, React Three Fiber, and Tailwind CSS.

## Data Flow

```
f1-circuits (GitHub) → useCircuits() → CircuitList
                  ↓
          useTrackData(selectedId)
                  ↓
         fetchCircuitGeoJson() → TrackViewer (Three.js)
                  ↓
         fetchElevations() → elevation profile
```

## File Structure

### Hooks
- `use-circuits.ts` — loads circuit index from GitHub, manages selection
- `use-track-data.ts` — loads GeoJSON geometry + elevation data with retry

### Components
- `track-viewer.tsx` — Three.js Canvas with OrbitControls
- `track-controls.tsx` — autorotate, elevation toggle, track width slider
- `track-overlay.tsx` — circuit name overlay + mouse controls hint
- `circuit-list.tsx` — searchable list of circuits with country flags
- `circuit-sidebar.tsx` — wraps CircuitList with loading skeleton
- `mobile-menu.tsx` — hamburger menu with Sheet for mobile
- `mobile-info-sheet.tsx` — track info panel for mobile
- `elevation-sparkline.tsx` — SVG sparkline for elevation profile
- `error-banner.tsx` — centered error display

### Lib
- `geo-utils.ts` — WGS84 → metric conversion, bounds, CatmullRom curve builder
- `elevation.ts` — SRTM data smoothing, normalization, interpolation, stats
- `elevation-api.ts` — Open-Meteo/OpenTopoData API calls, localStorage caching
- `track-geometry.ts` — Three.js BufferGeometry builders for track mesh + outline
- `f1-circuits.ts` — GitHub API helpers for bacinger/f1-circuits dataset

## Key Algorithms

### Elevation Smoothing (`elevation.ts`)

SRTM data from Open-Meteo can produce spikes on tight street circuits (Monaco, Baku).
The pipeline:
1. `normalizeElevationProfile()` — statistical outlier removal + local median filter
2. `smoothByTrackDistance()` — weighted averaging along track distance (45m radius)
3. `limitTrackGrade()` — caps slope to 20% grade, 4 passes bidirectional

### Track Geometry (`track-geometry.ts`)

`buildExtrudedTrack()` creates a solid 3D ribbon:
- 6 vertices per sample: topL/topR (road surface), wallL/wallR (slightly below), botL/botR (ground)
- Flat shading via per-quad normals (cross product of vertex positions)
- Walls extend down to `groundY` for a "3D-printed" look

`buildTrackOutline()` creates thin black lines along both top edges for visual definition.

### Centripetal Parametrization

`buildTrackCurve()` uses `"centripetal"` parametrization (not uniform) to prevent
self-intersections on street circuits where consecutive GeoJSON points cluster tightly.

## External Data Sources

| Source | Data | License |
|--------|------|---------|
| bacinger/f1-circuits | Circuit geometry (GeoJSON) | MIT |
| Open-Meteo | SRTM elevation data | CC-BY 4.0 |
| OpenTopoData | Alternative elevation source | CC-BY 4.0 |

## Caching Strategy

1. Static JSON in `public/elevations/` (pre-generated)
2. localStorage cache (versioned, `f1tv:elevations:v2:`)
3. Open-Meteo API (rate-limited, 64 samples max)
