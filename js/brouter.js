/* =========================================================
   brouter.js — omleidingssuggesties via de publieke BRouter-dienst
   (brouter.de), een gratis, sleutelloze routeplanner op OSM-data.
   ========================================================= */
"use strict";
const Brouter = (() => {
  const ENDPOINT = "https://brouter.de/brouter";

  /* Berekent een fietsroute tussen twee [lat,lon]-punten die de cirkel
     (nlat,nlon,radius in m) vermijdt. Geeft {pts, eles, lengthM} terug,
     of gooit een Error als er geen route gevonden werd. */
  async function route(fromPt, toPt, nlat, nlon, radius) {
    const lonlats = `${fromPt[1].toFixed(6)},${fromPt[0].toFixed(6)}|${toPt[1].toFixed(6)},${toPt[0].toFixed(6)}`;
    const nogos = `${nlon.toFixed(6)},${nlat.toFixed(6)},${Math.round(radius)}`;
    const url = `${ENDPOINT}?lonlats=${lonlats}&nogos=${nogos}&profile=trekking&alternativeidx=0&format=gpx`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try { r = await fetch(url, { signal: ctrl.signal }); }
    catch (e) { throw new Error("brouter onbereikbaar"); }
    finally { clearTimeout(timer); }
    if (!r.ok) throw new Error("brouter " + r.status);
    const text = await r.text();
    if (/<error|<Error/.test(text) || !/<trkpt/i.test(text)) throw new Error("geen route gevonden");
    const { pts, eles } = GPX.parse(text);
    if (pts.length < 2) throw new Error("geen route gevonden");
    return { pts, eles, lengthM: Geom.pathLength(pts) };
  }

  return { route };
})();
