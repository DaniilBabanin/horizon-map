// Checks of the Terrarium tile protocol in worker.js: zoom selection, the disc's tile block,
// interpolation across tile seams and continuity across the dateline.
// Every expected tile coordinate is derived here from the Mercator formulas.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const TILE_SIDE = 256;

let messageId = 0;
let prepareId = 0;

// Same zoom rule as the worker: a pixel is at most 110 m wide at the observer's latitude.
function zoomFor(lat) {
  return Math.min(15, Math.max(0, Math.ceil(Math.log2(156543.03 * Math.cos(lat * RAD) / 110))));
}

function mercatorPixelY(lat, z) {
  const mercatorY = Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
  return (1 - mercatorY / Math.PI) / 2 * TILE_SIDE * 2 ** z;
}

function mercatorPixelX(lon, z) {
  return (lon + 180) / 360 * TILE_SIDE * 2 ** z;
}

function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", R });
  return worker;
}

function prepare(worker, { lat, lon, rmax }) {
  const id = ++prepareId;
  worker.send({ type: "prepare", id, lat, lon, rmax });
  const need = worker.messages.filter((message) => message.type === "need" && message.id === id).pop();
  assert.ok(need, "worker did not reply to prepare with a need message");
  return need;
}

// Tile count of the disc's bounding box, with the one-pixel margin the protocol asks for.
// This mirrors the worker's derivation from the same formulas; the test keeps its own copy
// so a wrong bbox in the worker shows up as a mismatch.
function boundingBoxTileCount({ lat, lon, rmax }, z) {
  const delta = rmax / R;
  const latMax = Math.min(85.05112878, lat + delta / RAD);
  const latMin = Math.max(-85.05112878, lat - delta / RAD);
  const lonHalf = Math.abs(lat) + delta / RAD >= 90
    ? 180
    : Math.asin(Math.min(1, Math.sin(delta) / Math.cos(lat * RAD))) / RAD;
  const scale = TILE_SIDE * 2 ** z;
  const pxMin = mercatorPixelX(lon - lonHalf, z) - 1;
  const pxMax = mercatorPixelX(lon + lonHalf, z) + 1;
  const pyMin = mercatorPixelY(latMax, z) - 1;
  const pyMax = mercatorPixelY(latMin, z) + 1;
  const tileX0 = Math.floor(pxMin / TILE_SIDE);
  const tileX1 = Math.floor(pxMax / TILE_SIDE);
  const tileY0 = Math.max(0, Math.floor(pyMin / TILE_SIDE));
  const tileY1 = Math.min(2 ** z - 1, Math.floor(pyMax / TILE_SIDE));
  return (tileX1 - tileX0 + 1) * (tileY1 - tileY0 + 1);
}

test("prepare at 50 N 8 E asks for the disc's z10 tiles", () => {
  const worker = startWorker();
  const request = { lat: 50, lon: 8, rmax: 100000 };
  const need = prepare(worker, request);

  assert.equal(need.z, 10);
  assert.ok(need.keys.includes("10/534/346"), "need.keys lacks 10/534/346");
  assert.equal(need.total, boundingBoxTileCount(request, need.z));
  // No tiles are held yet, so every tile of the block is requested.
  assert.equal(need.keys.length, need.total);
  for (const key of need.keys) {
    assert.match(key, /^10\/\d+\/\d+$/);
  }
});

test("zoomFor picks a zoom where a pixel is at most 110 m wide", () => {
  const expected = [[0, 11], [50, 10], [70, 9], [80, 8]];
  const worker = startWorker();
  for (const [lat, z] of expected) {
    const need = prepare(worker, { lat, lon: 0, rmax: 1000 });
    assert.equal(need.z, z, `lat ${lat} should use z${z}`);
    const pixelMetres = 156543.03 * Math.cos(lat * RAD) / 2 ** need.z;
    assert.ok(pixelMetres <= 110, `lat ${lat}: z${need.z} pixel is ${pixelMetres} m wide`);
  }
});

test("tile seam: bilinear interpolation crosses tile edges", () => {
  // At z7 the whole Mercator world is 32768 pixels wide, so a height of twice the global
  // pixel x stays inside Int16; the ramp is then exact at every pixel centre.
  const observer = { lat: 85, lon: -5.63, rmax: 10000 };
  const worker = startWorker();
  const need = prepare(worker, observer);
  const z = need.z;
  assert.equal(z, 7);
  const heightAt = (lat, lon) => 2 * mercatorPixelX(lon, z);

  loadTerrain(worker, observer, heightAt);
  worker.send({ type: "view", id: ++messageId, lat: observer.lat, lon: observer.lon, h: 10, k: 0, rmax: 5000, rays: 64 });

  // Pixel 62 * 256 is the seam between tile x 61 and tile x 62.
  const seamPixel = 62 * TILE_SIDE;
  const seamLon = seamPixel / (TILE_SIDE * 2 ** z) * 360 - 180;
  assert.ok(need.keys.includes(`7/61/${Math.floor(mercatorPixelY(observer.lat, z) / TILE_SIDE)}`));
  assert.ok(need.keys.includes(`7/62/${Math.floor(mercatorPixelY(observer.lat, z) / TILE_SIDE)}`));

  worker.send({ type: "query", qid: ++messageId, lat: observer.lat, lon: seamLon });
  const reply = worker.messages[worker.messages.length - 1];
  assert.equal(reply.type, "query");
  assert.ok(
    Math.abs(reply.z - 2 * seamPixel) <= 0.01,
    `seam elevation ${reply.z} is not within 0.01 m of ${2 * seamPixel}`,
  );
});

test("dateline: the disc wraps tile x and stays edge-free", () => {
  const observer = { lat: 0, lon: 179.95, rmax: 50000 };
  const worker = startWorker();
  const { z, keys } = loadTerrain(worker, observer);
  assert.equal(z, 11);
  const wrappedX = (x) => `${z}/${x}/`;
  assert.ok(keys.some((key) => key.startsWith(wrappedX(0))), "no tile with x = 0");
  assert.ok(keys.some((key) => key.startsWith(wrappedX(2 ** z - 1))), `no tile with x = ${2 ** z - 1}`);

  const h = 10;
  worker.send({ type: "view", id: ++messageId, lat: observer.lat, lon: observer.lon, h, k: 0, rmax: observer.rmax, rays: 64 });
  const reply = worker.messages[worker.messages.length - 1];
  assert.equal(reply.type, "view");
  assert.equal(reply.edge, false);
  const expectedHorizon = Math.sqrt(2 * R * h);
  assert.ok(
    Math.abs(reply.far.d - expectedHorizon) <= 60,
    `far.d ${reply.far.d} is not within 60 m of ${expectedHorizon}`,
  );
});
