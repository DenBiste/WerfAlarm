#!/usr/bin/env python3
# =========================================================
# build_nl_data.py — Nederland (Melvin/NDW) → compacte gridcellen
#
# Leest de open-data "planningsfeed wegwerkzaamheden en evenementen"
# van NDW (DATEX II v3, ±14 MB gz / ±160 MB XML) en condenseert die
# tot kleine GeoJSON-bestanden per rastercel van 0,5°×0,5°, zodat de
# browser-app alleen de cellen hoeft op te halen die de route raakt.
# Draait elke paar uur in GitHub Actions (zie .github/workflows/).
#
# Belangrijke keuzes:
# · ReroutingManagement-records worden OVERGESLAGEN: dat zijn de
#   aanbevolen omleidingsroutes — die als "hinder" markeren zou juist
#   de omleiding afstraffen.
# · Eén feature per situation (werf), met samengevoegde geometrie en
#   min/max-geldigheid over de records, zodat één werf één kaart wordt.
# · Coördinaten zijn al WGS84 in de bron; afgerond op 5 decimalen en
#   lijnen uitgedund tot max ~25 punten.
#
# Gebruik: python3 build_nl_data.py <feed.xml.gz> <output-dir>
# =========================================================
import gzip, json, math, re, sys
from collections import defaultdict
from datetime import date, datetime, timezone

FEED = sys.argv[1] if len(sys.argv) > 1 else "planningsfeed.xml.gz"
OUT = sys.argv[2] if len(sys.argv) > 2 else "out"

SKIP_TYPES = {"ReroutingManagement", "AbnormalTraffic", "GeneralNetworkManagement"}

ACT_NL = {
    "MaintenanceWorks": "Wegwerkzaamheden",
    "ConstructionWorks": "Bouwwerkzaamheden",
    "PublicEvent": "Evenement",
    "RoadOrCarriagewayOrLaneManagement": "Verkeersmaatregel",
    "SpeedManagement": "Snelheidsbeperking",
}
MAINT_NL = {
    "maintenanceWork": "onderhoudswerken", "resurfacingWork": "nieuwe wegverharding",
    "overheadWorks": "bovengrondse werken", "installationWork": "installatiewerken",
    "treeAndVegetationCuttingWork": "snoeiwerken", "roadsideWork": "bermwerken",
    "repairWork": "herstellingswerken", "sweepingOfRoad": "veegwerken",
    "roadworks": "wegwerkzaamheden",
}
# bewoording stuurt ook de blokkade-detectie in de app: "afgesloten"
# telt als blokkade, een rijstrookmaatregel niet
MGMT_NL = {
    "roadClosed": "weg afgesloten",
    "carriagewayClosures": "rijbaan afgesloten",
    "laneClosures": "rijstrook dicht",
    "narrowLanes": "versmalde rijstroken",
    "lanesDeviated": "verlegde rijstroken",
    "useOfSpecifiedLanesOrCarriagewaysAllowed": "beperkt rijstrookgebruik",
    "other": "verkeersmaatregel",
}

CELL = 0.5  # graden

def cell_key(lon, lat):
    return f"c{math.floor(lon / CELL)}_{math.floor(lat / CELL)}"

def thin(coords, max_pts=25):
    if len(coords) <= max_pts:
        return coords
    step = (len(coords) - 1) / (max_pts - 1)
    return [coords[round(i * step)] for i in range(max_pts)]

def r5(v):
    return round(float(v), 5)

def main():
    txt = gzip.open(FEED, "rb").read().decode("utf-8", errors="replace")
    today = date.today().isoformat()

    features = []
    for sm in re.finditer(r'<sit:situation id="([^"]+)".*?</sit:situation>', txt, re.S):
        block = sm.group(0)
        sit_id = sm.group(1)
        starts, ends, lines, points, cons, act = [], [], [], [], [], None
        owner = ""

        for rm in re.finditer(r'<sit:situationRecord xsi:type="sit:([A-Za-z]+)".*?</sit:situationRecord>', block, re.S):
            rtype, rec = rm.group(1), rm.group(0)
            if rtype in SKIP_TYPES:
                continue
            if act is None or rtype in ("MaintenanceWorks", "ConstructionWorks", "PublicEvent"):
                if act not in ("MaintenanceWorks", "ConstructionWorks", "PublicEvent"):
                    act = rtype
            s = re.search(r"<com:overallStartTime>([^<]+)", rec)
            e = re.search(r"<com:overallEndTime>([^<]+)", rec)
            if s: starts.append(s.group(1))
            if e: ends.append(e.group(1))
            if not owner:
                o = re.search(r'<com:sourceName>.*?<com:value[^>]*>([^<]+)', rec, re.S)
                if o: owner = o.group(1).strip()
            for mt in re.findall(r"<sit:roadOrCarriagewayOrLaneManagementType>([^<]+)", rec):
                lbl = MGMT_NL.get(mt, mt)
                if lbl not in cons: cons.append(lbl)
            for mt in re.findall(r"<sit:roadMaintenanceType>([^<]+)", rec):
                lbl = MAINT_NL.get(mt)
                if lbl and lbl not in cons: cons.append(lbl)
            if rtype == "SpeedManagement" and "snelheidsbeperking" not in cons:
                cons.append("snelheidsbeperking")
            for pl in re.findall(r"<loc:posList>([^<]+)</loc:posList>", rec):
                nums = pl.split()
                coords = [[r5(nums[i + 1]), r5(nums[i])] for i in range(0, len(nums) - 1, 2)]
                if len(coords) >= 2: lines.append(thin(coords))
                elif coords: points.append(coords[0])
            for la, lo in re.findall(r"<loc:latitude>([-\d.]+)</loc:latitude><loc:longitude>([-\d.]+)</loc:longitude>", rec):
                points.append([r5(lo), r5(la)])

        if not lines and not points:
            continue
        start = min(starts)[:10] if starts else None
        end = max(ends)[:10] if ends else None
        if end and end < today:
            continue  # al voorbij

        # geometrie: lijnen als MultiLineString; losse punten als 1-punts
        # "lijnen" erbij (de nabijheidsanalyse van de app leest elk pad)
        seen_geo, geoms = set(), []
        for ln in lines + [[p] for p in points]:
            key = json.dumps(ln)
            if key not in seen_geo:
                seen_geo.add(key); geoms.append(ln)
        geometry = ({"type": "Point", "coordinates": geoms[0][0]}
                    if len(geoms) == 1 and len(geoms[0]) == 1
                    else {"type": "LineString", "coordinates": geoms[0]}
                    if len(geoms) == 1
                    else {"type": "MultiLineString", "coordinates": geoms})

        features.append({
            "type": "Feature", "geometry": geometry,
            "properties": {"i": sit_id, "d": ACT_NL.get(act, "Wegwerkzaamheden"),
                            "c": " · ".join(cons), "s": start, "e": end, "o": owner},
        })

    # verdeel over rastercellen (een feature komt in élke cel die hij raakt)
    cells = defaultdict(list)
    for f in features:
        g = f["geometry"]
        paths = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]] if g["type"] == "LineString" else [[g["coordinates"]]]
        keys = {cell_key(lon, lat) for path in paths for lon, lat in path}
        for k in keys:
            cells[k].append(f)

    import os
    os.makedirs(f"{OUT}/nl", exist_ok=True)
    for k, fs in cells.items():
        with open(f"{OUT}/nl/{k}.json", "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": fs}, fh, ensure_ascii=False, separators=(",", ":"))
    with open(f"{OUT}/nl/index.json", "w", encoding="utf-8") as fh:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "cellDeg": CELL, "cells": sorted(cells.keys()), "situations": len(features)}, fh)
    total = sum(len(v) for v in cells.values())
    print(f"situations: {len(features)} | cellen: {len(cells)} | features incl. dubbels: {total}")

if __name__ == "__main__":
    main()
