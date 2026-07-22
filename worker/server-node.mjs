/* =========================================================
   server-node.mjs — draai de Trafiroutes-proxy als gewone
   Node-server (bv. op een Oracle Cloud Always Free VM) i.p.v.
   als Cloudflare Worker. Hergebruikt trafiroutes-proxy.js
   ongewijzigd: Node 18+ heeft dezelfde Request/Response-API.

   Start:   node server-node.mjs        (poort 8787, of PORT=…)
   Test:    curl http://localhost:8787/?type=chantier
   Zet er in productie een HTTPS-reverse-proxy vóór (bv. Caddy),
   want de app zelf draait op https en browsers blokkeren
   mixed content. Zie worker/README.md.
   ========================================================= */
import { createServer } from "node:http";
import worker from "./trafiroutes-proxy.js";

const PORT = parseInt(process.env.PORT || "8787", 10);

/* kleine in-memory cache (3 min): de Worker leunt op de edge-cache van
   Cloudflare; op een VM vangen we dat hier op zodat elke pagina-refresh
   niet opnieuw op de Trafiroutes-servers klopt */
const cache = new Map();
const TTL = 3 * 60 * 1000;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const key = url.search || "";
    const hit = cache.get(key);
    let body, status, headers;
    if (req.method !== "OPTIONS" && hit && Date.now() - hit.t < TTL) {
      ({ body, status, headers } = hit);
    } else {
      const r = await worker.fetch(new Request("http://localhost/" + (url.search || ""), { method: req.method }));
      body = await r.text();
      status = r.status;
      headers = Object.fromEntries(r.headers.entries());
      if (req.method !== "OPTIONS" && status === 200) cache.set(key, { body, status, headers, t: Date.now() });
    }
    res.writeHead(status, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "proxy error" }));   // geen interne details naar buiten
  }
}).listen(PORT, () => console.log(`trafiroutes-proxy luistert op http://localhost:${PORT}`));
