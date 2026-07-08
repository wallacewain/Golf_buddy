# ⛳ Golf Buddy

A **hands-free GPS caddie** that lives in your pocket. Start a round, put the
phone in your bag, and it:

1. **Finds the course you're on** with GPS and pulls the hole layouts (tees,
   greens, fairways, bunkers, pars) from OpenStreetMap's golf data.
2. **Shows a stylised 3D flyover** of every hole using Google Maps
   photorealistic 3D — camera swoops in behind the tee looking down the hole.
3. **Hears your shot** with the microphone (the impact "crack"), then *asks
   out loud* **"What club?"** — just say *"seven iron"* and it's logged.
4. **Measures every shot with GPS** — the distance from where you hit to
   where you hit the next one is that club's real carry.
5. **Learns your game** and recommends clubs on future rounds:
   *"148 yards to the middle — I'd take the 7 iron, you average 151 with it."*

You should barely ever need to look at the screen — but when you do, the
glance panel shows front/middle/back distances in huge type plus the
recommended club, and the hole view shows where to hit when the line is blind.

## Try it

It's a static web app (PWA) — host it anywhere with HTTPS. The easiest way is
**GitHub Pages**: repo → Settings → Pages → deploy from the `main` branch.
Then open the URL on your phone and "Add to Home Screen".

> HTTPS is required — browsers only allow GPS and microphone on secure pages.

Not on a course? Tap **"Try demo (St Andrews)"** on the start screen — it
simulates walking the Old Course so you can play with every feature at home.

## Setup

### Google Maps 3D flyover (optional but pretty)

Everything works without a key — you get the stylised 2D hole view instead.
For the photorealistic 3D flyover:

1. Create a key at [Google Cloud Console](https://console.cloud.google.com/google/maps-apis)
   with **Maps JavaScript API** enabled (the free monthly credit is far more
   than a season of golf will use).
2. Open Golf Buddy → **⚙️ Settings** → paste the key → Save.

The key is stored only in your browser's localStorage — it never leaves your
phone. Restrict the key to your GitHub Pages domain in the Cloud Console.

### Course data

Hole layouts come from [OpenStreetMap](https://www.openstreetmap.org). Most
well-known courses are mapped (holes, greens, bunkers). If yours isn't, shot
tracking and club learning still work — only the distances-to-green and hole
views need the map data. Mapping your home course on OSM takes about an hour
and helps every golfer who plays it.

## Using it on the course

| You do | Golf Buddy does |
|---|---|
| Tap **Start Round** on the first tee | Finds the course, flies to your hole, starts listening |
| Hit a shot | Chirps, then asks **"What club?"** — say it, done |
| Say nothing / it mishears | Shows a big club grid to tap once |
| Tap 🎙️ **Caddie** (or glance at the screen) | Speaks distance to the green + club recommendation |
| Walk to the next tee | Auto-advances to the next hole and announces it |
| Putt out & tap 🏁 **End** | Saves the round and updates your club distances |

The manual 🏌️ **Shot** button does the same as the mic detection, for driving
ranges, windy days, or phones with the mic off.

**Voice input** (saying the club name) uses the browser's speech recognition —
best on **Android Chrome**. On iPhones the app falls back to the tap-once club
grid automatically.

## How club learning works

- Each shot is stamped with GPS. When you hit the *next* shot, the distance
  between the two points is the previous club's carry.
- Carries feed a recency-weighted average per club (chips under 30 yards and
  putts are excluded so they don't drag your averages down).
- Recommendations use *your* averages once a club has 2+ measured shots;
  before that, sensible defaults. Check **📊 My clubs** to see what it's
  learned.

## Privacy

Everything — rounds, shots, club stats, your API key — stays in your
browser's local storage. The only network calls are to the Overpass API
(course geometry) and Google Maps (map tiles, if you added a key).

## Development

No build step, no dependencies — plain ES modules. Serve the folder with any
static server (`python3 -m http.server`) and open it. Note GPS/mic need
HTTPS or `localhost`.

```
index.html          app shell
css/style.css       glanceable sunlight-friendly UI
js/app.js           round flow / state machine
js/course.js        course + hole detection (Overpass/OSM)
js/gps.js           position tracking
js/geo.js           geodesy helpers
js/map3d.js         Google Maps photorealistic 3D flyover (+ fallback)
js/holeview.js      stylised 2D hole rendering (no key needed)
js/shotlistener.js  mic impact detection (Web Audio)
js/voice.js         speech out + speech in (Web Speech)
js/caddie.js        clubs, carry learning, recommendations
js/store.js         localStorage persistence
sw.js               offline app shell (PWA)
```
