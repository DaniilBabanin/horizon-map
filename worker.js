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
  let area = 0, far = { d: 0 }, edge = false;
  for (let a = 0; a < A; a++) {
    const az = a * dAng;
    const dlat = Math.cos(az) * ds / R / RAD, dlon = Math.sin(az) * ds / (R * cosl) / RAD;
    let maxA = -Infinity, maxI = 0, maxZ = z0, pend = -1, pendA = 0, hidRun = 0, nc = 0;
    for (let i = 1; i < N; i++) {
      const z = elev(lat + dlat * i, lon + dlon * i);
      if (!isFinite(z)) { edge = true; break; }
      const d = i * ds;
      const ang = (z - d * d / (2 * Re) - zo) / d;
      if (ang >= maxA) {
        vis[a * N + i] = 1; maxA = ang; maxI = i; maxZ = z;
        area += d * dAng * ds;
        if (d > far.d) far = { d, az, z, lat: lat + dlat * i, lon: lon + dlon * i };
        pend = i; pendA = ang; hidRun = 0;
      } else {
        if (pend > 0 && ++hidRun === 4) {
          if (nc < CM) { crA[a * CM + nc] = pendA; crD[a * CM + nc] = pend * ds; nc++; }
          pend = -1;
        }
      }
    }
    crN[a] = nc;
    skyAng[a] = maxA; skyDist[a] = maxI * ds; skyZ[a] = maxZ;
    skyLat[a] = lat + dlat * maxI; skyLon[a] = lon + dlon * maxI;
  }
  // viewshed raster in unit Mercator (world = 1024 wide)
  const W = 1024, mx = (L) => (L + 180) / 360 * W, my = (P) => (1 - mercY(P) / Math.PI) / 2 * W;
  const dLat = rmax / R / RAD, dLon = rmax / (R * cosl) / RAD;
  const x0 = mx(lon - dLon), x1 = mx(lon + dLon), y0 = my(lat + dLat), y1 = my(lat - dLat);
  const big = 1500, sc = big / Math.max(x1 - x0, y1 - y0);
  const pw = Math.max(1, Math.round((x1 - x0) * sc)), ph = Math.max(1, Math.round((y1 - y0) * sc));
  const mask = new Uint8ClampedArray(pw * ph);
  const rN = (N - 1) * ds;
  for (let j = 0; j < ph; j++) {
    const yy = y0 + (j + 0.5) / ph * (y1 - y0);
    const plat = (2 * Math.atan(Math.exp((1 - 2 * yy / W) * Math.PI)) - Math.PI / 2) / RAD;
    const dy = (plat - lat) * RAD * R;
    for (let i = 0; i < pw; i++) {
      const plon = (x0 + (i + 0.5) / pw * (x1 - x0)) / W * 360 - 180;
      const dx = (plon - lon) * RAD * R * cosl;
      const d = Math.hypot(dx, dy);
      if (d > rN) continue;
      const step = Math.round(d / ds);
      if (step < 1) { mask[j * pw + i] = 255; continue; }
      let a = Math.round(Math.atan2(dx, dy) / dAng); a = ((a % A) + A) % A;
      if (vis[a * N + step]) mask[j * pw + i] = 255;
    }
  }
  last = { lat, lon, zo, Re, cosl };
  postMessage({ type: "view", id, A, rmax, z0, zo, area, far, edge, bbox: [x0, y0, x1, y1], pw, ph, mask,
    skyAng, skyDist, skyLat, skyLon, skyZ, crA, crD, crN, CM },
    [mask.buffer, skyAng.buffer, skyDist.buffer, skyLat.buffer, skyLon.buffer, skyZ.buffer, crA.buffer, crD.buffer, crN.buffer]);
}

function query(m) {
  if (!last) return;
  const { lat, lon, zo, Re, cosl } = last;
  const dy = (m.lat - lat) * RAD * R, dx = (m.lon - lon) * RAD * R * cosl;
  const D = Math.hypot(dx, dy);
  const zt = elev(m.lat, m.lon);
  if (!isFinite(zt)) { postMessage({ type: "query", qid: m.qid, D, z: NaN }); return; }
  const ds = 30, n = Math.floor(D / ds);
  let maxA = -Infinity;
  for (let i = 1; i <= n; i++) {
    const f = i * ds / D;
    const z = elev(lat + (m.lat - lat) * f, lon + (m.lon - lon) * f);
    if (!isFinite(z)) break;
    const d = i * ds;
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
