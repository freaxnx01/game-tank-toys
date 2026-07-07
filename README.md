# Tank Toys 🪖💥

A two-player **isometric tank battle** with a toy / plastic-miniature look — the
whole battlefield sits in front of you like a **diorama**. Maps are randomly
generated with hills, destructible obstacles, and power-ups. Play **online against
a friend** (serverless peer-to-peer over WebRTC) or **local hot-seat** on one
keyboard. First tank to **5** wins.

**▶️ Play it: https://github.freaxnx01.ch/game-tank-toys/**

## How to Play

Drive your tank, use the hills as cover, and out-shoot your opponent.

| Action | Player | Keys |
| --- | --- | --- |
| Rotate / Drive | either | `A` `D` rotate · `W` `S` forward / reverse |
| Shoot | either | `Space` or `Enter` |

In **local hot-seat** both players share the keyboard; online, each player controls
their own tank. Tanks can climb one height step but not two — the terrain shapes every
duel. Bullets fired from a hilltop arc down into the valleys, and terrain higher than a
bullet blocks it, so **hills are cover**.

**Power-ups** drop onto the field every few seconds (never near a spawn):

| Power-up | Effect |
| --- | --- |
| ⚡ **Speed** | ×1.65 movement for 8 s |
| 🛡️ **Shield** | Absorbs all damage for 6 s |
| ✳️ **Rapid** | Fire cooldown drops from 0.55 s to 0.18 s for 8 s |

Each tank has **5 HP**. On death it explodes into particles, respawns at its own corner
after ~2.4 s, and blinks with brief invulnerability. First to the win score (default **5**) wins.

## Online 2-Player

Head-to-head against a friend with **no backend** — signaling is manual copy-paste,
gameplay runs peer-to-peer over WebRTC:

1. One player clicks **Host** and gets an **invite code**.
2. The other clicks **Join**, pastes the invite, and returns a **reply code**.
3. The host pastes the reply back — and you're connected. The match then runs directly
   between the two browsers over an `RTCDataChannel`.

Connection codes travel however you like (chat, email). Both peers derive the **same map
from a shared seed**, each client is authoritative over its own tank's damage, and state
syncs at 15 Hz with interpolation.

Connectivity uses Google's public **STUN** servers only. Note: STUN-only can fail behind
strict / symmetric NATs (some corporate networks) — a TURN server or a tiny signaling
service would fix that, but it's out of scope for this static deployment.

## Tech

- **Single vanilla web component.** `tank-game.js` defines `<tank-game>` — all game logic,
  Canvas 2D rendering, Web Audio, and WebRTC networking live inside it. `index.html` just
  loads the component. No build step, no server, no bundling.
- **No external asset files.** Every tank, tree, rock, hill, and power-up is drawn at
  runtime on the canvas; every sound is synthesized with the Web Audio API. The only
  network dependency is the *Nunito* web font from Google Fonts (falls back to Trebuchet MS
  offline) and, for online play, Google's public STUN servers.
- **Isometric renderer.** Painter's-algorithm diamonds (`iso(x,y,h) = ((x−y)·32, (x+y)·16 − h·20)`),
  soft elliptical shadows, and radial "plastic" highlights for the toy aesthetic.
- **Deterministic maps.** A seeded `mulberry32` RNG means both peers generate an identical
  battlefield from one shared seed.

## Configuration

`<tank-game>` takes two optional attributes (set in `index.html`):

```html
<tank-game map-size="20" win-score="5"></tank-game>
```

- `map-size` — battlefield is N×N tiles (default `20`, range 12–40).
- `win-score` — points needed to win (default `5`).

## Running Locally

`tank-game.js` is fully self-contained, so serving the folder is enough. Because it loads
as an ES/`defer` script and uses `customElements`, open it over HTTP rather than `file://`:

```sh
# from the repo root
python3 -m http.server 8000
# then visit http://localhost:8000/
```

## License

No license file yet — all rights reserved by default. Ask if you'd like to reuse it.

---

*`source/Tank Battle.dc.html` is the original design-tool export, kept for reference only —
it isn't used by the deployed game.*
