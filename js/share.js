/* =========================================================
   share.js — routes bewaren (localStorage) & delen via link
   Geen server: de route zelf zit gecomprimeerd in het URL-fragment
   (na de #), dat nooit naar een server wordt gestuurd.
   ========================================================= */
"use strict";
const Share = (() => {
  /* Polyline-encodering (delta + varint, precisie 1e-5 ≈ 1,1 m) met een
     base64url-alfabet i.p.v. het klassieke ASCII-bereik, zodat het
     resultaat URL-veilig is zonder percent-escaping (die de link fors
     langer zou maken). */
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const IDX = {}; [...ABC].forEach((c, i) => IDX[c] = i);

  function encodePoints(pts) {
    let out = "", pLat = 0, pLon = 0;
    const enc = v => {
      v = v < 0 ? ~(v << 1) : v << 1;
      let s = "";
      while (v >= 32) { s += ABC[32 | (v & 31)]; v >>= 5; }
      return s + ABC[v];
    };
    for (const [lat, lon] of pts) {
      const iLat = Math.round(lat * 1e5), iLon = Math.round(lon * 1e5);
      out += enc(iLat - pLat) + enc(iLon - pLon);
      pLat = iLat; pLon = iLon;
    }
    return out;
  }

  function decodePoints(str) {
    const pts = []; let i = 0, lat = 0, lon = 0;
    const dec = () => {
      let shift = 0, result = 0, b;
      do {
        b = IDX[str[i++]];
        if (b === undefined) throw new Error("ongeldige polyline");
        result |= (b & 31) << shift; shift += 5;
      } while (b & 32);
      return (result & 1) ? ~(result >> 1) : (result >> 1);
    };
    while (i < str.length) { lat += dec(); lon += dec(); pts.push([lat / 1e5, lon / 1e5]); }
    return pts;
  }

  /* ---------------- bewaarde routes (localStorage) ---------------- */
  const KEY = "routescout-saved-routes";
  const MAX = 12;

  function list() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { return []; }
  }

  /* entry: {name, km, savedAt, p (gecodeerde punten), e (hoogtes|null), set (instellingen)} */
  function save(entry) {
    try {
      const cur = list().filter(x => x.name !== entry.name);
      cur.unshift(entry);
      localStorage.setItem(KEY, JSON.stringify(cur.slice(0, MAX)));
      return true;
    } catch (e) { return false; }
  }

  function remove(name) {
    try { localStorage.setItem(KEY, JSON.stringify(list().filter(x => x.name !== name))); }
    catch (e) { /* opslag niet beschikbaar */ }
  }

  /* Werk een bestaande route bij zonder de volgorde te wijzigen (save()
     zet de route bovenaan — dat is ongewenst voor bv. een bijgewerkte
     controle-vingerafdruk). */
  function update(name, patch) {
    try {
      const cur = list();
      const i = cur.findIndex(x => x.name === name);
      if (i === -1) return false;
      cur[i] = { ...cur[i], ...patch };
      localStorage.setItem(KEY, JSON.stringify(cur));
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- deelbare link ---------------- */
  /* o: {name, p, d, sh, eh, sp, rg, m, oh} — p is al gecodeerd */
  function buildLink(o) {
    const q = new URLSearchParams();
    q.set("v", "1");
    q.set("n", o.name);
    q.set("p", o.p);
    if (o.d) q.set("d", o.d);
    if (o.sh) q.set("a", o.sh);
    if (o.eh) q.set("b", o.eh);
    if (o.sp) q.set("s", o.sp);
    if (o.rg != null && o.rg !== "") q.set("r", o.rg);
    if (o.m) q.set("m", o.m);
    if (o.oh) q.set("h", "1");
    return location.origin + location.pathname + "#" + q.toString();
  }

  /* Geeft {name, pts, set} of null als de huidige URL geen gedeelde route bevat. */
  function parseLink() {
    const h = location.hash.slice(1);
    if (!h.includes("p=")) return null;
    try {
      const q = new URLSearchParams(h);
      const p = q.get("p");
      if (!p) return null;
      const pts = decodePoints(p);
      if (pts.length < 2) return null;
      return {
        name: q.get("n") || "",
        pts,
        set: {
          d: q.get("d") || "", sh: q.get("a") || "", eh: q.get("b") || "", sp: q.get("s") || "",
          rg: q.get("r"), m: q.get("m") || "", oh: q.get("h") === "1" ? 1 : 0
        }
      };
    } catch (e) { return null; }
  }

  return { encodePoints, decodePoints, list, save, remove, update, buildLink, parseLink };
})();
