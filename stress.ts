// Stress test: simulates a classroom game (1 host + N players) plus HTTP load.
// Run: bun server/stress.ts [url] [players]   (server must be running)
// No AI calls are made (would cost money) — pure game + HTTP paths.
const BASE = process.argv[2] ?? "http://localhost:9283";
const WS_BASE = BASE.replace(/^http/, "ws");
const NPLAYERS = Number(process.argv[3] ?? 150);
const NQUESTIONS = 5;

const stats = {
  joinMs: [] as number[],
  ackMs: [] as number[],
  revealLagMs: [] as number[],
  errors: 0,
};

function summarize(name: string, arr: number[]) {
  if (arr.length === 0) return `${name}: no samples`;
  const s = [...arr].sort((x, y) => x - y);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `${name}: n=${s.length} min=${s[0].toFixed(0)}ms p50=${q(0.5).toFixed(0)}ms p99=${q(0.99).toFixed(0)}ms max=${s[s.length - 1].toFixed(0)}ms`;
}

class Conn {
  ws!: WebSocket;
  inbox: any[] = [];
  waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void; rej: (e: any) => void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(private label: string) {}
  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), 15000);
      this.ws = new WebSocket(url);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => {};
      this.ws.onclose = () => {
        for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.rej(new Error(`${this.label}: closed while waiting`)); }
      };
      this.ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        this.inbox.push(m);
        if (this.inbox.length > 50) this.inbox.shift();
        for (let i = 0; i < this.waiters.length; i++) {
          const w = this.waiters[i];
          let ok = false;
          try { ok = w.pred(m); } catch { ok = false; }
          if (ok) { this.waiters.splice(i, 1); clearTimeout(w.timer); w.res(m); return; }
        }
      };
    });
  }
  waitFor(pred: (m: any) => boolean, timeoutMs = 30000): Promise<any> {
    // Inbox zuerst (consume-on-match, damit alte Nachrichten nicht wieder matchen)
    for (let i = 0; i < this.inbox.length; i++) {
      let ok = false;
      try { ok = pred(this.inbox[i]); } catch { ok = false; }
      if (ok) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.res === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`${this.label}: waitFor timeout`));
      }, timeoutMs);
      this.waiters.push({ pred, res: resolve, rej: reject, timer });
    });
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch { } }
}

function makeQuiz() {
  return {
    title: "Stress-Quiz",
    description: "load test",
    questions: Array.from({ length: NQUESTIONS }, (_, i) => ({
      id: crypto.randomUUID(),
      type: "quiz",
      text: `Frage ${i + 1}`,
      timeLimit: 5,
      points: 1000,
      choices: ["A", "B", "C", "D"],
      correctIndex: 0,
    })),
  };
}

const t00 = Date.now();
// 1) HTTP load: 200 concurrent quiz listings
{
  const t = Date.now();
  const reqs = Array.from({ length: 200 }, () => fetch(`${BASE}/api/quizzes`).then((r) => { if (!r.ok) throw new Error(`GET ${r.status}`); return r.json(); }));
  await Promise.all(reqs);
  console.log(`HTTP: 200x GET /api/quizzes in ${Date.now() - t}ms`);
}
// 2) Save one quiz for the game
const saveRes = await fetch(`${BASE}/api/quizzes`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(makeQuiz()),
});
if (!saveRes.ok) throw new Error(`quiz save failed: ${saveRes.status}`);
const { id: quizId } = await saveRes.json();
console.log(`HTTP: quiz saved (${quizId})`);

// 3) Host connects (creates room)
const pin = String(Math.floor(100000 + Math.random() * 900000));
const host = new Conn("host");
await host.connect(`${WS_BASE}/ws?role=host&pin=${pin}&quizId=${quizId}`);
await host.waitFor((m) => m.type === "session");
console.log(`WS: host connected, room pin=${pin}`);

// 4) N players join (staggered slightly to avoid SYN flood artifacts)
const players: Conn[] = [];
{
  const t = Date.now();
  const batch = 25;
  for (let i = 0; i < NPLAYERS; i += batch) {
    const slice = await Promise.all(Array.from({ length: Math.min(batch, NPLAYERS - i) }, async (_, k) => {
      const idx = i + k;
      const c = new Conn(`p${idx}`);
      const t0 = Date.now();
      await c.connect(`${WS_BASE}/ws?role=player&pin=${pin}`);
      c.send({ type: "player:join", pin, name: `Bot${idx}` });
      await c.waitFor((m) => m.type === "joined");
      stats.joinMs.push(Date.now() - t0);
      return c;
    }));
    players.push(...slice);
  }
  console.log(`WS: ${players.length} players joined in ${Date.now() - t}ms`);
}

// 5) Play all questions: host advances, everyone answers instantly
for (let qi = 0; qi < NQUESTIONS; qi++) {
  host.send({ type: "host:next-question", pin });
  await host.waitFor((m) => m.type === "question:show" && m.index === qi);
  // All players answer at once (thundering herd — the hot path)
  const tSend = Date.now();
  await Promise.all(players.map(async (c) => {
    const t0 = Date.now();
    c.send({ type: "player:answer", pin, questionIndex: qi, answer: { kind: "choice", choice: 0 } });
    await c.waitFor((m) => m.type === "answer:ack" && m.questionIndex === qi);
    stats.ackMs.push(Date.now() - t0);
  }));
  const lastAnswerAt = Date.now();
  await host.waitFor((m) => m.type === "question:reveal" && m.index === qi);
  stats.revealLagMs.push(Date.now() - lastAnswerAt);
  host.send({ type: "host:show-leaderboard", pin });
  await host.waitFor((m) => m.type === "leaderboard:show");
  console.log(`Q${qi + 1}/${NQUESTIONS} done (answers sent in ${lastAnswerAt - tSend}ms)`);
}
host.send({ type: "host:show-results", pin });
await host.waitFor((m) => m.type === "game:finished", 30000).catch(() => { stats.errors++; console.log("WARN: no game:finished"); });

// 6) Cleanup
for (const c of players) c.close();
host.close();
await fetch(`${BASE}/api/quizzes/${quizId}`, { method: "DELETE" });

console.log("\n=== STRESS RESULTS ===");
console.log(`players=${NPLAYERS} questions=${NQUESTIONS} total=${((Date.now() - t00) / 1000).toFixed(1)}s errors=${stats.errors}`);
console.log(summarize("join latency      ", stats.joinMs));
console.log(summarize("answer ack latency", stats.ackMs));
console.log(summarize("reveal lag (last answer -> reveal)", stats.revealLagMs));
console.log(`throughput: ${((NPLAYERS * NQUESTIONS) / ((Date.now() - t00) / 1000)).toFixed(0)} answers/s overall`);
process.exit(stats.errors > 0 ? 1 : 0);
