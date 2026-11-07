// Analytic checks of the target-height option in worker.js: a target of height t raises the
// sightline a point has to beat by t / distance, so the top of a distant object can stay
// visible after the ground around it has dropped below the terrain horizon.
// Expected values are derived from the formulas (flat sphere), never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const RAY_STEP = 60;
const OBSERVER = { lat: 50, lon: 8, rmax: 100000 };

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

function longitudeEastOf(lat, lon, distanceMetres) {
  return lon + distanceMetres / (R * RAD * Math.cos(lat * RAD));
}

// Exact bit comparison: a missing or zero target height must leave every sample untouched,
// not merely close enough.
function sameBytes(left, right) {
  return Buffer.compare(Buffer.from(left.buffer), Buffer.from(right.buffer)) === 0;
}

// Loading tiles runs hillshade for each one, so the flat terrain is built once at module load
// and reused; every test sends its own view before querying.
const flatWorker = startWorker();
loadTerrain(flatWorker, OBSERVER);

test("target height: farthest visible point is the two-horizon sum", () => {
  const h = 100;
  const t = 50;
  const k = 0;
  const Re = R / (1 - k);
  // The observer's own horizon plus the distance at which a t-metre top sinks below it.
  const expectedFar = Math.sqrt(2 * Re * h) + Math.sqrt(2 * Re * t);
  const reply = runView(flatWorker, { lat: 50, lon: 8, h, k, rmax: 100000, rays: 64, t });
  assert.ok(
    Math.abs(reply.far.d - expectedFar) <= RAY_STEP,
    `far.d ${reply.far.d} is not within ${RAY_STEP} m of ${expectedFar}`,
  );
});

test("target height 0 (or omitted) leaves the ground view byte-identical", () => {
  const params = { lat: 50, lon: 8, h: 100, k: 0, rmax: 100000, rays: 64 };
  const omitted = runView(flatWorker, params);
  const zero = runView(flatWorker, { ...params, t: 0 });
  for (const field of ["mask", "skyAng", "skyDist"]) {
    assert.ok(sameBytes(omitted[field], zero[field]), `${field} changed with t: 0`);
  }
  assert.equal(omitted.area, zero.area);
});

test("target height does not change the terrain skyline", () => {
  const params = { lat: 50, lon: 8, h: 100, k: 0, rmax: 100000, rays: 64 };
  const ground = runView(flatWorker, { ...params, t: 0 });
  const raised = runView(flatWorker, { ...params, t: 50 });
  assert.ok(sameBytes(ground.skyAng, raised.skyAng), "skyAng changed with a target height");
  assert.ok(sameBytes(ground.skyDist, raised.skyDist), "skyDist changed with a target height");
});

test("target height lifts the query sightline by t / D", () => {
  const observer = { lat: 50.5, lon: 8.5 };
  const h = 10;
  const k = 0;
  const D = 20000;
  const Re = R / (1 - k);
  const target = { lat: observer.lat, lon: longitudeEastOf(observer.lat, observer.lon, D) };

  // Beyond the horizon the ground point sits below the peak of the sightline angle curve;
  // a 5 m top rises by 5 / D and cuts that hidden depth by 5 m.
  runView(flatWorker, { ...observer, h, k, rmax: 100000, rays: 64, t: 5 });
  const five = runQuery(flatWorker, target);
  const peak = -Math.sqrt(2 * h / Re);
  const angT = (-five.D * five.D / (2 * Re) - h) / five.D;
  const groundHidden = five.D * (peak - angT);
  assert.ok(
    Math.abs(five.hidden - (groundHidden - 5)) <= 0.05,
    `hidden ${five.hidden} is not within 0.05 m of ${groundHidden - 5}`,
  );

  // A 10 m top rises above the peak of the ground sightline, so the point is fully visible.
  runView(flatWorker, { ...observer, h, k, rmax: 100000, rays: 64, t: 10 });
  const ten = runQuery(flatWorker, target);
  assert.equal(ten.hidden, 0);
});
