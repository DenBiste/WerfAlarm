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
  let rawGpx = "";        // originele bestandsinhoud, voor export met waypoints
  let lastResults = [];   // laatste gevonden hinder
  let view = null;        // {list, rideDate, truncated, range, filterHard, sortBy}

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
      const text = await file.text();
      const { pts, name } = GPX.parse(text);
      rawGpx = text;
      GIPOD.clearCache();                 // nieuwe route = verse data
      lastResults = [];
      route = Geom.buildRoute(pts, name || file.name.replace(/\.gpx$/i, ""));
      drawRoute();
      $("strip").hidden = true;
      $("dlgpx").disabled = true;
      $("report").disabled = true;
      $("routeinfo").innerHTML = `<b>${esc(route.name)}</b> · ${route.km.toFixed(1)} km · ${route.tiles.length} zones`;
      $("footroute").textContent = `Route: ${route.name}, ${route.km.toFixed(1)} km, ${pts.length} punten`;
      $("run").disabled = false;
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
  async function run() {
    $("run").disabled = true;
    $("dlgpx").disabled = true; $("report").disabled = true;
    $("error").style.display = "none";
    clearMarkers();

    const rideDate = new Date($("ridedate").value || Date.now()); rideDate.setHours(12);
    const onlyHard = $("onlyhard").checked;
    const modes = getModes();
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

    let truncated, fromCache;
    try {
      ({ truncated, fromCache } = await GIPOD.query(route.tiles, (f, col) => {
        const s = GIPOD.summarize(f.properties || {}, col);
        if (!relevantFor(s, modes)) return;   // filter tijdens de berekening: andere weggebruikers overslaan
        if (onlyHard && !isHardFor(s, modes)) return;  // enkel blokkades voor deze weggebruikers
        const res = Geom.analyzeGeom(route, f.geometry, thresh);
        if (!res) return;
        const key = col + "|" + (s.id || s.desc + s.start);
        const kms = res.kms.map(m => m / 1000);
        const rec = seen.get(key);
        if (!rec) {
          const [lon, lat] = firstCoord(f.geometry);
          seen.set(key, { ...s, dist: Math.round(res.dist), kms, km: kms[0], lat, lon, geom: f.geometry });
        } else {
          rec.kms = mergeKms(rec.kms, kms);
          rec.km = rec.kms[0];
          if (res.dist < rec.dist) rec.dist = Math.round(res.dist);
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
    const list = dedupe(active)
      .filter(r => relevantFor(r, modes))
      .filter(r => !onlyHard || isHardFor(r, modes));
    lastResults = list;
    view = { list, rideDate, truncated, range, onlyHard, modes, filterHard: false, sortBy: "km" };
    refresh();
    $("run").disabled = false;
    $("dlgpx").disabled = !list.length;
    $("report").disabled = false;
    const cacheNote = fromCache === route.tiles.length * 2 ? " · uit cache" : "";
    const forWho = modes.size === 3 ? "" : ` voor ${modesLabel(modes)}`;
    $("status").textContent = `Klaar — ${list.length} ${onlyHard ? "blokkade(s)" : "hinder(s)"}${forWho} actief op ${rideDate.toLocaleDateString("nl-BE")}.${cacheNote}`;
    $("bar").firstElementChild.style.width = "100%";
  }

  function firstCoord(g) { let c = g.coordinates; while (typeof c[0] !== "number") c = c[0]; return c; }

  /* km-lijsten samenvoegen: passages die <200 m uit elkaar liggen zijn dezelfde */
  function mergeKms(a, b) {
    const all = [...a, ...b].sort((x, y) => x - y);
    const out = [];
    for (const k of all) if (!out.length || k - out[out.length - 1] > 0.2) out.push(k);
    return out;
  }

  /* Dezelfde werf één keer tonen, met alle km-punten samengevoegd:
     1) identieke omschrijving + periode (bv. HINDER- én INNAME-record, of
        meerdere hinderregels van dezelfde werf) → samenvoegen;
     2) verschillend record maar zelfde plek (<150 m) + overlappende periode,
        uit de andere collectie → samenvoegen (oude regel). */
  function dedupe(list) {
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const d10 = v => String(v).slice(0, 10);
    const bySig = new Map();
    const merged = [];
    list.sort((a, b) => a.km - b.km || (a.collection === "HINDER" ? -1 : 1));
    for (const r of list) {
      const sig = norm(r.desc) + "|" + d10(r.start) + "|" + d10(r.end);
      let target = bySig.get(sig);
      if (!target) {
        target = merged.find(o => o.collection !== r.collection &&
          o.kms.some(ok => r.kms.some(rk => Math.abs(ok - rk) < 0.15)) &&
          (d10(o.start) === d10(r.start) || d10(o.end) === d10(r.end)));
      }
      if (target) {
        target.kms = mergeKms(target.kms, r.kms);
        target.km = target.kms[0];
        if (!target.cons && r.cons) target.cons = r.cons;
        if (r.dist < target.dist) target.dist = r.dist;
        continue;
      }
      bySig.set(sig, r);
      merged.push(r);
    }
    merged.sort((a, b) => a.km - b.km);
    return merged;
  }

  const cardFocus = [];

  /* ---------------- routestrook: 0 → einde met een tik per werf ---------------- */
  function renderStrip(list) {
    const strip = $("strip");
    strip.innerHTML = `<div class="strip-line"></div>
      <div class="strip-start" style="left:26px" title="Start"></div>
      <div class="strip-end" style="left:calc(100% - 26px)" title="Aankomst"></div>
      <span class="strip-label" style="left:26px">0</span>
      <span class="strip-label" style="left:calc(100% - 26px)">${route.km.toFixed(0)} km</span>`;
    list.forEach((r, i) => {
      r.kms.forEach(km => {
        const pct = Math.max(0, Math.min(1, km / route.km));
        const tick = document.createElement("button");
        tick.className = "strip-tick" + (isHardFor(r, view.modes) ? " hard" : "");
        tick.style.left = `calc(26px + (100% - 52px) * ${pct.toFixed(4)})`;
        tick.title = `km ${km.toFixed(1)} — ${r.desc}` +
          (r.kms.length > 1 ? ` (passage ${r.kms.indexOf(km) + 1}/${r.kms.length})` : "") +
          (isHardFor(r, view.modes) ? " (blokkade)" : "");
        tick.setAttribute("aria-label", `Werf op kilometer ${km.toFixed(1)}: ${r.desc}`);
        tick.innerHTML = "<span></span>";
        tick.addEventListener("click", () => cardFocus[i] && cardFocus[i](true));
        strip.appendChild(tick);
      });
    });
    strip.hidden = false;
  }

  /* ---------------- GPX-export met waarschuwings-waypoints ---------------- */
  $("dlgpx").addEventListener("click", () => {
    if (!route || !rawGpx || !lastResults.length) return;
    const wpts = lastResults.flatMap(r =>
      r.kms.map((km, i) => {
        const [lat, lon] = Geom.pointAtChain(route, km * 1000); // op jóuw track, waar je passeert
        return {
          lat, lon,
          name: `WERF km ${km.toFixed(1)}` + (r.kms.length > 1 ? ` (${i + 1}/${r.kms.length})` : ""),
          desc: `${r.desc} | ${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}` +
                (r.cons ? ` | ${String(r.cons).replace(/[;|]/g, " · ")}` : "")
        };
      }));
    const out = GPX.exportWithWarnings(rawGpx, wpts);
    const blob = new Blob([out], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = route.name.replace(/[^\w\- ]+/g, "").trim().replace(/ +/g, "-") + "-werfalarm.gpx";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  /* ---------------- ernst & weggebruiker ---------------- */
  const MODES = { all: "alle weggebruikers", bike: "fietsers", ped: "voetgangers", motor: "gemotoriseerd verkeer" };
  const HARD_RE = /afgesloten|afsluiting|closed|onderbroken|geen doorgang|versperd|omleiding/i;
  const consText = r => r.cons ? String(r.cons).replace(/[;|]/g, " · ") : "";
  const consItems = r => String(r.cons || "").split(/[;|·,]/).map(s => s.trim()).filter(Boolean);

  /* Op welke weggebruikers slaat één gevolg-omschrijving?
     Geen groep genoemd = generiek gevolg (bv. "weg afgesloten") = iedereen. */
  function itemModes(txt) {
    const s = txt.toLowerCase(), m = new Set();
    if (/voetganger|voetpad|zebrapad|oversteekplaats/.test(s)) m.add("ped");
    if (/fiets/.test(s)) m.add("bike");
    if (/gemotoriseerd|autoverkeer|beurtelings|rijbaan|rijstro|parkeer|vrachtverkeer|doorgaand verkeer/.test(s)) m.add("motor");
    return m.size ? m : new Set(["ped", "bike", "motor"]);
  }

  /* Is deze hinder relevant voor (minstens één van) de gekozen weggebruikers? */
  function relevantFor(r, modes) {
    if (modes.size === 3) return true;
    const items = consItems(r);
    if (!items.length) return true;              // gevolgen onbekend: niet uitsluiten
    return items.some(it => [...itemModes(it)].some(m => modes.has(m)));
  }

  /* Is dit een blokkade voor (minstens één van) de gekozen weggebruikers?
     Een generieke afsluiting telt voor iedereen; "omleiding voor voetgangers"
     telt niet als blokkade voor fietsers of auto's. */
  function isHardFor(r, modes) {
    if (HARD_RE.test(String(r.desc || ""))) return true;   // omschrijving is altijd generiek
    return consItems(r).some(it => HARD_RE.test(it) &&
      (modes.size === 3 || [...itemModes(it)].some(m => modes.has(m))));
  }

  const modesLabel = modes => modes.size === 3
    ? "alle weggebruikers"
    : ["bike", "ped", "motor"].filter(m => modes.has(m)).map(m => MODES[m]).join(" + ");

  /* ---------------- weggebruiker-knoppen (multi-select) ---------------- */
  const modeBtns = [...document.querySelectorAll('#mode [data-m]')];
  const getModes = () => new Set(modeBtns.filter(b => b.dataset.m !== "all" && b.getAttribute("aria-pressed") === "true").map(b => b.dataset.m));
  function syncAllBtn() {
    const allBtn = modeBtns.find(b => b.dataset.m === "all");
    allBtn.setAttribute("aria-pressed", getModes().size === 3);
  }
  modeBtns.forEach(b => b.addEventListener("click", () => {
    if (b.dataset.m === "all") {
      modeBtns.forEach(x => x.setAttribute("aria-pressed", "true"));
      return;
    }
    const on = b.getAttribute("aria-pressed") === "true";
    if (on && getModes().size === 1) return;     // minstens één weggebruiker blijft actief
    b.setAttribute("aria-pressed", String(!on));
    syncAllBtn();
  }));

  /* Past filter & sortering toe en tekent lijst + strook opnieuw (zonder netwerk) */
  function refresh() {
    if (!view) return;
    let shown = view.list.slice();
    if (view.filterHard) shown = shown.filter(r => isHardFor(r, view.modes));
    if (view.sortBy === "sev") shown.sort((a, b) => (isHardFor(b, view.modes) - isHardFor(a, view.modes)) || (a.km - b.km));
    else shown.sort((a, b) => a.km - b.km);
    renderList(shown);
    renderStrip(shown);
  }

  function segRow() {
    const row = document.createElement("div"); row.className = "seg-row";
    const filterSeg = view.onlyHard
      ? `<span class="hardtag" style="margin:0;align-self:center">⛔ Berekend: enkel blokkades</span>`
      : `<div class="seg" role="group" aria-label="Filter">
           <button class="seg-btn" data-f="all" aria-pressed="${!view.filterHard}">Alles (${view.list.length})</button>
           <button class="seg-btn" data-f="hard" aria-pressed="${view.filterHard}">⛔ Blokkades (${view.list.filter(r => isHardFor(r, view.modes)).length})</button>
         </div>`;
    row.innerHTML = filterSeg +
      `<div class="seg" role="group" aria-label="Sortering">
         <button class="seg-btn" data-s="km" aria-pressed="${view.sortBy === "km"}">Op km</button>
         <button class="seg-btn" data-s="sev" aria-pressed="${view.sortBy === "sev"}">Op ernst</button>
       </div>`;
    row.querySelectorAll("[data-f]").forEach(b =>
      b.addEventListener("click", () => { view.filterHard = b.dataset.f === "hard"; refresh(); }));
    row.querySelectorAll("[data-s]").forEach(b =>
      b.addEventListener("click", () => { view.sortBy = b.dataset.s; refresh(); }));
    return row;
  }

  function renderList(shown) {
    const out = $("out"); out.innerHTML = "";
    cardFocus.length = 0;
    clearMarkers();
    const { rideDate, truncated, range } = view;
    const scope = range === 0 ? "op je track zelf" : `binnen ${range} m van je route`;
    const dateStr = rideDate.toLocaleDateString("nl-BE");

    const mk = r => {
      const hard = isHardFor(r, view.modes);
      const multi = r.kms.length > 1;
      const kmList = r.kms.map(k => k.toFixed(1)).join(" · ");
      const el = document.createElement("div"); el.className = "card" + (hard ? " hard" : "");
      const consTxt = consText(r);
      el.innerHTML =
        `<div class="km"><b>${multi ? r.kms.length + "× KM" : "KM"}</b><span>${r.km.toFixed(1)}</span></div>
         <div class="body"><h3>${esc(r.desc)}</h3>
         <div class="meta">${r.cat ? `<b>${esc(r.cat)}</b> · ` : ""}${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}` +
        `${r.owner ? ` · ${esc(r.owner)}` : ""}${r.dist > 10 ? ` · ${r.dist} m van je track` : " · op je track"}` +
        `${multi ? `<br><b>Je passeert hier ${r.kms.length}×:</b> km ${kmList}` : ""}</div>
         ${consTxt ? `<div class="cons">${hard ? "<em>" : ""}${esc(consTxt)}${hard ? "</em>" : ""}</div>` : ""}
         <span class="chip">Actief op ${dateStr}</span>${hard ? `<span class="hardtag">⛔ Blokkade</span>` : ""}</div>`;

      const popup = `<b>km ${kmList} — ${esc(r.desc)}</b><br>${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}<br>${esc(consTxt)}`;
      /* de getroffen zone zelf, zoals op geopunt.be/hinder-in-kaart */
      const zone = L.geoJSON(r.geom, {
        style: { color: hard ? "#A61E04" : "#D9480F", weight: 3, opacity: .9, fillColor: "#E8590C", fillOpacity: .35 },
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 2, fillColor: "#D9480F", fillOpacity: .95 })
      }).addTo(map).bindPopup(popup);
      const b0 = zone.getBounds(), ctr = b0.isValid() ? b0.getCenter() : L.latLng(r.lat, r.lon);
      const dot = L.circleMarker(ctr, { radius: 5, color: "#fff", weight: 1.5, fillColor: hard ? "#A61E04" : "#D9480F", fillOpacity: .95 })
        .addTo(map).bindPopup(popup);
      markers.push(zone, dot);

      const focus = (fromStrip) => {
        const b = zone.getBounds();
        if (b.isValid() && b.getNorthEast().distanceTo(b.getSouthWest()) > 40) map.fitBounds(b.pad(0.6));
        else map.setView(ctr, 16);
        zone.openPopup(ctr);
        if (fromStrip) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
          el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
        }
      };
      el.addEventListener("click", () => focus(false));
      cardFocus.push(focus);
      return el;
    };

    const forWho = view.modes.size === 3 ? "" : ` voor ${modesLabel(view.modes)}`;
    if (!view.list.length) {
      out.innerHTML = view.onlyHard
        ? `<div class="empty"><span class="empty-icon">🎉</span><strong>Geen blokkades${forWho}!</strong><br>Geen afsluitingen of omleidingen gevonden ${scope} op ${dateStr}. Lichtere hinder werd niet berekend — vink de filter uit voor het volledige beeld.</div>`
        : `<div class="empty"><span class="empty-icon">🎉</span><strong>Vrije baan${forWho ? " " + forWho.trim() : ""}!</strong><br>Geen hinder${forWho} gevonden ${scope} op ${dateStr}. Goede rit!</div>`;
    } else {
      out.appendChild(segRow());
      const h = document.createElement("h2");
      h.textContent = (view.onlyHard || view.filterHard)
        ? `Blokkades${forWho} ${scope} op ${dateStr} (${shown.length})`
        : `Hinder${forWho} ${scope} op ${dateStr} (${shown.length})`;
      out.appendChild(h);
      if (!shown.length) {
        out.insertAdjacentHTML("beforeend",
          `<div class="empty"><span class="empty-icon">👍</span><strong>Geen blokkades</strong><br>Wel ${view.list.length} lichtere hinder(s) — schakel terug naar “Alles” om ze te bekijken.</div>`);
      } else shown.forEach(r => out.appendChild(mk(r)));
    }
    if (truncated) {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = "⚠ Minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig.";
      out.appendChild(p);
    }
  }


  /* ---------------- deelbaar HTML-rapport ---------------- */
  function buildReportHtml() {
    const { list, rideDate, range, truncated } = view;
    const dateStr = rideDate.toLocaleDateString("nl-BE");
    const now = new Date().toLocaleString("nl-BE");
    const scope = range === 0 ? "0 m (enkel op de route zelf)" : "±" + range + " m";

    /* schematisch kaartje van de route als SVG (zelfstandig, geen tegels nodig) */
    const P = route.pts;
    const lats = P.map(p => p[0]), lons = P.map(p => p[1]);
    const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
    const Wm = 760, Hm = 440, pad = 30, ky = (Hm - 2 * pad) / Math.max(la1 - la0, 1e-9);
    const kx = (Wm - 2 * pad) / Math.max(lo1 - lo0, 1e-9);
    const k = Math.min(kx, ky);
    const X = lon => pad + (lon - lo0) * k + (Wm - 2 * pad - (lo1 - lo0) * k) / 2;
    const Y = lat => Hm - pad - (lat - la0) * k - (Hm - 2 * pad - (la1 - la0) * k) / 2;
    const path = P.map((p, i) => (i ? "L" : "M") + X(p[1]).toFixed(1) + " " + Y(p[0]).toFixed(1)).join("");
    const zoneMarks = list.flatMap(r => r.kms.map(km => {
      const [lat, lon] = Geom.pointAtChain(route, km * 1000);
      const c = isHardFor(r, view.modes) ? "#A61E04" : "#E8590C";
      return `<circle cx="${X(lon).toFixed(1)}" cy="${Y(lat).toFixed(1)}" r="9" fill="${c}" stroke="#fff" stroke-width="2.5"/>` +
             `<text x="${X(lon).toFixed(1)}" y="${(Y(lat) - 14).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="bold" fill="#141619">km ${km.toFixed(1)}</text>`;
    })).join("");
    const mapSvg = `<svg viewBox="0 0 ${Wm} ${Hm}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schema van de route met werven">
      <rect width="${Wm}" height="${Hm}" fill="#EDECE5"/>
      <path d="${path}" fill="none" stroke="#2F5AA8" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="${X(P[0][1]).toFixed(1)}" cy="${Y(P[0][0]).toFixed(1)}" r="7" fill="#2B8A3E" stroke="#fff" stroke-width="2.5"/>
      ${zoneMarks}</svg>`;

    /* routestrook als SVG */
    const stripTicks = list.flatMap(r => r.kms.map(km => {
      const x = 30 + 700 * Math.min(1, km / route.km);
      return `<rect x="${(x - 7).toFixed(1)}" y="13" width="14" height="14" transform="rotate(45 ${x.toFixed(1)} 20)" fill="${isHardFor(r, view.modes) ? "#A61E04" : "#F4590B"}" stroke="#141619" stroke-width="2"/>`;
    })).join("");
    const stripSvg = `<svg viewBox="0 0 760 44" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Werven per kilometerpunt">
      <line x1="30" y1="20" x2="730" y2="20" stroke="#141619" stroke-width="4"/>
      <circle cx="30" cy="20" r="7" fill="#2B8A3E" stroke="#141619" stroke-width="2"/>
      <rect x="723" y="13" width="14" height="14" fill="#141619"/>${stripTicks}
      <text x="30" y="40" font-size="11" font-weight="bold" fill="#565E68">0</text>
      <text x="730" y="40" font-size="11" font-weight="bold" fill="#565E68" text-anchor="end">${route.km.toFixed(0)} km</text></svg>`;

    const rows = list.map(r => `
      <div class="c${isHardFor(r, view.modes) ? " hard" : ""}">
        <div class="ckm">${r.kms.length > 1 ? r.kms.length + "× KM" : "KM"}<br><b>${r.km.toFixed(1)}</b></div>
        <div><h3>${esc(r.desc)}${isHardFor(r, view.modes) ? ' <span class="tag">⛔ Blokkade</span>' : ""}</h3>
        <p>${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}${r.owner ? " · " + esc(r.owner) : ""} · ${r.dist > 10 ? r.dist + " m van de track" : "op de track"}</p>
        ${r.kms.length > 1 ? `<p><b>Passages:</b> km ${r.kms.map(k => k.toFixed(1)).join(" · ")}</p>` : ""}
        ${consText(r) ? `<p class="cons">${esc(consText(r))}</p>` : ""}
        <p class="lnk"><a href="https://www.google.com/maps?q=${r.lat.toFixed(5)},${r.lon.toFixed(5)}">Bekijk op kaart</a></p></div>
      </div>`).join("");

    return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WerfAlarm-rapport — ${esc(route.name)}</title>
<style>
 body{font-family:system-ui,sans-serif;background:#F4F2EC;color:#141619;max-width:820px;margin:0 auto;padding:24px;line-height:1.5}
 .stripes{height:12px;background:repeating-linear-gradient(-45deg,#F4590B 0 16px,#fff 16px 32px);border:2px solid #141619;border-radius:6px}
 h1{font-size:26px;margin:16px 0 2px}h1 span{color:#F4590B}
 .sub{color:#565E68;font-size:14px;margin:0 0 18px}
 .box{background:#fff;border:2px solid #141619;border-radius:12px;box-shadow:5px 5px 0 #141619;overflow:hidden;margin-bottom:18px}
 .box svg{display:block;width:100%;height:auto}
 .c{display:flex;gap:14px;background:#fff;border:2px solid #141619;border-left:8px solid #D9480F;border-radius:12px;box-shadow:4px 4px 0 #141619;padding:12px 14px;margin-bottom:14px}
 .c.hard{border-left-color:#A61E04}
 .ckm{border:2px solid #141619;border-radius:8px;padding:4px 10px;text-align:center;font-size:10px;font-weight:700;align-self:flex-start}
 .ckm b{font-size:17px}
 h3{margin:0 0 4px;font-size:16px}
 .tag{font-size:11px;background:#A61E04;color:#fff;border-radius:99px;padding:2px 9px;vertical-align:2px}
 p{margin:0 0 4px;font-size:13.5px;color:#565E68}
 .cons{color:#A61E04;font-weight:600}
 .lnk a{color:#2F5AA8;font-size:12.5px}
 .ok{background:#fff;border:2px dashed #141619;border-radius:12px;padding:26px;text-align:center;font-size:16px}
 footer{font-size:12px;color:#565E68;margin-top:22px}
</style></head><body>
<div class="stripes"></div>
<h1>WERF<span>ALARM</span> — rapport</h1>
<p class="sub"><b>${esc(route.name)}</b> · ${route.km.toFixed(1)} km · ritdatum <b>${dateStr}</b> · zoekafstand ${scope}${view.modes.size !== 3 ? ` · <b>weggebruikers: ${modesLabel(view.modes)}</b>` : ""}${view.onlyHard ? " · <b>filter: enkel blokkades ⛔</b>" : ""} · gemaakt op ${now}</p>
<div class="box">${mapSvg}</div>
<div class="box">${stripSvg}</div>
${list.length ? rows : `<div class="ok">🎉 <b>${view.onlyHard ? "Geen blokkades!" : "Vrije baan!"}</b> ${view.onlyHard ? "Geen afsluitingen of omleidingen op deze route op " + dateStr + " (lichtere hinder niet berekend)." : "Geen hinder gevonden op deze route op " + dateStr + "."}</div>`}
${truncated ? `<p class="sub">⚠ Minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig.</p>` : ""}
<footer>Bron: GIPOD open data (geo.api.vlaanderen.be), dezelfde bron als geopunt.be/hinder-in-kaart — enkel Vlaanderen.
Gegenereerd met WerfAlarm; de situatie kan wijzigen, controleer kort voor vertrek opnieuw.</footer>
</body></html>`;
  }

  $("report").addEventListener("click", () => {
    if (!view) return;
    const blob = new Blob([buildReportHtml()], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const slug = route.name.replace(/[^\w\- ]+/g, "").trim().replace(/ +/g, "-").toLowerCase();
    a.download = `werfalarm-rapport-${slug}-${view.rideDate.toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
})();
