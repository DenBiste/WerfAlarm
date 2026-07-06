/* =========================================================
   app.js — UI, kaart en het controleproces
   Vereist: geometry.js, gpx.js, gipod.js, Leaflet
   ========================================================= */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------------- state ---------------- */
  let route = null;       // gebouwd door Geom.buildRoute()
  let lastReport = "";

  /* ---------------- kaart ---------------- */
  const map = L.map("map", { scrollWheelZoom: true }).setView([50.95, 4.9], 9);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
  let routeLayer = null, startMarker = null, markers = [];

  function drawRoute() {
    if (routeLayer) map.removeLayer(routeLayer);
    if (startMarker) map.removeLayer(startMarker);
    clearMarkers();
    routeLayer = L.polyline(route.pts, { color: "#2F5AA8", weight: 4, opacity: .9 }).addTo(map);
    startMarker = L.circleMarker(route.pts[0], { radius: 6, color: "#2B8A3E", fillColor: "#2B8A3E", fillOpacity: 1 })
      .addTo(map).bindTooltip("Start");
    map.fitBounds(routeLayer.getBounds().pad(0.05));
  }
  function clearMarkers() { markers.forEach(m => map.removeLayer(m)); markers = []; }

  /* ---------------- GPX laden ---------------- */
  async function loadFile(file) {
    try {
      const { pts, name } = GPX.parse(await file.text());
      route = Geom.buildRoute(pts, name || file.name.replace(/\.gpx$/i, ""));
      drawRoute();
      $("routeinfo").innerHTML = `<b>${esc(route.name)}</b> · ${route.km.toFixed(1)} km · ${route.tiles.length} zones`;
      $("footroute").textContent = `Route: ${route.name}, ${route.km.toFixed(1)} km, ${pts.length} punten`;
      $("run").disabled = false; $("copy").disabled = true;
      $("status").textContent = "Klaar om te controleren.";
      $("error").style.display = "none";
      $("out").innerHTML = `<div id="empty" class="empty"><span class="empty-icon">✅</span>Route geladen. Kies je ritdatum en klik op <b>Controleer route</b>.</div>`;
      document.getElementById("app").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      $("error").style.display = "block";
      $("error").textContent = "GPX kon niet gelezen worden: " + err.message;
    }
  }

  $("gpxfile").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  $("ctaLoad").addEventListener("click", () => $("gpxfile").click());

  /* slepen & neerzetten op de kaart */
  const mapEl = $("map");
  ["dragover", "dragenter"].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); mapEl.classList.add("dropping");
  }));
  ["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); mapEl.classList.remove("dropping");
  }));
  document.addEventListener("drop", e => {
    const f = [...(e.dataTransfer?.files || [])].find(f => /\.gpx$/i.test(f.name));
    if (f) loadFile(f);
  });

  /* ---------------- controle uitvoeren ---------------- */
  $("ridedate").valueAsDate = new Date();
  $("run").addEventListener("click", run);
  $("copy").addEventListener("click", () => {
    navigator.clipboard.writeText(lastReport);
    $("copy").textContent = "Gekopieerd ✓";
    setTimeout(() => $("copy").textContent = "Kopieer resultaat", 1500);
  });

  async function run() {
    $("run").disabled = true; $("copy").disabled = true; $("error").style.display = "none";
    clearMarkers();

    const rideDate = new Date($("ridedate").value || Date.now()); rideDate.setHours(12);
    const v = parseInt($("range").value, 10);
    const range = isNaN(v) ? 100 : Math.max(0, Math.min(250, v));
    $("range").value = range;
    const thresh = range === 0 ? 5 : range;   // bij 0 m: 5 m tolerantie voor gps-/tekenruis
    Geom.expandGrid(route, 1 + Math.ceil(thresh / 250));

    const seen = new Map();
    const setP = (d, t) => {
      $("bar").firstElementChild.style.width = (100 * d / t) + "%";
      $("status").textContent = `Bevraagt GIPOD… ${d}/${t}`;
    };
    setP(0, 1);

    let truncated;
    try {
      ({ truncated } = await GIPOD.query(route.tiles, (f, col) => {
        const res = Geom.analyzeGeom(route, f.geometry, thresh);
        if (!res || res[0] > thresh) return;
        const s = GIPOD.summarize(f.properties || {}, col);
        const key = col + "|" + (s.id || s.desc + s.start);
        const rec = seen.get(key);
        if (!rec || res[0] < rec.dist) {
          const [lon, lat] = firstCoord(f.geometry);
          seen.set(key, { ...s, dist: Math.round(res[0]), km: res[1] / 1000, lat, lon, geom: f.geometry });
        }
      }, setP));
    } catch (e) {
      $("error").style.display = "block";
      $("error").innerHTML = `<b>Kon de GIPOD-dienst niet bevragen.</b> (${esc(e.message)})<br>` +
        `Controleer je internetverbinding of raadpleeg handmatig ` +
        `<a href="https://www.geopunt.be/hinder-in-kaart" target="_blank" rel="noopener">geopunt.be/hinder-in-kaart</a>.`;
      $("run").disabled = false; $("status").textContent = "Mislukt.";
      return;
    }

    /* enkel hinder die actief is op de gekozen ritdatum */
    const active = [];
    for (const r of seen.values()) {
      const st = r.start ? new Date(r.start) : null, en = r.end ? new Date(r.end) : null;
      if (en && en < rideDate) continue;
      if (st && st > rideDate) continue;
      active.push(r);
    }
    const list = dedupe(active);
    render(list, rideDate, truncated, range);
    $("run").disabled = false; $("copy").disabled = false;
    $("status").textContent = `Klaar — ${list.length} hinder(s) actief op ${rideDate.toLocaleDateString("nl-BE")}.`;
    $("bar").firstElementChild.style.width = "100%";
  }

  function firstCoord(g) { let c = g.coordinates; while (typeof c[0] !== "number") c = c[0]; return c; }

  /* HINDER- en INNAME-object over dezelfde werf samenvoegen */
  function dedupe(list) {
    list.sort((a, b) => a.km - b.km || (a.collection === "HINDER" ? -1 : 1));
    const out = [];
    const sameDates = (a, b) =>
      String(a.start).slice(0, 10) === String(b.start).slice(0, 10) ||
      String(a.end).slice(0, 10) === String(b.end).slice(0, 10);
    for (const r of list) {
      const dup = out.find(o => Math.abs(o.km - r.km) < 0.15 && o.collection !== r.collection && sameDates(o, r));
      if (dup) { if (!dup.cons && r.cons) dup.cons = r.cons; continue; }
      out.push(r);
    }
    return out;
  }

  /* ---------------- resultaten tonen ---------------- */
  function render(active, rideDate, truncated, range) {
    const out = $("out"); out.innerHTML = "";
    const scope = range === 0 ? "op je track zelf" : `binnen ${range} m van je route`;
    const dateStr = rideDate.toLocaleDateString("nl-BE");

    const mk = r => {
      const el = document.createElement("div"); el.className = "card";
      const consTxt = r.cons ? String(r.cons).replace(/[;|]/g, " · ") : "";
      const hard = /afgesloten|closed|onderbroken|geen doorgang|fiets/i.test(consTxt);
      el.innerHTML =
        `<div class="km"><b>KM</b><span>${r.km.toFixed(1)}</span></div>
         <div class="body"><h3>${esc(r.desc)}</h3>
         <div class="meta">${r.cat ? `<b>${esc(r.cat)}</b> · ` : ""}${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}` +
        `${r.owner ? ` · ${esc(r.owner)}` : ""}${r.dist > 10 ? ` · ${r.dist} m van je track` : " · op je track"}</div>
         ${consTxt ? `<div class="cons">${hard ? "<em>" : ""}${esc(consTxt)}${hard ? "</em>" : ""}</div>` : ""}
         <span class="chip">Actief op ${dateStr}</span></div>`;

      const popup = `<b>km ${r.km.toFixed(1)} — ${esc(r.desc)}</b><br>${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}<br>${esc(consTxt)}`;
      /* de getroffen zone zelf, zoals op geopunt.be/hinder-in-kaart */
      const zone = L.geoJSON(r.geom, {
        style: { color: "#D9480F", weight: 3, opacity: .9, fillColor: "#E8590C", fillOpacity: .35 },
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 2, fillColor: "#D9480F", fillOpacity: .95 })
      }).addTo(map).bindPopup(popup);
      const b0 = zone.getBounds(), ctr = b0.isValid() ? b0.getCenter() : L.latLng(r.lat, r.lon);
      const dot = L.circleMarker(ctr, { radius: 5, color: "#fff", weight: 1.5, fillColor: "#D9480F", fillOpacity: .95 })
        .addTo(map).bindPopup(popup);
      markers.push(zone, dot);

      el.addEventListener("click", () => {
        const b = zone.getBounds();
        if (b.isValid() && b.getNorthEast().distanceTo(b.getSouthWest()) > 40) map.fitBounds(b.pad(0.6));
        else map.setView(ctr, 16);
        zone.openPopup(ctr);
      });
      return el;
    };

    if (!active.length) {
      out.innerHTML = `<div class="empty"><span class="empty-icon">🎉</span><strong>Vrije baan!</strong><br>Geen hinder gevonden ${scope} op ${dateStr}. Goede rit!</div>`;
    } else {
      const h = document.createElement("h2");
      h.textContent = `Hinder ${scope} op ${dateStr} (${active.length})`;
      out.appendChild(h);
      active.forEach(r => out.appendChild(mk(r)));
    }
    if (truncated) {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = "⚠ Minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig.";
      out.appendChild(p);
    }

    lastReport =
      `Hindercheck ${route.name} (${route.km.toFixed(1)} km) — ritdatum ${dateStr}\n` +
      `Bron: GIPOD open data (geo.api.vlaanderen.be), zoekafstand ${range === 0 ? "0 m (enkel op de route zelf)" : "±" + range + " m"}\n\n` +
      `ACTIEF OP RITDATUM (${active.length}):\n` +
      active.map(r => `- km ${r.km.toFixed(1)} | ${r.desc} | ${GIPOD.fmtDate(r.start)}→${GIPOD.fmtDate(r.end)} | ${r.cons || "gevolgen onbekend"} | ${r.dist} m van track | ${r.lat.toFixed(5)},${r.lon.toFixed(5)}`).join("\n");
  }
})();
