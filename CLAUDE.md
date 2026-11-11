# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Horizon Finder": a static, single-page viewshed tool. User places an observer anywhere between 85° S and 85° N, sets eye height (and optionally a target height), and the page computes what terrain is visible (with Earth curvature and refraction), the skyline, and a 360° panorama.

Copied from claude.ai artifact https://claude.ai/artifact/45La1UMsLJSri6BzePbhsB (version 1794051200-2296). No build step, no package manager, no linter. Hosted on GitHub Pages from `main` (repo https://github.com/DaniilBabanin/horizon-map, live at https://horizon-map.babanin.de/ (custom domain via the `CNAME` file; Cloudflare proxies DNS `horizon-map` CNAME → `daniilbabanin.github.io`, set 2026-11-08); 1 GB site cap; published 2026-11-08; `.nojekyll` skips Jekyll). Push only when the user asks. Design notes for the global data: `research/global-coverage-2026-11-07.md`.

## Running

The page `fetch()`es relative paths, so it must be served over HTTP (`file://` fails):

```
python3 -m http.server 8765 --bind 0.0.0.0
```

On this machine ports 8000 and 8080 are already taken by other local services (127.0.0.1 only), so use another port. d3 7.8.5, topojson-client 3.1.0 and the three web fonts are self-hosted in `vendor/` (`scripts/vendor.sh` re-downloads them with SHA-256 checks; since 2026-11-08, so no visitor IP goes to Google Fonts or script CDNs). Terrain comes from AWS Terrain Tiles, so the page still needs network access.

**Privacy/legal** (user request 2026-11-08): `privacy.html` (English + German) lists every host the browser contacts: GitHub Pages + Cloudflare (site), `s3.amazonaws.com` (terrain), `tile.openstreetmap.org` (only when the overlay is above 0 %). A new third-party request, stored value or browser permission must be added there in both languages. Imprint lives on the user's main site, https://babanin.de/imprint.html; the map's attribution line links both.

## Tests and benchmark

GitHub Actions (`.github/workflows/test.yml`) runs `node --test` on every push and pull request; Pages still deploys `main` regardless of the result.

```
node --test                 # all tests (test/*.test.js), ~2.5 s; Node 24, built-ins only
node bench/rays.js          # ray-count benchmark, ~35 min, prints a Markdown table (--quick: one site, ~15 s)
```

`node --test test/` does not work on Node 24 (a directory is not a glob); use plain `node --test`. `test/harness.js` wraps `worker.js` in `new Function` with a `postMessage` stub and a local `onmessage` (`loadWorker(path?)`, `flatTile(h)` = 256×256, `loadTerrain(worker, {lat, lon, rmax}, heightAt?, skipKey?)` runs the prepare/need/tile exchange with synthetic terrain); `WORKER_SRC=<file>` makes the tests load a mutated copy for red checks. Do not go back to `node:vm`: global lookups through the vm context made the worker ~10× slower (measured 2026-11-07: 3410 ms vs 301 ms for one 4096-ray 100 km view; suite 37 s vs 2.5 s). `bench/terrain.js` feeds the worker real Terrarium tiles from `~/.cache/horizonmap/terrarium/` (downloads missing ones; `HORIZONMAP_TILE_CACHE` overrides), `bench/png.js` decodes them with `node:zlib`.

## Architecture

`index.html` holds CSS, markup and the main-thread script; the Web Worker is `worker.js`.

**Worker** (`worker.js`, loaded with `new Worker("worker.js")`): shares no scope with the main script. It owns all tile math, keeps elevation tiles in memory and handles these messages:
- `init {R}` → Earth radius; resets the store.
- `prepare {id, lat, lon, rmax}` → picks the zoom `zoomFor(lat)` (Mercator pixel ≤ 110 m at the observer's latitude: z10 at 50° N, z11 at the equator, z9 at 70° N) and replies `need {id, z, keys, total, evicted}`: the `z/x/y` keys of the disc's tile block it does not hold yet. When the store exceeds `max(600, 2·total)` tiles it drops tiles outside the block and lists them in `evicted`.
- `tile {key, data: Int16Array(65536)}` → stores a 256×256 tile (metres, -32768 = no data), replies `shade {key, z, x, y, data}` (hillshade RGBA in the tile's own Mercator pixels).
- Near field: `prepare` also lists tiles two zooms finer (`FINE_ZOOM_STEP`, z12 at 50° N ≈ 25 m) within `FINE_RADIUS` = 5 km; `view`/`query` sample that second mosaic for near ray steps and the observer's `z0`. Finer than +2 gains nothing (measured 2026-11-07, see the comment in `worker.js`): summits stay a little low because the source data is ~30 m (Matterhorn 4,301 m vs 4,478 m).
- At `view` start the worker copies the block into one Int16 mosaic (x unwrapped across the dateline) and samples it bilinearly; ray segments are converted to mosaic pixels at their exact great-circle points and interpolated in between (no log/tan per sample).
- `view {id, lat, lon, h, k, rmax, rays?, t?}` → the viewshed. Casts `rays` (default 4096; the page sends `raysFor(rmax)`: 8192 up to 100 km, 16384 beyond, from the 2026-11-07 bench) azimuth rays at 60 m steps out to `rmax`, each along a great circle (exact points every 32 samples, linear in between, <0.12 m error); the mask looks pixels up by great-circle distance and initial bearing; a sample is visible if its elevation angle `(z - d²/(2·Re) - zo)/d` plus `t/d` (target height `t`) is ≥ the running terrain max (`Re = R/(1-k)` folds refraction coefficient `k` into Earth radius); the skyline and crests stay terrain-only. An optional finite `ground` replaces the sampled observer height `z0` (summit snap). Returns visibility mask raster (in unit-Mercator bbox), skyline per azimuth, intermediate ridge crests (`crA/crD/crN`) for the panorama, visible area, farthest point.
- `query` → single line-of-sight check for map hover / touch tap (30 m steps along the great circle), returns great-circle distance `D` and metres hidden below sightline. With `profile: n` the reply adds `profile` (Float32Array, max terrain height per distance bin, at most one bin per walk sample, NaN = no data) and `blockD` (distance of the highest-angle sample); the page draws them as the sightline chart in the tooltip (`drawProfile`, heights minus the curvature drop so sightlines are straight).

Results go back as transferable buffers. `viewId`/`qid` counters discard stale replies.

**Main script** (IIFE after the CDN scripts):
- Map: canvas 2D with d3-zoom; all geometry projected with one `d3.geoMercator` scaled to a 1024-px world (`W`). Layers drawn in `render()`: land (TopoJSON) → hillshade tiles (per z/x/y, from `shade`) → lakes → borders → tinted viewshed mask → flat-horizon ring + `rmax` ring → skyline dots → city labels → markers.
- Panorama: separate canvas, `drawPano()`; height axis auto-scaled (exaggerated).
- `state` (lat, lon, h, t, k, rmax, g; default range 100 km, user decision 2026-11-11) persisted in `localStorage` key `horizon-v3` (bump the key if the state shape changes) and in the URL hash (`#lat=..&lon=..&h=..&k=..&rmax=..&t=..`, written with `history.replaceState` in `changed()`). At start and on `hashchange`, a valid hash wins over `localStorage` (`readHashState()`).
- `compute()` is debounced 120 ms; it posts `prepare`, fetches the `need` keys from `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (8 in flight, one retry; CORS `*` on GET, verified 2026-11-07), decodes `R*256 + G + B/256 - 32768` with `createImageBitmap(..., {colorSpaceConversion: "none", premultiplyAlpha: "none"})` (keep those options), posts the tiles, then `view` with `rays: raysFor(rmax)` and `t`. Hillshade exists only where tiles were loaded. When some (not all) tiles fail, the status line says how many and offers a Retry button (`compute()` again: the worker lists unheld tiles under `need` each time).
- Search: `data/cities.json` at start; the first input fetches `data/cities-1000.json` once and searches it. Coordinates typed into the search box (`coords.js` `parseCoordinates`: decimal, N/S/E/W, DMS, decimal minutes; tested in `test/coords.test.js`) show as the first result.
- "Use my location": Geolocation API, works only in a secure context (HTTPS or localhost; on the LAN `http://192.168.0.142:8765` the page says so).
- Summit snap (user decision 2026-11-11: map placement only, never search, typed coordinates, GPS): `placeFromClient` (mouse click, long-press) looks for the nearest OSM peak with an `ele` within `summitSnapRadius` (`snap.js`: 10 CSS px of map, at least 110 m, at most 500 m; the 500 m cap is a candidate, not tuned), moves the observer onto it and sets `state.g` = its OSM elevation (hash `g=`), sent as `ground` with `view`. Every other `placeAt` clears `g`. Measured 2026-11-11: Großer Feldberg 872 m sampled → 880 m, which opens the whole south-west sector at 1.7 m eye height.
- Map gestures: mouse click = move observer, mouse hover = spot check; touch/pen tap = spot check (tooltip), long-press 500 ms = move observer (user decision 2026-11-07).
- Panorama window: `panoWindow` `{start, span}` in degrees (`panoview.js`, tested in `test/panoview.test.js`); every azimuth ↔ x mapping goes through `panoFraction` / `panoAzimuth`. Wheel zooms about the pointer, mouse drag turns, two fingers pinch/pan, double-click or `#panoreset` resets; smallest span = 4 px per ray. Not persisted. Pinch is untested on a device (headless run covered wheel, drag, reset; 2026-11-11).
- Panorama gestures: `#pano` has `touch-action: pan-y` (without it a sideways finger slide fired `pointercancel` and hid the readout, reproduced in headless Chrome 2026-11-08); touch/pen readouts stay after lifting until the next press on map or panorama; mouse leave hides.
- Highlight colour: `state.highlight` (magenta default, green, orange, blue; orange/blue = Okabe-Ito, colour-blind safe) sets `data-highlight` on `<html>`, CSS overrides `--horizon`/`--vis` per theme; saved in localStorage only, not in the hash. `readColors()` re-runs `tintMask()`.
- Peak names: local OSM name by default; the Local/English toggle (`state.names`, hash `names=en`) picks row[4] (`name:en`) where present. The page maps names before posting rows to the worker.
- OSM overlay: `state.osm` 0–100 (localStorage only), slider `#osm`; raster tiles from `tile.openstreetmap.org` (CORS `*`, checked 2026-11-08; tile usage policy: attribution on the map, no prefetch) drawn after borders, before the tint, with `globalAlpha`; each tile `Image` sets `referrerPolicy = "strict-origin-when-cross-origin"` because Cloudflare sends `Referrer-Policy: same-origin` and OSM blocks Referer-less requests (user report 2026-11-08); zoom `round(log2(k·W/256))` without dpr; ≤ 6 in flight, LRU 300, loads start after the view is still 150 ms (the Fit animation otherwise fetched every intermediate zoom); 0 % = zero requests.
- Theme: colors are CSS custom properties (light + dark under `prefers-color-scheme` and `[data-theme]`). Canvas code reads them via `readColors()` into `colors`; a new canvas color must be added to the name list there.

**Coverage**: worldwide between 85° S and 85° N (Mercator limit). Terrarium smooths summits: z10 alone gave Großer Feldberg 865 m (SRTM 881 m); the z12 near field raised it to 876 m (both measured 2026-11-07). The rest is the ~30 m source data (Matterhorn 4,301 m vs 4,478 m), so standing on a sharp peak is still a known weak spot.

## Data formats

All data files are rebuilt by scripts in `scripts/` (each has a docstring with the exact command):
- `data/cities.json` / `data/cities-1000.json` (`scripts/build_cities.py`, GeoNames cities1000, CC BY 4.0): rows `[name, countryCode, lat, lon, population]`; `cities.json` = population ≥ 5000 (69k rows), `cities-1000.json` = all 172k; **sorted descending by population**. `drawCities()` stops at the first row below its population threshold (`break`), and search fills up to 8 matches in file order, so keep this sort order.
- `data/world.json` (`scripts/build_outlines.sh`): TopoJSON `land`, `countries` = world-atlas@2.0.2 countries-10m with `name` → `n`, reproduced byte for byte. `data/lakes.json`: TopoJSON `map.geo` = Natural Earth 10m lakes v4.1.0 (since 2026-11-07; the earlier file had an unknown source and licence).
- `data/peaks/{N50E008}.json` + `data/peaks/index.json` (`scripts/build_peaks.sh` → `build_peaks.py`, OSM `natural=peak` filtered with osmium from the planet file (default: FAU mirror, 8 resumable range requests capped at 87.5 MB/s = 70% of the 1 Gbit line, user limit 2026-11-07; `--continents` = Geofabrik extracts), ODbL: credit "© OpenStreetMap contributors"): 2°×2° cells named by SW corner, rows `[name, lat, lon, ele|null]` plus an optional 5th `nameEn` (only when `name:en` exists and differs; `name` is the local OSM name), sorted by `ele` desc; `--reuse-filtered` rebuilds from the cached `peaks-planet.osm.pbf` without downloading; `index.json` lists existing cells. Build of 2026-11-07: 697,955 named peaks in 4,184 cells (42,531 with `nameEn`), 29 MB raw / ~10.6 MB gzip, ~25 min download + 3 min filter. `fixWinding()` reverses rings whose spherical area > 2π (wrong winding order).
