// Checks that the worker's `peaks` message names only the OSM peaks a view can see.
// The terrain is flat ground with three cones; every expected value comes from the
// elevation-angle formula and the same great-circle distance the worker uses.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const OBSERVER = { lat: 50, lon: 8, rmax: 100000 };
const EYE_HEIGHT = 10;
const REFRACTION = 0;
const RAYS = 4096;

// The page sends at least 8192 rays, but the worker's visibility window must also hold
// for this coarser count (one ray is 4.6 m wide at 3 km).
const CONES = [
  { name: "Cone A", height: 600, radius: 1500, distance: 3000 },
  // B lies on A's bearing, farther and far lower, so A's shadow hides it.
  { name: "Cone B", height: 100, radius: 400, distance: 6000 },
  // C lies beyond rmax, so it must be dropped before its terrain is even looked at.
  { name: "Cone C", height: 200, radius: 1000, distance: 110000 },
];

// Same zoom rule as the worker and the harness: 156543.03 m per pixel at the equator
// divided by 2^z, at most 110 m wide at the observer's latitude.
function zoomFor(lat) {
  return Math.min(15, Math.max(0, Math.ceil(Math.log2(156543.03 * Math.cos(lat * RAD) / 110))));
}

function worldPixels(z) {
  return 256 * 2 ** z;
}

function pixelX(lon, z) {
  return (lon + 180) / 360 * worldPixels(z);
}

function pixelY(lat, z) {
  const mercatorY = Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
  return (1 - mercatorY / Math.PI) / 2 * worldPixels(z);
}

function longitudeOfPixel(x, z) {
  return x / worldPixels(z) * 360 - 180;
}

function latitudeOfPixel(y, z) {
  const mercatorY = (1 - 2 * y / worldPixels(z)) * Math.PI;
  return (2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2) / RAD;
}

// Snapping a summit to a DEM pixel centre makes the bilinear mosaic sample return the
// stored cone height exactly, so the angle check needs no sampling-error allowance.
const ZOOM = zoomFor(OBSERVER.lat);

function summitAt(lat, lon) {
  return {
    lat: latitudeOfPixel(Math.floor(pixelY(lat, ZOOM)) + 0.5, ZOOM),
    lon: longitudeOfPixel(Math.floor(pixelX(lon, ZOOM)) + 0.5, ZOOM),
  };
}

function longitudeAtDistance(lat, distance) {
  return OBSERVER.lon + distance / (R * RAD * Math.cos(lat * RAD));
}

for (const cone of CONES) {
  const summit = summitAt(OBSERVER.lat, longitudeAtDistance(OBSERVER.lat, cone.distance));
  cone.lat = summit.lat;
  cone.lon = summit.lon;
}

// Local equirectangular distance is accurate to a few centimetres over a cone radius;
// the cones are the only terrain, so that is far below the 1 m DEM quantisation.
function distanceMetres(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD * Math.cos((lat1 + lat2) / 2 * RAD);
  return R * Math.hypot(dLat, dLon);
}

function coneTerrain(lat, lon) {
  let height = 0;
  for (const cone of CONES) {
    const distance = distanceMetres(cone.lat, cone.lon, lat, lon);
    if (distance < cone.radius) height = Math.max(height, Math.round(cone.height * (1 - distance / cone.radius)));
  }
  return height;
}

function greatCircleDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dLon = (lon2 - lon1) * RAD;
  return Math.atan2(
    Math.sin(dLon) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon),
  );
}

let messageId = 0;

function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", R });
  return worker;
}

function lastMessage(worker, type) {
  const messages = worker.messages.filter((message) => message.type === type);
  assert.ok(messages.length > 0, `worker posted no ${type} message`);
  return messages[messages.length - 1];
}

function runView(worker, params) {
  worker.send({ type: "view", id: ++messageId, ...params });
  return lastMessage(worker, "view");
}

function runPeaks(worker, rows) {
  const id = ++messageId;
  worker.send({ type: "peaks", id, rows });
  const reply = lastMessage(worker, "peaks");
  assert.equal(reply.id, id, "peaks reply does not echo the message id");
  return reply;
}

const worker = startWorker();
loadTerrain(worker, OBSERVER, coneTerrain);
runView(worker, { ...OBSERVER, h: EYE_HEIGHT, k: REFRACTION, rays: RAYS });

test("names a visible peak, drops a hidden one and one beyond rmax", () => {
  const rows = CONES.map((cone) => [cone.name, cone.lat, cone.lon, cone.height]);
  const reply = runPeaks(worker, rows);

  assert.equal(reply.list.length, 1, `expected only Cone A, got ${JSON.stringify(reply.list.map((peak) => peak.name))}`);
  const peak = reply.list[0];
  assert.equal(peak.name, "Cone A");
  assert.equal(peak.ele, 600);
  assert.equal(peak.lat, CONES[0].lat);
  assert.equal(peak.lon, CONES[0].lon);

  const distance = greatCircleDistance(OBSERVER.lat, OBSERVER.lon, peak.lat, peak.lon);
  assert.ok(
    Math.abs(peak.d - distance) <= 1e-6,
    `d ${peak.d} is not within 1e-6 m of the haversine distance ${distance}`,
  );
  const bearing = initialBearing(OBSERVER.lat, OBSERVER.lon, peak.lat, peak.lon);
  const expectedAz = ((bearing % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  assert.ok(
    Math.abs(peak.az - expectedAz) <= 1e-12,
    `az ${peak.az} is not within 1e-12 rad of the initial bearing ${expectedAz}`,
  );

  const Re = R / (1 - REFRACTION);
  const expectedAngle = (CONES[0].height - distance * distance / (2 * Re) - EYE_HEIGHT) / distance;
  // The summit is a DEM pixel centre and both sides compute the distance from the same
  // coordinates, so only double-precision rounding separates the angles (about 1e-15 rad).
  assert.ok(
    Math.abs(peak.ang - expectedAngle) <= 1e-9,
    `ang ${peak.ang} is not within 1e-9 rad of ${expectedAngle}`,
  );
  assert.equal(peak.sky, true, "Cone A is the skyline on its bearing but sky is false");
});

test("a peak with ele null still works", () => {
  const cone = CONES[0];
  const reply = runPeaks(worker, [[cone.name, cone.lat, cone.lon, null]]);
  assert.equal(reply.list.length, 1);
  assert.equal(reply.list[0].ele, null);
  assert.ok(isFinite(reply.list[0].ang), "ang is not finite for a peak without ele");
});

test("an empty row list replies an empty list", () => {
  assert.deepEqual(runPeaks(worker, []).list, []);
});
