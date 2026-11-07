// Checks that worker.js loads a finer zoom near the observer: a small summit keeps its
// height, prepare asks for the fine block, and a thin near ridge still forms the skyline.
// Expected values come from the Mercator grid and the great-circle formulas, never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const TILE_SIDE = 256;
// The fine block at z12 covers a disc of this radius around the observer; the same
// number the worker comment derives from the near-field horizon (see worker.js).
const FINE_RADIUS = 5000;
const FINE_ZOOM_STEP = 2;
const MAX_FINE_ZOOM = 15;
const RAY_STEP = 60;

let messageId = 0;

// Same zoom rule as the worker: a pixel is at most 110 m wide at the observer's latitude.
function zoomFor(lat) {
  return Math.min(15, Math.max(0, Math.ceil(Math.log2(156543.03 * Math.cos(lat * RAD) / 110))));
}

function fineZoomFor(coarseZoom) {
  return Math.min(MAX_FINE_ZOOM, coarseZoom + FINE_ZOOM_STEP);
}

function mercatorPixelX(lon, z) {
  return (lon + 180) / 360 * TILE_SIDE * 2 ** z;
}

function mercatorPixelY(lat, z) {
  const mercatorY = Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
  return (1 - mercatorY / Math.PI) / 2 * TILE_SIDE * 2 ** z;
}

function longitudeOfPixel(globalPixelX, z) {
  return globalPixelX / (TILE_SIDE * 2 ** z) * 360 - 180;
}

function latitudeOfPixel(globalPixelY, z) {
  const mercatorY = (1 - 2 * globalPixelY / (TILE_SIDE * 2 ** z)) * Math.PI;
  return (2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2) / RAD;
}

function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", R });
  return worker;
}

function prepare(worker, { lat, lon, rmax }) {
  const id = ++messageId;
  worker.send({ type: "prepare", id, lat, lon, rmax });
  const need = worker.messages.filter((message) => message.type === "need" && message.id === id).pop();
  assert.ok(need, "worker did not reply to prepare with a need message");
  return need;
}

function runView(worker, params) {
  const id = ++messageId;
  worker.send({ type: "view", id, ...params });
  const reply = worker.messages.filter((message) => message.type === "view" && message.id === id).pop();
  assert.ok(reply, "worker did not reply with a view message");
  assert.equal(reply.error, undefined, `view failed: ${reply.error}`);
  return reply;
}

// Tile keys of the disc's block at one zoom, derived here from the Mercator formulas (the
// same rule the worker documents: bounding box of the disc, one pixel of margin).
function discTileKeys(lat, lon, rmax, z) {
  const delta = rmax / R;
  const latMax = Math.min(85.05112878, lat + delta / RAD);
  const latMin = Math.max(-85.05112878, lat - delta / RAD);
  const lonHalf = Math.abs(lat) + delta / RAD >= 90
    ? 180
    : Math.asin(Math.min(1, Math.sin(delta) / Math.cos(lat * RAD))) / RAD;
  const xMin = mercatorPixelX(lon - lonHalf, z) - 1, xMax = mercatorPixelX(lon + lonHalf, z) + 1;
  const yMin = mercatorPixelY(latMax, z) - 1, yMax = mercatorPixelY(latMin, z) + 1;
  const tx0 = Math.floor(xMin / TILE_SIDE), tx1 = Math.floor(xMax / TILE_SIDE);
  const ty0 = Math.max(0, Math.floor(yMin / TILE_SIDE)), ty1 = Math.min(2 ** z - 1, Math.floor(yMax / TILE_SIDE));
  const side = 2 ** z;
  const keys = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) keys.push(`${z}/${((tx % side) + side) % side}/${ty}`);
  }
  return keys;
}

// Destination of a great circle, identical to the worker's ray segment endpoints.
function destinationPoint(lat, lon, bearing, distance) {
  const p1 = lat * RAD, l1 = lon * RAD, delta = distance / R;
  const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1);
  const sinDelta = Math.sin(delta), cosDelta = Math.cos(delta);
  const p2 = Math.asin(sinP1 * cosDelta + cosP1 * sinDelta * Math.cos(bearing));
  const l2 = l1 + Math.atan2(Math.sin(bearing) * sinDelta * cosP1, cosDelta - sinP1 * Math.sin(p2));
  return { lat: p2 / RAD, lon: ((l2 / RAD + 540) % 360) - 180 };
}

test("a 40 m summit between coarse pixel centres keeps its height", () => {
  const coarseZoom = zoomFor(50);
  assert.equal(coarseZoom, 10);
  // The observer sits on a coarse pixel corner: pixel coordinates are integers, so the
  // four surrounding coarse pixel centres are half a coarse pixel away. At z10/50 N that
  // is ~49 m, more than the plateau's 20 m half-width, so no coarse centre sees the summit.
  const observerPixelX = Math.round(mercatorPixelX(8, coarseZoom));
  const observerPixelY = Math.round(mercatorPixelY(50, coarseZoom));
  const observer = {
    lat: latitudeOfPixel(observerPixelY, coarseZoom),
    lon: longitudeOfPixel(observerPixelX, coarseZoom),
    rmax: 10000,
  };
  const coarsePixelMetres = 156543.03 * Math.cos(observer.lat * RAD) / 2 ** coarseZoom;
  const finePixelMetres = coarsePixelMetres / 2 ** FINE_ZOOM_STEP;
  const plateauHalfWidth = 20;
  assert.ok(coarsePixelMetres / 2 > plateauHalfWidth, "a coarse pixel centre falls inside the plateau");
  assert.ok(finePixelMetres / 2 < plateauHalfWidth, "the nearest fine pixel centre is outside the plateau");

  const heightAt = (lat, lon) => {
    const north = (lat - observer.lat) * R * RAD;
    const east = (lon - observer.lon) * R * RAD * Math.cos(observer.lat * RAD);
    return Math.abs(north) <= plateauHalfWidth && Math.abs(east) <= plateauHalfWidth ? 500 : 0;
  };

  const worker = startWorker();
  loadTerrain(worker, observer, heightAt);
  const reply = runView(worker, { ...observer, h: 10, k: 0, rays: 64 });
  assert.ok(
    Math.abs(reply.z0 - 500) <= 1,
    `z0 ${reply.z0} is not within 1 m of 500; the coarse mosaic misses the summit`,
  );
});

test("prepare asks for the coarse block and a fine disc of FINE_RADIUS", () => {
  const request = { lat: 50, lon: 8, rmax: 100000 };
  const worker = startWorker();
  const need = prepare(worker, request);

  assert.equal(need.z, zoomFor(request.lat));
  const coarseKeys = need.keys.filter((key) => key.startsWith(need.z + "/"));
  const fineKeys = need.keys.filter((key) => key.startsWith(fineZoomFor(need.z) + "/"));
  assert.equal(coarseKeys.length + fineKeys.length, need.keys.length, "need.keys has an unexpected zoom");
  assert.equal(need.total, coarseKeys.length + fineKeys.length, "need.total does not count both blocks");
  assert.ok(fineKeys.length > 0, "need.keys has no fine-zoom tiles");

  const expectedFine = discTileKeys(request.lat, request.lon, FINE_RADIUS, fineZoomFor(need.z));
  assert.deepEqual([...fineKeys].sort(), [...expectedFine].sort(),
    "fine keys do not match the disc of FINE_RADIUS around the observer");

  const expectedCoarse = discTileKeys(request.lat, request.lon, request.rmax, need.z);
  assert.deepEqual([...coarseKeys].sort(), [...expectedCoarse].sort());
});

test("a thin 200 m wall 2 km away is the skyline on its bearing", () => {
  const coarseZoom = zoomFor(50);
  const fineZoom = fineZoomFor(coarseZoom);
  const fineWorld = TILE_SIDE * 2 ** fineZoom;
  const finePixelMetres = 156543.03 * Math.cos(50 * RAD) / 2 ** fineZoom;
  const wallHalfThickness = 20;
  const wallHalfLength = 1000;
  const east = Math.PI / 2;
  // The wall stands at the 34th ray sample (2040 m). Slide the observer along longitude
  // until that sample sits on a fine pixel corner (a multiple of 4 fine pixels, i.e. a
  // coarse pixel corner): the nearest coarse pixel centres are then 49 m away, outside
  // the 40 m wall, while the two fine centres 12 m either side are inside it.
  let observerLon = 8;
  const wallDistance = 34 * RAY_STEP;
  for (let pass = 0; pass < 4; pass++) {
    const sample = destinationPoint(50, observerLon, east, wallDistance);
    const samplePixelX = (sample.lon + 180) / 360 * fineWorld;
    const shift = (Math.round(samplePixelX / 4) * 4 - samplePixelX) / fineWorld * 360;
    observerLon += shift;
  }
  const observer = { lat: 50, lon: observerLon, rmax: 10000 };
  const wallCentre = destinationPoint(observer.lat, observer.lon, east, wallDistance);
  const centrePixelX = (wallCentre.lon + 180) / 360 * fineWorld;
  assert.ok(Math.abs(centrePixelX / 4 - Math.round(centrePixelX / 4)) < 1e-6,
    "wall centre is not on a coarse pixel corner");
  assert.ok(finePixelMetres / 2 < wallHalfThickness, "the fine pixel centres do not straddle the wall");

  const heightAt = (lat, lon) => {
    const north = (lat - wallCentre.lat) * R * RAD;
    const eastOfCentre = (lon - wallCentre.lon) * R * RAD * Math.cos(wallCentre.lat * RAD);
    return Math.abs(eastOfCentre) <= wallHalfThickness && Math.abs(north) <= wallHalfLength ? 200 : 0;
  };

  const worker = startWorker();
  loadTerrain(worker, observer, heightAt);
  const reply = runView(worker, { ...observer, h: 10, k: 0, rays: 4096 });

  const eastRay = 1024; // 90 degrees with 4096 rays
  assert.equal(reply.skyZ[eastRay], 200, `east skyline is ${reply.skyZ[eastRay]} m, not the 200 m wall`);
  assert.ok(
    Math.abs(reply.skyDist[eastRay] - wallDistance) <= RAY_STEP,
    `east skyline distance ${reply.skyDist[eastRay]} is not within ${RAY_STEP} m of ${wallDistance}`,
  );
});
