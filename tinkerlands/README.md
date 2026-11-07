# Tinkerlands

A multiplayer block-world sandbox that runs in the browser. Players race obstacle
courses, explore, customise an avatar with coins they earn, and build their own
worlds for others to play.

## Quick start

Needs Node.js 24 or newer.

```sh
npm install
npm run build
npm start          # http://127.0.0.1:8080
```

`npm run dev` rebuilds the client and restarts the server when files change.

## Playing

| Input | Action |
| --- | --- |
| WASD or arrows | Move |
| Space | Jump |
| Mouse | Look (click to capture the mouse, Esc for the menu) |
| Wheel | Zoom, or choose a block while building |
| Enter or / | Chat |
| B | Build mode, then hold left-click to break, right-click to place or light TNT |
| E | All blocks, while building |
| 1–9 | Choose a block |
| R | Restart the run |
| G, H, J | Wave, dance, cheer |

Touch screens get a joystick, a jump button and build buttons.

## How it works

```
shared/    Code both sides run: physics, blocks, world format, protocol, templates
server/    HTTP API, WebSocket gateway, game rooms, SQLite storage
client/    Three.js renderer, prediction, HUD, and the hub pages
tests/     Unit and integration tests
e2e/       Plays the game in real headless Chrome
scripts/   Client build, dev server, load test
```

- **The server decides everything.** Clients send only inputs (`stepPlayer` in
  [shared/physics.ts](shared/physics.ts) runs on the server at 30 Hz), so speed
  hacks and teleporting have nothing to work with. Run times, coins and block
  edits are all decided on the server.
- **Movement still feels instant.** The client runs the same physics straight
  away, then replays unacknowledged inputs on top of each server snapshot. Other
  players are drawn slightly in the past and interpolated.
- **Each world is one room in one process.** Rooms load on first join, autosave,
  and unload once empty.
- **Worlds are stored** run-length encoded and deflated in SQLite, with a PNG
  thumbnail drawn from the real blocks.

## Testing

```sh
npm run typecheck
npm test            # Unit and integration, against a real server and sockets
npm run test:e2e    # Real Chrome. Set CHROME_PATH if it isn't auto-detected.
npm run check       # All of the above
```

Screenshots from the browser test land in `e2e/screenshots/`. Every generated
course seed in the tests is played start to finish by an autopilot under the real
physics, and every island coin is checked for reachability on foot.

## Deploying

The included setup runs the game behind Caddy, which handles HTTPS:

```sh
cp .env.example .env    # Set DOMAIN, ADMIN_TOKEN and METRICS_TOKEN
docker compose up -d --build
```

Back up the `game-data` volume. To take a consistent copy while running:
`sqlite3 /data/tinkerlands.db ".backup /backup/tinkerlands.db"`.

### Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `127.0.0.1` (`0.0.0.0` in production) | Listen address |
| `DB_PATH` | `data/tinkerlands.db` | SQLite file |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*`. Enable **only** behind a proxy |
| `ALLOWED_ORIGINS` | same host only | Extra allowed WebSocket origins, comma separated |
| `ADMIN_TOKEN` | off | Enables the moderation API (24+ characters) |
| `METRICS_TOKEN` | off | Enables `/metrics` |
| `BLOCKED_WORDS` | none | Extra words for the text filter, comma separated |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `SAVE_INTERVAL_MS` | `30000` | Autosave interval |
| `MAX_CONNECTIONS` | `2000` | Sockets, in total |
| `MAX_CONNECTIONS_PER_IP` | `16` | Sockets per address |
| `RATE_API_PER_MINUTE` | `600` | API calls per address |
| `RATE_AUTH_PER_MINUTE` | `20` | Sign-in attempts per address |
| `RATE_GUESTS_PER_HOUR` | `30` | New guest accounts per address |

### Operations

- `GET /healthz` is liveness and `GET /readyz` is readiness.
- `GET /metrics` is Prometheus format, with `Authorization: Bearer $METRICS_TOKEN`.
  Watch `tinkerlands_tick_duration_ms` (the budget is 33 ms) and
  `tinkerlands_ticks_skipped_total`.
- Logs are JSON lines on stdout.
- `SIGTERM` saves every world, tells clients to reconnect, and exits.

### Moderation API

All with `Authorization: Bearer $ADMIN_TOKEN`:

```
GET  /api/admin/reports                 Open reports
POST /api/admin/reports/:id/resolve     Close a report
POST /api/admin/users/:id/ban           {"reason": "...", "days": 7}
POST /api/admin/users/:id/unban
POST /api/admin/worlds/:id/unpublish    Takes a world down and removes its players
```

## Before opening to the public

These are not built, and depend on decisions only the operator can make:

- **Children's safety and legal.** Games like this attract under-13s, which brings
  duties under laws such as COPPA and the UK Age Appropriate Design Code. There is
  no age gate, parental consent, privacy policy or terms of service yet. Get legal
  advice first.
- **Moderation.** The chat filter is a word list, which determined users will get
  around. There's no image or build scanning and reports are API-only, with no
  dashboard. A public launch needs a moderation service and people to review reports.
- **Account recovery and deletion.** Accounts have no email, so a forgotten
  password can't be reset, and there's no self-service account deletion yet.
- **Scale.** One process and one SQLite file, so one machine. That's a limit on
  growth and also a single point of failure.
- **Payments.** Coins are earned only. Nothing is for sale.
- **Editing and leaderboards.** Editing a course doesn't reset its leaderboard.
