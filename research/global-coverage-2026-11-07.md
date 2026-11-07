# Global coverage for Horizon Finder — research note, 2026-11-07

Scope: facts needed to choose how a static, backend-free viewshed page can load elevation, place names,
outlines and peak names per region anywhere on Earth. This note does **not** pick a design.

Method: every measurement below was run in this session from a Linux host (Node 24, curl 8.x) against the
public URL shown. Downloads went to `/tmp/hmapres`. Status labels:

- **verified** — fetched or measured in this session; evidence is in the appendix or inline.
- **unverified** — from memory or a secondary source, not checked here.

Two project facts that constrain every option (read from the repo, verified):

- `index.html` defines one rectangle `REG = {la0:48, la1:52, lo0:6, lo1:11}` and the worker allocates a flat
  `new Array(NLA*NLO)` indexed by `(la-LA0)*NLO + (lo-LO0)`. Going global needs a keyed tile map, and
  `tilesFor()` currently scans the whole region on every view, while `loadRest()` loads *every* tile of the
  region for hillshade after the first view. Both must become radius- or block-limited.
- One DEM tile is 1201×1201 RGB PNG, ≈ 0.99 MB mean (20 files, 19,754,657 B total, min 719,411, max
  1,149,783 — measured from `dem/`). The panorama already treats missing elevation as "edge of data".

---

## A. Elevation sources

### A1. What the browser can fetch directly, and how

| Source | URL pattern | Format / grid | Native resolution | Coverage | Licence / attribution | CORS (real request) | One tile at 50°N 8°E | Browser decode |
|---|---|---|---|---|---|---|---|---|
| AWS Terrain Tiles — `skadi` | `https://s3.amazonaws.com/elevation-tiles-prod/skadi/N50/N50E008.hgt.gz` (`S`/`W` for south/west) | gzip'd HGT, big-endian int16, 3601×3601 per 1°×1° | 1″ (~30 m) where SRTM exists; coarser upsampled data elsewhere | all five 1° cells tested return 200, incl. 78°N, 70°S and an ocean cell (bathymetry) | Mixed, per-provider attribution list (Mapzen/Joerd) | **`Access-Control-Allow-Origin: *`** on GET/206; **absent on HEAD** | **8,455,883 B in 1.32 s** gz; 25,934,402 B decompressed | `DecompressionStream("gzip")` → `DataView.getInt16(offset, false)`; 25.9 MB RAM per tile |
| AWS Terrain Tiles — `terrarium` | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | PNG, 256×256, Web Mercator; `(R*256 + G + B/256) - 32768` | z10 ≈ 98 m/px at 50°N; z15 ≈ 3.1 m/px | global; z15 tested 200 | same attribution list | **`*`** (GET) | z10 **127,315 B / 0.63 s**; z11 123,114 B; z12 108,781 B | `createImageBitmap` + `getImageData` (already used on our PNGs) |
| AWS Terrain Tiles — `geotiff` | `https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif` | GeoTIFF, 512×512, 16-bit, deflate, Web Mercator | z10 ≈ 98 m/px; **max z14** (z15 → 404, two tiles tested) | global to z14 | same attribution list | **`*`** (GET) | z10 **125,694 B / 0.73 s** | needs a library: **geotiff.js**, `/dist-browser/geotiff.js` = **317,520 B** minified (unpkg) |
| Copernicus DEM GLO-30 (AWS Open Data) | `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N50_00_E008_00_DEM/Copernicus_DSM_COG_10_N50_00_E008_00_DEM.tif` | COG GeoTIFF, 32-bit float, deflate; 2400×3600 measured at 50°N (varies with longitude) | 1″ | global land, minus a few restricted countries | Free; notice: “© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved” | **No `access-control-allow-origin` line at all** on 206 (tested direct and regional host) | **30,741,998 B / 0.94 s** | geotiff.js, or our own scripts (see A2) |
| Copernicus DEM GLO-90 | `https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_N50_00_E008_00_DEM/...tif` | COG, 32-bit float; 800×1200 measured | 3″ | global land | same notice, “WorldDEM-90” wording | **absent** | **3,734,343 B / 0.23 s** | geotiff.js / offline only |
| Viewfinder Panoramas DEM3 | `https://viewfinderpanoramas.org/dem3/M32.zip` (sheet folder; M32 = N48–51, E6–11) | ZIP of 1°×1° HGT, **1201×1201**, big-endian int16 | 3″ | global, SRTM voids filled | “research and private use”; “Limited commercial use is OK, but anyone contemplating large scale reproduction should contact me” | **absent** on 206 | sheet **29,039,641 B / 1.54 s** (24 tiles, 2,884,802 B each = 1201²×2) | `DecompressionStream("deflate-raw")` in the browser, or unzip in our scripts |
| ALOS AW3D30 (JAXA) | registration then HTTPS download (no stable anonymous pattern found) | GeoTIFF, 1″ DSM | 1″ (~30 m) | global land | free, commercial and non-commercial, under JAXA terms; **account required** | n/a (not anonymous) | not measured | offline only |
| NASADEM | LP DAAC / Earthdata (login) | HGT/GeoTIFF, 1″ and 3″ | 1″ | 60°N–56°S | public domain (NASA) | n/a (auth) | not measured | offline only |
| MERIT DEM | U-Tokyo page now redirects to `global-hydrodynamics.github.io`; request form | GeoTIFF, 3″ | 3″ | 90°N–60°S (claim, unverified) | research licence, registration | n/a | not measured | offline only |

### Row sources and status

- **AWS Terrain Tiles (all three formats):** registry page `https://registry.opendata.aws/terrain-tiles/`
  and `https://github.com/tilezen/joerd` docs — **verified** (both fetched). URL patterns, byte sizes, times
  and CORS headers were measured directly (appendix). Zoom coverage: terrarium z15 exists, geotiff z14
  exists / z15 404 — **verified**.
- **Copernicus GLO-30/GLO-90:** `https://registry.opendata.aws/copernicus-dem/` (licence, coverage, COG
  format) and `https://dataspace.copernicus.eu/.../COP-DEM` (user obligations text) — **verified** (fetched).
  Tile bytes and CORS tested on both buckets — **verified**.
- **Viewfinder Panoramas:** `https://viewfinderpanoramas.org/dem3.html`, `dem3h.html`,
  `Coverage map viewfinderpanoramas_org3.htm`, `https://viewfinderpanoramas.org/index.htm` (terms) —
  **verified** (all fetched). Sheet contents measured (M32).
- **ALOS AW3D30:** `https://www.eorc.jaxa.jp/ALOS/en/dataset/aw3d30/aw3d30_e.htm` — **verified** (fetched:
  1″ DSM, “Any of the commercial and non-commercial purposes can be used free of charge”, account required).
- **NASADEM:** `https://lpdaac.usgs.gov/products/nasadem_hgtv001/` redirects to
  `https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001` — **verified** (301). The claim that
  download needs an Earthdata Login is **unverified** (no working anonymous URL was found; a guessed
  `e4ftl01.cr.usgs.gov` path returned 404).
- **MERIT DEM:** the old U-Tokyo URL now serves a “website has moved” page pointing to
  `https://global-hydrodynamics.github.io/` — **verified**. The 3″/90°N–60°S claims and the request form are
  **unverified** (not reached).

Additional detail and caveats:

- The AWS attribution file (`https://github.com/tilezen/joerd/blob/master/docs/attribution.md`) lists ~14
  providers that must be credited when using Terrain Tiles (ArcticDEM, Geoscience Australia, Austria,
  Canada, Copernicus/EU-DEM, ETOPO1, INEGI, LINZ, Kartverket, UK Environment Agency, USGS 3DEP/GMTED/SRTM).
  This is a long attribution string, not a single credit. **verified** (file fetched).
- The Joerd format doc states `terrarium` is 256×256 with a 32,768 offset, 16 integer bits + 8 fractional
  bits, and `geotiff` is 512×512; it also documents that the source stack is ETOPO1 in water, GMTED at low
  zooms, SRTM on land, with national LiDAR/DEM overrides. **verified** (`docs/formats.md`, `docs/data-sources.md`).
  Above 60°N the stack switches to ArcticDEM/GMTED, so “30 m” is not true everywhere. **verified from the
  zoom table in `data-sources.md`.**
- CORS nuance: the S3 bucket answers `HEAD` without CORS headers but answers `GET`/range requests with
  `Access-Control-Allow-Origin: *`. A browser `fetch()` uses GET, so this is usable; a `HEAD` pre-check from
  the page would fail. **verified** (both requests run).
- Skadi is *not* 30 m everywhere. Measured tile contents: N78E015 min −283 m / max 1,108 m, 0 voids;
  S70E010 min −2,700 / max 47; N00E000 (ocean) min −5,000 / max −4,648 — i.e. bathymetry. The high-latitude
  values are plausibly upsampled GMTED/ArcticDEM, not SRTM; the exact per-tile source is not exposed on the
  object (no `x-imagery-sources` metadata on skadi, unlike terrarium). **partly verified** (values measured;
  provenance inference unverified).
- Copernicus is a **DSM** (buildings and vegetation included), not a bare-earth DTM; SRTM is also a
  surface model (C-band penetrates vegetation only partly). This matters for a horizon tool: tree cover
  can raise the apparent horizon. **verified** (registry text: “represents the surface of the Earth
  including buildings, infrastructure and vegetation”).
- Copernicus COG tiles are 1°×1° but pixel counts vary by longitude (2400×3600 at 50°N measured, readme says
  3601²/2401²/1801² variants before edge trimming). **verified** (`readme.html`).
- Viewfinder DEM3 is the only source found that is **already on our exact grid** (1° cell, 1201×1201,
  int16 metres, SW-corner naming), which makes conversion to our PNG a byte-level repack with no resampling.
  **verified** (zip listing + exact byte size 2,884,802 = 1201²×2).
- Viewfinder DEM3 sheet coverage: `dem3.html` claims “The whole world is now on this site at 3 and 15 arc
  second resolutions”; only the M32 sheet (N48–51, E6–11) was downloaded here. **partly verified**
  (claim from site; one sheet measured).

### A2. Memory and decode cost (browser side)

| Payload | Bytes on wire | Decoded in memory | Decode path |
|---|---|---|---|
| our 3″ PNG tile | ≈ 0.99 MB | 1201²×2 = 2.88 MB Int16 | `createImageBitmap` + `getImageData` (current code) |
| skadi 1″ HGT.gz | 8.46 MB | 3601²×2 = 25.9 MB Int16 | gunzip + byte-swap loop over 12.97 M samples |
| terrarium z12 tile | 0.11 MB | 256² RGBA = 0.26 MB, then 16-bit height | canvas |
| Copernicus GLO-30 1° tile | 30.7 MB | 2400×3600×4 = 34.6 MB float32 | geotiff.js + deflate; not viable per-view |

A 100 km-radius view at 50°N covers roughly 2° of latitude and 4° of longitude (≈ 8 one-degree tiles) in
our current 1° scheme — about 8 MB of PNG or 207 MB of raw skadi HGT. This is the main argument for
pre-processing skadi (or using Viewfinder) rather than decoding 1″ HGT in the page.

---

## B. Place names by region (GeoNames)

Dumps: `https://download.geonames.org/export/dump/{cities500,cities1000,cities5000,cities15000}.zip`.
All four were downloaded and unpacked in this session. **verified.**

| Dump | ZIP bytes | .txt bytes | Rows (lines) | Compact JSON `[name,cc,lat,lon,pop]` | gzip of that JSON |
|---|---|---|---|---|---|
| `cities500.zip` | 13,919,603 | 41,768,153 | 236,953 | 10,015,218 B | 3,777,820 B |
| `cities1000.zip` | 11,090,762 | 32,060,313 | 171,806 | not built | — |
| `cities5000.zip` | 5,725,971 | 15,286,970 | 70,018 | 3,021,370 B | 1,223,766 B |
| `cities15000.zip` | 3,366,116 | 8,548,400 | 34,205 | 1,479,343 B | 617,027 B |

Licence: “This work is licensed under a Creative Commons Attribution 4.0 License” —
`https://download.geonames.org/export/dump/readme.txt`. **verified.**

Chunking model: group the compact rows into 5°×5° cells (floor(lat/5), floor(lon/5)); one file per cell,
only for cells that contain rows.

| Dump | 5° cells with rows | Largest cell | Median cell |
|---|---|---|---|
| cities15000 | 664 | 27,034 B | 637 B |
| cities5000 | 751 | 68,631 B | 941 B |
| cities500 | 879 | 357,621 B | 1,479 B |

Notes:

- A single global `cities15000` file is only 1.5 MB uncompressed (0.6 MB gzip) — small enough that
  “one global search index + per-region display chunks” is a real option. `cities5000` at 3.0 MB / 1.2 MB gz
  is still modest. `cities500` at 10 MB / 3.8 MB gz is the upper bound if every 500-person village is wanted.
- The repo's current `data/cities.json` is 2,031,322 B for ~49k rows — consistent with the ~41 B/row seen
  here, and far below `cities5000` (70k rows) because it is filtered and rounded.
- Population is field 15 (index 14), name field 2, country field 9, lat 5, lon 6 in the TSV. **verified**
  by parsing.
- Cities do not solve peak naming; they are labels and search only.

---

## C. Outlines by region (Natural Earth)

ZIP sizes from `https://naciscdn.org/naturalearth/{scale}/{physical|cultural}/ne_{scale}_{layer}.zip`;
GeoJSON from the `nvkelso/natural-earth-vector` mirror; TopoJSON produced in this session with
`npx mapshaper@0.6.102 <file>.geojson -o format=topojson`. **all verified.**

| Layer | 110m ZIP | 50m ZIP | 10m ZIP | 10m GeoJSON | 10m TopoJSON | 10m TopoJSON gzip |
|---|---|---|---|---|---|---|
| land | 69,700 | 457,183 | 3,269,070 | 10,157,965 | **4,066,288** | 1,282,845 |
| admin_0 countries | 214,976 | 799,734 | 4,930,492 | 13,287,234 | **5,212,939** | 1,517,140 |
| lakes | — | 252,615 | 2,349,685 | 5,043,554 | **2,671,123** | 616,497 |

Licence: “All versions of Natural Earth raster + vector map data found on this website are in the public
domain” — `https://www.naturalearthdata.com/about/terms-of-use/`. **verified.** Attribution is not legally
required; “Made with Natural Earth” is the customary credit.

Notes:

- The whole 10m set (land + countries + lakes) is ≈ 11.95 MB of TopoJSON, 3.4 MB gzipped. That is roughly
  twice the repo's current `data/world.json` (3,660,305 B, 477,295 TopoJSON points) + `data/lakes.json`
  (1,277,836 B, 132,732 points) and needs no regional splitting at all. **verified** (sizes; the source
  resolution of the repo files was not identified).
- Regional splitting only pays off for *much* higher detail (OSM coastlines) or for vector tiles. At 10m,
  a 10°×10° clip is a small fraction of the global 12 MB, but clipping requires real polygon clipping
  (mapshaper `-clip`, GDAL `ogr2ogr -clipsrc`, or `geojson-vt`/`tippecanoe` for tiles); simple bbox filtering
  does not work because continents are single MultiPolygons (10m land is 11 features).
- Tooling worth naming: **mapshaper** (clip/simplify/TopoJSON, used here), **GDAL/ogr2ogr** (clip, reproject),
  **tippecanoe** (MBTiles/PMTiles vector tiles), **geojson-vt** (client-side tiling), **PMTiles** (single-file
  range-served tiles). Only mapshaper was exercised in this session; the rest are unverified.
- Natural Earth data on `naturalearth.s3.amazonaws.com` also returns `Access-Control-Allow-Origin: *`
  (tested 110m/10m land), so a page *could* fetch outlines from AWS instead of self-hosting. **verified.**

---

## D. OSM peaks, globally

### D1. How many, and which tags

`https://taginfo.openstreetmap.org/api/4/tag/stats?key=natural&value=peak`, `data_until 2026-11-07T00:59:21Z`:
**1,114,314 total objects, of which 1,114,178 are nodes** (110 ways, 26 relations). **verified.**

Tag coverage, measured on a real 1° cell (50–51°N, 8–9°E, Overpass `out body`, 1,374 nodes):

| Tag | Nodes with tag | Share |
|---|---|---|
| `name` (any) | 1,200 | 87.3 % |
| `ele` | 1,181 | 86.0 % |
| `prominence` | 1 | 0.07 % |
| unique names | 1,007 | — |

`ele` appears on **2,571,446 nodes** across all of OSM; `prominence` on only **14,376 nodes**
(taginfo key stats). **verified.** So `prominence` cannot be a required field; it is a bonus for a few
thousand peaks.

### D2. Per-region size

| Sample | Peaks | Full Overpass JSON | Compact JSON `[name,lat,lon,ele]` | gzip | Bytes/peak |
|---|---|---|---|---|---|
| 50–51°N, 8–9°E (low mountains) | 1,374 | 249,519 B | 48,347 B | 18,928 B | 35.2 |
| 47–48°N, 12–13°E (Alps) | 2,362 | not fetched | ≈ 83,000 B (model) | — | 35.2 |
| 27.9–28.9°N, 86.8–87.8°E (Everest) | 269 | not fetched | ≈ 9,500 B (model) | — | 35.2 |
| 0.5° box near Innsbruck | 640 | not fetched | — | — | — |

Model: 1,114,178 peaks × 35 B ≈ **39 MB** global compact JSON (≈ 15 MB gzip); per 1° cell the observed
range is 0.3k–2.4k peaks = 10–85 KB. A binary form (int32 lat, int32 lon, int16 ele, name offset) would be
≈ 14 B + name, roughly 25–30 MB global. The 35 B/peak figure is measured; the global total is an
extrapolation, not a measurement.

### D3. Overpass on demand — is it allowed?

Primary policy: `https://dev.overpass-api.de/overpass-doc/en/preface/commons.html`:

> “Setting up an app for more than just OSM mappers and relying on the public instances as backend.”
> (listed under “Examples of problematic behaviour”)

> “In the last cast, only running your own instance sustainably serves your mission.”

> “As a broad guideline to stay within safety margins, users are expected to send a maximum of about
> 10000 requests per day and keep their download volume below about 1 GB per day.”

Wiki instance table, `https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances`,
for the main `overpass-api.de` instance:

> “You can assume that you don't disturb other users when you do less than 10,000 queries per day and
> download less than 1 GB data per day … If you set something up that uses the Overpass API regularly,
> then divide those numbers by 100 … **If you have an app or website, then the usage counts towards the
> sum of requests made by all your users.**”

> “Be sure to check that your app or website adds User-Agent or Referer headers to requests that uniquely
> identify your app. No parallel running of multiple scripts. Commercial use should use self-hosted or paid
> Overpass servers. Cache and rate-limit calls, use extracts if you need a lot of data.”

> “Nowadays this server is overloaded - be mindful of that, do not overconsume resources and do not expect
> high reliability.”

**verified** (both pages fetched 2026-11-07). Practical reading: a public web page *can* call it technically,
but the quota is counted across all users of the app rather than per visitor, a browser cannot set a custom
`User-Agent` (it can send `Referer`), and a “regularly used app” is asked to keep under ~100 queries/day in
total — which rules out per-visitor on-demand queries at any scale, and points to a pre-built extract.

Technical check: `POST https://overpass-api.de/api/interpreter` with form-encoded `data=...` returns
`access-control-allow-origin: *`, so the browser can call it; a query sent without a `User-Agent` got a 406,
and a GET without one returned an empty body, while the same query with a UA succeeded. Count queries over
1° took **22–41 s** each. **verified.**

### D4. Pre-built extract

- Planet PBF: `https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf` = **95,715,394,709 B**
  (Last-Modified 2026-11-05). Europe PBF = **35,389,153,230 B**. **verified** (Content-Length).
- Filter with osmium: `osmium tags-filter planet.osm.pbf n/natural=peak -o peaks.osm.pbf` then
  `osmium export` / `osmium cat -f opl`. **unverified command** (not run here; osmium not installed).
  Geofabrik regional extracts are an alternative to the planet for a first build.
- Ship compact per-region JSON or a binary; 1° cells are ~10–85 KB (measured above). A full global file is
  ~39 MB JSON, so regional chunking is mostly about first-load latency, not total size.
- ODbL obligations (`https://www.openstreetmap.org/copyright`): credit “© OpenStreetMap contributors”,
  “Make clear that the data is available under the Open Database License”, and for a derived database
  “may distribute the result only under the same license.” **verified** (page fetched). In practice: a
  visible attribution line plus a link to the ODbL, and if we publish an enriched peak database, it must be
  ODbL too. Offering the extract as a separate downloadable file is the clean way to satisfy share-alike.

---

## E. Prior art

| Project | DEM / data | How data is loaded | Worth copying |
|---|---|---|---|
| **HeyWhatsThat** (`heywhatsthat.com`) | SRTM, “roughly every 100 feet … for the US and every 300 feet elsewhere, covering latitude 60°N to 54°S” (FAQ) | Server-side computation; the page posts a viewpoint and gets back panorama/skyline images and a visibility map | The 360° panorama + “what can I see” interaction, and the explicit statement of DEM limits. Its FAQ is a good model for honesty about resolution. **verified** |
| **PeakFinder** (`peakfinder.com/about/resources`) | Regional mix: Copernicus GLO-30 worldwide, NASADEM worldwide, Viewfinder 3″/1″ “Mountain Top Horizon Maps”, EU LiDAR v25, USGS 3DEP, Japan GSI, NZ LiDAR, ArcticDEM v4.1; peak names from OSM + GeoNames | Ships a WASM viewer (`wasm.peakfinder.com/4.10.4`) with offline packs; covers “northern to southern latitude 85°” | The per-region source table itself: pick the best free source per region instead of one global DEM; offline-first packaging. **verified** |
| **udeuschle.de panoramas** | SRTM (NASA LP DAAC) + Viewfinder Panoramas; “The whole earth is covered (light blue: 3″ resolution, dark blue: 1″)” | Panorama generated from a viewpoint + azimuth window; summit names from OSM planet, GeoNames, and regional lists (server-side generation inferred from the form, not inspected) | Server-side rendering keeps the client tiny; a documented data-source page. **verified** for the data list; generation method **unverified** |
| **PeakVisor** (`peakvisor.com`) | Not disclosed publicly (proprietary). Claims “more than a million peaks” and worldwide 3D/offline | Native app + web, offline 3D map packs; AR identification | The peak-count scale (~1 M, same order as OSM `natural=peak`) and offline region packs. DEM source **unverified** |
| **KHwong12/viewshed-peaks** (open source) | Hong Kong Lands Department DTM; 50 m output grid | MapLibre/3D web map, client-computed viewshed | A working open-source browser viewshed with a 3D map; small area, single source. **verified** (README) |
| **AllTheLines/CacheTVS** (open source) | any raster DEM | GPU total-viewshed computation (research code) | Cache-efficient many-origin viewshed algorithm; not a web app. **verified** (GitHub search description) |
| **tilezen/joerd** (open source) | the AWS Terrain Tiles pipeline | Batch pipeline producing skadi/terrarium/geotiff | The exact recipe for producing our own tiles from mixed sources, and the attribution generator. **verified** (docs fetched) |

---

## F. Hosting implications of self-hosted static tiles

### F1. How much data

Measured from the repo: 20 tiles, 19,754,657 B, mean **987,733 B/tile**. Land 1° cells were counted by
testing cell centres against Natural Earth land polygons (point-in-polygon): **21,538** land cells
globally, of which **11,620** lie in the SRTM band 56°S–60°N (NE 110m; the 50m polygons give 21,447 /
11,577). **verified measurement, approximate by method** (± a few hundred cells; a centre-point rule
undercounts slivers).

| Dataset | Tiles | Size at 0.99 MB/tile |
|---|---|---|
| Global land, 1° | 21,538 | **≈ 21.3 GB** |
| Land inside 56°S–60°N (SRTM band) | 11,620 | **≈ 11.5 GB** |
| Current 48–52°N, 6–11°E | 20 | 19.8 MB |

If we keep 1″ instead of 3″, multiply by roughly 3 (3601² vs 1201² samples), before compression — i.e.
30–60 GB. **unverified** (not built).

### F2. Do free hosts accept it

| Host | Quoted limit | Consequence |
|---|---|---|
| GitHub Pages | “Published GitHub Pages sites may be no larger than 1 GB.” “soft bandwidth limit of 100 GB per month.” (`docs.github.com/.../github-pages-limits`) | Cannot hold global DEM (11–21 GB). At 8 MB/view, 100 GB/month ≈ 12,500 views. **verified** |
| Cloudflare Pages | “Cloudflare Pages sites can contain up to 20,000 files on the Free plan.” “The maximum file size for a single Cloudflare Pages site asset is 25 MiB.” (`developers.cloudflare.com/pages/platform/limits/`) | 11,620 band tiles fit the 20k file cap; the full 21,538 does not. Per-file size is fine. Total-size limit not stated. **verified** |
| Cloudflare R2 | Free tier: “Storage 10 GB-month / month”, “Class B Operations 10 million requests / month”, egress free. Standard storage $0.015/GB-month. (`developers.cloudflare.com/r2/pricing/`) | 11.5 GB slightly exceeds the free 10 GB; 21.3 GB ≈ $0.32/month. Range requests are Class B. **verified** |

Practical note: a 1° tile is fetched whole even if a view touches only its edge, and at high latitude a 1°
cell is small in km but costs the same bytes. A quadtree or Web-Mercator tile store wastes less at high
latitude. **unverified design judgement.**

---

## Options (end-to-end, no winner picked)

Byte figures are for one 100 km-radius view at 50°N (≈ 200 km across), using measured tile sizes.

### Option 1 — Self-hosted 3″ PNG regions, global outlines, chunked names and peaks

- **Browser loads per view:** 6–9 DEM PNG tiles from the nearest 5° block(s) (≈ 6–9 MB); one global
  outlines file (3.4 MB gz, cached); one city chunk (median < 1 KB, worst 69 KB for `cities5000` on a 5°
  cell); one peak chunk (10–85 KB for a 1° cell).
- **Scripts must pre-build:** HGT → our 1201×1201 RGB PNG packer (Viewfinder tiles need no resampling;
  skadi needs 3:1 downsampling); 5° block index/manifest; city chunks from `cities15000`/`cities5000`;
  peak chunks from an osmium-filtered planet; global 10m TopoJSON (mapshaper).
- **Licence duties:** Viewfinder permission for “large scale reproduction” (contact the author); ODbL
  attribution + share-alike for peaks; CC BY 4.0 for GeoNames; Natural Earth public domain.
- **Risks:** 11–21 GB of storage and the corresponding egress; Viewfinder licence is the blocker; peak
  freshness depends on extract rebuilds; 1° blocks are wasteful at high latitude.

### Option 2 — No DEM hosting: browser fetches AWS Terrarium tiles

- **Browser loads per view:** z10 = 8×8 = 64 tiles ≈ 8.1 MB (98 m/px — coarser than the current 60 m ray
  step); z11 = 16×16 = 256 tiles ≈ 31 MB (49 m/px); z12 ≈ 1,024 tiles ≈ 111 MB (25 m/px, impractical).
- **Scripts must pre-build:** only city/peak chunks and the global outlines; no DEM pipeline at all.
- **Licence duties:** the full Mapzen/Joerd attribution block (~14 providers) in the UI; ODbL for peaks;
  CC BY for GeoNames.
- **Risks:** third-party dependency and rate behaviour; no control over future tile content; 8–31 MB per
  view; z10 too coarse for a 60 m horizon at 100 km; still needs our own peaks/cities (no CORS problem —
  `*` verified).

### Option 3 — Self-hosted multi-resolution pyramid (LOD) from a mixed source stack

- **Browser loads per view:** fine 3″ tiles for the inner ~50 km (≈ 2 tiles, 2 MB) + 9″ or 15″ tiles for the
  rest (≈ 4–6 tiles at 0.1–0.3 MB) ≈ **3–4 MB** per 100 km view, with several zoom levels cached.
- **Scripts must pre-build:** a tile pyramid (e.g. 3″, 9″, 30″) per 5°/10° block from skadi/Viewfinder or
  Copernicus; manifests; the same city/peak/outline work as Option 1.
- **Licence duties:** depends on the chosen source: Joerd attribution block, or the Copernicus notice, plus
  ODbL for peaks. If Viewfinder is the 3″ source, the same permission issue applies.
- **Risks:** most build work (resampling, LOD selection in the worker, more code paths); larger total
  storage than single-resolution unless the coarse levels replace, not duplicate, fine tiles.

### Option 4 — Thin tile service in front of a COG source (Cloudflare Worker + R2 cache)

- **Browser loads per view:** our PNG tiles from the Worker (≈ 6–9 MB), same as Option 1.
- **Scripts must pre-build:** the Worker (range-read COG via geotiff.js, or serve pre-tiled R2 objects), a
  cache key scheme, and the city/peak/outline work. DEM can be generated lazily from Copernicus GLO-30/90
  (no bulk storage) or pre-tiled into R2.
- **Licence duties:** Copernicus notice (“produced using Copernicus WorldDEM-30 © DLR …”), ODbL for peaks,
  CC BY for GeoNames; no Viewfinder dependency if Copernicus is the source.
- **Risks:** the project is no longer purely static (needs a Worker and an account), cold-start and egress
  cost, and Copernicus is a DSM with vegetation/building bias; adds a moving part that the current
  “python3 -m http.server” workflow does not have.

Combination notes: peaks and cities are independent of the DEM choice — all four options need the same
pre-built peak extract (or accept the Overpass limits) and the same city chunks. Outlines are cheap enough
(≈ 12 MB TopoJSON global) that regional splitting is optional in every option.

---

## Open questions for the user

1. **Licence tolerance.** Is contacting Jonathan de Ferranti for large-scale Viewfinder use acceptable, or
   should the pipeline avoid Viewfinder entirely (skadi/Copernicus only)?
2. **Hosting budget.** Is a paid R2 bucket (≈ 21 GB, ≈ $0.32/month) acceptable, or must this stay
   inside a free tier (10 GB, 20k files)?
3. **Static or “static plus one Worker”.** Does Option 4's Worker violate the “no backend” constraint?
4. **Target range and resolution.** What `rmax` should be supported globally — 50 km, 100 km, 200 km? That
   decides whether 3″ everywhere is enough or a LOD pyramid is required.
5. **Latitude scope.** Is Antarctica / >60°N in scope? SRTM stops at 60°N; skadi fills with GMTED/ArcticDEM
   there, and the quality claim changes.
6. **Peak data freshness.** Is a quarterly planet extract acceptable, or is on-demand Overpass needed for
   fresh peaks (which the policy effectively forbids at scale)?
7. **Peak attributes.** Do we need `prominence` (present on only ~14k OSM nodes) or is `ele` + `name` enough?
8. **Search scope.** Should global search cover all `cities500` (10 MB JSON / 3.8 MB gz) or only
   `cities5000`/`cities15000`?

---

## Appendix — evidence log

Commands were run from `/tmp/hmapres` unless noted; output quoted verbatim where it matters.

```
# skadi range GET with Origin
$ curl -s -o /dev/null -D - -H "Origin: https://example.org" -r 0-99 \
    https://s3.amazonaws.com/elevation-tiles-prod/skadi/N50/N50E008.hgt.gz
HTTP/1.1 206 Partial Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
Access-Control-Expose-Headers: x-amz-meta-x-imagery-sources
Access-Control-Max-Age: 3000
Vary: Origin, Access-Control-Request-Headers, Access-Control-Request-Method
Content-Range: bytes 0-99/8455883
Content-Type: application/x-gzip

# same object, HEAD (no CORS headers present)
$ curl -sI -H "Origin: https://example.org" https://s3.amazonaws.com/.../N50E008.hgt.gz
HTTP/1.1 200 OK
Content-Length: 8455883

# full download
$ curl -s -o N50E008.hgt.gz -w 'size=%{size_download} time=%{time_total}\n' ...
size=8455883 time=1.318747
$ file N50E008.hgt.gz
gzip compressed data ... original size modulo 2^32 25934402

# Copernicus GLO-30, range GET with Origin (no access-control line)
$ curl -s -o /dev/null -D - -H "Origin: https://example.org" -r 0-100 \
    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N50_00_E008_00_DEM/...tif
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-100/30741998
Content-Type: image/tiff

# terrarium / geotiff at 50N 8E
terrarium/10/536/345.png  code=200 bytes=127315 time=0.626686
geotiff/10/536/345.tif    code=200 bytes=125694 time=0.727800
terrarium/11/1072/690.png code=200 bytes=123114 time=0.690875
terrarium/12/2144/1380.png code=200 bytes=108781 time=0.745562
geotiff/15/1092/704.tif   code=404
geotiff/14/8736/5632.tif  code=200

# Viewfinder sheet
$ curl -o M32.zip https://viewfinderpanoramas.org/dem3/M32.zip
code=200 size=29039641 time=1.543146
$ unzip -l M32.zip | awk '{print $4}' | grep hgt | wc -l
24                      # N48E006 .. N51E011, 2,884,802 B each

# GeoNames
cities500   zip=13919603 txt=41768153 lines=236953
cities1000  zip=11090762 txt=32060313 lines=171806
cities5000  zip=5725971  txt=15286970 lines=70018
cities15000 zip=3366116  txt=8548400  lines=34205

# Natural Earth ZIPs (HEAD Content-Length)
ne_110m_land 69700 | ne_50m_land 457183 | ne_10m_land 3269070
ne_110m_admin_0_countries 214976 | ne_50m_admin_0_countries 799734 | ne_10m_admin_0_countries 4930492
ne_50m_lakes 252615 | ne_10m_lakes 2349685

# TopoJSON built here
land10.topojson 4066288 (gz 1282845)
countries10.topojson 5212939 (gz 1517140)
lakes10.topojson 2671123 (gz 616497)

# Land-cell count (point-in-polygon, NE 50m)
land50.geojson -> {"landCells":21447,"bandLandCells":11577}   # 110m: 21538 / 11620
# repo PNG tiles
files 20 sum 19754657 mean 987733 min 719411 max 1149783

# taginfo
natural=peak: total 1114314, nodes 1114178, ways 110, relations 26
ele nodes 2571446; prominence nodes 14376

# Overpass POST, CORS and timing
HTTP 200, access-control-allow-origin: *
47.0,12.0,48.0,13.0 -> peaks 2362, 36.9 s
50.0,8.0,51.0,9.0   -> peaks 1374, 41.0 s
27.9,86.8,28.9,87.8 -> peaks 269, 22.6 s
full body 50-51N 8-9E: 249,519 B; compact 48,347 B; gz 18,928 B; 35.2 B/peak

# Sizes
planet-latest.osm.pbf 95715394709 B (2026-11-05)
europe-latest.osm.pbf 35389153230 B
```

Report written 2026-11-07. Only this file was created in the repo; all downloads live under `/tmp/hmapres`.
