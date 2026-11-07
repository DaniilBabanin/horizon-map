// Analytic checks of the viewshed math in worker.js against made-up terrain.
// Expected values are derived from the formulas (flat sphere, single wall), never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const RAY_STEP = 60;
const QUERY_STEP = 30;

// Same zoom rule as the worker: 156543.03 m per pixel at the equator divided by 2^z,
// chosen so that a pixel is at most 110 m wide at the observer's latitude.
function zoomFor(lat) {
  return Math.min(15, Math.max(0, Math.ceil(Math.log2(156543.03 * Math.cos(lat * RAD) / 110))));
}

function mercatorPixelY(lat, z) {
  const mercatorY = Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
  return (1 - mercatorY / Math.PI) / 2 * 256 * 2 ** z;
}

const FLAT_OBSERVER = { lat: 50, lon: 8, rmax: 200000 };
const WALL_OBSERVER = { lat: 50.5, lon: 8.5, rmax: 100000 };
const WALL_LON = 8.6;
const WALL_HEIGHT = 200;
// The wall band is three pixels wide at the view's zoom, so a 60 m ray sample always
// lands on the plateau; its first pixel centre lies somewhere in the first pixel east
// of WALL_LON, which the query tolerance below accounts for.
const WALL_ZOOM = zoomFor(WALL_OBSERVER.lat);
const WALL_PIXEL_METRES = 156543.03 * Math.cos(WALL_OBSERVER.lat * RAD) / 2 ** WALL_ZOOM;
const WALL_WIDTH_DEGREES = 3 * WALL_PIXEL_METRES / (R * RAD * Math.cos(WALL_OBSERVER.lat * RAD));

let messageId = 0;

// A worker loaded with the source under test. WORKER_SRC lets the red checks swap in a
// mutated copy; unset, loadWorker falls back to worker.js.
function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", R });
  return worker;
}

function wallTerrain(lat, lon) {
  return lon >= WALL_LON && lon <= WALL_LON + WALL_WIDTH_DEGREES ? WALL_HEIGHT : 0;
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
loadTerrain(flatWorker, FLAT_OBSERVER);

const wallWorker = startWorker();
loadTerrain(wallWorker, WALL_OBSERVER, wallTerrain);

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

  // The wall starts 0.1 degrees east of the observer; its three pixels span three pixel widths.
  const Dw = 0.1 * R * RAD * cosLat;
  const eastRay = 1024; // 90 degrees

  assert.equal(viewReply.skyZ[eastRay], WALL_HEIGHT);
  assert.ok(
    viewReply.skyDist[eastRay] >= Dw &&
      viewReply.skyDist[eastRay] <= Dw + 3 * WALL_PIXEL_METRES + RAY_STEP,
    `skyDist ${viewReply.skyDist[eastRay]} is outside ` +
      `[${Dw}, ${Dw + 3 * WALL_PIXEL_METRES + RAY_STEP}]`,
  );

  const D = 20000;
  const angT = (-D * D / (2 * Re) - h) / D;
  const angleAtDistance = (distance) =>
    (WALL_HEIGHT - distance * distance / (2 * Re) - h) / distance;

  // The first pixel centre with full height lies between Dw and Dw + one pixel, and the
  // first 30 m query sample on it follows within another step. Because the sightline angle
  // falls with distance, the hidden depth lies between the values at those two bounds.
  const hiddenAtFirstPlateau = D * (angleAtDistance(Dw + WALL_PIXEL_METRES + QUERY_STEP) - angT);
  const hiddenAtWall = D * (angleAtDistance(Dw) - angT);
  const lowerBound = Math.min(hiddenAtFirstPlateau, hiddenAtWall);
  const upperBound = Math.max(hiddenAtFirstPlateau, hiddenAtWall);
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

test("edge flag is set when rays leave the loaded tiles", () => {
  // Withhold every tile north of the observer's tile: the northern rays leave the loaded
  // block even though the observer himself stands on loaded ground.
  const direction = { lat: 50, lon: 8, rmax: 100000 };
  const z = zoomFor(direction.lat);
  const observerTileY = Math.floor(mercatorPixelY(direction.lat, z) / 256);
  const edgeWorker = startWorker();
  loadTerrain(edgeWorker, direction, undefined, (key) => Number(key.split("/")[2]) < observerTileY);

  const outside = runView(edgeWorker, { lat: 50, lon: 8, h: 10, k: 0, rmax: 100000, rays: 64 });
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
