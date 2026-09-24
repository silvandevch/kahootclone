#!/usr/bin/env bun
import { saveQuiz } from "./db";
import type { Question } from "./types";

function mk(o: Partial<Question> & Pick<Question, "type" | "text">): Question {
  return {
    id: crypto.randomUUID(),
    timeLimit: 20,
    points: 1000,
    ...o,
  };
}

const questions: Question[] = [
  mk({ type: "quiz", text: "Welches HTML-Element hält JavaScript-Code?", choices: ["<script>", "<style>", "<link>", "<meta>"], correctIndex: 0 }),
  mk({ type: "true_false", text: "CSS steht für \"Computer Style System\".", choices: ["Wahr", "Falsch"], correctIndex: 1 }),
  mk({ type: "type_answer", text: "Wie heißt die HTTP-Methode zum Abrufen einer Ressource?", acceptedAnswers: ["get", "fetch"], timeLimit: 30 }),
  mk({ type: "slider", text: "In welchem Jahr wurde das erste iPhone veröffentlicht?", sliderMin: 2000, sliderMax: 2010, sliderStep: 1, sliderCorrect: 2007, sliderTolerance: 1, timeLimit: 25 }),
  mk({ type: "poll", text: "Was ist dein Lieblings-Frontend-Framework?", choices: ["React", "Vue", "Svelte", "Solid"], timeLimit: 15 }),
  mk({ type: "multi_select", text: "Welche Zahlen sind Primzahlen?", choices: ["2", "4", "7", "9"], correctIndices: [0, 2] }),
  mk({ type: "order", text: "Sortiere diese Ereignisse in chronologischer Reihenfolge", items: ["Gründung Roms", "Kolumbus segelt", "Mondlandung", "iPhone-Start"], correctOrder: [0, 1, 2, 3] }),
  mk({ type: "match_pairs", text: "Ordne jedes Land seiner Hauptstadt zu", pairs: [{ left: "Frankreich", right: "Paris" }, { left: "Japan", right: "Tokio" }, { left: "Brasilien", right: "Brasília" }] }),
  mk({ type: "brainstorm", text: "Nenne so viele Farben wie möglich in 20 Sekunden", timeLimit: 20, points: 1500 }),
  mk({ type: "open_ended", text: "Warum ist der Himmel blau?", timeLimit: 60, referenceAnswer: "Weil die Erdatmosphäre das blaue Sonnenlicht stärker streut (Rayleigh-Streuung)" }),
  mk({ type: "dropdown", text: "Welcher ist der größte Planet?", choices: ["Merkur", "Venus", "Jupiter", "Mars"], correctIndex: 2 }),
  mk({ type: "fill_blank", text: "Die Hauptstadt von Frankreich ist ____", acceptedAnswers: ["paris"], timeLimit: 25 }),
  mk({ type: "puzzle_drop", text: "Setze das Wort zusammen", puzzleSlots: ["_", "_", "_", "_", "_"], items: ["h", "a", "l", "l", "o"], correctOrder: [0, 1, 2, 3, 4] }),
  mk({ type: "sequence", text: "Sortiere diese Zahlen aufsteigend", items: ["9", "2", "5", "1"], correctOrder: [3, 1, 2, 0] }),
  mk({ type: "reaction", text: "Tippe SOFORT, wenn du ein blaues Quadrat siehst!", timeLimit: 30, points: 2000 }),
  mk({ type: "fastest_finger", text: "Sortiere nach Geschwindigkeit (schnellste zuerst)", items: ["Gepard", "Faultier", "Pferd", "Falke"], correctOrder: [0, 3, 2, 1] }),
  mk({ type: "estimate", text: "Wie viele Knochen hat ein erwachsener Mensch?", sliderMin: 100, sliderMax: 400, sliderCorrect: 206, sliderTolerance: 10, estimateUnit: "Knochen", timeLimit: 30 }),
  mk({ type: "color_match", text: "Welche Farbe ist das?", colors: [{ hex: "#ff0000", name: "Rot" }, { hex: "#00ff00", name: "Grün" }, { hex: "#0000ff", name: "Blau" }, { hex: "#ffff00", name: "Gelb" }], correctName: "Rot" }),
  mk({ type: "classify", text: "Sortiere in Tiere und Fahrzeuge", items: ["Hund", "Auto", "Katze", "Fahrrad"], categories: ["Tier", "Fahrzeug"], correctBins: { Hund: "Tier", Auto: "Fahrzeug", Katze: "Tier", Fahrrad: "Fahrzeug" } } as any),
  mk({ type: "choose_two", text: "Welche sind Früchte?", choices: ["Apfel", "Karotte", "Banane", "Kartoffel"], correctIndices: [0, 2] }),
];

const sample = {
  title: "Mega-Demo: 20 Fragetypen",
  description: "Alle 25 unterstützten Typen in einem Quiz.",
  coverColor: "#46178f",
  questions,
};

const id = saveQuiz(sample);
console.log("seeded:", id, "with", questions.length, "questions");