# Chess

A small chess application with two compatible game modes:

- **Local game** — pass-and-play on one board.
- **Online chess** — private two-player rooms with server-authoritative rules, realtime WebSocket updates, synchronized clocks, reconnects, draw offers, resignation, rematches, and saved game history.

## Run it

```bash
npm install
npm start
```

Open <http://localhost:3000> in two separate browser profiles or windows. Choose **Play online**, create a room in one window, and join the six-digit code in the other.

The server binds to `0.0.0.0` by default so it also works in a hosted preview. Set `PORT` or `HOST` when needed:

```bash
PORT=8080 npm start
```

## Architecture

The original app was a static DOM/jQuery board with game rules embedded in click handlers. The board surface and visual language are retained, but the rules are now an explicit shared `ChessEngine` abstraction in `shared/chess-engine.js`. It is loaded by the browser for local play and required by the server for authoritative online validation.

```text
index.js                  shared board controller
shared/chess-engine.js    legal chess rules, FEN, SAN, clocks-independent state
server.js                 HTTP/static server and WebSocket upgrade endpoint
server/game-service.js    rooms, sessions, permissions, state transitions, presence
server/persistence.js     narrow JSON history adapter (replaceable by a database)
```

Online clients only submit `{ from, to, promotion, moveId, clientRevision }`. The server derives the session user, color, turn, legal position, result, and clock. Accepted state is broadcast with a monotonically increasing `revision`; clients can request a complete `game:sync` snapshot after reconnects or missed events.

For this repository, there is no existing identity provider, so `/api/session` issues a server-generated anonymous session token. The token is held in `sessionStorage` and authenticated again during the WebSocket handshake. The adapter is intentionally small so an existing login/session provider can replace it without changing game actions.

Active rooms and games live in memory for low-latency transitions. Completed and in-progress game records are atomically written to `data/games.json` (ignored by Git) through the persistence adapter. A Redis/database adapter can be introduced behind the same service boundary for multi-instance deployment.

## Realtime events

The WebSocket endpoint is `/ws`. The MVP uses:

- `auth`
- `room:create`, `room:join`, `room:cancel`, `room:sync`
- `game:state`, `game:sync`, `game:move`, `game:move:accepted`
- `game:resign`
- `game:draw:offer`, `game:draw:respond`
- `game:rematch`
- `player:connected`, `player:disconnected`, `player:reconnected`

Errors are structured packets with codes such as `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `ROOM_FULL`, `NOT_YOUR_TURN`, `INVALID_MOVE`, `STATE_OUT_OF_SYNC`, `UNAUTHORIZED`, and `RATE_LIMITED`.

## Tests

```bash
npm test
npm run lint
```

The test suite covers the shared rules engine and service-level room/game flows, including legal moves, castling, en passant, promotion, checkmate, stale revisions, duplicate moves, authorization, reconnect state restoration, room expiry, draw response, resignation, persistence, and color-swapping rematches.
