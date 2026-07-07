/* =========================================================
   app.js — UI, kaart en het controleproces
   Vereist: geometry.js, gpx.js, gipod.js, Leaflet
   ========================================================= */
"use strict";
(() => {
  /* Element-lookup die niet crasht als script- en paginaversie niet samengaan
     (bv. door browsercache): ontbrekende elementen geven een waarschuwing in
     de console en absorberen alle lees/schrijf-acties. */
  const $ = id => {
    const el = document.getElementById(id);
    if (el) return el;
    console.warn(`WerfAlarm: element #${id} ontbreekt — pagina en script zijn mogelijk verschillende versies. Ververs met Ctrl+F5.`);
    const absorb = new Proxy(function () {}, {
      get: (t, p) => (p === Symbol.toPrimitive ? () => "" : absorb),
      set: () => true,
      apply: () => absorb
    });
    return absorb;
  };
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
    let text, pts, eles, name;
    try {
      text = await file.text();
      ({ pts, eles, name } = GPX.parse(text));
    } catch (err) {
      $("error").style.display = "block";
      $("error").textContent = "GPX kon niet gelezen worden: " + err.message;
      return;
    }
    /* vanaf hier is het bestand geldig; UI-fouten tonen we niet als GPX-fout */
    rawGpx = text;
    GIPOD.clearCache();                 // nieuwe route = verse data
    lastResults = [];
    route = Geom.buildRoute(pts, name || file.name.replace(/\.gpx$/i, ""));
    route.rawPts = pts;
    route.rawEles = eles;               // null als de GPX geen hoogtes bevat
    route.profile = undefined;          // wordt (lui) gebouwd voor het rapport
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

  /* ---------------- PDF-rapport (jsPDF, lazy geladen; HTML als vangnet) ---------------- */
  let jspdfPromise = null;
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    if (!jspdfPromise) jspdfPromise = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res;
      s.onerror = () => { jspdfPromise = null; rej(new Error("PDF-bibliotheek kon niet geladen worden")); };
      document.head.appendChild(s);
    });
    return jspdfPromise;
  }

  /* PDF kan geen emoji/pijlen in de standaardfonts aan */
  const san = s => String(s).replace(/→/g, "->").replace(/⛔/g, "").replace(/[^\x20-\xFF\n]/g, "").replace(/[ \t\r\n]+/g, " ").trim();

  /* Echte kaartafbeelding voor het rapport: OSM-tegels + route + markers op een
     canvas. Faalt dit (offline, geblokkeerde tegels), dan valt het rapport
     terug op het schematische kaartje. */
  async function buildMapImage(list) {
    const S = 2, cw = 780, ch = 360;                       // 780×360 ≙ 182×84 mm in het rapport
    const canvas = document.createElement("canvas");
    canvas.width = cw * S; canvas.height = ch * S;
    const ctx = canvas.getContext("2d"); ctx.scale(S, S);

    const lats = route.pts.map(p => p[0]), lons = route.pts.map(p => p[1]);
    let la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
    const padLat = (la1 - la0) * .08 + .002, padLon = (lo1 - lo0) * .08 + .002;
    la0 -= padLat; la1 += padLat; lo0 -= padLon; lo1 += padLon;

    const lon2x = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
    const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); };
    let z = 15;
    while (z > 3) {
      const wpx = (lon2x(lo1, z) - lon2x(lo0, z)) * 256, hpx = (lat2y(la0, z) - lat2y(la1, z)) * 256;
      if (wpx <= cw && hpx <= ch) break; z--;
    }
    const cx = (lon2x(lo0, z) + lon2x(lo1, z)) / 2, cy = (lat2y(la0, z) + lat2y(la1, z)) / 2;
    const px0 = cx * 256 - cw / 2, py0 = cy * 256 - ch / 2;
    const X = lon => lon2x(lon, z) * 256 - px0, Y = lat => lat2y(lat, z) * 256 - py0;

    /* tegels ophalen (individuele missers zijn geen ramp) */
    const jobs = [];
    for (let tx = Math.floor(px0 / 256); tx <= Math.floor((px0 + cw) / 256); tx++)
      for (let ty = Math.floor(py0 / 256); ty <= Math.floor((py0 + ch) / 256); ty++)
        jobs.push(new Promise(res => {
          const img = new Image(); img.crossOrigin = "anonymous";
          let settled = false; const done = ok => { if (!settled) { settled = true; res(ok ? { img, tx, ty } : null); } };
          img.onload = () => done(true); img.onerror = () => done(false);
          setTimeout(() => done(false), 7000);
          img.src = `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`;
        }));
    const loaded = (await Promise.all(jobs)).filter(Boolean);
    if (!loaded.length) throw new Error("geen kaarttegels beschikbaar");

    ctx.fillStyle = "#EDECE5"; ctx.fillRect(0, 0, cw, ch);
    for (const t of loaded) ctx.drawImage(t.img, t.tx * 256 - px0, t.ty * 256 - py0, 256, 256);

    const dot = (x, y, r, c) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); };

    /* route met witte rand voor leesbaarheid op de kaart */
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    route.pts.forEach((p, i) => i ? ctx.lineTo(X(p[1]), Y(p[0])) : ctx.moveTo(X(p[1]), Y(p[0])));
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = "#2F5AA8"; ctx.lineWidth = 3.5; ctx.stroke();
    dot(X(route.pts[0][1]), Y(route.pts[0][0]), 5, "#2B8A3E");

    ctx.font = "bold 11px Arial"; ctx.textAlign = "center";
    for (const r of list) for (const km of r.kms) {
      const [lat, lon] = Geom.pointAtChain(route, km * 1000);
      dot(X(lon), Y(lat), 6, isHardFor(r, view.modes) ? "#A61E04" : "#D9480F");
      const label = "km " + km.toFixed(1);
      ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.strokeText(label, X(lon), Y(lat) - 9);
      ctx.fillStyle = "#141619"; ctx.fillText(label, X(lon), Y(lat) - 9);
    }
    /* verplichte bronvermelding */
    ctx.font = "10px Arial"; ctx.textAlign = "right";
    const at = "© OpenStreetMap-bijdragers";
    const aw = ctx.measureText(at).width + 8;
    ctx.fillStyle = "rgba(255,255,255,.82)"; ctx.fillRect(cw - aw - 4, ch - 16, aw, 13);
    ctx.fillStyle = "#333"; ctx.fillText(at, cw - 8, ch - 6);

    return { data: canvas.toDataURL("image/jpeg", .85) };
  }

  /* ---------------- hoogtedata & weer voor het rapport ---------------- */

  /* Profiel uit de GPX-hoogtes; ontbreken die, dan halen we hoogtes op bij
     Open-Meteo (open data, geen sleutel). Mislukt ook dat: null. */
  async function ensureProfile() {
    if (route.profile !== undefined) return route.profile;
    let pts = route.rawPts, eles = route.rawEles;
    if (!eles) {
      try {
        const step = Math.max(1, Math.ceil(route.pts.length / 300));
        pts = route.pts.filter((_, i) => i % step === 0);
        eles = [];
        for (let i = 0; i < pts.length; i += 100) {
          const chunk = pts.slice(i, i + 100);
          const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(p => p[0].toFixed(5)).join(",")}&longitude=${chunk.map(p => p[1].toFixed(5)).join(",")}`;
          const r = await fetch(url);
          if (!r.ok) throw new Error("hoogtedienst " + r.status);
          eles.push(...(await r.json()).elevation);
        }
      } catch (e) { route.profile = null; return null; }
    }
    route.profile = Geom.buildProfile(pts, eles);
    return route.profile;
  }

  const COMPASS = ["N", "NNO", "NO", "ONO", "O", "OZO", "ZO", "ZZO", "Z", "ZZW", "ZW", "WZW", "W", "WNW", "NW", "NNW"];
  const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];
  const wmoText = c => c === 0 ? "helder" : c <= 2 ? "licht bewolkt" : c === 3 ? "bewolkt"
    : c <= 48 ? "mist" : c <= 57 ? "motregen" : c <= 67 ? "regen" : c <= 77 ? "sneeuw"
    : c <= 82 ? "buien" : c <= 86 ? "sneeuwbuien" : "onweer mogelijk";

  /* Dagvoorspelling van Open-Meteo voor het middelpunt van de route.
     We tonen de voorspelling voor de ritdatum als die binnen het
     voorspellingsbereik (±15 dagen) valt, anders voor vandaag. */
  async function fetchWeather() {
    const lats = route.pts.map(p => p[0]), lons = route.pts.map(p => p[1]);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const ahead = Math.round((view.rideDate - today) / 864e5);
    const target = (ahead >= 0 && ahead <= 15) ? view.rideDate : today;
    const iso = target.toLocaleDateString("en-CA");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,` +
      `wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,cloud_cover_mean` +
      `&timezone=Europe%2FBrussels&start_date=${iso}&end_date=${iso}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("weerdienst " + r.status);
    const d = (await r.json()).daily;
    return {
      date: target, isRideDate: target !== today || ahead === 0,
      tmax: d.temperature_2m_max[0], tmin: d.temperature_2m_min[0],
      wind: d.wind_speed_10m_max[0], gust: d.wind_gusts_10m_max[0],
      dir: d.wind_direction_10m_dominant[0],
      pp: d.precipitation_probability_max[0], psum: d.precipitation_sum[0],
      cloud: d.cloud_cover_mean[0], code: d.weather_code[0]
    };
  }

  /* Kort Nederlands karakterportret van een klim op basis van zijn cijfers */
  function climbStory(c) {
    const pos = c.startKm < route.km * .3 ? "vroeg in de rit"
      : c.startKm > route.km * .7 ? "diep in de finale" : "rond halfweg";
    let aard;
    if (c.avg < 3.5) aard = "een geleidelijke stijging die vooral ritme en geduld vraagt — echt steil wordt het nergens";
    else if (c.avg < 6) aard = "een gelijkmatige klim waarop je met een vast tempo goed kunt doorrijden";
    else if (c.avg < 9) aard = "een stevige helling die kracht vraagt; kies je verzet voor de voet";
    else aard = "een scherpe kuitenbijter waar je beter niet te enthousiast aan begint";
    const ritme = c.irregular ? " Het profiel is onregelmatig: stroken vals plat wisselen af met steilere ramps, dus doseer op de steile stukken." : "";
    const piek = c.max >= c.avg + 2
      ? ` De steilste strook (tot zo'n ${c.max.toFixed(0)}%) ligt rond km ${c.maxAt.toFixed(1)}.` : "";
    const lengte = c.lenKm >= 2.5 ? "Een lange inspanning: verdeel je krachten. " : c.lenKm <= 0.6 ? "Kort maar fel: dit kan op momentum. " : "";
    return `Je pakt deze klim ${pos} mee. Het is ${aard}.${ritme}${piek} ${lengte}Boven sta je op ${c.topEle} m.`.trim();
  }

  async function buildReportPdf() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const { list, rideDate, range, truncated } = view;
    const W = 210, M = 14, CW = W - 2 * M;
    const INKc = [20, 22, 25], ORANGEc = [244, 89, 11], DEEPc = [217, 72, 15], HARDc = [166, 30, 4],
          MUTEDc = [86, 94, 104], ROUTEc = [47, 90, 168], OKc = [43, 138, 62], CHALKc = [237, 236, 229];
    const dateStr = rideDate.toLocaleDateString("nl-BE");
    let y;
    let mapImg = null, profile = null, weather = null;
    try { mapImg = await buildMapImage(list); } catch (e) { /* schematisch kaartje als vangnet */ }
    try { profile = await ensureProfile(); } catch (e) { profile = null; }
    try { weather = await fetchWeather(); } catch (e) { weather = null; }

    const stripes = yy => {
      doc.setFillColor(...ORANGEc); doc.rect(0, yy, W, 7, "F");
      doc.setDrawColor(255); doc.setLineWidth(2.4);
      for (let x = -8; x < W + 8; x += 7) doc.line(x, yy + 7, x + 7, yy);
    };
    const diamond = (cx, cy, r, fill) => {
      doc.setFillColor(...fill); doc.setDrawColor(...INKc); doc.setLineWidth(.4);
      doc.lines([[r, r], [-r, r], [-r, -r], [r, -r]], cx, cy - r, [1, 1], "FD", true);
    };
    const newPage = () => { doc.addPage(); y = 18; };

    /* ---- kop ---- */
    stripes(0);
    y = 20;
    doc.setFont("helvetica", "bold"); doc.setFontSize(21); doc.setTextColor(...INKc);
    doc.text("WERF", M, y);
    doc.setTextColor(...ORANGEc); doc.text("ALARM", M + doc.getTextWidth("WERF"), y);
    doc.setTextColor(...INKc); doc.text(" — RAPPORT", M + doc.getTextWidth("WERFALARM"), y);
    y += 7;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...MUTEDc);
    /* ook de infolijnen afbreken op paginabreedte (lange routenamen!) */
    const info1 = doc.splitTextToSize(san(`${route.name} · ${route.km.toFixed(1)} km · ritdatum ${dateStr}`), CW);
    doc.text(info1, M, y); y += info1.length * 4.5;
    const opts = [`zoekafstand ${range === 0 ? "0 m (enkel op de route zelf)" : "±" + range + " m"}`];
    if (view.modes.size !== 3) opts.push(`weggebruikers: ${modesLabel(view.modes)}`);
    if (view.onlyHard) opts.push("filter: enkel blokkades");
    opts.push(`gemaakt\u00A0op\u00A0${new Date().toLocaleString("nl-BE", { dateStyle: "short", timeStyle: "short" }).replace(/ /g, "\u00A0")}`);
    const info2 = doc.splitTextToSize(san(opts.join(" · ")), CW);
    doc.text(info2, M, y); y += info2.length * 4.5 + 1.5;

    /* ---- kaart (echte OSM-kaart; schematisch als vangnet) ---- */
    const mapH = 84;
    if (mapImg) {
      doc.addImage(mapImg.data, "JPEG", M, y, CW, mapH);
      doc.setDrawColor(...INKc); doc.setLineWidth(.6); doc.rect(M, y, CW, mapH, "D");
    } else {
      doc.setFillColor(...CHALKc); doc.setDrawColor(...INKc); doc.setLineWidth(.6);
      doc.rect(M, y, CW, mapH, "FD");
      const P = route.pts, lats = P.map(p => p[0]), lons = P.map(p => p[1]);
      const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
      const pad = 8, k = Math.min((CW - 2 * pad) / Math.max(lo1 - lo0, 1e-9), (mapH - 2 * pad) / Math.max(la1 - la0, 1e-9));
      const X = lon => M + pad + (lon - lo0) * k + (CW - 2 * pad - (lo1 - lo0) * k) / 2;
      const Y = lat => y + mapH - pad - (lat - la0) * k - (mapH - 2 * pad - (la1 - la0) * k) / 2;
      doc.setDrawColor(...ROUTEc); doc.setLineWidth(1.1);
      const step = Math.max(1, Math.floor(P.length / 600));
      let prev = P[0];
      for (let i = step; i < P.length; i += step) { doc.line(X(prev[1]), Y(prev[0]), X(P[i][1]), Y(P[i][0])); prev = P[i]; }
      doc.line(X(prev[1]), Y(prev[0]), X(P[P.length - 1][1]), Y(P[P.length - 1][0]));
      doc.setFillColor(...OKc); doc.setDrawColor(255); doc.setLineWidth(.6);
      doc.circle(X(P[0][1]), Y(P[0][0]), 1.9, "FD");
      doc.setFontSize(7); doc.setFont("helvetica", "bold");
      for (const r of list) for (const km of r.kms) {
        const [lat, lon] = Geom.pointAtChain(route, km * 1000);
        doc.setFillColor(...(isHardFor(r, view.modes) ? HARDc : DEEPc)); doc.setDrawColor(255);
        doc.circle(X(lon), Y(lat), 2.1, "FD");
        doc.setTextColor(...INKc);
        doc.text(`km ${km.toFixed(1)}`, X(lon), Y(lat) - 3.2, { align: "center" });
      }
    }
    y += mapH + 6;

    /* ---- routestrook ---- */
    doc.setFillColor(255, 255, 255); doc.setDrawColor(...INKc); doc.setLineWidth(.6);
    doc.rect(M, y, CW, 14, "FD");
    const sy = y + 6, sx0 = M + 8, sx1 = M + CW - 8;
    doc.setDrawColor(...INKc); doc.setLineWidth(1.1); doc.line(sx0, sy, sx1, sy);
    doc.setFillColor(...OKc); doc.setLineWidth(.4); doc.circle(sx0, sy, 1.7, "FD");
    doc.setFillColor(...INKc); doc.rect(sx1 - 1.7, sy - 1.7, 3.4, 3.4, "F");
    for (const r of list) for (const km of r.kms)
      diamond(sx0 + (sx1 - sx0) * Math.min(1, km / route.km), sy, 1.9, isHardFor(r, view.modes) ? HARDc : ORANGEc);
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(...MUTEDc);
    doc.text("0", sx0, y + 12); doc.text(`${route.km.toFixed(0)} km`, sx1, y + 12, { align: "right" });
    y += 20;

    /* ---- werven ---- */
    if (!list.length) {
      doc.setDrawColor(...INKc); doc.setLineWidth(.5); doc.rect(M, y, CW, 18, "D");
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...OKc);
      doc.text(view.onlyHard ? "Geen blokkades!" : "Vrije baan!", W / 2, y + 8, { align: "center" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      doc.text(san(view.onlyHard
        ? `Geen afsluitingen of omleidingen op deze route op ${dateStr} (lichtere hinder niet berekend).`
        : `Geen hinder gevonden op deze route op ${dateStr}. Goede rit!`), W / 2, y + 13.5, { align: "center" });
      y += 24;
    }
    const tX = M + 27, tW = W - M - tX - 3;   // 3 mm binnenmarge rechts
    for (const r of list) {
      const hard = isHardFor(r, view.modes);
      /* Belangrijk: splitTextToSize meet met het ACTIEVE font — dus vóór elke
         meting exact het font/formaat instellen waarmee de tekst ook wordt afgedrukt. */
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
      const titleLines = doc.splitTextToSize(san(r.desc) + (hard ? "  [BLOKKADE]" : ""), tW);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
      const meta = san(`${GIPOD.fmtDate(r.start)} -> ${GIPOD.fmtDate(r.end)}${r.owner ? " · " + r.owner : ""} · ${r.dist > 10 ? r.dist + " m van de track" : "op de track"}`);
      const metaLines = doc.splitTextToSize(meta, tW);
      const consLines = consText(r) ? doc.splitTextToSize(san(consText(r)), tW) : [];
      doc.setFont("helvetica", "bold");
      const passLines = r.kms.length > 1
        ? doc.splitTextToSize(san(`Passages: km ${r.kms.map(k => k.toFixed(1)).join(" · ")}`), tW) : [];
      const h = 8 + titleLines.length * 4.6 + metaLines.length * 3.9 + passLines.length * 3.9 + consLines.length * 3.9 + 4.5;
      if (y + h > 282) newPage();

      doc.setFillColor(255, 255, 255); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
      doc.rect(M, y, CW, h, "FD");
      doc.setFillColor(...(hard ? HARDc : DEEPc)); doc.rect(M, y, 2.4, h, "F");
      /* km-badge */
      doc.setDrawColor(...INKc); doc.setFillColor(255, 255, 255); doc.rect(M + 6, y + 4, 17, 11, "FD");
      doc.setFillColor(...INKc); doc.rect(M + 6, y + 4, 17, 4, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(255, 212, 59);
      doc.text(r.kms.length > 1 ? `${r.kms.length}x KM` : "KM", M + 14.5, y + 6.9, { align: "center" });
      doc.setFontSize(10); doc.setTextColor(...INKc);
      doc.text(r.km.toFixed(1), M + 14.5, y + 12.6, { align: "center" });

      let ty = y + 8;
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...(hard ? HARDc : INKc));
      doc.text(titleLines, tX, ty); ty += titleLines.length * 4.6;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...MUTEDc);
      doc.text(metaLines, tX, ty); ty += metaLines.length * 3.9;
      if (passLines.length) {
        doc.setFont("helvetica", "bold"); doc.setTextColor(...INKc);
        doc.text(passLines, tX, ty); ty += passLines.length * 3.9;
        doc.setFont("helvetica", "normal");
      }
      if (consLines.length) { doc.setTextColor(...(hard ? HARDc : DEEPc)); doc.text(consLines, tX, ty); ty += consLines.length * 3.9; }
      doc.setTextColor(...ROUTEc); doc.setFontSize(8);
      doc.textWithLink("Bekijk op kaart", tX, ty, { url: `https://www.google.com/maps?q=${r.lat.toFixed(5)},${r.lon.toFixed(5)}` });
      y += h + 4;
    }
    if (truncated) {
      if (y > 275) newPage();
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTEDc);
      doc.text(san("Let op: minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig."), M, y + 2);
      y += 7;
    }

    /* ================= SECTIE: HOOGTEPROFIEL & KLIMMEN ================= */
    const sectionHeader = title => {
      if (y > 252) newPage();
      y += 3;
      doc.setFillColor(...ORANGEc); doc.rect(M, y - 3.6, 4.2, 4.2, "F");
      doc.setDrawColor(...INKc); doc.setLineWidth(.4); doc.rect(M, y - 3.6, 4.2, 4.2, "D");
      doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(...INKc);
      doc.text(title, M + 7, y);
      doc.setLineWidth(.7); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 8;
    };
    const fillPoly = (pts, fill) => {
      if (pts.length < 3) return;
      doc.setFillColor(...fill);
      const segs = [];
      for (let i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
      doc.lines(segs, pts[0][0], pts[0][1], [1, 1], "F", true);
    };
    const strokePath = (pts, color, lw) => {
      doc.setDrawColor(...color); doc.setLineWidth(lw);
      for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    };
    /* profielgrafiek: gevulde curve, klimzones oranje gemarkeerd */
    const drawProfileChart = (x, yy, w, h, prof, climbs, lineC, fillC) => {
      const kmax = prof.km[prof.km.length - 1] || 1;
      const e0 = prof.min ?? Math.min(...prof.ele), e1 = prof.max ?? Math.max(...prof.ele);
      const sx = k => x + (k / kmax) * w;
      const sy = e => yy + h - 3 - ((e - e0) / Math.max(e1 - e0, 1)) * (h - 8);
      const step = Math.max(1, Math.floor(prof.km.length / 220));
      const path = [];
      for (let i = 0; i < prof.km.length; i += step) path.push([sx(prof.km[i]), sy(prof.ele[i])]);
      path.push([sx(kmax), sy(prof.ele[prof.ele.length - 1])]);
      fillPoly([[path[0][0], yy + h - 3], ...path, [sx(kmax), yy + h - 3]], fillC);
      /* klimzones */
      for (const c of (climbs || [])) {
        const cp = [];
        const cs = Math.max(1, Math.floor(c.slice.km.length / 60));
        for (let i = 0; i < c.slice.km.length; i += cs) cp.push([sx(c.slice.km[i]), sy(c.slice.ele[i])]);
        cp.push([sx(c.endKm), sy(c.topEle)]);
        fillPoly([[cp[0][0], yy + h - 3], ...cp, [cp[cp.length - 1][0], yy + h - 3]], [253, 216, 190]);
      }
      strokePath(path, lineC, .8);
      doc.setDrawColor(...INKc); doc.setLineWidth(.4); doc.line(x, yy + h - 3, x + w, yy + h - 3);
      /* nummers op de toppen */
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5);
      (climbs || []).forEach((c, i) => {
        const px = sx(c.endKm), py = sy(c.topEle) - 3.4;
        doc.setFillColor(...DEEPc); doc.setDrawColor(255); doc.setLineWidth(.4);
        doc.circle(px, py, 2.2, "FD");
        doc.setTextColor(255, 255, 255); doc.text(String(i + 1), px, py + .9, { align: "center" });
      });
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor(...MUTEDc);
      doc.text("0", x, yy + h + 1); doc.text(`${kmax.toFixed(0)} km`, x + w, yy + h + 1, { align: "right" });
      doc.text(`${e1} m`, x + w + 1.5, sy(e1) + 1, { align: "left" });
      doc.text(`${e0} m`, x + w + 1.5, sy(e0) + 1, { align: "left" });
    };

    sectionHeader("HOOGTEPROFIEL & KLIMMEN");
    if (!profile) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const noEle = doc.splitTextToSize(san("Geen hoogtedata beschikbaar: de GPX bevat geen hoogtes en de hoogtedienst was niet bereikbaar. Exporteer je route met hoogteprofiel (Komoot/Strava doen dit standaard) en maak het rapport opnieuw."), CW);
      doc.text(noEle, M, y); y += noEle.length * 4 + 4;
    } else {
      const climbs = Geom.findClimbs(profile);
      /* overzichtsgrafiek van de volledige rit */
      if (y + 46 > 282) newPage();
      doc.setFillColor(255, 255, 255); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
      doc.rect(M, y, CW, 40, "FD");
      drawProfileChart(M + 3, y + 2, CW - 14, 34, profile, climbs, ROUTEc, [222, 228, 238]);
      y += 44;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...INKc);
      const stats = san(`Totaal ${profile.ascent} hoogtemeters over ${route.km.toFixed(1)} km · laagste punt ${profile.min} m · hoogste punt ${profile.max} m · ${climbs.length} ${climbs.length === 1 ? "klim" : "klimmen"} gedetecteerd.`);
      const statsLines = doc.splitTextToSize(stats, CW);
      doc.text(statsLines, M, y); y += statsLines.length * 4 + 3;

      if (!climbs.length) {
        doc.setTextColor(...MUTEDc);
        const flat = doc.splitTextToSize(san("Een vlak tot golvend parcours zonder noemenswaardige klimmen — hier wint de groep die uit de wind blijft, niet de klimmer."), CW);
        doc.text(flat, M, y); y += flat.length * 4 + 4;
      }
      /* per klim: minigrafiek + portret */
      climbs.forEach((c, i) => {
        doc.setFont("helvetica", "bold"); doc.setFontSize(10);
        const titleTxt = san(`Klim ${i + 1} — km ${c.startKm.toFixed(1)} -> km ${c.endKm.toFixed(1)}`);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        const statTxt = san(`${c.lenKm.toFixed(2)} km lang · ${c.gain} hoogtemeters · gem. ${c.avg}% · max. ${c.max}%`);
        const story = doc.splitTextToSize(san(climbStory(c)), CW - 62);
        const h = Math.max(26, 14 + story.length * 3.9 + 3);
        if (y + h > 282) newPage();
        doc.setFillColor(255, 255, 255); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
        doc.rect(M, y, CW, h, "FD");
        doc.setFillColor(...DEEPc); doc.rect(M, y, 2.4, h, "F");
        /* minigrafiek links */
        doc.setFillColor(...CHALKc); doc.setDrawColor(...INKc); doc.setLineWidth(.4);
        doc.rect(M + 5, y + 4, 48, h - 8, "FD");
        drawProfileChart(M + 7, y + 5, 40, h - 12, { km: c.slice.km.map(k => k - c.startKm), ele: c.slice.ele, min: c.startEle, max: c.topEle }, null, DEEPc, [253, 216, 190]);
        /* tekst rechts */
        let ty = y + 8;
        doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...INKc);
        doc.text(titleTxt, M + 58, ty); ty += 4.6;
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...DEEPc);
        doc.text(statTxt, M + 58, ty); ty += 4.4;
        doc.setTextColor(...MUTEDc);
        doc.text(story, M + 58, ty);
        y += h + 4;
      });
    }

    /* ================= SECTIE: WEERSVOORSPELLING ================= */
    sectionHeader("WEERSVOORSPELLING");
    if (!weather) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const noW = doc.splitTextToSize(san("De weersvoorspelling kon niet opgehaald worden (geen internetverbinding of dienst onbereikbaar). Raadpleeg je weerapp voor vertrek."), CW);
      doc.text(noW, M, y); y += noW.length * 4 + 4;
    } else {
      if (y + 34 > 282) newPage();
      doc.setFillColor(255, 255, 255); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
      doc.rect(M, y, CW, 30, "FD");
      const wd = weather.date.toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...INKc);
      doc.text(san(`Voorspelling voor ${wd}${weather.isRideDate ? " (je ritdatum)" : ""} — ${wmoText(weather.code)}`), M + 5, y + 7);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const col1 = [
        `Temperatuur: ${Math.round(weather.tmin)}° tot ${Math.round(weather.tmax)}°C`,
        `Neerslagkans: ${weather.pp ?? "?"}%  ·  neerslag: ${(weather.psum ?? 0).toFixed(1)} mm`
      ];
      const col2 = [
        `Wind: ${Math.round(weather.wind)} km/u uit ${compass(weather.dir)} (rukwinden tot ${Math.round(weather.gust)} km/u)`,
        `Bewolking: gemiddeld ${Math.round(weather.cloud)}%`
      ];
      doc.text(san(col1[0]), M + 5, y + 14); doc.text(san(col1[1]), M + 5, y + 19.5);
      doc.text(san(col2[0]), M + 92, y + 14); doc.text(san(col2[1]), M + 92, y + 19.5);
      doc.setFontSize(7.5);
      doc.text(san(`Bron: Open-Meteo.com · locatie: middelpunt van de route · opgehaald op ${new Date().toLocaleString("nl-BE", { dateStyle: "short", timeStyle: "short" })}`), M + 5, y + 26);
      y += 34;
      /* fietsduiding op basis van wind */
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const windAdvies = weather.wind >= 35
        ? `Stevige wind uit ${compass(weather.dir)}: plan je lus zo dat je de terugweg wind mee hebt, en hou rekening met rukwinden op open stukken.`
        : weather.wind >= 20
          ? `Matige wind uit ${compass(weather.dir)} — merkbaar op open wegen, maar goed te doen.`
          : `Weinig wind: een dag om van te profiteren.`;
      const regenAdvies = (weather.pp ?? 0) >= 60 ? " Grote kans op neerslag: neem een regenjasje mee." :
        (weather.pp ?? 0) >= 30 ? " Een bui is niet uitgesloten; een windvestje kan geen kwaad." : "";
      const adv = doc.splitTextToSize(san(windAdvies + regenAdvies), CW);
      doc.text(adv, M, y); y += adv.length * 4 + 3;
    }

    /* ---- voettekst + paginanummers ---- */
    const pages = doc.getNumberOfPages();
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    const foot = doc.splitTextToSize(san("Bron: GIPOD open data (geo.api.vlaanderen.be), zelfde bron als geopunt.be/hinder-in-kaart — enkel Vlaanderen. Controleer kort voor vertrek opnieuw."), CW - 12);
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...MUTEDc);
      doc.text(foot, M, 293 - foot.length * 2.8);
      doc.text(`${p}/${pages}`, W - M, 291, { align: "right" });
    }
    return doc;
  }

  $("report").addEventListener("click", async () => {
    if (!view) return;
    const btn = $("report"), old = btn.textContent;
    btn.disabled = true; btn.textContent = "PDF maken…";
    const slug = route.name.replace(/[^\w\- ]+/g, "").trim().replace(/ +/g, "-").toLowerCase();
    const base = `werfalarm-rapport-${slug}-${view.rideDate.toISOString().slice(0, 10)}`;
    try {
      await loadJsPDF();
      (await buildReportPdf()).save(base + ".pdf");
    } catch (e) {
      /* geen internet of bibliotheek faalt: HTML-rapport als vangnet */
      const blob = new Blob([buildReportHtml()], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = base + ".html";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $("status").textContent = "PDF-bibliotheek niet beschikbaar — HTML-rapport gedownload.";
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });
})();
