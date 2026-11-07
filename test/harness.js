// Loads worker.js as a plain function so it can be driven from node:test.
// The worker is a classic script: its top-level declarations stay inside the wrapper function
// and its `onmessage = ...` assignment binds to the local below, so loaded workers are isolated.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TILE_SIDE = 1201;

// loadWorker(sourcePath?) -> { send(message), messages }
// The worker's postMessage calls append to `messages` (transfer lists are ignored);
// send() dispatches a message to the worker's onmessage handler synchronously.
function loadWorker(sourcePath = path.join(__dirname, "..", "worker.js")) {
  const messages = [];
  const source = fs.readFileSync(sourcePath, "utf8");
  // `let onmessage` catches the worker's global assignment; without it the assignment would
  // write a Node global and a second worker would replace the first worker's handler. The
  // wrapper returns a dispatcher, not the handler value, so it reads that binding on every
  // send: a captured value would hide the leak and keep isolated-looking workers working.
  const startWorker = new Function(
    "postMessage",
    "let onmessage;\n" + source + "\nreturn (message) => onmessage(message);\n//# sourceURL=" + sourcePath,
  );
  const dispatch = startWorker((message) => { messages.push(message); });
  return {
    messages,
    send(message) { dispatch({ data: message }); },
  };
}

// flatTile(heightMetres) -> Int16Array(1201 * 1201) filled with heightMetres
function flatTile(heightMetres) {
  return new Int16Array(TILE_SIDE * TILE_SIDE).fill(heightMetres);
}

module.exports = { loadWorker, flatTile };
