import type { ServerWebSocket } from "bun";
import { listQuizzes, getQuiz, saveQuiz, deleteQuiz, recordPlayTx, getQuizMeta } from "./db";
import type { Player, Question, Quiz, RoomState, WSEvent } from "./types";
import {
  aggregateStats,
  choiceCounts,
  clampAnswer,
  allRanks,
  clearAutoReveal,
  createRoom,
  developerDisplayName,
  isDeveloperJoinName,
  leaderboard,
  looksLikeDeveloperImpersonation,
  makePin,
  newId,
  nextGuestName,
  publicRoomSnapshot,
  safeName,
  scoreAnswer,
  shuffledPairs,
  topPlayers,
  type AggregatedStats,
} from "./game";
import { generateQuiz, generateQuizStream, gradeOpenEnded } from "./ai";

type WSData = { role: "host" | "player"; id: string; pin: string; quizId: string; sessionToken: string; invalidSession: boolean };

const rooms = new Map<string, ReturnType<typeof createRoom>>();
const sessions = new Map<string, { role: "host" | "player"; id: string; pin: string }>();
const emptySince = new Map<string, number>();
const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingAnswers = new Map<string, number>();
const wsById = new Map<string, ServerWebSocket<WSData>>();

const MAX_PLAYERS_PER_ROOM = 500;
const MAX_ROOMS = 300;
const MAX_CONCURRENT_STREAMS = 4;
let activeStreams = 0;

const rateBuckets = new Map<string, number[]>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const prev = rateBuckets.get(key);
  const fresh = prev ? prev.filter((t) => now - t < windowMs) : [];
  if (fresh.length >= limit) {
    rateBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length === 0) rateBuckets.delete(k);
    else rateBuckets.set(k, fresh);
  }
}, 60_000).unref();

// ---- Server-Side Performance-Metriken (für /healthz & Stresstests) ----
const answerSamples: number[] = [];
function recordAnswerMs(ms: number) {
  answerSamples.push(ms);
  if (answerSamples.length > 2000) answerSamples.splice(0, 500);
}
function answerPerf() {
  if (answerSamples.length === 0) return { n: 0, p50: 0, p99: 0, max: 0 };
  const s = [...answerSamples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: Math.round(q(0.5) * 100) / 100, p99: Math.round(q(0.99) * 100) / 100, max: Math.round(s[s.length - 1] * 100) / 100 };
}
let loopLagMs = 0;
{
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    loopLagMs = Math.max(0, now - lastTick - 1000);
    lastTick = now;
  }, 1000).unref();
}

function clientIp(req: Request, server: any): string {  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  try {
    return server.requestIP(req)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

function rateLimited(req: Request, server: any, key: string, limit: number, windowMs: number): Response | null {
  const ip = clientIp(req, server);
  if (rateLimit(`${ip}:${key}`, limit, windowMs)) return null;
  log("warn", "rate limit hit", { ip, key, limit });
  return Response.json({ error: "Zu viele Anfragen — kurz warten." }, {
    status: 429,
    headers: { "Retry-After": String(Math.ceil(windowMs / 1000)) },
  });
}

async function readJson(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function log(level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, any>) {
  const entry = { level, message, timestamp: new Date().toISOString(), ...meta };
  console.log(JSON.stringify(entry));
}

function destroyRoom(room: RoomState) {
  clearAutoReveal(room);
  const timer = snapshotTimers.get(room.pin);
  if (timer) clearTimeout(timer);
  snapshotTimers.delete(room.pin);
  const lobbyTimer = lobbyTimers.get(room.pin);
  if (lobbyTimer) clearTimeout(lobbyTimer);
  lobbyTimers.delete(room.pin);
  countThrottle.delete(room.pin);
  rooms.delete(room.pin);
  emptySince.delete(room.pin);
  for (const [token, session] of sessions) {
    if (session.pin !== room.pin) continue;
    sessions.delete(token);
    pendingAnswers.delete(session.id);
    lastSeen.delete(session.id);
    const ws = wsById.get(session.id);
    if (ws) ws.close(1000, "Game ended");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const active = (room.hostId && wsById.has(room.hostId)) || Array.from(room.players.values()).some((p) => p.connected);
    if (active) emptySince.delete(room.pin);
    else if (!emptySince.has(room.pin)) emptySince.set(room.pin, now);
    else if (now - emptySince.get(room.pin)! >= 5 * 60_000) destroyRoom(room);
  }
}, 30_000).unref();

function queueHostSnapshot(room: RoomState) {
  if (snapshotTimers.has(room.pin)) return;
  snapshotTimers.set(room.pin, setTimeout(() => {
    snapshotTimers.delete(room.pin);
    if (rooms.get(room.pin) === room) pushHostSnapshot(room);
  }, 100));
}

// Trailing-debounced Lobby-Broadcasts (Join-Stürme) + gedrosselte
// Live-Zähler (Antwort-Stürme): max 1 Broadcast pro Fenster.
const lobbyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const countThrottle = new Map<string, number>();
// Letzte Aktivität pro Spieler (jede WS-Nachricht zählt, inkl. Ping).
// Wer nichts sendet, fliegt per Sweep raus (siehe IDLE_TIMEOUT_MS).
// Client pingt alle 5s (siehe player.ts) — bei CPU-gedrosselten Hosts kann die
// Event-Loop unter Last (viele Spieler, JSON-Serialisierung) mehrere Sekunden
// hinterherhängen, bevor eine eingehende Ping-Nachricht verarbeitet wird. Ein
// zu knappes Timeout (früher 10s = nur 1 verpasster Zyklus Puffer) kickt dann
// aktive Spieler fälschlich als "idle", was ihre Session löscht und beim
// Reconnect zum "Session abgelaufen"-Fehler führt. 30s (6 Zyklen Puffer)
// toleriert das, ohne echte Inaktivität lange zu übersehen.
const lastSeen = new Map<string, number>();
const IDLE_TIMEOUT_MS = 30_000;
// Reload/Back-Navigation schliesst den Socket sofort (kein Ping mehr), lässt
// aber Session + Spieler bestehen, damit der Reconnect sie wiederfindet. Wer
// bereits getrennt ist braucht daher viel mehr Zeit zum Reconnecten als ein
// still gewordener, noch offener Socket (IDLE_TIMEOUT_MS) — sonst killt der
// Sweep die Session genau während der Spieler neu lädt/zurücknavigiert.
const disconnectedSince = new Map<string, number>();
const DISCONNECT_GRACE_MS = 5 * 60_000;

// Entfernt Spieler+Session endgültig — nur nach der langen Reconnect-Gnadenfrist,
// nie direkt vom Ping-Timeout (siehe dropStaleSocket).
function kickIdlePlayer(room: RoomState, playerId: string) {
  const p = room.players.get(playerId);
  if (!p) return;
  room.players.delete(playerId);
  lastSeen.delete(playerId);
  disconnectedSince.delete(playerId);
  pendingAnswers.delete(playerId);
  for (const [token, session] of sessions) {
    if (session.id === playerId) sessions.delete(token);
  }
  if (p.lastAnswer?.questionIndex === room.currentQuestionIndex) {
    room.answeredCount = Math.max(0, room.answeredCount - 1);
  }
  log("info", "idle player removed", { pin: room.pin, player: p.name });
  sendLobbyUpdate(room);
  queueHostSnapshot(room);
}

// Ping-Timeout erreicht, aber Browser hat den Socket evtl. nie sauber
// geschlossen (kein Close-Frame bei Navigation/Reload garantiert) — Session
// und Spieler bleiben bestehen, nur der tote Socket fliegt raus. close()
// markiert connected=false, danach greift die lange DISCONNECT_GRACE_MS.
function dropStaleSocket(room: RoomState, playerId: string) {
  lastSeen.delete(playerId);
  const ws = wsById.get(playerId);
  if (ws) ws.close(1000, "Idle timeout");
  else {
    const p = room.players.get(playerId);
    if (p) p.connected = false;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (!p.connected) {
        const since = disconnectedSince.get(p.id) ?? now;
        disconnectedSince.set(p.id, since);
        if (now - since >= DISCONNECT_GRACE_MS) kickIdlePlayer(room, p.id);
        continue;
      }
      const seen = lastSeen.get(p.id) ?? 0;
      if (now - seen >= IDLE_TIMEOUT_MS) {
        dropStaleSocket(room, p.id);
      }
    }
  }
}, 5000).unref();

function sendLobbyUpdate(room: RoomState) {
  broadcast(room, {
    type: "lobby:update",
    players: Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name, locked: !!p.nameLocked, renamePending: !!p.renamePending })),
    snapshot: publicRoomSnapshot(room),
  });
}

function broadcast(room: ReturnType<typeof createRoom>, event: object, exceptId?: string) {
  const hostWs = room.hostId && room.hostId !== exceptId ? wsById.get(room.hostId) : null;
  if (!hostWs) {
    let anyone = false;
    for (const p of room.players.values()) {
      if (p.connected && p.id !== exceptId && wsById.has(p.id)) { anyone = true; break; }
    }
    if (!anyone) return;
  }
  const json = JSON.stringify(event);
  for (const p of room.players.values()) {
    if (p.connected && p.id !== exceptId) {
      const ws = wsById.get(p.id);
      if (ws) ws.send(json);
    }
  }
  if (hostWs) hostWs.send(json);
}

function pushHostSnapshot(room: ReturnType<typeof createRoom>) {
  if (!room.hostId) return;
  const hostWs = wsById.get(room.hostId);
  if (!hostWs) return;
  hostWs.send(JSON.stringify({ type: "host:snapshot", room: fullHostSnapshot(room) }));
}

function send(ws: ServerWebSocket<WSData>, event: object) {
  ws.send(JSON.stringify(event));
}

function fullHostSnapshot(room: ReturnType<typeof createRoom>) {
  // Volle Antwort-Payloads braucht der Host nur im Reveal (dort zeigt er WER
  // WAS geantwortet hat). Während der Frage reicht questionIndex zum Zählen —
  // das spart pro Snapshot O(Spieler × Payload) Serialisierung.
  const detail = room.phase === "reveal";
  return {
    pin: room.pin,
    phase: room.phase,
    quiz: room.quiz,
    currentQuestionIndex: room.currentQuestionIndex,
    questionStartedAt: room.questionStartedAt,
    buzzedPlayerId: room.buzzedPlayerId,
    reactionGoAt: room.reactionGoAt,
    answeredCount: room.answeredCount,
    // Beim Reveal nach Rang sortiert (höchste Punktzahl zuerst), damit der
    // Host sofort sieht, wer vorne liegt; in Lobby/Frage bleibt Beitrittsreihenfolge.
    players: (detail ? Array.from(room.players.values()).sort((a, b) => b.score - a.score) : Array.from(room.players.values())).map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      locked: !!p.nameLocked,
      lastAnswer: !p.lastAnswer ? null : detail ? p.lastAnswer : { questionIndex: p.lastAnswer.questionIndex },
    })),
    leaderboard: topPlayers(room.players, 5),
  };
}

function questionPayload(room: RoomState, q: Question, index: number) {
  const correctColor = (q.colors ?? []).find((c) => c.name === (q.correctName ?? ""));
  return {
    type: "question:show",
    index,
    total: room.quiz.questions.length,
    questionType: q.type,
    timeLimit: q.timeLimit,
    points: q.points,
    goAt: q.type === "reaction" ? room.reactionGoAt : undefined,
    memorySeq: q.type === "memory" ? room.memorySeq : undefined,
    correctName: q.type === "color_match" ? (q.correctName ?? null) : undefined,
    targetHex: q.type === "color_match" ? (correctColor?.hex ?? q.colors?.[0]?.hex ?? null) : undefined,
    question: {
      id: q.id,
      text: q.text,
      imageUrl: q.imageUrl,
      audioUrl: q.audioUrl,
      videoUrl: q.videoUrl,
      choices: q.choices ?? [],
      correctIndices: q.correctIndices,
      items: q.items ?? [],
      pairs: q.pairs ?? [],
      categories: q.categories ?? [],
      sliderMin: q.sliderMin,
      sliderMax: q.sliderMax,
      sliderStep: q.sliderStep,
      estimateUnit: q.estimateUnit,
      puzzleSlots: q.puzzleSlots ?? [],
      hotspotRadius: q.hotspotRadius,
      colors: q.colors ?? [],
      correctName: q.correctName ?? null,
      memoryLength: q.memoryLength,
    },
    startedAt: room.questionStartedAt,
  };
}

function playerQuestionPayload(room: RoomState, q: Question, index: number) {
  // Spieler-Version OHNE Lösungen: keine correctIndices, kein correctName,
  // Paare mit gemischten rechten Seiten. Wer Devtools liest, sieht NICHTS —
  // gewertet wird ausschliesslich serverseitig (false-positive-frei).
  const full: any = questionPayload(room, q, index);
  const qq = full.question ?? {};
  delete qq.correctIndices;
  delete qq.correctName;
  if (Array.isArray(qq.pairs)) qq.pairs = shuffledPairs(qq.pairs);
  return full;
}

function broadcastPlayers(room: RoomState, event: object, exceptId?: string) {
  const json = JSON.stringify(event);
  for (const p of room.players.values()) {
    if (p.connected && p.id !== exceptId) {
      const ws = wsById.get(p.id);
      if (ws) ws.send(json);
    }
  }
}

function revealQuestion(room: RoomState) {
  if (room.phase !== "question" && room.phase !== "buzzed") return;
  clearAutoReveal(room);
  room.phase = "reveal";
  broadcast(room, revealPayload(room));
  pushHostSnapshot(room);
}

function revealPayload(room: RoomState) {
  const q = room.quiz.questions[room.currentQuestionIndex];
  const agg = aggregateStats(room, room.currentQuestionIndex);
  const stats = (q.choices ?? q.items ?? []).map((_, i) => agg.choiceCounts[i] ?? 0);
  const answered = room.answeredCount;
  return {
    type: "question:reveal",
    index: room.currentQuestionIndex,
    questionType: q.type,
    correctIndex: q.correctIndex,
    correctIndices: q.correctIndices,
    correctValue: q.sliderCorrect,
    acceptedAnswers: q.acceptedAnswers ?? [],
    referenceAnswer: q.referenceAnswer ?? null,
    correctAnswer: q.correctIndex !== undefined ? (q.choices ?? [])[q.correctIndex] : null,
    correctOrder: q.correctOrder ?? [],
    correctBins: (q as any).correctBins ?? {},
    correctName: q.correctName ?? null,
    choices: q.choices ?? [],
    items: q.items ?? [],
    pairs: q.pairs ?? [],
    categories: q.categories ?? [],
    imageUrl: q.imageUrl ?? null,
    memorySeq: q.type === "memory" ? room.memorySeq : [],
    hotspot: q.hotspotX !== undefined ? { x: q.hotspotX, y: q.hotspotY ?? 0.5, r: q.hotspotRadius ?? 0.1 } : null,
    colors: q.colors ?? [],
    memoryLength: q.memoryLength ?? 0,
    stats,
    textAnswers: agg.textAnswers,
    sliderValues: agg.sliderValues,
    words: agg.words,
    buzzedPlayerId: room.buzzedPlayerId,
    answers: agg.answers,
    answered,
    total: room.players.size,
    ranks: allRanks(room.players),
  };
}

function autoReveal(room: RoomState) {
  revealQuestion(room);
}

// Prüft einen gewünschten Namen auf die "Entwickler"-Easter-Egg-Regel.
// Rückgabe: der zu verwendende Name + ob der Spieler weiter umbenennen muss.
// Bei einer geblockten Nachahmung wird `null` zurückgegeben (Wunsch abgelehnt).
function resolveGuardedName(room: RoomState, raw: string): { name: string; renamePending: boolean } | null {
  if (isDeveloperJoinName(raw)) return { name: developerDisplayName(), renamePending: false };
  if (looksLikeDeveloperImpersonation(raw)) return null;
  return { name: safeName(raw), renamePending: false };
}

function sendRenameRequired(ws: ServerWebSocket<WSData>, name: string) {
  send(ws, {
    type: "rename:required",
    name,
    message: "Dieser Name ist nicht erlaubt. Bitte wähle einen anderen Namen.",
  });
}

function handlePlayerRename(ws: ServerWebSocket<WSData>, evt: Extract<WSEvent, { type: "player:rename" }>) {
  const room = rooms.get(evt.pin);
  if (!room) return;
  const p = room.players.get(ws.data.id);
  if (!p) return;
  if (p.nameLocked) {
    send(ws, { type: "error", message: "Dein Name wurde vom Host festgelegt." });
    return;
  }
  const raw = evt.name ?? "";
  const resolved = resolveGuardedName(room, raw);
  if (!resolved) {
    // Weiterhin gesperrt: Platzhalter bleibt, bis ein erlaubter Name kommt.
    if (!p.renamePending) { p.name = nextGuestName(room); p.renamePending = true; sendLobbyUpdate(room); queueHostSnapshot(room); }
    sendRenameRequired(ws, p.name);
    return;
  }
  const next = resolved.name;
  if (!next || (next === p.name && p.renamePending === resolved.renamePending)) return;
  log("debug", "player renamed", { pin: evt.pin, from: p.name, to: next });
  p.name = next;
  p.renamePending = resolved.renamePending;
  sendLobbyUpdate(room);
  queueHostSnapshot(room);
}

function handlePlayerJoin(ws: ServerWebSocket<WSData>, evt: Extract<WSEvent, { type: "player:join" }>) {
  const room = rooms.get(evt.pin);
  if (!room) {
    send(ws, { type: "error", message: "Game not found" });
    return;
  }
  const id = ws.data.id;
  const existing = room.players.get(id);
  if (room.phase === "finished" && !existing) {
    send(ws, { type: "error", message: "Game has ended", terminal: true });
    ws.close();
    return;
  }
  if (!existing && room.players.size >= MAX_PLAYERS_PER_ROOM) {
    send(ws, { type: "error", message: "Room is full", terminal: true });
    ws.close();
    return;
  }
  let renamePendingOnJoin = false;
  if (existing) { existing.connected = true; disconnectedSince.delete(id); }
  else {
    const raw = evt.name ?? "";
    const resolved = resolveGuardedName(room, raw);
    const name = resolved ? resolved.name : nextGuestName(room);
    renamePendingOnJoin = resolved ? resolved.renamePending : true;
    room.players.set(id, {
      id,
      name,
      renamePending: renamePendingOnJoin,
      score: 0,
      correctCount: 0,
      streak: 0,
      connected: true,
    });
  }
  send(ws, { type: "joined", playerId: id, pin: evt.pin });
  log("debug", "player joined", { pin: evt.pin, name: room.players.get(id)?.name ?? "", players: room.players.size });
  if (renamePendingOnJoin) sendRenameRequired(ws, room.players.get(id)!.name);
  // Lobby-Liste: bei Join-Stürmen (ganze Klasse auf einmal) trailing-debounced
  // (max 1 Broadcast/500ms) statt O(P²); kleine Räume bleiben instant.
  const pendingLobby = lobbyTimers.get(evt.pin);
  if (room.players.size <= 20) {
    if (pendingLobby) { clearTimeout(pendingLobby); lobbyTimers.delete(evt.pin); }
    sendLobbyUpdate(room);
  } else if (!pendingLobby) {
    lobbyTimers.set(evt.pin, setTimeout(() => {
      lobbyTimers.delete(evt.pin);
      const r = rooms.get(evt.pin);
      if (r) sendLobbyUpdate(r);
    }, 500));
  }
  queueHostSnapshot(room);
  const p = room.players.get(id)!;
  if (room.phase === "question" || room.phase === "buzzed" || room.phase === "reveal") {
    send(ws, {
      ...playerQuestionPayload(room, room.quiz.questions[room.currentQuestionIndex], room.currentQuestionIndex),
      answered: p.lastAnswer?.questionIndex === room.currentQuestionIndex || pendingAnswers.get(id) === room.currentQuestionIndex,
    });
    if (p.lastAnswer?.questionIndex === room.currentQuestionIndex) sendAnswerAck(ws, room, p);
    if (room.phase === "reveal") send(ws, revealPayload(room));
    if (room.phase === "buzzed") send(ws, { type: "buzzed", playerId: room.buzzedPlayerId, playerName: room.players.get(room.buzzedPlayerId!)?.name });
  } else if (room.phase === "leaderboard" || room.phase === "finished") {
    send(ws, { type: room.phase === "finished" ? "game:finished" : "leaderboard:show", leaderboard: leaderboard(room.players, room.phase === "finished" ? room.players.size : 5) });
  }
}

function sendAnswerAck(ws: ServerWebSocket<WSData>, room: RoomState, p: Player) {
  const answer = p.lastAnswer;
  if (!answer) return;
  send(ws, {
    type: "answer:ack",
    questionIndex: answer.questionIndex,
    correct: answer.correct,
    correctIndex: room.quiz.questions[answer.questionIndex]?.correctIndex,
    delta: answer.delta,
    score: p.score,
  });
}

async function handlePlayerAnswer(ws: ServerWebSocket<WSData>, evt: Extract<WSEvent, { type: "player:answer" }>) {
  const room = rooms.get(evt.pin);
  if (!room) return;
  if (room.phase !== "question") return;
  const p = room.players.get(ws.data.id);
  if (!p) return;
  if (p.lastAnswer && p.lastAnswer.questionIndex === evt.questionIndex) {
    // Anti-Cheat (harmlos): Doppel-Antwort wird ignoriert, nur geloggt.
    log("debug", "duplicate answer ignored", { pin: evt.pin, player: p.id });
    return;
  }
  const q = room.quiz.questions[room.currentQuestionIndex];
  if (!q || evt.questionIndex !== room.currentQuestionIndex) {
    log("debug", "stale answer ignored", { pin: evt.pin, player: p.id });
    return;
  }
  // Riesen-Payloads sofort auf sinnvolle Größen stutzen.
  evt.answer = clampAnswer(evt.answer);
  const tA = performance.now();

  if (q.type === "reaction") {
    if (room.buzzedPlayerId) {
      send(ws, { type: "answer:ack", questionIndex: evt.questionIndex, correct: false, correctIndex: -1, delta: 0, score: p.score });
      return;
    }
    if (Date.now() < room.reactionGoAt) {
      send(ws, { type: "answer:ack", questionIndex: evt.questionIndex, correct: false, correctIndex: -1, delta: 0, score: p.score, tooEarly: true });
      return;
    }
    room.buzzedPlayerId = p.id;
    room.buzzedAt = Date.now();
    room.phase = "buzzed";
    clearAutoReveal(room);
    const elapsed = Date.now() - room.questionStartedAt;
    const result = scoreAnswer(q, evt.answer, elapsed, p.score, p.streak, room.memorySeq);
    p.lastAnswer = {
      questionIndex: room.currentQuestionIndex,
      answer: evt.answer,
      timeMs: elapsed,
      delta: result.delta,
      correct: result.correct,
    };
    p.score += result.delta;
    if (result.correct) p.correctCount += 1;
    p.streak = result.newStreak;
    room.answeredCount++;
    broadcast(room, {
      type: "buzzed",
      playerId: p.id,
      playerName: p.name,
      delayMs: elapsed,
    });
    pushHostSnapshot(room);
    send(ws, { type: "answer:ack", questionIndex: evt.questionIndex, correct: true, correctIndex: 0, delta: result.delta, score: p.score });
    recordAnswerMs(performance.now() - tA);
    return;
  }

  const elapsed = Date.now() - room.questionStartedAt;
  // Anti-Cheat: Antworten nach Zeitlimit + 2s Grace kommen nicht in die Wertung.
  // (Ehrliche Clients sind längst durch — keine False-Positives möglich.)
  if (elapsed > q.timeLimit * 1000 + 2000) {
    log("debug", "late answer ignored", { pin: evt.pin, player: p.id, elapsed });
    send(ws, { type: "answer:ack", questionIndex: evt.questionIndex, correct: false, correctIndex: -1, delta: 0, score: p.score });
    return;
  }
  let result = scoreAnswer(q, evt.answer, elapsed, p.score, p.streak, room.memorySeq);

  if (q.type === "open_ended" && (q.referenceAnswer ?? "").trim() && evt.answer.kind === "text") {
    try {
      const ok = await gradeOpenEnded(q.text, q.referenceAnswer!.trim(), evt.answer.text);
      const base = q.points;
      const timeLimitMs = q.timeLimit * 1000;
      const speedRatio = Math.max(0, 1 - elapsed / timeLimitMs);
      const fullDelta = Math.round(base * (0.5 + 0.5 * speedRatio));
      const streakBonus = Math.floor(base * 0.25 * Math.min(p.streak, 5));
      result = ok
        ? { delta: fullDelta + streakBonus, correct: true, newStreak: p.streak + 1 }
        : { delta: 0, correct: false, newStreak: 0 };
    } catch (e) {
      log("error", "gradeOpenEnded failed, using heuristic", { error: String(e) });
    }
  }

  p.lastAnswer = {
    questionIndex: room.currentQuestionIndex,
    answer: evt.answer,
    timeMs: elapsed,
    delta: result.delta,
    correct: result.correct,
  };
  p.score += result.delta;
  if (result.correct) p.correctCount += 1;
  p.streak = result.newStreak;
  room.answeredCount++;
  // Schlanker Live-Zähler (keine Full-Aggregation pro Antwort!);
  // die teure Full-Aggregation läuft nur einmal beim Reveal.
  const counts = choiceCounts(room, room.currentQuestionIndex);
  const totalAnswers = room.answeredCount;
  // Live-Zähler drosseln: max 1 Broadcast/150ms im Antwort-Sturm (die finale
  // Antwort + das Reveal danach liefern immer den exakten Stand).
  const allIn = totalAnswers >= room.players.size;
  const lastCount = countThrottle.get(room.pin) ?? 0;
  if (allIn || Date.now() - lastCount >= 150) {
    countThrottle.set(room.pin, Date.now());
    broadcast(room, {
      type: "answers:update",
      answered: totalAnswers,
      total: room.players.size,
      stats: (q.choices ?? q.items ?? []).map((_, i) => counts[i] ?? 0),
    });
  }
  queueHostSnapshot(room);
  const activeSocket = wsById.get(p.id);
  if (activeSocket) sendAnswerAck(activeSocket, room, p);
  recordAnswerMs(performance.now() - tA);
  if (room.players.size > 0 && allIn) {
    clearAutoReveal(room);
    room.autoRevealTimer = setTimeout(() => {
      if (room.phase !== "question") return;
      autoReveal(room);
    }, 1500);
  }
}

const server = Bun.serve<WSData, {}>({
  port: Number(process.env.PORT ?? 9283),
  hostname: process.env.HOST ?? "0.0.0.0",
  idleTimeout: 255,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") as "host" | "player" | null;
      const pin = url.searchParams.get("pin");
      const quizId = url.searchParams.get("quizId");
      if ((role !== "host" && role !== "player") || !pin) return new Response("missing params", { status: 400 });
      const sessionToken = url.searchParams.get("sessionToken") ?? newId();
      const session = sessions.get(sessionToken);
      if (session && (session.role !== role || session.pin !== pin)) return new Response("invalid session", { status: 403 });
      const id = session?.id ?? newId();
      const ok = server.upgrade(req, { data: { role, id, pin, quizId: quizId ?? "", sessionToken, invalidSession: url.searchParams.has("sessionToken") && !session } });
      if (ok) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/healthz" && req.method === "GET") {
      let totalPlayers = 0;
      for (const room of rooms.values()) totalPlayers += room.players.size;
      return Response.json({
        ok: true,
        uptime: process.uptime(),
        rooms: rooms.size,
        players: totalPlayers,
        streams: activeStreams,
        memory: process.memoryUsage(),
        loopLagMs,
        answerMs: answerPerf(),
      });
    }

    if (url.pathname === "/metrics" && req.method === "GET") {
      let totalPlayers = 0;
      const roomMetrics = [];
      for (const room of rooms.values()) {
        const playerCount = room.players.size;
        totalPlayers += playerCount;
        roomMetrics.push({ pin: room.pin, phase: room.phase, players: playerCount, question: room.currentQuestionIndex });
      }
      return Response.json({
        rooms: rooms.size,
        players: totalPlayers,
        activeStreams,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        roomsDetail: roomMetrics,
      });
    }

    if (url.pathname === "/api/quizzes" && req.method === "GET") {
      return Response.json(listQuizzes());
    }

    if (url.pathname === "/api/ai/generate-quiz" && req.method === "POST") {
      const limited = rateLimited(req, server, "ai", 10, 60_000);
      if (limited) return limited;
      const body = (await readJson(req)) as { topic?: string; count?: number; difficulty?: "easy" | "medium" | "hard" } | null;
      if (!body) return Response.json({ error: "Ungültiges JSON" }, { status: 400 });
      const topic = (body.topic ?? "").trim();
      if (!topic) return Response.json({ error: "Thema fehlt" }, { status: 400 });
      const count = Math.max(3, Math.min(30, Number(body.count) || 10));
      const difficulty = (body.difficulty ?? "medium") as "easy" | "medium" | "hard";
      try {
        const quiz = await generateQuiz(topic, count, difficulty);
        return Response.json(quiz);
      } catch (e: any) {
        console.error(`[quiz] non-stream generate failed:`, e?.message ?? e);
        return Response.json({ error: e?.message ?? "Generierung fehlgeschlagen" }, { status: 502 });
      }
    }

    if (url.pathname === "/api/ai/generate-quiz-stream" && req.method === "POST") {
      const limited = rateLimited(req, server, "ai-stream", 5, 60_000);
      if (limited) return limited;
      if (activeStreams >= MAX_CONCURRENT_STREAMS) {
        return Response.json({ error: "Server busy — try again shortly." }, { status: 429, headers: { "Retry-After": "20" } });
      }
      const body = (await readJson(req)) as { topic?: string; count?: number; difficulty?: "easy" | "medium" | "hard" } | null;
      if (!body) return Response.json({ error: "Ungültiges JSON" }, { status: 400 });
      const topic = (body.topic ?? "").trim();
      if (!topic) return Response.json({ error: "Thema fehlt" }, { status: 400 });
      const count = Math.max(3, Math.min(30, Number(body.count) || 10));
      const difficulty = (body.difficulty ?? "medium") as "easy" | "medium" | "hard";
      const encoder = new TextEncoder();
      const send = (obj: unknown, controller: ReadableStreamDefaultController) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const ac = new AbortController();
      const onReqAbort = () => ac.abort();
      req.signal.addEventListener("abort", onReqAbort);
      activeStreams++;
      const stream = new ReadableStream({
        async start(controller) {
          const t0 = Date.now();
          log("info", "SSE stream started", { topic, count, difficulty });
          try {
            send({ type: "progress", received: 0, attempt: 1 }, controller);
            const quiz = await generateQuizStream(
              topic,
              count,
              difficulty,
              (text, _full, round) => {
                try { send({ type: "token", text, round }, controller); } catch { }
              },
              (received, attempt) => {
                try { send({ type: "progress", received, attempt }, controller); } catch { }
              },
              (text) => {
                try { send({ type: "reasoning", text }, controller); } catch { }
              },
              {
                signal: ac.signal,
                onRetry: (round, maxRounds, reason) => {
                  try { send({ type: "retry", round, maxRounds, reason }, controller); } catch { }
                },
                onTool: (kind, query, resultCount) => {
                  try { send({ type: "tool", kind, query, resultCount }, controller); } catch { }
                },
              },
            );
            send({ type: "done", quiz }, controller);
            log("info", "SSE stream done", { topic: quiz.title, questions: quiz.questions.length, duration: (Date.now() - t0) / 1000 });
          } catch (e: any) {
            if (ac.signal.aborted) {
              log("info", "SSE stream aborted by client", { duration: (Date.now() - t0) / 1000 });
            } else {
              log("error", "SSE stream FAILED", { error: e?.message ?? String(e), duration: (Date.now() - t0) / 1000 });
              try { send({ type: "error", error: e?.message ?? "Stream fehlgeschlagen" }, controller); } catch { }
            }
          } finally {
            activeStreams = Math.max(0, activeStreams - 1);
            req.signal.removeEventListener("abort", onReqAbort);
            controller.close();
          }
        },
        cancel() {
          ac.abort();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (url.pathname === "/api/quizzes" && req.method === "POST") {
      const limited = rateLimited(req, server, "quiz-save", 30, 60_000);
      if (limited) return limited;
      const quiz = (await readJson(req)) as Quiz | null;
      if (!quiz || !quiz.title || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
        return Response.json({ error: "invalid quiz" }, { status: 400 });
      }
      if (quiz.questions.length > 100) {
        return Response.json({ error: "too many questions (max 100)" }, { status: 400 });
      }
      const id = saveQuiz(quiz);
      return Response.json({ id });
    }

    const quizMatch = url.pathname.match(/^\/api\/quizzes\/([^\/]+)$/);
    if (quizMatch) {
      const id = quizMatch[1];
      if (req.method === "GET") {
        const q = getQuiz(id);
        return q ? Response.json(q) : new Response("not found", { status: 404 });
      }
      if (req.method === "DELETE") {
        const limited = rateLimited(req, server, "quiz-del", 30, 60_000);
        if (limited) return limited;
        deleteQuiz(id);
        return new Response(null, { status: 204 });
      }
    }

    if (url.pathname === "/api/quizzes/:id/meta" && req.method === "GET") {
      const id = url.pathname.split("/")[3];
      const meta = getQuizMeta(id);
      return meta ? Response.json(meta) : new Response("not found", { status: 404 });
    }

    if (url.pathname.startsWith("/")) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (path.includes("\0") || path.split("/").includes("..")) {
        return new Response("bad path", { status: 400 });
      }
      const file = Bun.file(`public${path}`);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = path.startsWith("/_built/")
        ? { "Cache-Control": "public, max-age=3600" }
        : { "Cache-Control": "no-cache" };
      return new Response(file, { headers });
    }

    return new Response("not found", { status: 404 });
  },

  websocket: {
    idleTimeout: 60,
    sendPings: true,
    maxPayloadLength: 256 * 1024,
    open(ws) {
      const { role, pin, id, quizId, sessionToken, invalidSession } = ws.data;
      const reject = (message: string) => {
        send(ws, { type: "error", message, terminal: true });
        ws.close(1008, "Session unavailable");
      };
      if (invalidSession) { reject("Session abgelaufen. Bitte erneut beitreten."); return; }
      let room = rooms.get(pin);
      if (!room) {
        if (role === "player") { reject("Game not found. Check your PIN."); return; }
        if (rooms.size >= MAX_ROOMS) { reject("Server voll — bitte später erneut versuchen."); return; }
        const quiz = quizId ? getQuiz(quizId) : { title: "Schnellstart", questions: [] };
        if (!quiz) { reject("Quiz not found"); return; }
        room = createRoom(quiz, pin);
        rooms.set(pin, room);
        log("info", "room created", { pin, quiz: quiz.title, questions: quiz.questions.length });
      }
      if (role === "host" && room.hostId && room.hostId !== id) {
        reject("Dieses Spiel hat bereits einen Host.");
        return;
      }
      const previous = wsById.get(id);
      sessions.set(sessionToken, { role, id, pin });
      wsById.set(id, ws);
      if (role === "player") lastSeen.set(id, Date.now());
      emptySince.delete(pin);
      if (previous && previous !== ws) previous.close(1000, "Connection replaced");
      send(ws, { type: "session", sessionToken });
      log("debug", "ws connected", { role, pin });
      if (role === "host") {
        room.hostId = id;
        pushHostSnapshot(room);
      }
    },

    message(ws, raw) {
      let evt: WSEvent;
      try {
        evt = JSON.parse(raw as string) as WSEvent;
      } catch {
        return;
      }
      // Jede Nachricht (inkl. Ping) markiert den Spieler als aktiv.
      if (ws.data.role === "player") lastSeen.set(ws.data.id, Date.now());
      void handleEvent(ws, evt).catch((e) => log("error", "event handler failed", { error: String(e) }));
    },

    close(ws) {
      const { role, pin, id, sessionToken } = ws.data;
      if (wsById.get(id) !== ws) return;
      wsById.delete(id);
      log("debug", "ws closed", { role, pin });
      const room = rooms.get(pin);
      if (!room) return;

      if (role === "player") {
        const p = room.players.get(id);
        if (p) {
          p.connected = false;
          broadcast(room, {
            type: "lobby:update",
            players: Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name })),
            snapshot: publicRoomSnapshot(room),
          });
        }
        if (!p) sessions.delete(sessionToken);
        queueHostSnapshot(room);
      }
    },
  },
});

async function handleEvent(ws: ServerWebSocket<WSData>, evt: WSEvent) {
  const { role } = ws.data;
  if (wsById.get(ws.data.id) !== ws || !evt || typeof evt !== "object") return;
  if (evt.type === "ping") { send(ws, { type: "pong" }); return; }
  if ("pin" in evt && evt.pin !== ws.data.pin) return;

  if (evt.type === "host:create-quiz") {
    const id = saveQuiz(evt.quiz);
    send(ws, { type: "quiz:saved", id });
    return Promise.resolve();
  }

  if (role !== "host") {
    if (evt.type === "player:join") { handlePlayerJoin(ws, evt); return Promise.resolve(); }
    else if (evt.type === "player:rename") { handlePlayerRename(ws, evt); return Promise.resolve(); }
    else if (evt.type === "player:answer") return handlePlayerAnswer(ws, evt);
    else if (evt.type === "player:buzz") return handlePlayerAnswer(ws, { type: "player:answer", pin: evt.pin, questionIndex: evt.questionIndex, answer: { kind: "react" } });
    return Promise.resolve();
  }

  const pin = ws.data.pin;
  const room = rooms.get(pin);
  if (room && room.hostId !== ws.data.id) return;
  if (!room) {
    send(ws, { type: "error", message: "no room" });
    return Promise.resolve();
  }

  switch (evt.type) {
    case "host:next-question": {
      if (room.phase !== "lobby" && room.phase !== "reveal" && room.phase !== "leaderboard" && room.phase !== "buzzed") return Promise.resolve();
      const next = room.currentQuestionIndex + 1;
      if (next >= room.quiz.questions.length) {
        room.phase = "finished";
        recordPlayTx(room.quiz.id ?? "", room.players.size);
        broadcast(room, {
          type: "game:finished",
          leaderboard: leaderboard(room.players, room.players.size),
        });
        pushHostSnapshot(room);
        return;
      }
      clearAutoReveal(room);
      room.currentQuestionIndex = next;
      room.phase = "question";
      room.questionStartedAt = Date.now();
      room.buzzedAt = 0;
      room.buzzedPlayerId = null;
      room.answeredCount = 0;
      const q = room.quiz.questions[next];
      room.reactionGoAt = q.type === "reaction" ? Date.now() + 1500 + Math.floor(Math.random() * 2500) : 0;
      room.memorySeq = q.type === "memory"
        ? Array.from({ length: q.memoryLength ?? 4 }, () => Math.floor(Math.random() * 4))
        : [];
      const payload = questionPayload(room, q, next);
      // Host bekommt alles (für die Anzeige), Spieler die lösungsfreie Version.
      broadcastPlayers(room, playerQuestionPayload(room, q, next));
      if (room.hostId) {
        const hostWs = wsById.get(room.hostId);
        if (hostWs) hostWs.send(JSON.stringify(payload));
      }
      pushHostSnapshot(room);
      log("debug", "question started", { pin, index: next, type: q.type, players: room.players.size });
      room.autoRevealTimer = setTimeout(() => {
        if (room.phase !== "question") return;
        autoReveal(room);
      }, q.timeLimit * 1000 + 500);
      break;
    }
    case "host:reveal": {
      if (room.phase !== "question" && room.phase !== "buzzed") return Promise.resolve();
      clearAutoReveal(room);
      log("debug", "question revealed", { pin, index: room.currentQuestionIndex });
      revealQuestion(room);
      break;
    }
    case "host:show-leaderboard": {
      if (room.phase !== "reveal" && room.phase !== "leaderboard") return;
      clearAutoReveal(room);
      room.phase = "leaderboard";
      broadcast(room, {
        type: "leaderboard:show",
        leaderboard: leaderboard(room.players, 5),
      });
      pushHostSnapshot(room);
      break;
    }
    case "host:show-results": {
      clearAutoReveal(room);
      room.phase = "finished";
      log("info", "game finished", { pin, players: room.players.size });
      broadcast(room, {
        type: "game:finished",
        leaderboard: leaderboard(room.players, room.players.size),
      });
      pushHostSnapshot(room);
      break;
    }
    case "host:end-game": {
      log("info", "game ended by host", { pin, players: room.players.size });
      broadcast(room, { type: "game:ended" });
      destroyRoom(room);
      break;
    }
    case "host:kick": {
      const p = room.players.get(evt.playerId);
      if (!p) return Promise.resolve();
      log("warn", "player kicked by host", { pin, player: p.name });
      room.players.delete(evt.playerId);
      const target = wsById.get(evt.playerId);
      if (target) {
        sessions.delete(target.data.sessionToken);
        send(target, { type: "player:kicked" });
        target.close(1000, "Removed by host");
      }
      for (const [token, session] of sessions) if (session.id === evt.playerId) sessions.delete(token);
      pendingAnswers.delete(evt.playerId);
      lastSeen.delete(evt.playerId);
      queueHostSnapshot(room);
      broadcast(room, {
        type: "lobby:update",
        players: Array.from(room.players.values()).map((pl) => ({ id: pl.id, name: pl.name })),
        snapshot: publicRoomSnapshot(room),
      });
      break;
    }
    case "host:rename": {
      // Host legt Namen fest + sperrt ihn: Der Spieler kann ihn danach
      // NICHT mehr selbst ändern (player:rename wird bei Lock abgelehnt).
      const p = room.players.get(evt.playerId);
      const next = safeName((evt as any).name ?? "");
      if (!p || !next) return Promise.resolve();
      p.name = next;
      p.nameLocked = true;
      log("info", "player renamed+locked by host", { pin, player: p.id, name: next });
      sendLobbyUpdate(room);
      queueHostSnapshot(room);
      break;
    }
  }
  return Promise.resolve();
}

const clientEntries = ["dom", "editor", "library", "host", "player"];

async function buildClient() {
  const outdir = "public/_built";
  for (const name of clientEntries) {
    const src = name === "dom" ? `public/lib/dom.ts` : `public/${name}.ts`;
    const result = await Bun.build({
      entrypoints: [src],
      target: "browser",
      outdir,
      minify: true,
    });
    if (!result.success) {
      log("error", `Build failed for ${name}`, { logs: result.logs });
    }
  }
}

const shutdown = async () => {
  log("info", "Shutting down server...");
  for (const room of rooms.values()) {
    destroyRoom(room);
  }
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

(process.env.BUILD_CLIENT === "0" ? Promise.resolve() : buildClient()).then(() => {
  log("info", `Kahoot clone running`, { port: server.port, hostname: server.hostname });
}).catch((e) => {
  log("error", "client build error", { error: String(e) });
  log("info", `Kahoot clone running`, { port: server.port, hostname: server.hostname });
});