export type WSEvent =
  | { type: "ping" }
  | { type: "host:create-quiz"; quiz: Quiz }
  | { type: "host:start-game"; pin: string }
  | { type: "host:next-question"; pin: string }
  | { type: "host:reveal"; pin: string }
  | { type: "host:show-leaderboard"; pin: string }
  | { type: "host:show-results"; pin: string }
  | { type: "host:end-game"; pin: string }
  | { type: "host:kick"; pin: string; playerId: string }
  | { type: "host:rename"; pin: string; playerId: string; name: string }
  | { type: "player:join"; pin: string; name: string }
  | { type: "player:rename"; pin: string; name: string }
  | { type: "player:answer"; pin: string; questionIndex: number; answer: PlayerAnswer }
  | { type: "player:buzz"; pin: string; questionIndex: number }
  | { type: "host:create-room"; pin: string };

export type PlayerAnswer =
  | { kind: "choice"; choice: number }
  | { kind: "multi"; choices: number[] }
  | { kind: "text"; text: string }
  | { kind: "words"; words: string[] }
  | { kind: "order"; order: number[] }
  | { kind: "match"; pairs: Record<string, string> }
  | { kind: "puzzle"; slots: number[] }
  | { kind: "classify"; bins: Record<string, string> }
  | { kind: "hotspot"; x: number; y: number }
  | { kind: "color"; hex: string }
  | { kind: "memory"; sequence: number[] }
  | { kind: "react" };

export type QuestionType =
  | "quiz"
  | "true_false"
  | "type_answer"
  | "slider"
  | "poll"
  | "multi_select"
  | "order"
  | "match_pairs"
  | "brainstorm"
  | "word_cloud"
  | "open_ended"
  | "dropdown"
  | "fill_blank"
  | "puzzle_drop"
  | "sequence"
  | "reaction"
  | "fastest_finger"
  | "estimate"
  | "audio_clip"
  | "video_clip"
  | "image_hotspot"
  | "color_match"
  | "memory"
  | "classify"
  | "choose_two";

export type Question = {
  id: string;
  type: QuestionType;
  text: string;
  imageUrl?: string;
  audioUrl?: string;
  videoUrl?: string;
  timeLimit: number;
  points: number;

  // Quiz / true_false / dropdown / choose_two / multi_select
  choices?: string[];
  correctIndex?: number;
  correctIndices?: number[];

  // Type answer / fill_blank
  acceptedAnswers?: string[];

  // Open-ended: host-set reference answer; AI grades student texts against it
  referenceAnswer?: string;

  // Slider / estimate
  sliderMin?: number;
  sliderMax?: number;
  sliderStep?: number;
  sliderCorrect?: number;
  sliderTolerance?: number;
  estimateUnit?: string;

  // Order / sequence / fastest_finger / puzzle_drop
  // For order/sequence/fastest_finger: items[] is the unsorted set; correctOrder is the indices in correct order
  items?: string[];
  correctOrder?: number[];
  // For puzzle_drop: items[] are the pieces; correctOrder is where each piece belongs
  puzzleSlots?: string[];

  // Match pairs / classify
  pairs?: Array<{ left: string; right: string }>;
  categories?: string[];

  // Image hotspot
  hotspotX?: number;
  hotspotY?: number;
  hotspotRadius?: number;

  // Color match
  colors?: Array<{ hex: string; name: string }>;
  correctName?: string;

  // Memory
  memoryLength?: number;
};

export type Quiz = {
  id?: string;
  title: string;
  description?: string;
  coverColor?: string;
  questions: Question[];
};

export type Player = {
  id: string;
  name: string;
  // Vom Host festgelegter Name: Spieler darf ihn nicht mehr selbst ändern.
  nameLocked?: boolean;
  // Name enthält "entwickler" o.ä. und wurde durch einen Platzhalter ersetzt —
  // Spieler muss sich umbenennen, bevor der Name wieder frei wählbar ist.
  renamePending?: boolean;
  score: number;
  correctCount: number;
  streak: number;
  lastAnswer?: {
    questionIndex: number;
    answer: PlayerAnswer;
    timeMs: number;
    delta?: number;
    correct?: boolean;
  };
  connected: boolean;
};

export type RoomState = {
  pin: string;
  quiz: Quiz;
  hostId: string | null;
  phase: "lobby" | "question" | "buzzed" | "reveal" | "leaderboard" | "finished";
  currentQuestionIndex: number;
  questionStartedAt: number;
  buzzedAt: number;
  buzzedPlayerId: string | null;
  reactionGoAt: number;
  memorySeq: number[];
  autoRevealTimer: ReturnType<typeof setTimeout> | null;
  players: Map<string, Player>;
  // Laufender Zähler beantworteter Spieler der aktuellen Frage (O(1) statt
  // Array.from(...).filter(...) pro Antwort).
  answeredCount: number;
  // Zähler für Platzhalternamen ("User1", "User2", ...) bei gesperrten Namen.
  guestCounter: number;
};