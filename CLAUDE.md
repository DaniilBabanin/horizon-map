# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Horizon Finder": a static, single-page viewshed tool. User places an observer on a map (48–52° N, 6–11° E, i.e. Rhine-Main / Hesse / Rhineland-Palatinate area), sets eye height, and the page computes what terrain is visible (with Earth curvature and refraction), the skyline, and a 360° panorama.

Copied from claude.ai artifact https://claude.ai/artifact/45La1UMsLJSri6BzePbhsB (version 1794051200-2296). No build step, no package manager, no linter. The scripts that generated `data/` and `dem/` are not in this repo.

## Running

The page `fetch()`es relative paths, so it must be served over HTTP (`file://` fails):

```
python3 -m http.server 8765 --bind 0.0.0.0
```

On this machine ports 8000 and 8080 are already taken by other local services (127.0.0.1 only), so use another port. External deps load from CDNs (d3 7.8.5, topojson-client 3.1.0) and Google Fonts, so the page needs network access.

## Tests and benchmark

```
node --test                 # all tests (test/*.test.js), ~40 s; Node 24, built-ins only
node bench/rays.js          # ray-count benchmark, ~35 min, prints a Markdown table
```

`node --test test/` does not work on Node 24 (a directory is not a glob); use plain `node --test`. `test/harness.js` runs `worker.js` in `node:vm` with a `postMessage` stub (`loadWorker(path?)`, `flatTile(h)`); `WORKER_SRC=<file>` makes `test/viewshed.test.js` load a mutated copy for red checks. Each 20-tile load costs ~12 s because every `tile` message runs `shade()`, and code in `node:vm` runs ~10× slower than in a browser (global lookups go through the context; measured 2026-11-07: 3410 ms vs 301 ms for one 4096-ray 100 km view), so `bench/rays.js` times are only good as ratios. `bench/png.js` decodes the DEM PNGs with `node:zlib`.

## Architecture

`index.html` holds CSS, markup and the main-thread script; the Web Worker is `worker.js`.

**Worker** (`worker.js`, loaded with `new Worker("worker.js")`): shares no scope with the main script. It keeps the DEM tiles in memory and handles four messages:
- `init` → region (`la0, lo0, nla, nlo`) and Earth radius `R`, sent by the main script from `REG`/`R` right after creating the worker; must come before any `tile`.
- `tile` → stores an `Int16Array` heightmap, replies `shade` (hillshade bitmap for that 1°×1° tile, Mercator-resampled).
- `view` → the viewshed. Casts `rays` (default 4096) azimuth rays at 60 m steps out to `rmax`; a sample is visible if its elevation angle `(z - d²/(2·Re) - zo)/d` is ≥ the running max (`Re = R/(1-k)` folds refraction coefficient `k` into Earth radius). Returns visibility mask raster (in unit-Mercator bbox), skyline per azimuth, intermediate ridge crests (`crA/crD/crN`) for the panorama, visible area, farthest point.
- `query` → single line-of-sight check for map hover (30 m steps), returns metres hidden below sightline.

Results go back as transferable buffers. `viewId`/`qid` counters discard stale replies.

**Main script** (IIFE after the CDN scripts):
- Map: canvas 2D with d3-zoom; all geometry projected with one `d3.geoMercator` scaled to a 1024-px world (`W`). Layers drawn in `render()`: land (TopoJSON) → hillshade tiles → lakes → borders → data-edge box → tinted viewshed mask → flat-horizon ring + `rmax` ring → skyline dots → city labels → markers.
- Panorama: separate canvas, `drawPano()`; height axis auto-scaled (exaggerated).
- `state` (lat, lon, h, k, rmax) persisted in `localStorage` key `horizon-v3` (bump the key if the state shape changes) and in the URL hash (`#lat=..&lon=..&h=..&k=..&rmax=..`, written with `history.replaceState` in `changed()`). At start and on `hashchange`, a valid hash wins over `localStorage` (`readHashState()`).
- `compute()` is debounced 120 ms; it loads only tiles within `rmax`, then posts `view`. After the first view, `loadRest()` loads all remaining tiles for hillshade.
- Theme: colors are CSS custom properties (light + dark under `prefers-color-scheme` and `[data-theme]`). Canvas code reads them via `readColors()` into `colors`; a new canvas color must be added to the name list there.

**Region bounds**: defined once in the main script (`REG`, 48–52° N, 6–11° E, 4×5 tiles) and sent to the worker in `init`. Changing coverage also means editing the user-facing text that states the bounds (lede note, hints, status messages) and the region in the tests and bench.

## Data formats

- `dem/N{lat}E{lon:03}.png`: SRTM 3″, 1201×1201 RGB 8-bit, one per 1° cell (name = SW corner). Height in metres = `(R << 8 | G) - 1000`. `loadTile()` decodes with `colorSpaceConversion: "none"` / `premultiplyAlpha: "none"` so the raw bytes reach the height formula unchanged; keep those options.
- `data/cities.json`: GeoNames rows `[name, countryCode, lat, lon, population]`, ~49k worldwide, population ≥ 5000, **sorted descending by population**. `drawCities()` stops at the first row below its population threshold (`break`), and search fills up to 8 matches in file order, so keep this sort order.
- `data/world.json`: TopoJSON, objects `land`, `countries` (Natural Earth). `data/lakes.json`: TopoJSON, object `map.geo`. `fixWinding()` reverses rings whose spherical area > 2π (wrong winding order).
