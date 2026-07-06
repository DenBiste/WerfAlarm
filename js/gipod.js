/* =========================================================
   gipod.js — bevraging van de GIPOD open data
   (dezelfde bron als geopunt.be/hinder-in-kaart)
   ========================================================= */
"use strict";
const GIPOD = (() => {
  const BASE = "https://geo.api.vlaanderen.be/GIPOD/ogc/features/v1/collections/";
  const COLLECTIONS = ["HINDER", "INNAME"]; // gevalideerde hinder + innames (werken)

  /* Bevraagt alle zones (bboxes) voor beide collecties.
     onFeature(feature, collection) wordt voor elk object aangeroepen,
     onProgress(done, total) na elke afgehandelde deelbevraging.
     Geeft {truncated} terug. */
  async function query(tiles, onFeature, onProgress) {
    const total = tiles.length * COLLECTIONS.length;
    let done = 0, truncated = false;
    for (const col of COLLECTIONS) {
      for (let t = 0; t < tiles.length; t += 5) {           // 5 tegelijk
        await Promise.all(tiles.slice(t, t + 5).map(async bb => {
          const url = `${BASE}${col}/items?bbox=${bb.join(",")}&limit=1000&f=json`;
          const r = await fetch(url, { headers: { Accept: "application/geo+json, application/json" } });
          if (!r.ok) throw new Error(`GIPOD antwoordde ${r.status} voor ${col}`);
          const j = await r.json();
          done++; onProgress(done, total);
          if ((j.numberReturned || 0) >= 1000) truncated = true;
          for (const f of (j.features || [])) onFeature(f, col);
        }));
      }
    }
    return { truncated };
  }

  /* ---- attributen robuust uitlezen (schema kan variëren) ---- */
  const pick = (props, cands) => {
    for (const k of Object.keys(props))
      if (cands.some(c => k.toLowerCase() === c)) return props[k];
    return null;
  };
  const pickRe = (props, re, dateLike) => {
    for (const [k, v] of Object.entries(props))
      if (re.test(k) && v != null && v !== "" && (!dateLike || !isNaN(Date.parse(v)))) return v;
    return null;
  };

  function summarize(props, collection) {
    return {
      id:    pick(props, ["gipodid", "id"]) ?? "",
      desc:  pick(props, ["beschrijving", "description", "omschrijving", "naam", "name", "referentie"])
             ?? pickRe(props, /(beschrijv|descript|omschrijv)/i) ?? "(geen omschrijving)",
      start: pickRe(props, /(start|begin|van(?!dal))/i, true),
      end:   pickRe(props, /(eind|end|tot)/i, true),
      cons:  pickRe(props, /(gevolg|consequen)/i) ?? "",
      owner: pickRe(props, /(beheerder|owner|organisat|initiatief|verantwoord)/i) ?? "",
      cat:   pickRe(props, /(type|categor|aard)/i) ?? "",
      collection, props
    };
  }

  const fmtDate = s => {
    if (!s) return "?";
    return new Date(s).toLocaleDateString("nl-BE", { day: "numeric", month: "short", year: "numeric" });
  };

  return { query, summarize, fmtDate };
})();
