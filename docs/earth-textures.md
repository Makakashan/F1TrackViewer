# Globe Earth Textures

GlobeLanding can use local Earth texture assets from:

- `public/textures/earth/earth-day.jpg`
- `public/textures/earth/earth-clouds.png` optional
- `public/textures/earth/earth-night.jpg` optional for future night-side work

Use equirectangular Earth maps. A 2048 or 4096 pixel wide JPG/WebP is a good first target for GitHub Pages and local development. Avoid very large 16k or 32k textures because they slow the initial page load and increase GPU memory use.

Do not load Earth textures from external URLs at runtime. Store assets locally under `public/textures/earth/`.
