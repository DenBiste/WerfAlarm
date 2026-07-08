/* =========================================================
   gpx.js — GPX-bestanden inlezen
   ========================================================= */
"use strict";
const GPX = (() => {

  /* Leest een GPX-tekst en geeft {pts:[[lat,lon],...], name} terug.
     Valt terug op routepunten (rtept) en waypoints (wpt) als er geen track is. */
  function parse(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Geen geldig GPX/XML-bestand");

    let nodes = [...doc.getElementsByTagName("trkpt")];
    if (!nodes.length) nodes = [...doc.getElementsByTagName("rtept")];
    if (!nodes.length) nodes = [...doc.getElementsByTagName("wpt")];

    const pts = [], eles = [];
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute("lat")), lon = parseFloat(n.getAttribute("lon"));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      pts.push([lat, lon]);
      const el = n.getElementsByTagName("ele")[0];
      const ev = el ? parseFloat(el.textContent) : NaN;
      eles.push(isFinite(ev) ? ev : null);
    }
    if (pts.length < 2) throw new Error("Geen trackpunten gevonden in dit bestand");
    const hasEle = eles.filter(v => v != null).length > pts.length * 0.5;

    const nameEl = doc.querySelector("trk > name, metadata > name, rte > name, trk > n, metadata > n");
    return { pts, eles: hasEle ? eles : null, name: nameEl ? nameEl.textContent.trim() : "" };
  }

  const escXml = s => String(s).replace(/[<>&'"]/g,
    c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

  /* Voegt waarschuwings-waypoints toe aan de originele GPX-tekst.
     wpts: [{lat, lon, name, desc}]  →  nieuwe GPX-string.
     Waypoints horen vóór rte/trk; we voegen ze in na </metadata>
     of meteen na de openende <gpx>-tag. */
  function exportWithWarnings(raw, wpts) {
    const blocks = wpts.map(w =>
      `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n` +
      `    <name>${escXml(w.name)}</name>\n` +
      `    <desc>${escXml(w.desc)}</desc>\n` +
      `    <sym>Danger Area</sym>\n  </wpt>`).join("\n");
    if (/<\/metadata>/.test(raw)) return raw.replace(/<\/metadata>/, m => m + "\n" + blocks);
    return raw.replace(/<gpx\b[^>]*>/, m => m + "\n" + blocks);
  }

  /* Bouwt een volledig nieuwe GPX op uit routepunten (gebruikt nadat de route
     zelf gewijzigd is, bv. na het overnemen van een omleiding — de originele
     bestandstekst komt dan niet meer overeen met de route). */
  function buildGpx(pts, eles, name, wpts) {
    const wptBlocks = (wpts || []).map(w =>
      `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n` +
      `    <name>${escXml(w.name)}</name>\n` +
      `    <desc>${escXml(w.desc)}</desc>\n` +
      `    <sym>Danger Area</sym>\n  </wpt>`).join("\n");
    const trkpts = pts.map((p, i) => {
      const e = eles && eles[i] != null ? `<ele>${eles[i].toFixed(1)}</ele>` : "";
      return `   <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${e}</trkpt>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="RouteScout" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      (wptBlocks ? wptBlocks + "\n" : "") +
      `  <trk>\n    <name>${escXml(name)}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n</gpx>`;
  }

  return { parse, exportWithWarnings, buildGpx };
})();
