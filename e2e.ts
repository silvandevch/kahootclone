#!/usr/bin/env bun
// End-to-end multiplayer test across all 20 question types in the seed quiz.

const PORT = process.env.PORT ?? "3000";
const HOST = `ws://127.0.0.1:${PORT}/ws`;
type Resolver = (v: any) => void;

function client(role: "host" | "player", pin: string, name?: string, quizId?: string) {
  const params = new URLSearchParams({ role, pin });
  if (quizId) params.set("quizId", quizId);
  const ws = new WebSocket(`${HOST}?${params}`);
  const inbox: any[] = [];
  const waiters: Array<{ predicate: (m: any) => boolean; resolve: Resolver }> = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  };
  ws.onopen = () => {
    if (role === "player") ws.send(JSON.stringify({ type: "player:join", pin, name: name ?? "Player" }));
  };
  function waitFor(predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const found = inbox.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for message (have ${inbox.map((m) => m.type).join(",")})`));
      }, timeoutMs);
      waiters.push({ predicate, resolve: (v) => { clearTimeout(t); resolve(v); } });
    });
  }
  function send(msg: any) { ws.send(JSON.stringify(msg)); }
  return { ws, send, waitFor, inbox };
}

async function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function answerFor(q: any, correct: boolean): any {
  switch (q.type) {
    case "quiz":
    case "true_false":
    case "dropdown":
    case "audio_clip":
    case "video_clip":
      return { kind: "choice", choice: correct ? q.correctIndex : (q.correctIndex + 1) % (q.choices?.length ?? 2) };
    case "multi_select":
    case "choose_two":
      return { kind: "multi", choices: correct ? (q.correctIndices ?? []) : [(q.correctIndices?.[0] ?? 0)] };
    case "type_answer":
    case "fill_blank":
      return { kind: "text", text: correct ? (q.acceptedAnswers?.[0] ?? "x") : "wrong" };
    case "slider":
    case "estimate":
      return { kind: "choice", choice: correct ? q.sliderCorrect : q.sliderCorrect + 50 };
    case "order":
    case "sequence":
    case "fastest_finger":
      return { kind: "order", order: correct ? (q.correctOrder ?? []) : (q.correctOrder ?? []).slice().reverse() };
    case "puzzle_drop":
      return { kind: "puzzle", slots: correct ? (q.correctOrder ?? []) : (q.correctOrder ?? []).slice().reverse() };
    case "match_pairs":
      const pairs: any = {};
      (q.pairs ?? []).forEach((p: any) => pairs[p.left] = correct ? p.right : "wrong");
      return { kind: "match", pairs };
    case "classify":
      const bins: any = {};
      (q.items ?? []).forEach((it: string) => bins[it] = correct ? q.correctBins?.[it] : (q.categories ?? [])[0]);
      return { kind: "classify", bins };
    case "poll":
      return { kind: "choice", choice: 0 };
    case "reaction":
      return { kind: "react" };
    case "brainstorm":
    case "word_cloud":
      return { kind: "words", words: ["alpha", "beta", "gamma"] };
    case "open_ended":
      return { kind: "text", text: "This is my answer with enough words to score something." };
    case "color_match":
      return { kind: "color", hex: correct ? (q.colors?.find((c: any) => c.name === q.correctName)?.hex ?? "#000000") : "#000000" };
    case "image_hotspot":
      return { kind: "hotspot", x: correct ? q.hotspotX : 0.1, y: correct ? q.hotspotY : 0.1 };
    case "memory":
      return { kind: "memory", sequence: correct ? Array.from({ length: q.memoryLength }, (_, i) => i) : Array.from({ length: q.memoryLength }, () => 0) };
    default:
      return { kind: "choice", choice: 0 };
  }
}

(async () => {
  const list = await fetch(`http://127.0.0.1:${PORT}/api/quizzes`).then((r) => r.json());
  const quizId = list[0].id;
  const quiz = await fetch(`http://127.0.0.1:${PORT}/api/quizzes/${quizId}`).then((r) => r.json());
  console.log(`Quiz: ${quiz.title} (${quiz.questions.length} questions)`);

  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  const host = client("host", pin, undefined, quizId);
  await host.waitFor((m) => m.type === "host:snapshot");
  console.log(`\u2713 host connected, PIN=${pin}`);

  const players = ["Alice", "Bob", "Cara"].map((n) => client("player", pin, n));
  await Promise.all(players.map((p) => p.waitFor((m) => m.type === "joined")));
  await delay(100);
  console.log("\u2713 3 players joined");

  let pass = 0, fail = 0;
  for (let i = 0; i < quiz.questions.length; i++) {
    const qd = quiz.questions[i];
    host.send({ type: "host:next-question", pin });
    try {
      await host.waitFor((m) => m.type === "host:snapshot" && m.room.phase === "question" && m.room.currentQuestionIndex === i, 2000);
      await Promise.all(players.map((p) => p.waitFor((m) => m.type === "question:show" && m.index === i, 2000)));
    } catch (e) {
      console.log(`\u2717 Q${i + 1} [${qd.type}] show failed: ${e.message}`);
      fail++;
      continue;
    }

    players.forEach((p, idx) => {
      const ans = answerFor(qd, idx !== 1); // Bob gets it wrong
      setTimeout(() => p.send({ type: "player:answer", pin, questionIndex: i, answer: ans }), 20 * (idx + 1));
    });

    try {
      await Promise.all(players.map((p) => p.waitFor((m) => m.type === "answer:ack", 30000)));
    } catch (e) {
      console.log(`\u2717 Q${i + 1} [${qd.type}] ack failed: ${e.message}`);
      fail++;
      continue;
    }
    await delay(150);

    host.send({ type: "host:reveal", pin });
    try {
      await Promise.all(players.map((p) => p.waitFor((m) => m.type === "question:reveal", 2000)));
      await host.waitFor((m) => m.type === "host:snapshot" && m.room.phase === "reveal", 2000);
    } catch (e) {
      console.log(`\u2717 Q${i + 1} [${qd.type}] reveal failed: ${e.message}`);
      fail++;
      continue;
    }

    host.send({ type: "host:show-leaderboard", pin });
    try {
      await Promise.all(players.map((p) => p.waitFor((m) => m.type === "leaderboard:show", 2000)));
    } catch {}
    pass++;
    process.stdout.write(`\u2713 Q${i + 1} [${qd.type}]  `);
    if (i % 4 === 3) console.log("");
  }

  console.log(`\n\n${pass}/${quiz.questions.length} questions passed`);
  if (fail > 0) { console.log(`${fail} FAILED`); process.exit(1); }

  host.send({ type: "host:show-results", pin });
  const final = await players[0].waitFor((m) => m.type === "game:finished");
  console.log(`\nFinal: ${final.leaderboard.map((r: any) => `${r.name}=${r.score}`).join(", ")}`);
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});