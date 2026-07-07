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

  return { parse, exportWithWarnings };
})();
