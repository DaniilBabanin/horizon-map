// Measures how the ray count trades accuracy against speed in worker.js's view().
// Prints one Markdown table; progress and total runtime go to stderr.
// Measured 2026-11-07 at Feldberg/100 km/4096 rays through test/harness.js: 293-302 ms over three
// runs. The earlier 3410 ms figure came from running worker.js in node:vm, whose context
// indirection made every global lookup (Math.*) ~10x slower. Ratios between rows hold.
"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { loadWorker } = require("../test/harness.js");
const { decodeDemPng } = require("./png.js");

const ROOT = path.join(__dirname, "..");
const R = 6371008.8;
const REGION = { la0: 48, lo0: 6, nla: 4, nlo: 5 };
const REFRACTION_K = 0.13; // index.html default
const MASK_WORLD_WIDTH = 1024; // worker's unit-Mercator world width
const RAD = Math.PI / 180;

const SITES = [
  { name: "Großer Feldberg", lat: 50.2325, lon: 8.4573, h: 1.7 },
  { name: "Mainz", lat: 49.9989, lon: 8.2739, h: 24 },
  { name: "Bacharach", lat: 50.0590, lon: 7.7690, h: 1.7 },
];
const RMAX_VALUES = [100000, 200000];
const RAY_COUNTS = [4096, 8192, 16384, 32768];
const REFERENCE_RAYS = 65536;
const FAR_DISTANCE_METRES = 50000;
const REFERENCE_RUN_LIMIT_MS = 120000; // brief: one reference run if a run exceeds 120 s

function loadTerrain(worker) {
  for (let la = REGION.la0; la < REGION.la0 + REGION.nla; la++) {
    for (let lo = REGION.lo0; lo < REGION.lo0 + REGION.nlo; lo++) {
      const idx = (la - REGION.la0) * REGION.nlo + (lo - REGION.lo0);
      const file = path.join(ROOT, "dem", "N" + la + "E" + String(lo).padStart(3, "0") + ".png");
      worker.send({ type: "tile", idx, data: decodeDemPng(file) });
    }
  }
  worker.messages.length = 0;
}

function timeViewOnce(worker, request) {
  worker.messages.length = 0;
  const started = performance.now();
  worker.send(request);
  const elapsed = performance.now() - started;
  const reply = worker.messages.find((message) => message.type === "view");
  if (!reply) throw new Error("no view reply");
  if (reply.error) throw new Error("view error: " + reply.error);
  return { reply, elapsed };
}

function measureRuns(worker, request, runCount) {
  const samples = [];
  let reply = null;
  for (let run = 0; run < runCount; run++) {
    const result = timeViewOnce(worker, request);
    samples.push(result.elapsed);
    reply = result.reply;
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(samples.length / 2)], runs: samples.length, reply };
}

function measureReference(worker, request) {
  const first = timeViewOnce(worker, request);
  if (first.elapsed > REFERENCE_RUN_LIMIT_MS) {
    return { medianMs: first.elapsed, runs: 1, reply: first.reply };
  }
  const second = timeViewOnce(worker, request);
  const third = timeViewOnce(worker, request);
  const samples = [first.elapsed, second.elapsed, third.elapsed].sort((a, b) => a - b);
  return { medianMs: samples[1], runs: 3, reply: third.reply };
}

function assertSameLayout(candidate, reference) {
  if (candidate.pw !== reference.pw || candidate.ph !== reference.ph) {
    throw new Error("mask size differs: " + candidate.pw + "x" + candidate.ph + " vs " + reference.pw + "x" + reference.ph);
  }
  for (let part = 0; part < 4; part++) {
    if (candidate.bbox[part] !== reference.bbox[part]) {
      throw new Error("mask bbox differs at " + part + ": " + candidate.bbox[part] + " vs " + reference.bbox[part]);
    }
  }
}

// Same flat pixel-centre distance formula the worker's mask raster uses.
function pixelDistances(reply, site) {
  const [x0, y0, x1, y1] = reply.bbox;
  const cosl = Math.cos(site.lat * RAD);
  const distances = new Float64Array(reply.pw * reply.ph);
  for (let j = 0; j < reply.ph; j++) {
    const yy = y0 + (j + 0.5) / reply.ph * (y1 - y0);
    const plat = (2 * Math.atan(Math.exp((1 - 2 * yy / MASK_WORLD_WIDTH) * Math.PI)) - Math.PI / 2) / RAD;
    const dy = (plat - site.lat) * RAD * R;
    for (let i = 0; i < reply.pw; i++) {
      const plon = (x0 + (i + 0.5) / reply.pw * (x1 - x0)) / MASK_WORLD_WIDTH * 360 - 180;
      const dx = (plon - site.lon) * RAD * R * cosl;
      distances[j * reply.pw + i] = Math.hypot(dx, dy);
    }
  }
  return distances;
}

// Counts disagreement over pixels farther than minimumDistanceMetres, as % of the
// reference's visible pixels in the same band.
function countDisagreement(candidate, reference, distances, minimumDistanceMetres) {
  let referenceVisible = 0, novelPixels = 0, missingPixels = 0;
  for (let pixel = 0; pixel < reference.mask.length; pixel++) {
    if (distances[pixel] <= minimumDistanceMetres) continue;
    const inReference = reference.mask[pixel] !== 0;
    const inCandidate = candidate.mask[pixel] !== 0;
    if (inReference) referenceVisible++;
    if (inCandidate && !inReference) novelPixels++;
    else if (!inCandidate && inReference) missingPixels++;
  }
  return {
    novelPercent: referenceVisible === 0 ? 0 : novelPixels / referenceVisible * 100,
    missingPercent: referenceVisible === 0 ? 0 : missingPixels / referenceVisible * 100,
    referenceVisible,
  };
}

function makeRow(site, rmax, rays, measurement, referenceReply, referenceDistances) {
  const overall = countDisagreement(measurement.reply, referenceReply, referenceDistances, -1);
  const far = countDisagreement(measurement.reply, referenceReply, referenceDistances, FAR_DISTANCE_METRES);
  return {
    site: site.name,
    rmax,
    rays,
    medianMs: measurement.medianMs,
    runs: measurement.runs,
    areaKm2: measurement.reply.area / 1e6,
    farKm: measurement.reply.far.d / 1000,
    novelPercent: overall.novelPercent,
    missingPercent: overall.missingPercent,
    farNovelPercent: far.novelPercent,
    farMissingPercent: far.missingPercent,
  };
}

function printHeader() {
  console.log("| Site | rmax km | rays | send ms (runs) | area km² | far.d km | novel % | missing % | novel >50 km % | missing >50 km % |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
}

function printRow(row) {
  console.log(
    "| " + row.site +
    " | " + (row.rmax / 1000) +
    " | " + row.rays +
    " | " + row.medianMs.toFixed(1) + " (" + row.runs + ")" +
    " | " + row.areaKm2.toFixed(1) +
    " | " + row.farKm.toFixed(2) +
    " | " + row.novelPercent.toFixed(2) +
    " | " + row.missingPercent.toFixed(2) +
    " | " + row.farNovelPercent.toFixed(2) +
    " | " + row.farMissingPercent.toFixed(2) +
    " |",
  );
}

function main() {
  const startedAt = performance.now();
  const worker = loadWorker();
  worker.send({ type: "init", la0: REGION.la0, lo0: REGION.lo0, nla: REGION.nla, nlo: REGION.nlo, R });
  loadTerrain(worker);

  const referenceRunCounts = [];
  let viewId = 0;
  printHeader();
  for (const site of SITES) {
    for (const rmax of RMAX_VALUES) {
      console.error("measuring " + site.name + " rmax " + rmax / 1000 + " km");
      const referenceRequest = {
        type: "view", id: ++viewId, lat: site.lat, lon: site.lon, h: site.h,
        k: REFRACTION_K, rmax, rays: REFERENCE_RAYS,
      };
      const reference = measureReference(worker, referenceRequest);
      referenceRunCounts.push({ site: site.name, rmax, runs: reference.runs, medianMs: reference.medianMs });
      const referenceDistances = pixelDistances(reference.reply, site);
      printRow(makeRow(site, rmax, REFERENCE_RAYS, reference, reference.reply, referenceDistances));

      for (const rays of RAY_COUNTS) {
        const request = {
          type: "view", id: ++viewId, lat: site.lat, lon: site.lon, h: site.h,
          k: REFRACTION_K, rmax, rays,
        };
        const measurement = measureRuns(worker, request, 3);
        assertSameLayout(measurement.reply, reference.reply);
        printRow(makeRow(site, rmax, rays, measurement, reference.reply, referenceDistances));
      }
    }
  }

  const singleRunReferences = referenceRunCounts.filter((entry) => entry.runs === 1);
  if (singleRunReferences.length > 0) {
    console.error("Reference (65536 rays) used 1 run (> " + REFERENCE_RUN_LIMIT_MS / 1000 + " s): " +
      singleRunReferences.map((entry) => entry.site + " rmax " + entry.rmax / 1000 + " km at " + entry.medianMs.toFixed(0) + " ms").join("; "));
  }
  console.error("total runtime: " + ((performance.now() - startedAt) / 1000).toFixed(1) + " s");
}

main();
