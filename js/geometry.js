/* =========================================================
   geometry.js — routebewerking & afstandsberekening
   Pure functies, geen DOM. Gebruikt door app.js.
   ========================================================= */
"use strict";
const Geom = (() => {
  const MY = 110540; // meter per breedtegraad

  /* Iteratieve Douglas–Peucker vereenvoudiging (tolerantie in graden) */
  function simplify(pts, tol) {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    const pd = (p, a, b) => {
      const ax = a[1], ay = a[0], bx = b[1], by = b[0], px = p[1], py = p[0];
      const dx = bx - ax, dy = by - ay;
      if (!dx && !dy) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    while (stack.length) {
      const [i, j] = stack.pop();
      let dmax = 0, idx = 0;
      for (let k = i + 1; k < j; k++) {
        const d = pd(pts[k], pts[i], pts[j]);
        if (d > dmax) { dmax = d; idx = k; }
      }
      if (dmax > tol) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /* Bouw een route-object uit ruwe [lat,lon]-punten */
  function buildRoute(rawPts, name) {
    let tol = 0.00012, pts = simplify(rawPts, tol);
    while (pts.length > 1800) { tol *= 1.8; pts = simplify(rawPts, tol); }

    const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length * Math.PI / 180;
    const MX = 111320 * Math.cos(lat0);
    const R = pts.map(p => [p[1] * MX, p[0] * MY]);
    const CHAIN = [0];
    for (let i = 1; i < R.length; i++)
      CHAIN.push(CHAIN[i - 1] + Math.hypot(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1]));

    /* bevraagzones: route in stukken, max ~5×7 km, buffer 250 m */
    const buf = 0.0025, maxLat = 0.045, maxLon = 0.07, tiles = [];
    let cur = null;
    for (const [lat, lon] of rawPts) {
      if (!cur) { cur = [lat, lat, lon, lon]; continue; }
      const nlo = Math.min(cur[0], lat), nhi = Math.max(cur[1], lat);
      const wlo = Math.min(cur[2], lon), whi = Math.max(cur[3], lon);
      if (nhi - nlo > maxLat || whi - wlo > maxLon) { tiles.push(cur); cur = [lat, lat, lon, lon]; }
      else cur = [nlo, nhi, wlo, whi];
    }
    tiles.push(cur);
    const bboxes = tiles.map(t => [
      +(t[2] - buf).toFixed(4), +(t[0] - buf).toFixed(4),
      +(t[3] + buf).toFixed(4), +(t[1] + buf).toFixed(4)
    ]);

    /* rasterindex van routecellen (250 m) voor snelle voorfilter */
    const cells = new Set(), C = 250;
    const mark = (x, y) => cells.add(Math.floor(x / C) + "_" + Math.floor(y / C));
    for (let i = 0; i < R.length - 1; i++) {
      const [ax, ay] = R[i], [bx, by] = R[i + 1];
      const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / 100));
      for (let s = 0; s <= n; s++) mark(ax + (bx - ax) * s / n, ay + (by - ay) * s / n);
    }

    return {
      name: name || "Naamloze route",
      pts, R, CHAIN, MX, cells,
      tiles: bboxes,
      km: CHAIN[CHAIN.length - 1] / 1000,
      grid: null // wordt gevuld met expandGrid()
    };
  }

  /* Vergroot de routecellen met `halo` cellen (250 m) — bepaalt zoekbereik van de voorfilter */
  function expandGrid(route, halo) {
    const g = new Set();
    for (const key of route.cells) {
      const [cx, cy] = key.split("_").map(Number);
      for (let dx = -halo; dx <= halo; dx++)
        for (let dy = -halo; dy <= halo; dy++) g.add((cx + dx) + "_" + (cy + dy));
    }
    route.grid = g;
  }

  const nearRoute = (route, x, y) =>
    route.grid.has(Math.floor(x / 250) + "_" + Math.floor(y / 250));

  /* Kortste afstand van punt tot de route + kilometerpunt */
  function distToRoute(route, x, y) {
    let best = Infinity, ch = 0;
    const R = route.R, CH = route.CHAIN;
    for (let i = 0; i < R.length - 1; i++) {
      const ax = R[i][0], ay = R[i][1], bx = R[i + 1][0], by = R[i + 1][1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < best) { best = d; ch = CH[i] + t * Math.sqrt(len2); }
    }
    return [best, ch];
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* GeoJSON-coördinaten -> lijst van paden [[lon,lat],...] */
  function geomPaths(g) {
    const paths = [];
    const walk = c => {
      if (typeof c[0] === "number") { paths.push([c]); return; }
      if (typeof c[0][0] === "number") { paths.push(c); return; }
      c.forEach(walk);
    };
    if (g && g.coordinates) walk(g.coordinates);
    return paths;
  }

  /* Verdicht een pad tot punten om de ≤25 m (max 4000) */
  function* densify(route, coords) {
    const toXY = (lat, lon) => [lon * route.MX, lat * MY];
    let n = 0;
    for (let i = 0; i < coords.length; i++) {
      const a = toXY(coords[i][1], coords[i][0]);
      yield a; if (++n > 4000) return;
      if (i < coords.length - 1) {
        const b = toXY(coords[i + 1][1], coords[i + 1][0]);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.min(Math.floor(d / 25), 80);
        for (let s = 1; s <= steps; s++) {
          yield [a[0] + (b[0] - a[0]) * s / (steps + 1), a[1] + (b[1] - a[1]) * s / (steps + 1)];
          if (++n > 4000) return;
        }
      }
    }
  }

  /* Analyseer een GeoJSON-geometrie t.o.v. de route.
     Geeft {dist, kms} terug: kleinste afstand (m) én álle kilometerpunten
     waar de route deze zone passeert (lussen kunnen dezelfde werf twee keer
     kruisen). Passages die langs de route >400 m uit elkaar liggen tellen
     als aparte doortochten. Geeft null als niets binnen `thresh` valt. */
  function analyzeGeom(route, g, thresh) {
    if (!g) return null;
    const paths = geomPaths(g);
    const toXY = (lat, lon) => [lon * route.MX, lat * MY];
    const hits = []; // [afstand, kilometerstand]
    let best = Infinity;

    for (const p of paths) {
      for (const pt of densify(route, p)) {
        if (!nearRoute(route, pt[0], pt[1])) continue;
        const [d, c] = distToRoute(route, pt[0], pt[1]);
        if (d < best) best = d;
        if (d <= thresh) hits.push([d, c]);
      }
    }
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      /* routepunten ín de zone tellen als passage op afstand 0 */
      const rings = paths.map(p => p.map(c => toXY(c[1], c[0])));
      for (let i = 0; i < route.R.length; i += 3) {
        for (const r of rings) {
          if (pointInRing(route.R[i][0], route.R[i][1], r)) {
            hits.push([0, route.CHAIN[i]]); best = 0; break;
          }
        }
      }
    }
    if (!hits.length) return null;

    /* clusteren tot één km-punt per doortocht (representant = dichtstbijzijnde) */
    hits.sort((a, b) => a[1] - b[1]);
    const kms = [];
    let cd = hits[0][0], cc = hits[0][1], prev = hits[0][1];
    for (let i = 1; i < hits.length; i++) {
      const [d, c] = hits[i];
      if (c - prev > 400) { kms.push(cc); cd = d; cc = c; }
      else if (d < cd) { cd = d; cc = c; }
      prev = c;
    }
    kms.push(cc);
    return { dist: best, kms };
  }

  /* Punt [lat,lon] op de route bij kilometerstand m (meter) */
  function pointAtChain(route, m) {
    const CH = route.CHAIN, P = route.pts;
    if (m <= 0) return P[0];
    if (m >= CH[CH.length - 1]) return P[P.length - 1];
    let i = 1; while (CH[i] < m) i++;
    const t = (m - CH[i - 1]) / (CH[i] - CH[i - 1] || 1);
    return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t,
            P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t];
  }

  /* ---------------- hoogteprofiel ---------------- */

  /* Bouwt een gladgemaakt hoogteprofiel {km:[], ele:[]} uit ruwe punten +
     hoogtes (null-gaten worden geïnterpoleerd), geresampled om de 50 m. */
  function buildProfile(rawPts, eles) {
    if (!rawPts || !eles || rawPts.length < 2) return null;
    const lat0 = rawPts.reduce((a, p) => a + p[0], 0) / rawPts.length * Math.PI / 180;
    const MX = 111320 * Math.cos(lat0);
    /* cumulatieve afstand (m) */
    const dist = [0];
    for (let i = 1; i < rawPts.length; i++) {
      const dx = (rawPts[i][1] - rawPts[i - 1][1]) * MX;
      const dy = (rawPts[i][0] - rawPts[i - 1][0]) * MY;
      dist.push(dist[i - 1] + Math.hypot(dx, dy));
    }
    /* null-hoogtes interpoleren */
    const e = eles.slice();
    let last = null;
    for (let i = 0; i < e.length; i++) {
      if (e[i] != null) { if (last === null) for (let j = 0; j < i; j++) e[j] = e[i]; last = i; }
      else if (last !== null) {
        let next = i; while (next < e.length && e[next] == null) next++;
        if (next >= e.length) { for (let j = i; j < e.length; j++) e[j] = e[last]; break; }
        for (let j = i; j < next; j++) e[j] = e[last] + (e[next] - e[last]) * (dist[j] - dist[last]) / (dist[next] - dist[last] || 1);
        i = next - 1;
      }
    }
    if (e.some(v => v == null)) return null;
    /* resample om de 50 m */
    const STEP = 50, total = dist[dist.length - 1];
    const km = [], ele = [];
    let idx = 0;
    for (let d = 0; d <= total; d += STEP) {
      while (idx < dist.length - 2 && dist[idx + 1] < d) idx++;
      const t = (d - dist[idx]) / (dist[idx + 1] - dist[idx] || 1);
      km.push(d / 1000);
      ele.push(e[idx] + (e[idx + 1] - e[idx]) * Math.max(0, Math.min(1, t)));
    }
    /* gladstrijken (glijdend gemiddelde over 250 m) */
    const sm = ele.map((_, i) => {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(ele.length - 1, i + 2); j++) { s += ele[j]; n++; }
      return s / n;
    });
    let ascent = 0;
    for (let i = 1; i < sm.length; i++) if (sm[i] > sm[i - 1]) ascent += sm[i] - sm[i - 1];
    return { km, ele: sm, ascent: Math.round(ascent),
             min: Math.round(Math.min(...sm)), max: Math.round(Math.max(...sm)) };
  }

  /* Detecteert individuele klimmen in een profiel. Een klim eindigt op zijn top
     zodra het profiel duidelijk terugzakt; kleine tussenzakjes horen bij de klim. */
  function findClimbs(profile) {
    if (!profile) return [];
    const { km, ele } = profile, n = ele.length, climbs = [];
    let i = 0;
    while (i < n - 1) {
      if (ele[i + 1] <= ele[i]) { i++; continue; }
      let j = i, top = i, topEle = ele[i];
      while (j < n - 1) {
        j++;
        if (ele[j] > topEle) { topEle = ele[j]; top = j; }
        if (topEle - ele[j] > Math.max(12, (topEle - ele[i]) * .3)) break;   // klim voorbij
      }
      const gain = topEle - ele[i], lenKm = km[top] - km[i];
      if (top > i && lenKm > 0.05 && (gain >= 20 || (gain >= 12 && gain / (lenKm * 10) >= 4))) {
        /* max helling en onregelmatigheid over 100m-vensters */
        let maxG = 0, maxAt = km[i]; const grades = [];
        for (let k = i; k < top - 1; k++) {
          const g = (ele[k + 2] - ele[k]) / ((km[k + 2] - km[k]) * 1000 || 1) * 100;
          grades.push(g);
          if (g > maxG) { maxG = g; maxAt = km[k + 1]; }
        }
        const avg = gain / (lenKm * 10);
        const mean = grades.reduce((a, b) => a + b, 0) / (grades.length || 1);
        const sd = Math.sqrt(grades.reduce((a, b) => a + (b - mean) ** 2, 0) / (grades.length || 1));
        climbs.push({
          startKm: km[i], endKm: km[top], lenKm, gain: Math.round(gain),
          avg: +avg.toFixed(1), max: +Math.max(maxG, avg).toFixed(1), maxAt: +maxAt.toFixed(1),
          irregular: sd > 2.5, startEle: Math.round(ele[i]), topEle: Math.round(topEle),
          slice: { km: km.slice(i, top + 1), ele: ele.slice(i, top + 1) }
        });
      }
      i = Math.max(top, i + 1) + 1;
    }
    return climbs;
  }

  /* Lengte (m) van een lijst [lat,lon]-punten, via de haversineformule. */
  function pathLength(pts) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
      const dLat = toRad(pts[i][0] - pts[i - 1][0]), dLon = toRad(pts[i][1] - pts[i - 1][1]);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(pts[i - 1][0])) * Math.cos(toRad(pts[i][0])) * Math.sin(dLon / 2) ** 2;
      d += 2 * R * Math.asin(Math.sqrt(a));
    }
    return d;
  }

  /* Middelpunt + straal (m) die een GeoJSON-geometrie net omvat, plus marge —
     gebruikt om een "vermijd deze zone"-cirkel aan een routeplanner te geven. */
  function geomCenterRadius(g) {
    const coords = geomPaths(g).flat();
    if (!coords.length) return null;
    const lats = coords.map(c => c[1]), lons = coords.map(c => c[0]);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const R = 6371000, toRad = d => d * Math.PI / 180;
    let maxD = 0;
    for (const [clon, clat] of coords) {
      const dLat = toRad(clat - lat), dLon = toRad(clon - lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(clat)) * Math.sin(dLon / 2) ** 2;
      const d = 2 * R * Math.asin(Math.sqrt(a));
      if (d > maxD) maxD = d;
    }
    return { lat, lon, radius: Math.max(25, maxD + 30) };
  }

  /* Index van het [lat,lon]-punt in `pts` dat het dichtst bij `latlon` ligt. */
  function nearestIndex(pts, latlon) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dLat = pts[i][0] - latlon[0], dLon = pts[i][1] - latlon[1];
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* Afstand (m) tussen twee [lat,lon]-punten (haversine). */
  function haversine(a, b) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  /* Als het omleidingspad `detourPts` de originele route al vroeger terug
     raakt dan het geplande eindpunt `hi` (bv. een BRouter-suggestie die
     verderop toevallig weer over je eigen track loopt), geeft dit het
     eerste zo'n punt terug: {detourIdx, rawIdx}. Anders null. De eerste
     `skipM` meter van beide paden worden overgeslagen om het triviale
     beginpunt niet als "terugkeer" te herkennen; `minRun` opeenvolgende
     nabije punten zijn vereist zodat een toevallige, geïsoleerde nabijheid
     (twee punten die toevallig dicht bij elkaar liggen zonder dat de route
     er echt weer over loopt) niet als terugkeer telt. */
  function earlyRejoin(detourPts, rawPts, lo, hi, skipM = 80, threshM = 20, minRun = 3) {
    let dAcc = 0, dStart = 0;
    while (dStart < detourPts.length - 1 && dAcc < skipM) { dAcc += haversine(detourPts[dStart], detourPts[dStart + 1]); dStart++; }
    let rAcc = 0, rStart = lo;
    while (rStart < hi && rAcc < skipM) { rAcc += haversine(rawPts[rStart], rawPts[rStart + 1]); rStart++; }
    let run = 0, runStart = null;
    for (let i = dStart; i < detourPts.length; i++) {
      let matchJ = -1;
      for (let j = rStart; j <= hi; j++) {
        if (haversine(detourPts[i], rawPts[j]) <= threshM) { matchJ = j; break; }
      }
      if (matchJ === -1) { run = 0; runStart = null; continue; }
      if (run === 0) runStart = { detourIdx: i, rawIdx: matchJ };
      run++;
      if (run >= minRun) return runStart;
    }
    return null;
  }

  /* Het spiegelbeeld van earlyRejoin: als BRouter vanaf het vaste startpunt
     `lo` eerst een stuk TERUG moet rijden over je eigen track om de echte
     aftakking te bereiken (de natuurlijke afslag ligt verder terug dan
     `lo`), geeft dit het vroegste punt van die aftakking terug:
     {detourIdx, rawIdx} met rawIdx < lo. Zo kan de rit die aftakking
     gewoon meteen nemen i.p.v. eerst door te rijden tot `lo` en dan om
     te keren. Geeft null als er geen terugkeer is (het normale geval).
     `minRun` opeenvolgende nabije punten zijn vereist — anders zou een
     enkel toevallig nabijgelegen punt vlak bij `lo` zelf (routepunten
     liggen nu eenmaal dicht bij elkaar) al als "terugkeer" tellen. */
  function earlyDeparture(detourPts, rawPts, lo, backWindowM = 2500, threshM = 20, minRun = 3) {
    let acc = 0, start = lo;
    while (start > 0 && acc < backWindowM) { acc += haversine(rawPts[start - 1], rawPts[start]); start--; }
    if (start >= lo) return null;
    let best = null, run = 0;
    for (let i = 0; i < detourPts.length; i++) {
      let matchJ = -1;
      for (let j = start; j < lo; j++) {
        if (haversine(detourPts[i], rawPts[j]) <= threshM) { matchJ = j; break; }
      }
      if (matchJ === -1) break;   // het omleidingspad heeft de terugkeer verlaten
      run++;
      if (run >= minRun) best = { detourIdx: i, rawIdx: matchJ };
    }
    return best;
  }

  return { buildRoute, expandGrid, analyzeGeom, pointAtChain, buildProfile, findClimbs,
           pathLength, geomCenterRadius, nearestIndex, earlyRejoin, earlyDeparture };
})();
