import { el, on } from "./lib/dom";

type QuizSummary = {
  id: string;
  title: string;
  description: string;
  coverColor: string;
  questionCount: number;
  plays: number;
  createdAt: number;
};

const root = el("main", { className: "app library-app" });
document.body.appendChild(el("div", { className: "topbar" }, [
  el("a", { className: "brand", href: "/", text: "KahootClone" }),
  el("div", { className: "row" }, [
    el("a", { href: "/", text: "Start" }),
    el("a", { href: "/editor.html", text: "Neu erstellen" }),
    el("a", { href: "/host.html", text: "Spiel hosten" }),
    el("a", { href: "/join.html", text: "Beitreten" }),
  ]),
]));
document.body.appendChild(root);
let searchTerm = "";

async function load() {
  root.replaceChildren(el("p", { className: "badge", role: "status", text: "Quizze werden geladen …" }));
  try {
    const res = await fetch("/api/quizzes");
    if (!res.ok) throw new Error("load failed");
    const items: QuizSummary[] = await res.json();
    root.replaceChildren();
    root.append(el("header", { className: "page-heading" }, [
      el("div", { className: "col" }, [
        el("span", { className: "eyebrow", text: "Deine Sammlung" }),
        el("h1", { className: "title", text: "Bereit für die nächste Runde?" }),
        el("p", { className: "subtitle", text: `${items.length} Quizze. Ein Klick bis zum Spiel.` }),
      ]),
      el("a", { className: "button", href: "/editor.html", text: "+ Neues Quiz" }),
    ]));
    if (!items.length) {
      root.append(el("section", { className: "card quiz-empty" }, [
        el("span", { className: "eyebrow", text: "Hier beginnt dein erstes Spiel" }),
        el("h2", { text: "Eine gute Frage ist der Anfang." }),
        el("p", { className: "muted", text: "Erstelle dein erstes Quiz selbst oder beginne mit einem KI-Entwurf." }),
        el("a", { className: "button", href: "/editor.html", text: "Quiz erstellen" }),
      ]));
      return;
    }
    const search = el("input", { type: "search", id: "quiz-search", placeholder: "Titel oder Beschreibung suchen", value: searchTerm });
    const count = el("span", { className: "badge", role: "status" });
    const grid = el("div", { className: "quiz-grid" });
    const noResults = el("p", { className: "card quiz-empty", text: "Kein Quiz gefunden. Versuche einen anderen Suchbegriff.", hidden: true });
    root.append(el("div", { className: "library-toolbar" }, [
      el("label", { className: "col", htmlFor: "quiz-search" }, [el("span", { className: "small muted", text: "Sammlung durchsuchen" }), search]),
      count,
    ]), grid, noResults);
    const cards = items.map((q) => {
      const card = el("article", { className: "quiz-card" });
      const color = /^#[\da-f]{3}([\da-f]{3})?$/i.test(q.coverColor) ? q.coverColor : "#46178f";
      const cover = el("div", { className: "quiz-cover" }, [
        el("span", { className: "cover-shapes", text: "▲ ◆ ● ■", ariaHidden: "true" }),
        el("span", { className: "badge", text: `${q.questionCount} Fragen` }),
      ]);
      cover.style.background = `linear-gradient(135deg, ${color}, #1a0b2e 140%)`;
      card.append(cover, el("div", { className: "quiz-body" }, [
        el("h2", { className: "quiz-title", text: q.title }),
        el("p", { className: "quiz-desc", text: q.description || "Dein nächstes Live-Quiz wartet." }),
        el("span", { className: "small muted", text: `${q.plays} mal gespielt` }),
      ]));
      const id = encodeURIComponent(q.id);
      const deleteButton = el("button", { className: "ghost small", text: "Löschen", ariaLabel: `Quiz ${q.title} löschen` });
      const error = el("p", { className: "inline-error", role: "alert", hidden: true });
      on(deleteButton, "click", async () => {
        if (!confirm(`„${q.title}“ wirklich löschen?`)) return;
        deleteButton.disabled = true;
        error.hidden = true;
        try {
          const result = await fetch(`/api/quizzes/${id}`, { method: "DELETE" });
          if (!result.ok) throw new Error("delete failed");
          await load();
        } catch {
          error.textContent = "Löschen fehlgeschlagen. Bitte erneut versuchen.";
          error.hidden = false;
          deleteButton.disabled = false;
        }
      });
      card.append(el("div", { className: "quiz-actions" }, [
        el("a", { className: "button", href: `/host.html?quiz=${id}`, text: "Spiel starten" }),
        el("a", { className: "ghost button", href: `/editor.html?id=${id}`, text: "Bearbeiten" }),
        deleteButton,
      ]), error);
      grid.append(card);
      return { card, text: `${q.title} ${q.description}`.toLocaleLowerCase("de") };
    });
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase("de");
      searchTerm = search.value;
      let visible = 0;
      for (const { card, text } of cards) {
        card.hidden = !text.includes(query);
        if (!card.hidden) visible++;
      }
      count.textContent = `${visible} von ${items.length} Quizzen`;
      noResults.hidden = visible > 0;
    };
    on(search, "input", filter);
    filter();
  } catch {
    const retry = el("button", { text: "Erneut versuchen" });
    on(retry, "click", load);
    root.replaceChildren(el("section", { className: "card quiz-empty", role: "alert" }, [
      el("h2", { text: "Sammlung nicht erreichbar" }),
      el("p", { className: "muted", text: "Prüfe deine Verbindung und versuche es erneut." }), retry,
    ]));
  }
}
void load();
