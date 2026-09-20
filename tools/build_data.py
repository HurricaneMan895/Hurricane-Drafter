#!/usr/bin/env python3
"""Build the two JSON payloads the drafter ships to the browser.

  data/storms.json  - one compact record per draftable storm (card face data)
  data/tracks.json  - best-track polyline for each of those storms

Inputs:
  data/HurricaneOVRs.csv           ratings / stats / card art (authoritative)
  <tropicalcyclonedatabase>/storm_tracks.html  embedded HURDAT2 track JSON

Usage:
  python3 tools/build_data.py [path/to/storm_tracks.html]
"""
import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "data", "HurricaneOVRs.csv")
DEFAULT_TRACKS_HTML = os.path.join(
    os.path.dirname(ROOT), "TropicalCycloneDatabase", "storm_tracks.html"
)

# Bronze/Silver/Gold/Elite come straight from the CSV. The fifth template
# (5 stars, magenta) is reserved for the handful of 96+ overalls.
LEGENDARY_MIN_OVR = 96
TIER_STARS = {"Bronze": 1, "Silver": 2, "Gold": 3, "Elite": 4, "Legendary": 5}
STATUS_CODES = {"TD": 0, "TS": 1, "HU": 2, "EX": 3, "SD": 4, "SS": 5, "LO": 6, "WV": 7, "DB": 8}


def num(value, cast=float):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return cast(value)
    except ValueError:
        return None


def clean_image(url):
    """Normalise the Wikimedia URLs in the CSV.

    The export uses the `thumb.wikimedia.org` alias with tracking params.
    `upload.wikimedia.org` serves the identical path and is the canonical
    host, so we prefer it and let the page fall back to the original.
    """
    url = (url or "").strip()
    if not url:
        return None
    url = url.split("?", 1)[0]
    return url.replace("https://thumb.wikimedia.org/", "https://upload.wikimedia.org/")


def load_tracks(html_path):
    with open(html_path, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
    match = re.search(
        r'<script id="tracks-data" type="application/json">(.*?)</script>', html, re.S
    )
    if not match:
        raise SystemExit("could not find the tracks-data block in %s" % html_path)
    return {rec["atcf_id"]: rec for rec in json.loads(match.group(1))}


def title_case(name):
    """MITCH -> Mitch, but leave already-mixed names ("Okeechobee Hurricane") alone."""
    return name.title() if name.isupper() else name


def main():
    tracks_html = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TRACKS_HTML
    tracks = load_tracks(tracks_html)

    storms, packed_tracks, skipped = [], {}, []
    with open(CSV_PATH, encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            sid = row["ID"].strip()
            rec = tracks.get(sid)
            if not rec or not rec.get("track"):
                skipped.append(sid)
                continue

            ovr = int(row["Overall"])
            tier = "Legendary" if ovr >= LEGENDARY_MIN_OVR else row["Tier"].strip()
            storms.append({
                "id": sid,
                "n": title_case(row["Storm_Name"].strip()),
                "y": int(row["Year"]),
                "t": tier,
                "o": ovr,
                "c": int(row["Category"]),
                "w": num(row["peak_wind_mph"], int),
                "p": num(row["min_pressure_mb"], int),
                "a": num(row["ace"]),
                "d": num(row["duration_hours"], int),
                "f": num(row["fatalities"], int),
                "img": clean_image(row["image_url"]),
                "lf": bool(rec.get("madeLandfall")),
                "rg": rec.get("regions") or [],
                "sd": rec.get("startDate"),
                "ed": rec.get("endDate"),
                "gen": rec.get("genesis"),
                "ret": bool(rec.get("retired")),
            })

            # [lat, lon, wind_kt, status] per fix. Coordinates keep two decimals
            # (~1 km), which is well beyond what the playback map resolves.
            packed_tracks[sid] = [
                [round(p[0], 2), round(p[1], 2), p[2], STATUS_CODES.get(p[3], 0)]
                for p in rec["track"]
            ]

    storms.sort(key=lambda s: (-s["o"], s["n"]))
    write(os.path.join(ROOT, "data", "storms.json"), {
        "count": len(storms),
        "legendaryMinOvr": LEGENDARY_MIN_OVR,
        "tierStars": TIER_STARS,
        "seasons": real_seasons(),
        "storms": storms,
    })
    write(os.path.join(ROOT, "data", "tracks.json"), {
        "statusCodes": STATUS_CODES,
        "tracks": packed_tracks,
    })

    print("storms: %d" % len(storms))
    print("skipped (no best track): %d" % len(skipped))
    for tier in ("Bronze", "Silver", "Gold", "Elite", "Legendary"):
        print("  %-10s %4d" % (tier, sum(1 for s in storms if s["t"] == tier)))


def real_seasons():
    """Per-year Atlantic totals, so a drafted season can be ranked against
    the real ones. Built from every row of the CSV (including the handful
    with no best track), which is the same source the ratings come from.
    """
    seasons = {}
    with open(CSV_PATH, encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            year = int(row["Year"])
            cat = int(row["Category"])
            season = seasons.setdefault(year, {"ace": 0.0, "ns": 0, "hu": 0, "mh": 0})
            season["ace"] += num(row["ace"]) or 0.0
            season["ns"] += 1
            season["hu"] += 1 if cat >= 1 else 0
            season["mh"] += 1 if cat >= 3 else 0
    for season in seasons.values():
        season["ace"] = round(season["ace"], 1)
    return {str(y): seasons[y] for y in sorted(seasons)}


def write(path, payload):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print("wrote %s (%.1f KB)" % (path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
