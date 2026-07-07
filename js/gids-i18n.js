/* =========================================================
   gids-i18n.js — tweetalige gidsinhoud (uitbreiding op i18n.js)
   ========================================================= */
"use strict";
(() => {
  const G = {
    nl: {
      g_title: "DE ", g_titleHl: "GIDS",
      g_intro: "In een halve minuut zie je hieronder de basisstroom. Daaronder vind je elke stap in detail — inclusief de nieuwste functies: het hoogteprofiel met klimmen, de weersvoorspelling met windpijlen, de kaartlagen en de taalkeuze NL/EN.",
      g_videoCap: "Instructievideo (33 s, zonder geluid). De beelden zijn een gestileerde weergave van een oudere versie van de app: de werkstroom is identiek, maar de nieuwste onderdelen (kaartlagen, hoofdstukken, taalkeuze) zie je op de pagina zelf.",
      g_s1nr: "STAP 01", g_s1t: "Laad je route",
      g_s1p: `<p>Klik op <span class="ui">Laad GPX…</span> of sleep je GPX-bestand op de kaart. Tracks uit Komoot, Strava, Garmin, RideWithGPS en elke andere app werken. Bevat je export hoogtedata (standaard bij Komoot/Strava), dan wordt die gebruikt voor het hoogteprofiel; zo niet, halen we de hoogtes automatisch op.</p><p>Meteen na het laden verschijnen ook de twee hoofdstukken onder de kaart: <b>Hoogteprofiel &amp; klimmen</b> en <b>Weersvoorspelling</b>.</p>`,
      g_s1c1: "Klik op “Laad GPX…” of sleep je bestand op de kaart.",
      g_s1c2: "Route geladen: blauw spoor op de kaart, naam en afstand in de werkbalk.",
      g_s2nr: "STAP 02", g_s2t: "Datum, marge, weggebruikers & lagen",
      g_s2p: `<p>Stel je <span class="ui">Ritdatum</span> in (databank kijkt ±6 maanden vooruit), kies de <span class="ui">Zoekafstand</span> naast je track (0&nbsp;m = enkel wat je track zelf kruist; 20–50&nbsp;m is de aanrader voor de racefiets) en selecteer voor welke <span class="ui">Weggebruiker(s)</span> hinder telt — vrij te combineren.</p><p>Met de balk <span class="ui">Kaartlagen</span> bepaal je wat je ziet: 🚧 blokkades, ⛰️ hoogteprofiel en 🌤️ weer &amp; wind zijn <b>onafhankelijk</b> aan of uit te zetten — meerdere lagen tegelijk is net de bedoeling. Rechtsboven wissel je de hele interface tussen <b>NL</b> en <b>EN</b>.</p>`,
      g_s2c1: "Datum, zoekafstand en weggebruikers; daaronder de combineerbare kaartlagen.",
      g_s3nr: "STAP 03", g_s3t: "Controleer & lees de kaart",
      g_s3p: `<p>Klik op <span class="ui">Controleer route</span>: we bevragen live de open GIPOD-databank (dezelfde bron als geopunt.be/hinder-in-kaart) langs je hele track. Elke werf verschijnt als oranje wegvak op de kaart én als kaartje in de lijst, met km-punt, periode, gevolgen en het aantal passages als je lus er twee keer langs komt.</p><p>De kaart is interactief: <b>genummerde klim-pins</b> brengen je met één klik naar de beschrijving van die klim, <b>windpijlen</b> tonen de windrichting op je parcours (hover voor snelheid), en werf-stippen openen een pop-up met details.</p>`,
      g_s3c1: "De bevraging loopt: de status toont de voortgang per zone.",
      g_s3c2: "Resultaat: oranje wegvakken op de kaart, details in de kaartjes (weergave van een oudere versie).",
      g_s4nr: "STAP 04", g_s4t: "Hoofdstukken, rapport & export",
      g_s4p: `<p>Onder de kaart lees je het <b>hoogteprofiel</b> — grafiek met oranje klimzones, statistieken en per klim een minigrafiekje met cijfers (lengte, start/eind-km, hoogtemeters, gemiddeld en maximaal stijgingspercentage) plus een karakterportret — en de <b>weersvoorspelling</b> voor je ritdatum, inclusief “De wind onderweg”: waar je tegen-, mee- of zijwind hebt.</p><p>Klaar? Download je <span class="ui">Rapport (PDF)</span> — kaart, werven, klimmen en weer in één deelbaar document, in de taal van de interface — of <span class="ui">GPX + werven</span>: je originele route met een waarschuwingspunt op elke werf, zichtbaar op je Garmin of Wahoo.</p>`,
      g_s4c1: "Klik op een werf: inzoomen op het wegvak, met pop-up en alle details.",
      g_faqT: "Goed om te weten",
      g_q1: "Hoe betrouwbaar en actueel is de data?",
      g_a1: "Werven komen live uit GIPOD, het officiële register van innames van de openbare weg in Vlaanderen — exact wat geopunt.be/hinder-in-kaart toont, op het moment dat jij controleert. Hoogte en weer komen van Open-Meteo. Kleine of last-minute werken kunnen ontbreken; controleer kort voor vertrek opnieuw.",
      g_q2: "Waarom blijft hinderinformatie in het Nederlands, ook in de Engelse interface?",
      g_a2: "De omschrijvingen en gevolgen (bv. “weg afgesloten · omleiding voor fietsers”) zijn brondata, ingevoerd door Vlaamse gemeenten, nutsbedrijven en aannemers — en enkel in het Nederlands beschikbaar. Automatisch vertalen zou onnauwkeurigheden kunnen introduceren in precies de informatie waar je veiligheid van afhangt. Daarom tonen we die teksten altijd letterlijk; alle labels en uitleg eromheen volgen wél je taalkeuze.",
      g_q3: "Werkt dit ook buiten Vlaanderen?",
      g_a3: "De werven-laag dekt enkel Vlaanderen (GIPOD): stukken route door Brussel of Wallonië komen leeg terug — dat betekent “geen data”, niet “geen wegenwerken”. Het hoogteprofiel en het weer werken wél overal.",
      g_q4: "Waarom lijkt een werfzone soms breder dan de straat?",
      g_a4: "De vorm komt rechtstreeks van wie de werf intekende. Meestal netjes langs de weg, soms een ruwe cirkel of rechthoek. Bekijk dan de pop-up: omschrijving en gevolgen vertellen wat er écht aan de hand is.",
      g_q5: "Hoe worden klimmen gedetecteerd?",
      g_a5: "Het profiel wordt gladgestreken (zo verzint GPS-ruis geen klimmen) en elke aaneengesloten stijging van ±20 hoogtemeters of meer telt als klim; kleine tussenzakjes horen bij dezelfde klim. Per klim berekenen we lengte, hoogtemeters, gemiddeld en maximaal percentage — het portret eronder is daarop gebaseerd.",
      g_q6: "Wordt mijn route ergens opgeslagen?",
      g_a6: "Nee. Je GPX wordt volledig in je browser verwerkt; enkel kaartuitsnedes (zones) en het middelpunt van je route gaan als zoekvraag naar de open databanken. Geen account, geen opslag.",
      g_cta: "Zelf proberen"
    },
    en: {
      g_title: "THE ", g_titleHl: "GUIDE",
      g_intro: "The half-minute video below shows the basic flow. Underneath you'll find every step in detail — including the newest features: the elevation profile with climbs, the weather forecast with wind arrows, the map layers and the NL/EN language switch.",
      g_videoCap: "Instruction video (33 s, no sound). The visuals are a stylised rendering of an earlier version of the app: the workflow is identical, but the newest parts (map layers, chapters, language switch) are best seen on the page itself.",
      g_s1nr: "STEP 01", g_s1t: "Load your route",
      g_s1p: `<p>Click <span class="ui">Load GPX…</span> or drop your GPX file onto the map. Tracks from Komoot, Strava, Garmin, RideWithGPS and any other app work. If your export contains elevation data (Komoot/Strava include it by default) it is used for the profile; if not, we fetch elevations automatically.</p><p>Right after loading, the two chapters below the map appear as well: <b>Elevation profile &amp; climbs</b> and <b>Weather forecast</b>.</p>`,
      g_s1c1: "Click “Load GPX…” or drop your file onto the map.",
      g_s1c2: "Route loaded: blue track on the map, name and distance in the toolbar.",
      g_s2nr: "STEP 02", g_s2t: "Date, margin, road users & layers",
      g_s2p: `<p>Set your <span class="ui">Ride date</span> (the register looks ±6 months ahead), choose the <span class="ui">Search distance</span> beside your track (0&nbsp;m = only what your track itself crosses; 20–50&nbsp;m is the road-bike sweet spot) and select which <span class="ui">Road user(s)</span> disruptions should count for — combine freely.</p><p>The <span class="ui">Map layers</span> bar controls what you see: 🚧 blockages, ⛰️ elevation profile and 🌤️ weather &amp; wind each toggle <b>independently</b> — running several at once is exactly the idea. Top right you switch the whole interface between <b>NL</b> and <b>EN</b>.</p>`,
      g_s2c1: "Date, search distance and road users; below them the combinable map layers.",
      g_s3nr: "STEP 03", g_s3t: "Check & read the map",
      g_s3p: `<p>Click <span class="ui">Check route</span>: we live-query the open GIPOD register (the same source as geopunt.be/hinder-in-kaart) along your whole track. Every roadwork appears as an orange road section on the map and as a card in the list, with km point, period, consequences and the number of passages if your loop crosses it twice.</p><p>The map is interactive: <b>numbered climb pins</b> jump you straight to that climb's description with one click, <b>wind arrows</b> show the wind direction along your course (hover for the speed), and roadwork dots open a detail popup.</p>`,
      g_s3c1: "The query is running: the status shows progress per zone.",
      g_s3c2: "Result: orange road sections on the map, details in the cards (rendering of an earlier version).",
      g_s4nr: "STEP 04", g_s4t: "Chapters, report & export",
      g_s4p: `<p>Below the map you'll find the <b>elevation profile</b> — a chart with orange climb zones, statistics, and per climb a mini chart with the numbers (length, start/end km, gain, average and maximum gradient) plus a character portrait — and the <b>weather forecast</b> for your ride date, including “The wind along the way”: where you'll face head-, tail- or crosswind.</p><p>Done? Download your <span class="ui">Report (PDF)</span> — map, roadworks, climbs and weather in one shareable document, in the interface language — or <span class="ui">GPX + warnings</span>: your original route with a warning waypoint at every roadwork, visible on your Garmin or Wahoo.</p>`,
      g_s4c1: "Click a roadwork: zoom to the road section, with a popup and all details.",
      g_faqT: "Good to know",
      g_q1: "How reliable and current is the data?",
      g_a1: "Roadworks come live from GIPOD, the official register of public-road occupations in Flanders — exactly what geopunt.be/hinder-in-kaart shows, at the moment you check. Elevation and weather come from Open-Meteo. Small or last-minute works may be missing; check again shortly before departure.",
      g_q2: "Why does blockade information stay in Dutch, even in the English interface?",
      g_a2: "The descriptions and consequences (e.g. “weg afgesloten · omleiding voor fietsers”) are source data, entered by Flemish municipalities, utility companies and contractors — and only available in Dutch. Machine-translating them could introduce inaccuracies in precisely the information your safety depends on. That's why we always show those texts verbatim; all labels and explanations around them do follow your language choice.",
      g_q3: "Does this work outside Flanders?",
      g_a3: "The roadworks layer covers Flanders only (GIPOD): route sections through Brussels or Wallonia come back empty — that means “no data”, not “no roadworks”. The elevation profile and the weather do work everywhere.",
      g_q4: "Why does a work zone sometimes look wider than the street?",
      g_a4: "The shape comes straight from whoever registered the works. Usually it follows the road neatly, sometimes it's a rough circle or rectangle. Check the popup in that case: the description and consequences tell you what's really going on.",
      g_q5: "How are climbs detected?",
      g_a5: "The profile is smoothed first (so GPS noise can't invent climbs) and every continuous rise of roughly 20 vertical metres or more counts as a climb; small dips belong to the same climb. Per climb we compute length, gain, average and maximum gradient — the portrait underneath is based on those numbers.",
      g_q6: "Is my route stored anywhere?",
      g_a6: "No. Your GPX is processed entirely in your browser; only map extents (zones) and the midpoint of your route are sent as queries to the open data services. No account, no storage.",
      g_cta: "Try it yourself"
    }
  };
  /* sleutel-injectie in het centrale woordenboek */
  I18N.extend("nl", G.nl);
  I18N.extend("en", G.en);
  I18N.apply();
})();
