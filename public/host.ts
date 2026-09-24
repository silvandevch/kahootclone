import { el, on, gameSound } from "./lib/dom";

const GLYPHS = ["\u25B2", "\u25C6", "\u25CF", "\u25A0"];
const COLORS = ["red", "blue", "green", "yellow"];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const root = el("div", { className: "app" });
document.body.appendChild(el("div", { className: "topbar" }, [
  el("a", { className: "brand", href: "/", text: "KahootClone" }),
  el("div", { className: "row" }, [
    el("a", { href: "/", text: "Start" }),
    el("a", { href: "/library.html", text: "Meine Quizze" }),
    el("a", { href: "/editor.html", text: "Neu erstellen" }),
    el("a", { href: "/join.html", text: "Beitreten" }),
    el("div", { className: "small muted", text: "Host-Ansicht" }),
  ]),
]));
document.body.appendChild(root);
const sound = gameSound("host");

type Quiz = {
  id?: string;
  title: string;
  description?: string;
  coverColor?: string;
  questions: Array<any>;
};

type RoomData = {
  pin: string;
  phase: "lobby" | "question" | "buzzed" | "reveal" | "leaderboard" | "finished";
  quiz: Quiz;
  currentQuestionIndex: number;
  questionStartedAt: number;
  buzzedPlayerId: string | null;
  reactionGoAt?: number;
  players: Array<{ id: string; name: string; score: number; connected: boolean; locked?: boolean; correct?: boolean; lastAnswer?: { questionIndex: number; answer: any; timeMs: number; delta?: number; correct?: boolean } | null }>;
  leaderboard: Array<{ rank: number; id: string; name: string; score: number }>;
};

const params = new URLSearchParams(location.search);
const quizId = params.get("quiz");
let pin = params.get("pin") ?? makePin();
let ws: WebSocket | null = null;
let room: RoomData | null = null;
let phase: RoomData["phase"] | null = null;
let renderSeq = 0;
let answeredCount = 0;
let answeredTotal = 0;
let sessionToken: string | null = null;
let connected = false;
let terminal = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let renderedQuestionIndex: number | null = null;

const statusEl = el("div", { className: "small muted", role: "status", text: "" });
document.querySelector(".topbar .row")?.appendChild(statusEl);
let connectTimeout: ReturnType<typeof setTimeout> | null = null;
let connectionStarted = false;

function setConnStatus(text: string) {
  statusEl.textContent = text;
  statusEl.style.display = text ? "" : "none";
}

function sessionKey() {
  return `kc:session:host:${pin}`;
}

function makePin() {
  let p = "";
  for (let i = 0; i < 6; i++) p += Math.floor(Math.random() * 10);
  return p;
}

function patchCommands() {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = !connected || terminal || (button.dataset.startBtn === "1" && !room?.players.length);
  });
}

function send(data: any) {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || !connected || terminal) return false;
  try {
    socket.send(JSON.stringify(data));
    return true;
  } catch {
    disconnect(socket);
    return false;
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
  if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
}

function ping(socket: WebSocket) {
  if (ws !== socket || terminal || socket.readyState !== WebSocket.OPEN || pongTimeout) return;
  pongTimeout = setTimeout(() => disconnect(socket), 10000);
  try { socket.send(JSON.stringify({ type: "ping" })); } catch { disconnect(socket); }
}

function disconnect(socket: WebSocket) {
  if (ws !== socket) return;
  ws = null;
  connected = false;
  sound.stop();
  stopHeartbeat();
  try { socket.close(); } catch {}
  patchCommands();
  if (terminal) return;
  if (room?.phase === "finished") {
    setConnStatus("Spiel beendet — getrennt");
    return;
  }
  setConnStatus("Verbindung getrennt — verbinde neu...");
  scheduleReconnect();
}

function stopConnection(text: string) {
  terminal = true;
  connected = false;
  sound.stop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHeartbeat();
  const socket = ws;
  ws = null;
  try { socket?.close(); } catch {}
  sessionToken = null;
  try { sessionStorage.removeItem(sessionKey()); } catch {}
  setConnStatus(text);
  patchCommands();
}

function scheduleReconnect() {
  if (terminal || room?.phase === "finished" || reconnectTimer) return;
  const delay = Math.floor(reconnectDelay * (0.5 + Math.random() * 0.5));
  reconnectDelay = Math.min(15000, reconnectDelay * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (terminal || room?.phase === "finished" || ws) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectionStarted = true;
  if (!sessionToken) {
    try { sessionToken = sessionStorage.getItem(sessionKey()); } catch {}
  }
  history.replaceState({}, "", `?${new URLSearchParams({ pin, ...(quizId ? { quiz: quizId } : {}) })}`);
  const qs = new URLSearchParams({ role: "host", pin });
  if (quizId) qs.set("quizId", quizId);
  if (sessionToken) qs.set("sessionToken", sessionToken);
  setConnStatus("Verbinde...");
  connected = false;
  patchCommands();
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${qs}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  connectTimeout = setTimeout(() => disconnect(socket), 15000);
  socket.onopen = () => {
    if (ws !== socket || terminal) return;
    heartbeatTimer = setInterval(() => ping(socket), 20000);
  };
  socket.onmessage = (e) => {
    if (ws !== socket || terminal) return;
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg && typeof msg === "object") handle(msg);
  };
  socket.onclose = () => disconnect(socket);
  socket.onerror = () => disconnect(socket);
}

function resumeConnection() {
  if (!connectionStarted || terminal || room?.phase === "finished") return;
  if (ws?.readyState === WebSocket.OPEN) ping(ws);
  else if (!ws) connect();
}

window.addEventListener("online", resumeConnection);
window.addEventListener("pageshow", (event) => {
  if (event.persisted && ws) disconnect(ws);
  resumeConnection();
});

function handle(msg: any) {
  if (msg.type === "pong") {
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    return;
  }
  if (msg.type === "session") {
    if (typeof msg.sessionToken !== "string" || !msg.sessionToken) return;
    sessionToken = msg.sessionToken;
    try { sessionStorage.setItem(sessionKey(), msg.sessionToken); } catch {}
    return;
  }
  if (msg.type === "host:snapshot" || msg.type === "host:redirect") {
    const oldKey = sessionKey();
    if (msg.room?.pin) pin = msg.room.pin;
    else if (msg.pin) pin = msg.pin;
    if (oldKey !== sessionKey() && sessionToken) {
      try {
        sessionStorage.setItem(sessionKey(), sessionToken);
        sessionStorage.removeItem(oldKey);
      } catch {}
    }
    history.replaceState({}, "", `?${new URLSearchParams({ pin, ...(quizId ? { quiz: quizId } : {}) })}`);
    if (!msg.room) return;
    const restoring = !connected;
    const changed = room?.phase !== msg.room.phase || room?.currentQuestionIndex !== msg.room.currentQuestionIndex;
    room = msg.room;
    if (changed) {
      sound.stop();
      if (!restoring) {
        const cue = room!.phase === "question" ? "question" : room!.phase === "reveal" || room!.phase === "leaderboard" ? "reveal" : room!.phase === "buzzed" ? "buzz" : room!.phase === "finished" ? "podium" : null;
        if (cue) sound.play(cue, `${pin}:${room!.currentQuestionIndex}:${room!.phase}`);
      }
    }
    if ((changed || restoring) && room!.phase === "question") {
      const question = room!.quiz.questions[room!.currentQuestionIndex];
      if (question && question.type !== "memory" && question.type !== "reaction" && !question.audioUrl && !question.videoUrl) sound.countdown(room!.questionStartedAt + question.timeLimit * 1000);
    }
    connected = true;
    reconnectDelay = 1000;
    if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
    setConnStatus("");
    syncAnsweredFromSnapshot();
    renderIfNeeded(restoring);
    patchCommands();
    return;
  }
  if (msg.type === "error") {
    if (msg.terminal === true) stopConnection(msg.message || "Sitzung beendet");
    else setConnStatus(msg.message || "Fehler");
    return;
  }
  if (msg.type === "game:ended" || msg.type === "kicked" || msg.type === "player:kicked") {
    stopConnection(msg.message || "Sitzung beendet");
    return;
  }
  if (msg.type === "game:finished") {
    sound.stop();
    sound.play("podium", `${pin}:finished`);
    if (room) {
      room.phase = "finished";
      if (msg.leaderboard) room.leaderboard = msg.leaderboard;
      renderIfNeeded(true);
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConnStatus("Spiel beendet");
    patchCommands();
    return;
  }
  if (msg.type === "lobby:update") {
    if (room) {
      const players = msg.players;
      for (const np of players) {
        const ex = room.players.find((p) => p.id === np.id);
        if (ex) ex.name = np.name;
        else room.players.push({ id: np.id, name: np.name, score: 0, connected: true });
      }
      room.players = room.players.filter((p) => players.some((np: any) => np.id === p.id));
      patchLobby();
    }
    return;
  }
  if (msg.type === "answers:update") {
    answeredCount = msg.answered ?? 0;
    answeredTotal = msg.total ?? 0;
    patchAnswerCount(answeredCount, answeredTotal);
    return;
  }
  if (msg.type === "buzzed") {
    flashBuzz(msg.playerName);
    return;
  }
}

function syncAnsweredFromSnapshot() {
  if (!room) return;
  const n = room.players.filter((p: any) => p.lastAnswer && p.lastAnswer.questionIndex === room!.currentQuestionIndex).length;
  answeredCount = n;
  answeredTotal = room.players.length;
}

function flashBuzz(name: string) {
  const banner = el("div", { className: "buzz-banner" }, [
    el("span", { className: "buzz-glyph", text: "\u26a1" }),
    el("span", { text: `${name} hat zuerst gebuzzert!` }),
  ]);
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add("show"), 10);
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 300);
  }, 2400);
}

function renderIfNeeded(force = false) {
  if (!room) return;
  const index = room.currentQuestionIndex;
  if (force || room.phase !== phase || index !== renderedQuestionIndex) {
    phase = room.phase;
    renderedQuestionIndex = index;
    render();
  } else {
    patchLobby();
    patchAnswerCount(answeredCount, answeredTotal);
  }
}

function patchLobby() {
  if (!room) return;
  if (phase === "lobby") {
    const count = root.querySelector("[data-player-count]");
    if (count) count.textContent = `${room.players.filter((p) => p.connected).length} Spieler`;
    const grid = root.querySelector("[data-player-grid]");
    // Nicht neu rendern, während der Host gerade einen Namen editiert.
    if (grid && !grid.querySelector("input")) renderPlayerGrid(grid, room.players);
    const startBtn = root.querySelector("[data-start-btn]") as HTMLButtonElement | null;
    if (startBtn) {
      startBtn.disabled = !connected || terminal || room.players.length === 0;
      startBtn.textContent = `Spiel starten (${room.players.length} Spieler)`;
    }
  }
}

function patchAnswerCount(answered: number, total: number) {
  if (phase !== "question" && phase !== "buzzed") return;
  answeredCount = answered;
  answeredTotal = total;
  const el = root.querySelector("[data-answered]");
  if (el) el.textContent = `${answered} / ${total} haben geantwortet`;
}

function renderPlayerGrid(container: Element, players: RoomData["players"]) {
  container.innerHTML = "";
  players.forEach((p) => {
    const tile = el("div", { className: "player-tile" });
    const nameEl = el("span", { text: (p.locked ? "🔒 " : "") + p.name, title: p.locked ? "Name vom Host festgelegt" : p.name });
    tile.appendChild(nameEl);
    // Umbenennen (sperrt den Namen gleichzeitig für den Spieler)
    const renameBtn = el("button", { className: "ghost small", text: "✎", title: "Namen festlegen + sperren" }) as HTMLButtonElement;
    on(renameBtn, "click", () => {
      tile.innerHTML = "";
      const input = el("input", { value: p.name, maxlength: "18", style: "max-width:110px" }) as HTMLInputElement;
      const save = el("button", { className: "small", text: "OK" }) as HTMLButtonElement;
      const doSave = () => {
        const next = input.value.trim().slice(0, 18);
        if (next) send({ type: "host:rename", pin, playerId: p.id, name: next });
        else renderPlayerGrid(container, players);
      };
      on(save, "click", doSave);
      on(input, "keydown", (e: KeyboardEvent) => { if (e.key === "Enter") doSave(); if (e.key === "Escape") renderPlayerGrid(container, players); });
      tile.append(input, save);
      input.focus();
      input.select();
    });
    // Rauswerfen
    const kickBtn = el("button", { className: "ghost small", text: "✕", title: "Spieler entfernen" }) as HTMLButtonElement;
    on(kickBtn, "click", () => {
      if (confirm(`${p.name} wirklich entfernen?`)) send({ type: "host:kick", pin, playerId: p.id });
    });
    tile.append(renameBtn, kickBtn);
    container.appendChild(tile);
  });
  if (players.length === 0) container.appendChild(el("p", { className: "muted", text: "Warte auf Spieler..." }));
}

function render() {
  if (!room) return;
  const r = room;
  const seq = ++renderSeq;
  root.innerHTML = "";

  const heading = el("div", { className: "row" }, [
    el("h1", { className: "title", text: r.quiz.title }),
    el("div", { className: "spacer" }),
    el("span", { className: "muted small", text: `${r.players.filter((p) => p.connected).length} Spieler` }),
  ]);
  root.appendChild(heading);

  switch (r.phase) {
    case "lobby": renderLobby(r); break;
    case "question":
    case "buzzed": renderQuestion(r, seq); break;
    case "reveal": renderReveal(r); break;
    case "leaderboard": renderLeaderboard(r); break;
    case "finished": renderFinal(r); break;
  }
}

function renderLobby(r: RoomData) {
  const card = el("div", { className: "card col center" });
  card.append(el("div", { className: "muted small", text: "Spiel-PIN" }));
  const pinEl = el("div", { className: "pin", text: r.pin });
  card.append(pinEl);
  card.append(el("div", { className: "muted small", text: "Spieler beitreten unter " + location.host }));
  const start = el("button", { text: `Start game (${r.players.length} players)`, disabled: r.players.length === 0 } as any) as HTMLButtonElement;
  start.dataset.startBtn = "1";
  on(start, "click", () => {
    send({ type: "host:next-question", pin: r.pin });
  });
  card.append(start);
  root.appendChild(card);

  const grid = el("div", { className: "player-grid" });
  grid.dataset.playerGrid = "1";
  renderPlayerGrid(grid, r.players);
  const playersCard = el("div", { className: "card" }, [
    el("h3", { text: "Spieler in der Lobby" }),
    grid,
  ]);
  root.appendChild(playersCard);
}

function renderQuestion(r: RoomData, seq: number) {
  const q = r.quiz.questions[r.currentQuestionIndex];
  root.append(el("div", { className: "question-text big", text: q.text || `(${q.type})` }));

  const meta = el("div", { className: "q-top" }, [
    el("span", { className: "badge", text: `Frage ${r.currentQuestionIndex + 1} / ${r.quiz.questions.length}` }),
    el("span", { className: "badge accent", text: `${answeredCount} / ${answeredTotal} geantwortet` }),
  ]);
  meta.lastElementChild!.setAttribute("data-answered", "1");
  root.append(meta);

  renderHostQuestionBody(q, r.reactionGoAt ?? 0);

  const bar = el("div", { className: "timer-bar" });
  const fill = el("div", { className: "timer-fill" });
  bar.append(fill);
  root.append(bar);

  const revealBtn = el("button", { text: q.type === "reaction" && r.phase === "buzzed" ? "Auflösen" : "Antwort aufdecken", style: "margin-top:1rem" });
  on(revealBtn, "click", () => send({ type: "host:reveal", pin: r.pin }));
  root.append(revealBtn);

  if (q.type === "reaction" && r.phase === "buzzed") {
    const player = r.players.find((p) => p.id === r.buzzedPlayerId);
    root.append(el("div", { className: "card center", style: "margin-top:1rem; border-color: var(--yellow)" }, [
      el("h2", { text: "\u26a1" }),
      el("p", { text: `${player?.name ?? "?"} hat zuerst gebuzzert` }),
    ]));
  }

  const start = r.questionStartedAt;
  const total = q.timeLimit * 1000;
  const interval = setInterval(() => {
    if (seq !== renderSeq) { clearInterval(interval); return; }
    const elapsed = Date.now() - start;
    const left = Math.max(0, total - elapsed);
    fill.style.width = `${(left / total) * 100}%`;
    if (left <= 0) {
      clearInterval(interval);
      fill.style.background = "var(--bad)";
    }
  }, 100);
}

function renderHostQuestionBody(q: any, reactionGoAt = 0) {
  const container = el("div", { className: "host-qbody" });

  switch (q.type) {
    case "quiz":
    case "true_false":
    case "dropdown":
    case "audio_clip":
    case "video_clip": {
      const stage = el("div", { className: "stage" });
      (q.choices ?? []).slice(0, 4).forEach((c: string, i: number) => {
        stage.append(el("div", { className: `choice ${COLORS[i % 4]}`, text: c || "(empty)", style: c ? "" : "opacity:0.4" }, [
          el("span", { className: "glyph", text: GLYPHS[i % 4] }),
        ]));
      });
      container.append(stage);
      break;
    }
    case "multi_select":
    case "choose_two": {
      const stage = el("div", { className: "stage" });
      (q.choices ?? []).slice(0, 6).forEach((c: string, i: number) => {
        stage.append(el("div", { className: `choice ${COLORS[i % 4]}`, text: c || "(empty)" }, [
          el("span", { className: "glyph", text: GLYPHS[i % 4] }),
        ]));
      });
      container.append(stage);
      container.append(el("p", { className: "muted center small", text: "Richtige Antworten werden nach dem Aufdecken gezeigt" }));
      break;
    }
    case "type_answer":
    case "fill_blank":
      container.append(el("div", { className: "card center", text: "Spieler tippen ihre Antwort" }));
      container.append(el("p", { className: "muted center small", text: "Lösung wird nach dem Aufdecken gezeigt" }));
      break;
    case "slider":
    case "estimate": {
      const min = q.sliderMin ?? 0;
      const max = q.sliderMax ?? 100;
      const stage = el("div", { className: "slider-stage" });
      const track = el("div", { className: "slider-track" });
      track.append(el("div", { className: "slider-fill" }));
      stage.append(track);
      stage.append(el("div", { className: "slider-labels" }, [
        el("span", { text: String(min) }),
        el("span", { text: q.estimateUnit ? `? ${q.estimateUnit}` : "? (wird aufgedeckt)" }),
        el("span", { text: String(max) }),
      ]));
      container.append(stage);
      break;
    }
    case "order":
    case "sequence":
    case "fastest_finger": {
      const list = el("div", { className: "list-display" });
      (q.items ?? []).forEach((it: string) => {
        list.append(el("div", { className: "list-row" }, [
          el("span", { className: "list-pos muted", text: "?" }),
          el("span", { text: it || "(leer)" }),
        ]));
      });
      container.append(list);
      container.append(el("p", { className: "muted center small", text: "Richtige Reihenfolge wird nach dem Aufdecken gezeigt" }));
      break;
    }
    case "puzzle_drop": {
      const slotsRow = el("div", { className: "puzzle-slots" });
      (q.puzzleSlots ?? []).forEach((s: string, i: number) => {
        slotsRow.append(el("div", { className: "puzzle-slot", text: s }));
      });
      container.append(slotsRow);
      const piecesRow = el("div", { className: "puzzle-pieces" });
      (q.items ?? []).forEach((it: string, i: number) => {
        piecesRow.append(el("div", { className: "puzzle-piece", text: it }));
      });
      container.append(piecesRow);
      break;
    }
    case "match_pairs": {
      // Neutral view: lefts and rights as separate shuffled pools — NO mapping shown.
      const lefts = (q.pairs ?? []).map((p: any) => p.left || "?");
      const rights = shuffle((q.pairs ?? []).map((p: any) => p.right || "?"));
      const grid = el("div", { className: "match-grid" });
      const colL = el("div", { className: "col" });
      const colR = el("div", { className: "col" });
      lefts.forEach((l: string) => colL.append(el("div", { className: "match-left", text: l })));
      rights.forEach((r: string) => colR.append(el("div", { className: "match-right", text: r })));
      grid.append(colL, colR);
      container.append(grid);
      container.append(el("p", { className: "muted center small", text: "Zuordnung wird nach dem Aufdecken gezeigt" }));
      break;
    }
    case "classify": {
      // Neutral view: categories empty, items in a pool — NO solution shown.
      const grid = el("div", { className: "classify-grid" });
      (q.categories ?? []).forEach((cat: string) => {
        const bin = el("div", { className: "classify-bin" });
        bin.append(el("div", { className: "classify-label", text: cat }));
        bin.append(el("div", { className: "muted small", text: "(verdeckt)" }));
        grid.append(bin);
      });
      container.append(grid);
      const pool = el("div", { className: "classify-items" });
      (q.items ?? []).forEach((it: string) => {
        pool.append(el("div", { className: "classify-item", text: it }));
      });
      container.append(pool);
      break;
    }
    case "poll": {
      const stage = el("div", { className: "stage" });
      (q.choices ?? []).slice(0, 4).forEach((c: string, i: number) => {
        stage.append(el("div", { className: `choice ${COLORS[i % 4]}`, text: c || "(empty)" }, [
          el("span", { className: "glyph", text: GLYPHS[i % 4] }),
        ]));
      });
      container.append(stage);
      container.append(el("p", { className: "muted center small", text: "Spieler stimmen ab — keine falsche Antwort" }));
      break;
    }
    case "brainstorm":
      container.append(el("div", { className: "card center", text: "Spieler geben so viele Wörter wie möglich ein" }));
      break;
    case "word_cloud":
      container.append(el("div", { className: "card center", text: "Spieler tippen kurze Antworten" }));
      break;
    case "open_ended":
      container.append(el("div", { className: "card center", text: "Spieler schreiben eine längere Antwort" }));
      break;
    case "reaction": {
      const box = el("div", { className: "card center big-buzz" });
      const title = el("h2", { className: "buzz-text", text: "WARTEN..." });
      const sub = el("p", { className: "muted small", text: "Das blaue Quadrat erscheint gleich — wer zuerst tippt, gewinnt" });
      const square = el("div", { text: "■", style: "font-size:6rem; color:var(--blue); display:none" });
      box.append(title, sub, square);
      container.append(box);
      const ms = Math.max(0, reactionGoAt - Date.now());
      setTimeout(() => {
        title.textContent = "JETZT TIPPEN!";
        sub.textContent = "Blaues Quadrat ist da!";
        square.style.display = "";
      }, ms);
      break;
    }
    case "color_match": {
      const grid = el("div", { className: "color-grid" });
      (q.colors ?? []).forEach((c: any) => {
        const opt = el("div", { className: "color-option" });
        opt.append(el("div", { className: "color-swatch", style: `background:${c.hex}` }));
        opt.append(el("span", { text: c.name }));
        grid.append(opt);
      });
      container.append(grid);
      container.append(el("p", { className: "muted center small", text: "Zielfarbe erscheint auf den Geräten — Lösung wird aufgedeckt" }));
      break;
    }
    case "image_hotspot": {
      const img = el("div", { className: "host-image", style: q.imageUrl ? `background:url(${q.imageUrl}) center/cover` : "background:#222" });
      container.append(img);
      container.append(el("p", { className: "muted center small", text: "Spieler klicken auf das Bild" }));
      break;
    }
    case "memory":
      container.append(el("div", { className: "card center", text: `Spieler wiederholen eine Sequenz von ${q.memoryLength} Taps` }));
      break;
  }

  if (q.imageUrl && q.type !== "image_hotspot" && q.type !== "color_match") {
    container.append(el("img", { src: q.imageUrl, className: "host-image", style: "max-height:200px" }));
  }
  if (q.audioUrl) container.append(el("audio", { src: q.audioUrl, controls: "true" }));
  if (q.videoUrl) container.append(el("video", { src: q.videoUrl, controls: "true", style: "max-width:100%; max-height:240px" }));

  root.append(container);
}

function formatPlayerAnswer(q: any, ans: any): string {
  if (!ans) return "— keine Antwort —";
  switch (ans.kind) {
    case "choice":
      if (q.type === "slider" || q.type === "estimate") return String(ans.choice);
      return (q.choices ?? [])[ans.choice] ?? `Option ${ans.choice + 1}`;
    case "multi":
      return (ans.choices ?? []).map((i: number) => (q.choices ?? [])[i] ?? `#${i + 1}`).join(", ") || "—";
    case "text":
      return `"${ans.text}"`;
    case "words":
      return (ans.words ?? []).join(", ") || "—";
    case "order":
      return (ans.order ?? []).map((itemIdx: number, pos: number) => `${pos + 1}. ${(q.items ?? [])[itemIdx] ?? "?"}`).join(" → ") || "—";
    case "puzzle":
      return (ans.slots ?? []).map((itemIdx: number) => (q.items ?? [])[itemIdx] ?? "?").join("") || "—";
    case "match":
      return Object.entries(ans.pairs ?? {}).map(([l, r]) => `${l}↔${r}`).join(", ") || "—";
    case "classify":
      return Object.entries(ans.bins ?? {}).map(([it, c]) => `${it}→${c}`).join(", ") || "—";
    case "hotspot":
      return `(${Math.round(ans.x * 100)}%, ${Math.round(ans.y * 100)}%)`;
    case "color": {
      const named = (q.colors ?? []).find((c: any) => c.hex.toLowerCase() === String(ans.hex).toLowerCase());
      return named ? `${named.name} (${ans.hex})` : String(ans.hex);
    }
    case "memory":
      return (ans.sequence ?? []).join("-") || "—";
    case "react":
      return "BUZZ!";
    default:
      return JSON.stringify(ans);
  }
}

function renderWhoAnswered(q: any, players: RoomData["players"], currentIndex: number) {
  const card = el("div", { className: "card" });
  const answered = players.filter((p: any) => p.lastAnswer && p.lastAnswer.questionIndex === currentIndex);
  card.append(el("h3", { text: `Wer hat was geantwortet (${answered.length}/${players.length})` }));
  if (answered.length === 0) {
    card.append(el("p", { className: "muted", text: "Niemand hat geantwortet." }));
    return card;
  }
  const list = el("div", { className: "answer-list" });
  answered.forEach((p: any) => {
    const ok = p.lastAnswer?.correct;
    const row = el("div", { className: "answer-row" });
    row.append(el("strong", { text: `${p.name}: ` }));
    row.append(el("span", { text: formatPlayerAnswer(q, p.lastAnswer?.answer) }));
    row.append(el("span", { text: ok ? " ✓" : " ✗", style: ok ? "color:var(--good)" : "color:var(--bad)" }));
    if (typeof p.lastAnswer?.delta === "number" && p.lastAnswer.delta > 0) {
      row.append(el("span", { className: "muted small", text: ` (+${p.lastAnswer.delta})` }));
    }
    list.append(row);
  });
  const missing = players.filter((p: any) => !p.lastAnswer || p.lastAnswer.questionIndex !== currentIndex);
  missing.forEach((p: any) => {
    const row = el("div", { className: "answer-row" });
    row.append(el("strong", { text: `${p.name}: ` }));
    row.append(el("span", { className: "muted", text: "— keine Antwort —" }));
    list.append(row);
  });
  card.append(list);
  return card;
}

function renderReveal(r: RoomData) {
  const q = r.quiz.questions[r.currentQuestionIndex];
  root.append(el("div", { className: "question-text big", text: q.text }));
  const answeredPlayers = r.players.filter((p: any) => p.lastAnswer && p.lastAnswer.questionIndex === r.currentQuestionIndex);

  switch (q.type) {
    case "quiz":
    case "true_false":
    case "dropdown":
    case "audio_clip":
    case "video_clip": {
      const stage = el("div", { className: "stage" });
      (q.choices ?? []).slice(0, 4).forEach((c: string, i: number) => {
        const cls = i === q.correctIndex ? `choice ${COLORS[i % 4]} reveal-correct` : `choice ${COLORS[i % 4]} reveal-wrong`;
        stage.append(el("div", { className: cls, text: c }, [
          el("span", { className: "glyph", text: GLYPHS[i % 4] }),
        ]));
      });
      root.append(stage);
      const counts = el("div", { className: "row center", style: "justify-content:center; gap:1rem;" });
      (q.choices ?? []).forEach((_, i) => {
        const pct = Math.round(((r.players.filter((p: any) => p.lastAnswer?.answer?.choice === i).length) / Math.max(1, r.players.length)) * 100);
        counts.append(el("div", { className: `glyph-circle ${COLORS[i % 4]}`, text: `${pct}%` }));
      });
      root.append(counts);
      break;
    }
    case "multi_select":
    case "choose_two": {
      const stage = el("div", { className: "stage" });
      (q.choices ?? []).slice(0, 6).forEach((c: string, i: number) => {
        const correct = (q.correctIndices ?? []).includes(i);
        const cls = correct ? `choice ${COLORS[i % 4]} reveal-correct` : `choice ${COLORS[i % 4]} reveal-wrong`;
        stage.append(el("div", { className: cls, text: c }, [
          el("span", { className: "glyph", text: GLYPHS[i % 4] }),
        ]));
      });
      root.append(stage);
      break;
    }
    case "type_answer":
    case "fill_blank": {
      const correctCard = el("div", { className: "card center" });
      correctCard.append(el("div", { className: "muted small", text: "Akzeptierte Antworten" }));
      correctCard.append(el("h2", { text: (q.acceptedAnswers ?? []).join(" / ") }));
      root.append(correctCard);
      const counts = el("div", { className: "row" }, [
        el("div", { className: "card", style: "flex:1; text-align:center;" }, [
          el("div", { className: "muted small", text: "Richtig" }),
          el("h2", { text: String(r.players.filter((p: any) => p.lastAnswer?.correct).length) }),
        ]),
        el("div", { className: "card", style: "flex:1; text-align:center;" }, [
          el("div", { className: "muted small", text: "Falsch / übersprungen" }),
          el("h2", { text: String(r.players.length - r.players.filter((p: any) => p.lastAnswer?.correct).length) }),
        ]),
      ]);
      root.append(counts);
      break;
    }
    case "slider":
    case "estimate": {
      const min = q.sliderMin ?? 0;
      const max = q.sliderMax ?? 100;
      const correct = q.sliderCorrect ?? 0;
      const values = r.players.map((p: any) => p.lastAnswer?.answer?.choice).filter((v: any) => typeof v === "number") as number[];
      const stage = el("div", { className: "slider-stage reveal" });
      const track = el("div", { className: "slider-track" });
      const fill = el("div", { className: "slider-fill" });
      fill.style.width = `${((correct - min) / (max - min)) * 100}%`;
      track.append(fill);
      const correctMark = el("div", { className: "slider-correct" });
      correctMark.style.left = `${((correct - min) / (max - min)) * 100}%`;
      track.append(correctMark);
      values.forEach((v) => {
        const dot = el("div", { className: "slider-dot" });
        dot.style.left = `${((v - min) / (max - min)) * 100}%`;
        track.append(dot);
      });
      const labels = el("div", { className: "slider-labels" }, [
        el("span", { text: String(min) }),
        el("span", { text: q.estimateUnit ? `Correct: ${correct} ${q.estimateUnit}` : `Correct: ${correct}` }),
        el("span", { text: String(max) }),
      ]);
      stage.append(track, labels);
      root.append(stage);
      break;
    }
    case "order":
    case "sequence":
    case "fastest_finger": {
      const list = el("div", { className: "list-display" });
      (q.correctOrder ?? []).forEach((itemIdx: number, pos: number) => {
        list.append(el("div", { className: "list-row reveal-correct" }, [
          el("span", { className: "list-pos", text: String(pos + 1) }),
          el("span", { text: (q.items ?? [])[itemIdx] }),
        ]));
      });
      root.append(list);
      break;
    }
    case "poll": {
      const stage = el("div", { className: "poll-stage" });
      (q.choices ?? []).slice(0, 4).forEach((c: string, i: number) => {
        const pct = Math.round(((r.players.filter((p: any) => p.lastAnswer?.answer?.choice === i).length) / Math.max(1, r.players.length)) * 100);
        const bar = el("div", { className: `poll-row ${COLORS[i % 4]}` });
        bar.append(el("div", { className: "poll-bar", style: `width:${pct}%` }));
        bar.append(el("span", { className: "poll-label", text: c }));
        bar.append(el("span", { className: "poll-pct", text: `${pct}%` }));
        stage.append(bar);
      });
      root.append(stage);
      break;
    }
    case "brainstorm":
    case "word_cloud": {
      const textAnswers = answeredPlayers.map((p: any) => ({ name: p.name, text: p.lastAnswer?.answer?.words?.join(", ") ?? "" })).filter((a) => a.text);
      const card = el("div", { className: "card" });
      card.append(el("h3", { text: `${textAnswers.length} Antworten` }));
      const list = el("div", { className: "answer-list" });
      textAnswers.forEach((a) => {
        const row = el("div", { className: "answer-row" });
        row.append(el("strong", { text: `${a.name}: ` }));
        row.append(el("span", { text: a.text }));
        list.append(row);
      });
      card.append(list);
      root.append(card);
      break;
    }
    case "open_ended": {
      if (q.referenceAnswer) {
        const refCard = el("div", { className: "card center", style: "border-color: var(--good)" });
        refCard.append(el("div", { className: "muted small", text: "Musterlösung (vom Ersteller)" }));
        refCard.append(el("h2", { text: `"${q.referenceAnswer}"` }));
        root.append(refCard);
      }
      const card = el("div", { className: "card" });
      const withAnswers = answeredPlayers.filter((p: any) => p.lastAnswer?.answer?.kind === "text");
      card.append(el("h3", { text: `${withAnswers.length} Antworten (KI-geprüft)` }));
      const list = el("div", { className: "answer-list" });
      withAnswers.forEach((p: any) => {
        const ok = p.lastAnswer?.correct;
        const row = el("div", { className: "answer-row" });
        row.append(el("strong", { text: `${p.name}: ` }));
        row.append(el("span", { text: `"${p.lastAnswer?.answer?.text ?? ""}"` }));
        row.append(el("span", { text: ok ? " ✓" : " ✗", style: ok ? "color:var(--good)" : "color:var(--bad)" }));
        list.append(row);
      });
      card.append(list);
      root.append(card);
      break;
    }
    case "color_match": {
      const colorsArr = q.colors ?? [];
      const correctName = q.correctName ?? colorsArr[0]?.name ?? "?";
      const correct = colorsArr.find((c: any) => c.name === correctName) ?? colorsArr[0];
      const swatch = el("div", { className: "color-swatch-big", style: `background:${correct?.hex ?? "#888"}` });
      root.append(swatch);
      root.append(el("div", { className: "card center" }, [el("h2", { text: `Richtig: ${correctName}` })]));
      break;
    }
    case "reaction": {
      const player = r.players.find((p) => p.id === r.buzzedPlayerId);
      const card = el("div", { className: "card center", style: "border-color: var(--yellow)" });
      card.append(el("h2", { text: "\u26a1" }));
      card.append(el("p", { text: `${player?.name ?? "?"} hat gewonnen` }));
      root.append(card);
      break;
    }
    case "image_hotspot": {
      const img = el("div", { className: "host-image", style: q.imageUrl ? `background:url(${q.imageUrl}) center/cover; position:relative` : "background:#222" });
      img.style.minHeight = "240px";
      const target = el("div", { className: "hotspot-target" });
      target.style.left = `${(q.hotspotX ?? 0.5) * 100}%`;
      target.style.top = `${(q.hotspotY ?? 0.5) * 100}%`;
      target.style.width = `${(q.hotspotRadius ?? 0.1) * 200}%`;
      target.style.height = `${(q.hotspotRadius ?? 0.1) * 200}%`;
      img.append(target);
      root.append(img);
      break;
    }
    case "classify": {
      const grid = el("div", { className: "classify-grid" });
      (q.categories ?? []).forEach((cat: string) => {
        const bin = el("div", { className: "classify-bin reveal-correct" });
        bin.append(el("div", { className: "classify-label", text: cat }));
        (q.items ?? []).filter((it: string) => q.correctBins?.[it] === cat).forEach((it: string) => {
          bin.append(el("div", { className: "classify-item", text: it }));
        });
        grid.append(bin);
      });
      root.append(grid);
      break;
    }
    case "puzzle_drop": {
      const slotsRow = el("div", { className: "puzzle-slots" });
      (q.correctOrder ?? []).forEach((itemIdx: number) => {
        slotsRow.append(el("div", { className: "puzzle-slot reveal-correct", text: (q.items ?? [])[itemIdx] ?? "" }));
      });
      root.append(slotsRow);
      break;
    }
    case "match_pairs": {
      const grid = el("div", { className: "match-grid" });
      (q.pairs ?? []).forEach((p: any) => {
        grid.append(el("div", { className: "match-row reveal-correct" }, [
          el("div", { className: "match-left", text: p.left }),
          el("div", { className: "match-arrow", text: "\u2194" }),
          el("div", { className: "match-right", text: p.right }),
        ]));
      });
      root.append(grid);
      break;
    }
    case "memory": {
      const card = el("div", { className: "card center" });
      card.append(el("h2", { text: `Sequenz-Länge: ${q.memoryLength}` }));
      root.append(card);
      break;
    }
  }

  // Shared-screen summary: WHO answered WHAT (skip for open_ended which already lists names).
  if (q.type !== "open_ended" && q.type !== "brainstorm" && q.type !== "word_cloud") {
    root.append(renderWhoAnswered(q, r.players, r.currentQuestionIndex));
  }

  const isLast = r.currentQuestionIndex === r.quiz.questions.length - 1;
  const next = el("button", { text: isLast ? "Endergebnis zeigen" : "Nächste Frage", style: "margin-top:1rem" });
  on(next, "click", () => {
    if (isLast) send({ type: "host:show-results", pin: r.pin });
    else send({ type: "host:next-question", pin: r.pin });
  });
  root.append(next);
}

function renderLeaderboard(r: RoomData) {
  root.append(el("h2", { className: "center", text: "🏆 Bestenliste" }));
  const list = el("div", { className: "lb-list" });
  r.leaderboard.forEach((row, i) => {
    const cls = i === 0 ? "lb-row gold" : i === 1 ? "lb-row silver" : i === 2 ? "lb-row bronze" : "lb-row";
    const rankLabel = ["🥇", "🥈", "🥉"][i] ?? `#${row.rank}`;
    list.append(el("div", { className: cls }, [
      el("span", { className: "rank", text: rankLabel }),
      el("span", { text: row.name }),
      el("span", { text: String(row.score).padStart(5, "0") }),
    ]));
  });
  root.append(list);
  const isLast = r.currentQuestionIndex >= r.quiz.questions.length - 1;
  const next = el("button", { text: isLast ? "Endergebnis zeigen" : "Nächste Frage", style: "margin-top:1rem" });
  on(next, "click", () => {
    if (isLast) send({ type: "host:show-results", pin: r.pin });
    else send({ type: "host:next-question", pin: r.pin });
  });
  root.append(next);
}

function renderFinal(r: RoomData) {
  root.append(el("h1", { className: "center", text: "🏁 Endergebnis" }));
  root.append(el("p", { className: "center muted", text: `${r.quiz.questions.length} Fragen · ${r.players.length} Spieler` }));
  const entries = r.leaderboard.slice(0, 3).map((row) => ({ ...row, id: row.id }));
  if (entries.length >= 2) {
    const podium = el("div", { className: "podium" });
    const order = [
      { place: 2, entry: entries[1] },
      { place: 1, entry: entries[0] },
      { place: 3, entry: entries[2] ?? null },
    ];
    for (const { place, entry } of order) {
      const slot = el("div", { className: `podium-slot place-${place}${entry ? "" : " empty"}` });
      if (entry) {
        slot.append(
          el("div", { className: "podium-medal", text: ["🥇", "🥈", "🥉"][place - 1] }),
          el("div", { className: "podium-name", text: entry.name }),
          el("div", { className: "podium-score", text: `${entry.score} Pkte` }),
        );
      }
      slot.append(el("div", { className: "podium-bar", text: String(place) }));
      podium.append(slot);
    }
    root.append(podium);
    const list = el("div", { className: "lb-list" });
    r.leaderboard.slice(3).forEach((row) => {
      list.append(el("div", { className: "lb-row" }, [
        el("span", { className: "rank", text: `#${row.rank}` }),
        el("span", { text: row.name }),
        el("span", { text: String(row.score).padStart(5, "0") }),
      ]));
    });
    if (r.leaderboard.length > 3) root.append(list);
  } else {
    const list = el("div", { className: "lb-list" });
    r.leaderboard.forEach((row, i) => {
      const cls = i === 0 ? "lb-row gold" : "lb-row";
      list.append(el("div", { className: cls }, [
        el("span", { className: "rank", text: `#${row.rank}` }),
        el("span", { text: row.name }),
        el("span", { text: String(row.score).padStart(5, "0") }),
      ]));
    });
    root.append(list);
  }
  const end = el("button", { text: "Spiel beenden", className: "danger", style: "margin-top:1rem" });
  on(end, "click", () => ws!.send(JSON.stringify({ type: "host:end-game", pin: r.pin })));
  root.append(end);
}

if (!quizId && !params.get("pin")) {
  const card = el("div", { className: "card center" });
  card.append(el("h2", { text: "Schnellstart" }));
  card.append(el("p", { className: "muted", text: "Wähle ein Quiz zum Hosten oder starte eine leere Session." }));
  const goLib = el("a", { href: "/library.html", text: "Quiz wählen" });
  const startEmpty = el("button", { text: "Leere Session starten" });
  card.append(el("div", { className: "row center", style: "justify-content:center" }, [goLib, startEmpty]));
  goLib.classList.add("ghost", "button");
  on(startEmpty, "click", () => {
    pin = makePin();
    connect();
    room = null;
    root.innerHTML = "";
    root.append(el("p", { className: "muted", text: "Verbinde..." }));
  });
  root.appendChild(card);
} else {
  connect();
}