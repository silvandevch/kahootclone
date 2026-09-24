# KahootClone

A lightweight Kahoot-style live quiz game built on Bun. Optimised to run on low-end hardware:

- **Server**: single Bun process, native WebSockets, SQLite for persistence.
- **Frontend**: vanilla TypeScript, system fonts, no framework, no build tooling on the client side. Minified bundles are <25 KB total.
- **Footprint**: zero runtime deps. SQLite via `bun:sqlite`. The client bundles are built at server startup with `Bun.build`.

## Features

- Create, edit, delete quizzes with up to 4 choices per question.
- **Five question types:**
  - **Quiz** — 2-4 multiple choice answers, coloured buttons, single correct answer.
  - **True / False** — binary choice, custom labels allowed.
  - **Type answer** — players type a string; matches any of an accepted-answers list (case-insensitive).
  - **Slider** — players pick a number on a slider; closer to the correct value scores more.
  - **Poll** — no wrong answer; results show as a bar chart.
- Configurable time limit (5-300s) and point value per question.
- Live lobby: players join by PIN + nickname.
- Animated question display on host screen + mobile-optimized answer UI on player devices.
- Score = points scaled by speed (0.5x..1.0x of base) + 25% per-question streak bonus, capped at +125%.
- Per-question live answer-counts, correct-answer reveal, mid-game and final leaderboards.
- Auto-reconnect on transient disconnects.
- Quiz library with play-count tracking and delete-from-library.
- Host can kick players from the lobby.
- **Incremental UI updates** — the host and player UIs only re-render when the phase changes; answer-count and player-list updates patch in place so the timer keeps running and the screen doesn't flash.

## Run

```bash
bun server/index.ts
```

This:
1. Boots the HTTP + WebSocket server on port 3000 (override with `PORT=... HOST=...`).
2. Builds the client bundles into `public/_built/`.
3. Loads the SQLite database at `data/kahoot.db` (created on demand).

Open <http://localhost:3000/> to get started.

## Seed a sample quiz

```bash
bun server/seed.ts
```

## End-to-end multiplayer tests

```bash
bash server/run-e2e.sh        # full 5-type quiz with 3 players
bash server/run-host-test.sh  # host phase transitions (reveal, leaderboard, next)
```

Spawns one host + three players, runs through a full game, validates scoring.

## Project layout

```
server/                 Bun HTTP + WebSocket server (TypeScript)
  index.ts              routing, websocket handlers, game flow
  game.ts               pure functions: room creation, scoring
  db.ts                 SQLite persistence
  types.ts              shared types
  seed.ts               sample quiz
  e2e.ts                multiplayer integration test
public/
  index.html            home
  editor.html/.ts       quiz creator/editor
  library.html/.ts      quiz list
  host.html/.ts         host presentation screen
  join.html/.ts         player join + game view
  style.css             shared styling
  lib/dom.ts            tiny DOM helpers
  _built/               auto-generated minified bundles
data/                   SQLite database file lives here
```

## Wiring

- Host opens a WebSocket at `/ws?role=host&pin=NNNNNN&quizId=...`. The server creates the room and a 6-digit PIN.
- Players open `/ws?role=player&pin=NNNNNN` then send `{type:"player:join", name:"..."}` to register.
- Host events: `host:next-question`, `host:reveal`, `host:show-leaderboard`, `host:show-results`, `host:end-game`, `host:kick`.
- Player events: `player:join`, `player:answer`.

## API

- `GET /api/quizzes` - list quizzes
- `POST /api/quizzes` - create / upsert a quiz
- `GET /api/quizzes/:id` - fetch one quiz
- `DELETE /api/quizzes/:id` - remove a quiz
