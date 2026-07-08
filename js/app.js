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
    console.warn(`RouteScout: element #${id} ontbreekt — pagina en script zijn mogelijk verschillende versies. Ververs met Ctrl+F5.`);
    const absorb = new Proxy(function () {}, {
      get: (t, p) => (p === Symbol.toPrimitive ? () => "" : absorb),
      set: () => true,
      apply: () => absorb
    });
    return absorb;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* UI-vertaalhelper: leest de actieve interfacetaal (i18n.js) */
  const T = (k, ...a) => {
    const d = window.I18N ? I18N.ui() : null;
    const v = d && d[k];
    return typeof v === "function" ? v(...a) : (v ?? "");
  };
  const uiLoc = () => (window.I18N ? I18N.ui().locale : "nl-BE");
  const modesLabelL = (modes, dict) => modes.size === 3 ? dict.allUsers
    : ["bike", "ped", "motor"].filter(m => modes.has(m)).map(m => dict.modes[m]).join(" + ");

  /* ---------------- state ---------------- */
  let route = null;       // gebouwd door Geom.buildRoute()
  let rawGpx = "";        // originele bestandsinhoud, voor export met waypoints
  let lastResults = [];   // laatste gevonden hinder
  let view = null;        // {list, rideDate, truncated, range, filterHard, sortBy}

  /* ---------------- kaart ---------------- */
  const map = L.map("map", { scrollWheelZoom: true }).setView([50.95, 4.9], 9);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
  let routeLayer = null, startMarker = null, markers = [];
  const hinderLayer = L.layerGroup().addTo(map);   // werven (zones + stippen)
  const climbLayer  = L.layerGroup().addTo(map);   // klim-pins
  const windLayer   = L.layerGroup().addTo(map);   // windpijlen
  const detourLayer = L.layerGroup().addTo(map);   // omleidingsvoorstel (tijdelijk)

  function drawRoute() {
    if (routeLayer) map.removeLayer(routeLayer);
    if (startMarker) map.removeLayer(startMarker);
    clearMarkers();
    routeLayer = L.polyline(route.pts, { color: "#2F5AA8", weight: 4, opacity: .9 }).addTo(map);
    startMarker = L.circleMarker(route.pts[0], { radius: 6, color: "#2B8A3E", fillColor: "#2B8A3E", fillOpacity: 1 })
      .addTo(map).bindTooltip("Start");
    map.fitBounds(routeLayer.getBounds().pad(0.05));
  }
  function clearMarkers() { hinderLayer.clearLayers(); markers = []; }

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
    route.modified = false;             // nog geen omleiding overgenomen
    detourLayer.clearLayers();
    drawRoute();
    $("strip").hidden = true;
    $("dlgpx").disabled = true;
    $("report").disabled = true;
    $("routeinfo").innerHTML = T("routeInfo", esc(route.name), route.km.toFixed(1), route.tiles.length);
    $("footroute").textContent = T("footRoute", route.name, route.km.toFixed(1), pts.length);
    $("run").disabled = false;
    $("status").textContent = T("statusReady");
    $("error").style.display = "none";
    recalcRideTimes();
    $("out").innerHTML = `<div id="empty" class="empty"><span class="empty-icon">✅</span>${T("emptyLoaded")}</div>`;
    initSections();   // hoogteprofiel + weer alvast opbouwen (async)
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
      $("status").textContent = T("statusQuery", d, t);
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
      $("error").innerHTML = T("gipodFailHtml") + ` <span class="note">(${esc(e.message)})</span>`;
      $("run").disabled = false; $("status").textContent = T("statusFail");
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
    view = { list, rideDate, truncated, range, onlyHard, modes, filterHard: false, sortBy: "km",
              startHour: $("starthour").value, endHour: $("endhour").value };
    refresh();
    $("run").disabled = false;
    $("dlgpx").disabled = false;   // route (evt. herroutet) blijft downloadbaar, ook zonder resterende hinder
    $("report").disabled = false;
    const cacheNote = fromCache === route.tiles.length * 2 ? T("fromCache") : "";
    const forWho = modes.size === 3 ? "" : T("forUsers", modesLabelL(modes, repLang()));
    $("status").textContent = T("statusDone", list.length, onlyHard, forWho, rideDate.toLocaleDateString(uiLoc()), cacheNote);
    renderPageWeather();   // ritdatum kan gewijzigd zijn
    $("bar").firstElementChild.style.width = "100%";
  }

  /* ---------------- startuur / einduur / snelheid: automatische berekening ----------------
     Vult het ontbrekende veld aan zodra de andere twee gekend zijn, op basis van de
     routelengte. Bij een bewerking wordt nooit het veld overschreven dat de gebruiker
     net zelf intikt. */
  const toDecHour = t => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h + (m || 0) / 60; };
  const fromDecHour = h => {
    h = ((h % 24) + 24) % 24;
    let hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  };
  function recalcRideTimes(editedId) {
    if (!route) return;
    const sVal = $("starthour").value, eVal = $("endhour").value, spVal = $("speed").value;
    const hasS = !!sVal, hasE = !!eVal, hasSp = spVal !== "" && parseFloat(spVal) > 0;
    const km = route.km;
    if (editedId !== "speed" && hasS && hasE) {
      let dur = toDecHour(eVal) - toDecHour(sVal);
      if (dur <= 0) dur += 24;   // rit over middernacht
      $("speed").value = (km / dur).toFixed(1);
    } else if (editedId !== "endhour" && hasS && hasSp) {
      const dur = km / parseFloat(spVal);
      $("endhour").value = fromDecHour(toDecHour(sVal) + dur);
    } else if (editedId !== "starthour" && hasE && hasSp) {
      const dur = km / parseFloat(spVal);
      $("starthour").value = fromDecHour(toDecHour(eVal) - dur);
    }
  }
  ["starthour", "endhour", "speed"].forEach(id =>
    $(id).addEventListener("input", () => recalcRideTimes(id)));

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
      <div class="strip-start" style="left:26px" title="${T("stripStart")}"></div>
      <div class="strip-end" style="left:calc(100% - 26px)" title="${T("stripFinish")}"></div>
      <span class="strip-label" style="left:26px">0</span>
      <span class="strip-label" style="left:calc(100% - 26px)">${route.km.toFixed(0)} km</span>`;
    list.forEach((r, i) => {
      r.kms.forEach(km => {
        const pct = Math.max(0, Math.min(1, km / route.km));
        const tick = document.createElement("button");
        tick.className = "strip-tick" + (isHardFor(r, view.modes) ? " hard" : "");
        tick.style.left = `calc(26px + (100% - 52px) * ${pct.toFixed(4)})`;
        tick.title = T("stripTick", km.toFixed(1), r.desc) +
          (r.kms.length > 1 ? T("stripPass", r.kms.indexOf(km) + 1, r.kms.length) : "") +
          (isHardFor(r, view.modes) ? T("stripBlock") : "");
        tick.setAttribute("aria-label", T("werfAria", km.toFixed(1), r.desc));
        tick.innerHTML = "<span></span>";
        tick.addEventListener("click", () => cardFocus[i] && cardFocus[i](true));
        strip.appendChild(tick);
      });
    });
    strip.hidden = false;
  }

  /* ---------------- GPX-export met waarschuwings-waypoints ---------------- */
  $("dlgpx").addEventListener("click", () => {
    if (!route) return;
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
    const out = route.modified
      ? GPX.buildGpx(route.rawPts, route.rawEles, route.name, wpts)
      : GPX.exportWithWarnings(rawGpx, wpts);
    const blob = new Blob([out], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = route.name.replace(/[^\w\- ]+/g, "").trim().replace(/ +/g, "-") + "-routescout.gpx";
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
      ? `<span class="hardtag" style="margin:0;align-self:center">${T("calcHardBadge")}</span>`
      : `<div class="seg" role="group" aria-label="Filter">
           <button class="seg-btn" data-f="all" aria-pressed="${!view.filterHard}">${T("segAll", view.list.length)}</button>
           <button class="seg-btn" data-f="hard" aria-pressed="${view.filterHard}">${T("segHard", view.list.filter(r => isHardFor(r, view.modes)).length)}</button>
         </div>`;
    row.innerHTML = filterSeg +
      `<div class="seg" role="group" aria-label="Sort">
         <button class="seg-btn" data-s="km" aria-pressed="${view.sortBy === "km"}">${T("segKm")}</button>
         <button class="seg-btn" data-s="sev" aria-pressed="${view.sortBy === "sev"}">${T("segSev")}</button>
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
    const scope = range === 0 ? T("scope0") : T("scopeN", range);
    const dateStr = rideDate.toLocaleDateString(uiLoc());

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
        `${r.owner ? ` · ${esc(r.owner)}` : ""}${r.dist > 10 ? ` · ${T("fromTrack", r.dist)}` : ` · ${T("onTrack")}`}` +
        `${multi ? `<br><b>${esc(T("passages", r.kms.length, kmList))}</b>` : ""}</div>
         ${consTxt ? `<div class="cons">${hard ? "<em>" : ""}${esc(consTxt)}${hard ? "</em>" : ""}</div>` : ""}
         <span class="chip">${T("activeOn", dateStr)}</span>${hard ? `<span class="hardtag">${T("blockTag")}</span>` : ""}
         <div class="alt-box">
           <button type="button" class="btn-alt">${T("suggestAlt")}</button>
           <div class="alt-result" hidden></div>
         </div></div>`;

      const popup = `<b>km ${kmList} — ${esc(r.desc)}</b><br>${GIPOD.fmtDate(r.start)} → ${GIPOD.fmtDate(r.end)}<br>${esc(consTxt)}`;
      /* de getroffen zone zelf, zoals op geopunt.be/hinder-in-kaart */
      const zone = L.geoJSON(r.geom, {
        style: { color: hard ? "#A61E04" : "#D9480F", weight: 3, opacity: .9, fillColor: "#E8590C", fillOpacity: .35 },
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 2, fillColor: "#D9480F", fillOpacity: .95 })
      }).addTo(hinderLayer).bindPopup(popup);
      const b0 = zone.getBounds(), ctr = b0.isValid() ? b0.getCenter() : L.latLng(r.lat, r.lon);
      const dot = L.circleMarker(ctr, { radius: 5, color: "#fff", weight: 1.5, fillColor: hard ? "#A61E04" : "#D9480F", fillOpacity: .95 })
        .addTo(hinderLayer).bindPopup(popup);
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

      const altBtn = el.querySelector(".btn-alt"), altResult = el.querySelector(".alt-result");
      altBtn.addEventListener("click", ev => { ev.stopPropagation(); suggestAlternative(r, altBtn, altResult); });

      return el;
    };

    const forWho = view.modes.size === 3 ? "" : T("forUsers", modesLabelL(view.modes, repLang()));
    if (!view.list.length) {
      out.innerHTML = view.onlyHard
        ? `<div class="empty"><span class="empty-icon">🎉</span><strong>${T("noBlocksTitle", forWho)}</strong><br>${T("noBlocksBody", scope, dateStr)}</div>`
        : `<div class="empty"><span class="empty-icon">🎉</span><strong>${T("freeTitle", forWho)}</strong><br>${T("freeBody", scope, dateStr)}</div>`;
    } else {
      out.appendChild(segRow());
      const h = document.createElement("h2");
      h.textContent = (view.onlyHard || view.filterHard)
        ? T("hdrBlocks", forWho, scope, dateStr, shown.length)
        : T("hdrAll", forWho, scope, dateStr, shown.length);
      out.appendChild(h);
      if (!shown.length) {
        out.insertAdjacentHTML("beforeend",
          `<div class="empty"><span class="empty-icon">👍</span><strong>${T("noBlocksSub")}</strong><br>${T("noBlocksFiltered", view.list.length)}</div>`);
      } else {
        shown.forEach(r => out.appendChild(mk(r)));
        out.insertAdjacentHTML("beforeend", `<p class="dutch-note">${T("dutchNote")}</p>`);
      }
    }
    if (truncated) {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = T("truncNote");
      out.appendChild(p);
    }
  }

  /* ---------------- omleidingsvoorstel (BRouter) ----------------
     Zoekt een fietsroute die de getroffen zone vermijdt tussen een punt
     ruim vóór en ruim ná de werf, en toont die als voorstel op de kaart
     vóórdat de gebruiker hem effectief overneemt.
     Een route kan dezelfde zone op meerdere, ver uit elkaar liggende
     plekken kruisen (bv. een lus die dezelfde straat twee keer neemt).
     Elke doortocht krijgt daarom zijn EIGEN lokale omleiding — anders zou
     de omleiding van de eerste tot de laatste doortocht lopen en een groot,
     onschuldig stuk route ertussenin overbodig meesturen. */
  async function suggestAlternative(r, btn, resultBox) {
    detourLayer.clearLayers();
    /* een eerder open voorstel op een andere kaart sluiten */
    document.querySelectorAll(".btn-alt[hidden]").forEach(b => { b.hidden = false; b.disabled = false; });
    document.querySelectorAll(".alt-result").forEach(box => { if (box !== resultBox) { box.hidden = true; box.innerHTML = ""; } });

    const origLabel = btn.textContent;
    btn.disabled = true; btn.textContent = T("altLoading");
    resultBox.hidden = true; resultBox.innerHTML = "";

    try {
      const zone = Geom.geomCenterRadius(r.geom);
      if (!zone) throw new Error("geen zone-geometrie");
      const bufferKm = Math.max(0.25, zone.radius / 1000 + 0.15);

      /* per doortocht een lokaal [lo,hi]-indexbereik; overlappende bereiken
         (doortochten die dicht bij elkaar liggen) worden samengevoegd */
      const ranges = [];
      for (const km of [...r.kms].sort((a, b) => a - b)) {
        const kmFrom = Math.max(0, km - bufferKm), kmTo = Math.min(route.km, km + bufferKm);
        let lo = Geom.nearestIndex(route.rawPts, Geom.pointAtChain(route, kmFrom * 1000));
        let hi = Geom.nearestIndex(route.rawPts, Geom.pointAtChain(route, kmTo * 1000));
        if (lo > hi) [lo, hi] = [hi, lo];
        if (hi - lo < 2) continue;
        const last = ranges[ranges.length - 1];
        if (last && lo <= last.hi) last.hi = Math.max(last.hi, hi);
        else ranges.push({ lo, hi });
      }
      if (!ranges.length) throw new Error("geen bruikbaar segment");

      const detours = [];
      for (const rg of ranges) {
        const d = await Brouter.route(route.rawPts[rg.lo], route.rawPts[rg.hi], zone.lat, zone.lon, zone.radius);
        let pts = d.pts, eles = d.eles, hi = rg.hi;
        /* raakt de omleiding je eigen track al vroeger terug dan het
           geplande eindpunt, dan hervat de route daar i.p.v. verderop */
        const rejoin = Geom.earlyRejoin(pts, route.rawPts, rg.lo, rg.hi);
        if (rejoin) {
          pts = pts.slice(0, rejoin.detourIdx + 1);
          eles = eles ? eles.slice(0, rejoin.detourIdx + 1) : null;
          hi = rejoin.rawIdx;
        }
        detours.push({ lo: rg.lo, hi, pts, eles, lengthM: Geom.pathLength(pts) });
      }

      let deltaKm = 0;
      for (const d of detours) {
        const bypassed = route.rawPts.slice(d.lo, d.hi + 1);
        deltaKm += (d.lengthM - Geom.pathLength(bypassed)) / 1000;
        L.polyline(bypassed, { color: "#5A6258", weight: 4, opacity: .85, dashArray: "2 7" }).addTo(detourLayer);
        L.polyline(d.pts, { color: "#FFD43B", weight: 5, opacity: .95, dashArray: "1 7" })
          .addTo(detourLayer).bindTooltip(T("altPreviewTip"));
      }
      map.fitBounds(L.featureGroup(detourLayer.getLayers()).getBounds().pad(0.4));

      btn.hidden = true;
      resultBox.hidden = false;
      resultBox.innerHTML = `<p>${esc(T("altFound", deltaKm))}</p>
        <div class="alt-actions">
          <button type="button" class="btn-alt-accept">${T("altAccept")}</button>
          <button type="button" class="btn-alt-discard">${T("altDiscard")}</button>
        </div>`;
      resultBox.querySelector(".btn-alt-accept").addEventListener("click", ev => {
        ev.stopPropagation();
        acceptAlternative(detours, resultBox);
      });
      resultBox.querySelector(".btn-alt-discard").addEventListener("click", ev => {
        ev.stopPropagation();
        detourLayer.clearLayers();
        resultBox.hidden = true; resultBox.innerHTML = "";
        btn.hidden = false; btn.disabled = false; btn.textContent = origLabel;
      });
    } catch (e) {
      resultBox.hidden = false;
      resultBox.innerHTML = `<p class="alt-error">${esc(T("altFail"))}</p>`;
      btn.disabled = false; btn.textContent = origLabel;
    }
  }

  /* Splitst elke lokale omleiding in de route (van hoge naar lage index,
     zodat eerder bepaalde indices geldig blijven), bouwt alle afgeleide
     routedata opnieuw op en herhaalt de controle zodat werven,
     hoogteprofiel en strook meteen kloppen met het nieuwe tracé. */
  async function acceptAlternative(detours, resultBox) {
    resultBox.innerHTML = `<p>${esc(T("altApplying"))}</p>`;
    let newRawPts = route.rawPts.slice();
    let newRawEles = route.rawEles ? route.rawEles.slice() : null;
    for (const d of [...detours].sort((a, b) => b.lo - a.lo)) {
      newRawPts = [...newRawPts.slice(0, d.lo + 1), ...d.pts.slice(1, -1), ...newRawPts.slice(d.hi)];
      newRawEles = (newRawEles && d.eles)
        ? [...newRawEles.slice(0, d.lo + 1), ...d.eles.slice(1, -1), ...newRawEles.slice(d.hi)]
        : null;
    }
    const name = route.name;
    route = Geom.buildRoute(newRawPts, name);
    route.rawPts = newRawPts;
    route.rawEles = newRawEles;
    route.profile = undefined;
    route.modified = true;
    detourLayer.clearLayers();
    drawRoute();
    $("routeinfo").innerHTML = T("routeInfo", esc(route.name), route.km.toFixed(1), route.tiles.length);
    $("footroute").textContent = T("footRoute", route.name, route.km.toFixed(1), newRawPts.length);
    initSections();
    await run();
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
<title>RouteScout-rapport — ${esc(route.name)}</title>
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
<h1>ROUTE<span>SCOUT</span> — rapport</h1>
<p class="sub"><b>${esc(route.name)}</b> · ${route.km.toFixed(1)} km · ritdatum <b>${dateStr}</b> · zoekafstand ${scope}${view.modes.size !== 3 ? ` · <b>weggebruikers: ${modesLabel(view.modes)}</b>` : ""}${view.onlyHard ? " · <b>filter: enkel blokkades ⛔</b>" : ""} · gemaakt op ${now}</p>
<div class="box">${mapSvg}</div>
<div class="box">${stripSvg}</div>
${list.length ? rows : `<div class="ok">🎉 <b>${view.onlyHard ? "Geen blokkades!" : "Vrije baan!"}</b> ${view.onlyHard ? "Geen afsluitingen of omleidingen op deze route op " + dateStr + " (lichtere hinder niet berekend)." : "Geen hinder gevonden op deze route op " + dateStr + "."}</div>`}
${truncated ? `<p class="sub">⚠ Minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig.</p>` : ""}
<footer>Bron: GIPOD open data (geo.api.vlaanderen.be), dezelfde bron als geopunt.be/hinder-in-kaart — enkel Vlaanderen.
Gegenereerd met RouteScout; de situatie kan wijzigen, controleer kort voor vertrek opnieuw.</footer>
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
  async function buildMapImage(list, RL) {
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
    const at = RL.osmAttr;
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

  /* ---------------- rapporttaal (NL/EN) ---------------- */
  const REPL = {
    nl: {
      locale: "nl-BE",
      compass: ["N","NNO","NO","ONO","O","OZO","ZO","ZZO","Z","ZZW","ZW","WZW","W","WNW","NW","NNW"],
      wmo: c => c === 0 ? "helder" : c <= 2 ? "licht bewolkt" : c === 3 ? "bewolkt"
        : c <= 48 ? "mist" : c <= 57 ? "motregen" : c <= 67 ? "regen" : c <= 77 ? "sneeuw"
        : c <= 82 ? "buien" : c <= 86 ? "sneeuwbuien" : "onweer mogelijk",
      modes: { bike: "fietsers", ped: "voetgangers", motor: "gemotoriseerd verkeer" }, allUsers: "alle weggebruikers",
      rapport: " — RAPPORT",
      info1: (name, km, d) => `${name} · ${km} km · ritdatum ${d}`,
      searchDist: r => `zoekafstand ${r === 0 ? "0 m (enkel op de route zelf)" : "±" + r + " m"}`,
      usersLbl: t => `weggebruikers: ${t}`, filterHardTxt: "filter: enkel blokkades",
      madeOn: t => `gemaakt\u00A0op\u00A0${t}`,
      freeTitle: "Vrije baan!", freeBody: d => `Geen hinder gevonden op deze route op ${d}. Goede rit!`,
      noBlocksTitle: "Geen blokkades!", noBlocksBody: d => `Geen afsluitingen of omleidingen op deze route op ${d} (lichtere hinder niet berekend).`,
      kmLbl: "KM", kmMulti: n => `${n}x KM`, blockTag: "[BLOKKADE]",
      onTrack: "op de track", fromTrack: d => `${d} m van de track`,
      passages: l => `Passages: km ${l}`, viewMap: "Bekijk op kaart",
      truncNote: "Let op: minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig.",
      secClimbs: "HOOGTEPROFIEL & KLIMMEN", secWeather: "WEERSVOORSPELLING",
      noEle: "Geen hoogtedata beschikbaar: de GPX bevat geen hoogtes en de hoogtedienst was niet bereikbaar. Exporteer je route met hoogteprofiel (Komoot/Strava doen dit standaard) en maak het rapport opnieuw.",
      profStats: (asc, km, min, max, n) => `Totaal ${asc} hoogtemeters over ${km} km · laagste punt ${min} m · hoogste punt ${max} m · ${n} ${n === 1 ? "klim" : "klimmen"} gedetecteerd.`,
      flat: "Een vlak tot golvend parcours zonder noemenswaardige klimmen — hier wint de groep die uit de wind blijft, niet de klimmer.",
      climbTitle: (i, a, b) => `Klim ${i} — km ${a} -> km ${b}`,
      climbStats: (l, g, a, m) => `${l} km lang · ${g} hoogtemeters · gem. ${a}% · max. ${m}%`,
      noWeather: "De weersvoorspelling kon niet opgehaald worden (geen internetverbinding of dienst onbereikbaar). Raadpleeg je weerapp voor vertrek.",
      forecastFor: (wd, ride, cond, range) => `Voorspelling voor ${wd}${ride ? " (je ritdatum)" : ""}${range ? ` tussen ${range[0]} en ${range[1]}` : ""} — ${cond}`,
      wTemp: (a, b) => `Temperatuur: ${a}° tot ${b}°C`,
      wPrecip: (p, s) => `Neerslagkans: ${p}%  ·  neerslag: ${s} mm`,
      wWind: (v, dir, g) => `Wind: ${v} km/u uit ${dir} (rukwinden tot ${g} km/u)`,
      kmh: "km/u",
      wCloud: c => `Bewolking: gemiddeld ${c}%`,
      wSrc: t => `Bron: Open-Meteo.com · locatie: middelpunt van de route · opgehaald op ${t}`,
      osmAttr: "© OpenStreetMap-bijdragers",
      weatherStory: (tmin, tmax, cond, pp, psum, cloud, windV, gust, dir) => {
        const temp = tmin === tmax ? `zo'n ${tmax}°C` : `tussen ${tmin}° en ${tmax}°C`;
        const sky = cloud >= 70 ? `onder een grijze wolkendeken (${cloud}% bedekking)` : cloud <= 25 ? `onder een vrijwel blauwe lucht (${cloud}% bewolking)` : `met wisselende bewolking (${cloud}%)`;
        const rain = pp >= 60 ? `Met ${pp}% kans op neerslag en zo'n ${psum} mm verwacht, is een regenjasje geen overbodige luxe.`
          : pp >= 30 ? `Een bui is niet helemaal uitgesloten (${pp}% kans), maar het blijft grotendeels droog.`
          : "Regen lijkt erg onwaarschijnlijk, het blijft de hele rit droog.";
        const wind = windV < 12 ? `De wind waait amper ${windV} km/u en speelt nauwelijks een rol in hoe de rit aanvoelt.`
          : `Reken op zo'n ${windV} km/u uit ${dir}, met rukwinden tot ${gust} km/u die je op open stukken zal voelen.`;
        const tip = tmax <= 10 ? "Trek een extra laagje aan, want het blijft fris tijdens de hele rit."
          : tmax >= 25 ? "Denk aan voldoende water, want de temperatuur loopt op richting warm."
          : "Al bij al aangename, fietsvriendelijke temperaturen.";
        return `Het wordt ${cond}, ${temp} ${sky}. ${rain} ${wind} ${tip}`;
      },
      hourlyHeader: "Uur per uur",
      windHeader: "De wind onderweg",
      rain60: " Grote kans op neerslag: neem een regenjasje mee.",
      rain30: " Een bui is niet uitgesloten; een windvestje kan geen kwaad.",
      footer: "Bron: GIPOD open data (geo.api.vlaanderen.be), zelfde bron als geopunt.be/hinder-in-kaart — enkel Vlaanderen. Controleer kort voor vertrek opnieuw.",
      calm: v => `Met hooguit ${v} km/u wind speelt de windrichting vandaag nauwelijks een rol — een dag om van te profiteren.`,
      windFrom: (d, v) => `De wind komt uit ${d} (${v} km/u): `,
      verbs: { tegen: ["zit de wind pal tegen", "rijd je vol in de wind", "moet je tegen de wind opboksen"],
               mee: ["duwt hij je in de rug", "heb je hem lekker mee", "surf je op de wind"],
               zij: ["staat hij dwars op de weg", "komt hij van opzij", "waait het dwars over de weg"] },
      rStart: to => `van de start tot km ${to}`, rEnd: f => `van km ${f} tot de aankomst`, rMid: (a, b) => `van km ${a} tot km ${b}`,
      moreLegs: "; daarna wisselt het nog enkele keren",
      windTotals: (t, m, z) => `Alles samen: zo'n ${t} km tegenwind, ${m} km meewind en ${z} km zijwind.`,
      finMee: " Goed nieuws voor de finale: de laatste kilometers heb je de wind in de rug.",
      finTegen: " Hou een reserve over: de slotkilometers gaan tegen de wind in.",
      cOpen: { vroeg: ["Amper op gang en daar is de eerste hindernis al.", "De rit kleurt meteen bergop — deze pak je met frisse benen.", "Vroeg in de rit: ideaal om het klimritme te vinden."],
               mid: ["Halverwege de lus duikt deze helling op.", "Midden in de rit wacht deze inspanning.", "Net wanneer je in je ritme zit, buigt de weg hier omhoog."],
               finale: ["Diep in de finale, op verzuurde benen, wacht deze klim.", "Deze komt wanneer het pijn doet: in de slotfase.", "Met de streep in zicht moet je hier nog één keer vol aan de bak."] },
      cChar: [["Meer vals plat dan echte klim: het venijn zit in het tempo, niet in de stijging.", "Een tapijt dat traag omhoog rolt — verraderlijk, juist omdat je hem amper ziet.", "Geleidelijk oplopend; wie hier te gretig rijdt, betaalt verderop de rekening."],
              ["Een eerlijke, gelijkmatige klim waarop een vast tempo loont.", "Mooi regelmatig stijgen: zoek je cadans en hou die vast tot boven.", "Klassiek klimwerk zonder verrassingen — een kwestie van doseren."],
              ["Stevig klimwerk dat kracht vraagt; schakel terug vóór de voet.", "Hier wordt geselecteerd: de helling bijt stevig door.", "Een pittige strook waar lichte verzetten goud waard zijn."],
              ["Een regelrechte muur — uit het zadel en doorbijten.", "Kort lontje, veel dynamiet: dit loopt venijnig steil op.", "Scherprechter van formaat; te groot verzet en je staat stil."]],
      cRitme: [" Het percentage danst voortdurend: vals plat wisselt met venijnige ramps.", " Geen twee hectometers zijn gelijk — schakelen, schakelen, schakelen.", " Onregelmatig van profiel: bewaar marge voor de steile stroken."],
      cPiek: (m, at) => [` Rond km ${at} piekt de helling tot zo'n ${m}%.`, ` De zwaarste meters (~${m}%) liggen bij km ${at}.`, ` Let op de ramp van ~${m}% ter hoogte van km ${at}.`],
      cLong: " Ruim drie kilometer klimmen: verdeel je krachten.", cShort: " Kort en krachtig — op momentum te nemen.",
      cHardest: " Dit is de scherprechter van de dag.", cLongest: " Met afstand de langste beklimming van de route.",
      cBackToBack: " Hij volgt kort op de vorige klim — veel herstel krijg je niet.",
      cSlot: t => [`Boven, op ${t} m, kun je even doorademen.`, `De top ligt op ${t} m.`, `Bovenaan wacht ${t} m — en heel even respijt.`]
    },
    en: {
      locale: "en-GB",
      compass: ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"],
      wmo: c => c === 0 ? "clear" : c <= 2 ? "partly cloudy" : c === 3 ? "overcast"
        : c <= 48 ? "fog" : c <= 57 ? "drizzle" : c <= 67 ? "rain" : c <= 77 ? "snow"
        : c <= 82 ? "showers" : c <= 86 ? "snow showers" : "thunderstorms possible",
      modes: { bike: "cyclists", ped: "pedestrians", motor: "motorised traffic" }, allUsers: "all road users",
      rapport: " — REPORT",
      info1: (name, km, d) => `${name} · ${km} km · ride date ${d}`,
      searchDist: r => `search distance ${r === 0 ? "0 m (route itself only)" : "±" + r + " m"}`,
      usersLbl: t => `road users: ${t}`, filterHardTxt: "filter: blockages only",
      madeOn: t => `generated\u00A0on\u00A0${t}`,
      freeTitle: "All clear!", freeBody: d => `No disruptions found on this route on ${d}. Enjoy the ride!`,
      noBlocksTitle: "No blockages!", noBlocksBody: d => `No closures or diversions on this route on ${d} (lighter disruptions were not calculated).`,
      kmLbl: "KM", kmMulti: n => `${n}x KM`, blockTag: "[BLOCKAGE]",
      onTrack: "on the track", fromTrack: d => `${d} m from the track`,
      passages: l => `Passages: km ${l}`, viewMap: "View on map",
      truncNote: "Note: at least one sub-area hit the 1000-object limit; results may be incomplete.",
      secClimbs: "ELEVATION PROFILE & CLIMBS", secWeather: "WEATHER FORECAST",
      noEle: "No elevation data available: the GPX contains no altitudes and the elevation service could not be reached. Export your route with elevation (Komoot/Strava include it by default) and regenerate the report.",
      profStats: (asc, km, min, max, n) => `Total ${asc} m of climbing over ${km} km · lowest point ${min} m · highest point ${max} m · ${n} climb${n === 1 ? "" : "s"} detected.`,
      flat: "A flat to rolling course without any notable climbs — the group that stays out of the wind wins here, not the climber.",
      climbTitle: (i, a, b) => `Climb ${i} — km ${a} -> km ${b}`,
      climbStats: (l, g, a, m) => `${l} km long · ${g} m of gain · avg. ${a}% · max. ${m}%`,
      noWeather: "The weather forecast could not be retrieved (no internet connection or service unavailable). Check your weather app before departure.",
      forecastFor: (wd, ride, cond, range) => `Forecast for ${wd}${ride ? " (your ride date)" : ""}${range ? ` between ${range[0]} and ${range[1]}` : ""} — ${cond}`,
      wTemp: (a, b) => `Temperature: ${a}° to ${b}°C`,
      wPrecip: (p, s) => `Chance of rain: ${p}%  ·  precipitation: ${s} mm`,
      wWind: (v, dir, g) => `Wind: ${v} km/h from ${dir} (gusts up to ${g} km/h)`,
      kmh: "km/h",
      wCloud: c => `Cloud cover: average ${c}%`,
      wSrc: t => `Source: Open-Meteo.com · location: midpoint of the route · retrieved on ${t}`,
      osmAttr: "© OpenStreetMap contributors",
      weatherStory: (tmin, tmax, cond, pp, psum, cloud, windV, gust, dir) => {
        const temp = tmin === tmax ? `around ${tmax}°C` : `between ${tmin}° and ${tmax}°C`;
        const sky = cloud >= 70 ? `under a grey blanket of cloud (${cloud}% cover)` : cloud <= 25 ? `under largely blue skies (${cloud}% cloud)` : `with variable cloud cover (${cloud}%)`;
        const rain = pp >= 60 ? `With a ${pp}% chance of rain and around ${psum} mm expected, a rain jacket isn't a bad idea.`
          : pp >= 30 ? `A shower can't quite be ruled out (${pp}% chance), but it should mostly stay dry.`
          : "Rain looks very unlikely, so it should stay dry for the whole ride.";
        const wind = windV < 12 ? `The wind barely blows at ${windV} km/h and hardly plays a role in how the ride feels.`
          : `Expect a steady ${windV} km/h from the ${dir}, with gusts up to ${gust} km/h you'll notice on exposed stretches.`;
        const tip = tmax <= 10 ? "Pack an extra layer, it stays chilly for the whole ride."
          : tmax >= 25 ? "Bring plenty of water, temperatures climb into warm territory."
          : "All in all, pleasant, ride-friendly temperatures.";
        return `It'll be ${cond}, ${temp} ${sky}. ${rain} ${wind} ${tip}`;
      },
      hourlyHeader: "Hour by hour",
      windHeader: "The wind along the way",
      rain60: " High chance of rain: pack a rain jacket.",
      rain30: " A shower can't be ruled out; a wind vest won't hurt.",
      footer: "Source: GIPOD open data (geo.api.vlaanderen.be), same source as geopunt.be/hinder-in-kaart — Flanders only. Check again shortly before departure.",
      calm: v => `With at most ${v} km/h of wind, wind direction hardly matters today — a day to make the most of.`,
      windFrom: (d, v) => `The wind blows from the ${d} (${v} km/h): `,
      verbs: { tegen: ["you ride straight into a headwind", "the wind is dead against you", "you battle a headwind"],
               mee: ["it pushes you along", "you enjoy a tailwind", "you surf the tailwind"],
               zij: ["it blows across the road", "you get a crosswind", "it comes at you from the side"] },
      rStart: to => `from the start to km ${to}`, rEnd: f => `from km ${f} to the finish`, rMid: (a, b) => `from km ${a} to km ${b}`,
      moreLegs: "; after that it keeps switching a few more times",
      windTotals: (t, m, z) => `All in all: roughly ${t} km of headwind, ${m} km of tailwind and ${z} km of crosswind.`,
      finMee: " Good news for the finale: the last kilometres come with a tailwind.",
      finTegen: " Keep something in reserve: the closing kilometres go into the wind.",
      cOpen: { vroeg: ["Barely warmed up and the first obstacle is already there.", "The ride tilts uphill right away — you take this one on fresh legs.", "Early in the ride: ideal for finding your climbing rhythm."],
               mid: ["Halfway around the loop this climb appears.", "Mid-ride, this effort awaits.", "Just as you settle into a rhythm, the road bends upwards here."],
               finale: ["Deep in the finale, on tired legs, this climb awaits.", "This one comes when it hurts: in the closing stages.", "With the finish in sight you have to dig deep one more time."] },
      cChar: [["More false flat than a real climb: the sting is in the pace, not the gradient.", "A carpet that rolls slowly upwards — treacherous precisely because you barely see it.", "A gradual rise; ride it too eagerly and you pay for it later."],
              ["An honest, even climb where a steady tempo pays off.", "Nicely regular climbing: find your cadence and hold it to the top.", "Classic climbing without surprises — a matter of pacing."],
              ["Solid climbing that demands strength; shift down before the foot of it.", "Selection happens here: the gradient bites hard.", "A punchy stretch where light gears are worth gold."],
              ["An outright wall — out of the saddle and grind through.", "Short fuse, lots of dynamite: this ramps up viciously.", "A brutal leg-breaker; pick too big a gear and you grind to a halt."]],
      cRitme: [" The gradient dances constantly: false flat alternates with vicious ramps.", " No two hectometres are alike — shift, shift, shift.", " Irregular in profile: keep a margin for the steep sections."],
      cPiek: (m, at) => [` Around km ${at} the gradient peaks at about ${m}%.`, ` The hardest metres (~${m}%) sit near km ${at}.`, ` Watch out for the ~${m}% ramp around km ${at}.`],
      cLong: " More than three kilometres of climbing: spread your effort.", cShort: " Short and sharp — take it on momentum.",
      cHardest: " This is the judge of the day.", cLongest: " By far the longest climb of the route.",
      cBackToBack: " It follows hot on the heels of the previous climb — recovery is scarce.",
      cSlot: t => [`At the top, at ${t} m, you can breathe again.`, `The summit sits at ${t} m.`, `Up top, ${t} m awaits — and a brief respite.`]
    }
  };
  const repLang = () => REPL[(window.I18N && I18N.lang === "en") ? "en" : "nl"];
  /* FIX 4: WMO-weercode -> icoon; emoji sluit aan bij de bestaande
     emoji-iconografie van de site (lagen, hoofdstukken) en werkt offline. */
  const wmoIcon = c => c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️"
    : c <= 48 ? "🌫️" : c <= 57 ? "🌦️" : c <= 67 ? "🌧️" : c <= 77 ? "❄️"
    : c <= 82 ? "🌦️" : c <= 86 ? "🌨️" : "⛈️";
  const compassL = (deg, RL) => RL.compass[Math.round(deg / 22.5) % 16];

  /* Weersvoorspelling van Open-Meteo voor het middelpunt van de route.
     We tonen de voorspelling voor de ritdatum als die binnen het
     voorspellingsbereik (±15 dagen) valt, anders voor vandaag.
     Zijn startuur én einduur gekend, dan halen we het UURlijkse weer op en
     middelen/aggregeren we enkel over de uren dat je effectief onderweg bent
     — nauwkeuriger dan de dagvoorspelling. Anders valt dit terug op het
     daggemiddelde/-maximum zoals voorheen. */
  async function fetchWeather(forDate, startStr, endStr) {
    const lats = route.pts.map(p => p[0]), lons = route.pts.map(p => p[1]);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const ahead = Math.round((forDate - today) / 864e5);
    const target = (ahead >= 0 && ahead <= 15) ? forDate : today;
    const iso = target.toLocaleDateString("en-CA");
    const isRideDate = target !== today || ahead === 0;

    const startH = toDecHour(startStr), endH = toDecHour(endStr);
    const hasRange = startH !== null && endH !== null && endH > startH;
    if (hasRange) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
        `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,` +
        `wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover` +
        `&timezone=Europe%2FBrussels&start_date=${iso}&end_date=${iso}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error("weerdienst " + r.status);
      const h = (await r.json()).hourly;
      /* uurvakken die de rit (deels) overlappen */
      const idx = [];
      for (let i = 0; i < h.time.length; i++) if (i + 1 > startH && i < endH) idx.push(i);
      if (!idx.length) idx.push(Math.min(h.time.length - 1, Math.max(0, Math.round(startH))));
      const pick = arr => idx.map(i => arr[i]);
      const temps = pick(h.temperature_2m), winds = pick(h.wind_speed_10m), gusts = pick(h.wind_gusts_10m);
      const dirs = pick(h.wind_direction_10m), precs = pick(h.precipitation), pps = pick(h.precipitation_probability);
      const clouds = pick(h.cloud_cover), codes = pick(h.weather_code);
      const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
      /* vectorgemiddelde windrichting, gewogen met windsnelheid — voorkomt
         onzin rond de 0°/360°-grens bij een gewone rekenkundige gemiddelde */
      let vx = 0, vy = 0;
      dirs.forEach((d, i) => { const rad = d * Math.PI / 180, w = winds[i] || .01; vx += Math.cos(rad) * w; vy += Math.sin(rad) * w; });
      let dir = Math.atan2(vy, vx) * 180 / Math.PI; if (dir < 0) dir += 360;
      /* per-uur detail voor de grafische tijdlijn */
      const hours = idx.map(i => ({
        time: h.time[i], temp: h.temperature_2m[i], code: h.weather_code[i],
        wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], dir: h.wind_direction_10m[i]
      }));
      return {
        date: target, isRideDate, hourly: true, rangeStart: startStr, rangeEnd: endStr, hours,
        tmax: Math.max(...temps), tmin: Math.min(...temps),
        wind: avg(winds), gust: Math.max(...gusts), dir,
        pp: Math.max(...pps), psum: precs.reduce((s, v) => s + v, 0),
        cloud: avg(clouds), code: Math.max(...codes)
      };
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,` +
      `wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,cloud_cover_mean` +
      `&timezone=Europe%2FBrussels&start_date=${iso}&end_date=${iso}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("weerdienst " + r.status);
    const d = (await r.json()).daily;
    return {
      date: target, isRideDate, hourly: false,
      tmax: d.temperature_2m_max[0], tmin: d.temperature_2m_min[0],
      wind: d.wind_speed_10m_max[0], gust: d.wind_gusts_10m_max[0],
      dir: d.wind_direction_10m_dominant[0],
      pp: d.precipitation_probability_max[0], psum: d.precipitation_sum[0],
      cloud: d.cloud_cover_mean[0], code: d.weather_code[0]
    };
  }

  /* Windrol per wegvak: rijrichting vs. dominante windrichting. */
  function windLegs(windDir) {
    const step = 750, total = route.km * 1000;
    const cls = [];
    for (let d = 0; d < total - step; d += step) {
      const a = Geom.pointAtChain(route, d), b = Geom.pointAtChain(route, d + step);
      const dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), dy = b[0] - a[0];
      let bearing = Math.atan2(dx, dy) * 180 / Math.PI; if (bearing < 0) bearing += 360;
      let diff = Math.abs(((bearing - windDir) % 360 + 360) % 360); if (diff > 180) diff = 360 - diff;
      cls.push(diff <= 60 ? "tegen" : diff >= 120 ? "mee" : "zij");
    }
    let legs = [];
    cls.forEach((c, i) => {
      const from = i * step / 1000, to = from + step / 1000;
      if (legs.length && legs[legs.length - 1].c === c) legs[legs.length - 1].to = to;
      else legs.push({ c, from, to });
    });
    const out = [];
    for (const l of legs) {
      if (out.length && l.to - l.from < 2.5) out[out.length - 1].to = l.to;
      else if (out.length && out[out.length - 1].c === l.c) out[out.length - 1].to = l.to;
      else out.push({ ...l });
    }
    legs = [];
    for (const l of out) {
      if (legs.length && legs[legs.length - 1].c === l.c) legs[legs.length - 1].to = l.to;
      else legs.push(l);
    }
    return legs;
  }

  /* Verhaal over de wind onderweg, in de gekozen rapporttaal. */
  function windStory(w, RL) {
    if (w.wind < 12) return RL.calm(Math.round(w.wind));
    const legs = windLegs(w.dir);
    const tot = { tegen: 0, mee: 0, zij: 0 };
    legs.forEach(l => tot[l.c] += l.to - l.from);
    const seg = legs.slice(0, 6).map((l, i) => {
      const range = l.from < 0.5 ? RL.rStart(l.to.toFixed(0))
        : l.to > route.km - 0.7 ? RL.rEnd(l.from.toFixed(0))
        : RL.rMid(l.from.toFixed(0), l.to.toFixed(0));
      return `${range} ${RL.verbs[l.c][i % 3]}`;
    }).join("; ");
    const extra = legs.length > 6 ? RL.moreLegs : "";
    const som = RL.windTotals(Math.round(tot.tegen), Math.round(tot.mee), Math.round(tot.zij));
    const finale = legs.length && legs[legs.length - 1].c === "mee" ? RL.finMee
      : legs.length && legs[legs.length - 1].c === "tegen" ? RL.finTegen : "";
    return `${RL.windFrom(compassL(w.dir, RL), Math.round(w.wind))}${seg}${extra}. ${som}${finale}`;
  }

  /* Korte, gegevens-gedreven samenvatting van weer én wind tijdens de rit
     (los van het gedetailleerde per-wegvak windverhaal hierboven/-onder). */
  function weatherStory(w, RL) {
    return RL.weatherStory(Math.round(w.tmin), Math.round(w.tmax), RL.wmo(w.code),
      Math.round(w.pp ?? 0), (w.psum ?? 0).toFixed(1), Math.round(w.cloud),
      Math.round(w.wind), Math.round(w.gust), compassL(w.dir, RL));
  }

  /* Gevarieerd karakterportret van een klim, in de gekozen rapporttaal. */
  function climbStory(c, i, climbs, RL) {
    const pick = (arr, seed) => arr[seed % arr.length];
    const s = i;
    const pos = c.startKm < route.km * .3 ? "vroeg" : c.startKm > route.km * .7 ? "finale" : "mid";
    const open = pick(RL.cOpen[pos], s);
    const band = c.avg < 3.5 ? 0 : c.avg < 6 ? 1 : c.avg < 9 ? 2 : 3;
    const karakter = pick(RL.cChar[band], s);
    const ritme = c.irregular ? pick(RL.cRitme, s) : "";
    const piek = c.max >= c.avg + 2 ? pick(RL.cPiek(c.max.toFixed(0), c.maxAt.toFixed(1)), s) : "";
    const lente = c.lenKm >= 3 ? RL.cLong : c.lenKm <= 0.6 ? RL.cShort : "";
    let context = "";
    const score = x => x.gain * x.avg;
    if (climbs.length > 1 && score(c) === Math.max(...climbs.map(score))) context += RL.cHardest;
    if (climbs.length > 1 && c.lenKm === Math.max(...climbs.map(x => x.lenKm)) && c.lenKm >= 1.5 && score(c) !== Math.max(...climbs.map(score)))
      context += RL.cLongest;
    if (i > 0 && c.startKm - climbs[i - 1].endKm < 3) context += RL.cBackToBack;
    const slot = pick(RL.cSlot(c.topEle), s + 1);
    return `${open} ${karakter}${ritme}${piek}${lente}${context} ${slot}`.replace(/\s+/g, " ").trim();
  }

  async function buildReportPdf() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const { list, rideDate, range, truncated } = view;
    const W = 210, M = 14, CW = W - 2 * M;
    /* FIX 2: kleuren = websitepalet (css :root, "trail & terrain") */
    const INKc = [23, 33, 27], ORANGEc = [244, 89, 11], DEEPc = [217, 72, 15], HARDc = [166, 30, 4],
          MUTEDc = [90, 98, 88], ROUTEc = [47, 90, 168], OKc = [43, 138, 62], CHALKc = [234, 227, 212],
          PINEc = [30, 77, 59], SANDc = [241, 235, 221], PAPERc = [251, 248, 241];
    const RL = repLang();
    const dateStr = rideDate.toLocaleDateString(RL.locale);
    let y;
    let mapImg = null, profile = null, weather = null;
    try { mapImg = await buildMapImage(list, RL); } catch (e) { /* schematisch kaartje als vangnet */ }
    try { profile = await ensureProfile(); } catch (e) { profile = null; }
    try { weather = await fetchWeather(view.rideDate, view.startHour, view.endHour); } catch (e) { weather = null; }

    const paintPage = () => { doc.setFillColor(...SANDc); doc.rect(0, 0, W, 297, "F"); };
    /* koptekstbalk = dennengroen met gestippeld waymark-spoor (zoals de site) */
    const stripes = yy => {
      doc.setFillColor(...PINEc); doc.rect(0, yy, W, 8, "F");
      doc.setFillColor(...ORANGEc);
      for (let x = 8; x < W - 6; x += 13) doc.rect(x, yy + 3.1, 7, 1.8, "F");
    };
    const diamond = (cx, cy, r, fill) => {
      doc.setFillColor(...fill); doc.setDrawColor(...INKc); doc.setLineWidth(.4);
      doc.lines([[r, r], [-r, r], [-r, -r], [r, -r]], cx, cy - r, [1, 1], "FD", true);
    };
    /* linker accentbalk van een kaart, geclipt op de afgeronde kaartvorm zodat
       de balk niet vierkant buiten de ronde hoeken van de kaart uitsteekt */
    const cardAccent = (cx, cy, cw, ch, radius, fill) => {
      doc.saveGraphicsState();
      doc.roundedRect(cx, cy, cw, ch, radius, radius, null);
      doc.clip();
      doc.discardPath();
      doc.setFillColor(...fill);
      doc.rect(cx + .4, cy + .4, 2.4, ch - .8, "F");
      doc.restoreGraphicsState();
    };
    const newPage = () => { doc.addPage(); paintPage(); y = 18; };

    /* ---- kop ---- */
    paintPage();
    stripes(0);
    y = 20;
    doc.setFont("helvetica", "bold"); doc.setFontSize(21); doc.setTextColor(...INKc);
    doc.text("ROUTE", M, y);
    doc.setTextColor(...ORANGEc); doc.text("SCOUT", M + doc.getTextWidth("ROUTE"), y);
    doc.setTextColor(...INKc); doc.text(RL.rapport, M + doc.getTextWidth("ROUTESCOUT"), y);
    y += 7;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...MUTEDc);
    /* ook de infolijnen afbreken op paginabreedte (lange routenamen!) */
    const info1 = doc.splitTextToSize(san(RL.info1(route.name, route.km.toFixed(1), dateStr)), CW);
    doc.text(info1, M, y); y += info1.length * 4.5;
    const opts = [RL.searchDist(range)];
    const usersTxt = view.modes.size === 3 ? RL.allUsers : ["bike", "ped", "motor"].filter(m => view.modes.has(m)).map(m => RL.modes[m]).join(" + ");
    if (view.modes.size !== 3) opts.push(RL.usersLbl(usersTxt));
    if (view.onlyHard) opts.push(RL.filterHardTxt);
    opts.push(RL.madeOn(new Date().toLocaleString(RL.locale, { dateStyle: "short", timeStyle: "short" }).replace(/ /g, "\u00A0")));
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
    doc.setFillColor(...PAPERc); doc.setDrawColor(...INKc); doc.setLineWidth(.6);
    doc.roundedRect(M, y, CW, 14, 3, 3, "FD");
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
      doc.text(view.onlyHard ? RL.noBlocksTitle : RL.freeTitle, W / 2, y + 8, { align: "center" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      doc.text(san(view.onlyHard ? RL.noBlocksBody(dateStr) : RL.freeBody(dateStr)), W / 2, y + 13.5, { align: "center" });
      y += 24;
    }
    const tX = M + 27, tW = W - M - tX - 3;   // 3 mm binnenmarge rechts
    for (const r of list) {
      const hard = isHardFor(r, view.modes);
      /* Belangrijk: splitTextToSize meet met het ACTIEVE font — dus vóór elke
         meting exact het font/formaat instellen waarmee de tekst ook wordt afgedrukt. */
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
      const titleLines = doc.splitTextToSize(san(r.desc) + (hard ? "  " + RL.blockTag : ""), tW);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
      const meta = san(`${GIPOD.fmtDate(r.start)} -> ${GIPOD.fmtDate(r.end)}${r.owner ? " · " + r.owner : ""} · ${r.dist > 10 ? RL.fromTrack(r.dist) : RL.onTrack}`);
      const metaLines = doc.splitTextToSize(meta, tW);
      const consLines = consText(r) ? doc.splitTextToSize(san(consText(r)), tW) : [];
      doc.setFont("helvetica", "bold");
      const passLines = r.kms.length > 1
        ? doc.splitTextToSize(san(RL.passages(r.kms.map(k => k.toFixed(1)).join(" · "))), tW) : [];
      const h = 8 + titleLines.length * 4.6 + metaLines.length * 3.9 + passLines.length * 3.9 + consLines.length * 3.9 + 4.5;
      if (y + h > 282) newPage();

      doc.setFillColor(...PAPERc); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
      doc.roundedRect(M, y, CW, h, 3, 3, "FD");
      cardAccent(M, y, CW, h, 3, hard ? HARDc : DEEPc);
      /* km-badge */
      doc.setDrawColor(...INKc); doc.setFillColor(...PAPERc); doc.rect(M + 6, y + 4, 17, 11, "FD");
      doc.setFillColor(...PINEc); doc.rect(M + 6, y + 4, 17, 4, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(255, 212, 59);
      doc.text(r.kms.length > 1 ? RL.kmMulti(r.kms.length) : RL.kmLbl, M + 14.5, y + 6.9, { align: "center" });
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
      doc.textWithLink(RL.viewMap, tX, ty, { url: `https://www.google.com/maps?q=${r.lat.toFixed(5)},${r.lon.toFixed(5)}` });
      y += h + 4;
    }
    if (truncated) {
      if (y > 275) newPage();
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTEDc);
      doc.text(san(RL.truncNote), M, y + 2);
      y += 7;
    }

    /* ================= SECTIE: HOOGTEPROFIEL & KLIMMEN ================= */
    /* Hoofdstukbanner: oranje icoonplaat + inktbalk met witte titel + streep */
    const mountainIcon = (cx, cy) => {
      doc.setFillColor(255, 255, 255);
      doc.triangle(cx - 5.2, cy + 3.4, cx - .8, cy - 3.8, cx + 2.4, cy + 3.4, "F");
      doc.triangle(cx + .2, cy + 3.4, cx + 3.2, cy - 1.6, cx + 5.4, cy + 3.4, "F");
      doc.setFillColor(...ORANGEc);
      doc.triangle(cx - 2.1, cy - 1.65, cx - .8, cy - 3.8, cx + .45, cy - 1.65, "F"); // sneeuwkap-uitsparing
      doc.setFillColor(255, 255, 255);
      doc.triangle(cx - 1.55, cy - 2.55, cx - .8, cy - 3.8, cx - .05, cy - 2.55, "F"); // top
    };
    const weatherIcon = (cx, cy) => {
      doc.setFillColor(255, 255, 255);
      doc.circle(cx - 2.8, cy - 2, 1.7, "F");                         // zon
      doc.setFillColor(...ORANGEc); doc.circle(cx - 1.1, cy - .6, 2.1, "F"); // wolk 'schaduw' in plaatkleur
      doc.setFillColor(255, 255, 255);
      doc.circle(cx - 1.2, cy + .8, 2.0, "F");
      doc.circle(cx + 1.4, cy + .2, 2.4, "F");
      doc.circle(cx + 3.4, cy + 1.2, 1.7, "F");
      doc.rect(cx - 1.2, cy + 1.2, 5.2, 1.8, "F");
    };
    const chapter = (title, icon) => {
      if (y > 236) newPage();
      y += 4;
      doc.setFillColor(...PINEc); doc.rect(M, y, CW, 14, "F");
      doc.setFillColor(...ORANGEc); doc.rect(M, y, 14, 14, "F");
      icon(M + 7, y + 7);
      doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(255, 255, 255);
      doc.text(title, M + 19, y + 9.6);
      y += 14;
      /* gestippeld trailspoor onder de balk (websitemotief) */
      doc.setFillColor(...PAPERc); doc.rect(M, y, CW, 2.6, "F");
      doc.setFillColor(...ORANGEc);
      for (let x = M + 3; x < M + CW - 8; x += 12) doc.rect(x, y + .6, 6.5, 1.4, "F");
      y += 10;
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

    chapter(RL.secClimbs, mountainIcon);
    if (!profile) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const noEle = doc.splitTextToSize(san(RL.noEle), CW);
      doc.text(noEle, M, y); y += noEle.length * 4 + 4;
    } else {
      const climbs = Geom.findClimbs(profile);
      /* overzichtsgrafiek van de volledige rit */
      if (y + 46 > 282) newPage();
      doc.setFillColor(...PAPERc); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
      doc.roundedRect(M, y, CW, 40, 3, 3, "FD");
      drawProfileChart(M + 3, y + 2, CW - 14, 34, profile, climbs, ROUTEc, [222, 228, 238]);
      y += 44;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...INKc);
      const stats = san(RL.profStats(profile.ascent, route.km.toFixed(1), profile.min, profile.max, climbs.length));
      const statsLines = doc.splitTextToSize(stats, CW);
      doc.text(statsLines, M, y); y += statsLines.length * 4 + 3;

      if (!climbs.length) {
        doc.setTextColor(...MUTEDc);
        const flat = doc.splitTextToSize(san(RL.flat), CW);
        doc.text(flat, M, y); y += flat.length * 4 + 4;
      }
      /* per klim: minigrafiek + portret */
      climbs.forEach((c, i) => {
        doc.setFont("helvetica", "bold"); doc.setFontSize(10);
        const titleTxt = san(RL.climbTitle(i + 1, c.startKm.toFixed(1), c.endKm.toFixed(1)));
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        const statTxt = san(RL.climbStats(c.lenKm.toFixed(2), c.gain, c.avg, c.max));
        const story = doc.splitTextToSize(san(climbStory(c, i, climbs, RL)), CW - 62);
        const h = Math.max(26, 14 + story.length * 3.9 + 3);
        if (y + h > 282) newPage();
        doc.setFillColor(...PAPERc); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
        doc.roundedRect(M, y, CW, h, 3, 3, "FD");
        cardAccent(M, y, CW, h, 3, DEEPc);
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

    /* ---- vectoriconen voor het weer (standaard-PDF-fonts kennen geen emoji) ---- */
    const GREYc = [176, 180, 170];
    const wxKind = c => c === 0 ? "sun" : c <= 2 ? "partsun" : c === 3 ? "cloud"
      : c <= 48 ? "fog" : c <= 67 ? "rain" : c <= 77 ? "snow" : c <= 82 ? "rain"
      : c <= 86 ? "snow" : "storm";
    const drawCloud = (cx, cy, s, fill) => {
      doc.setFillColor(...fill); doc.setDrawColor(...INKc); doc.setLineWidth(.35);
      doc.circle(cx - s * .55, cy + s * .15, s * .42, "FD");
      doc.circle(cx + s * .05, cy - s * .18, s * .55, "FD");
      doc.circle(cx + s * .62, cy + s * .18, s * .4, "FD");
      doc.setFillColor(...fill);
      doc.rect(cx - s * .55, cy + s * .12, s * 1.17, s * .45, "F");
      doc.setDrawColor(...INKc);
      doc.line(cx - s * .95, cy + s * .57, cx + s * 1.0, cy + s * .57);
    };
    const drawSun = (cx, cy, s) => {
      doc.setDrawColor(...ORANGEc); doc.setLineWidth(.5);
      for (let i = 0; i < 8; i++) {
        const a0 = i * Math.PI / 4;
        doc.line(cx + Math.cos(a0) * s * .62, cy + Math.sin(a0) * s * .62,
                 cx + Math.cos(a0) * s * .95, cy + Math.sin(a0) * s * .95);
      }
      doc.setFillColor(...ORANGEc); doc.setDrawColor(...INKc); doc.setLineWidth(.35);
      doc.circle(cx, cy, s * .45, "FD");
    };
    const drawWx = (kind, cx, cy, s) => {
      if (kind === "sun") return drawSun(cx, cy, s);
      if (kind === "partsun") { drawSun(cx - s * .35, cy - s * .35, s * .7); drawCloud(cx + s * .15, cy + s * .2, s * .8, PAPERc); return; }
      if (kind === "cloud") return drawCloud(cx, cy, s, GREYc);
      if (kind === "fog") {
        doc.setDrawColor(...MUTEDc); doc.setLineWidth(.7);
        for (let i = -1; i <= 1; i++) doc.line(cx - s * .8, cy + i * s * .35, cx + s * .8, cy + i * s * .35);
        return;
      }
      drawCloud(cx, cy - s * .15, s * .85, kind === "storm" ? GREYc : PAPERc);
      if (kind === "rain") {
        doc.setDrawColor(...ROUTEc); doc.setLineWidth(.55);
        for (let i = -1; i <= 1; i++) doc.line(cx + i * s * .38, cy + s * .5, cx + i * s * .38 - s * .16, cy + s * .85);
      } else if (kind === "snow") {
        doc.setFillColor(...ROUTEc);
        for (let i = -1; i <= 1; i++) doc.circle(cx + i * s * .38, cy + s * .68, s * .09, "F");
      } else if (kind === "storm") {
        doc.setFillColor(...ORANGEc);
        doc.triangle(cx - s * .1, cy + s * .35, cx + s * .28, cy + s * .35, cx - s * .05, cy + s * .72, "F");
        doc.triangle(cx + s * .18, cy + s * .55, cx - s * .2, cy + s * .55, cx + s * .12, cy + s * .95, "F");
      }
    };
    /* mini-iconen per meetwaarde */
    const icoThermo = (cx, cy) => {
      doc.setDrawColor(...HARDc); doc.setLineWidth(.7);
      doc.line(cx, cy - 1.8, cx, cy + .7);
      doc.setFillColor(...HARDc); doc.circle(cx, cy + 1.3, .85, "F");
    };
    const icoDrop = (cx, cy) => {
      doc.setFillColor(...ROUTEc);
      doc.triangle(cx - 1, cy + .2, cx + 1, cy + .2, cx, cy - 1.9, "F");
      doc.circle(cx, cy + .6, 1.05, "F");
    };
    const icoWind = (cx, cy) => {
      doc.setDrawColor(...PINEc); doc.setLineWidth(.6);
      doc.line(cx - 1.8, cy - 1.1, cx + 1.4, cy - 1.1);
      doc.line(cx - 1.8, cy, cx + 1.9, cy);
      doc.line(cx - 1.8, cy + 1.1, cx + .9, cy + 1.1);
    };
    const icoCloudS = (cx, cy) => drawCloud(cx, cy, 1.7, GREYc);
    /* windpijltje, gedraaid naar de richting waar de wind NAARTOE waait —
       zelfde conventie als de ➤-pijlen op de kaart/pagina (rot = dir+180-90) */
    const drawWindArrow = (cx, cy, dir, s) => {
      const rad = ((dir + 180 - 90) * Math.PI) / 180;
      const rot = (px, py) => [cx + px * Math.cos(rad) - py * Math.sin(rad), cy + px * Math.sin(rad) + py * Math.cos(rad)];
      const [x1, y1] = rot(-s, 0), [x2, y2] = rot(s, 0);
      const [hx1, hy1] = rot(s - s * .8, -s * .5), [hx2, hy2] = rot(s - s * .8, s * .5);
      doc.setDrawColor(...ROUTEc); doc.setLineWidth(.55);
      doc.line(x1, y1, x2, y2); doc.line(x2, y2, hx1, hy1); doc.line(x2, y2, hx2, hy2);
    };

    /* ================= SECTIE: WEERSVOORSPELLING ================= */
    chapter(RL.secWeather, weatherIcon);
    if (!weather) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const noW = doc.splitTextToSize(san(RL.noWeather), CW);
      doc.text(noW, M, y); y += noW.length * 4 + 4;
    } else {
      /* kolom 2 (wind) kan lang zijn: afbreken op kolombreedte, kaart groeit mee */
      doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      const col1 = [
        RL.wTemp(Math.round(weather.tmin), Math.round(weather.tmax)),
        RL.wPrecip(weather.pp ?? "?", (weather.psum ?? 0).toFixed(1))
      ];
      const windLines = doc.splitTextToSize(san(RL.wWind(Math.round(weather.wind), compassL(weather.dir, RL), Math.round(weather.gust))), 76);
      const cloudTxt = san(RL.wCloud(Math.round(weather.cloud)));
      const extra = (windLines.length - 1) * 4;
      if (y + 38 + extra > 282) newPage();
      doc.setFillColor(...PAPERc); doc.setDrawColor(...INKc); doc.setLineWidth(.5);
      doc.roundedRect(M, y, CW, 34 + extra, 3, 3, "FD");
      /* groot conditie-icoon rechtsboven, naast de (afgebroken) titel */
      drawWx(wxKind(weather.code), M + CW - 14, y + 8.5, 6);
      const wd = weather.date.toLocaleDateString(RL.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...INKc);
      doc.text(doc.splitTextToSize(san(RL.forecastFor(wd, weather.isRideDate, RL.wmo(weather.code), weather.hourly ? [weather.rangeStart, weather.rangeEnd] : null)), CW - 32), M + 5, y + 7);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      /* mini-iconen vóór elke meetwaarde */
      icoThermo(M + 6.5, y + 17);    doc.text(san(col1[0]), M + 11, y + 18);
      icoDrop(M + 6.5, y + 23.2);    doc.text(san(col1[1]), M + 11, y + 24);
      icoWind(M + 93.5, y + 17.2);   doc.text(windLines, M + 98, y + 18);
      icoCloudS(M + 93.5, y + 23.4 + extra); doc.text(cloudTxt, M + 98, y + 24 + extra);
      doc.setFontSize(7.5);
      doc.text(san(RL.wSrc(new Date().toLocaleString(RL.locale, { dateStyle: "short", timeStyle: "short" }))), M + 5, y + 30 + extra);
      y += 38 + extra;

      /* korte, gegevens-gedreven samenvatting van weer + wind */
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...INKc);
      const summary = doc.splitTextToSize(san(weatherStory(weather, RL)), CW);
      const summaryH = summary.length * 4;
      if (y + summaryH > 284) newPage();
      doc.text(summary, M, y); y += summaryH + 5;

      /* uur-per-uur tijdlijn: icoon, temperatuur & wind per uurvak van de rit */
      if (weather.hourly && weather.hours && weather.hours.length) {
        const hrs = weather.hours;
        const minTileW = 20, perRow = Math.max(1, Math.min(hrs.length, Math.floor(CW / minTileW)));
        const tileW = CW / perRow, tileH = 24, rows = Math.ceil(hrs.length / perRow);
        if (y + 5 + rows * tileH > 282) newPage();
        doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...INKc);
        doc.text(RL.hourlyHeader, M, y); y += 4.5;
        hrs.forEach((hr, i) => {
          const row = Math.floor(i / perRow), col = i % perRow;
          const x = M + col * tileW, yy = y + row * tileH;
          doc.setFillColor(...PAPERc); doc.setDrawColor(...INKc); doc.setLineWidth(.4);
          doc.roundedRect(x + 1, yy, tileW - 2, tileH - 2.5, 2.5, 2.5, "FD");
          drawWx(wxKind(hr.code), x + tileW / 2, yy + 5.5, 3.6);
          doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(...MUTEDc);
          doc.text(hr.time.slice(11, 16), x + tileW / 2, yy + 10.8, { align: "center" });
          doc.setFontSize(8.5); doc.setTextColor(...INKc);
          doc.text(`${Math.round(hr.temp)}°`, x + tileW / 2, yy + 14.8, { align: "center" });
          /* pijl + windsnelheid als één centraal geheel positioneren, zodat de
             pijl nooit tegen de (afgeronde) tegelrand aan komt bij smalle tegels */
          doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
          const windTxt = `${Math.round(hr.wind)} ${RL.kmh}`, windTxtW = doc.getTextWidth(windTxt);
          const arrowR = 1.5, gap = 1.4, pairW = arrowR * 2 + gap + windTxtW;
          const pairX0 = x + tileW / 2 - pairW / 2;
          drawWindArrow(pairX0 + arrowR, yy + 17.3, hr.dir, arrowR);
          doc.setTextColor(...PINEc);
          doc.text(windTxt, pairX0 + arrowR * 2 + gap, yy + 18, { align: "left" });
        });
        y += rows * tileH + 5;
      }

      /* de wind onderweg: waar tegen, waar mee, waar dwars */
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...INKc);
      doc.text(RL.windHeader, M, y); y += 4.5;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTEDc);
      const regenAdvies = (weather.pp ?? 0) >= 60 ? RL.rain60 : (weather.pp ?? 0) >= 30 ? RL.rain30 : "";
      const adv = doc.splitTextToSize(san(windStory(weather, RL) + regenAdvies), CW);
      const advH = adv.length * 4;
      if (y + advH > 284) newPage();
      doc.text(adv, M, y); y += advH + 3;
    }

    /* ---- voettekst + paginanummers ---- */
    const pages = doc.getNumberOfPages();
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    const foot = doc.splitTextToSize(san(RL.footer), CW - 12);
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...MUTEDc);
      doc.text(foot, M, 293 - foot.length * 2.8);
      doc.text(`${p}/${pages}`, W - M, 291, { align: "right" });
    }
    return doc;
  }

  /* =========================================================
     PAGINAHOOFDSTUKKEN — spiegel van het PDF-rapport
     + kaartlagen (blokkades / hoogteprofiel / weer & wind)
     ========================================================= */
  const LAYERS = { blocks: true, profile: true, weather: true };
  let pageProf = null, pageClimbs = [], pageWeather = null;

  const currentRideDate = () => {
    const d = new Date($("ridedate").value || Date.now()); d.setHours(12); return d;
  };

  function applyLayers() {
    /* kaartlagen */
    LAYERS.blocks ? map.addLayer(hinderLayer) : map.removeLayer(hinderLayer);
    LAYERS.profile ? map.addLayer(climbLayer) : map.removeLayer(climbLayer);
    LAYERS.weather ? map.addLayer(windLayer) : map.removeLayer(windLayer);
    /* paginadelen */
    const secP = document.getElementById("secProfile"), secW = document.getElementById("secWeather");
    if (secP) secP.hidden = !LAYERS.profile || !route;
    if (secW) secW.hidden = !LAYERS.weather || !route;
    const outEl = document.getElementById("out"), stripEl = document.getElementById("strip");
    if (outEl) outEl.style.display = LAYERS.blocks ? "" : "none";
    if (stripEl && view) stripEl.hidden = !LAYERS.blocks;
    document.querySelectorAll(".layer-btn").forEach(b =>
      b.setAttribute("aria-pressed", LAYERS[b.dataset.layer]));
  }
  document.querySelectorAll(".layer-btn").forEach(b =>
    b.addEventListener("click", () => { LAYERS[b.dataset.layer] = !LAYERS[b.dataset.layer]; applyLayers(); }));

  /* ---------- hoofdstuk: hoogteprofiel & klimmen ---------- */
  function drawProfCanvas(canvas, prof, climbs, minE, maxE) {
    const ctx = canvas.getContext("2d");
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    const kmax = prof.km[prof.km.length - 1] || 1;
    const e0 = minE ?? prof.min, e1 = maxE ?? prof.max;
    const padB = 26, padT = 22, padR = 56;
    const sx = k => 10 + (k / kmax) * (cw - 10 - padR);
    const sy = e => ch - padB - ((e - e0) / Math.max(e1 - e0, 1)) * (ch - padB - padT);
    const area = (km, ele, fill) => {
      ctx.beginPath(); ctx.moveTo(sx(km[0]), ch - padB);
      for (let i = 0; i < km.length; i++) ctx.lineTo(sx(km[i]), sy(ele[i]));
      ctx.lineTo(sx(km[km.length - 1]), ch - padB); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    };
    area(prof.km, prof.ele, "#DEE4EE");
    for (const c of (climbs || [])) area(c.slice.km, c.slice.ele, "#FDD8BE");
    ctx.beginPath();
    prof.km.forEach((k, i) => i ? ctx.lineTo(sx(k), sy(prof.ele[i])) : ctx.moveTo(sx(k), sy(prof.ele[i])));
    ctx.strokeStyle = "#2F5AA8"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.stroke();
    ctx.strokeStyle = "#141619"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(10, ch - padB); ctx.lineTo(cw - padR + 10, ch - padB); ctx.stroke();
    ctx.font = "bold 18px Archivo, sans-serif"; ctx.fillStyle = "#565E68";
    ctx.fillText("0", 10, ch - 6);
    ctx.textAlign = "right"; ctx.fillText(`${kmax.toFixed(0)} km`, cw - padR + 10, ch - 6);
    ctx.textAlign = "left";
    ctx.fillText(`${e1} m`, cw - padR + 16, sy(e1) + 6);
    ctx.fillText(`${e0} m`, cw - padR + 16, sy(e0) + 6);
    (climbs || []).forEach((c, i) => {
      const px = sx(c.endKm), py = sy(c.topEle) - 14;
      ctx.beginPath(); ctx.arc(px, py, 13, 0, 7);
      ctx.fillStyle = "#D9480F"; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center";
      ctx.font = "bold 15px Archivo, sans-serif";
      ctx.fillText(String(i + 1), px, py + 5); ctx.textAlign = "left";
    });
  }

  function syncClimbPins() {
    climbLayer.clearLayers();
    pageClimbs.forEach((c, i) => {
      const [lat, lon] = Geom.pointAtChain(route, c.endKm * 1000);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "", html: `<div class="climb-pin">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        title: T("climbPinTitle", i + 1, c.endKm.toFixed(1)), keyboard: true
      }).addTo(climbLayer).on("click", () => focusClimb(i));
    });
  }

  function focusClimb(i) {
    if (!LAYERS.profile) { LAYERS.profile = true; applyLayers(); }
    const el = document.getElementById("climb-" + i);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flashTarget"); void el.offsetWidth; el.classList.add("flashTarget");
  }

  async function renderPageProfile() {
    const sec = document.getElementById("secProfile");
    if (!sec || !route) return;
    if (pageProf === null) { try { pageProf = await ensureProfile(); } catch (e) { pageProf = null; } }
    const RL = repLang();
    const body = document.getElementById("climbCards");
    if (!pageProf) {
      pageClimbs = [];
      document.getElementById("profStats").textContent = T("profNoData");
      body.innerHTML = ""; syncClimbPins(); applyLayers(); return;
    }
    pageClimbs = Geom.findClimbs(pageProf);
    drawProfCanvas(document.getElementById("profChart"), pageProf, pageClimbs);
    document.getElementById("profStats").textContent =
      san(RL.profStats(pageProf.ascent, route.km.toFixed(1), pageProf.min, pageProf.max, pageClimbs.length));
    body.innerHTML = "";
    if (!pageClimbs.length) {
      body.innerHTML = `<p class="note">${esc(san(RL.flat))}</p>`;
    }
    pageClimbs.forEach((c, i) => {
      const card = document.createElement("div");
      card.className = "card climb-card"; card.id = "climb-" + i;
      card.innerHTML =
        `<div class="climb-mini"><canvas width="240" height="150"></canvas></div>
         <div class="km"><b>${i + 1}</b><span>${c.endKm.toFixed(1)}</span></div>
         <div class="body">
           <h3>${esc(san(RL.climbTitle(i + 1, c.startKm.toFixed(1), c.endKm.toFixed(1))))}</h3>
           <div class="meta"><b>${esc(san(RL.climbStats(c.lenKm.toFixed(2), c.gain, c.avg, c.max)))}</b></div>
           <div class="cons" style="margin-top:6px;color:var(--muted)">${esc(san(climbStory(c, i, pageClimbs, RL)))}</div>
         </div>`;
      body.appendChild(card);
      drawProfCanvas(card.querySelector("canvas"),
        { km: c.slice.km.map(k => k - c.startKm), ele: c.slice.ele, min: c.startEle, max: c.topEle },
        null, c.startEle, c.topEle);
      card.addEventListener("click", () => {
        const [lat, lon] = Geom.pointAtChain(route, c.endKm * 1000);
        map.setView([lat, lon], 14);
      });
    });
    syncClimbPins();
    applyLayers();
  }

  /* ---------- hoofdstuk: weer & wind ---------- */
  function syncWindArrows() {
    windLayer.clearLayers();
    if (!pageWeather || !route) return;
    /* FIX 3: `const L = repLang()` overschaduwde Leaflets globale `L`,
       waardoor L.marker() op het vertaalwoordenboek crashte en er nooit
       windpijlen verschenen. Lokale naam is nu RL. */
    const RL = repLang();
    const n = Math.max(4, Math.min(14, Math.round(route.km / 9)));
    const rot = ((pageWeather.dir + 180) - 90);   // ➤ wijst standaard naar rechts (oost)
    for (let i = 1; i <= n; i++) {
      const [lat, lon] = Geom.pointAtChain(route, route.km * 1000 * i / (n + 1));
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "", html: `<span class="wind-arrow" style="display:inline-block;transform:rotate(${rot}deg)">➤</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        interactive: true, keyboard: false
      }).addTo(windLayer)
        .bindTooltip(T("windArrowTip", Math.round(pageWeather.wind), compassL(pageWeather.dir, RL)));
    }
  }

  async function renderPageWeather() {
    const sec = document.getElementById("secWeather");
    if (!sec || !route) return;
    try { pageWeather = await fetchWeather(currentRideDate(), $("starthour").value, $("endhour").value); } catch (e) { pageWeather = null; }
    renderWeatherHtml();
  }
  function renderWeatherHtml() {
    const RL = repLang(), body = document.getElementById("weatherBody");
    if (!body || !route) return;
    if (!pageWeather) {
      body.innerHTML = `<p class="note">${esc(T("weerNoData"))}</p>`;
      syncWindArrows(); applyLayers(); return;
    }
    const w = pageWeather;
    const wd = w.date.toLocaleDateString(uiLoc(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const hourStrip = (w.hourly && w.hours && w.hours.length)
      ? `<h4 class="hour-strip-title">${esc(T("hourlyHeader"))}</h4>
         <div class="hour-strip">${w.hours.map(hr => {
           const rot = (hr.dir + 180) - 90;
           return `<div class="hour-tile">
             <span class="hour-time">${esc(hr.time.slice(11, 16))}</span>
             <span class="hour-ico" aria-hidden="true">${wmoIcon(hr.code)}</span>
             <span class="hour-temp">${Math.round(hr.temp)}°</span>
             <span class="hour-wind"><span class="hour-arrow" aria-hidden="true" style="transform:rotate(${rot}deg)">➤</span>${Math.round(hr.wind)} ${esc(RL.kmh)}</span>
           </div>`;
         }).join("")}</div>`
      : "";
    body.innerHTML =
      `<div class="weather-card">
         <div class="weather-head">
           <span class="weather-ico" aria-hidden="true">${wmoIcon(w.code)}</span>
           <h3>${esc(san(RL.forecastFor(wd, w.isRideDate, RL.wmo(w.code), w.hourly ? [w.rangeStart, w.rangeEnd] : null)))}</h3>
         </div>
         <p><span class="w-ico" aria-hidden="true">🌡️</span>${esc(san(RL.wTemp(Math.round(w.tmin), Math.round(w.tmax))))}</p>
         <p><span class="w-ico" aria-hidden="true">🌧️</span>${esc(san(RL.wPrecip(w.pp ?? "?", (w.psum ?? 0).toFixed(1))))}</p>
         <p><span class="w-ico" aria-hidden="true">💨</span>${esc(san(RL.wWind(Math.round(w.wind), compassL(w.dir, RL), Math.round(w.gust))))}</p>
         <p><span class="w-ico" aria-hidden="true">☁️</span>${esc(san(RL.wCloud(Math.round(w.cloud))))}</p>
       </div>
       <p class="weather-summary">${esc(san(weatherStory(w, RL)))}</p>
       ${hourStrip}
       <p class="wind-par"><b>${esc(T("windHeader"))}</b>${esc(san(windStory(w, RL)))}</p>
       <p class="weather-src">${esc(san(RL.wSrc(new Date().toLocaleString(uiLoc(), { dateStyle: "short", timeStyle: "short" }))))}</p>`;
    syncWindArrows();
    applyLayers();
  }

  function initSections() {
    pageProf = null; pageWeather = null;
    renderPageProfile();
    renderPageWeather();
  }

  /* ---------- taalwissel: alles hertekenen in de nieuwe taal ---------- */
  if (window.I18N) I18N.onChange(() => {
    if (route) {
      $("routeinfo").innerHTML = T("routeInfo", esc(route.name), route.km.toFixed(1), route.tiles.length);
      $("footroute").textContent = T("footRoute", route.name, route.km.toFixed(1), route.rawPts.length);
      renderPageProfile();
      renderWeatherHtml();
    }
    if (view) refresh();
    else $("status").textContent = route ? T("statusReady") : T("statusLoadFirst");
  });

  $("report").addEventListener("click", async () => {
    if (!view) return;
    const btn = $("report"), old = btn.textContent;
    btn.disabled = true; btn.textContent = T("pdfBusy");
    const slug = route.name.replace(/[^\w\- ]+/g, "").trim().replace(/ +/g, "-").toLowerCase();
    const base = `routescout-rapport-${slug}-${view.rideDate.toISOString().slice(0, 10)}`;
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
      $("status").textContent = T("pdfFallback");
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });
})();
