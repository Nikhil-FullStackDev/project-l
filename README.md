# Project L

A web version of the **Project L** puzzle board game. Play online with up to 4 players in a shared room, against bots, or offline with pass-and-play. It's built mobile-first and deploys to [Render](https://render.com) in one click.

## Play

- **Online:** tap *Create online game* to get a 4-letter room code and a share link. Friends join with the code or link, and the host can fill empty seats with bots. If you refresh or your phone drops the connection, you rejoin your seat automatically. If a player stays disconnected for 30 seconds, a bot plays their turns until they come back. Anyone who joins after the game starts watches as a spectator.
- **Offline:** play in your browser against 1–3 bots or with friends on one device. The game is saved locally, so you can resume it later.

### Rules (short)

Each turn you take **3 actions**. You can repeat an action in the same turn, except Master.

| Action | Effect |
| --- | --- |
| Take a puzzle | Take one from the white/black market or the top of a pile. You can hold at most 4. |
| Take a level-1 piece | Take a single square from the supply. |
| Upgrade | Return a piece and take one up to one level higher, or swap for one at the same or a lower level. |
| Place | Put a piece into one of your puzzles. |
| Master (once per turn) | Place one piece into *each* of your puzzles. |

When you complete a puzzle, you score its points, get back all the pieces in it, and take its reward piece. When the black pile runs out, the current round finishes and one more round is played. Then comes a final phase: each piece you place costs −1 point, and every unfinished puzzle subtracts its points. Ties go to the player with more completed puzzles.

The puzzle cards are generated procedurally for each game, from a seed. White puzzles are small with low rewards; black puzzles are large and worth more points.

**Controls:** pick a piece from your tray, then tap your puzzle to preview it and tap again (or press ✓) to place it. On desktop you hover and click. Rotate with ⟳, `R` or right-click; flip with ⇋ or `F`. Placement snaps to the nearest valid position around your tap.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # engine, bot and server/WebSocket tests
```

Requires Node 20 or later.

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, go to **New → Blueprint** and select the repo. `render.yaml` sets up a free Node web service with a `/healthz` health check.
3. Open the service URL and share room links.

Render supports WebSockets out of the box, so no extra setup is needed. Two caveats:

- **Free tier sleep:** the service sleeps when idle, so the first visit can take about 30 seconds to wake it. The client keeps retrying and reconnects on its own.
- **No persistence:** rooms live in memory, so a redeploy or restart ends any games in progress.

## Architecture

```
shared/engine.js   Pure game rules (used by server and browser). Server is authoritative.
shared/bot.js      Greedy bot with an exact-cover solver for puzzle fitting.
server/index.js    HTTP + WebSocket server (ws), heartbeat, rate limiting.
server/rooms.js    Rooms, seats/tokens, reconnection, bot scheduling, spectators.
server/static.js   In-memory static files, precompressed brotli/gzip + ETags.
public/            Vanilla JS client (no build step): app.js (screens/transport), board.js (game UI).
```

### Performance

- **No framework, no build step:** the whole client (HTML, CSS, JS and the game engine) is about 20 KB after Brotli. The bot code (`shared/bot.js`) loads only for offline games.
- **Static files:** everything is preloaded into memory and pre-compressed at startup (Brotli quality 11 and gzip), and ETags make repeat visits cheap 304 responses.
- **WebSocket traffic:** each game update is about 7 KB of JSON, and permessage-deflate shrinks it to about 1 KB. Each broadcast is serialized once and sent to every player. Hidden information (the deck order) never leaves the server.
- **Rendering:** updates are batched with `requestAnimationFrame`, and one delegated listener per area handles input. Placement previews only toggle classes on the cells of one puzzle, so they never trigger a full re-render.
- **Mobile:** the layout is mobile-first, with a thumb-reach dock, 44 px touch targets, safe-area insets, `100dvh`, no double-tap zoom delay, and bottom sheets. The app also reconnects as soon as a backgrounded tab becomes visible again.
- **Server hygiene:** a 25 s heartbeat drops dead mobile sockets, each socket is rate-limited, payloads are capped at 16 KB, and idle rooms are cleaned up. Game logic validates every action on the server.
- **Game length:** a 50-round safety cap means a game can't run forever, even if nobody ever draws a black puzzle.
