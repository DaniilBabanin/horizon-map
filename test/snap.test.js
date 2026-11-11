// Checks the summit snap that places the observer on an OSM peak: the nearest peak with a
// finite elevation inside the radius wins, the radius follows the map scale, and a peak
// across the antimeridian is measured the short way. Distances are derived from the
// great-circle formula, never pasted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { nearestSummit, summitSnapRadius } = require("../snap.js");

const R = 6371008.8;
const RAD = Math.PI / 180;

test("nearest of two peaks inside the radius wins", () => {
  const rows = [
    ["Far Peak", 0.003, 0, 3000],
    ["Near Peak", 0.001, 0, 2000],
  ];
  const found = nearestSummit(rows, 0, 0, 500, R);
  assert.ok(found, "no summit found");
  assert.equal(found.row[0], "Near Peak");
  assert.ok(Math.abs(found.distance - 111.2) <= 0.2, `distance ${found.distance} is not 111 m`);
});

test("a nearer peak without an elevation is skipped", () => {
  const rows = [
    ["Unknown Peak", 0.001, 0, null],
    ["Known Peak", 0.003, 0, 1200],
  ];
  const found = nearestSummit(rows, 0, 0, 500, R);
  assert.ok(found, "no summit found");
  assert.equal(found.row[0], "Known Peak");
});

test("a peak just outside the radius gives null", () => {
  // 120 m of latitude: 0.001079... degrees, just outside the 110 m radius.
  const rows = [["Outer Peak", 120 / (R * RAD), 0, 900]];
  assert.equal(nearestSummit(rows, 0, 0, 110, R), null);
});

test("a peak across the antimeridian is measured the short way", () => {
  const rows = [["Dateline Peak", 0, 179.9995, 1500]];
  const found = nearestSummit(rows, 0, -179.9995, 200, R);
  assert.ok(found, "the peak across the antimeridian was not found");
  assert.ok(Math.abs(found.distance - 111.2) <= 0.2, `distance ${found.distance} is not 111 m`);
});

test("empty rows give null", () => {
  assert.equal(nearestSummit([], 0, 0, 500, R), null);
});

test("the snap radius follows the map scale and its bounds", () => {
  // 110 = one coarse terrain pixel, 10 = the page's touch slop in pixels, 500 = the cap.
  assert.equal(summitSnapRadius(1), 110);
  assert.equal(summitSnapRadius(30), 300);
  assert.equal(summitSnapRadius(1000), 500);
});
