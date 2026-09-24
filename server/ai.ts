import OpenAI from "openai";
import { ddgText, ddgImages } from "./search";

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "sk-or-v1-yourkeyhere";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free";
// Optional but recommended by OpenRouter: identify your app.
// Set OPENROUTER_SITE_URL / OPENROUTER_APP_NAME to get analytics + rankings.
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL ?? "";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME ?? "KahootClone";

// Official OpenAI SDK, pointed at OpenRouter (OpenAI-compatible API).
const client = new OpenAI({
  baseURL: OPENROUTER_BASE,
  apiKey: OPENROUTER_KEY,
  defaultHeaders: {
    ...(OPENROUTER_SITE_URL ? { "HTTP-Referer": OPENROUTER_SITE_URL } : {}),
    ...(OPENROUTER_APP_NAME ? { "X-Title": OPENROUTER_APP_NAME } : {}),
  },
  // No SDK-level retries: we handle 429 backoff ourselves.
  maxRetries: 0,
});

// Startup-Log: Modell + Key-Quelle (niemals den Key selbst loggen!).
if (!process.env.OPENROUTER_API_KEY) {
  console.warn("[quiz] WARN: OPENROUTER_API_KEY not set — using built-in fallback key. Set the env var in production!");
}
console.log(`[quiz] AI backend: model=${OPENROUTER_MODEL} base=${OPENROUTER_BASE}`);

export type GenQuestion = {
  id?: string;
  type: string;
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
  correctName?: string;
  memoryLength?: number;
};

export type GenQuiz = {
  title: string;
  description: string;
  questions: GenQuestion[];
};

const SYSTEM_PROMPT = `Du erstellst Kahoot-Quizze als valides JSON. Antworte NUR mit einem JSON-Objekt (kein Markdown, kein Kommentar).

Sämtliche sichtbaren Texte (Titel, Beschreibung, jeder Fragetext, jede Antwort, jede akzeptierte Eingabe, jede Musterlösung, jede Paar-Seite, jeder Kategorienname, jedes Item, jeder Farbname, jede Einheit) MÜSSEN auf DEUTSCH sein. Keine Mischsprache. Schreibe echte Umlaute (ä, ö, ü) — keine ae/oe/ue-Umschreibung. WICHTIG: Schweizer Rechtschreibung — NIEMALS ß, immer ss (z.B. Strasse, Fussball, gross).

KONTEXT — unbedingt beachten:
- Einsatzort: Schweiz. Bezüge zur Schweiz einbauen, wo sinnvoll (Kantone, Schweizer Städte/Flüsse/Berge, Schweizer Geschichte, Franken als Währung, Schweizer Alltag). Am Lehrplan 21 orientieren.
- Zielgruppe: Die Fragen haben das Niveau der Schweizer 4. Klasse (ca. 9-10 Jahre): kurze, einfache Sätze, geläufiger Wortschatz, keine Fremdwörter ohne Erklärung.
- Eingesetzt wird das Quiz in einer 6. Klasse (zur Wiederholung und Festigung) — der Schwierigkeitsgrad bleibt trotzdem 4.-Klass-Niveau: lieber zu leicht als zu schwer.
JSON-Schlüssel, Steuerwerte und "type"-Bezeichner bleiben Englisch.

RECHERCHE IST PFLICHT (Funktionsaufrufe — IMMER verwenden, bevor du das Quiz schreibst):
- Insgesamt stehen dir nur 2 Recherche-Aufrufe zur Verfügung — plane sie gezielt, nicht mehrfach dasselbe suchen.
- web_search(query, count): DuckDuckGo-Websuche für Fakten, Zahlen, Schweizer Bezüge (z.B. "Einwohner Zürich 2026"). Genau 1 Aufruf. Gefundene Fakten still verwenden (keine Quellenangaben im Quiz).
- web_image_search(query, count): Bildersuche, liefert direkte Bild-URLs. Genau 1 Aufruf. Mindestens 1 Frage bekommt ein imageUrl aus den Ergebnissen (gute Motive: Tiere, Orte, Karten, image_hotspot).
- BILD-REGELN: imageUrl NUR mit einer exakt zurückgegebenen BILD-URL befüllen (direkte .jpg/.png/.webp-URL bevorzugt). NIEMALS Bild-URLs raten, erfinden oder zusammenbauen — kein passendes Bild gefunden → imageUrl weglassen oder leer lassen.

Exakt diese Fragetypen mit exakt diesen Feldern (keine erfundenen Felder!):
- "quiz": { choices: [genau 4 Strings], correctIndex: 0..3 }
- "true_false": { choices: ["Wahr","Falsch"] ODER eigene Labels, correctIndex: 0 oder 1 }
- "dropdown": wie "quiz" (choices: [genau 4 Strings], correctIndex: 0..3)
- "multi_select": { choices: [3-5 Strings], correctIndices: [2 oder mehr gültige Indizes] }
- "choose_two": { choices: [genau 4 Strings], correctIndices: [genau 2 gültige Indizes] }
- "type_answer": { acceptedAnswers: [2-4 echte, gebräuchliche Schreibvarianten auf Deutsch] }
- "fill_blank": { acceptedAnswers: [1-3 Wörter, das eindeutig passende Wort für die Lücke] }
- "open_ended": { referenceAnswer: "Musterlösung in 1-2 Sätzen auf Deutsch (Schülerantworten werden von einer KI dagegen geprüft)" }
- "slider": { sliderMin, sliderMax (min < max), sliderStep, sliderCorrect (muss zwischen min und max liegen), sliderTolerance }
- "estimate": { sliderMin, sliderMax (min < max), sliderCorrect (muss zwischen min und max liegen), sliderTolerance, estimateUnit: "Einheit auf Deutsch" }
- "order": { items: [3-5 Strings in GEMISCHTER Reihenfolge], correctOrder: Permutation — correctOrder[Position] = Index in items, der an diese Position gehört }
- "sequence": wie order, Ereignisse in chronologischer Reihenfolge
- "fastest_finger": wie order, nach Geschwindigkeit sortierbar
- "puzzle_drop": { puzzleSlots: ["_" pro Buchstabe/Teil], items: [Einzelteile in GEMISCHTER Reihenfolge], correctOrder: correctOrder[Schlitz] = Index in items, der in diesen Schlitz gehört }
- "match_pairs": { pairs: [{left, right}, ...] (3-4 Paare, KEINE Synonyme, KEINE trivialen Paare — echte Wissenspaare wie Land→Hauptstadt) }
- "classify": { items: [4-6 Strings], categories: [2-3 Strings], correctBins: {jedes Item: exakt eine der categories} }
- "poll": { choices: [2-4 Strings] } (kein correctIndex, keine richtigen/falschen Antworten)
- "color_match": { colors: [3-4 verschiedene Farben als {hex:"#rrggbb", name:"Farbname auf Deutsch"}], correctName: MUSS exakt einer der Farbnamen aus colors sein }
- "memory": { memoryLength: 3-5 }
- "image_hotspot": { imageUrl: "" (leer lassen, ODER echte URL aus web_image_search), hotspotX: 0..1, hotspotY: 0..1, hotspotRadius: 0.05..0.2 }
- "audio_clip": { audioUrl: "" (leer lassen), choices: [genau 4 Strings], correctIndex: 0..3 }
- "video_clip": { videoUrl: "" (leer lassen), choices: [genau 4 Strings], correctIndex: 0..3 }
- "brainstorm": keine Extra-Felder
- "word_cloud": keine Extra-Felder
- "reaction": keine Extra-Felder

QUALITÄT — das ist der wichtigste Teil:
- Plane KURZ (max ~10 Stichpunkte im Kopf, keine seitenlangen Selbst-Checks), dann SOFORT das JSON. Nachdenken heisst ENTSCHEIDEN, nicht im Kreis fragen.
- correctIndex / correctIndices MÜSSEN auf die tatsächlich richtige(n) Antwort(en) zeigen. Prüfe jede Frage einzeln nach: Ist die markierte Antwort wirklich korrekt? Zeigt sie auf eine falsche Option, ist das Quiz kaputt.
- Stelle NIEMALS eine Frage, bei der keine der angebotenen Optionen korrekt ist. Erfinde keine Fakten: Wenn du dir bei Auswahlfragen unsicher bist, wähle ein Thema, das du sicher weißt.
- Distraktoren: plausibel, aber eindeutig falsch. Keine Scherzantworten.
- match_pairs: Paare müssen echtes Wissen abfragen (z.B. Begriff→Definition, Land→Hauptstadt). Keine Wort→Synonym-Paare.
- order/sequence: Items müssen eine eindeutige, unstrittige Reihenfolge haben. Keine vagen Items wie "Aufbau der Mauer".
- type_answer/fill_blank: Nur echte, existierende Wörter/Namen als akzeptierte Antworten. Keine erfundenen Begriffe.
- slider/estimate: Der korrekte Wert muss stimmen (bekannte Zahl) und strikt zwischen min und max liegen.
- open_ended: Die referenceAnswer muss die Frage wirklich beantworten.

timeLimit in Sekunden (5-60, eher 15-30). points 500-2000.

Mische bei 8+ Fragen mindestens 6 verschiedene Typen, darunter mindestens 2 interaktive aus: slider, estimate, order, match_pairs, puzzle_drop, classify, color_match, type_answer, open_ended.

Schema (strikt):
{
  "title": "...",
  "description": "...",
  "questions": [
    { "type": "quiz", "text": "...", "timeLimit": 20, "points": 1000,
      "choices": ["...","...","...","..."], "correctIndex": 0 }
  ]
}`;

const DIFFICULTY_HINT: Record<string, string> = {
  easy: "Schwierigkeit EINFACH (3.-Klass-Niveau, ca. 8-9 Jahre): Allgemeinwissen, offensichtliche Distraktoren, timeLimit 15-20, points 500-1000.",
  medium: "Schwierigkeit MITTEL (4.-Klass-Niveau, ca. 9-10 Jahre, Schweizer 4. Klasse): solides Grundschulwissen nach Lehrplan 21, realistische Distraktoren, timeLimit 15-25, points 800-1500.",
  hard: "Schwierigkeit ANSPRUCHSVOLL (starke 4.-Klässler, ca. 9-10 Jahre): kniffligere Distraktoren und Detailwissen, aber IMMER noch auf 4.-Klass-Niveau lösbar — nie Stoff der Oberstufe. timeLimit 20-30, points 1000-2000.",
};

function safeJsonParse<T>(raw: string): T | null {
  // Strip zero-width / invisible chars that the watermark injects inside JSON content.
  const stripped = raw
    .replace(/[\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/g, "")
    .replace(/\u00AD/g, "");
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : stripped;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < 0) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1)) as T;
  } catch {
    return null;
  }
}

function isGenQuiz(x: any): x is GenQuiz {
  return x && typeof x === "object" && typeof x.title === "string" && Array.isArray(x.questions) && x.questions.length > 0;
}

function normalize(q: GenQuestion): GenQuestion {
  // Ensure required defaults
  q.text = (q.text ?? "").trim();
  q.timeLimit = Math.max(5, Math.min(120, Number(q.timeLimit) || 20));
  q.points = Math.max(100, Math.min(3000, Number(q.points) || 1000));
  if (!q.id) q.id = crypto.randomUUID();
  return q;
}

const VALID_TYPES = new Set([
  "quiz", "true_false", "dropdown", "multi_select", "choose_two",
  "type_answer", "fill_blank", "open_ended", "slider", "estimate",
  "order", "sequence", "fastest_finger", "puzzle_drop", "match_pairs",
  "classify", "poll", "color_match", "memory", "image_hotspot",
  "audio_clip", "video_clip", "brainstorm", "word_cloud", "reaction",
]);

function isPermutation(arr: unknown, n: number): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== n || n === 0) return false;
  const seen = new Set<number>();
  for (const v of arr) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

function nonEmptyStrings(arr: unknown, min: number, max: number): arr is string[] {
  if (!Array.isArray(arr) || arr.length < min || arr.length > max) return false;
  return arr.every((s) => typeof s === "string" && s.trim().length > 0);
}

// Validates one generated question. Repairs what's safely repairable
// (clamping ranges, defaulting correctName), drops what's broken.
// Returns null if the question must be discarded.
function sanitizeQuestion(raw: any): GenQuestion | null {
  if (!raw || typeof raw !== "object" || !VALID_TYPES.has(raw.type)) return null;
  if (typeof raw.text !== "string" || raw.text.trim().length === 0) return null;
  const q: GenQuestion = { ...raw, text: raw.text.trim() };
  // URL-Felder: nur echte http(s)-URLs behalten (Schutz vor erfundenen Links —
  // das Modell darf nur Tool-erzeugte Bild-URLs verwenden).
  for (const k of ["imageUrl", "audioUrl", "videoUrl"] as const) {
    const v = (q as any)[k];
    if (typeof v !== "string" || !/^https?:\/\/\S+\.\S+/.test(v.trim())) {
      delete (q as any)[k];
    } else {
      (q as any)[k] = v.trim();
    }
  }

  switch (q.type) {
    case "quiz":
    case "dropdown":
    case "audio_clip":
    case "video_clip": {
      if (!nonEmptyStrings(q.choices, 2, 6)) return null;
      if (!Number.isInteger(q.correctIndex) || q.correctIndex! < 0 || q.correctIndex! >= q.choices!.length) return null;
      break;
    }
    case "true_false": {
      if (!nonEmptyStrings(q.choices, 2, 2)) {
        q.choices = ["Wahr", "Falsch"];
      }
      if (q.correctIndex !== 0 && q.correctIndex !== 1) return null;
      break;
    }
    case "multi_select": {
      if (!nonEmptyStrings(q.choices, 2, 6)) return null;
      if (!Array.isArray(q.correctIndices) || q.correctIndices.length === 0) return null;
      const ok = [...new Set(q.correctIndices)].filter((i) => Number.isInteger(i) && i >= 0 && i < q.choices!.length);
      if (ok.length === 0) return null;
      q.correctIndices = ok.sort((a, b) => a - b);
      break;
    }
    case "choose_two": {
      if (!nonEmptyStrings(q.choices, 4, 4)) return null;
      if (!Array.isArray(q.correctIndices)) return null;
      const ok = [...new Set(q.correctIndices)].filter((i) => Number.isInteger(i) && i >= 0 && i < 4);
      if (ok.length !== 2) return null;
      q.correctIndices = ok.sort((a, b) => a - b);
      break;
    }
    case "type_answer":
    case "fill_blank": {
      if (!Array.isArray(q.acceptedAnswers)) return null;
      q.acceptedAnswers = q.acceptedAnswers.filter((s) => typeof s === "string" && s.trim().length > 0);
      if (q.acceptedAnswers.length === 0) return null;
      break;
    }
    case "open_ended": {
      if (typeof q.referenceAnswer === "string") q.referenceAnswer = q.referenceAnswer.trim();
      if (!q.referenceAnswer) delete q.referenceAnswer; // optional: game falls back to length heuristic
      break;
    }
    case "slider":
    case "estimate": {
      let min = Number(q.sliderMin), max = Number(q.sliderMax);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      if (min === max) return null;
      if (min > max) [min, max] = [max, min];
      q.sliderMin = min;
      q.sliderMax = max;
      let correct = Number(q.sliderCorrect);
      if (!Number.isFinite(correct)) return null;
      q.sliderCorrect = Math.max(min, Math.min(max, correct));
      const step = Number(q.sliderStep);
      q.sliderStep = Number.isFinite(step) && step > 0 ? step : 1;
      const tol = Number(q.sliderTolerance);
      q.sliderTolerance = Number.isFinite(tol) && tol >= 0 ? tol : Math.max((max - min) / 20, 1);
      if (q.type === "estimate" && typeof q.estimateUnit !== "string") q.estimateUnit = "";
      break;
    }
    case "order":
    case "sequence":
    case "fastest_finger": {
      if (!nonEmptyStrings(q.items, 2, 8)) return null;
      if (!isPermutation(q.correctOrder, q.items.length)) return null;
      break;
    }
    case "puzzle_drop": {
      if (!nonEmptyStrings(q.items, 2, 12)) return null;
      if (!Array.isArray(q.puzzleSlots) || q.puzzleSlots.length !== q.items.length) return null;
      if (!isPermutation(q.correctOrder, q.items.length)) return null;
      break;
    }
    case "match_pairs": {
      if (!Array.isArray(q.pairs) || q.pairs.length < 2 || q.pairs.length > 5) return null;
      const lefts = new Set<string>();
      for (const p of q.pairs) {
        if (!p || typeof p.left !== "string" || typeof p.right !== "string") return null;
        if (!p.left.trim() || !p.right.trim()) return null;
        if (p.left.trim().toLowerCase() === p.right.trim().toLowerCase()) return null; // no synonym pairs
        if (lefts.has(p.left.trim().toLowerCase())) return null;
        lefts.add(p.left.trim().toLowerCase());
      }
      break;
    }
    case "classify": {
      if (!nonEmptyStrings(q.items, 2, 8)) return null;
      if (!nonEmptyStrings(q.categories, 2, 4)) return null;
      if (!q.correctBins || typeof q.correctBins !== "object") return null;
      for (const it of q.items) {
        if (!q.categories.includes(q.correctBins[it])) return null;
      }
      break;
    }
    case "poll": {
      if (!nonEmptyStrings(q.choices, 2, 6)) return null;
      delete q.correctIndex;
      delete (q as any).correctIndices;
      break;
    }
    case "color_match": {
      if (!Array.isArray(q.colors) || q.colors.length < 2 || q.colors.length > 6) return null;
      for (const c of q.colors) {
        if (!c || typeof c.hex !== "string" || typeof c.name !== "string") return null;
        if (!/^#[0-9a-fA-F]{6}$/.test(c.hex.trim())) return null;
        if (!c.name.trim()) return null;
      }
      // correctName MUST name one of the colors — repair by defaulting to the first.
      const match = q.colors.find((c) => c.name.trim().toLowerCase() === (q.correctName ?? "").trim().toLowerCase());
      q.correctName = (match ?? q.colors[0]).name;
      break;
    }
    case "memory": {
      const len = Number(q.memoryLength);
      q.memoryLength = Number.isFinite(len) ? Math.max(2, Math.min(10, Math.round(len))) : 4;
      break;
    }
    case "image_hotspot": {
      const cx = Number(q.hotspotX), cy = Number(q.hotspotY);
      q.hotspotX = Number.isFinite(cx) ? Math.max(0, Math.min(1, cx)) : 0.5;
      q.hotspotY = Number.isFinite(cy) ? Math.max(0, Math.min(1, cy)) : 0.5;
      const r = Number(q.hotspotRadius);
      q.hotspotRadius = Number.isFinite(r) ? Math.max(0.01, Math.min(0.5, r)) : 0.1;
      break;
    }
    case "brainstorm":
    case "word_cloud":
    case "reaction":
      break;
    default:
      return null;
  }
  return normalize(q);
}

function sanitizeQuiz(parsed: GenQuiz, wantCount: number): { quiz: GenQuiz; dropped: number } | null {
  if (!isGenQuiz(parsed)) return null;
  const questions: GenQuestion[] = [];
  let dropped = 0;
  for (const raw of parsed.questions) {
    // Gimmick-Typen, die in normale Wissens-Quizze (z.B. Harry Potter) nicht
    // passen, fliegen raus — auch wenn das Modell sie trotzdem liefert.
    // Der Repair-Loop füllt danach mit passenden Typen auf.
    if (raw && typeof raw === "object" && typeof raw.type === "string") {
      if (AI_BANNED_TYPES.has(raw.type)) {
        dropped++;
        continue;
      }
      if (raw.type === "image_hotspot") {
        const u = typeof raw.imageUrl === "string" ? raw.imageUrl.trim() : "";
        if (!/^https?:\/\/\S+\.\S+/.test(u)) {
          dropped++;
          continue;
        }
      }
      if ((raw.type === "audio_clip" || raw.type === "video_clip")) {
        dropped++;
        continue;
      }
    }
    const clean = sanitizeQuestion(raw);
    if (clean) questions.push(clean);
    else dropped++;
  }
  if (questions.length < Math.min(3, wantCount)) return null;
  return {
    quiz: {
      title: parsed.title.trim() || "Generiertes Quiz",
      description: typeof parsed.description === "string" ? parsed.description : "",
      questions: questions.slice(0, wantCount),
    },
    dropped,
  };
}

// Typen, die die KI nie generieren darf (Gimmicks ohne Wissensbezug bzw.
// Medien-Typen ohne echte URL). Im Editor bleiben sie manuell verfügbar.
const AI_BANNED_TYPES = new Set(["reaction", "color_match", "poll", "brainstorm", "word_cloud", "memory"]);

type ORMessage = { role: "system" | "user" | "assistant"; content: string };

function quizParams(messages: ORMessage[], temperature = 0.7, reasoning: "think" | "direct" = "think"): any {
  // Grosszügiges Thinking-Budget für tiefe Prüfung (korrekte Antworten,
  // Schema-Gültigkeit). Bei Bedarf hier anpassen.
  const THINKING_BUDGET = 100000;
  const direct = reasoning === "direct";
  return {
    model: OPENROUTER_MODEL,
    messages,
    temperature,
    // Reasoning-Budget: Grosszügig (100k), damit das Modell bei grossen Quizzen
    // genug Denktiefe hat. "direct" schaltet Reasoning ganz ab, verbietet Tools
    // explizit und deckelt die Antwortlänge (finale JSON-Antworten sind kurz).
    reasoning: direct ? { exclude: true } : { enabled: true, max_tokens: THINKING_BUDGET },
    ...(direct ? { tool_choice: "none" as const, max_tokens: 12000 } : {}),
    response_format: { type: "json_object" },
  };
}

async function callOpenRouter(messages: ORMessage[], jsonMode: boolean, temperature = 0.7, reasoning: "think" | "direct" = "think", timeoutMs = 120000): Promise<{ raw: string; assistantMsg: ORMessage } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const params = quizParams(messages, temperature, reasoning);
      if (!jsonMode) delete params.response_format;
      const res = await client.chat.completions.create(params, { timeout: timeoutMs });
      const raw: string = res.choices[0]?.message?.content ?? "";
      return { raw, assistantMsg: { role: "assistant", content: raw } };
    } catch (e: any) {
      if (e?.status === 429 && attempt < 2) {
        // Free-tier rate limit: back off and retry instead of falling back.
        const waitMs = 8000 * (attempt + 1);
        console.error(`OpenRouter rate-limited (429), retrying in ${waitMs}ms...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      console.error("OpenRouter error:", e?.status ?? "", (e?.message ?? String(e)).slice(0, 300));
      return null;
    }
  }
  return null;
}

function buildQuizPrompts(topic: string, wantCount: number, difficulty: "easy" | "medium" | "hard"): ORMessage[] {
  // Wichtig: Die Typen-Mischung darf der GENAUEN Fragenanzahl nie widersprechen,
  // sonst verweigert das Modell das JSON und stellt Rückfragen.
  // Nur THEMATISCH PASSENDE Wissens-Typen — keine Gimmicks (Buzzer, Farben…).
  const mixHint = wantCount >= 8
    ? "- 4-5 verschiedene, PASSENDE Typen aus: quiz, true_false, dropdown, multi_select, choose_two, type_answer, fill_blank, open_ended, slider, estimate, order, sequence, fastest_finger, match_pairs, classify, puzzle_drop."
    : `- ${Math.min(3, wantCount)} verschiedene, PASSENDE Typen aus derselben Liste.`;
  const bannedHint = `- VERBOTEN: reaction, color_match, poll, brainstorm, word_cloud, memory, audio_clip, video_clip. image_hotspot nur mit echter Bild-URL.
- Kein Typ ohne Sinn zum Thema (kein slider ohne Zahl, kein match ohne Paare).`; 
  const userPrompt = `Thema: ${topic}
Anzahl Fragen: GENAU ${wantCount} (nicht mehr, nicht weniger)
${DIFFICULTY_HINT[difficulty] ?? DIFFICULTY_HINT.medium}
Bedingungen:
- ALLE sichtbaren Texte MÜSSEN auf DEUTSCH sein. Keine Mischung.
${mixHint}
${bannedHint}
- Realistische Distraktoren. Halte Antworten kurz (1-4 Wörter).
- Für "type_answer"/"fill_blank" gib nur echte, existierende Wörter/Namen an (2-3 Varianten).
- Für "open_ended" IMMER eine referenceAnswer (Musterlösung) setzen.
- Für "slider"/"estimate" muss sliderCorrect zwischen min und max liegen.
- Keine URLs erfinden. imageUrl nur aus web_image_search, sonst weglassen.
- Prüfe vor dem Antworten jede Frage: Zeigt correctIndex/correctIndices wirklich auf die richtige Antwort? Gibt es bei Auswahlfragen mindestens eine korrekte Option?
- NIEMALS Rückfragen oder Erklärungen — antworte IMMER nur mit dem JSON-Objekt. Bei Unklarheit triff eine sinnvolle Annahme. Die genaue Fragenanzahl hat immer Vorrang.

Gib nur das JSON-Objekt zurück.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

// --- Streaming-Variante (OpenAI SDK): leitet Content-Token live weiter, damit der
// Editor die Generierung in Echtzeit anzeigen kann. Reasoning-Token (falls das Modell
// erst nachdenkt) werden separat gemeldet, damit die UI nicht stillsteht.
// Gibt am Ende das sanitizte Quiz zurück.
const qlog = (...args: unknown[]) => console.log("[quiz]", ...args);
const qerr = (...args: unknown[]) => console.error("[quiz]", ...args);
const fmtDur = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Wartet ms — aber bricht sofort ab, wenn der Client weg ist.
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted by client."));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Aborted by client."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type StreamOpts = {
  signal?: AbortSignal;
  onRetry?: (round: number, maxRounds: number, reason: string) => void;
  onTool?: (kind: "search" | "images", query: string, resultCount: number) => void;
};

// Recherche-Werkzeuge für das Modell (DuckDuckGo, ohne API-Key).
const QUIZ_TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Durchsucht das Web (DuckDuckGo) nach Fakten: aktuelle Zahlen, Schweizer Bezüge, Details die du nicht sicher weisst. Genau 1 Aufruf pro Quiz (insgesamt nur 2 Recherche-Aufrufe verfügbar).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Suchanfrage, z.B. \"Einwohner Zürich 2026\"" },
          count: { type: "number", description: "Trefferanzahl 1-5 (Standard 3)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_image_search",
      description: "Sucht Bilder im Web (DuckDuckGo/Wikimedia/Wikipedia). Gibt direkte Bild-URLs zurück für imageUrl-Felder. Genau 1 Aufruf, max 4 Bilder (insgesamt nur 2 Recherche-Aufrufe verfügbar). Nur bei Motiven die ein Bild aufwerten (Tiere, Orte, Karten, image_hotspot).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Bildsuchanfrage, z.B. \"Matterhorn\"" },
          count: { type: "number", description: "Bildanzahl 1-4 (Standard 3)" },
        },
        required: ["query"],
      },
    },
  },
];

async function execQuizTool(name: string, args: any): Promise<{ kind: "search" | "images"; query: string; content: string; count: number }> {
  // Einmaliger Retry bei transienten Netzwerkfehlern (z.B. DDG ECONNRESET).
  try {
    return await execQuizToolOnce(name, args);
  } catch (e) {
    qlog(`tool ${name}: first try failed (${(e as Error)?.message ?? e}), retrying once…`);
    await new Promise((r) => setTimeout(r, 2000));
    return await execQuizToolOnce(name, args);
  }
}

async function execQuizToolOnce(name: string, args: any): Promise<{ kind: "search" | "images"; query: string; content: string; count: number }> {
  if (name === "web_image_search") {
    const query = String(args?.query ?? "").slice(0, 200);
    const count = Math.max(1, Math.min(4, Number(args?.count) || 3));
    const hits = await ddgImages(query, count);
    const content = hits.length === 0
      ? "Keine Bilder gefunden — imageUrl leer lassen."
      : hits.map((h, i) => `${i + 1}. ${h.title}\n   BILD-URL: ${h.imageUrl}\n   Quelle: ${h.sourceUrl}`).join("\n").slice(0, 2000);
    return { kind: "images", query, content, count: hits.length };
  }
  // web_search (Default, auch bei unbekannten Namen: als Textsuche behandeln)
  const query = String(args?.query ?? "").slice(0, 200);
  const count = Math.max(1, Math.min(5, Number(args?.count) || 3));
  const hits = await ddgText(query, count);
  const content = hits.length === 0
    ? "Keine Treffer — Wissen aus Training verwenden."
    : hits.map((h, i) => `${i + 1}. ${h.title}\n   URL: ${h.url}\n   ${h.snippet}`).join("\n").slice(0, 2500);
  return { kind: "search", query, content, count: hits.length };
}

export async function generateQuizStream(
  topic: string,
  count = 10,
  difficulty: "easy" | "medium" | "hard" = "medium",
  onToken?: (text: string, full: string, round: number) => void,
  onProgress?: (validCount: number, attempt: number) => void,
  onReasoning?: (text: string) => void,
  opts?: StreamOpts,
): Promise<GenQuiz> {
  const wantCount = Math.max(3, Math.min(30, Math.round(count) || 10));
  const firstMessages = buildQuizPrompts(topic, wantCount, difficulty);

  const streamOnce = async (messages: ORMessage[], attempt: number, reasoning: "think" | "direct" = "think"): Promise<string> => {
    if (opts?.signal?.aborted) throw new Error("Aborted by client.");
    // Tools nur im Think-Modus (Repair/Direct sollen sofort JSON liefern).
    // 2 statt 3 Runden: jede Runde kostet ~10-25s Modell-Latenz — mit 2 Runden
    // bleibt die Pflicht-Recherche (1x Text, 1x Bild) drin, aber ohne die dritte,
    // meist nur noch "nice to have"-Runde, die die Generierung spürbar verlangsamt.
    const useTools = reasoning === "think";
    const MAX_TOOL_ROUNDS = 2;
    const msgs: any[] = [...messages];
    const t0 = Date.now();
    // Watchdog: Falls der Provider das Reasoning-Limit ignoriert und endlos
    // denkt, ohne je Content zu liefern → abbrechen statt ewig zu hängen.
    // Limit liegt über dem 100k-Token-Budget (~400k Zeichen), greift also nur
    // bei echten Endlosschleifen.
    const MAX_REASON_WITHOUT_CONTENT = 500000;
    let reasonChars = 0;
    let chunks = 0;
    let firstTokenAt = 0;
    let lastFull = "";

    for (let toolRound = 0; ; toolRound++) {
      // Eigener Controller pro Call: Loop-Guard UND Client-Abbruch können den
      // Upstream-Call sofort killen (stoppt auch den Token-Verbrauch).
      const localAc = new AbortController();
      const onClientAbort = () => localAc.abort();
      opts?.signal?.addEventListener("abort", onClientAbort, { once: true });
      const toolsOn = useTools && toolRound < MAX_TOOL_ROUNDS;
      // Sind die Tool-Runden aufgebraucht (Recherche fertig), muss das Modell JETZT
      // antworten — weiteres Reasoning bringt nichts mehr, kostet aber oft 20s+ für
      // fast keinen Content (beobachtet: 25s Denken → 49 Zeichen Output). Also wie
      // beim Repair: Reasoning aus, response_format erzwingt sofortiges JSON.
      const toolsExhausted = useTools && !toolsOn;
      const effectiveReasoning: "think" | "direct" = toolsExhausted ? "direct" : reasoning;
      qlog(`stream attempt ${attempt}${useTools ? ` tool-round ${toolRound}` : ""}: requesting model=${OPENROUTER_MODEL} (${msgs.length} messages, reasoning=${effectiveReasoning}, tools=${toolsOn ? "on" : "off"})…`);
      let stream;
      try {
        const params: any = { ...quizParams(msgs, 0.7, effectiveReasoning), stream: true };
        if (toolsOn) {
          params.tools = QUIZ_TOOLS;
          params.tool_choice = "auto";
          delete params.response_format; // JSON gilt erst für die finale Antwort
        }
        stream = await client.chat.completions.create(
          params,
          // Streaming braucht länger als ein einzelner Call (Tokens trudeln ein).
          // signal: Loop-Guard + Client-Abbruch stornieren den Upstream-Call sofort.
          { timeout: 180000, signal: localAc.signal },
        );
      } catch (e: any) {
        opts?.signal?.removeEventListener("abort", onClientAbort);
        qerr(`stream attempt ${attempt}: request failed after ${fmtDur(Date.now() - t0)}:`, (e?.message ?? String(e)).slice(0, 300));
        if (e?.status === 429) throw new Error("Rate-Limit (429): kurz warten und erneut versuchen.");
        throw new Error(`OpenRouter-Fehler ${e?.status ?? ""}: ${(e?.message ?? String(e)).slice(0, 200)}`);
      }
      let roundFull = "";
      let finishReason: string | null = null;
      let lastReport = 0;
      let lastTick = Date.now();
      let loopAborted = false;
      // Loop-Guard: wiederholt das Modell denselben Satz immer wieder
      // ("Now check ... replaced." x N), denkt es im Kreis und liefert nie JSON.
      // Sätze ab 15 Zeichen zählen, ab 4 Wiederholungen → sofort abbrechen und
      // per Direct-Repair zum Antworten zwingen.
      const MIN_SENTENCE_LEN = 15;
      const MAX_SENTENCE_REPEATS = 4;
      const sentCounts = new Map<string, number>();
      let sentCarry = "";
      const trackSentences = (t: string): string | null => {
        sentCarry += t;
        const parts = sentCarry.split(/(?<=[.!?\n])\s+/);
        sentCarry = parts.pop() ?? "";
        if (sentCarry.length > 500) sentCarry = sentCarry.slice(-500);
        for (const part of parts) {
          const sent = part.trim();
          if (sent.length < MIN_SENTENCE_LEN) continue;
          const c = (sentCounts.get(sent) ?? 0) + 1;
          sentCounts.set(sent, c);
          if (sentCounts.size > 2000) sentCounts.clear();
          if (c >= MAX_SENTENCE_REPEATS) return sent;
        }
        return null;
      };
      const pendingTools = new Map<number, { id: string; name: string; args: string }>();
      try {
        for await (const chunk of stream as AsyncIterable<any>) {
          chunks++;
          const choice = chunk?.choices?.[0] as any;
          if (choice?.finish_reason) finishReason = String(choice.finish_reason);
          const delta = choice?.delta as any;
          if (!delta) continue;
          // Tool-Aufrufe aufsammeln (kommen fragmentiert als Deltas).
          const tcDeltas = (delta as any).tool_calls as any[] | undefined;
          if (Array.isArray(tcDeltas)) {
            for (const tc of tcDeltas) {
              const idx = Number(tc?.index ?? 0);
              let p = pendingTools.get(idx);
              if (!p) {
                p = { id: "", name: "", args: "" };
                pendingTools.set(idx, p);
              }
              if (typeof tc?.id === "string" && tc.id) p.id = tc.id;
              if (typeof tc?.function?.name === "string" && tc.function.name) p.name = tc.function.name;
              if (typeof tc?.function?.arguments === "string") p.args += tc.function.arguments;
            }
          }
          // Reasoning-Modelle denken erst nach, bevor JSON kommt — weiterleiten,
          // damit der Client "Denkt nach…" statt Stille zeigen kann.
          if (typeof delta.reasoning === "string" && delta.reasoning) {
            reasonChars += delta.reasoning.length;
            onReasoning?.(delta.reasoning);
            const loopSent = !roundFull ? trackSentences(delta.reasoning) : null;
            if (loopSent) {
              qerr(`stream attempt ${attempt}: REPEATING reasoning ("${loopSent.slice(0, 80)}" x${MAX_SENTENCE_REPEATS}) after ${fmtDur(Date.now() - t0)} — forcing direct answer NOW.`);
              loopAborted = true;
              localAc.abort();
              break;
            }
            if (!roundFull && reasonChars > MAX_REASON_WITHOUT_CONTENT) {
              qerr(`stream attempt ${attempt}: REASONING LOOP detected (${reasonChars} chars thinking, 0 content) — aborting, will retry without reasoning.`);
              loopAborted = true;
              localAc.abort();
              break;
            }
          }
          const content: string = typeof delta.content === "string" ? delta.content : "";
          if (content) {
            if (!firstTokenAt) {
              firstTokenAt = Date.now();
              qlog(`stream attempt ${attempt}: first content token after ${fmtDur(firstTokenAt - t0)} (${reasonChars} reasoning chars before)`);
            }
            roundFull += content;
            onToken?.(content, roundFull, toolRound);
            if (Date.now() - lastTick > 15000) {
              lastTick = Date.now();
              qlog(`stream attempt ${attempt}: … ${roundFull.length} content chars / ${reasonChars} reasoning chars / ${chunks} chunks`);
            }
            // Zwischendurch grob zählen, wie viele valide Fragen schon erkennbar sind,
            // damit die UI "3/10 Fragen..." anzeigen kann.
            if (roundFull.length - lastReport > 1500) {
              lastReport = roundFull.length;
              const parsed = safeJsonParse<GenQuiz>(roundFull);
              if (parsed && Array.isArray(parsed.questions)) {
                let valid = 0;
                for (const raw of parsed.questions) {
                  // Fragen sind im Stream noch unvollständig -> nur zählen, was schon ok ist.
                  try { if (sanitizeQuestion(raw)) valid++; } catch { /* ignore */ }
                }
                onProgress?.(valid, attempt);
              }
            }
          }
        }
      } catch (e: any) {
        // Loop-Guard-Abbruch ist kein Fehler, sondern der gewollte Fast-Path
        // zum Direct-Repair. Echte Abbrüche behalten was da ist (wird geparst),
        // statt alles wegzuwerfen.
        if (loopAborted) {
          qlog(`stream attempt ${attempt}: loop aborted after ${fmtDur(Date.now() - t0)} at ${reasonChars} reasoning chars — going direct.`);
        } else {
          qerr(`stream attempt ${attempt}: INTERRUPTED after ${fmtDur(Date.now() - t0)} at ${roundFull.length} content chars:`, e?.message ?? e);
        }
      } finally {
        opts?.signal?.removeEventListener("abort", onClientAbort);
      }
      lastFull = roundFull;
      qlog(`stream attempt ${attempt} round ${toolRound}: finished in ${fmtDur(Date.now() - t0)} — ${roundFull.length} content chars, ${reasonChars} reasoning chars, ${chunks} chunks, finish_reason=${finishReason ?? "?"}, tool_calls=${pendingTools.size}`);
      if (finishReason === "length") {
        qerr(`stream attempt ${attempt}: CUT OFF by token limit (finish_reason=length) — output incomplete!`);
      }
      if (!roundFull && reasonChars > 0 && pendingTools.size === 0) {
        qerr(`stream attempt ${attempt}: NO content at all, only reasoning — model never emitted JSON!`);
      }

      // Keine Tool-Aufrufe (oder Limit erreicht, oder Tools waren aus) → finale Antwort steht.
      // Phantom-Calls bei tools=off werden IGNORIERT (Modell-/Provider-Macke), nie ausgeführt.
      if (pendingTools.size === 0 || !toolsOn || toolRound >= MAX_TOOL_ROUNDS) {
        if (pendingTools.size > 0) qlog(`stream attempt ${attempt}: ignoring ${pendingTools.size} unexpected tool call(s) (tools off/limit) — using content as-is.`);
        return lastFull;
      }
      // Tools parallel ausführen, Ergebnisse in den Verlauf, nächste Runde.
      const calls = [...pendingTools.values()].filter((c) => c.name);
      if (calls.length === 0) return lastFull;
      qlog(`stream attempt ${attempt}: executing ${calls.length} tool call(s)…`);
      const results = await Promise.all(calls.map(async (c) => {
        let parsed: any = {};
        try { parsed = JSON.parse(c.args || "{}"); } catch { /* ignore */ }
        try {
          const r = await execQuizTool(c.name, parsed);
          opts?.onTool?.(r.kind, r.query, r.count);
          qlog(`tool ${c.name} ("${r.query.slice(0, 60)}"): ${r.count} Treffer`);
          return { id: c.id, content: `${c.name}(${r.query}):\n${r.content}` };
        } catch (e: any) {
          qerr(`tool ${c.name} failed:`, e?.message ?? e);
          return { id: c.id, content: `${c.name}: Fehler (${e?.message ?? e}) — ohne Recherche fortfahren.` };
        }
      }));
      msgs.push({
        role: "assistant",
        content: roundFull || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
      });
      for (const r of results) msgs.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  };

  // Runden mit Backoff. Runde 1: mit Reasoning + Repair ohne Reasoning.
  // Folgerunden: komplett ohne Reasoning (schnell, billig).
  // Nur ein EXAKTES Ergebnis (wantCount Fragen, 0 verworfen) wird akzeptiert —
  // sonst wird neu versucht. Nach MAX_ROUNDS wird ein FEHLER geworfen
  // (kein Fake-Quiz mehr!), den der Client als Fehler anzeigt.
  qlog(`generateQuiz: topic="${topic}" want=${wantCount} difficulty=${difficulty} model=${OPENROUTER_MODEL}`);
  const MAX_ROUNDS = 3;
  let attemptNo = 0;
  let lastProblem = "Unbekannter Fehler.";
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (opts?.signal?.aborted) throw new Error("Aborted by client.");
    const modes: Array<"think" | "direct"> = round === 1 ? ["think", "direct"] : ["direct"];
    if (round > 1) {
      // Bei Rate-Limit deutlich länger warten (Free-Tier braucht ~20s+).
      const wasRateLimit = /429|rate-limit/i.test(lastProblem);
      const waitMs = wasRateLimit ? 20000 * (round - 1) : 5000 * (round - 1);
      qlog(`round ${round}/${MAX_ROUNDS} in ${waitMs}ms (last problem: ${lastProblem})`);
      opts?.onRetry?.(round, MAX_ROUNDS, lastProblem);
      await sleepAbortable(waitMs, opts?.signal);
    } else {
      qlog(`round 1/${MAX_ROUNDS}…`);
    }

    // Erster Versuch der Runde (+ Repair). Wirft bei 429/Netzfehler → wird
    // gefangen und löst automatisch die nächste Runde (mit Backoff) aus.
    try {
      const raw1 = await streamOnce(firstMessages, ++attemptNo, modes[0]);
    const parsed1 = safeJsonParse<GenQuiz>(raw1);
    qlog(`attempt ${attemptNo}: raw=${raw1.length} chars → parse ${parsed1 ? `OK (${parsed1.questions?.length ?? 0} raw questions)` : "FAILED"}`);
    const clean = parsed1 ? sanitizeQuiz(parsed1, wantCount) : null;
    qlog(`attempt ${attemptNo}: sanitize → ${clean ? `${clean.quiz.questions.length} valid / ${clean.dropped} dropped` : "INVALID (<3 valid)"}`);
    if (clean) {
      onProgress?.(clean.quiz.questions.length, attemptNo);
      if (clean.dropped === 0 && clean.quiz.questions.length === wantCount) {
        qlog(`attempt ${attemptNo}: PERFECT — ${wantCount}/${wantCount}.`);
        return clean.quiz;
      }
    }
    lastProblem = !clean
      ? "Kein gültiges Quiz-JSON erhalten."
      : clean.quiz.questions.length < wantCount
        ? `Nur ${clean.quiz.questions.length} von ${wantCount} Fragen gültig.`
        : `${clean.dropped} Fragen hatten Schemafehler.`;

    // Repair-Versuch der Runde (immer OHNE Reasoning: sofort JSON).
    qlog(`attempt ${attemptNo} unbrauchbar/ungenau (${lastProblem}) → repair WITHOUT reasoning…`);
    const raw2 = await streamOnce([
      ...firstMessages,
      ...(raw1 ? [{ role: "assistant", content: raw1 } as ORMessage] : []),
      {
        role: "user",
        content: `${lastProblem} Erstelle das Quiz NEU mit GENAU ${wantCount} vollständig gültigen Fragen. Nur thematisch passende Wissens-Typen — VERBOTEN: reaction, color_match, poll, brainstorm, word_cloud, memory, audio_clip, video_clip. Antworte SOFORT und NUR mit dem JSON-Objekt, ohne Nachdenken, ohne Erklärung.`,
      },
    ], ++attemptNo, "direct");
    const parsed2 = safeJsonParse<GenQuiz>(raw2);
    qlog(`attempt ${attemptNo}: raw=${raw2.length} chars → parse ${parsed2 ? `OK (${parsed2.questions?.length ?? 0} raw questions)` : "FAILED"}`);
    if (parsed2) {
      const clean2 = sanitizeQuiz(parsed2, wantCount);
      qlog(`attempt ${attemptNo}: sanitize → ${clean2 ? `${clean2.quiz.questions.length} valid / ${clean2.dropped} dropped` : "INVALID (<3 valid)"}`);
      if (clean2 && clean2.dropped === 0 && clean2.quiz.questions.length === wantCount) {
        onProgress?.(clean2.quiz.questions.length, attemptNo);
        qlog(`attempt ${attemptNo}: PERFECT — ${wantCount}/${wantCount}.`);
        return clean2.quiz;
      }
      lastProblem = !clean2
        ? "Repair lieferte kein gültiges Quiz-JSON."
        : `Repair: nur ${clean2.quiz.questions.length} von ${wantCount} Fragen gültig.`;
    } else {
      lastProblem = "Repair lieferte kein gültiges Quiz-JSON.";
    }
    } catch (e: any) {
      if (opts?.signal?.aborted || /aborted by client/i.test(e?.message ?? "")) throw e;
      // 429/Netzfehler → nächste Runde (Backoff oben, bei 429 länger).
      lastProblem = (e?.message ?? String(e)).slice(0, 160);
      qerr(`round ${round} failed with error — retrying: ${lastProblem}`);
    }
  }
  qerr(`FAILED after ${MAX_ROUNDS} rounds (${attemptNo} attempts): ${lastProblem}`);
  throw new Error(`KI hat nach ${MAX_ROUNDS} Versuchen kein gültiges Quiz geliefert (${lastProblem}) Bitte erneut versuchen.`);
}

export async function generateQuiz(topic: string, count = 10, difficulty: "easy" | "medium" | "hard" = "medium"): Promise<GenQuiz> {
  const wantCount = Math.max(3, Math.min(30, Math.round(count) || 10));
  const firstMessages = buildQuizPrompts(topic, wantCount, difficulty);
  const MAX_ROUNDS = 2;
  let lastProblem = "Unbekannter Fehler.";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const t0 = Date.now();
    qlog(`generateQuiz (non-stream) round ${round}/${MAX_ROUNDS}: topic="${topic}" want=${wantCount} difficulty=${difficulty} model=${OPENROUTER_MODEL}`);
    // Folgerunden ohne Reasoning: schneller, billiger.
    const mode: "think" | "direct" = round === 1 ? "think" : "direct";
    const attempt1 = await callOpenRouter(firstMessages, true, 0.7, mode);
    qlog(`non-stream attempt 1: ${attempt1 ? `${attempt1.raw.length} chars in ${fmtDur(Date.now() - t0)}` : "FAILED (null)"}`);
    if (attempt1) {
      const parsed = safeJsonParse<GenQuiz>(attempt1.raw);
      qlog(`non-stream attempt 1: parse ${parsed ? `OK (${parsed.questions?.length ?? 0} raw questions)` : "FAILED"}`);
      if (parsed) {
        const clean = sanitizeQuiz(parsed, wantCount);
        qlog(`non-stream attempt 1: sanitize → ${clean ? `${clean.quiz.questions.length} valid / ${clean.dropped} dropped` : "INVALID (<3 valid)"}`);
        if (clean && clean.dropped === 0 && clean.quiz.questions.length === wantCount) {
          qlog(`non-stream attempt 1: PERFECT — ${wantCount}/${wantCount}.`);
          return clean.quiz;
        }
        lastProblem = !clean
          ? "Ungültiges Quiz-JSON."
          : `${clean.quiz.questions.length}/${wantCount} Fragen gültig.`;
        // Repair (immer ohne Reasoning).
        const problem = !clean
          ? "Dein JSON war ungültig oder enthielt zu wenige gültige Fragen."
          : `${lastProblem} Beachte: correctIndex im Bereich der choices, referenceAnswer bei open_ended, correctOrder als echte Permutation, min < max und sliderCorrect dazwischen bei slider/estimate. VERBOTEN: reaction, color_match, poll, brainstorm, word_cloud, memory, audio_clip, video_clip — nur thematisch passende Wissens-Typen.`;
        const repair = await callOpenRouter([
          ...firstMessages,
          attempt1.assistantMsg,
          {
            role: "user",
            content: `${problem} Erstelle das Quiz NEU mit GENAU ${wantCount} vollständig gültigen Fragen. Antworte SOFORT und NUR mit dem JSON-Objekt, ohne Nachdenken, ohne Erklärung.`,
          },
        ], true, 0.7, "direct");
        if (repair) {
          const parsed2 = safeJsonParse<GenQuiz>(repair.raw);
          qlog(`non-stream repair: ${repair.raw.length} chars → parse ${parsed2 ? `OK (${parsed2.questions?.length ?? 0} raw questions)` : "FAILED"}`);
          if (parsed2) {
            const clean2 = sanitizeQuiz(parsed2, wantCount);
            qlog(`non-stream repair: sanitize → ${clean2 ? `${clean2.quiz.questions.length} valid / ${clean2.dropped} dropped` : "INVALID (<3 valid)"}`);
            if (clean2 && clean2.dropped === 0 && clean2.quiz.questions.length === wantCount) {
              qlog(`non-stream repair: PERFECT — ${wantCount}/${wantCount}.`);
              return clean2.quiz;
            }
            lastProblem = "Repair lieferte kein exaktes Quiz.";
          } else {
            lastProblem = "Repair lieferte kein gültiges JSON.";
            qerr("OpenRouter repair returned invalid JSON. Raw:", repair.raw.slice(0, 300));
          }
        } else {
          lastProblem = "Repair-Aufruf fehlgeschlagen.";
        }
      } else {
        lastProblem = "Ungültiges Quiz-JSON.";
        qerr("OpenRouter returned invalid JSON. Raw:", attempt1.raw.slice(0, 300));
      }
    } else {
      lastProblem = "KI-Aufruf fehlgeschlagen.";
    }
  }
  qerr(`non-stream: FAILED after ${MAX_ROUNDS} rounds: ${lastProblem}`);
  throw new Error(`KI hat nach ${MAX_ROUNDS} Versuchen kein gültiges Quiz geliefert (${lastProblem}) Bitte erneut versuchen.`);
}

const GRADE_SYSTEM = `Du bewertest Schülerantworten für ein Quiz. Der Ersteller des Quiz legt die einzig gültige Musterlösung fest. NUR diese Musterlösung zählt — nicht dein Weltwissen.

Regeln:
- Vergleiche die Schülerantwort NUR mit der Musterlösung des Erstellers.
- Kleine Tippfehler, andere Groß-/Kleinschreibung, zusätzliche Füllwörter ("keine Ahnung", "also", "ähm") oder andere Wortstellung sind OK, solange derselbe Kerngedanke wie in der Musterlösung steht.
- Eine faktisch richtige, aber ANDERS lautende Erklärung (anderer Kerngedanke als die Musterlösung) ist FALSCH. Beispiel: Musterlösung "Ist hald so" + Schülerantwort mit physikalischer Streuungserklärung => FALSCH.
- Leere oder völlig themenfremde Antworten sind FALSCH.
- Antworte NUR mit einem JSON-Objekt: {"correct": true} oder {"correct": false}.`;

// Grades a free-text answer against the host-set reference answer.
// Lenient on typos/filler words, strict on meaning: a factually correct but
// different statement than the reference counts as wrong.
export async function gradeOpenEnded(question: string, reference: string, given: string): Promise<boolean> {
  const ref = (reference ?? "").trim();
  const ans = (given ?? "").trim();
  if (!ref || !ans) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  // Fast path: exact (case-insensitive) match or reference contained verbatim.
  if (norm(ans) === norm(ref) || norm(ans).includes(norm(ref))) return true;
  try {
    // Grading ist eine triviale true/false-Entscheidung und läuft pro
    // Spielerantwort im Live-Spiel → ohne Reasoning (schnell & billig).
    // 15s Timeout: Hängt der Provider, antwortet die Heuristik statt den
    // Spieler (und alle anderen) zu blockieren.
    const attempt = await callOpenRouter([
      { role: "system", content: GRADE_SYSTEM },
      {
        role: "user",
        content: `Frage: ${question}\nMusterlösung des Erstellers: ${ref}\nSchülerantwort: ${ans}\n\nGib nur das JSON-Objekt zurück.`,
      },
    ], true, 0, "direct", 15000);
    if (!attempt) return norm(ans).includes(norm(ref));
    const parsed = safeJsonParse<{ correct?: unknown }>(attempt.raw);
    return parsed?.correct === true;
  } catch (e) {
    console.error("OpenRouter grade call failed:", e);
    return norm(ans).includes(norm(ref));
  }
}
