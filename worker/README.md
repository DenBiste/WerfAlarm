# Trafiroutes proxy (Wallonia roadworks)

RouteScout runs entirely in the browser. The Walloon **Trafiroutes** roadworks
feed can't be called directly from browser code for two reasons:

1. it sends **no CORS header**, so the browser blocks the request, and
2. it returns coordinates in **Belgian Lambert 72 (EPSG:31370)**, not WGS84.

This tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) fetches
the feed server-side, reprojects every point to WGS84 (verified against `pyproj`
to < 5 mm), and returns GeoJSON with `Access-Control-Allow-Origin: *`. No API
key, secret, or binding is needed.

Flanders (GIPOD) and Brussels (Bruxelles Mobilité) work **without** any proxy —
this Worker only enables the Wallonia source.

## Deploy (free tier is plenty)

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

Wrangler prints a URL like
`https://routescout-trafiroutes-proxy.<your-subdomain>.workers.dev`.

## Point RouteScout at it

Open RouteScout and run once in the browser console (persists in `localStorage`):

```js
localStorage.setItem("routescout-wal-proxy",
  "https://routescout-trafiroutes-proxy.<your-subdomain>.workers.dev");
```

The Wallonia source activates automatically for routes in Wallonia. If the key
is not set, RouteScout simply skips Wallonia (Flanders + Brussels still work).

## Endpoint

```
GET <worker-url>?type=chantier   # roadworks (default)
GET <worker-url>?type=incident   # incidents
GET <worker-url>?type=all        # both
GET <worker-url>?lang=FR|NL      # description language (default FR)
```

Returns a GeoJSON `FeatureCollection`; each feature is a `Point` with
`properties: { id, kind, title, category }`.

## Alternative: run it on a plain VM (e.g. Oracle Cloud Always Free)

No Cloudflare account? The same code runs as a normal Node server —
`server-node.mjs` wraps `trafiroutes-proxy.js` unchanged (Node ≥ 18) and adds a
3-minute in-memory cache:

```bash
node server-node.mjs          # listens on :8787 (override with PORT=…)
curl http://localhost:8787/?type=chantier
```

Because RouteScout itself is served over HTTPS, browsers block a plain-HTTP
proxy (mixed content), so put a free HTTPS reverse proxy in front — e.g.
[Caddy](https://caddyserver.com) with a free [DuckDNS](https://www.duckdns.org)
hostname:

```
# /etc/caddy/Caddyfile
yourname.duckdns.org {
    reverse_proxy 127.0.0.1:8787
}
```

Then set `localStorage["routescout-wal-proxy"] = "https://yourname.duckdns.org"`.
Detailed Oracle Cloud (OCI Always Free) steps: create an Ubuntu VM, open
TCP 80+443 in **both** the subnet's Security List **and** the VM's own
iptables (OCI Ubuntu images ship with a restrictive ruleset), install
Node + Caddy, run `server-node.mjs` under systemd.

## Source & attribution

Data © [SPW / Trafiroutes](https://trafiroutes.wallonie.be) (Service public de
Wallonie). Respect their terms of use; the Worker caches responses for a few
minutes to stay gentle on the upstream service.
