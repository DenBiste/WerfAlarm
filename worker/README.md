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

## Source & attribution

Data © [SPW / Trafiroutes](https://trafiroutes.wallonie.be) (Service public de
Wallonie). Respect their terms of use; the Worker caches responses for a few
minutes to stay gentle on the upstream service.
