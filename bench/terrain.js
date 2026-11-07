// Loads real terrain for the benchmark: asks worker.js which AWS Terrarium tiles a
// site/radius needs, serves them from ~/.cache/horizonmap/terrarium (override with
// HORIZONMAP_TILE_CACHE), and downloads the missing ones from the public bucket.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { decodePngRgb, terrariumToInt16 } = require("./png.js");

const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const MAX_IN_FLIGHT = 8;
const USER_AGENT = "horizonmap-bench";

let prepareId = 0;
let downloadSequence = 0;

function cacheDirectory() {
  return process.env.HORIZONMAP_TILE_CACHE || path.join(os.homedir(), ".cache", "horizonmap", "terrarium");
}

// key is "z/x/y"; the cache mirrors that as <directory>/z/x/y.png.
function tilePath(directory, key) {
  return path.join(directory, ...key.split("/")) + ".png";
}

async function downloadTile(key, directory) {
  const response = await fetch(TERRARIUM_URL + "/" + key + ".png", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error("tile " + key + ": HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  const target = tilePath(directory, key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  // Write beside the target and rename, so an interrupted run never leaves a half tile
  // that later reads look complete.
  const temporary = target + ".tmp-" + process.pid + "-" + downloadSequence++;
  await fs.promises.writeFile(temporary, bytes);
  await fs.promises.rename(temporary, target);
}

// At most MAX_IN_FLIGHT downloads run at once; each lane takes the next missing key.
async function downloadTiles(keys, directory) {
  let nextKey = 0;
  async function downloadLane() {
    while (nextKey < keys.length) {
      const key = keys[nextKey++];
      await downloadTile(key, directory);
    }
  }
  const laneCount = Math.min(MAX_IN_FLIGHT, keys.length);
  const lanes = [];
  for (let lane = 0; lane < laneCount; lane++) lanes.push(downloadLane());
  await Promise.all(lanes);
}

// loadRealTerrain(worker, { lat, lon, rmax }) -> { z, keys }
// Sends prepare, reads the worker's need reply, downloads/reads every requested tile and
// sends it as an Int16Array of whole metres. Returns the zoom and requested keys.
async function loadRealTerrain(worker, { lat, lon, rmax }) {
  const id = ++prepareId;
  worker.send({ type: "prepare", id, lat, lon, rmax });
  const need = worker.messages.filter((message) => message.type === "need" && message.id === id).pop();
  if (!need) throw new Error("worker did not reply to prepare with a need message");
  const directory = cacheDirectory();
  const missing = need.keys.filter((key) => !fs.existsSync(tilePath(directory, key)));
  await downloadTiles(missing, directory);
  for (const key of need.keys) {
    const { rgb } = decodePngRgb(tilePath(directory, key));
    worker.send({ type: "tile", key, data: terrariumToInt16(rgb) });
  }
  return { z: need.z, keys: need.keys };
}

module.exports = { loadRealTerrain, cacheDirectory };
