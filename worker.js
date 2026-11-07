// Elevation tiles are AWS Terrarium PNGs: 256 x 256 Web Mercator pixels, height in
// metres = R*256 + G + B/256 - 32768. The page fetches them, converts to Int16 metres and
// posts them here; -32768 means "no data".
const TILE_SIDE = 256, TILE_PIXELS = TILE_SIDE * TILE_SIDE;
const RAD = Math.PI / 180;
const NO_DATA = -32768;
const MAX_MERCATOR_LAT = 85.05112878;
// Selects the zoom at which a Mercator pixel is at most 110 m wide at the observer's
// latitude: 156543.03 * cos(lat) / 2^z <= 110.
const MAX_PIXEL_METRES = 110;

let R;
let tiles = new Map();
let lastPrepare = null;
let last = null;

function zoomFor(lat) {
  const metresPerPixel = 156543.03 * Math.cos(lat * RAD);
  return Math.min(15, Math.max(0, Math.ceil(Math.log2(metresPerPixel / MAX_PIXEL_METRES))));
}

function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2)); }

function worldPixels(z) { return TILE_SIDE * 2 ** z; }

function pixelX(lon, z) { return (lon + 180) / 360 * worldPixels(z); }

function pixelY(lat, z) { return (1 - mercY(lat) / Math.PI) / 2 * worldPixels(z); }

function wrapTileX(x, z) {
  const side = 2 ** z;
  return ((x % side) + side) % side;
}

function tileKey(z, x, y) { return z + "/" + wrapTileX(x, z) + "/" + y; }

// Tile block of the disc of radius rmax around (lat, lon), plus one pixel of margin so
// bilinear corners stay inside the block. Longitudes are kept unwrapped: the continuous
// range around `lon` may run past +180 or below -180.
function discTiles(lat, lon, rmax, z) {
  const delta = rmax / R;
  const latMax = Math.min(MAX_MERCATOR_LAT, lat + delta / RAD);
  const latMin = Math.max(-MAX_MERCATOR_LAT, lat - delta / RAD);
  const lonHalf = Math.abs(lat) + delta / RAD >= 90
    ? 180
    : Math.asin(Math.min(1, Math.sin(delta) / Math.cos(lat * RAD))) / RAD;
  const xMin = pixelX(lon - lonHalf, z) - 1, xMax = pixelX(lon + lonHalf, z) + 1;
  const yMin = pixelY(latMax, z) - 1, yMax = pixelY(latMin, z) + 1;
  const tx0 = Math.floor(xMin / TILE_SIDE), tx1 = Math.floor(xMax / TILE_SIDE);
  const ty0 = Math.max(0, Math.floor(yMin / TILE_SIDE));
  const ty1 = Math.min(2 ** z - 1, Math.floor(yMax / TILE_SIDE));
  return {
    tx0, tx1, ty0, ty1,
    px0: tx0 * TILE_SIDE, py0: ty0 * TILE_SIDE,
    nx: tx1 - tx0 + 1, ny: ty1 - ty0 + 1,
  };
}

// One Int16 mosaic covering the disc's tile block, with unwrapped x. Missing tiles keep
// NO_DATA at every pixel, so sampling near them fails instead of reading stale values.
function buildMosaic(lat, lon, rmax, z) {
  const block = discTiles(lat, lon, rmax, z);
  const width = block.nx * TILE_SIDE, height = block.ny * TILE_SIDE;
  const data = new Int16Array(width * height).fill(NO_DATA);
  for (let row = 0; row < block.ny; row++) {
    const ty = block.ty0 + row;
    for (let column = 0; column < block.nx; column++) {
      const tile = tiles.get(tileKey(z, block.tx0 + column, ty));
      if (!tile) continue;
      for (let line = 0; line < TILE_SIDE; line++) {
        data.set(
          tile.subarray(line * TILE_SIDE, (line + 1) * TILE_SIDE),
          (row * TILE_SIDE + line) * width + column * TILE_SIDE,
        );
      }
    }
  }
  return { z, lat, lon, px0: block.px0, py0: block.py0, width, height, data };
}

// Global pixel coordinates of a geographic point, with longitude unwrapped to the mosaic's
// centre so a point east of the dateline has a larger x than the observer.
function mosaicPosition(mosaic, lat, lon) {
  let dLon = lon - mosaic.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  return {
    px: pixelX(mosaic.lon, mosaic.z) + dLon / 360 * worldPixels(mosaic.z),
    py: pixelY(lat, mosaic.z),
  };
}

// Bilinear sample; NaN when the point is outside the mosaic or any corner has no data.
function sampleMosaic(mosaic, px, py) {
  const u = px - mosaic.px0 - 0.5, v = py - mosaic.py0 - 0.5;
  const column = Math.floor(u), row = Math.floor(v);
  if (column < 0 || row < 0 || column >= mosaic.width - 1 || row >= mosaic.height - 1) return NaN;
  const fx = u - column, fy = v - row;
  const i = row * mosaic.width + column;
  const a = mosaic.data[i], b = mosaic.data[i + 1];
  const c = mosaic.data[i + mosaic.width], d = mosaic.data[i + mosaic.width + 1];
  if (a === NO_DATA || b === NO_DATA || c === NO_DATA || d === NO_DATA) return NaN;
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function shadeTile(key, z, x, y, data) {
  const out = new Uint8ClampedArray(TILE_PIXELS * 4);
  const zen = 45 * RAD, azi = 315 * RAD, zf = 1.6;
  const cz = Math.cos(zen), sz = Math.sin(zen);
  const scale = worldPixels(z);
  for (let row = 0; row < TILE_SIDE; row++) {
    const globalY = y * TILE_SIDE + row + 0.5;
    const lat = (2 * Math.atan(Math.exp((1 - 2 * globalY / scale) * Math.PI)) - Math.PI / 2) / RAD;
    // Terrarium pixels are square in Mercator, so one pixel spans this many metres both
    // east-west and north-south.
    const spacing = 156543.03 * Math.cos(lat * RAD) / 2 ** z;
    for (let column = 0; column < TILE_SIDE; column++) {
      const rowNorth = row > 0 ? row - 1 : 0, rowSouth = row < TILE_SIDE - 1 ? row + 1 : TILE_SIDE - 1;
      const columnWest = column > 0 ? column - 1 : 0, columnEast = column < TILE_SIDE - 1 ? column + 1 : TILE_SIDE - 1;
      const dzdx = (data[row * TILE_SIDE + columnEast] - data[row * TILE_SIDE + columnWest])
        / ((columnEast - columnWest) * spacing) * zf;
      const dzdy = (data[rowNorth * TILE_SIDE + column] - data[rowSouth * TILE_SIDE + column])
        / ((rowSouth - rowNorth) * spacing) * zf;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const hs = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(azi - (Math.PI / 2 - aspect));
      const v = hs - cz;
      const offset = (row * TILE_SIDE + column) * 4;
      if (v < 0) {
        out[offset] = out[offset + 1] = out[offset + 2] = 0;
        out[offset + 3] = Math.min(200, -v * 340);
      } else {
        out[offset] = out[offset + 1] = out[offset + 2] = 255;
        out[offset + 3] = Math.min(150, v * 260);
      }
    }
  }
  postMessage({ type: "shade", key, z, x, y, data: out }, [out.buffer]);
}

// Point reached from (lat, lon) after `distance` metres along the great circle whose
// initial bearing is `bearing` radians (clockwise from north).
function destinationPoint(lat, lon, bearing, distance) {
  const p1 = lat * RAD, l1 = lon * RAD, delta = distance / R;
  const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1);
  const sinDelta = Math.sin(delta), cosDelta = Math.cos(delta);
  const p2 = Math.asin(sinP1 * cosDelta + cosP1 * sinDelta * Math.cos(bearing));
  const l2 = l1 + Math.atan2(Math.sin(bearing) * sinDelta * cosP1, cosDelta - sinP1 * Math.sin(p2));
  return { lat: p2 / RAD, lon: ((l2 / RAD + 540) % 360) - 180 };
}

function greatCircleDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

function prepare(m) {
  const z = zoomFor(m.lat);
  const block = discTiles(m.lat, m.lon, m.rmax, z);
  const keys = [];
  for (let ty = block.ty0; ty <= block.ty1; ty++) {
    for (let tx = block.tx0; tx <= block.tx1; tx++) {
      const key = tileKey(z, tx, ty);
      if (!tiles.has(key)) keys.push(key);
    }
  }
  lastPrepare = { z, lat: m.lat, lon: m.lon, rmax: m.rmax };
  postMessage({ type: "need", id: m.id, z, keys, total: block.nx * block.ny });
}

function view(m) {
  const { lat, lon, h, k, rmax, id } = m;
  // Target height above the ground. A target top is visible when its angle clears the
  // terrain horizon by t / d; the terrain horizon itself stays terrain-only.
  const t = m.t || 0;
  if (!lastPrepare) { last = null; postMessage({ type: "view", id, error: "outside" }); return; }
  const mosaic = buildMosaic(lat, lon, rmax, lastPrepare.z);
  const z0 = sampleMosaic(mosaic, pixelX(lon, mosaic.z), pixelY(lat, mosaic.z));
  if (!isFinite(z0)) { last = null; postMessage({ type: "view", id, error: "outside" }); return; }
  const A = m.rays || 4096, ds = 60, N = Math.floor(rmax / ds) + 1;
  const zo = z0 + h, Re = R / (1 - k), cosl = Math.cos(lat * RAD);
  const dAng = 2 * Math.PI / A;
  const vis = new Uint8Array(A * N);
  const skyAng = new Float32Array(A), skyDist = new Float32Array(A), skyLat = new Float64Array(A), skyLon = new Float64Array(A), skyZ = new Float32Array(A);
  const CM = 24;
  const crA = new Float32Array(A * CM), crD = new Float32Array(A * CM), crN = new Uint8Array(A);
  let area = 0, far = { d: 0, az: 0, z: 0 }, edge = false;
  // Great-circle points every K samples (32 * 60 m = 1920 m). Only those points are
  // converted to Mercator pixels; x/y are interpolated linearly inside a block, so the
  // hot loop never calls log/tan. The added position error stays below 1 m at 200 km
  // (measured for lat 0 and lat 70).
  const K = 32;
  const worldWidth = worldPixels(mosaic.z);
  const observerPx = pixelX(lon, mosaic.z), observerPy = pixelY(lat, mosaic.z);
  const sinLat0 = Math.sin(lat * RAD), cosLat0 = Math.cos(lat * RAD);
  const segCount = N > 1 ? Math.ceil((N - 1) / K) : 0;
  const segEnd = new Int32Array(segCount), segSin = new Float64Array(segCount), segCos = new Float64Array(segCount);
  for (let s = 0; s < segCount; s++) {
    const end = Math.min((s + 1) * K, N - 1), delta = end * ds / R;
    segEnd[s] = end; segSin[s] = Math.sin(delta); segCos[s] = Math.cos(delta);
  }
  for (let a = 0; a < A; a++) {
    const az = a * dAng, sinAz = Math.sin(az), cosAz = Math.cos(az);
    let maxA = -Infinity, maxI = 0, maxZ = z0, pend = -1, pendA = 0, hidRun = 0, nc = 0;
    let segPx0 = observerPx, segPy0 = observerPy;
    ray: for (let seg = 0; seg < segCount; seg++) {
      const p2 = Math.asin(sinLat0 * segCos[seg] + cosLat0 * segSin[seg] * cosAz);
      const segLat1 = p2 / RAD;
      const segLon1 = lon + Math.atan2(sinAz * segSin[seg] * cosLat0, segCos[seg] - sinLat0 * Math.sin(p2)) / RAD;
      let dLon = segLon1 - lon;
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      const segPx1 = observerPx + dLon / 360 * worldWidth;
      const segPy1 = pixelY(segLat1, mosaic.z);
      const segEndI = segEnd[seg], segSteps = segEndI - seg * K;
      const dPx = (segPx1 - segPx0) / segSteps, dPy = (segPy1 - segPy0) / segSteps;
      let px = segPx0, py = segPy0;
      for (let i = seg * K + 1; i <= segEndI; i++) {
        px += dPx; py += dPy;
        const z = sampleMosaic(mosaic, px, py);
        if (!isFinite(z)) { edge = true; break ray; }
        const d = i * ds;
        const ang = (z - d * d / (2 * Re) - zo) / d;
        if (ang + t / d >= maxA) {
          vis[a * N + i] = 1;
          area += d * dAng * ds;
          if (d > far.d) far = { d, az, z };
        }
        if (ang >= maxA) {
          maxA = ang; maxI = i; maxZ = z;
          pend = i; pendA = ang; hidRun = 0;
        } else {
          if (pend > 0 && ++hidRun === 4) {
            if (nc < CM) { crA[a * CM + nc] = pendA; crD[a * CM + nc] = pend * ds; nc++; }
            pend = -1;
          }
        }
      }
      segPx0 = segPx1; segPy0 = segPy1;
    }
    crN[a] = nc;
    const sky = destinationPoint(lat, lon, az, maxI * ds);
    skyAng[a] = maxA; skyDist[a] = maxI * ds; skyZ[a] = maxZ;
    skyLat[a] = sky.lat; skyLon[a] = sky.lon;
  }
  if (far.d > 0) {
    const point = destinationPoint(lat, lon, far.az, far.d);
    far.lat = point.lat; far.lon = point.lon;
  }
  // viewshed raster in unit Mercator (world = 1024 wide)
  const W = 1024, mx = (L) => (L + 180) / 360 * W, my = (P) => (1 - mercY(P) / Math.PI) / 2 * W;
  const dLat = rmax / R / RAD, dLon = rmax / (R * cosl) / RAD;
  const x0 = mx(lon - dLon), x1 = mx(lon + dLon), y0 = my(lat + dLat), y1 = my(lat - dLat);
  const big = 1500, sc = big / Math.max(x1 - x0, y1 - y0);
  const pw = Math.max(1, Math.round((x1 - x0) * sc)), ph = Math.max(1, Math.round((y1 - y0) * sc));
  const mask = new Uint8ClampedArray(pw * ph);
  const rN = (N - 1) * ds;
  const sinLat = Math.sin(lat * RAD), cosLat = Math.cos(lat * RAD);
  // Columns advance by a constant longitude step, so sin/cos of the offset are updated
  // with the angle-addition formula instead of a Math.cos per pixel.
  const dLonStep = (x1 - x0) / pw / W * 360 * RAD;
  const sinDLonStep = Math.sin(dLonStep), cosDLonStep = Math.cos(dLonStep);
  for (let j = 0; j < ph; j++) {
    const yy = y0 + (j + 0.5) / ph * (y1 - y0);
    const plat = (2 * Math.atan(Math.exp((1 - 2 * yy / W) * Math.PI)) - Math.PI / 2) / RAD;
    const sinPlat = Math.sin(plat * RAD), cosPlat = Math.cos(plat * RAD);
    const sinHalfDLat = Math.sin((plat - lat) * RAD / 2);
    const firstDLon = ((x0 + 0.5 / pw * (x1 - x0)) / W * 360 - 180 - lon) * RAD;
    let cosDLon = Math.cos(firstDLon), sinDLon = Math.sin(firstDLon);
    for (let i = 0; i < pw; i++) {
      const columnCos = cosDLon, columnSin = sinDLon;
      const hav = sinHalfDLat * sinHalfDLat + cosLat * cosPlat * (1 - columnCos) / 2;
      // asin(x) = x + x^3/6 for the small angles inside the mask; the dropped term is
      // below 1 mm at 200 km.
      const x = Math.sqrt(hav);
      const d = 2 * R * x * (1 + x * x / 6);
      cosDLon = columnCos * cosDLonStep - columnSin * sinDLonStep;
      sinDLon = columnSin * cosDLonStep + columnCos * sinDLonStep;
      if (d > rN) continue;
      const step = Math.round(d / ds);
      if (step < 1) { mask[j * pw + i] = 255; continue; }
      const bearing = Math.atan2(columnSin * cosPlat, cosLat * sinPlat - sinLat * cosPlat * columnCos);
      let a = Math.round(bearing / dAng); a = ((a % A) + A) % A;
      if (vis[a * N + step]) mask[j * pw + i] = 255;
    }
  }
  last = { lat, lon, zo, Re, t, mosaic };
  postMessage({ type: "view", id, A, rmax, z0, zo, area, far, edge, bbox: [x0, y0, x1, y1], pw, ph, mask,
    skyAng, skyDist, skyLat, skyLon, skyZ, crA, crD, crN, CM },
    [mask.buffer, skyAng.buffer, skyDist.buffer, skyLat.buffer, skyLon.buffer, skyZ.buffer, crA.buffer, crD.buffer, crN.buffer]);
}

function query(m) {
  if (!last) return;
  const { lat, lon, zo, Re, t, mosaic } = last;
  const D = greatCircleDistance(lat, lon, m.lat, m.lon);
  const target = mosaicPosition(mosaic, m.lat, m.lon);
  const zt = sampleMosaic(mosaic, target.px, target.py);
  if (!isFinite(zt)) { postMessage({ type: "query", qid: m.qid, D, z: NaN }); return; }
  const ds = 30, n = Math.floor(D / ds);
  const p1 = lat * RAD, p2 = m.lat * RAD, dLon = (m.lon - lon) * RAD;
  const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1);
  const sinP2 = Math.sin(p2), cosP2 = Math.cos(p2);
  const sinDLon = Math.sin(dLon), cosDLon = Math.cos(dLon);
  const bearing = Math.atan2(sinDLon * cosP2, cosP1 * sinP2 - sinP1 * cosP2 * cosDLon);
  const sinBearing = Math.sin(bearing), cosBearing = Math.cos(bearing);
  let maxA = -Infinity;
  for (let i = 1; i <= n; i++) {
    const d = i * ds, delta = d / R;
    const sinDelta = Math.sin(delta), cosDelta = Math.cos(delta);
    const sampleLat = Math.asin(sinP1 * cosDelta + cosP1 * sinDelta * cosBearing);
    const sampleLon = lon * RAD + Math.atan2(sinBearing * sinDelta * cosP1, cosDelta - sinP1 * Math.sin(sampleLat));
    const sample = mosaicPosition(mosaic, sampleLat / RAD, ((sampleLon / RAD + 540) % 360) - 180);
    const z = sampleMosaic(mosaic, sample.px, sample.py);
    if (!isFinite(z)) break;
    const ang = (z - d * d / (2 * Re) - zo) / d;
    if (ang > maxA) maxA = ang;
  }
  const angT = D > 0 ? (zt - D * D / (2 * Re) - zo) / D : Infinity;
  const hidden = D === 0 || angT + t / D >= maxA ? 0 : (maxA - angT) * D - t;
  postMessage({ type: "query", qid: m.qid, D, z: zt, hidden });
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") { R = m.R; tiles = new Map(); lastPrepare = null; last = null; }
  else if (m.type === "prepare") prepare(m);
  else if (m.type === "tile") { tiles.set(m.key, m.data); const [z, x, y] = m.key.split("/").map(Number); shadeTile(m.key, z, x, y, m.data); }
  else if (m.type === "view") view(m);
  else if (m.type === "query") query(m);
};
