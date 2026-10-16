# TTT Kart — Brainrot Grand Prix

This checkout adds eight procedural brainrot racers, calmer phone handling, Beer Blitz, and local split-screen racing for up to four people to the original TTTKart game.

## Launch

```sh
npm ci
npm start
```

Open the desktop URL printed by the server (normally http://localhost:3000). Phones and the display must share Wi-Fi. In **Regular play**, each player scans a **different player-slot QR**. The local HTTPS certificate must be accepted once before enabling motion. Each slot uses a separate private controller room so input, reconnects, menus, and item state remain independent. This is shared-display local multiplayer, not remote matchmaking.

## Play

- **Quick Play:** one player, Tung Tung Tung Sahur, Classic kart, Street wheels, Breezy Bay. Keyboard/gamepad or the phone paired to slot 1.
- **Regular play:** connect 1–4 phones → character → kart → wheels → map. Confirm each choice on your own phone; the final phone confirmation advances the group. The desktop can also select and confirm. If someone changes the shared map, everyone confirms it again.
- **Two players:** top/bottom views. **Three players:** four quadrants with one spare. **Four players:** four quadrants. Each has its own camera, place, lap, speed, item, and drift/beer status.
- **Pause / Menu** or Escape pauses. Quit returns to the start screen. Disconnecting an active phone pauses; reconnect its slot and resume. Results wait for all human racers, then allow the CPUs a short finish window.
- **Controls:** tilt or touch steering; gas on the left, drift on the right, brake and item below. Settings offer sensitivity, inversion, haptics, and optional auto-gas. Center calibrates neutral. Keyboard: WASD/arrows, Shift drift, Space item, Escape pause.
- **Beer Blitz 🍺:** gives all other unfinished, non-starred racers six seconds of bounded steering wobble. Steering remains usable; the effect fades out during the last second. A star clears it. Repeated hits refresh the timer rather than stacking strength.

## What changed

All eight selectable and CPU characters are brainrot interpretations made from original procedural geometry: Tung Tung Tung Sahur, Tralalero Tralala, Brr Brr Patapim, Bombardiro Crocodilo, Ballerina Cappuccina, Chimpanzini Bananini, Lirili Larila, and Cappuccino Assassino. Kart bodies and wheels change the rendered model and stats. The original coastal circuit remains available alongside **Sahur Speedway**, a new broad stadium oval.

Phone defaults now use a 3.5° dead zone, 45° full lock, a softer response near center, and approximately 71ms low-pass filtering. Existing saved sensitivity preferences are retained. Drift arcs are wider, with countersteering to open the line, three spark tiers, and a release mini-turbo. See `HANDLING.md` for research, tuning, and test scope.

## Validation

```sh
npm test                   # physics, race/item logic, multiplayer rules
npm run test:net           # socket protocol + reconnection
npm run test:pad           # synthetic motion, touch, orientation and phone UI
npm run test:integration   # actual browser + four independent socket controllers
```

Browser tests use Chrome at its standard macOS path. The integration test accepts `CHROME_PATH` and `TEST_URL`; without `TEST_URL` it starts an isolated server on ports 3110/3550. Real-device tilt feel and Wi-Fi latency still need a hands-on playtest.

---

## Upstream documentation

# TTTKart — Version 1

TTTKart is an open source 3D kart racing game for the desktop browser. Your **phone
becomes the steering wheel**: scan a QR code, turn the phone like a wheel, and use
the on-screen GAS / BRAKE / DRIFT / ITEM buttons. Keyboard and gamepads work too.

This is the first public version. The current game displays **KRISHIV KART** in its
menus; TTTKart is the repository name. The next priorities are adding brainrot
characters and improving the gameplay.

## What's in v1

* Single-player races against seven CPU opponents on **Breezy Bay Circuit**, with
  three laps and Easy, Normal, or Hard difficulty.
* Twelve playable preset racers, each with their own appearance and driving stats.
* Drift mini-turbos, boost pads, a ramp, an arch bridge, and a lighthouse hairpin.
* Eight items: Banana Peel, Bouncer, Homing Rocket, Toot Boost, Triple Toot, Stink
  Bomb, Rainbow Star, and Zap Cloud.
* Phone steering and menu controls over the local network, alongside keyboard and
  gamepad input. The phone is a controller for the desktop game, not a second racer.

The game models, textures, sound effects, and music are generated in code. The
interface loads fonts from Google Fonts. There is no build step.

## Known limitations

Version 1 is a playable racing baseline with unfinished features. The **Create your
racer** card and **Customize** controls are visible, but the garage and custom racer
are not connected to the game flow yet. Customization is unavailable in v1; choose
one of the twelve preset racers to play. Completing this integration is a development
priority.

Races currently support one human player against CPU opponents. The phone controls
that player's kart on the desktop.

## Requirements

* **Node.js 22.12.0 or newer** and npm
* A desktop browser with WebGL: Chrome, Edge, Firefox or Safari
* Optional: a phone on the **same Wi-Fi network** as the computer

## Run it

```bash
git clone https://github.com/johrmohr/TTTKart.git
cd TTTKart
npm ci
npm start          # = node server.js
```

The server prints something like:

```
  Desktop game   http://localhost:3000
  Phone wheel    https://192.168.1.20:3443/pad?room=XXXX  (scan the QR code in the game)
```

The game opens in your default browser automatically. If it doesn't, open
**http://localhost:3000** yourself. Click or press any key once so the browser allows sound.

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (desktop game) |
| `HTTPS_PORT` | `3443` | HTTPS port (phone controller; motion sensors need HTTPS) |
| `NO_OPEN=1` | off | don't open the browser on start |
| `PAD_HOST` | auto | force the host/IP put in the phone URL + QR code (e.g. when several networks are up) |

Add `?quality=low` to the game URL (`http://localhost:3000/?quality=low`) on slow laptops.

## Connect your phone

1. Start the game. The title screen and the character-select screen show a **QR code**.
2. Scan it with the phone's camera app. It opens `https://<your-computer-ip>:3443/pad?room=ABCD`.
3. **Certificate warning:** the local server uses a self-signed HTTPS certificate
   because phone motion sensors require HTTPS. Confirm the address matches the
   computer running your game before continuing past its warning:
   * **iPhone (Safari):** *Show Details* → *visit this website* → *Visit Website*
   * **Android (Chrome):** *Advanced* → *Proceed to … (unsafe)*
4. Tap **Tap to start**. On iPhone, allow **Motion & Orientation** access when asked.
5. Hold the phone sideways like a steering wheel. The desktop shows "Phone connected".

Press **Center** on the phone any time to re-calibrate "straight ahead". Calibration also
happens automatically at every race start. The phone's ⚙ settings have steering
sensitivity, **auto-gas** and invert steering. Holding the phone upright or tilted back
toward you (low, or in your lap) steers the same; lying flat, tilt it left / right.

If the phone locks, switches apps, takes a call or loses Wi-Fi during a race, the game
pauses by itself within about a second. Resume from the phone or with Esc.

The phone can also drive the menus: START, pick a preset character, difficulty,
RACE!, pause / resume / restart / quit, Race Again / Change Character.

If you can't scan the code, open the URL shown under the QR code, or go to
`https://<computer-ip>:3443/pad` and type the 4-letter room code.

### macOS firewall prompt

The first time you run `node server.js`, macOS may ask *"Do you want the application
"node" to accept incoming network connections?"* Click **Allow**, or the phone can't
reach the computer. If you clicked *Deny* by mistake, go to **System Settings → Network →
Firewall → Options…** and set `node` to *Allow incoming connections*.

## Controls

| Action | Keyboard | Gamepad | Phone |
|---|---|---|---|
| Steer | ← → or A D | left stick / d-pad | turn the phone like a wheel |
| Gas | ↑ or W | A / RT | GAS (right thumb, hold) |
| Brake / reverse | ↓ or S | B / LT | BRAKE (right thumb) |
| Hop & drift (hold) | Space or Shift | RB or X | DRIFT (left thumb, hold) |
| Use item | X, E or Z | LB or Y | ITEM (left thumb, tap) |
| Look back | C | R3 / right stick down | |
| Pause | Esc or P | Start | ⏸ |
| Menus | arrows + Enter, Esc / Backspace = back | d-pad + A | buttons on the phone |
| Mute | M | | |
| Controls help | H (in menus) | | |

**Racing tips**

* **Rocket start:** press gas just before **GO!** (in the last half second or so). If you
  press too early, the engine stalls.
* **Drift mini-turbo:** hold drift while steering into a corner. The sparks turn
  **blue → orange → purple**. Let go for a speed boost; the longer you hold, the bigger it is.
  Steer into the drift for a tighter line and a faster charge, or steer out to widen it.
* Drive through the rainbow **? boxes** for items. Bananas and Stink Bombs drop behind you.
  Bouncers bounce off the walls. Rockets home in on the racer ahead of you. Toots are a
  (loud) boost. The Star makes you invincible. Zap shocks everyone ahead of you.
* Chevron **boost pads** and the **ramp** on the back straight are free speed.

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone page won't load | The phone must be on the **same Wi-Fi** as the computer (no guest network or "client isolation"). Allow `node` in the macOS firewall (see above). Check the IP in the URL matches the computer. With several networks (VPN, Ethernet + Wi-Fi), restart with `PAD_HOST=<right-ip> npm start`. |
| "Your connection is not private" | The local phone server uses a self-signed certificate. Check that the address matches your computer, then follow step 3 above. |
| Steering doesn't react on iPhone | Reload the pad page, tap **Tap to start**, and allow Motion & Orientation. If you tapped *Don't Allow*, iOS remembers it until Safari restarts: close Safari completely (swipe it away in the app switcher), or Settings → Safari → Advanced → Website Data → remove the site, then reload. The pad meanwhile steers with a touch slider and its ⚙ settings explain this (with a *Try tilt again* button). |
| Steering is reversed / too twitchy | Use the phone's ⚙ settings: *Invert steering* and *Sensitivity*. Press **Center** while holding the phone level. |
| No sound | Click the page or press a key once (browsers block audio until you interact). Check the 🔊 button / **M** key. |
| Game is choppy | Close other heavy tabs, make sure hardware acceleration is on, or use `?quality=low`. |
| Phone shows "waiting for game" | The desktop tab was closed or reloaded. Open http://localhost:3000 again in the same browser. If the room has expired, scan the new QR code. |
| Phone shows "Can't reconnect … reload this page" | The server was stopped, or it had to make a new certificate (see below). With the game running, tap **Reload** and accept the certificate warning again. |
| Port already in use | Another copy is running, or another program uses the port (even one that only listens on `localhost`). Stop it, or start with `PORT=3100 HTTPS_PORT=3543 npm start`. |
| Certificate problems after changing networks | The certificate is kept as long as it covers the computer's address in the phone URL (a VPN, VM or hotspot coming and going doesn't matter). On a different network it is replaced, and the phone must reload the pad page and accept the warning once more. To force a new one, delete the `.certs/` folder and restart. |

## Project layout

```
server.js            express + socket.io: HTTP (game) + HTTPS (phone), rooms, QR codes
public/index.html    desktop game page        public/pad.html   phone controller page
public/js/
  main.js            boot, app state machine, race loop, phone sync
  menus.js           title / character select / pause / results / help (DOM)
  customize.js       unfinished customization support; not connected to the game flow
  race.js items.js ai.js          race rules, items, CPU drivers (node-safe)
  kart.js kartview.js characters.js camera.js effects.js   karts, models, chase camera, particles
  track.js track-def.js world.js textures.js               the circuit and its scenery
  hud.js audio.js input.js net.js pad.js                    HUD, synth audio + music, input, phone link
  config.js bus.js utils.js                                 shared tuning, event bus, helpers
tools/               headless tests (see below)
SPEC.md              module contracts
```

## Tests and dev tools

Run the core physics and race-rule checks with `npm test`. For more targeted checks:

```bash
node tools/sim.mjs --all              # headless 8-CPU race simulation matrix
node tools/kart-test.mjs              # kart physics checks
node tools/race-logic-test.mjs        # race + item rules
node tools/test-net.mjs               # server / socket protocol
node tools/pad-test.mjs               # phone controller page (headless Chrome)
node tools/integration-test.mjs       # menus + phone menus against the real server
node tools/integration-race-test.mjs  # full races: keyboard, phone pad, autopilot, leak + perf
node tools/track-check.mjs            # track sanity
```

Run the server and browser test scripts one at a time; some use the same ports.
The browser tests currently need Google Chrome installed at the default macOS
location (they use `puppeteer-core`). In the browser console, `window.__game` has debug helpers such as
`__game.quickRace('blaze')`, `__game.skipIntro()`, `__game.autopilot(true)` and
`__game.setTimeScale(4)`.

## Roadmap

* Add brainrot characters and expand the roster.
* Connect the garage and custom racer to character selection, phone controls, and racing.
* Improve driving feel, CPU racing, and item balance through playtesting.
* Address bugs and polish controls, performance, and the overall race experience.

These are development priorities, not scheduled releases. Suggestions and playtest
feedback are welcome in [GitHub issues](https://github.com/johrmohr/TTTKart/issues).

## Contributing

Bug reports, gameplay feedback, and focused pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and submission guidance.

## License

TTTKart is released under the [ISC license](LICENSE). Dependencies retain their own licenses.

## Acknowledgments

Built with Three.js, Express, Socket.IO, qrcode, and selfsigned. Browser checks use
Puppeteer Core. The interface loads Fredoka, Lilita One, and Nunito from Google
Fonts; those fonts remain under their respective licenses.
