import type { Player, PlayerAnswer, Question, Quiz, RoomState } from "./types";

export function makePin(): string {
  let pin = "";
  for (let i = 0; i < 6; i++) pin += Math.floor(Math.random() * 10);
  return pin;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function createRoom(quiz: Quiz, pin: string): RoomState {
  return {
    pin,
    quiz,
    hostId: null,
    phase: "lobby",
    currentQuestionIndex: -1,
    questionStartedAt: 0,
    buzzedAt: 0,
    buzzedPlayerId: null,
    autoRevealTimer: null,
    players: new Map(),
    reactionGoAt: 0,
    memorySeq: [],
    answeredCount: 0,
  };
}

export function choicesForQuestion(q: Question): string[] {
  return q.choices ?? q.items ?? [];
}

export type ScoreResult = { delta: number; correct: boolean; newStreak: number };

function zero(): ScoreResult {
  return { delta: 0, correct: false, newStreak: 0 };
}

export function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function scoreAnswer(
  question: Question,
  answer: PlayerAnswer,
  timeMs: number,
  currentScore: number,
  streak: number,
  memorySeq?: number[]
): ScoreResult {
  const base = question.points;
  const timeLimitMs = question.timeLimit * 1000;
  const speedRatio = Math.max(0, 1 - timeMs / timeLimitMs);
  const streakBonus = (s: number) => Math.floor(base * 0.25 * Math.min(s, 5));
  const fullDelta = Math.round(base * (0.5 + 0.5 * speedRatio));

  switch (question.type) {
    case "poll":
      return { delta: 0, correct: true, newStreak: streak };

    case "word_cloud":
      return { delta: Math.round(base * 0.1 * speedRatio), correct: false, newStreak: 0 };

    case "open_ended":
      if (answer.kind !== "text") return zero();
      const len = answer.text.trim().length;
      if (len < 3) return zero();
      return { delta: Math.round(base * Math.min(1, len / 60) * (0.5 + 0.5 * speedRatio)), correct: len > 10, newStreak: 0 };

    case "brainstorm": {
      if (answer.kind !== "words") return zero();
      const words = answer.words.filter((w) => w.length >= 2);
      const unique = new Set(words.map(normalizeText));
      const pts = Math.round(base * 0.15 * Math.min(unique.size, 6) * (0.5 + 0.5 * speedRatio));
      return { delta: pts, correct: unique.size >= 3, newStreak: 0 };
    }

    case "quiz":
    case "true_false":
    case "dropdown":
    case "audio_clip":
    case "video_clip": {
      if (answer.kind !== "choice") return zero();
      if (answer.choice === question.correctIndex) {
        return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
      }
      return zero();
    }

    case "multi_select":
    case "choose_two": {
      if (answer.kind !== "multi") return zero();
      const correct = new Set(question.correctIndices ?? []);
      const got = new Set(answer.choices);
      if (got.size !== correct.size) return zero();
      for (const c of correct) if (!got.has(c)) return zero();
      return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
    }

    case "type_answer":
    case "fill_blank": {
      if (answer.kind !== "text") return zero();
      const accepted = (question.acceptedAnswers ?? []).map(normalizeText);
      if (accepted.length === 0) return zero();
      if (accepted.includes(normalizeText(answer.text))) {
        return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
      }
      return zero();
    }

    case "color_match": {
      if (answer.kind !== "color") return zero();
      const correct = (question.colors ?? []).find((c) => normalizeText(c.name) === normalizeText(question.correctName ?? ""));
      if (!correct) return zero();
      if (normalizeText(answer.hex) === normalizeText(correct.hex)) {
        return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
      }
      return zero();
    }

    case "slider":
    case "estimate": {
      if (answer.kind !== "choice") return zero();
      const guess = Number(answer.choice);
      const target = question.sliderCorrect ?? 0;
      const tol = Math.max(question.sliderTolerance ?? 1, 0.0001);
      const range = Math.max((question.sliderMax ?? 100) - (question.sliderMin ?? 0), 1);
      const distance = Math.abs(guess - target);
      if (distance <= tol) {
        return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
      }
      const proximity = Math.max(0, 1 - distance / range);
      return { delta: Math.round(base * 0.5 * proximity * (0.5 + 0.5 * speedRatio)), correct: false, newStreak: 0 };
    }

    case "order":
    case "sequence":
    case "fastest_finger":
    case "puzzle_drop": {
      const ord = answer.kind === "order" ? answer.order : answer.kind === "puzzle" ? answer.slots : null;
      if (!ord) return zero();
      const correct = question.correctOrder ?? [];
      if (ord.length !== correct.length) return zero();
      for (let i = 0; i < correct.length; i++) if (ord[i] !== correct[i]) return zero();
      return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
    }

    case "match_pairs": {
      if (answer.kind !== "match") return zero();
      const pairs = question.pairs ?? [];
      if (pairs.length === 0) return zero();
      let matches = 0;
      for (const p of pairs) {
        if (answer.pairs[p.left] === p.right) matches++;
      }
      const perfect = matches === pairs.length;
      return {
        delta: Math.round(fullDelta * (matches / pairs.length)) + (perfect ? streakBonus(streak) : 0),
        correct: perfect,
        newStreak: perfect ? streak + 1 : 0,
      };
    }

    case "classify": {
      if (answer.kind !== "classify") return zero();
      const items: string[] = (question as any).items ?? [];
      const cats = question.categories ?? [];
      if (items.length === 0 || cats.length === 0) return zero();
      const correctMap: Record<string, string> = (question as any).correctBins ?? {};
      let matches = 0;
      for (const it of items) {
        if (correctMap[it] && answer.bins[it] === correctMap[it]) matches++;
      }
      const perfect = matches === items.length;
      return {
        delta: Math.round(fullDelta * (matches / Math.max(1, items.length))) + (perfect ? streakBonus(streak) : 0),
        correct: perfect,
        newStreak: perfect ? streak + 1 : 0,
      };
    }

    case "image_hotspot": {
      if (answer.kind !== "hotspot") return zero();
      const cx = question.hotspotX ?? 0.5;
      const cy = question.hotspotY ?? 0.5;
      const r = question.hotspotRadius ?? 0.1;
      const dx = answer.x - cx;
      const dy = answer.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= r) {
        return { delta: fullDelta + streakBonus(streak), correct: true, newStreak: streak + 1 };
      }
      const proximity = Math.max(0, 1 - dist / 0.5);
      return { delta: Math.round(base * 0.5 * proximity * (0.5 + 0.5 * speedRatio)), correct: false, newStreak: 0 };
    }

    case "memory": {
      if (answer.kind !== "memory") return zero();
      const expected = memorySeq && memorySeq.length > 0
        ? memorySeq
        : Array.from({ length: question.memoryLength ?? 0 }, (_, i) => i);
      const correct = expected.length;
      let matches = 0;
      for (let i = 0; i < Math.min(answer.sequence.length, correct); i++) {
        if (answer.sequence[i] === expected[i]) matches++;
      }
      const perfect = matches === correct;
      return {
        delta: Math.round(fullDelta * (matches / Math.max(1, correct))) + (perfect ? streakBonus(streak) : 0),
        correct: perfect,
        newStreak: perfect ? streak + 1 : 0,
      };
    }

    case "reaction": {
      if (answer.kind !== "react") return zero();
      const elapsed = timeMs;
      const ratio = Math.max(0, 1 - elapsed / Math.min(2000, timeLimitMs));
      return { delta: Math.round(base * (0.5 + 0.5 * ratio)) + streakBonus(streak), correct: true, newStreak: streak + 1 };
    }
  }
}

export interface AggregatedStats {
  choiceCounts: number[];
  textAnswers: Array<{ name: string; text: string; correct: boolean }>;
  sliderValues: number[];
  words: Record<string, number>;
  orders: number[][];
  matches: Array<{ name: string; pairs: Record<string, string> }>;
  bins: Array<{ name: string; bins: Record<string, string> }>;
  hotspots: Array<{ name: string; x: number; y: number }>;
  answers: Array<{ id: string; name: string; answer: PlayerAnswer; correct: boolean; delta: number; timeMs: number }>;
}

export function aggregateStats(room: RoomState, questionIndex: number): AggregatedStats {
  const q = room.quiz.questions[questionIndex];
  const choiceCounts = new Array(8).fill(0);
  const textAnswers: Array<{ name: string; text: string; correct: boolean }> = [];
  const sliderValues: number[] = [];
  const words: Record<string, number> = {};
  const orders: number[][] = [];
  const matches: Array<{ name: string; pairs: Record<string, string> }> = [];
  const bins: Array<{ name: string; bins: Record<string, string> }> = [];
  const hotspots: Array<{ name: string; x: number; y: number }> = [];
  const answers: Array<{ id: string; name: string; answer: PlayerAnswer; correct: boolean; delta: number; timeMs: number }> = [];

  for (const p of room.players.values()) {
    const a = p.lastAnswer;
    if (!a || a.questionIndex !== questionIndex) continue;
    const ans = a.answer;
    answers.push({ id: p.id, name: p.name, answer: ans, correct: a.correct ?? false, delta: a.delta ?? 0, timeMs: a.timeMs });

    switch (ans.kind) {
      case "choice": {
        const idx = ans.choice;
        if (idx >= 0 && idx < choiceCounts.length) choiceCounts[idx]++;
        if (q.type === "slider" || q.type === "estimate") sliderValues.push(Number(ans.choice));
        break;
      }
      case "multi": {
        for (const c of ans.choices) {
          if (c >= 0 && c < choiceCounts.length) choiceCounts[c]++;
        }
        break;
      }
      case "text": {
        textAnswers.push({ name: p.name, text: ans.text, correct: a.correct ?? false });
        break;
      }
      case "words": {
        for (const w of ans.words) {
          const n = normalizeText(w);
          words[n] = (words[n] ?? 0) + 1;
        }
        break;
      }
      case "order":
      case "puzzle": {
        orders.push(ans.kind === "order" ? ans.order : ans.slots);
        break;
      }
      case "match": {
        matches.push({ name: p.name, pairs: ans.pairs });
        break;
      }
      case "classify": {
        bins.push({ name: p.name, bins: ans.bins });
        break;
      }
      case "hotspot": {
        hotspots.push({ name: p.name, x: ans.x, y: ans.y });
        break;
      }
      case "color":
      case "memory":
      case "react": {
        textAnswers.push({ name: p.name, text: ans.kind === "color" ? ans.hex : ans.kind === "memory" ? ans.sequence.join("-") : "buzz", correct: a.correct ?? false });
        break;
      }
    }
  }

  return { choiceCounts, textAnswers, sliderValues, words, orders, matches, bins, hotspots, answers };
}

// Schlanke Variante für den Live-Zähler während der Frage: nur choice-Verteilung,
// keine Payload-Arrays (O(Antworten) statt O(Spieler × Payload)).
export function choiceCounts(room: RoomState, questionIndex: number): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of room.players.values()) {
    const a = p.lastAnswer;
    if (!a || a.questionIndex !== questionIndex) continue;
    const ans = a.answer;
    if (ans.kind === "choice" && ans.choice < counts.length && ans.choice >= 0) {
      counts[ans.choice] += 1;
    } else if (ans.kind === "multi") {
      for (const c of ans.choices) {
        if (c < counts.length && c >= 0) counts[c] += 1;
      }
    }
  }
  return counts;
}

export function leaderboard(players: Map<string, Player>, limit = 5): Array<{ rank: number; id: string; name: string; score: number }> {
  const arr = Array.from(players.values());
  arr.sort((a, b) => b.score - a.score);
  const out = new Array(Math.min(limit, arr.length));
  for (let i = 0; i < out.length; i++) {
    out[i] = { rank: i + 1, id: arr[i].id, name: arr[i].name, score: arr[i].score };
  }
  return out;
}

// Mischt Paare für Spieler: linke Seite bleibt, rechte wird permutiert.
// Der Client sieht so nie die korrekte Zuordnung (kein Devtools-Cheat),
// antworten kann er trotzdem (Server prüft gegen das Original).
export function shuffledPairs(pairs: Array<{ left: string; right: string }>): Array<{ left: string; right: string }> {
  const rights = pairs.map((p) => p.right);
  for (let i = rights.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rights[i], rights[j]] = [rights[j], rights[i]];
  }
  return pairs.map((p, i) => ({ left: p.left, right: rights[i] }));
}

// Top-N ohne Vollsortierung: O(P) statt O(P log P) — für Snapshots, die bei
// jeder Antwort rausgehen.
export function topPlayers(players: Map<string, Player>, limit = 5): Array<{ rank: number; id: string; name: string; score: number }> {
  const top: Player[] = [];
  for (const p of players.values()) {
    if (top.length < limit) {
      top.push(p);
      continue;
    }
    let minIdx = 0;
    for (let i = 1; i < top.length; i++) {
      if (top[i].score < top[minIdx].score) minIdx = i;
    }
    if (p.score > top[minIdx].score) top[minIdx] = p;
  }
  top.sort((a, b) => b.score - a.score);
  return top.map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));
}

export function publicRoomSnapshot(room: RoomState) {
  return {
    pin: room.pin,
    phase: room.phase,
    quiz: { id: room.quiz.id, title: room.quiz.title, coverColor: room.quiz.coverColor },
    currentQuestionIndex: room.currentQuestionIndex,
    questionStartedAt: room.questionStartedAt,
    playerCount: room.players.size,
  };
}

export function safeName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 18);
  return cleaned.length > 0 ? cleaned : "Player";
}

// Begrenzt Spieler-Antworten auf sinnvolle Größen, bevor sie gespeichert,
// gebroadcastet oder aggregiert werden (Schutz vor Riesen-Payloads).
export function clampAnswer(a: PlayerAnswer): PlayerAnswer {
  switch (a.kind) {
    case "choice":
      return { kind: "choice", choice: Number.isFinite(a.choice) ? Math.trunc(a.choice) : -1 };
    case "multi":
      return { kind: "multi", choices: (Array.isArray(a.choices) ? a.choices : []).slice(0, 16).filter(Number.isInteger) };
    case "text":
      return { kind: "text", text: typeof a.text === "string" ? a.text.slice(0, 2000) : "" };
    case "words":
      return {
        kind: "words",
        words: (Array.isArray(a.words) ? a.words : []).slice(0, 200).filter((w) => typeof w === "string").map((w) => (w as string).slice(0, 100)),
      };
    case "order":
      return { kind: "order", order: (Array.isArray(a.order) ? a.order : []).slice(0, 64).filter(Number.isInteger) };
    case "puzzle":
      return { kind: "puzzle", slots: (Array.isArray(a.slots) ? a.slots : []).slice(0, 64).filter(Number.isInteger) };
    case "memory":
      return { kind: "memory", sequence: (Array.isArray(a.sequence) ? a.sequence : []).slice(0, 32).filter(Number.isInteger) };
    case "match": {
      const pairs: Record<string, string> = {};
      if (a.pairs && typeof a.pairs === "object") {
        for (const [k, v] of Object.entries(a.pairs).slice(0, 64)) {
          if (typeof k === "string" && typeof v === "string") pairs[k.slice(0, 200)] = v.slice(0, 200);
        }
      }
      return { kind: "match", pairs };
    }
    case "classify": {
      const bins: Record<string, string> = {};
      if (a.bins && typeof a.bins === "object") {
        for (const [k, v] of Object.entries(a.bins).slice(0, 64)) {
          if (typeof k === "string" && typeof v === "string") bins[k.slice(0, 200)] = v.slice(0, 200);
        }
      }
      return { kind: "classify", bins };
    }
    case "hotspot":
      return {
        kind: "hotspot",
        x: Number.isFinite(a.x) ? a.x : 0,
        y: Number.isFinite(a.y) ? a.y : 0,
      };
    case "color":
      return { kind: "color", hex: typeof a.hex === "string" ? a.hex.slice(0, 32) : "" };
    case "react":
      return { kind: "react" };
  }
}

export function clearAutoReveal(room: RoomState) {
  if (room.autoRevealTimer) {
    clearTimeout(room.autoRevealTimer);
    room.autoRevealTimer = null;
  }
}