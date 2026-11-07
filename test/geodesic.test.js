// Great-circle checks of the viewshed math in worker.js against made-up terrain.
// Every expected distance, bearing and position is derived here with the spherical
// destination / haversine formulas, never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const RAY_STEP = 60;

// Same zoom rule as the worker: 156543.03 m per pixel at the equator divided by 2^z,
// chosen so that a pixel is at most 110 m wide at the observer's latitude.
function zoomFor(lat) {
  return Math.min(15, Math.max(0, Math.ceil(Math.log2(156543.03 * Math.cos(lat * RAD) / 110))));
}

// The 3000 m wall is the band starting at 50.8983 N and three pixels deep at the view's
// zoom, so a 60 m ray sample always meets the plateau.
const WALL_SOUTH_LAT = 50.8983;
const WALL_HEIGHT = 3000;

const OBSERVER = { lat: 50.1, lon: 8.1 };
const VIEW = { ...OBSERVER, h: 10, k: 0, rmax: 200000, rays: 4096 };
const RAY = 512;
const BEARING = 45;
const MASK_WORLD = 1024;

const VIEW_ZOOM = zoomFor(OBSERVER.lat);
const VIEW_PIXEL_METRES = 156543.03 * Math.cos(OBSERVER.lat * RAD) / 2 ** VIEW_ZOOM;
const VIEW_PIXEL_LATITUDE = VIEW_PIXEL_METRES / (R * RAD);
const WALL_NORTH_LAT = WALL_SOUTH_LAT + 3 * VIEW_PIXEL_LATITUDE;

let messageId = 0;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

function destination(lat, lon, bearingDegrees, distanceMetres) {
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const bearing = bearingDegrees * RAD;
  const delta = distanceMetres / R;
  const sinP1 = Math.sin(p1);
  const cosP1 = Math.cos(p1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const p2 = Math.asin(sinP1 * cosDelta + cosP1 * sinDelta * Math.cos(bearing));
  const l2 = l1 + Math.atan2(
    Math.sin(bearing) * sinDelta * cosP1,
    cosDelta - sinP1 * Math.sin(p2),
  );
  return { lat: p2 / RAD, lon: ((l2 / RAD + 540) % 360) - 180 };
}

// Distance along the given initial bearing at which the great circle crosses
// `targetLat`; the latitude grows monotonically over the range that matters here.
function distanceToLatitude(lat, lon, bearingDegrees, targetLat) {
  let low = 0;
  let high = 500000;
  for (let step = 0; step < 80; step++) {
    const middle = (low + high) / 2;
    if (destination(lat, lon, bearingDegrees, middle).lat < targetLat) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function mercY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
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

function wallTerrain(lat) {
  return lat >= WALL_SOUTH_LAT && lat <= WALL_NORTH_LAT ? WALL_HEIGHT : 0;
}

// For the mask test the wall face rises northward (0.1 m per m over 600 m): along the
// 45 degree ray that is ~0.07 m/m, steeper than the ~0.04 m/m the elevation angle needs to
// keep growing at ~127 km, so the whole ~850 m deep face is visible. A step wall shows only
// its first 60 m sample, narrower than one 267 m mask pixel at rmax 200 km, so whether that
// pixel lights up would depend on rounding.
const RAMP_DEPTH_METRES = 600;
const RAMP_NORTH_LAT = WALL_SOUTH_LAT + RAMP_DEPTH_METRES / (R * RAD);
function rampTerrain(lat) {
  if (lat < WALL_SOUTH_LAT || lat > RAMP_NORTH_LAT) return 0;
  return WALL_HEIGHT + 0.1 * (lat - WALL_SOUTH_LAT) * R * RAD;
}

// Loading tiles runs hillshade for each one, so the terrain is built once at module load.
const worker = loadWorker(process.env.WORKER_SRC);
worker.send({ type: "init", R });
loadTerrain(worker, { lat: OBSERVER.lat, lon: OBSERVER.lon, rmax: VIEW.rmax }, wallTerrain);

const viewReply = runView(worker, VIEW);

const rampWorker = loadWorker(process.env.WORKER_SRC);
rampWorker.send({ type: "init", R });
loadTerrain(rampWorker, { lat: OBSERVER.lat, lon: OBSERVER.lon, rmax: VIEW.rmax }, rampTerrain);
const rampReply = runView(rampWorker, VIEW);

test("a wall at 50.9 N is reached at the great-circle distance", () => {
  const wallDistance = distanceToLatitude(OBSERVER.lat, OBSERVER.lon, BEARING, WALL_SOUTH_LAT);
  // The first full-height pixel centre lies within one pixel north of the southern edge;
  // at a 45 degree bearing the ray covers that northward pixel in pixel / cos(45) metres,
  // and a ray sample may sit up to one 60 m step beyond it.
  const upper = wallDistance + VIEW_PIXEL_METRES / Math.cos(BEARING * RAD) + RAY_STEP;

  const skyDistance = viewReply.skyDist[RAY];
  assert.ok(
    skyDistance >= wallDistance && skyDistance <= upper,
    `skyDist ${skyDistance} is outside [${wallDistance}, ${upper}]`,
  );

  const expected = destination(OBSERVER.lat, OBSERVER.lon, BEARING, skyDistance);
  const error = haversine(expected.lat, expected.lon, viewReply.skyLat[RAY], viewReply.skyLon[RAY]);
  assert.ok(
    error <= 100,
    `sky point ${viewReply.skyLat[RAY]},${viewReply.skyLon[RAY]} is ${error} m from ` +
      `the great-circle point ${expected.lat},${expected.lon}`,
  );
});

test("the mask pixel at the middle of a visible wall face is visible", () => {
  const [x0, y0, x1, y1] = rampReply.bbox;
  const { pw, ph, mask } = rampReply;
  const mx = (lon) => ((lon + 180) / 360) * MASK_WORLD;
  const my = (lat) => ((1 - mercY(lat) / Math.PI) / 2) * MASK_WORLD;

  const middleLat = (WALL_SOUTH_LAT + RAMP_NORTH_LAT) / 2;
  const middle = destination(OBSERVER.lat, OBSERVER.lon, BEARING,
    distanceToLatitude(OBSERVER.lat, OBSERVER.lon, BEARING, middleLat));
  const column = Math.floor((mx(middle.lon) - x0) / (x1 - x0) * pw);
  const row = Math.floor((my(middle.lat) - y0) / (y1 - y0) * ph);
  assert.ok(
    column >= 0 && column < pw && row >= 0 && row < ph,
    `skyline pixel ${column},${row} is outside the ${pw}x${ph} mask`,
  );
  assert.equal(
    mask[row * pw + column],
    255,
    `mask pixel ${column},${row} is ${mask[row * pw + column]}, expected 255`,
  );
});

test("query distance is the great-circle distance", () => {
  const target = { lat: 51.2, lon: 9.6 };
  const reply = runQuery(worker, target);
  const expected = haversine(OBSERVER.lat, OBSERVER.lon, target.lat, target.lon);
  assert.ok(
    Math.abs(reply.D - expected) <= 1,
    `query D ${reply.D} is not within 1 m of ${expected}`,
  );
});
