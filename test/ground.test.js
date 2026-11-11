// Analytic checks of the optional `ground` field in worker.js: a page that stands the
// observer on an OSM summit replaces the sampled terrain height z0, so the raised eye sees
// farther and a query uses the raised eye. Expected horizons come from the flat-sphere
// formulas, never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const RAD = Math.PI / 180;
const RAY_STEP = 60;
const PLAIN_METRES = 100;
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

// Loading tiles runs hillshade for each one, so the 100 m plain is built once and reused.
const plainWorker = startWorker();
loadTerrain(plainWorker, OBSERVER, () => PLAIN_METRES);

test("ground override becomes z0 and the eye is h above it", () => {
  const reply = runView(plainWorker, { ...OBSERVER, h: 2, k: 0, rays: 64, ground: 500 });
  assert.equal(reply.z0, 500);
  assert.equal(reply.zo, 502);
});

test("a missing, null or NaN ground keeps the sampled height", () => {
  const params = { ...OBSERVER, h: 2, k: 0, rays: 64 };
  const sampled = runView(plainWorker, params);
  assert.ok(
    Math.abs(sampled.z0 - PLAIN_METRES) <= 1,
    `z0 ${sampled.z0} is not within 1 m of ${PLAIN_METRES}`,
  );
  for (const ground of [null, NaN]) {
    const reply = runView(plainWorker, { ...params, ground });
    assert.equal(reply.z0, sampled.z0, `ground ${ground} changed z0`);
    assert.equal(reply.zo, sampled.zo, `ground ${ground} changed zo`);
  }
});

test("a raised ground sees farther across a flat plain", () => {
  const params = { ...OBSERVER, h: 2, k: 0, rmax: 100000, rays: 64 };
  const plain = runView(plainWorker, params);
  const raised = runView(plainWorker, { ...params, ground: 500 });
  // The plain is 100 m, so the plain view has a 2 m eye above it and the raised view 402 m.
  const plainHorizon = Math.sqrt(2 * R * 2);
  const raisedHorizon = Math.sqrt(2 * R * 402);
  assert.ok(
    Math.abs(plain.far.d - plainHorizon) <= RAY_STEP,
    `plain far.d ${plain.far.d} is not within ${RAY_STEP} m of ${plainHorizon}`,
  );
  assert.ok(
    Math.abs(raised.far.d - raisedHorizon) <= RAY_STEP,
    `raised far.d ${raised.far.d} is not within ${RAY_STEP} m of ${raisedHorizon}`,
  );
  assert.ok(raised.far.d > plain.far.d, `raised far.d ${raised.far.d} is not beyond plain ${plain.far.d}`);
});

test("a query after a ground view uses the raised eye", () => {
  const h = 2, k = 0, D = 30000;
  const target = { lat: OBSERVER.lat, lon: OBSERVER.lon + D / (R * RAD * Math.cos(OBSERVER.lat * RAD)) };
  runView(plainWorker, { ...OBSERVER, h, k, rmax: 100000, rays: 64, ground: 500 });
  const raised = runQuery(plainWorker, target);
  assert.equal(raised.hidden, 0, `raised eye reports ${raised.hidden} m hidden at ${D} m`);
  runView(plainWorker, { ...OBSERVER, h, k, rmax: 100000, rays: 64 });
  const plain = runQuery(plainWorker, target);
  assert.ok(plain.hidden > 0, `plain eye reports ${plain.hidden} m hidden at ${D} m`);
});

test("a ground override does not rescue a view with no terrain at the observer", () => {
  const worker = startWorker();
  loadTerrain(worker, OBSERVER, undefined, () => true);
  const reply = runView(worker, { ...OBSERVER, h: 2, k: 0, rays: 64, ground: 500 });
  assert.equal(reply.error, "outside");
});
