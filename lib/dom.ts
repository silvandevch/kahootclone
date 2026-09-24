export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k === "style" && typeof v === "object") Object.assign((node as any).style, v);
    else (node as any)[k] = v;
  }
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  ev: K,
  fn: (e: HTMLElementEventMap[K]) => void
) {
  node.addEventListener(ev, fn as EventListener);
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node: HTMLElement | null) {
  if (node) node.style.display = "";
}
export function hide(node: HTMLElement | null) {
  if (node) node.style.display = "none";
}

export function toast(msg: string, ms = 2200) {
  const t = el("div", { className: "toast", text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

export function fmtMs(ms: number) {
  return (ms / 1000).toFixed(1) + "s";
}

export function gameSound(role: "host" | "player") {
  type Cue = "question" | "submit" | "correct" | "wrong" | "reveal" | "buzz" | "podium" | "tick";
  const notes: Record<Cue, number[]> = {
    question: [261.63, 392, 523.25],
    submit: [659.25, 880],
    correct: [523.25, 659.25, 783.99, 1046.5],
    wrong: [293.66, 220, 196],
    reveal: [392, 523.25, 659.25],
    buzz: [440, 880, 880],
    podium: [392, 523.25, 659.25, 783.99, 659.25, 1046.5],
    tick: [880],
  };
  const key = `kc:sound:${role}`;
  let enabled = role === "host";
  try { const saved = localStorage.getItem(key); if (saved !== null) enabled = saved === "on"; } catch {}
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCueAt = -Infinity;
  const voices = new Set<OscillatorNode>();
  const heard = new Set<string>();
  const control = el("button", { className: "ghost small", type: "button" });
  control.style.minHeight = "44px";
  document.querySelector(".topbar .row")?.append(control);
  const updateControl = () => {
    control.textContent = enabled ? "Sound an" : "Sound aus";
    control.setAttribute("aria-label", enabled ? "Sound ausschalten" : "Sound einschalten");
    control.setAttribute("aria-pressed", String(enabled));
    control.title = "Dezente Spielsounds · auf Spielergeräten standardmäßig aus";
  };
  const silence = () => {
    for (const voice of voices) { try { voice.stop(); } catch {} }
    voices.clear();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    silence();
  };
  const unlock = () => {
    if (!enabled || document.hidden) return;
    try {
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        master.gain.value = role === "host" ? 0.18 : 0.1;
        master.connect(context.destination);
      }
      if (context.state === "suspended") void context.resume().catch(() => {});
    } catch {
      enabled = false;
      updateControl();
    }
  };
  const play = (cue: Cue, identity?: string) => {
    if (identity) {
      if (heard.has(identity)) return;
      heard.add(identity);
      if (heard.size > 64) heard.delete(heard.values().next().value!);
    }
    try {
      const log = ((window as any).__audioCues ?? ((window as any).__audioCues = []));
      log.push({ cue, identity: identity ?? null });
    } catch {}
    if (!enabled || !context || !master || context.state !== "running" || document.hidden) return;
    if (Array.from(document.querySelectorAll("audio, video")).some((node) => {
      const media = node as HTMLMediaElement;
      return !media.paused && !media.ended && !media.muted;
    })) return;
    const now = context.currentTime;
    if (now - lastCueAt < 0.08) return;
    lastCueAt = now;
    silence();
    const step = cue === "podium" ? 0.17 : cue === "tick" ? 0.04 : 0.095;
    try {
      notes[cue].forEach((frequency, index) => {
        const voice = context!.createOscillator();
        const envelope = context!.createGain();
        const start = now + index * step;
        const duration = cue === "tick" ? 0.06 : index === notes[cue].length - 1 ? 0.35 : 0.16;
        voice.type = cue === "wrong" || cue === "buzz" ? "triangle" : "sine";
        voice.frequency.setValueAtTime(frequency, start);
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(0.45, start + 0.008);
        envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
        voice.connect(envelope);
        envelope.connect(master!);
        voices.add(voice);
        voice.onended = () => { voice.disconnect(); envelope.disconnect(); voices.delete(voice); };
        voice.start(start);
        voice.stop(start + duration + 0.02);
      });
    } catch { silence(); }
  };
  const countdown = (deadline: number) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    let previous = Math.ceil((deadline - Date.now()) / 1000);
    timer = setInterval(() => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) { if (timer) clearInterval(timer); timer = null; return; }
      if (left !== previous && left <= 5) play("tick");
      previous = left;
    }, 250);
  };
  on(control, "click", () => {
    enabled = !enabled;
    try { localStorage.setItem(key, enabled ? "on" : "off"); } catch {}
    updateControl();
    if (enabled) unlock();
    else { silence(); if (context?.state === "running") void context.suspend().catch(() => {}); }
  });
  document.addEventListener("pointerdown", unlock, { passive: true });
  document.addEventListener("keydown", unlock);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      silence();
      if (context?.state === "running") void context.suspend().catch(() => {});
    } else unlock();
  });
  window.addEventListener("pagehide", stop);
  window.addEventListener("storage", (event) => {
    if (event.key !== key) return;
    enabled = event.newValue === "on";
    if (!enabled) silence();
    updateControl();
  });
  updateControl();
  return { play, countdown, stop };
}
