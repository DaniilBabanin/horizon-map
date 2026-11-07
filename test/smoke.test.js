"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, loadTerrain } = require("./harness.js");

const R = 6371008.8;
const OBSERVER = { lat: 50, lon: 8, rmax: 100000 };

function startWorker() {
  const worker = loadWorker(process.env.WORKER_SRC);
  worker.send({ type: "init", R });
  return worker;
}

function lastViewMessage(worker) {
  const viewMessages = worker.messages.filter((message) => message.type === "view");
  assert.ok(viewMessages.length > 0, "worker posted no view message");
  return viewMessages[viewMessages.length - 1];
}

test("flat ground: farthest point sits at the geometric horizon", () => {
  const worker = startWorker();
  loadTerrain(worker, OBSERVER);
  worker.send({ type: "view", id: 1, ...OBSERVER, h: 100, k: 0 });
  const reply = lastViewMessage(worker);
  assert.equal(reply.id, 1);
  const expectedHorizon = Math.sqrt(2 * R * 100);
  assert.ok(
    Math.abs(reply.far.d - expectedHorizon) <= 60,
    `far.d ${reply.far.d} is not within 60 m of ${expectedHorizon}`,
  );
});

test("view outside the region replies with an error", () => {
  // prepare sets the zoom but loads no tiles: the observer's elevation is unavailable.
  const worker = startWorker();
  loadTerrain(worker, OBSERVER, undefined, () => true);
  worker.send({ type: "view", id: 2, ...OBSERVER, h: 100, k: 0 });
  const reply = lastViewMessage(worker);
  assert.equal(reply.id, 2);
  assert.equal(reply.error, "outside");
});

test("view honours the optional rays count", () => {
  const worker = startWorker();
  loadTerrain(worker, OBSERVER);
  worker.send({ type: "view", id: 3, ...OBSERVER, h: 100, k: 0, rays: 1024 });
  const reply = lastViewMessage(worker);
  assert.equal(reply.id, 3);
  assert.equal(reply.A, 1024);
});

test("two workers keep separate state", () => {
  // A has terrain, B has none. If the workers shared one onmessage handler, the later
  // load would replace the handler that owns A's tiles and A's view would fail.
  const loadedWorker = startWorker();
  loadTerrain(loadedWorker, OBSERVER);
  const emptyWorker = startWorker();
  loadTerrain(emptyWorker, OBSERVER, undefined, () => true);
  loadedWorker.send({ type: "view", id: 4, ...OBSERVER, h: 100, k: 0, rays: 64 });
  const loadedReply = lastViewMessage(loadedWorker);
  assert.equal(loadedReply.id, 4);
  assert.equal(loadedReply.error, undefined);
  emptyWorker.send({ type: "view", id: 5, ...OBSERVER, h: 100, k: 0, rays: 64 });
  const emptyReply = lastViewMessage(emptyWorker);
  assert.equal(emptyReply.id, 5);
  assert.equal(emptyReply.error, "outside");
});
