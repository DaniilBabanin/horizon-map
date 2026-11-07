const S = 1200, SZ = 1201;
const RAD = Math.PI / 180;
let LA0, LO0, NLA, NLO, R;
let tiles = null;
let last = null;

function elev(lat, lon) {
  const la = Math.floor(lat), lo = Math.floor(lon);
  if (la < LA0 || la >= LA0 + NLA || lo < LO0 || lo >= LO0 + NLO) return NaN;
  const t = tiles[(la - LA0) * NLO + (lo - LO0)];
  if (!t) return NaN;
  const y = (la + 1 - lat) * S, x = (lon - lo) * S;
  let r = y | 0, c = x | 0; if (r >= S) r = S - 1; if (c >= S) c = S - 1;
  const fy = y - r, fx = x - c, i = r * SZ + c;
  const a = t[i], b = t[i + 1], cc = t[i + SZ], d = t[i + SZ + 1];
  return (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
}

function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2)); }

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

function shade(idx) {
  const t = tiles[idx];
  const la = LA0 + Math.floor(idx / NLO), lo = LO0 + idx % NLO;
  const W = 480, y1 = mercY(la + 1), y0 = mercY(la);
  const H = Math.round(W * (y1 - y0) / RAD);
  const out = new Uint8ClampedArray(W * H * 4);
  const step = S / W;
  const zen = 45 * RAD, azi = 315 * RAD, zf = 1.6;
  const cz = Math.cos(zen), sz = Math.sin(zen);
  const cy = 92.66;
  for (let j = 0; j < H; j++) {
    const lat = (2 * Math.atan(Math.exp(y1 - (j + 0.5) / H * (y1 - y0))) - Math.PI / 2) / RAD;
    const r = Math.min(S - 1, Math.max(1, Math.round((la + 1 - lat) * S)));
    const cx = cy * Math.cos(lat * RAD);
    const s = Math.max(1, Math.round(step));
    for (let i = 0; i < W; i++) {
      const c = Math.min(S - 1, Math.max(1, Math.round((i + 0.5) * step)));
      const r0 = Math.max(0, r - s), r1 = Math.min(S, r + s), c0 = Math.max(0, c - s), c1 = Math.min(S, c + s);
      const dzdx = (t[r * SZ + c1] - t[r * SZ + c0]) / ((c1 - c0) * cx) * zf;
      const dzdy = (t[r0 * SZ + c] - t[r1 * SZ + c]) / ((r1 - r0) * cy) * zf;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const hs = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(azi - (Math.PI / 2 - aspect));
      const v = hs - cz;
      const o = (j * W + i) * 4;
      if (v < 0) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = Math.min(200, -v * 340); }
      else { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = Math.min(150, v * 260); }
    }
  }
  postMessage({ type: "shade", idx, la, lo, W, H, data: out }, [out.buffer]);
}

function view(m) {
  const { lat, lon, h, k, rmax, id } = m;
  const z0 = elev(lat, lon);
  if (!isFinite(z0)) { postMessage({ type: "view", id, error: "outside" }); return; }
  const A = m.rays || 4096, ds = 60, N = Math.floor(rmax / ds) + 1;
  const zo = z0 + h, Re = R / (1 - k), cosl = Math.cos(lat * RAD);
  const dAng = 2 * Math.PI / A;
  const vis = new Uint8Array(A * N);
  const skyAng = new Float32Array(A), skyDist = new Float32Array(A), skyLat = new Float64Array(A), skyLon = new Float64Array(A), skyZ = new Float32Array(A);
  const CM = 24;
  const crA = new Float32Array(A * CM), crD = new Float32Array(A * CM), crN = new Uint8Array(A);
  let area = 0, far = { d: 0, az: 0, z: 0 }, edge = false;
  // Great-circle points every K samples (32 * 60 m = 1920 m), with lat/lon interpolated
  // linearly between them; the position error over a block stays below 1 m.
  const K = 32;
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
    let segLat0 = lat, segLon0 = lon;
    ray: for (let seg = 0; seg < segCount; seg++) {
      const p2 = Math.asin(sinLat0 * segCos[seg] + cosLat0 * segSin[seg] * cosAz);
      const segLat1 = p2 / RAD;
      const segLon1 = lon + Math.atan2(sinAz * segSin[seg] * cosLat0, segCos[seg] - sinLat0 * Math.sin(p2)) / RAD;
      const segEndI = segEnd[seg], segSteps = segEndI - seg * K;
      const dLatStep = (segLat1 - segLat0) / segSteps, dLonStep = (segLon1 - segLon0) / segSteps;
      let plat = segLat0, plon = segLon0;
      for (let i = seg * K + 1; i <= segEndI; i++) {
        plat += dLatStep; plon += dLonStep;
        const z = elev(plat, plon);
        if (!isFinite(z)) { edge = true; break ray; }
        const d = i * ds;
        const ang = (z - d * d / (2 * Re) - zo) / d;
        if (ang >= maxA) {
          vis[a * N + i] = 1; maxA = ang; maxI = i; maxZ = z;
          area += d * dAng * ds;
          if (d > far.d) far = { d, az, z };
          pend = i; pendA = ang; hidRun = 0;
        } else {
          if (pend > 0 && ++hidRun === 4) {
            if (nc < CM) { crA[a * CM + nc] = pendA; crD[a * CM + nc] = pend * ds; nc++; }
            pend = -1;
          }
        }
      }
      segLat0 = segLat1; segLon0 = segLon1;
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
  last = { lat, lon, zo, Re };
  postMessage({ type: "view", id, A, rmax, z0, zo, area, far, edge, bbox: [x0, y0, x1, y1], pw, ph, mask,
    skyAng, skyDist, skyLat, skyLon, skyZ, crA, crD, crN, CM },
    [mask.buffer, skyAng.buffer, skyDist.buffer, skyLat.buffer, skyLon.buffer, skyZ.buffer, crA.buffer, crD.buffer, crN.buffer]);
}

function query(m) {
  if (!last) return;
  const { lat, lon, zo, Re } = last;
  const D = greatCircleDistance(lat, lon, m.lat, m.lon);
  const zt = elev(m.lat, m.lon);
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
    const z = elev(sampleLat / RAD, sampleLon / RAD);
    if (!isFinite(z)) break;
    const ang = (z - d * d / (2 * Re) - zo) / d;
    if (ang > maxA) maxA = ang;
  }
  const angT = D > 0 ? (zt - D * D / (2 * Re) - zo) / D : Infinity;
  const hidden = angT >= maxA ? 0 : (maxA - angT) * D;
  postMessage({ type: "query", qid: m.qid, D, z: zt, hidden });
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") { LA0 = m.la0; LO0 = m.lo0; NLA = m.nla; NLO = m.nlo; R = m.R; tiles = new Array(NLA * NLO).fill(null); last = null; }
  else if (m.type === "tile") { tiles[m.idx] = m.data; shade(m.idx); }
  else if (m.type === "view") view(m);
  else if (m.type === "query") query(m);
};
