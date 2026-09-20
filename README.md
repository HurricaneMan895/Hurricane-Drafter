# Hurricane Drafter

Open fourteen packs, draft fourteen real Atlantic tropical cyclones, then watch
the season you built replay track-by-track on satellite imagery and see how its
totals stack up against every Atlantic season since 1851.

A single static page. No build step, no framework, no server.

**Companion to [tropicalcyclonedatabase.com](https://tropicalcyclonedatabase.com/).**

---

## How it plays

1. **Draft** — fourteen packs. In *Draft* mode each pack shows three cards and
   you keep one; in *Straight pulls* mode each pack gives you one card and you
   live with it. No storm can appear twice in a run.
2. **Replay** — the fourteen storms are ordered by where they fell in the
   calendar year, then animated one at a time over Esri satellite imagery,
   drawn in Saffir–Simpson colours with a live wind/category readout.
3. **Report** — season totals: ACE, hurricanes, majors, peak wind, lowest
   pressure, storm days, deaths, retired names — plus the season's rank against
   all 175 real Atlantic seasons in the record.

## Cards

Each card is one storm. The tier is a function of its overall rating, which the
Tropical Cyclone Database computes from what the storm actually did — peak wind,
minimum pressure, ACE, duration and death toll, each as a percentile against the
whole record.

| Tier | Stars | Pack odds | Pool |
|---|---|---|---|
| Bronze | ★ | 52.0% | 479 |
| Silver | ★★ | 30.0% | 738 |
| Gold | ★★★ | 14.0% | 627 |
| Elite | ★★★★ | 3.5% | 106 |
| Legendary | ★★★★★ | 0.5% | 11 |

*Legendary* is not a column in the source data — it is the top slice of Elite,
every storm rated 96 or better. Eleven storms qualify: Mitch, Maria, the 1928
Okeechobee hurricane, Inez, David, the 1938 New England hurricane, Matthew,
Dorian, Allen, Ivan and Irma.

Card art is the storm's real satellite or analysis image where one exists
(roughly a third of the pool). The rest get a cyclone generated from the storm's
ATCF id and tinted by its peak category — deterministic, so a given storm always
looks the same.

## Data

| File | What it is |
|---|---|
| `data/HurricaneOVRs.csv` | Source ratings, stats and image URLs, 1,988 storms |
| `data/storms.json` | Card data for the 1,961 draftable storms, plus per-year season totals |
| `data/tracks.json` | Best-track polyline for each of those storms |

Tracks come from the HURDAT2-derived dataset embedded in the Tropical Cyclone
Database's `storm_tracks.html`. Twenty-seven storms in the CSV (all from the
1850s–1870s) have no matching best track and are left out of the pool, so the
replay never hits a storm it cannot draw.

Season totals are summed from the full CSV — all 1,988 storms — so the ranking a
drafted season is measured against uses every storm on record, not just the
draftable ones.

To rebuild both JSON files after editing the CSV:

```sh
python3 tools/build_data.py [path/to/storm_tracks.html]
```

The script defaults to `../TropicalCycloneDatabase/storm_tracks.html`.

## Running it

Any static server — the page fetches JSON, so `file://` will not work:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## Layout

```
index.html                   markup for all four screens
assets/css/app.css           everything visual, including the card geometry
assets/js/app.js             draft logic, track playback, season report
assets/templates/*.webp      the five card frames
assets/vendor/leaflet/       Leaflet 1.9.4, vendored so the page works offline
data/                        CSV source and the two generated JSON payloads
tools/build_data.py          CSV + tracks → data/*.json
```

### Card geometry

The frames are 1429×2000 artwork with an opaque white interior. The page paints
a white well, then the storm art, then the frame itself composited with
`mix-blend-mode: multiply` — so the frame's corner rules and star row land on
top of the art while the white interior lets it through. The regions are CSS
custom properties (`--art-top`, `--art-bottom`, `--band-top`) at the top of
`app.css`; adjust those if the artwork changes.

## Credits

Imagery © Esri, Maxar, Earthstar Geographics. Track data: HURDAT2 / NHC.
Storm photographs: Wikimedia Commons. Leaflet © Volodymyr Agafonkin.
