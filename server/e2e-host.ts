#!/usr/bin/env bun
import assert from "node:assert/strict";

const base = "http://127.0.0.1:19483";
const pin = "123456";
const sockets: WebSocket[] = [];
const server = Bun.spawn([process.execPath, `${import.meta.dir}/index.ts`], {
  cwd: `${import.meta.dir}/..`,
  env: { ...process.env, HOST: "127.0.0.1", PORT: "19483", DATABASE_PATH: ":memory:", BUILD_CLIENT: "0" },
  stdout: "pipe",
  stderr: "pipe",
});

function client(role: "host" | "player", quizId: string, sessionToken?: string) {
  const params = new URLSearchParams({ role, pin, quizId });
  if (sessionToken) params.set("sessionToken", sessionToken);
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?${params}`);
  sockets.push(ws);
  const inbox: any[] = [];
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  ws.onopen = () => {
    if (role === "player") ws.send(JSON.stringify({ type: "player:join", pin, name: "Player" }));
  };
  async function wait(predicate: (message: any) => boolean, after = 0, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = inbox.slice(after).find(predicate);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error(`Timed out: ${role}; messages: ${inbox.slice(after).map((m) => m.type).join(", ")}`);
  }
  return { ws, inbox, wait, send: (type: string, data: object = {}) => ws.send(JSON.stringify({ type, pin, ...data })) };
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("Test server exited before startup");
    try {
      await fetch(`${base}/api/quizzes`);
      ready = true;
      break;
    } catch { await Bun.sleep(20); }
  }
  assert(ready, "Local server ready");
  const response = await fetch(`${base}/api/quizzes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Reconnect regression", questions: [0, 1].map((i) => ({
      id: `q${i}`, type: "quiz", text: `Question ${i}`, timeLimit: 30,
      points: 1000, choices: ["A", "B"], correctIndex: 0,
    })) }),
  });
  const { id } = await response.json() as { id: string };
  let host = client("host", id);
  await host.wait((m) => m.type === "host:snapshot");
  const hostToken = (await host.wait((m) => m.type === "session")).sessionToken;
  const players = Array.from({ length: 20 }, () => client("player", id));
  const joined = await Promise.all(players.map((p) => p.wait((m) => m.type === "joined")));
  const playerToken = (await players[0].wait((m) => m.type === "session")).sessionToken;
  host.send("host:next-question");
  await Promise.all(players.map((p) => p.wait((m) => m.type === "question:show" && m.index === 0)));
  host.ws.close();
  await Bun.sleep(100);
  players[0].send("player:answer", { questionIndex: 0, answer: { kind: "choice", choice: 0 } });
  const ack = await players[0].wait((m) => m.type === "answer:ack");
  assert(ack.score > 0, "Room accepts answers with disconnected host");
  console.log("PASS: host disconnect mid-question retains room");
  host = client("host", id, hostToken);
  const restored = (await host.wait((m) => m.type === "host:snapshot")).room;
  assert.equal(restored.phase, "question");
  assert.equal(restored.currentQuestionIndex, 0);
  assert.equal(restored.players.length, 20);
  assert.equal(restored.quiz.questions.length, 2);
  const playerState = restored.players.find((p: any) => p.id === joined[0].playerId);
  assert.equal(playerState.score, ack.score);
  players[0].ws.close();
  await Bun.sleep(100);
  players[0] = client("player", id, playerToken);
  assert.equal((await players[0].wait((m) => m.type === "joined")).playerId, joined[0].playerId);
  const question = await players[0].wait((m) => m.type === "question:show");
  assert.equal(question.index, 0);
  assert.equal(question.answered, true);
  const restoredAck = await players[0].wait((m) => m.type === "answer:ack");
  assert.equal(restoredAck.score, ack.score);
  assert.equal(restoredAck.questionIndex, 0);
  assert.equal(ack.questionIndex, 0);
  assert.equal(restoredAck.correct, ack.correct);
  assert.equal(restoredAck.delta, ack.delta);
  console.log("PASS: player reconnect restores identity, question, answer lock and score");
  const cursor = host.inbox.length;
  host.send("host:reveal");
  await host.wait((m) => m.type === "host:snapshot" && m.room.phase === "reveal", cursor);
  await Promise.all(players.map((p) => p.wait((m) => m.type === "question:reveal" && m.index === 0)));
  host.send("host:next-question");
  await host.wait((m) => m.type === "host:snapshot" && m.room.currentQuestionIndex === 1 && m.room.phase === "question");
  await Promise.all(players.map((p) => p.wait((m) => m.type === "question:show" && m.index === 1)));
  console.log("PASS: reconnecting host receives full snapshot and continues all 20 players");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  server.kill();
  await server.exited;
  const errors = await new Response(server.stderr).text();
  if (errors.trim()) console.error(errors);
}
