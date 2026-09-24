const PORT = 19499;
const server = Bun.spawn([process.execPath, `${import.meta.dir}/index.ts`], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), DATABASE_PATH: ":memory:", BUILD_CLIENT: "0" },
  stdout: "pipe", stderr: "pipe",
});
let sockets: WebSocket[] = [];
const log: string[] = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/quizzes`); ready = true; break; } catch { await Bun.sleep(25); } }
  if (!ready) throw new Error("server not ready");
  const res = await fetch(`http://127.0.0.1:${PORT}/api/quizzes`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Cue seq", questions: [{ id: "q1", type: "quiz", text: "T?", choices: ["A", "B"], correctIndex: 0, timeLimit: 30, points: 1000 }] }),
  });
  const { id } = await res.json();
  function client(role: "host" | "player", token?: string, name?: string) {
    const params = new URLSearchParams({ role, pin: "246810" });
    if (role === "host" && id) params.set("quizId", id);
    if (token) params.set("sessionToken", token);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${params}`);
    sockets.push(ws);
    const inbox: any[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      inbox.push(m);
      log.push(`${role}: ${m.type}${m.index !== undefined ? ` idx=${m.index}` : ""}${m.answered !== undefined ? ` answered=${m.answered}` : ""}${m.questionType ? ` type=${m.questionType}` : ""}${m.correct !== undefined ? ` correct=${m.correct}` : ""}`);
    };
    ws.onopen = () => { if (role === "player") ws.send(JSON.stringify({ type: "player:join", pin: "246810", name })); };
    return { ws, inbox };
  }
  const host = client("host", undefined, undefined);
  await Bun.sleep(200);
  const p1 = client("player", undefined, "A");
  const p2 = client("player", undefined, "B");
  await Bun.sleep(200);
  host.ws.send(JSON.stringify({ type: "host:next-question", pin: "246810" }));
  await Bun.sleep(200);
  p1.ws.send(JSON.stringify({ type: "player:answer", pin: "246810", questionIndex: 0, answer: { kind: "choice", choice: 0 } }));
  p2.ws.send(JSON.stringify({ type: "player:answer", pin: "246810", questionIndex: 0, answer: { kind: "choice", choice: 1 } }));
  await Bun.sleep(200);
  host.ws.send(JSON.stringify({ type: "host:show-leaderboard", pin: "246810" }));
  await Bun.sleep(200);
  host.ws.send(JSON.stringify({ type: "host:show-results", pin: "246810" }));
  await Bun.sleep(300);
  console.log("=== message sequence per role ===");
  for (const line of log) console.log(line);
  console.log("\n=== cue mapping check ===");
  const playerMsgs = log.filter((l) => l.startsWith("player:")).map((l) => l.split(": ")[1].split(" ")[0]);
  console.log("player saw:", playerMsgs.join(" → "));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  server.kill();
  await server.exited;
  const stderr = await new Response(server.stderr).text();
  if (stderr.trim()) console.error(stderr);
}
