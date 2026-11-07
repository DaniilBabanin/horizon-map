// Loads worker.js as a plain function so it can be driven from node:test.
// The worker is a classic script: its top-level declarations stay inside the wrapper function
// and its `onmessage = ...` assignment binds to the local below, so loaded workers are isolated.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TILE_SIDE = 256;
const RAD = Math.PI / 180;

let prepareId = 0;

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

// flatTile(heightMetres) -> Int16Array(256 * 256) filled with heightMetres
function flatTile(heightMetres) {
  return new Int16Array(TILE_SIDE * TILE_SIDE).fill(heightMetres);
}

function longitudeOfPixel(globalPixelX, z) {
  return globalPixelX / (TILE_SIDE * 2 ** z) * 360 - 180;
}

function latitudeOfPixel(globalPixelY, z) {
  const mercatorY = (1 - 2 * globalPixelY / (TILE_SIDE * 2 ** z)) * Math.PI;
  return (2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2) / RAD;
}

// loadTerrain(worker, { lat, lon, rmax }, heightAt?, skipKey?) -> { z, keys }
// Sends prepare, reads the `need` reply, builds every requested tile by calling
// heightAt(latDeg, lonDeg) at each pixel centre (default flat 0), skips keys where
// skipKey(key) is true, and sends the tiles. Returns the zoom and the requested keys.
function loadTerrain(worker, { lat, lon, rmax }, heightAt, skipKey) {
  const id = ++prepareId;
  worker.send({ type: "prepare", id, lat, lon, rmax });
  const need = worker.messages.filter((message) => message.type === "need" && message.id === id).pop();
  if (!need) throw new Error("worker did not reply to prepare with a need message");
  for (const key of need.keys) {
    if (skipKey && skipKey(key)) continue;
    const [z, x, y] = key.split("/").map(Number);
    const data = flatTile(0);
    if (heightAt) {
      for (let row = 0; row < TILE_SIDE; row++) {
        const pixelLat = latitudeOfPixel(y * TILE_SIDE + row + 0.5, z);
        for (let column = 0; column < TILE_SIDE; column++) {
          const pixelLon = longitudeOfPixel(x * TILE_SIDE + column + 0.5, z);
          data[row * TILE_SIDE + column] = heightAt(pixelLat, pixelLon);
        }
      }
    }
    worker.send({ type: "tile", key, data });
  }
  return { z: need.z, keys: need.keys };
}

module.exports = { loadWorker, flatTile, loadTerrain };
