// Checks the sightline profile that `query` returns when the page asks for one: a per-distance
// bin holdout of the walk, so a chart can show why a target is hidden. Bounds come from the
// tile geometry (about 76 m per pixel at the equator, z11) and the bin width.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const OBSERVER = { lat: 0, lon: 0, rmax: 20000 };
const RAY_STEP = 30; // query walk step in metres

let messageId = 0;

function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", R });
  return worker;
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

function longitudeEastOf(distanceMetres) {
  return distanceMetres / (R * RAD);
}

// 500 m high north-south wall from about 5.0 km to 6.1 km east; flat elsewhere.
function wallHeight(lat, lon) {
  return lon >= 0.045 && lon <= 0.055 ? 500 : 0;
}

const wallWorker = startWorker();
loadTerrain(wallWorker, OBSERVER, wallHeight);

const flatWorker = startWorker();
loadTerrain(flatWorker, OBSERVER);

test("profile: the wall appears as a 500 m ridge where the walk crossed it", () => {
  runView(wallWorker, { ...OBSERVER, h: 2, k: 0, rays: 64 });
  const reply = runQuery(wallWorker, { lat: 0, lon: 0.09, profile: 100 });

  assert.ok(reply.profile instanceof Float32Array, "profile is not a Float32Array");
  assert.equal(reply.profile.length, 100);

  let maximum = -Infinity;
  for (const value of reply.profile) if (value > maximum) maximum = value;
  assert.ok(Math.abs(maximum - 500) <= 5, `profile maximum ${maximum} is not within 5 m of 500`);

  const firstRidgeBin = reply.profile.findIndex((value) => value > 250);
  assert.ok(firstRidgeBin >= 0, "no bin reaches 250 m");
  const firstRidgeD = firstRidgeBin * reply.D / reply.profile.length;
  assert.ok(
    firstRidgeD >= 4800 && firstRidgeD <= 5300,
    `first ridge bin at ${firstRidgeD} m is outside 4800..5300 m`,
  );

  assert.ok(
    reply.blockD >= 4800 && reply.blockD <= 6300,
    `blockD ${reply.blockD} is outside 4800..6300 m`,
  );
  assert.ok(reply.hidden > 0, `hidden ${reply.hidden} is not positive`);
});

test("profile: flat terrain has a finite zero profile and nothing hidden", () => {
  runView(flatWorker, { ...OBSERVER, h: 2, k: 0, rays: 64 });
  // 4,000 m stays inside the 2 m eye's horizon (sqrt(2 * R * 2) ~= 5,048 m), so nothing
  // is hidden; a bin is 40 m wide, wider than the 30 m walk step, so every bin is filled.
  const reply = runQuery(flatWorker, { lat: 0, lon: longitudeEastOf(4000), profile: 100 });

  assert.equal(reply.profile.length, 100);
  for (const [bin, value] of reply.profile.entries()) {
    assert.ok(Number.isFinite(value), `bin ${bin} is not finite: ${value}`);
    assert.equal(value, 0, `bin ${bin} is ${value}, not 0`);
  }
  assert.equal(reply.hidden, 0);
});

test("query without a profile request keeps the old reply shape", () => {
  runView(flatWorker, { ...OBSERVER, h: 2, k: 0, rays: 64 });
  const reply = runQuery(flatWorker, { lat: 0, lon: longitudeEastOf(6000) });

  assert.equal(Object.prototype.hasOwnProperty.call(reply, "profile"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reply, "blockD"), false);
  assert.ok(Number.isFinite(reply.D));
  assert.ok(Number.isFinite(reply.z));
  assert.ok(Number.isFinite(reply.hidden));
});

test("profile: asking for more bins than samples gives one bin per sample", () => {
  runView(flatWorker, { ...OBSERVER, h: 2, k: 0, rays: 64 });
  const reply = runQuery(flatWorker, { lat: 0, lon: longitudeEastOf(600), profile: 100000 });

  assert.equal(reply.profile.length, Math.floor(reply.D / RAY_STEP) + 1);
});
