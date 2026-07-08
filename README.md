# ⛳ Golf Buddy

A **hands-free GPS caddie** that lives in your pocket. Start a round, put the
phone in your bag, and it:

1. **Finds the course you're on** with GPS and pulls the hole layouts (tees,
   greens, fairways, bunkers, pars) from OpenStreetMap's golf data.
2. **Shows every hole in beautiful stylised 3D** — a low-poly Three.js scene
   with crisp greens, fairways, bunkers, water and the pin, shaped by real
   slopes from Google's Elevation data. Drag to orbit, pinch to zoom. A
   Google Maps photorealistic 3D flyover is one tap away.
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

**ELI5: what's an API key?** Google's 3D imagery isn't anonymous — Google
wants to know who's asking for maps, so they give you a long password string
(the "key") and your app shows it with every map request. Everyone gets a
large free monthly allowance (~$200 worth); one golfer can't get close to it,
so it's effectively free, but Google asks for a card at sign-up.

**Getting your key (~5 minutes):**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   sign in with your normal Google account.
2. Create a "project" (just a folder for your stuff) — call it `golf-buddy`.
3. Add a card if it asks for billing (free-allowance thing; you won't be
   charged for normal use).
4. Search **"Maps JavaScript API"** at the top → click it → press **Enable**.
5. Left menu → **Keys & Credentials** → **Create credentials** → **API key**.
   Copy the long `AIza...` string.
6. Open Golf Buddy → **⚙️ Settings** → paste the key → **Save**. Done.

**Safety step (recommended):** your site's code is public, so lock the key to
your site: in the console click the key → **Application restrictions** →
**Websites** → add your domain (e.g. `wallacewain.github.io`). Now the key is
useless anywhere else.

The key is stored only in your browser's localStorage — it never leaves your
phone.

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
| Say the club, then **"yes"** when it reads it back | Confirms the club — only confirmed clubs train your averages |
| Say nothing / it mishears | Shows a big club grid to tap once (a tap counts as confirmed) |
| Tap **Hole Note** and jot a tip ("aim left of the bunker") | Saves it for that hole and reads it back next time you're on that tee |
| Tap 🎙️ **Caddie** (or glance at the screen) | Speaks distance to the green + club recommendation |
| Walk to the next tee | Auto-advances to the next hole and announces it |
| Tap **Rest** between shots | Screen goes black (battery saver) — mic, GPS and voice keep working; tap to wake |
| Putt out & tap 🏁 **End** | Saves the round and updates your club distances |

The manual 🏌️ **Shot** button does the same as the mic detection, for driving
ranges, windy days, or phones with the mic off.

**Voice input** (saying the club name) uses the browser's speech recognition —
best on **Android Chrome**. On iPhones the app falls back to the tap-once club
grid automatically.

## How club learning works

- Each shot is stamped with GPS. When you hit the *next* shot, the distance
  between the two points is the previous club's carry.
- **Only confirmed clubs count** — a tap on the club grid, or a spoken "yes"
  after the club is read back. If the mic mishears and you don't confirm,
  the shot stays on the scorecard but never touches your averages.
- Carries feed a recency-weighted average per club (chips under 30 yards and
  putts are excluded so they don't drag your averages down).
- Recommendations use *your* averages once a club has 2+ measured shots;
  before that, sensible defaults. Check **📊 My clubs** to see what it's
  learned.

## Privacy — everything lives on your phone

There is no account, no server, and no database. Rounds, shots, club stats,
hole notes, cached course data and your API key all live in your browser's
local storage on the device. Nothing you record is ever uploaded. The only
network calls are *downloads*: course geometry from the Overpass API and map
tiles from Google (if you added a key). Clearing the browser's site data
erases everything, so treat that as the "factory reset".

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
js/map3d.js         Google Maps photorealistic 3D flyover + Elevation data
js/hole3d.js        stylised low-poly 3D hole (Three.js, real slopes)
js/holeview.js      stylised 2D hole rendering (no WebGL fallback)
js/analytics.js     course book + smart tips from your round history
js/vendor/          three.js (vendored so the app works offline)
js/shotlistener.js  mic impact detection (Web Audio)
js/voice.js         speech out + speech in (Web Speech)
js/caddie.js        clubs, carry learning, recommendations
js/store.js         localStorage persistence
sw.js               offline app shell (PWA)
```
