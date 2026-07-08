/* =========================================================
   brouter.js — omleidingssuggesties via de publieke BRouter-dienst
   (brouter.de), een gratis, sleutelloze routeplanner op OSM-data.
   ========================================================= */
"use strict";
const Brouter = (() => {
  const ENDPOINT = "https://brouter.de/brouter";

  /* Onverhard wegdek: expliciet onverhard `surface=` óf een pad/track/
     ruiterpad zonder expliciete verharding (BRouter/OSM-conventie: zo'n
     weg is standaard onverhard tenzij anders getagd). */
  const UNPAVED_SURFACE = /surface=(unpaved|gravel|dirt|ground|grass|sand|compacted|fine_gravel|pebblestone|mud|earth|woodchips|grass_paver)\b/;
  const UNPAVED_HIGHWAY = /highway=(track|path|bridleway)\b/;
  const PAVED_SURFACE = /surface=(paved|asphalt|concrete|paving_stones|sett|cobblestone|metal|wood)\b/;

  /* Berekent een fietsroute tussen twee [lat,lon]-punten die de cirkel
     (nlat,nlon,radius in m) vermijdt. Geeft {pts, eles, lengthM} terug,
     of gooit een Error — ook wanneer een route wél gevonden werd maar
     over onverhard wegdek loopt (grind, aarde, een niet-verhard pad).
     Profiel "fastbike" i.p.v. "trekking" legt daarnaast al een fors
     hogere kostprijs op onverharde wegen, zodat BRouter zelf al een
     verharde weg verkiest zodra die bestaat. We vragen GeoJSON op i.p.v.
     GPX omdat BRouter daarbij per wegsegment de OSM-tags meestuurt
     (`WayTags`), zodat we het resultaat effectief kunnen controleren
     i.p.v. enkel op de kostprijs te vertrouwen. */
  async function route(fromPt, toPt, nlat, nlon, radius) {
    const lonlats = `${fromPt[1].toFixed(6)},${fromPt[0].toFixed(6)}|${toPt[1].toFixed(6)},${toPt[0].toFixed(6)}`;
    const nogos = `${nlon.toFixed(6)},${nlat.toFixed(6)},${Math.round(radius)}`;
    const url = `${ENDPOINT}?lonlats=${lonlats}&nogos=${nogos}&profile=fastbike&alternativeidx=0&format=geojson`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try { r = await fetch(url, { signal: ctrl.signal }); }
    catch (e) { throw new Error("brouter onbereikbaar"); }
    finally { clearTimeout(timer); }
    if (!r.ok) throw new Error("brouter " + r.status);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("geen route gevonden"); }
    const f = data && data.features && data.features[0];
    const coords = f && f.geometry && f.geometry.coordinates;
    if (!coords || coords.length < 2) throw new Error("geen route gevonden");

    const msgs = (f.properties && f.properties.messages) || [];
    for (let i = 1; i < msgs.length; i++) {   // rij 0 = kolomkoppen
      const tags = msgs[i][9] || "";
      const unpaved = UNPAVED_SURFACE.test(tags) || (UNPAVED_HIGHWAY.test(tags) && !PAVED_SURFACE.test(tags));
      if (unpaved) throw new Error("onverhard wegdek in omleiding");
    }

    const pts = coords.map(c => [c[1], c[0]]);
    const eles = coords.every(c => typeof c[2] === "number") ? coords.map(c => c[2]) : null;
    return { pts, eles, lengthM: Geom.pathLength(pts) };
  }

  return { route };
})();
