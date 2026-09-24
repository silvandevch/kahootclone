import { Database } from "bun:sqlite";
import type { Quiz } from "./types";

const db = new Database(process.env.DATABASE_PATH ?? "data/kahoot.db", { create: true });

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA cache_size = -8192;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA mmap_size = 268435456;");

db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    coverColor TEXT,
    data TEXT NOT NULL,
    questionCount INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    plays INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quizId TEXT NOT NULL,
    playedAt INTEGER NOT NULL,
    players INTEGER NOT NULL
  );
`);

// CREATE TABLE IF NOT EXISTS lässt eine bereits existierende, ältere Tabelle
// unverändert — fehlende Spalten (z.B. aus einer Zeit vor questionCount/plays)
// müssen daher per ALTER TABLE nachgezogen werden, bevor die Indizes unten
// darauf zugreifen.
const existingQuizColumns = new Set((db.prepare(`PRAGMA table_info(quizzes)`).all() as Array<{ name: string }>).map((c) => c.name));
if (!existingQuizColumns.has("questionCount")) {
  db.exec(`ALTER TABLE quizzes ADD COLUMN questionCount INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE quizzes SET questionCount = (
    SELECT COUNT(*) FROM json_each(json_extract(data, '$.questions'))
  ) WHERE questionCount = 0`);
}
if (!existingQuizColumns.has("plays")) {
  db.exec(`ALTER TABLE quizzes ADD COLUMN plays INTEGER NOT NULL DEFAULT 0`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_quizzes_createdAt ON quizzes(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_quizzes_plays ON quizzes(plays DESC);
  CREATE INDEX IF NOT EXISTS idx_plays_quizId ON plays(quizId);
`);

const stmtSaveQuiz = db.prepare(`
  INSERT OR REPLACE INTO quizzes (id, title, description, coverColor, data, questionCount, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetQuiz = db.prepare(`SELECT data FROM quizzes WHERE id = ?`);

const stmtListQuizzes = db.prepare(`
  SELECT id, title, description, coverColor, questionCount, createdAt, plays
  FROM quizzes
  ORDER BY createdAt DESC
`);

const stmtDeleteQuiz = db.prepare(`DELETE FROM quizzes WHERE id = ?`);

const stmtRecordPlayQuiz = db.prepare(`UPDATE quizzes SET plays = plays + 1 WHERE id = ?`);
const stmtRecordPlayInsert = db.prepare(`INSERT INTO plays (quizId, playedAt, players) VALUES (?, ?, ?)`);

const stmtGetQuizMeta = db.prepare(`SELECT id, title, questionCount FROM quizzes WHERE id = ?`);

export function saveQuiz(quiz: Quiz): string {
  const id = quiz.id ?? crypto.randomUUID();
  const questionCount = quiz.questions.length;
  stmtSaveQuiz.run(
    id,
    quiz.title,
    quiz.description ?? "",
    quiz.coverColor ?? "#46178f",
    JSON.stringify(quiz),
    questionCount,
    Date.now()
  );
  return id;
}

export function getQuiz(id: string): Quiz | null {
  const row = stmtGetQuiz.get(id) as { data: string } | null;
  if (!row) return null;
  return JSON.parse(row.data);
}

export function getQuizMeta(id: string): { id: string; title: string; questionCount: number } | null {
  return stmtGetQuizMeta.get(id) as { id: string; title: string; questionCount: number } | null;
}

export function listQuizzes(): Array<{
  id: string;
  title: string;
  description: string;
  coverColor: string;
  questionCount: number;
  plays: number;
  createdAt: number;
}> {
  return stmtListQuizzes.all() as Array<{
    id: string;
    title: string;
    description: string;
    coverColor: string;
    questionCount: number;
    plays: number;
    createdAt: number;
  }>;
}

export function deleteQuiz(id: string): void {
  stmtDeleteQuiz.run(id);
}

export function recordPlay(quizId: string, players: number): void {
  const t = Date.now();
  stmtRecordPlayQuiz.run(quizId);
  stmtRecordPlayInsert.run(quizId, t, players);
}

const txRecordPlay = db.transaction((quizId: string, players: number) => {
  const t = Date.now();
  stmtRecordPlayQuiz.run(quizId);
  stmtRecordPlayInsert.run(quizId, t, players);
});

export function recordPlayTx(quizId: string, players: number): void {
  txRecordPlay(quizId, players);
}