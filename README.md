# sizing-game

How big is it? A browser game about scale.

**Play it: https://traceysun.github.io/sizing-game/**

You're shown a 3D model of a random, obscure-but-real object or animal. Spin it around, then drag the person next to it until they look the right size relative to the object. Lock in your guess — each object is worth up to 100 points depending on how close you got to its true height. A game is 5 objects, so your total is out of 500.

## Play

Serve the folder (the game fetches `objects.json` and `models/*.glb`, which browsers block over `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Add `?o=okapi` to start on a specific object.

## Controls

- **Drag the object** to rotate it
- **Drag the person up/down** (or use the slider) to resize them
- **Lock in** (or Enter) to score; **Next object** (or Enter) to continue

## How it's built

- Plain HTML/CSS/JS with [three.js](https://threejs.org) loaded from a CDN — no build step
- Models were generated with Tripo text-to-3D via Higgsfield, then shrunk from ~1.5M triangles / 42 MB to ~40k triangles / 2–5 MB each with `tools/decimate.py` (Open3D decimation + xatlas re-unwrap + a texture bake)
- `objects.json` holds each object's name, model file, real height in metres, and a fact for the reveal

## Scoring

Per object: `100 × max(0, 1 − |log₂(guess / actual)| / 2)` — dead on is 100, 2× off is 50, 4× or more off is 0. Five objects per game, total out of 500. The banner shows the best game total of the day.

## Adding an object

1. Generate a GLB and drop it in `raw/`
2. `python3 tools/decimate.py raw/thing.glb models/thing.glb` (needs `pip install trimesh open3d xatlas scipy pillow`)
3. Add an entry to `objects.json` with its `height_m`

## Top score of the day

The banner's "top score today" comes from a tiny Cloudflare Worker with a KV namespace (`worker/worker.js`). Deploy it, put its URL in `SCORE_API` at the top of `game.js`, and every player's lock-in reports to it. Without it, the banner shows the best score in the visitor's own browser.

## Add your own object

`add.html` lets anyone photograph a thing; the browser cuts the object out with `@imgly/background-removal` (the small quantised model, ~67 MB one-time download; `sw.js` caches it and `add.js` fetches its chunks in parallel), then pixelates it to 80 px so rough edges don't matter, they enter its real height, and it's added to the lineup straight away. `admin.html` (needs the worker's `ADMIN_KEY` secret) lets you remove any. Cut-outs are served from the worker and mixed into the lineup as flat cards.
