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
     Geeft [minAfstand_m, kilometerpunt_m] of null. */
  function analyzeGeom(route, g, thresh) {
    if (!g) return null;
    const paths = geomPaths(g);
    const toXY = (lat, lon) => [lon * route.MX, lat * MY];
    let best = Infinity, ch = 0, anyNear = false;

    for (const p of paths) {
      for (const pt of densify(route, p)) {
        if (!nearRoute(route, pt[0], pt[1])) continue;
        anyNear = true;
        const [d, c] = distToRoute(route, pt[0], pt[1]);
        if (d < best) { best = d; ch = c; }
        if (best === 0) break;
      }
    }
    const isPoly = g.type === "Polygon" || g.type === "MultiPolygon";
    if ((!anyNear || best > thresh) && isPoly) {
      /* een grote zone kan de route omsluiten zonder nabije rand */
      const rings = paths.map(p => p.map(c => toXY(c[1], c[0])));
      for (let i = 0; i < route.R.length; i += 3)
        for (const r of rings)
          if (pointInRing(route.R[i][0], route.R[i][1], r)) return [0, route.CHAIN[i]];
      if (!anyNear) return null;
    }
    if (!anyNear) return null;
    return [best, ch];
  }

  return { buildRoute, expandGrid, analyzeGeom };
})();
