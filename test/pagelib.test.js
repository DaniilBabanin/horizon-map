// Pure page helpers: formulas checked against hand arithmetic (comments show the derivation),
// the OSM tile block, the URL hash and the panorama peak-tag layout.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  wrapLon,
  raysFor,
  flatHorizonDistance,
  compassPoint,
  heightToSlider,
  sliderToHeight,
  peakCellName,
  peakCellsTouched,
  parseHashState,
  formatHashState,
  osmZoomFor,
  osmTileRange,
  placePeakTags,
} = require("../pagelib.js");

const EARTH_RADIUS = 6371008.8;
const PANO_FULL = { start: 0, span: 360 };

test("raysFor rounds the 80 m horizon spacing up to a power of two", () => {
  // 2*pi*50000/80 = 3927 -> 2^12 = 4096, floor 8192; 150000 -> 11781 -> 2^14 = 16384.
  assert.equal(raysFor(50000), 8192);
  assert.equal(raysFor(100000), 8192);
  assert.equal(raysFor(150000), 16384);
  assert.equal(raysFor(200000), 16384);
});

test("wrapLon folds degrees into [-180, 180)", () => {
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-180), -180);
  assert.equal(wrapLon(180), -180);
  assert.equal(wrapLon(540), -180);
});

test("flatHorizonDistance follows the refracted-Earth circle", () => {
  // sqrt(2*R*h) = sqrt(2*6371008.8*1.7) = 4654 m; with k = 0.13, R/0.87 -> sqrt(2*7322998.6*1.7) = 4990 m.
  const flat = flatHorizonDistance(1.7, 0, EARTH_RADIUS);
  const refracted = flatHorizonDistance(1.7, 0.13, EARTH_RADIUS);
  assert.ok(Math.abs(flat - 4654) <= 1, `${flat} is not within 1 m of 4654`);
  assert.ok(Math.abs(refracted - 4990) <= 1, `${refracted} is not within 1 m of 4990`);
});

test("compassPoint maps degrees to sixteen points", () => {
  // 22.5 degrees per point, N at 0; 11.25 is the N/NNE edge, 359 rounds to 0.
  assert.equal(compassPoint(0), "N");
  assert.equal(compassPoint(11.24), "N");
  assert.equal(compassPoint(11.26), "NNE");
  assert.equal(compassPoint(359), "N");
  assert.equal(compassPoint(-90), "W");
});

test("height sliders invert each other and round at the documented steps", () => {
  // Slider 0..1000 spans log10(12000) - log10(0.5) = 4.3802 decades from 0.5 m.
  assert.equal(heightToSlider(0.5), 0);
  assert.equal(heightToSlider(12000), 1000);
  assert.ok(Math.abs(sliderToHeight(heightToSlider(1.7)) - 1.7) <= 0.1);
  // 10^(log10(0.5) + 292/1000*4.3802) = 9.5059 -> one decimal -> 9.5.
  assert.equal(sliderToHeight(292), 9.5);
  // 10^(log10(0.5) + 700/1000*4.3802) = 582.26 -> whole metres -> 582.
  assert.equal(sliderToHeight(700), 582);
  // 10^(log10(0.5) + 800/1000*4.3802) = 1596.39 -> tens -> 1600.
  assert.equal(sliderToHeight(800), 1600);
});

test("peakCellName pads the south-west corner", () => {
  assert.equal(peakCellName(50, 8), "N50E008");
  assert.equal(peakCellName(-2, -180), "S02W180");
  assert.equal(peakCellName(0, 0), "N00E000");
});

test("peakCellsTouched covers the disc's cell block", () => {
  // lat 50.232 +/- 100000/6371008.8 rad = +/-0.899 deg -> south 48 and 50.
  // lon half-width asin(sin(delta)/cos(50.232 deg)) = 1.406 deg -> west 6 and 8.
  const cells = peakCellsTouched(50.232, 8.458, 100000, EARTH_RADIUS);
  assert.deepEqual(cells.slice().sort(), ["N48E006", "N48E008", "N50E006", "N50E008"]);
  assert.ok(!cells.includes("N50E010"));
  assert.equal(new Set(cells).size, cells.length, "every cell name is unique");
  // lon 179.9 +/- 0.899 deg reaches 180, which wraps to W180.
  const across = peakCellsTouched(0, 179.9, 100000, EARTH_RADIUS);
  assert.ok(across.includes("N00E178"), "cell east of the observer");
  assert.ok(across.includes("N00W180"), "cell across the antimeridian");
});

test("parseHashState validates and narrows the hash", () => {
  const full = "lat=50.233&lon=8.459&h=1.7&k=0.13&rmax=50000&t=0&names=en";
  assert.equal(formatHashState(parseHashState("#" + full, 85)), full, "full hash round-trips");
  assert.equal(formatHashState(parseHashState(full, 85)), full, "leading # is optional");

  assert.equal(parseHashState("lat=50&lon=8&k=0.13", 85), null, "missing h");
  assert.equal(parseHashState("lat=86&lon=8&h=1.7", 85), null, "latitude above maxLat");
  assert.equal(parseHashState("lat=50&lon=8&h=1.7", 85).h, 1.7, "valid h passes through");

  const capped = parseHashState("lat=50&lon=8&h=50000", 85);
  assert.equal(capped.h, 12000);

  for (const t of ["-1", "2000"]) {
    const parsed = parseHashState(`lat=50&lon=8&h=1.7&t=${t}`, 85);
    assert.equal(Object.hasOwn(parsed, "t"), false, `t=${t} is out of range`);
  }
  assert.equal(parseHashState("lat=50&lon=8&h=1.7&t=800", 85).t, 800);

  assert.equal(parseHashState("lat=50&lon=8&h=1.7&names=en", 85).names, "en");
  // The ground override's limits: the Dead Sea shore (about -430 m) and Everest (8,849 m) are inside.
  assert.equal(parseHashState("lat=50&lon=8&h=1.7&g=8849", 85).g, 8849);
  assert.equal(parseHashState("lat=50&lon=8&h=1.7&g=-430", 85).g, -430);
  assert.equal(parseHashState("lat=50&lon=8&h=1.7&g=9001", 85).g, null);
  assert.equal(parseHashState("lat=50&lon=8&h=1.7&g=-501", 85).g, null);
  assert.equal(parseHashState("lat=50&lon=8&h=1.7", 85).names, "local");

  assert.equal(parseHashState("lat=50&lon=8&h=1.7&g=880", 85).g, 880);
  assert.equal(parseHashState("lat=50&lon=8&h=1.7&g=99999", 85).g, null);
  assert.equal(parseHashState("lat=50&lon=8&h=1.7", 85).g, null);

  const withoutK = parseHashState("lat=50&lon=8&h=1.7", 85);
  assert.equal(Object.hasOwn(withoutK, "k"), false, "no k in the hash, no k in the result");
});

test("formatHashState writes the hash in persistState's order", () => {
  const local = { lat: 50.233, lon: 8.459, h: 1.7, k: 0.13, rmax: 50000, t: 0, names: "local", g: null };
  assert.equal(formatHashState(local), "lat=50.233&lon=8.459&h=1.7&k=0.13&rmax=50000&t=0");
  const english = { ...local, names: "en", g: 880 };
  assert.equal(formatHashState(english), "lat=50.233&lon=8.459&h=1.7&k=0.13&rmax=50000&t=0&names=en&g=880");
});

test("osmZoomFor picks the tile zoom from the map scale", () => {
  // log2(1*1024/256) = 2; log2(1024*1024/256) = 12.
  assert.equal(osmZoomFor(1, 1024, 256, 19), 2);
  assert.equal(osmZoomFor(1024, 1024, 256, 19), 12);
  assert.equal(osmZoomFor(1e-6, 1024, 256, 19), 0, "clamped at 0");
  assert.equal(osmZoomFor(1e6, 1024, 256, 19), 19, "clamped at maxZoom");
});

test("osmTileRange covers the viewport in unwrapped columns", () => {
  // k=1 on 1024x1024 px: z 2, side 256, columns 0..3 and rows 0..3. Math.floor(-0) is -0,
  // which the page treats as 0, so compare with ===.
  const atOrigin = osmTileRange({ x: 0, y: 0, k: 1 }, 1024, 1024, 1024, 256, 19);
  assert.equal(atOrigin.z, 2);
  assert.equal(atOrigin.side, 256);
  assert.ok(atOrigin.colStart === 0, `colStart ${atOrigin.colStart} is not 0`);
  assert.equal(atOrigin.colEnd, 3);
  assert.equal(atOrigin.rowStart, 0);
  assert.equal(atOrigin.rowEnd, 3);

  // Panned right by 500 px: -500/256 -> floor(-1.95) = -2; rows stay inside the square.
  const shifted = osmTileRange({ x: 500, y: 0, k: 1 }, 1024, 1024, 1024, 256, 19);
  assert.equal(shifted.colStart, -2);
  assert.ok(shifted.colStart < 0, "columns are unwrapped");
  assert.equal(shifted.rowStart, 0);
  assert.equal(shifted.rowEnd, 3);
});

test("placePeakTags places two rows greedily", () => {
  const plot = { left: 40, width: 1000, pad: 5, gap: 3 };
  const measureText = (text) => text.length * 6;

  // All three at due north (x = plot.left): "AB" is 12 + 10 = 22 px wide, so the tags
  // overlap on both rows and only two of the three fit.
  const stack = ["AB", "CD", "EF"].map((text) => ({ az: 0, sky: false, ele: 100, d: 1000, text }));
  const stacked = placePeakTags(stack, measureText, PANO_FULL, plot);
  assert.deepEqual(stacked.placed.map((label) => label.row), [0, 1]);
  assert.equal(stacked.rows, 2);

  // A skyline peak wins over a higher peak without a skyline.
  const priority = [
    { az: 0, sky: false, ele: 8000, d: 10, text: "HIGH" },
    { az: Math.PI, sky: true, ele: 100, d: 20, text: "SKY" },
  ];
  const ordered = placePeakTags(priority, measureText, PANO_FULL, plot);
  assert.deepEqual(ordered.placed.map((label) => label.text), ["SKY", "HIGH"]);

  // Azimuth 180 is outside a 90-degree window and gets no tag.
  const quarter = { start: 0, span: 90 };
  const outside = placePeakTags([{ az: Math.PI, sky: false, ele: 100, d: 1000, text: "OUT" }], measureText, quarter, plot);
  assert.deepEqual(outside, { placed: [], rows: 0 });

  // Tags stay inside the plot even at its edges.
  const edgePeaks = [
    { az: 0, sky: false, ele: 100, d: 1000, text: "LEFT" },
    { az: 2 * Math.PI - 0.001, sky: false, ele: 100, d: 1000, text: "RIGHT" },
  ];
  for (const label of placePeakTags(edgePeaks, measureText, PANO_FULL, plot).placed) {
    assert.ok(label.tagX0 >= plot.left, `${label.text} starts left of the plot`);
    assert.ok(label.tagX0 + label.tagWidth <= plot.left + plot.width, `${label.text} ends right of the plot`);
  }
});
