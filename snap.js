// Summit snap: picks the OSM peak a map placement should stand on.
(() => {
  "use strict";

  // A coarser snap would move the observer inside one terrain sample: MAX_PIXEL_METRES in
  // worker.js is the widest terrain pixel the view ever samples, so closer placements are
  // indistinguishable on the ground.
  const SNAP_MIN_METRES = 110;
  // The page's TOUCH_SLOP_PX: a press cannot be aimed finer than this many screen pixels,
  // so that much on-screen slop becomes the snap radius at the current zoom.
  const SNAP_SLOP_PIXELS = 10;
  // Beyond half a kilometre the observer would jump visibly on a zoomed-out map.
  const SNAP_MAX_METRES = 500;
  const RAD = Math.PI / 180;

  // Great-circle distance in metres; the longitude difference is wrapped to ±180°, so a
  // peak across the antimeridian is measured the short way.
  function greatCircleDistance(lat1, lon1, lat2, lon2, earthRadius) {
    const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
    const deltaPhi = phi2 - phi1;
    let deltaLon = (lon2 - lon1) * RAD;
    deltaLon -= 2 * Math.PI * Math.round(deltaLon / (2 * Math.PI));
    const a = Math.sin(deltaPhi / 2) ** 2
      + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLon / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // rows: peak rows [name, lat, lon, ele|null, nameEn?]. Returns the nearest row whose ele
  // is a finite number and whose great-circle distance to (lat, lon) is <= radiusMetres, as
  // { row, distance }, or null. earthRadius in metres.
  function nearestSummit(rows, lat, lon, radiusMetres, earthRadius) {
    let best = null;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const peakLat = row[1], peakLon = row[2], ele = row[3];
      if (!Number.isFinite(ele) || !Number.isFinite(peakLat) || !Number.isFinite(peakLon)) continue;
      const distance = greatCircleDistance(lat, lon, peakLat, peakLon, earthRadius);
      if (distance <= radiusMetres && (!best || distance < best.distance)) best = { row, distance };
    }
    return best;
  }

  // Snap radius in metres for a placement made at a map scale of metresPerCssPixel.
  function summitSnapRadius(metresPerCssPixel) {
    return Math.min(SNAP_MAX_METRES, Math.max(SNAP_MIN_METRES, SNAP_SLOP_PIXELS * metresPerCssPixel));
  }

  globalThis.nearestSummit = nearestSummit;
  globalThis.summitSnapRadius = summitSnapRadius;
  if (typeof module === "object" && module && module.exports) module.exports = { nearestSummit, summitSnapRadius };
})();
