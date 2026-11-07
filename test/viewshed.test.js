// Analytic checks of the viewshed math in worker.js against made-up terrain.
// Expected values are derived from the formulas (flat sphere, single wall), never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, flatTile } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const REGION = { la0: 48, lo0: 6, nla: 4, nlo: 5 };
const TILE_SIDE = 1201;
const CELLS_PER_DEGREE = 1200;
const RAY_STEP = 60;
const QUERY_STEP = 30;

const WALL_TILE = { lat: 50, lon: 8 };
const WALL_COLUMNS = [720, 721, 722];
const WALL_HEIGHT = 200;

let messageId = 0;

// A worker loaded with the source under test. WORKER_SRC lets the red checks swap in a
// mutated copy; unset, loadWorker falls back to worker.js.
function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", ...REGION, R });
  return worker;
}

function tileIndex(lat, lon) {
  return (lat - REGION.la0) * REGION.nlo + (lon - REGION.lo0);
}

function loadTerrain(worker, tileFor) {
  for (let lat = REGION.la0; lat < REGION.la0 + REGION.nla; lat++) {
    for (let lon = REGION.lo0; lon < REGION.lo0 + REGION.nlo; lon++) {
      worker.send({ type: "tile", idx: tileIndex(lat, lon), data: tileFor(lat, lon) });
    }
  }
}

function wallTile() {
  const data = new Int16Array(TILE_SIDE * TILE_SIDE);
  for (let row = 0; row < TILE_SIDE; row++) {
    for (const column of WALL_COLUMNS) {
      data[row * TILE_SIDE + column] = WALL_HEIGHT;
    }
  }
  return data;
}

function runView(worker, params) {
  worker.send({ type: "view", id: ++messageId, ...params });
  const reply = worker.messages[worker.messages.length - 1];
  assert.equal(reply.type, "view", "worker did not reply with a view message");
  return reply;
}

function runQuery(worker, params) {
  worker.send({ type: "query", qid: ++messageId, ...params });
  const reply = worker.messages[worker.messages.length - 1];
  assert.equal(reply.type, "query", "worker did not reply with a query message");
  return reply;
}

function longitudeEastOf(lat, lon, distanceMetres) {
  return lon + distanceMetres / (R * RAD * Math.cos(lat * RAD));
}

// Loading tiles runs hillshade for each one, so both terrains are built once at module load
// and reused; every test sends its own view before querying.
const flatWorker = startWorker();
loadTerrain(flatWorker, () => flatTile(0));

const wallWorker = startWorker();
loadTerrain(wallWorker, (lat, lon) =>
  lat === WALL_TILE.lat && lon === WALL_TILE.lon ? wallTile() : flatTile(0));

test("flat sphere: farthest visible point sits at sqrt(2*Re*h)", () => {
  for (const h of [10, 100, 1000]) {
    for (const k of [0, 0.13]) {
      const Re = R / (1 - k);
      const expectedHorizon = Math.sqrt(2 * Re * h);
      // Every ray meets the same horizon on flat ground, so few rays keep this fast.
      const reply = runView(flatWorker, { lat: 50, lon: 8, h, k, rmax: 200000, rays: 64 });
      assert.ok(
        Math.abs(reply.far.d - expectedHorizon) <= RAY_STEP,
        `h=${h} k=${k}: far.d ${reply.far.d} is not within ${RAY_STEP} m of ${expectedHorizon}`,
      );
    }
  }
});

test("flat sphere: query hidden depth matches the continuous sightline", () => {
  const observer = { lat: 50.5, lon: 8.5 };
  const h = 10;
  const k = 0;
  const Re = R / (1 - k);
  // Queries only use the observer position and optics; the ray count does not affect them.
  runView(flatWorker, { ...observer, h, k, rmax: 100000, rays: 64 });

  // Inside the horizon the sightline angle still rises with distance, so the target is visible.
  const near = runQuery(flatWorker, {
    lat: observer.lat,
    lon: longitudeEastOf(observer.lat, observer.lon, 5000),
  });
  assert.equal(near.hidden, 0);

  // Beyond the horizon the target sits below the peak of the sightline angle curve.
  // Query samples every 30 m; at a maximum the sampling error is second order:
  // 0.5 * |ang''| * (15 m)^2 * D with ang'' = -2h/d^3 ~ 1.4e-11 rad/m^2 gives ~3e-5 m,
  // far below the 0.05 m tolerance (the 30 m step alone would be first order elsewhere).
  const D = 20000;
  const peak = -Math.sqrt(2 * h / Re);
  const angT = (-D * D / (2 * Re) - h) / D;
  const expectedHidden = D * (peak - angT);
  const far = runQuery(flatWorker, {
    lat: observer.lat,
    lon: longitudeEastOf(observer.lat, observer.lon, D),
  });
  assert.ok(
    Math.abs(far.hidden - expectedHidden) <= 0.05,
    `hidden ${far.hidden} is not within 0.05 m of ${expectedHidden}`,
  );
});

test("wall: a 200 m ridge casts a shadow of known depth", () => {
  const observer = { lat: 50.5, lon: 8.5 };
  const h = 10;
  const k = 0;
  const Re = R / (1 - k);
  const cosLat = Math.cos(observer.lat * RAD);

  const viewReply = runView(wallWorker, { ...observer, h, k, rmax: 100000, rays: 4096 });

  // The wall stands 0.1 degrees east of the observer; three columns span two cell widths.
  const Dw = 0.1 * R * RAD * cosLat;
  const cellWidth = R * RAD * cosLat / CELLS_PER_DEGREE;
  const eastRay = 1024; // 90 degrees

  assert.equal(viewReply.skyZ[eastRay], WALL_HEIGHT);
  assert.ok(
    viewReply.skyDist[eastRay] >= Dw &&
      viewReply.skyDist[eastRay] <= Dw + 2 * cellWidth + RAY_STEP,
    `skyDist ${viewReply.skyDist[eastRay]} is outside [${Dw}, ${Dw + 2 * cellWidth + RAY_STEP}]`,
  );

  const D = 20000;
  const angT = (-D * D / (2 * Re) - h) / D;
  const angleAtDistance = (distance) =>
    (WALL_HEIGHT - distance * distance / (2 * Re) - h) / distance;

  // Query samples every 30 m, so the first sample on the plateau lies between Dw and Dw+30;
  // its angle (and therefore the hidden depth) falls between the values at those distances.
  const hiddenAtWall = D * (angleAtDistance(Dw) - angT);
  const hiddenAtNextSample = D * (angleAtDistance(Dw + QUERY_STEP) - angT);
  const lowerBound = Math.min(hiddenAtWall, hiddenAtNextSample);
  const upperBound = Math.max(hiddenAtWall, hiddenAtNextSample);
  const far = runQuery(wallWorker, {
    lat: observer.lat,
    lon: longitudeEastOf(observer.lat, observer.lon, D),
  });
  assert.ok(
    far.hidden >= lowerBound && far.hidden <= upperBound,
    `hidden ${far.hidden} is outside [${lowerBound}, ${upperBound}]`,
  );

  // In front of the wall nothing blocks the target.
  const near = runQuery(wallWorker, {
    lat: observer.lat,
    lon: longitudeEastOf(observer.lat, observer.lon, 3000),
  });
  assert.equal(near.hidden, 0);
});

test("edge flag is set when rays leave the loaded region", () => {
  // Edge detection is per ray; 64 rays already include the northern one that leaves the region.
  const outside = runView(flatWorker, { lat: 51.9, lon: 8, h: 10, k: 0, rmax: 200000, rays: 64 });
  assert.equal(outside.edge, true);
  const inside = runView(flatWorker, { lat: 50, lon: 8, h: 10, k: 0, rmax: 50000, rays: 64 });
  assert.equal(inside.edge, false);
});

test("refraction widens the view", () => {
  const plain = runView(flatWorker, { lat: 50, lon: 8, h: 100, k: 0, rmax: 100000, rays: 64 });
  const refracted = runView(flatWorker, { lat: 50, lon: 8, h: 100, k: 0.13, rmax: 100000, rays: 64 });
  assert.ok(
    refracted.far.d > plain.far.d,
    `refracted far.d ${refracted.far.d} is not beyond plain far.d ${plain.far.d}`,
  );
});
