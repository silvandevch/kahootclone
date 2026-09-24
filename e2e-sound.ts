import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const server = Bun.spawn([process.execPath, `${import.meta.dir}/index.ts`], {
  cwd: `${import.meta.dir}/..`,
  env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: ":memory:" },
  stdout: "pipe",
  stderr: "pipe",
});
let browser: any;
let step = "Start isolated server";
const errors: string[] = [];
const timeout = setTimeout(() => {
  console.error(`TIMEOUT: ${step}`);
  server.kill();
  process.exit(1);
}, 120_000);

const CUES: Record<string, number[]> = {
  question: [261.63, 392, 523.25],
  submit: [659.25, 880],
  correct: [523.25, 659.25, 783.99, 1046.5],
  wrong: [293.66, 220, 196],
  reveal: [392, 523.25, 659.25],
  podium: [392, 523.25, 659.25, 783.99, 659.25, 1046.5],
};

async function cueSeen(page: any, cue: string) {
  return page.evaluate((freqs: number[]) => {
    const log = (window.__soundLog ?? []).map((e: any) => e.f).filter((v: any) => typeof v === "number");
    for (let i = 0; i + freqs.length <= log.length; i++) {
      let ok = true;
      for (let j = 0; j < freqs.length; j++) if (log[i + j] !== freqs[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }, CUES[cue]);
}

try {
  const reader = server.stdout.getReader();
  let output = "";
  let port: string | undefined;
  while (!port) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Server exited during startup");
    output += new TextDecoder().decode(value);
    port = output.match(/localhost:(\d+)/)?.[1];
  }
  reader.releaseLock();
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    (window as any).__soundLog = [];
    const Orig = (window as any).AudioContext;
    if (!Orig) return;
    class Patched extends Orig {
      constructor(...args: any[]) {
        super(...args);
        (window as any).__soundLog.push({ ctx: this.state });
      }
      resume() {
        return super.resume().then(() => { (window as any).__soundLog.push({ ctx: this.state }); return undefined; });
      }
      createOscillator() {
        const osc = super.createOscillator();
        const freq = osc.frequency;
        const original = freq.setValueAtTime.bind(freq);
        freq.setValueAtTime = (v: number, t: number) => { (window as any).__soundLog.push({ f: v }); return original(v, t); };
        return osc;
      }
    }
    (window as any).AudioContext = Patched;
  });
  context.on("page", (page: any) => {
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("dialog", (dialog: any) => dialog.accept());
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const quiz = {
    title: "Soundtest",
    questions: [{ id: "q1", type: "quiz", text: "Was klingt richtig?", choices: ["A", "B", "C", "D"], correctIndex: 0, points: 1000, timeLimit: 30 }],
  };
  const response = await context.request.post(`${base}/api/quizzes`, { data: quiz });
  const { id } = await response.json();

  step = "Host opens lobby";
  const host = await context.newPage();
  await host.goto(`${base}/host.html?quiz=${id}`);
  await host.locator(".pin").waitFor();
  const pin = (await host.locator(".pin").innerText()).trim();

  step = "Players join with sound enabled";
  const players: any[] = [];
  for (const name of ["Alina", "Ben"]) {
    const player = await context.newPage();
    await player.goto(`${base}/join.html?pin=${pin}&name=${name}`);
    const toggle = player.getByRole("button", { name: "Sound einschalten", exact: true });
    await toggle.waitFor();
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true", "Toggle must enable sound");
    await player.getByText(`Hallo ${name}!`, { exact: true }).waitFor();
    players.push(player);
  }
  await host.getByRole("button", { name: /Spiel starten|Start game/ }).click();
  for (const screen of [host, ...players]) {
    await screen.locator(".timer-bar").first().waitFor();
  }

  step = "question cue plays on host and players";
  for (const screen of [host, ...players]) {
    assert(await cueSeen(screen, "question"), "question cue frequencies not found");
  }
  const ctxStates = await host.evaluate(() => (window.__soundLog ?? []).map((e: any) => e.ctx));
  assert(ctxStates.includes("running"), `AudioContext never reached running state: ${JSON.stringify(ctxStates)}`);

  step = "submit cue on answer";
  await players[0].locator(".player-choice").first().click();
  await players[1].locator(".player-choice").nth(1).click();
  for (const player of players) {
    assert(await cueSeen(player, "submit"), "submit cue not played after answering");
  }

  step = "reveal cues: correct and wrong";
  await host.getByRole("button", { name: "Antwort aufdecken", exact: true }).click();
  await players[0].locator(".result-banner.win").waitFor();
  await players[1].locator(".result-banner.lose").waitFor();
  assert(await cueSeen(players[0], "correct"), "correct cue not played");
  assert(await cueSeen(players[1], "wrong"), "wrong cue not played");

  step = "podium cue on finish";
  await host.getByRole("button", { name: "Endergebnis zeigen", exact: true }).click();
  await host.locator(".podium").waitFor();
  for (const player of players) {
    await player.locator(".podium").waitFor();
    assert(await cueSeen(player, "podium"), "podium cue not played on player");
  }
  assert(await cueSeen(host, "podium"), "podium cue not played on host");

  step = "mute toggle stops sound";
  const toggle = players[0].getByRole("button", { name: "Sound ausschalten", exact: true });
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  assert.equal(await players[0].evaluate(() => localStorage.getItem("kc:sound:player")), "off");

  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log("PASS: sound cues fire through a full game (question, submit, correct, wrong, podium), AudioContext runs, mute persists");
} catch (error) {
  console.error(`FAIL: ${step}`, error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await browser?.close();
  server.kill();
  await server.exited;
  const stderr = await new Response(server.stderr).text();
  if (stderr.trim()) console.error(stderr);
}
