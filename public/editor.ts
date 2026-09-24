import { el, on } from "./lib/dom";

type QuestionType =
  | "quiz" | "true_false" | "type_answer" | "slider" | "poll"
  | "multi_select" | "order" | "match_pairs" | "brainstorm" | "word_cloud"
  | "open_ended" | "dropdown" | "fill_blank" | "puzzle_drop" | "sequence"
  | "reaction" | "fastest_finger" | "estimate" | "color_match"
  | "classify" | "choose_two";

type Question = {
  id: string;
  type: QuestionType;
  text: string;
  imageUrl?: string;
  audioUrl?: string;
  videoUrl?: string;
  timeLimit: number;
  points: number;
  choices?: string[];
  correctIndex?: number;
  correctIndices?: number[];
  acceptedAnswers?: string[];
  referenceAnswer?: string;
  correctName?: string;
  sliderMin?: number;
  sliderMax?: number;
  sliderStep?: number;
  sliderCorrect?: number;
  sliderTolerance?: number;
  estimateUnit?: string;
  items?: string[];
  correctOrder?: number[];
  puzzleSlots?: string[];
  pairs?: Array<{ left: string; right: string }>;
  categories?: string[];
  correctBins?: Record<string, string>;
  hotspotX?: number;
  hotspotY?: number;
  hotspotRadius?: number;
  colors?: Array<{ hex: string; name: string }>;
  memoryLength?: number;
};

type Quiz = {
  id?: string;
  title: string;
  description?: string;
  coverColor?: string;
  questions: Question[];
};

const GLYPHS = ["\u25B2", "\u25C6", "\u25CF", "\u25A0"];
const COLORS = ["red", "blue", "green", "yellow"];

const TYPES: Array<[QuestionType, string, string]> = [
  ["quiz", "Quiz", "Bis zu 4 Antworten, eine korrekt"],
  ["true_false", "Wahr / Falsch", "Ja/Nein Frage"],
  ["multi_select", "Mehrfachauswahl", "Mehrere richtige Antworten"],
  ["choose_two", "Wähle 2", "2 von 4 Antworten richtig"],
  ["type_answer", "Tippen", "Spieler tippen eine kurze Antwort"],
  ["fill_blank", "Lückentext", "Ein-Wort Antwort"],
  ["slider", "Schieberegler", "Zahl auf einem Regler wählen"],
  ["estimate", "Schätzen", "Numerische Schätzung mit Toleranz"],
  ["order", "Reihenfolge", "Optionen in richtiger Reihenfolge ordnen"],
  ["sequence", "Sequenz", "Ereignisse in chronologischer Reihenfolge"],
  ["fastest_finger", "Schnellster Finger", "Nach Geschwindigkeit ordnen"],
  ["puzzle_drop", "Puzzle", "Teile in Schlitze legen"],
  ["match_pairs", "Paare zuordnen", "Linke mit rechten Seiten paaren"],
  ["classify", "Klassifizieren", "Elemente in Kategorien sortieren"],
  ["poll", "Umfrage", "Keine falsche Antwort"],
  ["brainstorm", "Brainstorming", "So viele Antworten wie möglich"],
  ["word_cloud", "Wortwolke", "Kurze Antworten, visualisiert"],
  ["open_ended", "Offene Frage", "Längere Textantwort"],
  ["dropdown", "Dropdown", "Aus Dropdown wählen"],
  ["reaction", "Reaktion", "Wer zuerst tippt, gewinnt"],
  ["color_match", "Farbe zuordnen", "Die richtige Farbe wählen"],
  ["audio_clip", "Audio-Clip", "Anhören, dann wählen"],
  ["video_clip", "Video-Clip", "Ansehen, dann wählen"],
  ["image_hotspot", "Bild-Hotspot", "Auf die richtige Stelle klicken"],
  ["memory", "Gedächtnis", "Sequenz wiederholen"],
];

const draft: Quiz = {
  title: "Unbenanntes Quiz",
  description: "",
  coverColor: "#46178f",
  questions: [newQuestion("quiz")],
};

// ---- Autosave: alle 5s in den Browser (localStorage), Restore nach Refresh ----
const AUTOSAVE_NEW_KEY = "kahootclone:editor:draft:new";
const autosaveKeyFor = (id?: string | null) =>
  id ? `kahootclone:editor:draft:${id}` : AUTOSAVE_NEW_KEY;
let autosaveLabel: HTMLElement | null = null;
let restoredFromAutosave = false;

function readAutosave(key: string): { savedAt: number; draft: Quiz } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.draft) return null;
    if (!Array.isArray(parsed.draft.questions)) return null;
    return parsed as { savedAt: number; draft: Quiz };
  } catch {
    return null;
  }
}

function currentAutosaveKey(): string {
  // Nach dem Speichern bekommt der Draft eine id -> unter dieser Key weiter sichern.
  return autosaveKeyFor(draft.id ?? new URLSearchParams(location.search).get("id"));
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

function updateAutosaveLabel(savedAt?: number) {
  if (!autosaveLabel) return;
  autosaveLabel.textContent = savedAt
    ? `Auto-Sicherung ${fmtTime(savedAt)} · lokal im Browser`
    : restoredFromAutosave
      ? "Lokale Auto-Sicherung wiederhergestellt"
      : "Auto-Speichern aktiv (alle 5 s, lokal)";
}

function writeAutosave() {
  try {
    const payload = JSON.stringify({ savedAt: Date.now(), draft });
    localStorage.setItem(currentAutosaveKey(), payload);
    // Nach Vergabe einer id vom alten "new"-Key umziehen, damit kein Stale-Draft bleibt.
    if (draft.id) {
      try {
        const stale = localStorage.getItem(AUTOSAVE_NEW_KEY);
        if (stale && currentAutosaveKey() !== AUTOSAVE_NEW_KEY) localStorage.removeItem(AUTOSAVE_NEW_KEY);
      } catch { /* ignore */ }
    }
    updateAutosaveLabel(Date.now());
  } catch {
    /* Quota voll o.ä. -> still weitermachen */
  }
}

function tryRestoreAutosave(): boolean {
  const params = new URLSearchParams(location.search);
  const editId = params.get("id");
  const snap = readAutosave(autosaveKeyFor(editId));
  if (!snap) return false;
  // Leeren Draft nicht über einen frischen Default schreiben lassen, wenn nichts drin ist.
  Object.assign(draft, snap.draft);
  restoredFromAutosave = true;
  updateAutosaveLabel(snap.savedAt);
  return true;
}

setInterval(writeAutosave, 5000);
window.addEventListener("beforeunload", writeAutosave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") writeAutosave();
});

function newQuestion(type: QuestionType = "quiz"): Question {
  const base: Question = {
    id: crypto.randomUUID(),
    type,
    text: "",
    timeLimit: type === "reaction" ? 30 : 20,
    points: type === "reaction" ? 2000 : 1000,
  };
  switch (type) {
    case "quiz":
    case "multi_select":
    case "choose_two":
      base.choices = ["", "", "", ""];
      base.correctIndex = type === "quiz" ? 0 : undefined;
      base.correctIndices = type !== "quiz" ? [0] : undefined;
      break;
    case "true_false":
      base.choices = ["True", "False"];
      base.correctIndex = 0;
      break;
    case "type_answer":
    case "fill_blank":
      base.acceptedAnswers = [""];
      break;
    case "slider":
    case "estimate":
      base.sliderMin = 0;
      base.sliderMax = 100;
      base.sliderStep = 1;
      base.sliderCorrect = 50;
      base.sliderTolerance = type === "estimate" ? 10 : 2;
      base.estimateUnit = type === "estimate" ? "" : undefined;
      break;
    case "poll":
    case "dropdown":
      base.choices = ["", "", "", ""];
      base.correctIndex = 0;
      break;
    case "order":
    case "sequence":
    case "fastest_finger":
      base.items = ["", "", "", ""];
      base.correctOrder = [0, 1, 2, 3];
      break;
    case "puzzle_drop":
      base.puzzleSlots = ["_", "_", "_", "_"];
      base.items = ["", "", "", ""];
      base.correctOrder = [0, 1, 2, 3];
      break;
    case "match_pairs":
      base.pairs = [{ left: "", right: "" }, { left: "", right: "" }];
      break;
    case "classify":
      base.items = ["", "", "", ""];
      base.categories = ["A", "B"];
      base.correctBins = {};
      break;
    case "brainstorm":
    case "word_cloud":
    case "open_ended":
    case "reaction":
      break;
    case "color_match":
      base.colors = [
        { hex: "#ff0000", name: "Red" },
        { hex: "#00ff00", name: "Green" },
        { hex: "#0000ff", name: "Blue" },
        { hex: "#ffff00", name: "Yellow" },
      ];
      break;
    case "audio_clip":
    case "video_clip":
      base.audioUrl = undefined;
      base.videoUrl = undefined;
      base.choices = ["", "", "", ""];
      base.correctIndex = 0;
      break;
    case "image_hotspot":
      base.imageUrl = "";
      base.hotspotX = 0.5;
      base.hotspotY = 0.5;
      base.hotspotRadius = 0.1;
      break;
    case "memory":
      base.memoryLength = 4;
      break;
  }
  return base;
}

const root = el("main", { className: "app editor-app" });
document.body.appendChild(el("div", { className: "topbar" }, [
  el("a", { className: "brand", href: "/", text: "KahootClone" }),
  el("div", { className: "row" }, [
    el("a", { href: "/", text: "Start" }),
    el("a", { href: "/library.html", text: "Meine Quizze" }),
    el("a", { href: "/editor.html", text: "Neu erstellen" }),
    el("a", { href: "/host.html", text: "Spiel hosten" }),
    el("a", { href: "/join.html", text: "Beitreten" }),
  ]),
]));
document.body.appendChild(root);

function render() {
  root.innerHTML = "";
  const heading = el("header", { className: "page-heading editor-heading" }, [
    el("div", { className: "col" }, [
      el("span", { className: "eyebrow", text: "Quiz-Studio" }),
      el("h1", { className: "title", text: draft.title || "Neues Quiz" }),
      el("p", { className: "subtitle", text: draft.description || "Noch keine Beschreibung" }),
    ]),
    el("div", { className: "spacer" }),
  ]);
  const aiBtn = el("button", { className: "ai-btn", text: "\u2728 KI generieren" });
  const deleteBtn = el("button", { className: "danger", text: "Quiz löschen" });
  const saveBtn = el("button", { text: "Quiz speichern" });
  const hostLink = el("a", { href: `host.html?quiz=${draft.id ?? ""}`, text: "Spiel hosten" });
  hostLink.classList.add("ghost", "button");
  deleteBtn.style.display = draft.id ? "" : "none";
  const actions = el("div", { className: "editor-actions" }, [aiBtn, hostLink, deleteBtn, saveBtn]);
  heading.append(actions);
  on(aiBtn, "click", openAIDialog);
  on(deleteBtn, "click", async () => {
    if (!draft.id) return;
    if (!confirm("Dieses Quiz wirklich löschen?")) return;
    await fetch(`/api/quizzes/${draft.id}`, { method: "DELETE" });
    try {
      localStorage.removeItem(currentAutosaveKey());
      localStorage.removeItem(AUTOSAVE_NEW_KEY);
    } catch { /* ignore */ }
    location.href = "/library.html";
  });
  on(saveBtn, "click", save);
  root.appendChild(heading);
  // Autosave-Statuszeile: zeigt an, dass alle 5s lokal gesichert + Restore möglich ist.
  const autosaveRow = el("div", { className: "row" }, [
    (autosaveLabel = el("span", { className: "small muted" })),
    el("div", { className: "spacer" }),
  ]);
  const discardBtn = el("button", { className: "ghost small", text: "Lokale Sicherung verwerfen" });
  on(discardBtn, "click", () => {
    if (!confirm("Lokale Auto-Sicherung verwerfen und neu laden?")) return;
    try { localStorage.removeItem(currentAutosaveKey()); } catch { /* ignore */ }
    location.reload();
  });
  autosaveRow.appendChild(discardBtn);
  root.appendChild(autosaveRow);
  updateAutosaveLabel();
  if (restoredFromAutosave) {
    const banner = el("div", { className: "card", style: "border-left:4px solid var(--good, #1bb13c)" }, [
      el("strong", { text: "Lokale Auto-Sicherung wiederhergestellt. " }),
      el("span", { className: "small", text: "Dein Stand von vor dem Refresh ist wieder da (wird alle 5 s lokal gesichert)." }),
    ]);
    root.appendChild(banner);
  }

  const meta = el("section", { className: "card col editor-meta" }, [
    el("span", { className: "eyebrow", text: "01 / Die Grundlagen" }),
    el("h2", { text: "Gib deinem Quiz einen Charakter." }),
  ]);
  const titleIn = el("input", { value: draft.title, placeholder: "Titel des Quiz" }) as HTMLInputElement;
  const descIn = el("input", { value: draft.description ?? "", placeholder: "Beschreibung (optional)" }) as HTMLInputElement;
  const row1 = el("div", { className: "row" });
  row1.append(
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Titel" }), titleIn]),
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Beschreibung" }), descIn])
  );
  meta.append(row1);
  on(titleIn, "input", () => {
    draft.title = titleIn.value;
    const t = heading.querySelector(".title");
    if (t) t.textContent = draft.title || "Neues Quiz";
  });
  on(descIn, "input", () => { draft.description = descIn.value; });

  const colorRow = el("div", { className: "row" }, [el("span", { className: "small muted", text: "Titel-Farbe:" })]);
  ["#46178f", "#ff8b00", "#1bb13c", "#1368ce", "#e21b3c", "#0aa"].forEach((c) => {
    const b = el("button", { className: `swatch${draft.coverColor === c ? " active" : ""}`, ariaLabel: `Titel-Farbe ${c}`, ariaPressed: String(draft.coverColor === c) });
    b.style.background = c;
    on(b, "click", () => { draft.coverColor = c; render(); });
    colorRow.appendChild(b);
  });
  meta.append(colorRow);
  root.appendChild(meta);

  const outline = el("nav", { className: "question-outline", ariaLabel: "Fragenübersicht" }, [
    el("span", { className: "eyebrow", text: `02 / ${draft.questions.length} Fragen` }),
  ]);
  draft.questions.forEach((q, i) => {
    outline.append(el("a", { className: "outline-link", href: `#question-${q.id}`, text: String(i + 1), title: q.text || `Frage ${i + 1}`, ariaLabel: `Zu Frage ${i + 1}` }));
  });
  root.append(outline);
  draft.questions.forEach((q, i) => {
    const qEl = el("section", { className: "question-editor col", id: `question-${q.id}` });
    const top = el("div", { className: "q-head" });
    top.append(
      el("h3", { text: `Frage ${i + 1}` }),
      el("div", { className: "spacer" }),
    );
    const typeSelect = el("select", { style: "width:auto" }) as HTMLSelectElement;
    TYPES.forEach(([v, label, hint]) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      opt.title = hint;
      if (v === q.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    on(typeSelect, "change", () => {
      const next = typeSelect.value as QuestionType;
      if (next === q.type) return;
      draft.questions[i] = newQuestion(next);
      render();
    });
    top.append(typeSelect);
    const removeBtn = el("button", { className: "ghost", text: "Entfernen" });
    on(removeBtn, "click", () => {
      draft.questions.splice(i, 1);
      if (draft.questions.length === 0) draft.questions.push(newQuestion());
      render();
    });
    top.append(removeBtn);
    qEl.append(top);

    const textIn = el("textarea", { value: q.text, placeholder: "Frage Text" }) as HTMLTextAreaElement;
    textIn.rows = 2;
    on(textIn, "input", () => { q.text = textIn.value; });
    qEl.append(textIn);

    if (q.type === "audio_clip" || q.type === "video_clip") {
      const mediaRow = el("div", { className: "row" });
      const mediaIn = el("input", { value: (q as any)[q.type === "audio_clip" ? "audioUrl" : "videoUrl"] ?? "", placeholder: "URL" }) as HTMLInputElement;
      on(mediaIn, "input", () => {
        if (q.type === "audio_clip") q.audioUrl = mediaIn.value;
        else q.videoUrl = mediaIn.value;
      });
      mediaRow.append(el("label", { className: "col", style: "flex:1" }, [
        el("span", { className: "small muted", text: q.type === "audio_clip" ? "Audio URL" : "Video URL" }),
        mediaIn,
      ]));
      qEl.append(mediaRow);
    }

    // Bild-URL: für jeden Fragetyp außer color_match (dort ersetzen die
    // Farbkacheln das Bild) — vorher gab es dieses Feld nur für 4 Spezialtypen,
    // obwohl Server/Host/Player q.imageUrl bei ALLEN Typen anzeigen.
    if (q.type !== "color_match") {
      const imgRow = el("div", { className: "row" });
      const imgIn = el("input", { value: q.imageUrl ?? "", placeholder: "https://..." }) as HTMLInputElement;
      on(imgIn, "input", () => { q.imageUrl = imgIn.value; });
      imgRow.append(el("label", { className: "col", style: "flex:1" }, [
        el("span", { className: "small muted", text: q.type === "image_hotspot" ? "Bild URL" : "Bild URL (optional)" }),
        imgIn,
      ]));
      qEl.append(imgRow);
    }

    const metaRow = el("div", { className: "row" });
    const tl = el("input", { value: String(q.timeLimit), type: "number", min: "5", max: "300" }) as HTMLInputElement;
    on(tl, "input", () => { q.timeLimit = Math.max(5, Number(tl.value) || 20); });
    const pts = el("input", { value: String(q.points), type: "number", min: "100", max: "5000", step: "100" }) as HTMLInputElement;
    on(pts, "input", () => { q.points = Math.max(100, Number(pts.value) || 1000); });
    metaRow.append(
      el("label", { className: "col" }, [el("span", { className: "small muted", text: "Zeitlimit (s)" }), tl]),
      el("label", { className: "col" }, [el("span", { className: "small muted", text: "Punkte" }), pts])
    );
    qEl.append(metaRow);

    renderTypeEditor(qEl, q);

    if (i === draft.questions.length - 1) {
      const addRow = el("div", { className: "row" });
      const add = el("button", { className: "ghost", text: "+ Frage hinzufügen" });
      on(add, "click", () => { draft.questions.push(newQuestion("quiz")); render(); });
      addRow.append(add);
      qEl.append(addRow);
    }

    root.appendChild(qEl);
  });
}

function renderTypeEditor(container: HTMLElement, q: Question) {
  switch (q.type) {
    case "quiz":
    case "dropdown": renderChoicesEditor(container, q, "single");
      break;
    case "multi_select":
    case "choose_two": renderChoicesEditor(container, q, "multi");
      break;
    case "true_false": renderTrueFalseEditor(container, q);
      break;
    case "type_answer":
    case "fill_blank": renderTextAnswerEditor(container, q);
      break;
    case "slider":
    case "estimate": renderSliderEditor(container, q);
      break;
    case "order":
    case "sequence":
    case "fastest_finger": renderOrderEditor(container, q);
      break;
    case "puzzle_drop": renderPuzzleEditor(container, q);
      break;
    case "match_pairs": renderMatchPairsEditor(container, q);
      break;
    case "classify": renderClassifyEditor(container, q);
      break;
    case "poll": renderPollEditor(container, q);
      break;
    case "color_match": renderColorEditor(container, q);
      break;
    case "open_ended": renderOpenEndedEditor(container, q);
      break;
    case "image_hotspot": renderHotspotEditor(container, q);
      break;
    case "memory": renderMemoryEditor(container, q);
      break;
    case "brainstorm":
    case "word_cloud":
    case "reaction":
    case "audio_clip":
    case "video_clip":
      container.append(el("p", { className: "muted small", text: "Keine Extra-Felder für diesen Typ." }));
      break;
  }
}

function renderChoicesEditor(container: HTMLElement, q: Question, mode: "single" | "multi") {
  q.choices = q.choices ?? ["", "", "", ""];
  q.choices.forEach((choice, ci) => {
    if (ci >= 6) return;
    const row = el("div", { className: "choice-edit" });
    const glyph = el("span", { className: `glyph-circle ${COLORS[ci % 4]}`, text: GLYPHS[ci % 4] });
    const input = el("input", { value: choice, placeholder: `Antwort ${ci + 1}` }) as HTMLInputElement;
    on(input, "input", () => { q.choices![ci] = input.value; });
    let markBtn;
    if (mode === "single") {
      markBtn = el("button", {
        className: q.correctIndex === ci ? "" : "ghost",
        text: q.correctIndex === ci ? "\u2713 correct" : "Mark correct",
      });
      on(markBtn, "click", () => { q.correctIndex = ci; render(); });
    } else {
      const checked = (q.correctIndices ?? []).includes(ci);
      markBtn = el("button", { className: checked ? "" : "ghost", text: checked ? "\u2713 correct" : "Mark correct" });
      on(markBtn, "click", () => {
        const set = new Set(q.correctIndices ?? []);
        if (set.has(ci)) set.delete(ci); else set.add(ci);
        q.correctIndices = Array.from(set).sort();
        render();
      });
    }
    row.append(glyph, input, markBtn);
    container.append(row);
  });
  if ((q.choices ?? []).length < 6) {
    const add = el("button", { className: "ghost small", text: "+ Antwort hinzufügen" });
    on(add, "click", () => { q.choices!.push(""); render(); });
    container.append(add);
  }
}

function renderTrueFalseEditor(container: HTMLElement, q: Question) {
  q.choices = q.choices ?? ["True", "False"];
  q.choices.forEach((choice, ci) => {
    const row = el("div", { className: "choice-edit" });
    const glyph = el("span", { className: `glyph-circle ${COLORS[ci]}`, text: GLYPHS[ci] });
    const input = el("input", { value: choice, placeholder: ci === 0 ? "Wahr-Label" : "Falsch-Label" }) as HTMLInputElement;
    on(input, "input", () => { q.choices![ci] = input.value; });
    const radio = el("button", { className: q.correctIndex === ci ? "" : "ghost", text: q.correctIndex === ci ? "\u2713 correct" : "Mark correct" });
    on(radio, "click", () => { q.correctIndex = ci; render(); });
    row.append(glyph, input, radio);
    container.append(row);
  });
}

function renderTextAnswerEditor(container: HTMLElement, q: Question) {
  q.acceptedAnswers = q.acceptedAnswers ?? [""];
  q.acceptedAnswers.forEach((ans, idx) => {
    const row = el("div", { className: "row" });
    const input = el("input", { value: ans, placeholder: `Akzeptierte Antwort ${idx + 1}` }) as HTMLInputElement;
    on(input, "input", () => { q.acceptedAnswers![idx] = input.value; });
    const rm = el("button", { className: "ghost", text: "Entfernen" });
    on(rm, "click", () => {
      q.acceptedAnswers!.splice(idx, 1);
      if (q.acceptedAnswers!.length === 0) q.acceptedAnswers!.push("");
      render();
    });
    row.append(input, rm);
    container.append(row);
  });
  const add = el("button", { className: "ghost", text: "+ Akzeptierte Schreibweise" });
  on(add, "click", () => { q.acceptedAnswers!.push(""); render(); });
  container.append(add);
}

function renderSliderEditor(container: HTMLElement, q: Question) {
  q.sliderMin = q.sliderMin ?? 0; q.sliderMax = q.sliderMax ?? 100;
  q.sliderStep = q.sliderStep ?? 1; q.sliderCorrect = q.sliderCorrect ?? 50;
  q.sliderTolerance = q.sliderTolerance ?? 2;
  const row1 = el("div", { className: "row" });
  const minIn = el("input", { type: "number", value: String(q.sliderMin) }) as HTMLInputElement;
  const maxIn = el("input", { type: "number", value: String(q.sliderMax) }) as HTMLInputElement;
  const stepIn = el("input", { type: "number", value: String(q.sliderStep), step: "0.1" }) as HTMLInputElement;
  on(minIn, "input", () => { q.sliderMin = Number(minIn.value); });
  on(maxIn, "input", () => { q.sliderMax = Number(maxIn.value); });
  on(stepIn, "input", () => { q.sliderStep = Number(stepIn.value) || 1; });
  row1.append(
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Min" }), minIn]),
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Max" }), maxIn]),
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Schritt" }), stepIn]),
  );
  container.append(row1);

  const row2 = el("div", { className: "row" });
  const correctIn = el("input", { type: "number", value: String(q.sliderCorrect), step: "0.1" }) as HTMLInputElement;
  const tolIn = el("input", { type: "number", value: String(q.sliderTolerance), step: "0.1", min: "0" }) as HTMLInputElement;
  on(correctIn, "input", () => { q.sliderCorrect = Number(correctIn.value); });
  on(tolIn, "input", () => { q.sliderTolerance = Math.max(0, Number(tolIn.value)); });
  row2.append(
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Richtige Antwort" }), correctIn]),
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Tolerance (\u00b1)" }), tolIn]),
  );
  if (q.type === "estimate") {
    const unitIn = el("input", { value: q.estimateUnit ?? "", placeholder: "Einheit (optional)" }) as HTMLInputElement;
    on(unitIn, "input", () => { q.estimateUnit = unitIn.value; });
    row2.append(el("label", { className: "col" }, [el("span", { className: "small muted", text: "Einheit" }), unitIn]));
  }
  container.append(row2);
}

function renderOrderEditor(container: HTMLElement, q: Question) {
  q.items = q.items ?? ["", "", "", ""];
  q.correctOrder = q.correctOrder ?? q.items.map((_, i) => i);
  const intro = el("p", { className: "muted small", text: "Elemente unten eingeben. Nummeriert 1, 2, 3... = richtige Reihenfolge." });
  container.append(intro);
  q.items.forEach((it, idx) => {
    const row = el("div", { className: "row" });
    const orderIn = el("input", { type: "number", value: String((q.correctOrder ?? []).indexOf(idx) + 1), min: "1", style: "max-width:80px" }) as HTMLInputElement;
    on(orderIn, "input", () => {
      const pos = Math.max(1, Number(orderIn.value) || 1) - 1;
      // Rebuild correctOrder: which one is at position pos?
      const order = (q.correctOrder ?? []).slice();
      const cur = order.indexOf(idx);
      if (cur >= 0) order.splice(cur, 1);
      order.splice(Math.min(pos, order.length), 0, idx);
      q.correctOrder = order;
    });
    const itemIn = el("input", { value: it, placeholder: `Element ${idx + 1}` }) as HTMLInputElement;
    on(itemIn, "input", () => { q.items![idx] = itemIn.value; });
    row.append(orderIn, itemIn);
    container.append(row);
  });
}

function renderPuzzleEditor(container: HTMLElement, q: Question) {
  q.puzzleSlots = q.puzzleSlots ?? ["_", "_", "_", "_"];
  q.items = q.items ?? ["", "", "", ""];
  q.correctOrder = q.correctOrder ?? q.items.map((_, i) => i);
  container.append(el("p", { className: "muted small", text: "Slots are the final arrangement (underscores for blanks). Items are the pieces." }));
  const slotsRow = el("div", { className: "row" });
  q.puzzleSlots.forEach((s, idx) => {
    const inp = el("input", { value: s, placeholder: "Schlitz " + (idx + 1), style: "max-width:80px" }) as HTMLInputElement;
    on(inp, "input", () => { q.puzzleSlots![idx] = inp.value; });
    slotsRow.append(inp);
  });
  container.append(el("label", { className: "small muted", text: "Schlitze (als Lücken)" }), slotsRow);
  const itemsRow = el("div", { className: "col" });
  q.items.forEach((it, idx) => {
    const row = el("div", { className: "row" });
    const slotIn = el("input", { type: "number", value: String((q.correctOrder ?? []).indexOf(idx) + 1), min: "1", style: "max-width:80px" }) as HTMLInputElement;
    on(slotIn, "input", () => {
      const pos = Math.max(1, Number(slotIn.value) || 1) - 1;
      const order = (q.correctOrder ?? []).slice();
      const cur = order.indexOf(idx);
      if (cur >= 0) order.splice(cur, 1);
      order.splice(Math.min(pos, order.length), 0, idx);
      q.correctOrder = order;
    });
    const itemIn = el("input", { value: it, placeholder: `Teil ${idx + 1}` }) as HTMLInputElement;
    on(itemIn, "input", () => { q.items![idx] = itemIn.value; });
    row.append(slotIn, itemIn);
    itemsRow.append(row);
  });
  container.append(el("label", { className: "small muted", text: "Teile (Zahl = welcher Schlitz)" }), itemsRow);
}

function renderMatchPairsEditor(container: HTMLElement, q: Question) {
  q.pairs = q.pairs ?? [{ left: "", right: "" }];
  q.pairs.forEach((p, idx) => {
    const row = el("div", { className: "row" });
    const left = el("input", { value: p.left, placeholder: "Links" }) as HTMLInputElement;
    const right = el("input", { value: p.right, placeholder: "Rechts" }) as HTMLInputElement;
    on(left, "input", () => { q.pairs![idx].left = left.value; });
    on(right, "input", () => { q.pairs![idx].right = right.value; });
    const rm = el("button", { className: "ghost", text: "Entfernen" });
    on(rm, "click", () => {
      q.pairs!.splice(idx, 1);
      if (q.pairs!.length === 0) q.pairs!.push({ left: "", right: "" });
      render();
    });
    row.append(left, right, rm);
    container.append(row);
  });
  const add = el("button", { className: "ghost", text: "+ Paar hinzufügen" });
  on(add, "click", () => { q.pairs!.push({ left: "", right: "" }); render(); });
  container.append(add);
}

function renderClassifyEditor(container: HTMLElement, q: Question) {
  q.items = q.items ?? ["", "", "", ""];
  q.categories = q.categories ?? ["A", "B"];
  q.correctBins = q.correctBins ?? {};
  const catRow = el("div", { className: "row" });
  q.categories.forEach((cat, idx) => {
    const inp = el("input", { value: cat, placeholder: `Kategorie ${idx + 1}`, style: "max-width:160px" }) as HTMLInputElement;
    on(inp, "input", () => { q.categories![idx] = inp.value; });
    catRow.append(inp);
  });
  const addCat = el("button", { className: "ghost", text: "+ Kat" });
  on(addCat, "click", () => { q.categories!.push(""); render(); });
  if (q.categories.length < 4) catRow.append(addCat);
  container.append(el("label", { className: "small muted", text: "Kategorien" }), catRow);

  q.items.forEach((it, idx) => {
    const row = el("div", { className: "row" });
    const itemIn = el("input", { value: it, placeholder: `Element ${idx + 1}` }) as HTMLInputElement;
    on(itemIn, "input", () => { q.items![idx] = itemIn.value; });
    const sel = el("select", { style: "max-width:160px" }) as HTMLSelectElement;
    q.categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      if (q.correctBins![it] === cat) opt.selected = true;
      sel.appendChild(opt);
    });
    on(sel, "change", () => { q.correctBins![it] = sel.value; });
    row.append(itemIn, sel);
    container.append(row);
  });
}

function renderPollEditor(container: HTMLElement, q: Question) {
  q.choices = q.choices ?? ["", "", "", ""];
  q.choices.forEach((choice, ci) => {
    if (ci >= 6) return;
    const row = el("div", { className: "choice-edit" });
    const glyph = el("span", { className: `glyph-circle ${COLORS[ci % 4]}`, text: GLYPHS[ci % 4] });
    const input = el("input", { value: choice, placeholder: `Option ${ci + 1}` }) as HTMLInputElement;
    on(input, "input", () => { q.choices![ci] = input.value; });
    row.append(glyph, input);
    container.append(row);
  });
  if ((q.choices ?? []).length < 6) {
    const add = el("button", { className: "ghost small", text: "+ Option hinzufügen" });
    on(add, "click", () => { q.choices!.push(""); render(); });
    container.append(add);
  }
}

function renderOpenEndedEditor(container: HTMLElement, q: Question) {
  container.append(el("p", { className: "muted small", text: "Die KI prüft Schülerantworten gegen deine Musterlösung (nur der Sinn zählt, Tippfehler sind OK). Ohne Musterlösung zählt jede Antwort ab 3 Zeichen." }));
  const inp = el("textarea", { placeholder: "Musterlösung, z. B. Ist hald so", rows: "3" }) as HTMLTextAreaElement;
  inp.value = q.referenceAnswer ?? "";
  on(inp, "input", () => { q.referenceAnswer = inp.value; });
  container.append(el("label", { className: "col" }, [
    el("span", { className: "small muted", text: "Musterlösung (richtige Antwort)" }),
    inp,
  ]));
}

function renderColorEditor(container: HTMLElement, q: Question) {  q.colors = q.colors ?? [{ hex: "#ff0000", name: "Red" }, { hex: "#00ff00", name: "Green" }, { hex: "#0000ff", name: "Blue" }, { hex: "#ffff00", name: "Yellow" }];
  q.colors.forEach((c, idx) => {
    const row = el("div", { className: "row" });
    const swatch = el("input", { type: "color", value: c.hex, style: "max-width:60px; height:40px; padding:0" }) as HTMLInputElement;
    const name = el("input", { value: c.name, placeholder: "Farbname" }) as HTMLInputElement;
    on(swatch, "input", () => { q.colors![idx].hex = swatch.value; });
    on(name, "input", () => { q.colors![idx].name = name.value; });
    row.append(swatch, name);
    container.append(row);
  });
  q.correctName = q.correctName ?? q.colors[0].name;
  const correctRow = el("div", { className: "row" });
  correctRow.append(el("span", { className: "small muted", text: "Richtige Farbe:" }));
  const correctSel = el("select") as HTMLSelectElement;
  q.colors.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = c.name;
    if (q.correctName === c.name) opt.selected = true;
    correctSel.appendChild(opt);
  });
  on(correctSel, "change", () => { q.correctName = correctSel.value; });
  correctRow.append(correctSel);
  container.append(correctRow);
}

function renderHotspotEditor(container: HTMLElement, q: Question) {
  q.hotspotX = q.hotspotX ?? 0.5;
  q.hotspotY = q.hotspotY ?? 0.5;
  q.hotspotRadius = q.hotspotRadius ?? 0.1;
  const preview = el("div", { className: "hotspot-preview" });
  preview.style.background = q.imageUrl ? `url(${q.imageUrl}) center/cover` : "#333";
  preview.style.position = "relative";
  preview.style.width = "100%";
  preview.style.height = "240px";
  preview.style.borderRadius = "8px";
  preview.style.overflow = "hidden";
  preview.style.cursor = "crosshair";
  const marker = el("div", { className: "hotspot-marker" });
  marker.style.position = "absolute";
  marker.style.width = "20px";
  marker.style.height = "20px";
  marker.style.borderRadius = "50%";
  marker.style.background = "var(--good)";
  marker.style.border = "2px solid white";
  marker.style.left = `calc(${q.hotspotX * 100}% - 10px)`;
  marker.style.top = `calc(${q.hotspotY * 100}% - 10px)`;
  preview.appendChild(marker);
  on(preview, "click", (e: MouseEvent) => {
    const rect = preview.getBoundingClientRect();
    q.hotspotX = (e.clientX - rect.left) / rect.width;
    q.hotspotY = (e.clientY - rect.top) / rect.height;
    marker.style.left = `calc(${q.hotspotX * 100}% - 10px)`;
    marker.style.top = `calc(${q.hotspotY * 100}% - 10px)`;
  });
  container.append(preview);
  const radiusIn = el("input", { type: "number", value: String(q.hotspotRadius), min: "0.01", max: "0.5", step: "0.01" }) as HTMLInputElement;
  on(radiusIn, "input", () => { q.hotspotRadius = Math.max(0.01, Number(radiusIn.value) || 0.1); });
  container.append(el("label", { className: "small", text: "Auf Bild klicken, um richtige Stelle zu setzen" }));
  container.append(el("label", { className: "small muted col", style: "margin-top:0.5rem" }, [
    el("span", { text: "Toleranzradius (0-1)" }),
    radiusIn,
  ]));
}

function renderMemoryEditor(container: HTMLElement, q: Question) {
  q.memoryLength = q.memoryLength ?? 4;
  const inp = el("input", { type: "number", value: String(q.memoryLength), min: "2", max: "10" }) as HTMLInputElement;
  on(inp, "input", () => { q.memoryLength = Math.max(2, Math.min(10, Number(inp.value) || 4)); });
  container.append(el("label", { className: "col" }, [el("span", { className: "small muted", text: "Sequenz-Länge" }), inp]));
}

async function save() {
  if (!draft.title) { alert("Bitte einen Titel angeben"); return; }
  for (const q of draft.questions) {
    if (!q.text && q.type !== "image_hotspot" && q.type !== "audio_clip" && q.type !== "video_clip") { alert("Jede Frage braucht einen Text"); return; }
    if (q.type === "quiz" || q.type === "true_false" || q.type === "dropdown" || q.type === "audio_clip" || q.type === "video_clip") {
      if ((q.choices ?? []).some((c) => !c.trim())) { alert("Jede Antwort braucht Text"); return; }
      if (q.correctIndex === undefined) { alert("Bitte eine richtige Antwort markieren"); return; }
    }
    if (q.type === "multi_select" || q.type === "choose_two") {
      if ((q.choices ?? []).some((c) => !c.trim())) { alert("Jede Antwort braucht Text"); return; }
      if (!(q.correctIndices ?? []).length) { alert("Mindestens eine richtige Antwort markieren"); return; }
    }
    if (q.type === "type_answer" || q.type === "fill_blank") {
      if ((q.acceptedAnswers ?? []).every((a) => !a.trim())) { alert("Mindestens eine akzeptierte Antwort hinzufügen"); return; }
    }
    if (q.type === "slider" || q.type === "estimate") {
      if ((q.sliderCorrect ?? 0) < (q.sliderMin ?? 0) || (q.sliderCorrect ?? 0) > (q.sliderMax ?? 100)) {
        alert("Richtige Antwort muss zwischen Min und Max liegen"); return;
      }
    }
    if (q.type === "order" || q.type === "sequence" || q.type === "fastest_finger") {
      if ((q.items ?? []).some((c) => !c.trim())) { alert("Alle Elemente brauchen Text"); return; }
    }
    if (q.type === "poll") {
      if ((q.choices ?? []).some((c) => !c.trim())) { alert("Jede Umfrage-Option braucht Text"); return; }
    }
    if (q.type === "match_pairs") {
      if ((q.pairs ?? []).some((p) => !p.left.trim() || !p.right.trim())) { alert("Jedes Paar braucht beide Seiten"); return; }
    }
  }
  const res = await fetch("/api/quizzes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!res.ok) { alert("Speichern fehlgeschlagen"); return; }
  const { id } = await res.json();
  draft.id = id;
  // Neue id -> Autosave-Key wechselt mit, alten "new"-Key aufräumen.
  try { localStorage.removeItem(AUTOSAVE_NEW_KEY); } catch { /* ignore */ }
  writeAutosave();
  alert("Quiz gespeichert");
  render();
}

async function openAIDialog() {
  const overlay = el("div", { className: "modal-overlay" });
  const card = el("div", { className: "modal-card" });
  overlay.appendChild(card);
  card.append(el("h2", { text: "\u2728 Quiz mit KI generieren" }));
  card.append(el("p", { className: "muted small", text: "Die KI erstellt ein Quiz auf Deutsch zu deinem Thema. Du kannst danach alles manuell anpassen." }));

  const topicInput = el("input", { placeholder: "Thema (z.B. \"Deutsche Hauptstädte\", \"Python Grundlagen\", \"Fußball-WM 2024\")" }) as HTMLInputElement;
  card.append(el("label", { className: "col" }, [
    el("span", { className: "small muted", text: "Thema" }),
    topicInput,
  ]));

  const row2 = el("div", { className: "row" });
  const countIn = el("input", { type: "number", value: "10", min: "3", max: "30", style: "max-width:120px" }) as HTMLInputElement;
  const diffSel = el("select", { style: "max-width:200px" }) as HTMLSelectElement;
  ["einfach", "mittel", "schwer"].forEach((d, i) => {
    const o = document.createElement("option");
    o.value = ["easy", "medium", "hard"][i];
    o.textContent = d;
    if (i === 1) o.selected = true;
    diffSel.appendChild(o);
  });
  row2.append(
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Anzahl Fragen" }), countIn]),
    el("label", { className: "col" }, [el("span", { className: "small muted", text: "Schwierigkeit" }), diffSel]),
  );
  card.append(row2);

  const status = el("p", { className: "muted small" });
  card.append(status);

  // Live-Vorschau: zeigt die Generierung in Echtzeit (Streaming).
  // Zwei Tabs: erkannte Fragen + roher JSON-Stream.
  const liveWrap = el("div", { className: "col", style: "display:none; max-height:420px; overflow:auto; gap:0.25rem" });
  const liveMeta = el("p", { className: "small muted" });
  // Fortschrittsbalken (reiner Text-Balken, kein extra CSS nötig)
  const progressBar = el("div", { className: "small muted", style: "font-family:monospace" });
  // Gedankengang des Modells (Reasoning kommt vor dem JSON, sonst stünde die UI still).
  const reasonDetails = el("details", { className: "small muted", style: "display:none" });
  const reasonSummary = el("summary", { text: "Gedankengang der KI (live)" });
  const reasonPre = el("pre", {
    className: "small",
    style: "margin:0.25rem 0 0; padding:0.5rem; background:#141414; color:#c9b8f0; border-radius:8px; max-height:140px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:monospace; font-size:11px",
  });
  reasonDetails.append(reasonSummary, reasonPre);
  const tabRow = el("div", { className: "row", style: "gap:0.5rem" });
  const tabQuestions = el("button", { className: "small", text: "Fragen" }) as HTMLButtonElement;
  const tabJson = el("button", { className: "ghost small", text: "{} JSON-Stream" }) as HTMLButtonElement;
  tabRow.append(tabQuestions, tabJson);
  const liveList = el("ol", { className: "small", style: "margin:0; padding-left:1.25rem" });
  const jsonPre = el("pre", {
    className: "small",
    style: "margin:0; padding:0.5rem; background:#141414; color:#9fe8a9; border-radius:8px; max-height:280px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:monospace; font-size:11px; display:none",
  });
  jsonPre.textContent = "// JSON-Stream erscheint hier live …";
  liveWrap.append(liveMeta, progressBar, reasonDetails, tabRow, liveList, jsonPre);
  card.append(liveWrap);

  function showLiveTab(which: "questions" | "json") {
    const showJson = which === "json";
    liveList.style.display = showJson ? "none" : "";
    jsonPre.style.display = showJson ? "" : "none";
    tabQuestions.className = showJson ? "ghost small" : "small";
    tabJson.className = showJson ? "small" : "ghost small";
  }
  on(tabQuestions, "click", () => showLiveTab("questions"));
  on(tabJson, "click", () => showLiveTab("json"));

  // Hängt rohe JSON-Token live an (autoscrollt, außer du bist hochgescrollt).
  function updateJsonView(raw: string) {
    const stick = jsonPre.scrollHeight - jsonPre.scrollTop - jsonPre.clientHeight < 80;
    jsonPre.textContent = raw;
    if (stick) jsonPre.scrollTop = jsonPre.scrollHeight;
  }

  const btnRow = el("div", { className: "row", style: "justify-content:flex-end; gap:0.5rem" });
  const cancel = el("button", { className: "ghost", text: "Abbrechen" });
  const go = el("button", { text: "Generieren" });
  btnRow.append(cancel, go);
  card.append(btnRow);

  document.body.appendChild(overlay);
  let aborted = false;
  const close = () => { aborted = true; overlay.remove(); };
  on(cancel, "click", close);
  on(overlay, "click", (e: MouseEvent) => { if (e.target === overlay) close(); });

  // Zieht aus dem partiellen JSON-Rohtext schon erkennbare Fragen für die Live-Anzeige.
  function previewPartial(raw: string, want: number, target: HTMLElement, meta: HTMLElement, bar: HTMLElement) {
    // Titel, sobald vorhanden
    const titleMatch = raw.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    // Alle erkannten Fragetexte + Typen (paarweise, soweit vorhanden)
    const texts = [...raw.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
      try { return JSON.parse(`"${m[1]}"`); } catch { return m[1].slice(0, 120); }
    });
    const types = [...raw.matchAll(/"type"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    target.innerHTML = "";
    const n = Math.max(texts.length, types.length);
    for (let i = 0; i < n; i++) {
      const li = document.createElement("li");
      li.textContent = `${types[i] ?? "?"}: ${(texts[i] ?? "…").slice(0, 120)}`;
      target.appendChild(li);
    }
    const title = titleMatch ? (() => { try { return JSON.parse(`"${titleMatch[1]}"`); } catch { return titleMatch[1]; } })() : "";
    meta.textContent = `${raw.length} Zeichen empfangen · ${n}/${want} Fragen erkannt${title ? ` · „${String(title).slice(0, 80)}"` : ""}`;
    const pct = Math.max(0, Math.min(1, n / want));
    const filled = Math.round(pct * 20);
    bar.textContent = `[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${Math.round(pct * 100)}%`;
  }

  function applyQuiz(quiz: Quiz, topic: string) {
    // Replace the draft (clears any existing questions and id)
    draft.id = undefined;
    draft.title = quiz.title || topic;
    draft.description = quiz.description || "";
    draft.questions = (quiz.questions ?? []).map((q) => normalizeImported(q));
    if (draft.questions.length === 0) draft.questions.push(newQuestion("quiz"));
    writeAutosave();
    close();
    render();
  }

  async function streamGenerate(topic: string, count: number, difficulty: string) {
    const res = await fetch("/api/ai/generate-quiz-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, count, difficulty }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";
    let streamRound = -1;
    let reasonText = "";
    let doneQuiz: Quiz | null = null;
    const showReasoning = (t: string) => {
      reasonText += t;
      // Lang: nur das Ende behalten, damit das DOM klein bleibt.
      const tail = reasonText.length > 4000 ? "…\n" + reasonText.slice(-4000) : reasonText;
      reasonDetails.style.display = "";
      reasonPre.textContent = tail;
      reasonPre.scrollTop = reasonPre.scrollHeight;
      if (!fullText) status.textContent = `KI denkt nach … (${reasonText.length} Zeichen Gedankengang, JSON folgt)`;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload) continue;
          let evt: any;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.type === "token" && typeof evt.text === "string") {
            const r = typeof evt.round === "number" ? evt.round : 0;
            if (r !== streamRound) {
              // Neue Tool-Runde: Zwischen-Text verwerfen, finale Antwort beginnt.
              streamRound = r;
              if (fullText) {
                fullText = "";
                liveList.innerHTML = "";
                updateJsonView("// Recherche fertig — finale Antwort läuft …");
              }
            }
            fullText += evt.text;
            previewPartial(fullText, count, liveList, liveMeta, progressBar);
            updateJsonView(fullText);
            status.textContent = `Generiere live … (${fullText.length} Zeichen JSON empfangen)`;
          } else if (evt.type === "tool") {
            const what = evt.kind === "images" ? "Bildersuche" : "Websuche";
            status.textContent = `Recherche (${what}): „${String(evt.query ?? "").slice(0, 80)}“ — ${evt.resultCount ?? 0} Treffer …`;
          } else if (evt.type === "reasoning" && typeof evt.text === "string") {
            showReasoning(evt.text);
          } else if (evt.type === "progress" && typeof evt.received === "number") {
            status.textContent = `Generiere live … (${evt.received}/${count} Fragen validiert, Versuch ${evt.attempt ?? 1})`;
          } else if (evt.type === "retry") {
            // Server startet automatisch eine neue Runde — Dialog bleibt offen,
            // bisheriger Stand bleibt per Auto-Save gesichert.
            fullText = "";
            liveList.innerHTML = "";
            updateJsonView(`// Versuch ${evt.round}/${evt.maxRounds}: ${evt.reason ?? "neuer Versuch"} …`);
            status.textContent = `Versuch ${evt.round}/${evt.maxRounds} — ${evt.reason ?? "neuer Versuch"} (automatisch, Entwurf ist gesichert)`;
          } else if (evt.type === "done" && evt.quiz) {
            doneQuiz = evt.quiz as Quiz;
            try { updateJsonView(JSON.stringify(doneQuiz, null, 2)); } catch { /* ignore */ }
            status.textContent = `Fertig! ${(doneQuiz.questions ?? []).length} Fragen übernommen.`;
          } else if (evt.type === "error") {
            throw new Error(evt.error ?? "Unbekannter Fehler");
          }
        }
      }
      if (aborted) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    if (aborted) throw new Error("aborted");
    if (!doneQuiz && fullText) {
      // Fallback: Stream endete ohne done-Event (z.B. Verbindung weg) — was an
      // JSON da ist, trotzdem retten statt alles zu verwerfen.
      try {
        const first = fullText.indexOf("{");
        const last = fullText.lastIndexOf("}");
        if (first >= 0 && last > first) {
          const parsed = JSON.parse(fullText.slice(first, last + 1)) as Quiz;
          if (parsed && typeof parsed.title === "string" && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
            doneQuiz = parsed;
            status.textContent = `Stream unvollständig, aber ${(parsed.questions ?? []).length} Fragen gerettet.`;
          }
        }
      } catch { /* kein valides JSON im Rest -> Fehler unten */ }
    }
    if (!doneQuiz) throw new Error("Kein Quiz empfangen (Stream abgebrochen?)");
    return doneQuiz;
  }

  on(go, "click", async () => {
    const topic = topicInput.value.trim();
    if (!topic) { status.textContent = "Bitte ein Thema eingeben."; return; }
    const count = Math.max(3, Math.min(30, Number(countIn.value) || 10));
    const difficulty = diffSel.value;
    go.disabled = true;
    (cancel as HTMLButtonElement).textContent = "Abbrechen";
    (cancel as HTMLButtonElement).disabled = false;
    liveWrap.style.display = "";
    liveList.innerHTML = "";
    jsonPre.textContent = "// JSON-Stream erscheint hier live …";
    jsonPre.scrollTop = 0;
    reasonDetails.style.display = "none";
    reasonPre.textContent = "";
    showLiveTab("json");
    status.textContent = "Verbinde mit KI (Live-Stream startet sofort)…";
    try {
      const quiz = await streamGenerate(topic, count, difficulty);
      applyQuiz(quiz, topic);
    } catch (e: any) {
      if (e?.message === "aborted") return;
      status.textContent = `Fehler: ${e?.message ?? e} — Tipp: Es nochmal versuchen, der Entwurf ist per Auto-Save gesichert.`;
      (go as HTMLButtonElement).disabled = false;
    }
  });
  topicInput.focus();
}

function normalizeImported(q: any): Question {
  const base = newQuestion(q.type ?? "quiz");
  if (q.text) base.text = q.text;
  if (q.imageUrl) base.imageUrl = q.imageUrl;
  if (q.audioUrl) base.audioUrl = q.audioUrl;
  if (q.videoUrl) base.videoUrl = q.videoUrl;
  if (typeof q.timeLimit === "number") base.timeLimit = q.timeLimit;
  if (typeof q.points === "number") base.points = q.points;
  if (Array.isArray(q.choices)) base.choices = q.choices;
  if (typeof q.correctIndex === "number") base.correctIndex = q.correctIndex;
  if (Array.isArray(q.correctIndices)) base.correctIndices = q.correctIndices;
  if (Array.isArray(q.acceptedAnswers)) base.acceptedAnswers = q.acceptedAnswers;
  if (typeof q.sliderMin === "number") base.sliderMin = q.sliderMin;
  if (typeof q.sliderMax === "number") base.sliderMax = q.sliderMax;
  if (typeof q.sliderStep === "number") base.sliderStep = q.sliderStep;
  if (typeof q.sliderCorrect === "number") base.sliderCorrect = q.sliderCorrect;
  if (typeof q.sliderTolerance === "number") base.sliderTolerance = q.sliderTolerance;
  if (typeof q.estimateUnit === "string") base.estimateUnit = q.estimateUnit;
  if (Array.isArray(q.items)) base.items = q.items;
  if (Array.isArray(q.correctOrder)) base.correctOrder = q.correctOrder;
  if (Array.isArray(q.puzzleSlots)) base.puzzleSlots = q.puzzleSlots;
  if (Array.isArray(q.pairs)) base.pairs = q.pairs;
  if (Array.isArray(q.categories)) base.categories = q.categories;
  if (q.correctBins && typeof q.correctBins === "object") base.correctBins = q.correctBins;
  if (typeof q.hotspotX === "number") base.hotspotX = q.hotspotX;
  if (typeof q.hotspotY === "number") base.hotspotY = q.hotspotY;
  if (typeof q.hotspotRadius === "number") base.hotspotRadius = q.hotspotRadius;
  if (Array.isArray(q.colors)) base.colors = q.colors;
  if (typeof q.correctName === "string") base.correctName = q.correctName;
  if (typeof q.referenceAnswer === "string") base.referenceAnswer = q.referenceAnswer;
  if (typeof q.memoryLength === "number") base.memoryLength = q.memoryLength;
  return base;
}

const params = new URLSearchParams(location.search);
const editId = params.get("id");
// 1) Sofort lokale Auto-Sicherung wiederherstellen (schützt vor versehentlichem Refresh,
//    z.B. beim Hochscrollen), damit nichts verloren geht.
const hadLocal = tryRestoreAutosave();
if (editId) {
  if (hadLocal) {
    // Lokalen Stand sofort zeigen; Server-Version nur als Fallback, falls lokal leer wäre.
    render();
    fetch(`/api/quizzes/${editId}`).then((r) => (r.ok ? r.json() : null)).then((q: Quiz | null) => {
      if (!q) return;
      // Server-Version NICHT über den lokalen Stand bügeln — der ist neuer (User-Eingabe).
      // Sie bleibt über "Lokale Sicherung verwerfen" erreichbar.
    }).catch(() => { /* offline o.ä. -> lokaler Stand reicht */ });
  } else {
    fetch(`/api/quizzes/${editId}`).then((r) => r.json()).then((q: Quiz) => {
      Object.assign(draft, q, { id: editId });
      writeAutosave();
      render();
    }).catch(() => render());
  }
} else {
  render();
}