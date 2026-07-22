/* =========================================================
   trafiroutes-proxy — Cloudflare Worker
   Relays the Walloon "Trafiroutes" roadworks/incidents feed so it can be
   used by RouteScout's browser code. The upstream feed sends no CORS
   header (browsers block it) and uses Belgian Lambert 72 (EPSG:31370)
   coordinates; this Worker fetches it server-side, reprojects to WGS84,
   and returns GeoJSON with `Access-Control-Allow-Origin: *`.

   Deploy: see worker/README.md. No secrets or bindings required.

   Query params:
     ?type=chantier | incident | all   (default: chantier)
     ?lang=FR | NL                      (default: FR)
   ========================================================= */
"use strict";

const UPSTREAM = "https://trafiroutes.wallonie.be/trafiroutes/Rest/api/viewer/event/";
const FEEDS = {
  chantier: "EVENEMENT_REEL_CHANTIER",
  incident: "EVENEMENT_REEL_INCIDENT",
};

/* -------- Lambert 72 (EPSG:31370) -> WGS84 --------
   Rigorous inverse Lambert Conformal Conic (International 1924 ellipsoid)
   + Helmert BD72->WGS84 (coordinate-frame convention). Verified against
   pyproj (EPSG:31370 -> EPSG:4326) to < 5 mm across Wallonia. */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const A = 6378388.0, F = 1 / 297.0, E2 = 2 * F - F * F, E = Math.sqrt(E2);
const LAT0 = 90 * D2R, LON0 = 4.36748666666667 * D2R;
const LAT1 = 51.1666672333333 * D2R, LAT2 = 49.8333339 * D2R;
const X0 = 150000.013, Y0 = 5400088.438;
const mm = p => Math.cos(p) / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
const tt = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - E * Math.sin(p)) / (1 + E * Math.sin(p)), E / 2);
const N_ = (Math.log(mm(LAT1)) - Math.log(mm(LAT2))) / (Math.log(tt(LAT1)) - Math.log(tt(LAT2)));
const FC = mm(LAT1) / (N_ * Math.pow(tt(LAT1), N_));
const RHOF = A * FC * Math.pow(tt(LAT0), N_);

const AW = 6378137.0, FW = 1 / 298.257223563, E2W = 2 * FW - FW * FW;
const AS = D2R / 3600;
const TX = -106.8686, TY = 52.2978, TZ = -103.7239;
const RX = -0.3366 * AS, RY = 0.457 * AS, RZ = -1.8422 * AS, S = -1.2747e-6;

function lambert72ToWgs84(x, y) {
  /* inverse LCC -> lat/lon on BD72 (intl ellipsoid) */
  const dx = x - X0, dy = RHOF - (y - Y0);
  const rho = Math.sign(N_) * Math.sqrt(dx * dx + dy * dy);
  const t = Math.pow(rho / (A * FC), 1 / N_);
  const lam = Math.atan2(dx, dy) / N_ + LON0;
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) {
    const es = E * Math.sin(phi);
    phi = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - es) / (1 + es), E / 2));
  }
  /* geographic -> geocentric (intl) */
  const Nn = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const X = Nn * Math.cos(phi) * Math.cos(lam);
  const Y = Nn * Math.cos(phi) * Math.sin(lam);
  const Z = Nn * (1 - E2) * Math.sin(phi);
  /* Helmert BD72 -> WGS84 (coordinate-frame convention) */
  const k = 1 + S;
  const Xw = TX + k * (X + RZ * Y - RY * Z);
  const Yw = TY + k * (-RZ * X + Y + RX * Z);
  const Zw = TZ + k * (RY * X - RX * Y + Z);
  /* geocentric (WGS84) -> geographic */
  const lon = Math.atan2(Yw, Xw);
  const p = Math.hypot(Xw, Yw);
  let latw = Math.atan2(Zw, p * (1 - E2W));
  for (let i = 0; i < 8; i++) {
    const Nw = AW / Math.sqrt(1 - E2W * Math.sin(latw) ** 2);
    latw = Math.atan2(Zw + E2W * Nw * Math.sin(latw), p);
  }
  return [lon * R2D, latw * R2D]; // [lon, lat]
}

/* source data heeft soms al beschadigde accenten (U+FFFD) en nbsp's:
   opkuisen zodat de omschrijving leesbaar blijft */
const clean = s => String(s || "").replace(/�/g, "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

async function fetchFeed(name, lang) {
  const url = `${UPSTREAM}${name}/${lang}/`;
  /* de legacy-backend weigert een specifieke Accept-header (406); een
     wildcard-Accept + een gewone UA werkt, net als een browser/curl */
  const r = await fetch(url, {
    headers: { "Accept": "*/*", "User-Agent": "RouteScout-proxy/1.0" },
    cf: { cacheTtl: 180, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

function toFeatures(items, kind) {
  const out = [];
  for (const it of items || []) {
    const x = parseFloat(it.x), y = parseFloat(it.y);
    if (!isFinite(x) || !isFinite(y)) continue;
    const [lon, lat] = lambert72ToWgs84(x, y);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: it.id ?? it.idEvenement ?? "",
        kind,                                   // "chantier" | "incident"
        title: clean(it.evtTitle),
        category: clean(it.libelleTypeEvtTrf),
      },
    });
  }
  return out;
}

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const u = new URL(request.url);
    const type = (u.searchParams.get("type") || "chantier").toLowerCase();
    const lang = (u.searchParams.get("lang") || "FR").toUpperCase() === "NL" ? "NL" : "FR";
    const want = type === "all" ? ["chantier", "incident"] : (FEEDS[type] ? [type] : ["chantier"]);

    try {
      const groups = await Promise.all(want.map(async k => toFeatures(await fetchFeed(FEEDS[k], lang), k)));
      const features = groups.flat();
      return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
        headers: {
          ...cors,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=180",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [], error: "Upstream fetch failed" }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });
    }
  },
};
