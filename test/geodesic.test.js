// Great-circle checks of the viewshed math in worker.js against made-up terrain.
// Every expected distance, bearing and position is derived here with the spherical
// destination / haversine formulas, never pasted.
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

const WALL_LAT = 50;
const WALL_ROWS = [120, 121, 122];
const WALL_HEIGHT = 3000;
const WALL_SOUTH_LAT = 51 - 122 / CELLS_PER_DEGREE;

const OBSERVER = { lat: 50.1, lon: 8.1 };
const VIEW = { ...OBSERVER, h: 10, k: 0, rmax: 200000, rays: 4096 };
const RAY = 512;
const BEARING = 45;
const MASK_WORLD = 1024;

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

function tileIndex(lat, lon) {
  return (lat - REGION.la0) * REGION.nlo + (lon - REGION.lo0);
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

// The wall is the 50.9 N .. 50.8983 N band across all five tiles of the 50 N row.
// Loading tiles runs hillshade for each one, so the terrain is built once at module load.
const worker = loadWorker(process.env.WORKER_SRC);
worker.send({ type: "init", ...REGION, R });
for (let lat = REGION.la0; lat < REGION.la0 + REGION.nla; lat++) {
  for (let lon = REGION.lo0; lon < REGION.lo0 + REGION.nlo; lon++) {
    const data = flatTile(0);
    if (lat === WALL_LAT) {
      for (const row of WALL_ROWS) {
        for (let column = 0; column < TILE_SIDE; column++) {
          data[row * TILE_SIDE + column] = WALL_HEIGHT;
        }
      }
    }
    worker.send({ type: "tile", idx: tileIndex(lat, lon), data });
  }
}

const viewReply = runView(worker, VIEW);

test("a wall at 50.9 N is reached at the great-circle distance", () => {
  const wallDistance = distanceToLatitude(OBSERVER.lat, OBSERVER.lon, BEARING, WALL_SOUTH_LAT);
  // The wall spans two 1-degree/1200 cells north of its southern edge, and a ray
  // sample may sit up to one 60 m step beyond the edge.
  const cellHeight = R * RAD / CELLS_PER_DEGREE;
  const upper = wallDistance + 2 * cellHeight + RAY_STEP;

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

test("the mask pixel containing the skyline point is visible", () => {
  const [x0, y0, x1, y1] = viewReply.bbox;
  const { pw, ph, mask } = viewReply;
  const mx = (lon) => ((lon + 180) / 360) * MASK_WORLD;
  const my = (lat) => ((1 - mercY(lat) / Math.PI) / 2) * MASK_WORLD;

  const column = Math.floor((mx(viewReply.skyLon[RAY]) - x0) / (x1 - x0) * pw);
  const row = Math.floor((my(viewReply.skyLat[RAY]) - y0) / (y1 - y0) * ph);
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
