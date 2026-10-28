# V8 Grand Prix

A browser racing game built around the 2006–2013 V8 era: 2.4 L engines screaming to 18,000 rpm,
seamless 7-speed boxes, KERS, DRS, grooved-era tyre behaviour. Race AI or your friends, on any track.

## Run it

Needs only **Python 3.8+** (standard library, nothing to install).

```bash
python3 server.py            # then open http://localhost:8080
python3 server.py --port 9000
```

* **Same wifi / LAN**: the server prints a `http://192.168.x.x:8080` address. Friends open it.
* **Over the internet**: put the server behind any tunnel or host it on a small VPS. WebSockets must be allowed.
  Examples: `cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`. Share the https link.
* The page loads Three.js from the jsDelivr CDN, so players need internet access.

## Playing with friends

1. **Host a race** → you get a 4-letter room code and an invite link (`/?room=ABCD`).
2. Friends enter the code, click the link, or find your room under *Open rooms* (if listed publicly).
3. Host picks circuit / laps / AI drivers / tyre wear / grid order. Everyone picks tyres, wings, brake bias and aids.
4. Host presses **Start**: grid, five red lights, lights out. Results screen after the finish; host returns everyone to the lobby.

## Any track

* 5 built-in circuits (original layouts) incl. a tight street circuit with walls.
* **Random circuit from a seed**: same word → same track for everybody.
* **Track editor**: click to place points, drag to reshape, live validation (overlaps, impossible corners).
  Share tracks as a `V8T1.…` code; friends paste it in the lobby.

## Controls

| Key | Action |
|---|---|
| ↑ / W, ↓ / S, ← → / A D | throttle, brake (hold when stopped = reverse), steer |
| Space (hold) | KERS boost (+80 hp, recharges under braking) |
| X (hold) | DRS, from lap 2 on straights when within 1 s of the car ahead |
| E / Q, G | shift up/down, toggle automatic gearbox |
| C, L, M | camera, racing-line overlay, mute |
| R (hold) | return to track · Esc pause |

Gamepads work (stick, RT/LT, RB/LB, A boost, X DRS, Y camera, B reset).

## What is simulated

* 4-wheel vehicle model at 240 Hz: slip-based combined tyre model with load sensitivity, longitudinal and lateral load transfer,
  aero downforce/drag with slipstream, limited-slip differential, V8 torque map, rev limiter, gearbox with shift cut.
* Tyre **temperature windows** per compound, wear, fuel burn (mass changes), kerbs, grass, gravel, walls, car-to-car contact,
  front-wing damage, wide rear tyres, ABS / traction control / steering-stability aids (all optional).
* Tuned against rough published figures: 0–100 km/h ≈ 2.8 s, top speed ≈ 330 km/h, ≈ 4.8 g braking from 300 km/h, 4+ g cornering at 300 km/h.

## Architecture

* `server.py`: static files + hand-written WebSocket + rooms, start sequence, lap/finish referee, snapshot relay (30 Hz).
* `public/js/physics.js`, `track.js`, `ai.js`: pure modules shared by browser and tests.
* Each client simulates its own car; the host also simulates AI drivers. Remote cars are smoothed and extrapolated.

## Tests

```bash
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc   # macOS
$JSC -m tests/physics-test.js     # acceleration / braking
$JSC -m tests/ramp-test.js        # handling balance sweep
$JSC -m tests/ai-test.js          # AI laps on every track
python3 server.py & python3 tests/net_test.py    # protocol tests (27 checks)
```

## Known limits

* Players trust each other (client-side physics, no anti-cheat). Tracks are flat (no elevation). No pit stops or rain yet.
* A couple of AI cars can still tangle at a crowded standing start.
* Engine audio is synthesised; tune the constants in `audio.js` to taste.

## Put it on the internet (permanent public URL)

The repo includes a `Dockerfile` and `render.yaml`, so it deploys as-is to Render, Fly.io, Railway or any Docker host:

1. Push this folder to a GitHub repository.
2. On render.com: New → Blueprint → pick the repo. Render builds it and gives you `https://your-name.onrender.com`.
3. Share that link. Rooms, WebSockets and https all work with no changes (the client switches to `wss://` automatically).

Free tiers sleep when idle, so the first visit after a quiet spell takes ~30 s to wake.
