import { el, on, pad, gameSound } from "./lib/dom";

const GLYPHS = ["\u25B2", "\u25C6", "\u25CF", "\u25A0"];
const COLORS = ["red", "blue", "green", "yellow"];

const root = el("div", { className: "app" });
document.body.appendChild(el("div", { className: "topbar" }, [
  el("a", { className: "brand", href: "/", text: "KahootClone" }),
  el("div", { className: "row" }, [
    el("a", { href: "/", text: "Start" }),
    el("a", { href: "/library.html", text: "Meine Quizze" }),
    el("a", { href: "/editor.html", text: "Neu erstellen" }),
    el("a", { href: "/host.html", text: "Spiel hosten" }),
    el("div", { className: "small muted", text: "Spieler" }),
  ]),
]));
document.body.appendChild(root);
const sound = gameSound("player");

const params = new URLSearchParams(location.search);
let pin = params.get("pin") ?? "";
let name = params.get("name") ?? "";
let nameLocked = false;
let renameRequired = false;
let renameMessage = "";
let playerId: string | null = null;
let ws: WebSocket | null = null;
let phase: string = "idle";
let renderSeq = 0;
let answered = false;
let lastResult: { correct: boolean; delta: number; score: number } | null = null;
let isBuzzed = false;
let currentQuestion: any = null;
let currentView: any = null;

let currentQuestionIndex: number | null = null;
let sessionToken: string | null = null;
let terminal = false;
let connectionStarted = false;
let registered = false;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimeout: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongTimeout: ReturnType<typeof setTimeout> | null = null;
const statusEl = el("div", { className: "small muted", role: "status", text: "" });
document.querySelector(".topbar .row")?.appendChild(statusEl);

function sessionKey() {
  return `kc:session:player:${pin}`;
}

function stopTimers() {
  if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
}

function scheduleReconnect() {
  if (terminal || reconnectTimer) return;
  const delay = Math.floor(reconnectDelay * (0.5 + Math.random() * 0.5));
  reconnectDelay = Math.min(15000, reconnectDelay * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnect(socket: WebSocket) {
  if (ws !== socket) return;
  ws = null;
  registered = false;
  stopTimers();
  try { socket.close(); } catch {}
  if (terminal) return;
  root.inert = true;
  statusEl.textContent = "Verbindung getrennt — verbinde neu...";
  scheduleReconnect();
}

function stopConnection() {
  terminal = true;
  registered = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTimers();
  const socket = ws;
  ws = null;
  try { socket?.close(); } catch {}
  sessionToken = null;
  try { sessionStorage.removeItem(sessionKey()); } catch {}
  statusEl.textContent = "";
  root.inert = false;
}

function ping(socket: WebSocket) {
  if (ws !== socket || terminal || socket.readyState !== WebSocket.OPEN || pongTimeout) return;
  pongTimeout = setTimeout(() => disconnect(socket), 10000);
  try { socket.send(JSON.stringify({ type: "ping" })); } catch { disconnect(socket); }
}

function send(data: any) {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || terminal || !registered || root.inert || phase !== "question" || data.questionIndex !== currentQuestionIndex) {
    answered = false;
    if (socket && socket.readyState !== WebSocket.OPEN) disconnect(socket);
    return false;
  }
  try {
    socket.send(JSON.stringify(data));
    return true;
  } catch {
    answered = false;
    disconnect(socket);
    return false;
  }
}

function connect() {
  if (terminal || ws) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectionStarted = true;
  registered = false;
  root.inert = true;
  statusEl.textContent = "Verbinde...";
  if (!sessionToken) {
    try { sessionToken = sessionStorage.getItem(sessionKey()); } catch {}
  }
  const qs = new URLSearchParams({ role: "player", pin });
  if (sessionToken) qs.set("sessionToken", sessionToken);
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
    // Alle 5s pingen: Der Server kickt Spieler ohne Nachricht seit 10s.
    heartbeatTimer = setInterval(() => ping(socket), 5000);
    try { socket.send(JSON.stringify({ type: "player:join", pin, name })); } catch { disconnect(socket); }
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
  if (!connectionStarted || terminal) return;
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
  if (msg.type === "joined") {
    playerId = msg.playerId;
    registered = true;
    reconnectDelay = 1000;
    if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
    statusEl.textContent = "";
    if (phase === "idle" || phase === "lobby") { render({ type: "lobby" }); sound.play("question", `${pin}:joined`); }
    return;
  }
  if (msg.type === "answer:ack") {
    if (currentQuestionIndex === null || msg.questionIndex !== currentQuestionIndex) return;
    if (msg.tooEarly === true && phase === "question" && currentQuestion) {
      answered = false;
      lastResult = null;
      render({ type: "question", question: currentQuestion });
      showSubmitted("Zu früh! Warte auf das Quadrat.");
      return;
    }
    answered = true;
    lastResult = { correct: msg.correct, delta: msg.delta, score: msg.score };
    sound.stop();
    sound.play("submit", `${pin}:submit:${msg.questionIndex}`);
    lockAnswer();
    if (phase === "reveal" && currentView) render(currentView);
    if (msg.correct && isBuzzed) {
      flashBuzz("Du hast zuerst gebuzzert!");
    }
    showSubmitted(msg.tooEarly ? "Zu früh! Warte auf das Quadrat." : "✓ Eingereicht — warte auf die Auflösung");
    return;
  }
  if (msg.type === "lobby:update") {
    if (registered && (phase === "idle" || phase === "lobby")) {
      const me = (msg.players ?? []).find((p: any) => p.id === playerId);
      if (me) {
        // Host kann den Namen festlegen + sperren — dann ist Umbenennen aus.
        if (typeof me.name === "string" && me.name && me.name !== name) name = me.name;
        nameLocked = me.locked === true;
        if (me.renamePending !== true) { renameRequired = false; renameMessage = ""; }
      }
      render({ type: "lobby", players: msg.players.length });
    }
    return;
  }
  if (msg.type === "rename:required") {
    if (typeof msg.name === "string" && msg.name) name = msg.name;
    renameRequired = true;
    renameMessage = msg.message || "Dieser Name ist nicht erlaubt. Bitte wähle einen anderen Namen.";
    if (phase === "idle" || phase === "lobby") render({ type: "lobby", players: currentView?.players });
    return;
  }
  if (msg.type === "question:show") {
    if (!Number.isInteger(msg.index) || (currentQuestionIndex !== null && msg.index < currentQuestionIndex)) return;
    currentQuestionIndex = msg.index;
    currentQuestion = msg;
    answered = msg.answered === true;
    isBuzzed = false;
    lastResult = null;
    render({ type: "question", question: msg });
    sound.stop();
    const question = msg.question ?? {};
    if (!msg.answered && question.type !== "memory" && question.type !== "reaction" && !question.audioUrl && !question.videoUrl) {
      sound.play("question", `${pin}:q:${msg.index}`);
      sound.countdown(msg.startedAt + msg.timeLimit * 1000);
    }
    if (answered) {
      lockAnswer();
      showSubmitted("✓ Eingereicht — warte auf die Auflösung");
    }
    return;
  }
  if (msg.type === "answers:update") {
    patchAnswerCount(msg.answered, msg.total);
    return;
  }
  if (msg.type === "question:reveal") {
    if (!Number.isInteger(msg.index) || (currentQuestionIndex !== null && msg.index < currentQuestionIndex)) return;
    if (msg.index !== currentQuestionIndex) lastResult = null;
    currentQuestionIndex = msg.index;
    answered = true;
    render({ type: "reveal", data: msg });
    sound.stop();
    const identity = `${pin}:reveal:${msg.index}:${lastResult?.correct ? "correct" : lastResult ? "wrong" : "reveal"}`;
    if (lastResult) sound.play(lastResult.correct ? "correct" : "wrong", identity);
    else sound.play("reveal", `${pin}:reveal:${msg.index}`);
    return;
  }
  if (msg.type === "buzzed") {
    if (msg.playerId === playerId) {
      isBuzzed = true;
      flashBuzz("Du hast zuerst gebuzzert!");
    }
    return;
  }
  if (msg.type === "leaderboard:show") {
    render({ type: "leaderboard", data: msg });
    return;
  }
  if (msg.type === "game:finished") {
    stopConnection();
    sound.stop();
    sound.play("podium", `${pin}:finished`);
    render({ type: "final", data: msg });
    return;
  }
  if (msg.type === "game:ended") {
    stopConnection();
    render({ type: "ended" });
    return;
  }
  if (msg.type === "kicked" || msg.type === "player:kicked") {
    stopConnection();
    render({ type: "error", message: msg.message || "Du wurdest aus dem Spiel entfernt." });
    return;
  }
  if (msg.type === "error") {
    if (msg.terminal === true) {
      stopConnection();
      render({ type: "error", message: msg.message });
    } else {
      statusEl.textContent = msg.message || "Fehler";
    }
    return;
  }
}

function lockAnswer() {
  if (phase !== "question") return;
  root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button, input, textarea, select").forEach((control) => {
    control.disabled = true;
  });
}

function flashBuzz(text: string) {
  const banner = el("div", { className: "buzz-banner show" }, [
    el("span", { className: "buzz-glyph", text: "\u26a1" }),
    el("span", { text }),
  ]);
  document.body.appendChild(banner);
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 300);
  }, 1800);
}

function showSubmitted(text: string) {
  if (phase !== "question") return;
  let banner = root.querySelector(".locked-banner") as HTMLElement | null;
  if (!banner) {
    banner = el("div", { className: "locked-banner" }) as HTMLElement;
    root.appendChild(banner);
  }
  banner.textContent = text;
  banner.classList.add("show");
}

function patchAnswerCount(answeredCount: number, total: number) {
  if (phase !== "question") return;
  const node = root.querySelector("[data-answered]");
  if (node) node.textContent = `${answeredCount} / ${total} haben geantwortet`;
}

function render(view: any) {
  currentView = view;
  renderSeq++;
  const seq = renderSeq;
  phase = view.type;
  root.innerHTML = "";
  root.inert = !terminal && !registered;

  if (view.type === "disconnected") {
    root.append(el("p", { className: "muted center", text: "Verbinde neu..." }));
    return;
  }
  if (view.type === "error") {
    root.append(el("div", { className: "card center" }, [
      el("h2", { text: "\u26a0" }),
      el("p", { text: view.message }),
    ]));
    return;
  }
  if (view.type === "lobby") {
    const nameInput = el("input", { value: renameRequired ? "" : name, placeholder: "Dein Name", maxlength: "18", style: "max-width:220px; text-align:center" }) as HTMLInputElement;
    const renameBtn = el("button", { className: renameRequired ? "small" : "ghost small", text: renameRequired ? "Namen bestätigen" : "Namen ändern" });
    const doRename = () => {
      if (nameLocked) return;
      const next = nameInput.value.trim().slice(0, 18);
      if (!next || (!renameRequired && next === name)) return;
      try { ws?.send(JSON.stringify({ type: "player:rename", pin, name: next })); } catch { /* reconnect sends join with new name */ }
      if (!renameRequired) { name = next; render({ type: "lobby", players: view.players }); }
    };
    on(renameBtn, "click", doRename);
    on(nameInput, "keydown", (e: KeyboardEvent) => { if (e.key === "Enter") doRename(); });
    if (renameRequired) {
      root.append(el("div", { className: "card center col" }, [
        el("h2", { text: "⚠ Name nicht erlaubt" }),
        el("p", { className: "muted", text: renameMessage }),
        el("p", { className: "small", text: `Aktueller Platzhalter: ${name}` }),
        el("div", { className: "row center", style: "gap:0.5rem; margin-top:0.5rem" }, [nameInput, renameBtn]),
      ]));
      return;
    }
    const nameRow = nameLocked
      ? el("p", { className: "muted small", text: "🔒 Name vom Host festgelegt" })
      : el("div", { className: "row center", style: "gap:0.5rem; margin-top:0.5rem" }, [nameInput, renameBtn]);
    root.append(el("div", { className: "card center col" }, [
      el("h2", { text: `Hallo ${name}!` }),
      el("p", { className: "muted", text: view.players != null ? `${view.players} Spieler in der Lobby` : "Warte auf den Host..." }),
      el("div", { className: "row center" }, [el("span", { className: "muted small", text: "Spiel-PIN: " + pin })]),
      nameRow,
    ]));
    return;
  }
  if (view.type === "question") {
    const q = view.question;
    root.append(el("div", { className: "question-text", text: q.question.text }));

    if (q.audioUrl) root.append(el("audio", { src: q.audioUrl, controls: "true", autoplay: "true" }));
    if (q.videoUrl) root.append(el("video", { src: q.videoUrl, controls: "true", autoplay: "true", style: "max-width:100%; max-height:200px" }));
    if (q.question.imageUrl && q.questionType !== "image_hotspot" && q.questionType !== "color_match") {
      root.append(el("img", { src: q.question.imageUrl, style: "max-height:140px; border-radius:8px; display:block; margin:0 auto" }));
    }

    renderPlayerAnswer(q);

    const timer = el("div", { className: "timer-bar" });
    const fill = el("div", { className: "timer-fill" });
    timer.append(fill);
    root.append(timer);

    const answeredEl = el("div", { className: "center muted small", text: `` });
    answeredEl.setAttribute("data-answered", "1");
    root.append(answeredEl);

    const start = q.startedAt;
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
    return;
  }
  if (view.type === "reveal") {
    const data = view.data;
    if (lastResult) {
      const banner = el("div", { className: `result-banner ${lastResult.correct ? "win" : "lose"}` }, [
        el("div", { className: "result-emoji", text: lastResult.correct ? "🎉" : "💔" }),
        el("h2", { text: lastResult.correct ? `+${lastResult.delta} Punkte!` : "Leider falsch" }),
        el("p", { className: "muted", text: `Total: ${lastResult.score}` }),
      ]);
      root.append(banner);
    }
    renderRevealBody(data);
    return;
  }
  if (view.type === "leaderboard") {
    root.append(el("h2", { className: "center", text: "Bestenliste" }));
    const list = el("div", { className: "lb-list" });
    view.data.leaderboard.forEach((row: any, i: number) => {
      const cls = i === 0 ? "lb-row gold" : i === 1 ? "lb-row silver" : i === 2 ? "lb-row bronze" : "lb-row";
      list.append(el("div", { className: cls }, [
        el("span", { className: "rank", text: `#${row.rank}` }),
        el("span", { text: row.name }),
        el("span", { text: pad(row.score, 5) }),
      ]));
    });
    root.append(list);
    return;
  }
  if (view.type === "final") {
    root.append(el("h1", { className: "center", text: "🏁 Spiel vorbei" }));
    renderPodium(view.data.leaderboard, true);
    const list = el("div", { className: "lb-list" });
    const rest = view.data.leaderboard.slice(3);
    rest.forEach((row: any, i: number) => {
      const cls = "lb-row";
      list.append(el("div", { className: cls }, [
        el("span", { className: "rank", text: `#${row.rank}` }),
        el("span", { text: row.name + (playerId && row.id === playerId ? " (du)" : "") }),
        el("span", { text: pad(row.score, 5) }),
      ]));
    });
    if (rest.length) root.append(list);
    return;
  }
  if (view.type === "ended") {
    root.append(el("div", { className: "card center" }, [
      el("h2", { text: "Host hat das Spiel beendet" }),
      el("a", { href: "/", text: "Zurück zum Start" }),
    ]));
    return;
  }
}

function renderPlayerAnswer(q: any) {
  const type = q.questionType;

  if (type === "quiz" || type === "true_false" || type === "dropdown" || type === "audio_clip" || type === "video_clip") {
    const stage = el("div", { className: "player-stage" });
    (q.question.choices ?? []).slice(0, 4).forEach((c: string, i: number) => {
      const b = el("button", { className: `player-choice ${COLORS[i % 4]}` });
      b.append(el("span", { text: GLYPHS[i % 4] }));
      on(b, "click", () => {
        if (answered) return;
        answered = true;
        if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "choice", choice: i } })) return;
        renderSelected(stage, i);
      });
      stage.appendChild(b);
    });
    root.appendChild(stage);
  } else if (type === "multi_select" || type === "choose_two") {
    const max = type === "choose_two" ? 2 : (q.question.choices?.length ?? 0);
    const selected = new Set<number>();
    const stage = el("div", { className: "player-stage grid-multi" });
    (q.question.choices ?? []).slice(0, 6).forEach((c: string, i: number) => {
      const b = el("button", { className: `player-choice ${COLORS[i % 4]}` });
      b.append(el("span", { text: GLYPHS[i % 4] }));
      on(b, "click", () => {
        if (answered) return;
        if (selected.has(i)) selected.delete(i);
        else if (selected.size < max) selected.add(i);
        b.classList.toggle("selected", selected.has(i));
      });
      stage.appendChild(b);
    });
    const submit = el("button", { text: "Absenden", className: "type-submit", style: "margin:1rem auto; display:block" });
    on(submit, "click", () => {
      if (answered || selected.size === 0) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "multi", choices: Array.from(selected) } })) return;
      stage.classList.add("locked");
      submit.disabled = true;
    });
    root.append(stage, submit);
  } else if (type === "type_answer" || type === "fill_blank") {
    const stage = el("div", { className: "type-stage" });
    const input = el("input", { placeholder: "Tippe deine Antwort" }) as HTMLInputElement;
    input.maxLength = 60;
    const submit = el("button", { text: "Absenden", className: "type-submit" });
    const doSubmit = () => {
      if (answered) return;
      const v = input.value.trim();
      if (!v) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "text", text: v } })) return;
      submit.disabled = true;
      input.disabled = true;
      stage.classList.add("locked");
    };
    on(input, "keydown", (e: any) => { if (e.key === "Enter") doSubmit(); });
    on(submit, "click", doSubmit);
    stage.append(input, submit);
    root.appendChild(stage);
  } else if (type === "open_ended") {
    const stage = el("div", { className: "type-stage" });
    const input = el("textarea", { placeholder: "Schreibe deine Antwort" }) as HTMLTextAreaElement;
    input.rows = 4;
    input.maxLength = 500;
    const submit = el("button", { text: "Absenden", className: "type-submit" });
    const doSubmit = () => {
      if (answered) return;
      const v = input.value.trim();
      if (!v) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "text", text: v } })) return;
      submit.disabled = true;
      input.disabled = true;
    };
    on(submit, "click", doSubmit);
    stage.append(input, submit);
    root.appendChild(stage);
  } else if (type === "brainstorm" || type === "word_cloud") {
    const stage = el("div", { className: "type-stage" });
    const inputRow = el("div", { className: "row" });
    const input = el("input", { placeholder: "Tippe ein Wort", style: "flex:1" }) as HTMLInputElement;
    const addBtn = el("button", { text: "+", className: "ghost" });
    inputRow.append(input, addBtn);
    const wordList = el("div", { className: "word-chips" });
    const words: string[] = [];
    const redraw = () => {
      wordList.innerHTML = "";
      words.forEach((w, i) => {
        const chip = el("div", { className: "chip", text: w });
        const x = el("span", { className: "chip-x", text: "\u2715" });
        on(x, "click", () => { words.splice(i, 1); redraw(); });
        chip.append(x);
        wordList.append(chip);
      });
    };
    const addWord = () => {
      const v = input.value.trim().toLowerCase();
      if (!v || words.includes(v) || words.length >= 12) return;
      words.push(v);
      input.value = "";
      redraw();
    };
    on(input, "keydown", (e: any) => { if (e.key === "Enter") { e.preventDefault(); addWord(); } });
    on(addBtn, "click", addWord);
    const submit = el("button", { text: "Einreichen", className: "type-submit" });
    on(submit, "click", () => {
      if (answered) return;
      addWord(); // flush text still sitting in the input
      if (words.length === 0) {
        input.focus();
        return;
      }
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "words", words } })) return;
      submit.disabled = true;
      input.disabled = true;
    });
    stage.append(inputRow, wordList, submit);
    root.appendChild(stage);
  } else if (type === "slider" || type === "estimate") {
    const min = q.question.sliderMin ?? 0;
    const max = q.question.sliderMax ?? 100;
    const step = q.question.sliderStep ?? 1;
    const stage = el("div", { className: "slider-stage" });
    const track = el("div", { className: "slider-track" });
    const fill = el("div", { className: "slider-fill" });
    track.append(fill);
    const labels = el("div", { className: "slider-labels" }, [
      el("span", { text: String(min) }),
      el("span", { text: String(max) }),
    ]);
    const valueDisplay = el("div", { className: "slider-value", text: String(min) });
    const slider = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(min), style: "width:100%; touch-action:pan-x" }) as HTMLInputElement;
    on(slider, "input", () => {
      const v = Number(slider.value);
      fill.style.width = `${((v - min) / (max - min)) * 100}%`;
      valueDisplay.textContent = String(v);
    });
    const submit = el("button", { text: "Einreichen" });
    on(submit, "click", () => {
      if (answered) return;
      answered = true;
      const v = Number(slider.value);
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "choice", choice: v } })) return;
      submit.disabled = true;
      slider.disabled = true;
    });
    // NOTE: the range input itself must be in the DOM or the slider can't be dragged.
    stage.append(valueDisplay, slider, track, labels, submit);
    root.appendChild(stage);
  } else if (type === "order" || type === "sequence" || type === "fastest_finger") {
    const stage = el("div", { className: "order-stage" });
    const items = (q.question.items ?? []).slice();
    const order: number[] = [];
    const list = el("div", { className: "order-list" });
    const draw = () => {
      list.innerHTML = "";
      order.forEach((origIdx, pos) => {
        const row = el("div", { className: "order-row" });
        row.append(el("span", { className: "order-pos", text: String(pos + 1) }));
        row.append(el("span", { text: items[origIdx] }));
        const up = el("button", { className: "ghost small", text: "\u25b2" });
        const down = el("button", { className: "ghost small", text: "\u25bc" });
        on(up, "click", () => {
          if (pos === 0) return;
          const tmp = order[pos - 1];
          order[pos - 1] = order[pos];
          order[pos] = tmp;
          draw();
        });
        on(down, "click", () => {
          if (pos === order.length - 1) return;
          const tmp = order[pos + 1];
          order[pos + 1] = order[pos];
          order[pos] = tmp;
          draw();
        });
        row.append(up, down);
        list.append(row);
      });
      const remaining = items.map((_, i) => i).filter((i) => !order.includes(i));
      remaining.forEach((origIdx) => {
        const row = el("div", { className: "order-row unsorted" });
        row.append(el("span", { className: "order-pos", text: "?" }));
        row.append(el("span", { text: items[origIdx] }));
        const add = el("button", { className: "ghost small", text: "Hinzufügen" });
        on(add, "click", () => { order.push(origIdx); draw(); });
        row.append(add);
        list.append(row);
      });
    };
    items.forEach((_, i) => order.push(i));
    draw();
    const submit = el("button", { text: "Absenden", style: "margin-top:1rem" });
    on(submit, "click", () => {
      if (answered || order.length !== items.length) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "order", order } })) return;
      submit.disabled = true;
      list.classList.add("locked");
    });
    stage.append(list, submit);
    root.appendChild(stage);
  } else if (type === "puzzle_drop") {
    const stage = el("div", { className: "puzzle-stage" });
    const items = (q.question.items ?? []).slice();
    const slots = (q.question.puzzleSlots ?? []).slice();
    const slotsRow = el("div", { className: "puzzle-slots" });
    const placed: number[] = slots.map(() => -1);
    const drawSlots = () => {
      slotsRow.innerHTML = "";
      slots.forEach((s, i) => {
        const slot = el("div", { className: "puzzle-slot" });
        if (placed[i] >= 0) {
          slot.textContent = items[placed[i]];
          slot.classList.add("filled");
        } else {
          slot.textContent = "_";
        }
        slot.append(el("span", { className: "slot-pos muted small", text: String(i + 1) }));
        slotsRow.append(slot);
      });
    };
    drawSlots();
    const piecesRow = el("div", { className: "puzzle-pieces" });
    const used = new Set<number>();
    items.forEach((it, idx) => {
      const piece = el("button", { className: "puzzle-piece" });
      piece.textContent = it;
      on(piece, "click", () => {
        if (used.has(idx)) return;
        const slot = placed.indexOf(-1);
        if (slot >= 0) {
          placed[slot] = idx;
          used.add(idx);
          piece.disabled = true;
          drawSlots();
        }
      });
      piecesRow.append(piece);
    });
    const submit = el("button", { text: "Absenden", style: "margin-top:1rem" });
    on(submit, "click", () => {
      if (answered || placed.some((p) => p < 0)) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "puzzle", slots: placed } })) return;
      submit.disabled = true;
    });
    stage.append(slotsRow, piecesRow, submit);
    root.appendChild(stage);
  } else if (type === "match_pairs") {
    const stage = el("div", { className: "match-stage" });
    const pairs = q.question.pairs ?? [];
    const pairsMap: Record<string, string> = {};
    const lefts = pairs.map((p: any) => p.left);
    const rights = pairs.map((p: any) => p.right);
    const rightsAvailable = rights.slice();
    const drawMatch = () => {
      stage.innerHTML = "";
      pairs.forEach((p: any) => {
        const row = el("div", { className: "match-row" });
        const leftBox = el("div", { className: "match-left", text: p.left });
        const rightBox = el("div", { className: "match-right" });
        // Kein Richtig/Falsch-Feedback während dem Spiel: Die richtigen Paare
        // kennt nur der Server (Anti-Cheat) — Auflösung kommt beim Reveal.
        if (pairsMap[p.left]) {
          rightBox.textContent = pairsMap[p.left];
          leftBox.classList.add("assigned");
          rightBox.classList.add("assigned");
          rightBox.style.cursor = "pointer";
          on(rightBox, "click", () => {
            const r = pairsMap[p.left];
            delete pairsMap[p.left];
            rightsAvailable.push(r);
            drawMatch();
          });
        } else rightBox.textContent = "?";
        row.append(leftBox, el("span", { className: "match-arrow", text: "\u2192" }), rightBox);
        stage.append(row);
      });
      const picker = el("div", { className: "match-picker" });
      rightsAvailable.forEach((r) => {
        const b = el("button", { className: "ghost small", text: r });
        on(b, "click", () => {
          // cycle through lefts
          const keys = lefts.filter((l: string) => !pairsMap[l]);
          if (keys.length === 0) return;
          pairsMap[keys[0]] = r;
          const i = rightsAvailable.indexOf(r);
          if (i >= 0) rightsAvailable.splice(i, 1);
          drawMatch();
        });
        picker.append(b);
      });
      stage.append(picker);
    };
    drawMatch();
    const submit = el("button", { text: "Absenden", style: "margin-top:1rem" });
    on(submit, "click", () => {
      if (answered || Object.keys(pairsMap).length !== pairs.length) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "match", pairs: pairsMap } })) return;
      submit.disabled = true;
    });
    root.appendChild(stage);
    root.appendChild(submit);
  } else if (type === "classify") {
    const stage = el("div", { className: "classify-stage" });
    const items = (q.question.items ?? []).slice();
    const cats = q.question.categories ?? [];
    const bins: Record<string, string> = {};
    const list = el("div", { className: "classify-items" });
    const draw = () => {
      list.innerHTML = "";
      items.forEach((it) => {
        const row = el("div", { className: "classify-row" });
        row.append(el("span", { text: it }));
        const sel = el("select", { style: "max-width:160px" }) as HTMLSelectElement;
        const noneOpt = document.createElement("option");
        noneOpt.value = "";
        noneOpt.textContent = "Sortieren in...";
        sel.appendChild(noneOpt);
        cats.forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          if (bins[it] === c) opt.selected = true;
          sel.appendChild(opt);
        });
        if (!bins[it]) noneOpt.selected = true;
        on(sel, "change", () => {
          if (sel.value) bins[it] = sel.value;
          else delete bins[it];
        });
        row.append(sel);
        list.append(row);
      });
    };
    draw();
    const submit = el("button", { text: "Absenden", style: "margin-top:1rem" });
    on(submit, "click", () => {
      if (answered) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "classify", bins } })) return;
      submit.disabled = true;
    });
    stage.append(list, submit);
    root.appendChild(stage);
  } else if (type === "poll") {
    const stage = el("div", { className: "player-stage" });
    (q.question.choices ?? []).slice(0, 4).forEach((c: string, i: number) => {
      const b = el("button", { className: `player-choice ${COLORS[i % 4]}` });
      b.append(el("span", { text: GLYPHS[i % 4] }));
      on(b, "click", () => {
        if (answered) return;
        answered = true;
        if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "choice", choice: i } })) return;
        renderSelected(stage, i);
      });
      stage.appendChild(b);
    });
    root.appendChild(stage);
  } else if (type === "color_match") {
    const stage = el("div", { className: "color-stage" });
    const colors = q.question.colors ?? [];
    // Deterministic target shared with the host (server sends targetHex/correctName).
    const targetHex: string = q.targetHex ?? q.question.colors?.[0]?.hex ?? colors[0]?.hex;
    const targetName: string | undefined = q.correctName ?? q.question.correctName;
    const target = colors.find((c: any) => c.hex === targetHex) ?? colors.find((c: any) => c.name === targetName) ?? colors[0];
    if (target) {
      const swatch = el("div", { className: "color-swatch-big", style: `background:${target.hex}` });
      stage.append(swatch);
    }
    const grid = el("div", { className: "color-grid" });
    colors.forEach((c: any) => {
      const b = el("button", { className: "color-option" });
      b.append(el("div", { className: "color-swatch", style: `background:${c.hex}` }));
      b.append(el("span", { text: c.name }));
      on(b, "click", () => {
        if (answered) return;
        answered = true;
        if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "color", hex: c.hex } })) return;
        grid.classList.add("locked");
      });
      grid.append(b);
    });
    stage.append(grid);
    root.appendChild(stage);
  } else if (type === "image_hotspot") {
    const stage = el("div", { className: "hotspot-stage" });
    const img = el("div", { className: "hotspot-img", style: q.question.imageUrl ? `background:url(${q.question.imageUrl}) center/cover` : "background:#333" });
    img.style.cursor = "crosshair";
    const marker = el("div", { className: "hotspot-dot" });
    marker.style.display = "none";
    img.append(marker);
    on(img, "click", (e: MouseEvent) => {
      if (answered) return;
      const rect = img.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      marker.style.display = "block";
      marker.style.left = `calc(${x * 100}% - 8px)`;
      marker.style.top = `calc(${y * 100}% - 8px)`;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "hotspot", x, y } })) return;
    });
    stage.append(img);
    root.appendChild(stage);
  } else if (type === "reaction") {
    const stage = el("div", { className: "buzz-button-stage" });
    const waitNote = el("p", { className: "muted center", text: "Warte auf das blaue Quadrat..." });
    const square = el("div", { className: "center", text: "■", style: "font-size:5rem; color:var(--blue); display:none" });
    const buzz = el("button", { className: "buzz-button", text: "WARTEN...", style: "opacity:0.5" }) as HTMLButtonElement;
    buzz.disabled = true;
    const goAt: number = q.goAt ?? (Date.now() + 2000);
    const ms = Math.max(0, goAt - Date.now());
    const questionRenderSeq = renderSeq;
    setTimeout(() => {
      if (answered || questionRenderSeq !== renderSeq) return;
      square.style.display = "";
      waitNote.textContent = "JETZT TIPPEN!";
      buzz.textContent = "BUZZ!";
      buzz.style.opacity = "1";
      buzz.disabled = false;
    }, ms);
    on(buzz, "click", () => {
      if (answered || buzz.disabled) return;
      answered = true;
      if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "react" } })) return;
      buzz.disabled = true;
      buzz.classList.add("buzzed");
    });
    stage.append(waitNote, square, buzz);
    root.appendChild(stage);
  } else if (type === "memory") {
    const stage = el("div", { className: "memory-stage" });
    const length = q.question.memoryLength ?? 4;
    // Server-generated sequence (shared, scoreable); fallback to random for old rooms.
    const seq: number[] = Array.isArray(q.memorySeq) && q.memorySeq.length === length
      ? q.memorySeq.slice()
      : Array.from({ length }, () => Math.floor(Math.random() * 4));
    const display = el("div", { className: "memory-display" });
    const showSeq = async () => {
      for (const i of seq) {
        display.className = `memory-display show-${i}`;
        await new Promise((r) => setTimeout(r, 600));
        display.className = "memory-display";
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    showSeq();
    const grid = el("div", { className: "memory-grid" });
    const playerSeq: number[] = [];
    for (let i = 0; i < 4; i++) {
      const b = el("button", { className: `player-choice ${COLORS[i]}`, text: GLYPHS[i] });
      on(b, "click", () => {
        if (answered) return;
        playerSeq.push(i);
        if (playerSeq.length === length) {
          answered = true;
          if (!send({ type: "player:answer", pin, questionIndex: q.index, answer: { kind: "memory", sequence: playerSeq } })) return;
          grid.classList.add("locked");
        }
      });
      grid.append(b);
    }
    stage.append(display, grid);
    root.appendChild(stage);
  } else {
    // Fallback: not yet implemented
    root.append(el("div", { className: "card center", text: `Question type "${type}" not yet supported on player` }));
  }
}

function renderPodium(entries: Array<{ rank: number; id: string; name: string; score: number }>, highlightMe: boolean) {
  const top3 = entries.slice(0, 3);
  const podium = el("div", { className: "podium" });
  const order = [
    { place: 2, entry: top3[1] },
    { place: 1, entry: top3[0] },
    { place: 3, entry: top3[2] },
  ];
  for (const { place, entry } of order) {
    const slot = el("div", { className: `podium-slot place-${place}${entry ? "" : " empty"}` });
    if (entry) {
      slot.append(
        el("div", { className: "podium-medal", text: ["🥇", "🥈", "🥉"][place - 1] }),
        el("div", { className: "podium-name", text: entry.name + (highlightMe && playerId === entry.id ? " (du)" : "") }),
        el("div", { className: "podium-score", text: `${entry.score} Pkte` }),
      );
    }
    slot.append(el("div", { className: "podium-bar", text: String(place) }));
    podium.append(slot);
  }
  root.append(podium);
}

function renderRevealBody(data: any) {  if (data.questionType === "quiz" || data.questionType === "true_false" || data.questionType === "dropdown" || data.questionType === "audio_clip" || data.questionType === "video_clip") {
    const stage = el("div", { className: "player-stage" });
    const choices = data.choices ?? [];
    for (let i = 0; i < choices.length; i++) {
      const cls = i === data.correctIndex ? `player-choice ${COLORS[i % 4]} selected` : `player-choice ${COLORS[i % 4]} locked`;
      stage.append(el("button", { className: cls, text: GLYPHS[i % 4] }));
    }
    root.append(stage);
  } else if (data.questionType === "multi_select" || data.questionType === "choose_two") {
    const stage = el("div", { className: "player-stage grid-multi" });
    const choices = data.choices ?? [];
    for (let i = 0; i < choices.length; i++) {
      const correct = (data.correctIndices ?? []).includes(i);
      const cls = correct ? `player-choice ${COLORS[i % 4]} selected` : `player-choice ${COLORS[i % 4]} locked`;
      stage.append(el("button", { className: cls, text: GLYPHS[i % 4] }));
    }
    root.append(stage);
  } else if (data.questionType === "type_answer" || data.questionType === "fill_blank") {
    const card = el("div", { className: "card center" });
    card.append(el("div", { className: "muted small", text: "Akzeptiert" }));
    card.append(el("h2", { text: (data.acceptedAnswers ?? []).join(" / ") }));
    root.append(card);
  } else if (data.questionType === "slider" || data.questionType === "estimate") {
    const card = el("div", { className: "card center" });
    card.append(el("div", { className: "muted small", text: "Richtige Antwort" }));
    card.append(el("h2", { text: String(data.correctValue) }));
    root.append(card);
  } else if (data.questionType === "poll") {
    const card = el("div", { className: "card center" });
    card.append(el("p", { className: "muted", text: "Danke für deine Stimme!" }));
    root.append(card);
  } else if (data.questionType === "color_match") {
    const card = el("div", { className: "card center" });
    card.append(el("div", { className: "muted small", text: "Richtige Farbe" }));
    const target = (data.colors ?? []).find((c: any) => c.name === data.correctName);
    if (target) card.append(el("div", { className: "color-swatch-big", style: `background:${target.hex}` }));
    card.append(el("h2", { text: data.correctName ?? "" }));
    root.append(card);
  } else if (data.questionType === "image_hotspot" && data.hotspot) {
    const img = el("div", { className: "hotspot-img", style: `background:url(${data.imageUrl}) center/cover; position:relative` });
    img.style.minHeight = "240px";
    const target = el("div", { className: "hotspot-target-reveal" });
    target.style.left = `${data.hotspot.x * 100}%`;
    target.style.top = `${data.hotspot.y * 100}%`;
    target.style.width = `${data.hotspot.r * 200}%`;
    target.style.height = `${data.hotspot.r * 200}%`;
    img.append(target);
    root.append(img);
  } else if (data.questionType === "brainstorm" || data.questionType === "word_cloud" || data.questionType === "open_ended") {
    if (data.textAnswers && data.textAnswers.length) {
      const card = el("div", { className: "card" });
      card.append(el("h3", { text: "Andere Antworten" }));
      const list = el("div", { className: "answer-list" });
      data.textAnswers.forEach((a: any) => list.append(el("div", { className: "answer-row" }, [
        el("strong", { text: a.name + ":" }),
        el("span", { text: " " + a.text }),
      ])));
      card.append(list);
      root.append(card);
    }
  } else if (data.questionType === "order" || data.questionType === "sequence" || data.questionType === "fastest_finger") {
    const card = el("div", { className: "card center" });
    card.append(el("p", { className: "muted small", text: "Richtige Reihenfolge:" }));
    const list = el("div", { className: "list-display" });
    (data.correctOrder ?? []).forEach((itemIdx: number, pos: number) => {
      list.append(el("div", { className: "list-row reveal-correct" }, [
        el("span", { className: "list-pos", text: String(pos + 1) }),
        el("span", { text: (data.items ?? [])[itemIdx] ?? "" }),
      ]));
    });
    card.append(list);
    root.append(card);
  } else if (data.questionType === "match_pairs") {
    const card = el("div", { className: "card" });
    (data.pairs ?? []).forEach((p: any) => {
      card.append(el("div", { className: "match-row reveal-correct" }, [
        el("div", { className: "match-left", text: p.left }),
        el("div", { className: "match-arrow", text: "\u2194" }),
        el("div", { className: "match-right", text: p.right }),
      ]));
    });
    root.append(card);
  } else if (data.questionType === "classify") {
    const cats = data.categories ?? [];
    const items = data.items ?? [];
    const correctBins = data.correctBins ?? {};
    const grid = el("div", { className: "classify-grid" });
    cats.forEach((cat: string) => {
      const bin = el("div", { className: "classify-bin reveal-correct" });
      bin.append(el("div", { className: "classify-label", text: cat }));
      items.filter((it: string) => correctBins[it] === cat).forEach((it: string) => {
        bin.append(el("div", { className: "classify-item", text: it }));
      });
      grid.append(bin);
    });
    root.append(grid);
  } else if (data.questionType === "puzzle_drop") {
    const slotsRow = el("div", { className: "puzzle-slots" });
    (data.correctOrder ?? []).forEach((itemIdx: number) => {
      slotsRow.append(el("div", { className: "puzzle-slot reveal-correct", text: (data.items ?? [])[itemIdx] ?? "" }));
    });
    root.append(slotsRow);
  } else if (data.questionType === "reaction") {
    const card = el("div", { className: "card center" });
    card.append(el("h2", { text: data.buzzedPlayerId ? "Gewinner!" : "Zeit um" }));
    root.append(card);
  } else if (data.questionType === "memory") {
    const card = el("div", { className: "card center" });
    card.append(el("h2", { text: `Sequence was ${data.memoryLength} taps` }));
    root.append(card);
  }
}

function renderSelected(stage: Element, idx: number) {
  const tiles = stage.querySelectorAll(".player-choice");
  tiles.forEach((t, i) => {
    t.classList.toggle("selected", i === idx);
    (t as HTMLElement).style.opacity = i === idx ? "1" : "0.4";
  });
  const locked = document.createElement("div");
  locked.className = "locked-banner";
  locked.textContent = "\u2713 Eingereicht";
  stage.appendChild(locked);
}

if (!pin || !name) {
  const card = el("div", { className: "card col" }, [
    el("h1", { text: "Spiel beitreten" }),
    el("label", { className: "col" }, [
      el("span", { className: "small muted", text: "Spiel-PIN" }),
      (() => {
        const i = el("input", { placeholder: "123456", maxLength: 6 }) as HTMLInputElement;
        i.value = pin;
        on(i, "input", () => { pin = i.value; });
        return i;
      })(),
    ]),
    el("label", { className: "col" }, [
      el("span", { className: "small muted", text: "Dein Name" }),
      (() => {
        const i = el("input", { placeholder: "Spieler", maxLength: 18 }) as HTMLInputElement;
        i.value = name;
        on(i, "input", () => { name = i.value; });
        return i;
      })(),
    ]),
    el("button", { text: "Beitreten" }),
  ]);
  on(card.lastElementChild as HTMLButtonElement, "click", () => {
    if (!pin || pin.length < 4) { alert("Bitte PIN eingeben"); return; }
    if (!name.trim()) { alert("Bitte Namen eingeben"); return; }
    history.replaceState({}, "", `?pin=${pin}&name=${encodeURIComponent(name)}`);
    connect();
  });
  root.appendChild(card);
} else {
  connect();
}