"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker, flatTile } = require("./harness.js");

const R = 6371008.8;
const REGION = { la0: 48, lo0: 6, nla: 4, nlo: 5 };

function startWorker() {
  const worker = loadWorker();
  worker.send({ type: "init", la0: REGION.la0, lo0: REGION.lo0, nla: REGION.nla, nlo: REGION.nlo, R });
  return worker;
}

function loadFlatTiles(worker, heightMetres) {
  for (let la = REGION.la0; la < REGION.la0 + REGION.nla; la++) {
    for (let lo = REGION.lo0; lo < REGION.lo0 + REGION.nlo; lo++) {
      const idx = (la - REGION.la0) * REGION.nlo + (lo - REGION.lo0);
      worker.send({ type: "tile", idx, data: flatTile(heightMetres) });
    }
  }
}

function lastViewMessage(worker) {
  const viewMessages = worker.messages.filter((message) => message.type === "view");
  assert.ok(viewMessages.length > 0, "worker posted no view message");
  return viewMessages[viewMessages.length - 1];
}

test("flat ground: farthest point sits at the geometric horizon", () => {
  const worker = startWorker();
  loadFlatTiles(worker, 0);
  worker.send({ type: "view", id: 1, lat: 50, lon: 8, h: 100, k: 0, rmax: 100000 });
  const reply = lastViewMessage(worker);
  assert.equal(reply.id, 1);
  const expectedHorizon = Math.sqrt(2 * R * 100);
  assert.ok(
    Math.abs(reply.far.d - expectedHorizon) <= 60,
    `far.d ${reply.far.d} is not within 60 m of ${expectedHorizon}`,
  );
});

test("view outside the region replies with an error", () => {
  const worker = startWorker();
  loadFlatTiles(worker, 0);
  worker.send({ type: "view", id: 2, lat: 47, lon: 8, h: 100, k: 0, rmax: 100000 });
  const reply = lastViewMessage(worker);
  assert.equal(reply.id, 2);
  assert.equal(reply.error, "outside");
});

test("view honours the optional rays count", () => {
  const worker = startWorker();
  loadFlatTiles(worker, 0);
  worker.send({ type: "view", id: 3, lat: 50, lon: 8, h: 100, k: 0, rmax: 100000, rays: 1024 });
  const reply = lastViewMessage(worker);
  assert.equal(reply.id, 3);
  assert.equal(reply.A, 1024);
});

test("two workers keep separate state", () => {
  // A has terrain, B has none. If the workers shared one onmessage handler, the later
  // load would replace the handler that owns A's tiles and A's view would fail.
  const loadedWorker = startWorker();
  loadFlatTiles(loadedWorker, 0);
  const emptyWorker = startWorker();
  loadedWorker.send({ type: "view", id: 4, lat: 50, lon: 8, h: 100, k: 0, rmax: 100000, rays: 64 });
  const loadedReply = lastViewMessage(loadedWorker);
  assert.equal(loadedReply.id, 4);
  assert.equal(loadedReply.error, undefined);
  emptyWorker.send({ type: "view", id: 5, lat: 50, lon: 8, h: 100, k: 0, rmax: 100000, rays: 64 });
  const emptyReply = lastViewMessage(emptyWorker);
  assert.equal(emptyReply.id, 5);
  assert.equal(emptyReply.error, "outside");
});
