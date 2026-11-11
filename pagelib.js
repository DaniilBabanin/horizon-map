// Pure helpers behind the page's main script: the longitude wrap, ray count, flat-horizon
// distance, compass points, eye-height slider, OSM peak cells, the URL hash, the OSM overlay's
// tile block and the panorama's peak-tag layout. No DOM and no page state: index.html passes
// its constants (Earth radius, world size, canvas size, the zoom transform) in.
(() => {
  "use strict";

  const RAD = Math.PI / 180;
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  // The eye-height slider is logarithmic between these metres (index.html's 0.5 m and 12,000 m).
  const HEIGHT_MIN = 0.5, HEIGHT_MAX = 12000;
  // OSM peaks are grouped in 2x2 degree cells named by their south-west corner
  // (scripts/build_peaks.py).
  const PEAK_CELL_DEGREES = 2;

  // panoFraction comes from panoview.js: a global in the page, a sibling module in Node.
  const panoramaFraction = typeof module === "object" && module && module.exports
    ? require("./panoview.js").panoFraction
    : globalThis.panoFraction;

  // Degrees folded into [-180, 180), so a point across the antimeridian stays next to the
  // observer in one world copy.
  function wrapLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
  }

  // 2026-11-07 bench (Großer Feldberg, 65536-ray reference): 8192 rays leave 3.4 % of mask
  // pixels wrong beyond 50 km (0.46 s at 100 km), 16384 leave 1.7–1.9 % (1.6 s at 200 km),
  // 4096 leave 6.3–6.7 %. One ray per 80 m of the horizon circle, rounded up to a power of two.
  function raysFor(rmax) {
    return Math.max(8192, 2 ** Math.ceil(Math.log2(2 * Math.PI * rmax / 80)));
  }

  // Distance to the flat horizon on a sphere whose radius folds refraction in: R / (1 - k).
  function flatHorizonDistance(h, k, earthRadius) {
    const refractedRadius = earthRadius / (1 - k);
    return refractedRadius * Math.acos(refractedRadius / (refractedRadius + h));
  }

  // Nearest of the sixteen compass points; 22.5 degrees per point, N at 0.
  function compassPoint(degrees) {
    return COMPASS[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
  }

  function heightToSlider(h) {
    return Math.round((Math.log10(Math.max(HEIGHT_MIN, h)) - Math.log10(HEIGHT_MIN))
      / (Math.log10(HEIGHT_MAX) - Math.log10(HEIGHT_MIN)) * 1000);
  }

  // One decimal below 10 m, whole metres below 1000 m, tens above.
  function sliderToHeight(v) {
    const h = Math.pow(10, Math.log10(HEIGHT_MIN) + v / 1000 * (Math.log10(HEIGHT_MAX) - Math.log10(HEIGHT_MIN)));
    return h < 10 ? Math.round(h * 10) / 10 : h < 1000 ? Math.round(h) : Math.round(h / 10) * 10;
  }

  // Cell file name for the 2x2 degree cell whose south-west corner is (south, west).
  function peakCellName(south, west) {
    const latitude = (south >= 0 ? "N" : "S") + String(Math.abs(south)).padStart(2, "0");
    const longitude = (west >= 0 ? "E" : "W") + String(Math.abs(west)).padStart(3, "0");
    return latitude + longitude;
  }

  // Every cell whose 2x2 degree extent overlaps the disc's bounding box. The longitude
  // half-width is the worker's disc rule, so a disc across the antimeridian still names
  // the wrapped cells (the south-west corner is wrapped before building the name).
  function peakCellsTouched(lat, lon, radiusMetres, earthRadius) {
    const delta = radiusMetres / earthRadius, latHalf = delta / RAD;
    const latMin = Math.max(-90, lat - latHalf), latMax = Math.min(90, lat + latHalf);
    const lonHalf = Math.abs(lat) + latHalf >= 90
      ? 180
      : Math.min(180, Math.asin(Math.min(1, Math.sin(delta) / Math.cos(lat * RAD))) / RAD);
    const firstSouth = Math.floor(latMin / PEAK_CELL_DEGREES) * PEAK_CELL_DEGREES;
    const lastSouth = Math.floor(latMax / PEAK_CELL_DEGREES) * PEAK_CELL_DEGREES;
    const firstWest = Math.floor((lon - lonHalf) / PEAK_CELL_DEGREES) * PEAK_CELL_DEGREES;
    const lastWest = Math.floor((lon + lonHalf) / PEAK_CELL_DEGREES) * PEAK_CELL_DEGREES;
    const names = [];
    for (let south = firstSouth; south <= lastSouth; south += PEAK_CELL_DEGREES) {
      for (let west = firstWest; west <= lastWest; west += PEAK_CELL_DEGREES) {
        names.push(peakCellName(south, wrapLon(west)));
      }
    }
    return [...new Set(names)];
  }

  // Parses a URL hash (with or without the leading "#") into the fields the page restores
  // from a link. Returns null when lat, lon or h is missing or invalid; k, rmax and t are
  // own properties only when the hash carries a usable value.
  function parseHashState(hash, maxLat) {
    const params = new URLSearchParams(String(hash).replace(/^#/, ""));
    const lat = parseFloat(params.get("lat")), lon = parseFloat(params.get("lon")), h = parseFloat(params.get("h"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(h) || h <= 0
      || Math.abs(lat) > maxLat) return null;
    const parsed = { lat, lon, h: Math.min(12000, h) };
    const k = parseFloat(params.get("k")), rmax = parseFloat(params.get("rmax")), t = parseFloat(params.get("t"));
    if (Number.isFinite(k)) parsed.k = k;
    if (Number.isFinite(rmax)) parsed.rmax = rmax;
    if (Number.isFinite(t) && t >= 0 && t <= 1000) parsed.t = t;
    parsed.names = params.get("names") === "en" ? "en" : "local";
    const g = parseFloat(params.get("g"));
    // -500 m is below the Dead Sea shore (~-430 m) and 9,000 m above Everest (8,849 m).
    parsed.g = Number.isFinite(g) && g >= -500 && g <= 9000 ? g : null;
    return parsed;
  }

  // The string persistState puts after "#": URLSearchParams order, names only when English
  // is chosen (an old link keeps local names) and g only when the observer stands on a peak.
  function formatHashState(state) {
    const params = new URLSearchParams({ lat: state.lat, lon: state.lon, h: state.h, k: state.k, rmax: state.rmax, t: state.t });
    if (state.names === "en") params.set("names", "en");
    if (state.g !== null) params.set("g", state.g);
    return params.toString();
  }

  // OSM overlay zoom for a map scale of `scale` (world pixels per world pixel): one tile
  // covers tileSide world pixels, so the zoom is log2(scale * worldSize / tileSide).
  function osmZoomFor(scale, worldSize, tileSide, maxZoom) {
    return Math.max(0, Math.min(maxZoom, Math.round(Math.log2(scale * worldSize / tileSide))));
  }

  // Visible tiles in unwrapped world columns (so the overlay crosses the dateline), rows
  // clamped to the Mercator square. transform is a d3 zoom {x, y, k}; width and height are
  // the canvas CSS pixels.
  function osmTileRange(transform, width, height, worldSize, tileSide, maxZoom) {
    const z = osmZoomFor(transform.k, worldSize, tileSide, maxZoom);
    const side = worldSize / 2 ** z;
    const tileRows = 2 ** z;
    const colStart = Math.floor((-transform.x / transform.k) / side);
    const colEnd = Math.ceil(((width - transform.x) / transform.k) / side) - 1;
    const rowStart = Math.max(0, Math.floor((-transform.y / transform.k) / side));
    const rowEnd = Math.min(tileRows - 1, Math.ceil(((height - transform.y) / transform.k) / side) - 1);
    return { z, side, colStart, colEnd, rowStart, rowEnd };
  }

  // Greedy two-row placement, priority skyline peaks first, then higher elevations, then
  // nearer peaks. A tag that overlaps both rows is dropped; tags never overlap each other.
  // Peaks whose azimuth is outside the window get no tag. peaks = [{ az (radians), sky, ele,
  // d, text }], window = { start, span } in degrees, plot = { left, width, pad, gap } in px.
  function placePeakTags(peaks, measureText, window, plot) {
    const placed = [];
    const rowIntervals = [[], []];
    let rows = 0;
    const ordered = peaks.slice().sort((a, b) => {
      if (a.sky !== b.sky) return a.sky ? -1 : 1;
      const ea = a.ele == null ? -Infinity : a.ele, eb = b.ele == null ? -Infinity : b.ele;
      if (ea !== eb) return eb - ea;
      return a.d - b.d;
    });
    for (const peak of ordered) {
      const fraction = panoramaFraction(window, peak.az / RAD);
      if (fraction == null) continue;
      const text = peak.text;
      const tagWidth = measureText(text) + 2 * plot.pad;
      const x = plot.left + fraction * plot.width;
      const tagX0 = Math.max(plot.left, Math.min(x - tagWidth / 2, plot.left + plot.width - tagWidth));
      let row = -1;
      for (let candidate = 0; candidate < 2; candidate++) {
        const fits = rowIntervals[candidate].every(([a, b]) => tagX0 >= b + plot.gap || tagX0 + tagWidth <= a - plot.gap);
        if (fits) { row = candidate; break; }
      }
      if (row < 0) continue;
      rowIntervals[row].push([tagX0, tagX0 + tagWidth]);
      placed.push({ peak, text, tagWidth, x, tagX0, row });
      rows = Math.max(rows, row + 1);
    }
    return { placed, rows };
  }

  globalThis.wrapLon = wrapLon;
  globalThis.raysFor = raysFor;
  globalThis.flatHorizonDistance = flatHorizonDistance;
  globalThis.compassPoint = compassPoint;
  globalThis.heightToSlider = heightToSlider;
  globalThis.sliderToHeight = sliderToHeight;
  globalThis.peakCellName = peakCellName;
  globalThis.peakCellsTouched = peakCellsTouched;
  globalThis.parseHashState = parseHashState;
  globalThis.formatHashState = formatHashState;
  globalThis.osmZoomFor = osmZoomFor;
  globalThis.osmTileRange = osmTileRange;
  globalThis.placePeakTags = placePeakTags;
  if (typeof module === "object" && module && module.exports) {
    module.exports = {
      wrapLon,
      raysFor,
      flatHorizonDistance,
      compassPoint,
      heightToSlider,
      sliderToHeight,
      peakCellName,
      peakCellsTouched,
      parseHashState,
      formatHashState,
      osmZoomFor,
      osmTileRange,
      placePeakTags,
    };
  }
})();
