/* =========================================================
   sources.js — extra hinderbronnen naast GIPOD (Vlaanderen)
   · Brussel: Bruxelles Mobilité WFS (officieel, CORS-OK)
   · Wallonië: Trafiroutes via een eigen proxy (zie worker/), want de
     bronfeed stuurt geen CORS-header en gebruikt Lambert 72.
   · Nederland: Melvin/NDW. De open-data planningsfeed is ±160 MB XML,
     véél te groot voor de browser; een GitHub Action condenseert die
     elke paar uur tot kleine GeoJSON-rastercellen (0,5°) op de
     'nl-data'-branch, die we hier CORS-vrij via raw.githubusercontent
     ophalen — enkel de cellen die de route raakt.
   Elke bron levert genormaliseerde records in dezelfde vorm als
   GIPOD.summarize(), zodat app.js ze door dezelfde pijplijn kan sturen.
   Brussel/Wallonië zijn klein (~120–130 punten) → volledige set ophalen;
   Nederland is groot → per-cel ophalen.
   ========================================================= */
"use strict";
const Sources = (() => {
  /* ruwe regio-omhullenden (WGS84 [minLon,minLat,maxLon,maxLat]) — enkel om
     te beslissen óf een bron zinvol is voor een route */
  const REGIONS = {
    bxl: [4.24, 50.76, 4.48, 50.91],
    wal: [2.84, 49.49, 6.41, 50.85],
    nl:  [3.20, 50.72, 7.24, 53.62],
  };
  const BXL_WFS = "https://data.mobility.brussels/geoserver/bm_traffic/wfs" +
    "?service=WFS&version=2.0.0&request=GetFeature&typeNames=bm_traffic:worksites_comm" +
    "&outputFormat=application/json&srsName=EPSG:4326";
  /* de uitgerolde Trafiroutes-proxy (worker/) — standaard voor iedereen;
     de localStorage-sleutel blijft bruikbaar als ontwikkelaars-override */
  const WAL_PROXY_DEFAULT = "https://routescout-trafiroutes-proxy.routescout.workers.dev";
  const WAL_PROXY_KEY = "routescout-wal-proxy";
  /* Nederlandse gridcellen op de nl-data-branch (door GitHub Actions
     gevuld); override-sleutel voor lokaal testen */
  const NL_BASE_DEFAULT = "https://raw.githubusercontent.com/DenBiste/WerfAlarm/nl-data/nl";
  const NL_BASE_KEY = "routescout-nl-base";
  const NL_CELL = 0.5;

  const walProxy = () => {
    try { return (localStorage.getItem(WAL_PROXY_KEY) || "").trim() || WAL_PROXY_DEFAULT; }
    catch (e) { return WAL_PROXY_DEFAULT; }
  };
  const nlBase = () => {
    try { return ((localStorage.getItem(NL_BASE_KEY) || "").trim() || NL_BASE_DEFAULT).replace(/\/+$/, ""); }
    catch (e) { return NL_BASE_DEFAULT; }
  };

  const bboxIntersects = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
  function routeBBox(route) {
    const lats = route.pts.map(p => p[0]), lons = route.pts.map(p => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }

  /* welke EXTRA bronnen (naast GIPOD) overlappen deze route? */
  function relevant(route) {
    const bb = routeBBox(route), out = [];
    if (bboxIntersects(bb, REGIONS.bxl)) out.push("bxl");
    if (bboxIntersects(bb, REGIONS.wal) && walProxy()) out.push("wal");
    if (bboxIntersects(bb, REGIONS.nl)) out.push("nl");
    return out;
  }

  const stripHtml = s => String(s || "")
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();

  const fetchJson = async (url, ms = 20000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error("http " + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  };

  /* Brussel: Bruxelles Mobilité — wegwerkzaamheden (punten).
     Geen begin/einddatum in de data → start/end null (steeds "actief"). */
  async function fetchBxl(lang) {
    const d = await fetchJson(BXL_WFS);
    const L = lang === "en" ? "en" : lang === "fr" ? "fr" : "nl";
    return (d.features || []).map(f => {
      const p = f.properties || {};
      const label = p["label_" + L] || p.label_fr || p.label_nl || "";
      const descr = stripHtml(p["descr_" + L] || p.descr_fr || p.descr_nl || "");
      return {
        geometry: f.geometry,
        summary: {
          id: "bxl:" + (p.gid ?? ""), source: "bxl", collection: "BXL",
          desc: label.trim() || descr || "(werf)", start: null, end: null,
          cons: descr, owner: "", cat: "",
        },
      };
    });
  }

  /* Wallonië: Trafiroutes via proxy (GeoJSON, al herprojecteerd naar WGS84). */
  async function fetchWal() {
    const base = walProxy();
    if (!base) return [];
    const d = await fetchJson(base.replace(/\/+$/, "") + "?type=chantier");
    return (d.features || []).map(f => {
      const p = f.properties || {};
      return {
        geometry: f.geometry,
        summary: {
          id: "wal:" + (p.id ?? ""), source: "wal", collection: "WAL",
          desc: (p.title || p.category || "(chantier)").trim(), start: null, end: null,
          cons: p.category && p.category !== p.title ? p.category : "", owner: "", cat: "",
        },
      };
    });
  }

  /* Nederland: Melvin/NDW via voorbereide rastercellen (echte lijn-
     geometrie + begin/einddatum). Enkel de cellen die de route-bbox
     raakt worden opgehaald; een ontbrekende cel (zee, buitenland) faalt
     stil. */
  async function fetchNl(route) {
    const base = nlBase();
    const bb = routeBBox(route);
    const cx0 = Math.floor(bb[0] / NL_CELL), cx1 = Math.floor(bb[2] / NL_CELL);
    const cy0 = Math.floor(bb[1] / NL_CELL), cy1 = Math.floor(bb[3] / NL_CELL);
    const keys = [];
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++) keys.push(`c${cx}_${cy}`);

    const cells = await Promise.all(keys.map(async k => {
      try { return await fetchJson(`${base}/${k}.json`); }
      catch (e) { return null; }   // cel bestaat niet → overslaan
    }));

    const out = [];
    for (const d of cells) {
      if (!d || !d.features) continue;
      for (const f of d.features) {
        const p = f.properties || {};
        out.push({
          geometry: f.geometry,
          summary: {
            id: "nl:" + (p.i ?? ""), source: "nl", collection: "NL",
            desc: (p.d || "Wegwerkzaamheden").trim(),
            start: p.s || null, end: p.e || null,
            cons: p.c || "", owner: p.o || "", cat: "",
          },
        });
      }
    }
    return out;
  }

  async function fetch_(sourceId, lang, route) {
    if (sourceId === "bxl") return fetchBxl(lang);
    if (sourceId === "wal") return fetchWal();
    if (sourceId === "nl") return fetchNl(route);
    return [];
  }

  return { relevant, fetch: fetch_, walProxyKey: WAL_PROXY_KEY, hasWalProxy: () => !!walProxy() };
})();
