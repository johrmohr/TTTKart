# Handling and multiplayer design notes

## Research → choices

- Nintendo's [official controls guide](https://support-jp.nintendo.com/app/answers/detail/a_id/34439) describes steering while holding drift, then releasing once sparks appear for a mini-turbo. The [official Mini-Turbo tutorial](https://www.youtube.com/watch?v=yeju5WcQr8A) demonstrates that loop. This game keeps its existing hop, blue/orange/purple tiers and release boosts; its tuning is an arcade interpretation, not a claim to reproduce Nintendo's proprietary physics.
- Nintendo offers [optional tilt controls](https://en-americas-support.nintendo.com/app/answers/detail/a_id/22763/p/897/c/898). Tilt remains the default here, with touch fallback and manual calibration. Auto-gas remains optional so it does not silently change existing players' throttle control.
- W3C's [enhanced target-size guidance](https://www.w3.org/WAI/WCAG21/Understanding/target-size) recommends 44×44 CSS-pixel targets. Primary driving controls have a 56px minimum; other phone actions have a 44px minimum. The existing landscape thumb zones work well: gas/brake left, drift/item right, steering between them. Drift receives 66% of its column. Small-screen and rotated layouts are exercised by the phone test suite.
- Visual references: [Tung Tung Tung Sahur](https://knowyourmeme.com/memes/tung-tung-tung-sahur), [Ballerina Cappuccina](https://knowyourmeme.com/memes/ballerina-cappuccina-italian-brainrot), [Brr Brr Patapim](https://knowyourmeme.com/memes/brr-brr-patapim), and the [brainrot character overview](https://characters.biz/italian-brainrot). These informed silhouettes and props. Models are built locally from geometry; no meme audio or downloaded models are bundled.

## Tuning

| Parameter | Previous | New |
|---|---:|---:|
| Tilt neutral dead zone | 2° | 3.5° |
| Default full lock | 32° | 45° |
| Cubic contribution | 35% | 52% |
| Sensor filter rate | 22/s | 14/s |
| Yaw response | 13/s | 9/s |
| High-speed turn reduction | 20% | 30% |
| Drift countersteer / full-steer multipliers | 0.30 / 1.28 | 0.12 / 0.92 |
| Drift lateral grip | 3.5/s | 4.4/s |
| Extra visual drift yaw | 0.30rad | 0.19rad |

The dead zone removes hand tremor; the response curve reduces small corrections without removing full lock. The modest filter smooths sensor noise while keeping response quick. Existing saved sensitivity settings are honored. Full steering remains adjustable from 18° to 65°.

Drift direction locks at entry, with continuous adjustment between a wide arc and a tighter line. Gentler physical yaw and reduced decorative yaw avoid the impression of snapping sideways. Grounded drifts still charge the existing mini-turbo tiers; countersteering does not cancel the drift. Measured full-lock drift radii are around 14–19m across the new roster. Physics tests require drifting laps to be faster than non-drifting laps, retaining a meaningful reward.

## Multiplayer architecture

A single desktop simulation owns all eight karts. Up to four humans replace CPU drivers. Four independently persisted PhoneLink rooms reuse the existing validated, rate-limited socket protocol. Each player gets a separate input stream, item/pause sequence counters, phone mirror and chase camera. Extra cameras are disposed between races. Disconnected/stale controllers release their inputs; active-player disconnects pause the shared race. Join mid-race waits for the next lobby.

The renderer uses scissored viewports: one full frame, two horizontal halves, or four quadrants. The unused fourth quadrant in three-player mode is a static panel. Split-screen limits pixel ratio to reduce fill cost. The original full single-player HUD is retained; split views use smaller independent readouts. Everyone must finish before the results grace timer begins.

## Test boundaries

Automated tests cover geometry/model rendering, real socket routing, setup/ready stages, independent steering, per-player item state, 2/3/4 layouts, return home, Quick Play defaults, Beer Blitz expiry/immunity, loadout stat changes and multiplayer finish gating. Phone tests synthesize motion and touch events in Chrome, including orientation changes and denied motion access. They do not substitute for an actual iPhone/Android hand-feel test. Four-view rendering performance depends on the display computer. The new oval also passes a headless all-eight-racers finish simulation.
