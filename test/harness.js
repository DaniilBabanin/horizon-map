// Loads worker.js in a fresh node:vm context so it can be driven from node:test.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TILE_SIDE = 1201;

// loadWorker(sourcePath?) -> { send(message), messages }
// The worker's postMessage calls append to `messages` (transfer lists are ignored);
// send() dispatches a message to the worker's onmessage handler synchronously.
function loadWorker(sourcePath = path.join(__dirname, "..", "worker.js")) {
  const messages = [];
  const context = vm.createContext({
    postMessage(message) { messages.push(message); },
  });
  const source = fs.readFileSync(sourcePath, "utf8");
  new vm.Script(source, { filename: sourcePath }).runInContext(context);
  return {
    messages,
    send(message) { context.onmessage({ data: message }); },
  };
}

// flatTile(heightMetres) -> Int16Array(1201 * 1201) filled with heightMetres
function flatTile(heightMetres) {
  return new Int16Array(TILE_SIDE * TILE_SIDE).fill(heightMetres);
}

module.exports = { loadWorker, flatTile };
