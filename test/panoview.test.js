// Panorama azimuth window: mapping between azimuths and plot positions, zoom about a
// pointer fraction, panning, and the smallest useful span for a given ray count.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PANO_FULL,
  panoFraction,
  panoAzimuth,
  panoZoom,
  panoPan,
  panoMinSpan,
} = require("../panoview.js");

const TOLERANCE = 1e-9;

function close(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE,
    `${message}: ${actual} is not within ${TOLERANCE} of ${expected}`,
  );
}

test("the full window maps every azimuth to a fraction", () => {
  close(panoFraction(PANO_FULL, 90), 0.25, "north-east quarter");
  close(panoFraction(PANO_FULL, 450), 0.25, "one full turn beyond 90");
  close(panoFraction(PANO_FULL, -270), 0.25, "one full turn below 90");
  close(panoAzimuth(PANO_FULL, 0.5), 180, "fraction 0.5");
});

test("a window across north wraps like the compass", () => {
  const window = { start: 350, span: 20 };
  close(panoFraction(window, 355), 0.25, "355 inside the window");
  close(panoFraction(window, 5), 0.75, "5 inside the window");
  assert.equal(panoFraction(window, 180), null, "180 outside the window");
  close(panoAzimuth(window, 0.75), 5, "fraction 0.75");
});

test("fraction and azimuth round-trip", () => {
  const windows = [
    PANO_FULL,
    { start: 350, span: 20 },
    { start: 45, span: 180 },
    { start: 300, span: 90 },
    { start: 10, span: 359.5 },
  ];
  const fractions = [0, 0.1, 0.25, 0.5, 0.75, 0.999];
  for (const window of windows) {
    for (const fraction of fractions) {
      const azimuth = panoAzimuth(window, fraction);
      close(
        panoFraction(window, azimuth),
        fraction,
        `window ${JSON.stringify(window)} at fraction ${fraction}`,
      );
    }
  }
});

test("zooming keeps the azimuth under the pointer", () => {
  const zoomed = panoZoom(PANO_FULL, 0.25, 2, 10);
  close(zoomed.span, 180, "span halves");
  close(zoomed.start, 45, "start follows the anchored 90 degrees");
  close(
    panoFraction(zoomed, panoAzimuth(PANO_FULL, 0.25)),
    0.25,
    "90 degrees stays at fraction 0.25",
  );

  close(panoZoom(PANO_FULL, 0.5, 0.25, 10).span, 360, "zooming out clamps to 360");

  const narrow = panoZoom({ start: 10, span: 20 }, 0.3, 10, 8);
  close(narrow.span, 8, "zooming in clamps to minSpan");
  const anchor = panoAzimuth({ start: 10, span: 20 }, 0.3);
  close(panoFraction(narrow, anchor), 0.3, "anchor stays at its fraction");
});

test("panning shifts the window and wraps its start", () => {
  close(panoPan({ start: 350, span: 20 }, 1).start, 10, "start wraps past north");
  close(panoPan({ start: 350, span: 20 }, -0.25).start, 345, "small shift backwards");
  close(panoPan({ start: 350, span: 20 }, 1).span, 20, "span is unchanged");
});

test("the minimum span is one ray per four pixels", () => {
  close(panoMinSpan(8192, 1000), 360 * 1000 / (4 * 8192), "8192 rays on 1000 px");
  assert.equal(panoMinSpan(8192, 100000), 360, "wide plots never exceed a full turn");
});
