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

async function fit(page: any, label: string) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    offenders: Array.from(document.querySelectorAll("main, .app, .quiz-card, .question-editor, .podium, .result-banner")).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.right > innerWidth + 1 || rect.left < -1;
    }).map((node) => node.className),
  }));
  assert(size.width <= size.viewport + 1, `${label}: horizontal overflow ${JSON.stringify(size)}`);
  assert.deepEqual(size.offenders, [], `${label}: clipped content`);
}

async function touchTarget(locator: any, label: string) {
  const box = await locator.boundingBox();
  assert(box && box.height >= 44 && box.width >= 44, `${label}: target must be at least 44px`);
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
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  context.on("page", (page: any) => {
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("dialog", (dialog: any) => dialog.accept());
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const quiz = {
    title: "Akzeptanztest mit einem langen Quiztitel für kleine Bildschirme",
    description: "Eine Beschreibung für Suche und responsive Quizkarten.",
    coverColor: "#1368ce",
    questions: [{ id: "q1", type: "quiz", text: "Welche Antwort ist richtig?", choices: ["Richtig", "Falsch", "Auch falsch", "Noch falsch"], correctIndex: 0, points: 1000, timeLimit: 60 }],
  };
  const response = await context.request.post(`${base}/api/quizzes`, { data: quiz });
  assert.equal(response.status(), 200);
  const { id } = await response.json();

  step = "Library: cards, search, actions, typography and mobile";
  await page.goto(`${base}/library.html`);
  await page.locator(".quiz-card").waitFor();
  assert.equal(await page.locator(".page-heading .eyebrow").innerText(), "DEINE SAMMLUNG");
  assert.equal(await page.locator(".quiz-cover").count(), 1);
  assert.equal(await page.locator(".quiz-title").innerText(), quiz.title);
  assert(await page.locator(".quiz-title").evaluate((node: HTMLElement) => parseFloat(getComputedStyle(node).fontSize) >= 16));
  const search = page.getByRole("searchbox");
  await search.fill("does-not-exist");
  assert.equal(await page.locator(".quiz-card:visible").count(), 0);
  assert(await page.getByText("Kein Quiz gefunden.", { exact: false }).isVisible());
  await search.fill("responsive");
  assert.equal(await page.locator(".quiz-card:visible").count(), 1);
  assert.equal(await page.getByRole("link", { name: "Spiel starten", exact: true }).getAttribute("href"), `/host.html?quiz=${id}`);
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await fit(page, `Library ${width}px`);
    await touchTarget(page.getByRole("link", { name: "Spiel starten", exact: true }), "Library launch");
    await touchTarget(page.getByRole("button", { name: `Quiz ${quiz.title} löschen` }), "Library delete");
  }
  console.log("PASS: library acceptance");

  step = "Editor: sections, question navigation, swatches, save and mobile";
  await page.getByRole("link", { name: "Bearbeiten", exact: true }).click();
  await page.locator(".editor-meta").waitFor();
  assert.equal(await page.locator(".editor-actions").count(), 1);
  assert.equal(await page.locator(".question-outline a").count(), 1);
  assert.equal(await page.locator(".swatch.active").count(), 1);
  await page.locator(".swatch").first().click();
  assert.equal(await page.locator(".swatch").first().getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "+ Frage hinzufügen", exact: true }).click();
  assert.equal(await page.locator(".question-editor").count(), 2);
  assert.equal(await page.locator(".question-outline a").count(), 2);
  const question = page.locator(".question-editor").nth(1);
  await question.getByPlaceholder("Frage Text", { exact: true }).fill("Zweite Frage?");
  for (let i = 0; i < 4; i++) await question.getByPlaceholder(`Antwort ${i + 1}`, { exact: true }).fill(`Antwort ${i + 1}`);
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await fit(page, `Editor ${width}px`);
    await touchTarget(page.locator(".swatch").first(), "Editor swatch");
    await touchTarget(page.locator(".question-outline a").first(), "Editor question navigation");
  }
  const saved = page.waitForResponse((r: any) => r.url().endsWith("/api/quizzes") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Quiz speichern", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.goto(`${base}/library.html`);
  await page.locator(".quiz-card").waitFor();
  assert.match(await page.locator(".quiz-card").innerText(), /2 Fragen/);
  console.log("PASS: editor acceptance");

  step = "Player reveal: actual correct/wrong answers, one navigation, mobile and reduced motion";
  const gameResponse = await context.request.post(`${base}/api/quizzes`, { data: { ...quiz, title: "Podiumtest" } });
  const gameId = (await gameResponse.json()).id;
  const host = await context.newPage();
  await host.goto(`${base}/host.html?quiz=${gameId}`);
  await host.locator(".pin").waitFor();
  const pin = (await host.locator(".pin").innerText()).trim();
  const players: any[] = [];
  for (const name of ["Alexandertestname", "Beatrice", "Carla", "David"]) {
    const player = await context.newPage();
    await player.setViewportSize({ width: 375, height: 812 });
    await player.goto(`${base}/join.html?pin=${pin}&name=${name}`);
    await player.getByText(`Hallo ${name}!`, { exact: true }).waitFor();
    assert.equal(await player.locator(".topbar").count(), 1, "Player must have one navigation bar");
    players.push(player);
  }
  await host.getByRole("button", { name: /Spiel starten|Start game/ }).click();
  for (let i = 0; i < players.length; i++) {
    await players[i].locator(".player-choice").nth(i === 1 ? 1 : 0).click();
  }
  await players[0].locator(".result-banner.win").waitFor();
  await players[1].locator(".result-banner.lose").waitFor();
  assert.match(await players[0].locator(".result-banner").innerText(), /Punkte/);
  assert.match(await players[1].locator(".result-banner").innerText(), /Leider falsch/);
  assert(await players[0].locator(".result-banner h2").evaluate((node: HTMLElement) => parseFloat(getComputedStyle(node).fontSize) >= 24));
  for (const width of [375, 320]) {
    await players[0].setViewportSize({ width, height: 812 });
    await fit(players[0], `Reveal ${width}px`);
  }
  assert(await players[0].locator(".result-banner").evaluate((node: HTMLElement) => parseFloat(getComputedStyle(node).animationDuration) < 0.01));
  console.log("PASS: reveal acceptance");

  step = "Podium: host and player ranks, all participants, mobile and end action";
  await host.getByRole("button", { name: "Endergebnis zeigen", exact: true }).click();
  for (const screen of [host, ...players]) {
    await screen.locator(".podium").waitFor();
    assert.equal(await screen.locator(".podium-slot:not(.empty)").count(), 3);
    assert.equal(await screen.locator(".lb-row").count(), 1, "Fourth player remains listed");
    assert.match(await screen.locator(".podium-name").allTextContents().then((names: string[]) => names.join(" ")), /Alexandertestname/);
    for (const width of [1280, 375, 320]) {
      await screen.setViewportSize({ width, height: 900 });
      await fit(screen, `Podium ${width}px`);
    }
  }
  assert.match(await players[0].locator(".podium-name").allTextContents().then((names: string[]) => names.join(" ")), /\(du\)/);
  await host.getByRole("button", { name: "Spiel beenden", exact: true }).click();
  console.log("PASS: podium acceptance");

  step = "Library delete and empty state";
  await context.request.delete(`${base}/api/quizzes/${gameId}`);
  await page.reload();
  await page.getByRole("button", { name: `Quiz ${quiz.title} löschen`, exact: true }).click();
  await page.getByRole("heading", { name: "Eine gute Frage ist der Anfang.", exact: true }).waitFor();
  assert.equal(await page.locator(".quiz-card").count(), 0);
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log("PASS: deletion, empty state and no browser runtime errors");
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
