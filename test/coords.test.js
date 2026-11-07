// Hand-typed coordinates: every accepted spelling from the search box brief, and the
// inputs that must stay rejected so a town name never turns into a point.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCoordinates } = require("../coords.js");

const TOLERANCE = 1e-6;

function expectPoint(text, expectedLat, expectedLon) {
  const point = parseCoordinates(text);
  assert.ok(point, `parseCoordinates(${JSON.stringify(text)}) returned null`);
  assert.ok(
    Math.abs(point.lat - expectedLat) <= TOLERANCE,
    `${JSON.stringify(text)}: lat ${point.lat} is not within ${TOLERANCE} of ${expectedLat}`,
  );
  assert.ok(
    Math.abs(point.lon - expectedLon) <= TOLERANCE,
    `${JSON.stringify(text)}: lon ${point.lon} is not within ${TOLERANCE} of ${expectedLon}`,
  );
}

function expectRejected(text) {
  assert.equal(
    parseCoordinates(text),
    null,
    `parseCoordinates(${JSON.stringify(text)}) should be rejected`,
  );
}

test("decimal degrees with a comma, semicolon or space", () => {
  expectPoint("50.11, 8.68", 50.11, 8.68);
  expectPoint("50.11; 8.68", 50.11, 8.68);
  expectPoint("50.11 8.68", 50.11, 8.68);
  expectPoint("-33.86, 151.21", -33.86, 151.21);
});

test("hemisphere letters after the number", () => {
  expectPoint("50.11N 8.68E", 50.11, 8.68);
  expectPoint("33.86 S, 151.21 E", -33.86, 151.21);
});

test("hemisphere letters before the number", () => {
  expectPoint("N 50.11 E 8.68", 50.11, 8.68);
});

test("hemisphere letters decide the axis when longitude comes first", () => {
  expectPoint("8.68E 50.11N", 50.11, 8.68);
});

test("degrees, minutes and seconds", () => {
  expectPoint(
    "50°06'36\"N 8°40'48\"E",
    50 + 6 / 60 + 36 / 3600,
    8 + 40 / 60 + 48 / 3600,
  );
  expectPoint(
    "50°06'36\"N; 8°40'48\"E",
    50 + 6 / 60 + 36 / 3600,
    8 + 40 / 60 + 48 / 3600,
  );
});

test("decimal minutes", () => {
  expectPoint("50° 6.6' N, 8° 40.8' E", 50 + 6.6 / 60, 8 + 40.8 / 60);
});

test("Unicode prime marks", () => {
  expectPoint(
    "50°06′36″N 8°40′48″E",
    50 + 6 / 60 + 36 / 3600,
    8 + 40 / 60 + 48 / 3600,
  );
});

test("rejects a single number", () => {
  expectRejected("50.11");
  expectRejected("50.11N");
});

test("rejects empty or non-coordinate text", () => {
  expectRejected("");
  expectRejected("   ");
  expectRejected("Bad Homburg");
  expectRejected("abc 50.11, 8.68");
});

test("rejects latitudes outside ±90 and longitudes outside ±180", () => {
  expectRejected("91, 8");
  expectRejected("-90.0001, 8");
  expectRejected("50, 181");
  expectRejected("50, -180.0001");
});

test("rejects minutes or seconds of 60 and above", () => {
  expectRejected("50°61'00\"N 8°00'00\"E");
  expectRejected("50°06'60\"N 8°00'00\"E");
});

test("rejects two coordinates on the same axis", () => {
  expectRejected("50.11N 8.68N");
});

test("rejects more than two coordinates", () => {
  expectRejected("50.11, 8.68, 9.0");
});
