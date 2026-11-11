// Panorama azimuth window (zoom and pan along the compass axis). A window is
// { start, span }: start is the azimuth in degrees at the left edge, span the degrees shown.
// The full panorama is { start: 0, span: 360 }.
(() => {
  "use strict";

  const PANO_FULL = { start: 0, span: 360 };
  // Beyond four pixels per ray the plot only shows wider blocks: the ray is the data's
  // resolution.
  const PANO_MAX_PIXELS_PER_RAY = 4;

  const wrapDegrees = (degrees) => ((degrees % 360) + 360) % 360;

  // Fraction 0..1 across the plot for an azimuth in degrees (any real number), or null when
  // the azimuth is outside the window. At span 360 every azimuth is inside.
  function panoFraction(window, azimuthDegrees) {
    const offset = wrapDegrees(azimuthDegrees - window.start);
    if (window.span < 360 && offset >= window.span) return null;
    return offset / window.span;
  }

  // Azimuth in degrees, in [0, 360), at a plot fraction (0 = left edge, 1 = right edge).
  function panoAzimuth(window, fraction) {
    return wrapDegrees(window.start + fraction * window.span);
  }

  // New window after zooming by `factor` (> 1 = zoom in) while the azimuth under `fraction`
  // stays under it. span is clamped to [minSpan, 360]; start is wrapped to [0, 360). A result
  // with span 360 keeps its start (a rotated full panorama is allowed).
  function panoZoom(window, fraction, factor, minSpan) {
    const anchor = panoAzimuth(window, fraction);
    const span = Math.min(360, Math.max(minSpan, window.span / factor));
    return { start: wrapDegrees(anchor - fraction * span), span };
  }

  // New window shifted by a plot fraction (positive = content moves left, start grows).
  function panoPan(window, deltaFraction) {
    return { start: wrapDegrees(window.start + deltaFraction * window.span), span: window.span };
  }

  // Smallest useful span for `rays` rays on a plot `plotWidth` CSS px wide: one ray per
  // PANO_MAX_PIXELS_PER_RAY pixels, never above 360.
  function panoMinSpan(rays, plotWidth) {
    return Math.min(360, 360 * plotWidth / (PANO_MAX_PIXELS_PER_RAY * rays));
  }

  globalThis.PANO_FULL = PANO_FULL;
  globalThis.PANO_MAX_PIXELS_PER_RAY = PANO_MAX_PIXELS_PER_RAY;
  globalThis.panoFraction = panoFraction;
  globalThis.panoAzimuth = panoAzimuth;
  globalThis.panoZoom = panoZoom;
  globalThis.panoPan = panoPan;
  globalThis.panoMinSpan = panoMinSpan;
  if (typeof module === "object" && module && module.exports) {
    module.exports = {
      PANO_FULL,
      PANO_MAX_PIXELS_PER_RAY,
      panoFraction,
      panoAzimuth,
      panoZoom,
      panoPan,
      panoMinSpan,
    };
  }
})();
