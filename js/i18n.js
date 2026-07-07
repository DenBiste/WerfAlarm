/* =========================================================
   i18n.js — interfacetaal NL/EN
   - Statische teksten: elementen dragen data-i18n / data-i18n-html /
     data-i18n-title; apply() vult ze in de actieve taal in.
   - Dynamische teksten: app.js vraagt strings op via I18N.ui().
   - Hinderinformatie (omschrijvingen/gevolgen uit GIPOD) blijft ALTIJD
     Nederlands: dat is brondata van Vlaamse overheden (zie FAQ).
   ========================================================= */
"use strict";
const I18N = (() => {
  /* FIX 5: taalkeuze overleeft paginawissels (index ⇄ gids) via localStorage;
     try/catch zodat file://-restricties gracieus degraderen naar sessie-gedrag */
  let lang = "nl";
  try {
    const saved = localStorage.getItem("routescout-lang");
    if (saved === "en" || saved === "nl") lang = saved;
  } catch (e) { /* opslag niet beschikbaar: geen persistentie, wel werkend */ }
  const listeners = [];

  const D = {
    nl: {
      locale: "nl-BE",
      /* ---------- topbar / hero / bento (index) ---------- */
      navStart: "Start", navGids: "Gids", navCheck: "Naar de check ↓",
      heroKicker: "Jouw verkenner rijdt op kop",
      badgeText: "ROUTESCOUT ▸ VOORUIT GEKEKEN ▸",
      heroH1a: "SCOUT JE ", heroH1hl: "ROUTE", heroH1b: "RIJD GERUST",
      heroLede: "Laad je GPX en zie in enkele seconden élke wegenwerf op je route, het volledige hoogteprofiel met alle klimmen, én de weersvoorspelling met de wind onderweg. Live data uit <strong>GIPOD</strong> en Open-Meteo.",
      heroCta: "Laad je GPX", heroHow: "Hoe werkt het?",
      heroNote: "Komoot · Strava · Garmin · RideWithGPS<br>Gratis, zonder account · NL/EN",
      marquee: "VERKEN JE ROUTE ▸ ELKE WERF ▸ ELKE KLIM ▸ WEER & WIND ▸ HEEL VLAANDEREN ▸ SCOUTED. ▸ ",
      bentoTitle: "Van GPX naar gerust vertrekken",
      s1t: "Laad je route", s1p: "Sleep je GPX op de kaart of kies hem via de knop. Tracks van elke app of fietscomputer werken meteen.",
      s2t: "Kies datum, marge & lagen", s2p: "Wanneer rij je, hoe ver naast je track wil je kijken, en welke lagen wil je zien: blokkades, hoogteprofiel, weer? Combineer vrij.",
      s3t: "Lees, klik & vertrek", s3p: "Werven, klimmen en windpijlen staan op de kaart; klik erop en je springt naar de details. Download daarna je PDF-rapport (NL of EN) of je GPX met waarschuwingen.",
      f1n: "±6", f1u: "mnd", f1p: "vooruitgeplande hinder in de databank — check ook je toertocht van volgende maand",
      f2n: "3", f2u: "lagen", f2p: "blokkades, hoogteprofiel en weer — elk apart aan of uit te zetten",
      liveT: "Live open data", liveP: "Werven uit GIPOD (het officiële Vlaamse register), hoogte en weer via Open-Meteo. Geen kopie, geen vertraging.",
      /* ---------- toolbar ---------- */
      loadGpx: "Laad GPX…", noRoute: "Nog geen route geladen — of sleep een GPX op de kaart",
      rideDate: "Ritdatum", searchDist: "Zoekafstand (m)",
      distTitle: "Hoe ver naast je track gezocht wordt. 0 = enkel hinder die je track zelf raakt of kruist.",
      usersLbl: "Weggebruiker(s)",
      usersTitle: "Voor welke weggebruikers wil je hinder zien? Combineer vrij; algemene afsluitingen gelden voor iedereen.",
      mAll: "Alles", mBike: "🚴 Fietsers", mPed: "🚶 Voetgangers", mMotor: "🚗 Gemotoriseerd",
      filterLbl: "Filter", onlyHard: "⛔ Enkel blokkades",
      onlyHardTitle: "Berekent en toont enkel blokkades: afsluitingen, geen doorgang en omleidingen. Lichtere hinder wordt overgeslagen.",
      run: "Controleer route", dlgpx: "GPX + werven ⬇", report: "Rapport (PDF) ⬇",
      dlgpxTitle: "Download je GPX met een waarschuwings-waypoint op elke werf — zichtbaar op je Garmin of Wahoo",
      reportTitle: "Download een PDF-rapport (kaart, werven, klimmen, weer) in de gekozen taal",
      /* ---------- lagen ---------- */
      layersLbl: "Kaartlagen — combineer vrij:",
      layBlocks: "🚧 Blokkades & hinder", layProfile: "⛰️ Hoogteprofiel", layWeather: "🌤️ Weer & wind",
      /* ---------- status & resultaten ---------- */
      statusLoadFirst: "Laad eerst een GPX-bestand.", statusReady: "Klaar om te controleren.",
      statusQuery: (d, t) => `Bevraagt GIPOD… ${d}/${t}`, statusFail: "Mislukt.",
      statusDone: (n, hard, who, d, cache) => `Klaar — ${n} ${hard ? "blokkade(s)" : "hinder(s)"}${who} actief op ${d}.${cache}`,
      fromCache: " · uit cache", forUsers: t => ` voor ${t}`,
      routeInfo: (name, km, z) => `<b>${name}</b> · ${km} km · ${z} zones`,
      footRoute: (name, km, n) => `Route: ${name}, ${km} km, ${n} punten`,
      emptyStart: "Laad een GPX-bestand en klik op <b>Controleer route</b>.<br>We tonen de hinder op je ritdatum, je hoogteprofiel met klimmen en het weer met de wind onderweg.",
      emptyLoaded: "Route geladen. Kies je ritdatum en klik op <b>Controleer route</b>.",
      segAll: n => `Alles (${n})`, segHard: n => `⛔ Blokkades (${n})`, segKm: "Op km", segSev: "Op ernst",
      calcHardBadge: "⛔ Berekend: enkel blokkades",
      hdrBlocks: (who, scope, d, n) => `Blokkades${who} ${scope} op ${d} (${n})`,
      hdrAll: (who, scope, d, n) => `Hinder${who} ${scope} op ${d} (${n})`,
      scope0: "op je track zelf", scopeN: r => `binnen ${r} m van je route`,
      freeTitle: who => `Vrije baan${who}!`, freeBody: (scope, d) => `Geen hinder gevonden ${scope} op ${d}. Goede rit!`,
      noBlocksTitle: who => `Geen blokkades${who}!`,
      noBlocksBody: (scope, d) => `Geen afsluitingen of omleidingen gevonden ${scope} op ${d}. Lichtere hinder werd niet berekend — vink de filter uit voor het volledige beeld.`,
      noBlocksFiltered: n => `Wel ${n} lichtere hinder(s) — schakel terug naar “Alles” om ze te bekijken.`,
      noBlocksSub: "Geen blokkades",
      activeOn: d => `Actief op ${d}`, blockTag: "⛔ Blokkade",
      onTrack: "op je track", fromTrack: m => `${m} m van je track`,
      passages: (n, l) => `Je passeert hier ${n}×: km ${l}`,
      truncNote: "⚠ Minstens één deelgebied bereikte de limiet van 1000 objecten; mogelijk onvolledig.",
      dutchNote: "ℹ️ Omschrijvingen en gevolgen komen rechtstreeks uit het Vlaamse GIPOD-register en zijn enkel in het Nederlands beschikbaar.",
      stripStart: "Start", stripFinish: "Aankomst",
      stripTick: (km, d) => `km ${km} — ${d}`, stripPass: (i, n) => ` (passage ${i}/${n})`, stripBlock: " (blokkade)",
      werfAria: (km, d) => `Werf op kilometer ${km}: ${d}`,
      gipodFailHtml: `<b>Kon de GIPOD-dienst niet bevragen.</b> Controleer je internetverbinding of raadpleeg handmatig <a href="https://www.geopunt.be/hinder-in-kaart" target="_blank" rel="noopener">geopunt.be/hinder-in-kaart</a>.`,
      pdfFallback: "PDF-bibliotheek niet beschikbaar — HTML-rapport gedownload.", pdfBusy: "PDF maken…",
      /* ---------- hoofdstukken op de pagina ---------- */
      chapProfile: "HOOGTEPROFIEL & KLIMMEN", chapWeather: "WEERSVOORSPELLING",
      profNoData: "Geen hoogtedata beschikbaar: de GPX bevat geen hoogtes en de hoogtedienst was niet bereikbaar.",
      climbPinTitle: (i, km) => `Klim ${i} — top op km ${km}`,
      windArrowTip: (v, dir) => `Wind: ${v} km/u uit ${dir}`,
      weerNoData: "De weersvoorspelling kon niet opgehaald worden. Raadpleeg je weerapp voor vertrek.",
      windHeader: "De wind onderweg",
      /* ---------- footer ---------- */
      footTag: "jouw verkenner op kop — werven, klimmen & weer",
      footSrc: `Bron: <a href="https://www.geopunt.be/hinder-in-kaart" target="_blank" rel="noopener">GIPOD open data</a> (werven, enkel Vlaanderen) &amp; <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (hoogte &amp; weer). Kaart © OpenStreetMap.`
    },
    en: {
      locale: "en-GB",
      navStart: "Start", navGids: "Guide", navCheck: "Go to the check ↓",
      heroKicker: "Your scout rides up the road",
      badgeText: "ROUTESCOUT ▸ SCOUTED AHEAD ▸",
      heroH1a: "SCOUT THE ", heroH1hl: "ROUTE", heroH1b: "RIDE EASY",
      heroLede: "Load your GPX and see, in seconds, every roadwork on your route, the full elevation profile with all climbs, and the weather forecast with the wind along the way. Live data from <strong>GIPOD</strong> and Open-Meteo.",
      heroCta: "Load your GPX", heroHow: "How does it work?",
      heroNote: "Komoot · Strava · Garmin · RideWithGPS<br>Free, no account · NL/EN",
      marquee: "SCOUT YOUR ROUTE ▸ EVERY ROADWORK ▸ EVERY CLIMB ▸ WEATHER & WIND ▸ ALL OF FLANDERS ▸ SCOUTED. ▸ ",
      bentoTitle: "From GPX to a worry-free start",
      s1t: "Load your route", s1p: "Drag your GPX onto the map or pick it via the button. Tracks from any app or bike computer work instantly.",
      s2t: "Pick date, margin & layers", s2p: "When do you ride, how far beside your track should we look, and which layers do you want: blockages, elevation, weather? Combine freely.",
      s3t: "Read, click & ride", s3p: "Roadworks, climbs and wind arrows appear on the map; click them to jump to the details. Then download your PDF report (EN or NL) or your GPX with warnings.",
      f1n: "±6", f1u: "mo", f1p: "of planned disruptions in the register — check next month's sportive too",
      f2n: "3", f2u: "layers", f2p: "blockages, elevation profile and weather — each toggles independently",
      liveT: "Live open data", liveP: "Roadworks from GIPOD (the official Flemish register), elevation and weather via Open-Meteo. No copies, no delay.",
      loadGpx: "Load GPX…", noRoute: "No route loaded yet — or drop a GPX on the map",
      rideDate: "Ride date", searchDist: "Search distance (m)",
      distTitle: "How far beside your track we look. 0 = only disruptions that touch or cross your track itself.",
      usersLbl: "Road user(s)",
      usersTitle: "For which road users do you want to see disruptions? Combine freely; generic closures apply to everyone.",
      mAll: "All", mBike: "🚴 Cyclists", mPed: "🚶 Pedestrians", mMotor: "🚗 Motorised",
      filterLbl: "Filter", onlyHard: "⛔ Blockages only",
      onlyHardTitle: "Calculates and shows only blockages: closures, no-passage and diversions. Lighter disruptions are skipped.",
      run: "Check route", dlgpx: "GPX + warnings ⬇", report: "Report (PDF) ⬇",
      dlgpxTitle: "Download your GPX with a warning waypoint at every roadwork — visible on your Garmin or Wahoo",
      reportTitle: "Download a PDF report (map, roadworks, climbs, weather) in the selected language",
      layersLbl: "Map layers — combine freely:",
      layBlocks: "🚧 Blockages & disruptions", layProfile: "⛰️ Elevation profile", layWeather: "🌤️ Weather & wind",
      statusLoadFirst: "Load a GPX file first.", statusReady: "Ready to check.",
      statusQuery: (d, t) => `Querying GIPOD… ${d}/${t}`, statusFail: "Failed.",
      statusDone: (n, hard, who, d, cache) => `Done — ${n} ${hard ? "blockage(s)" : "disruption(s)"}${who} active on ${d}.${cache}`,
      fromCache: " · from cache", forUsers: t => ` for ${t}`,
      routeInfo: (name, km, z) => `<b>${name}</b> · ${km} km · ${z} zones`,
      footRoute: (name, km, n) => `Route: ${name}, ${km} km, ${n} points`,
      emptyStart: "Load a GPX file and click <b>Check route</b>.<br>We show disruptions on your ride date, your elevation profile with climbs, and the weather with the wind along the way.",
      emptyLoaded: "Route loaded. Pick your ride date and click <b>Check route</b>.",
      segAll: n => `All (${n})`, segHard: n => `⛔ Blockages (${n})`, segKm: "By km", segSev: "By severity",
      calcHardBadge: "⛔ Calculated: blockages only",
      hdrBlocks: (who, scope, d, n) => `Blockages${who} ${scope} on ${d} (${n})`,
      hdrAll: (who, scope, d, n) => `Disruptions${who} ${scope} on ${d} (${n})`,
      scope0: "on your track itself", scopeN: r => `within ${r} m of your route`,
      freeTitle: who => `All clear${who}!`, freeBody: (scope, d) => `No disruptions found ${scope} on ${d}. Enjoy the ride!`,
      noBlocksTitle: who => `No blockages${who}!`,
      noBlocksBody: (scope, d) => `No closures or diversions found ${scope} on ${d}. Lighter disruptions were not calculated — untick the filter for the full picture.`,
      noBlocksFiltered: n => `There are ${n} lighter disruption(s) — switch back to “All” to see them.`,
      noBlocksSub: "No blockages",
      activeOn: d => `Active on ${d}`, blockTag: "⛔ Blockage",
      onTrack: "on your track", fromTrack: m => `${m} m from your track`,
      passages: (n, l) => `You pass here ${n}×: km ${l}`,
      truncNote: "⚠ At least one sub-area hit the 1000-object limit; results may be incomplete.",
      dutchNote: "ℹ️ Descriptions and consequences come straight from the Flemish GIPOD register and are only available in Dutch.",
      stripStart: "Start", stripFinish: "Finish",
      stripTick: (km, d) => `km ${km} — ${d}`, stripPass: (i, n) => ` (passage ${i}/${n})`, stripBlock: " (blockage)",
      werfAria: (km, d) => `Roadwork at kilometre ${km}: ${d}`,
      gipodFailHtml: `<b>Could not query the GIPOD service.</b> Check your internet connection or consult <a href="https://www.geopunt.be/hinder-in-kaart" target="_blank" rel="noopener">geopunt.be/hinder-in-kaart</a> manually.`,
      pdfFallback: "PDF library unavailable — HTML report downloaded instead.", pdfBusy: "Building PDF…",
      chapProfile: "ELEVATION PROFILE & CLIMBS", chapWeather: "WEATHER FORECAST",
      profNoData: "No elevation data available: the GPX contains no altitudes and the elevation service could not be reached.",
      climbPinTitle: (i, km) => `Climb ${i} — summit at km ${km}`,
      windArrowTip: (v, dir) => `Wind: ${v} km/h from ${dir}`,
      weerNoData: "The weather forecast could not be retrieved. Check your weather app before departure.",
      windHeader: "The wind along the way",
      footTag: "your scout up the road — roadworks, climbs & weather",
      footSrc: `Source: <a href="https://www.geopunt.be/hinder-in-kaart" target="_blank" rel="noopener">GIPOD open data</a> (roadworks, Flanders only) &amp; <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (elevation &amp; weather). Map © OpenStreetMap.`
    }
  };

  function apply(root = document) {
    const d = D[lang];
    root.querySelectorAll("[data-i18n]").forEach(el => {
      const v = d[el.dataset.i18n];
      if (typeof v === "string") el.textContent = v;
    });
    root.querySelectorAll("[data-i18n-html]").forEach(el => {
      const v = d[el.dataset.i18nHtml];
      if (typeof v === "string") el.innerHTML = v;
    });
    root.querySelectorAll("[data-i18n-title]").forEach(el => {
      const v = d[el.dataset.i18nTitle];
      if (typeof v === "string") el.title = v;
    });
    document.documentElement.lang = lang;
    document.querySelectorAll(".lang-btn").forEach(b =>
      b.setAttribute("aria-pressed", b.dataset.lang === lang));
  }

  function set(l) {
    if (l !== "nl" && l !== "en") return;
    lang = l;
    try { localStorage.setItem("routescout-lang", l); } catch (e) { /* zie boven */ }
    apply();
    listeners.forEach(f => { try { f(l); } catch (e) { console.warn(e); } });
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".lang-btn").forEach(b =>
      b.addEventListener("click", () => set(b.dataset.lang)));
    apply();
  });

  return { apply, set, onChange: f => listeners.push(f), ui: () => D[lang],
           extend: (l, obj) => Object.assign(D[l], obj), get lang() { return lang; } };
})();
/* FIX 1: een top-level `const` wordt GEEN window-property; app.js test op
   window.I18N en viel daardoor altijd terug op Nederlands. Expliciet koppelen: */
window.I18N = I18N;
