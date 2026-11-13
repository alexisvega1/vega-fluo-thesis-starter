// Writing progress in the editor: counts what you type and dictate, shows live words per minute, today's
// words against today's bar, and your streak. Words are "standard words" (5 characters), as typing tests
// count them, so typing and dictation compare fairly. Pasted text, accepted suggestions, citation picks
// and updates from elsewhere are not counted.

const WORD = 5;
const GAP = 5000; // a pause longer than this is not typing time
const pending = { typedChars: 0, typedMs: 0, dictatedChars: 0, dictatedMs: 0 };
const recent: { t: number; chars: number; ms: number }[] = []; // last minute of typing, for live wpm
let lastKey = 0;
let dictStart = 0, dictChars = 0, dictFlushedMs = 0;
let state: any = null;
let pill: HTMLButtonElement, pop: HTMLDivElement;

export function noteTyped(chars: number) {
  if (chars <= 0) return;
  const now = Date.now(), gap = now - lastKey;
  const ms = lastKey && gap < GAP ? gap : 0;
  lastKey = now;
  pending.typedChars += chars;
  pending.typedMs += ms;
  recent.push({ t: now, chars, ms });
  draw();
}
export function noteDictated(chars: number) { if (chars > 0) { pending.dictatedChars += chars; dictChars += chars; draw(); } }
export function dictationStarted() { dictStart = Date.now(); dictChars = 0; dictFlushedMs = 0; draw(); }
export function dictationStopped() {
  if (dictStart) pending.dictatedMs += Date.now() - dictStart - dictFlushedMs;
  dictStart = 0;
  flush();
}

/** Live words per minute: dictation while recording, else typing over the last minute (if recent). */
function liveWpm(): { kind: string; wpm: number } | null {
  const now = Date.now();
  if (dictStart) {
    const min = (now - dictStart) / 60000;
    return min > 0.25 ? { kind: "dictating", wpm: Math.round(dictChars / WORD / min) } : { kind: "dictating", wpm: 0 };
  }
  while (recent.length && now - recent[0]!.t > 60000) recent.shift();
  if (!recent.length || now - lastKey > 8000) return null;
  const chars = recent.reduce((n, r) => n + r.chars, 0), ms = recent.reduce((n, r) => n + r.ms, 0);
  return ms > 5000 ? { kind: "typing", wpm: Math.round(chars / WORD / (ms / 60000)) } : null;
}

function unsent() { return Math.round((pending.typedChars + pending.dictatedChars) / WORD); }

function draw() {
  if (!pill) return;
  const live = liveWpm();
  const words = (state?.words ?? 0) + unsent(), goal = state?.goal ?? 0, s = state?.streak ?? 0;
  const done = goal && words >= goal;
  pill.classList.toggle("met", !!done);
  pill.textContent = `${game && left() > 0 ? `⏱ ${mmss(left())} · ` : game ? "⏱ time · " : ""}${s ? `🔥${s}` : "○"} ${words}/${goal}${live && live.wpm ? ` · ${live.wpm} wpm ${live.kind === "dictating" ? "🎙" : "⌨"}` : ""}`;
  pill.title = `${words} words today against today's bar of ${goal}${s ? `; ${s}-day streak` : ""}. Click for details.`;
  if (!pop.hidden) renderPop();
}

async function flush(keepalive = false) {
  if (dictStart) { const ms = Date.now() - dictStart - dictFlushedMs; pending.dictatedMs += ms; dictFlushedMs += ms; }
  const body = { ...pending };
  if (!body.typedChars && !body.dictatedChars && !body.typedMs && !body.dictatedMs) return;
  for (const k of Object.keys(pending) as (keyof typeof pending)[]) pending[k] = 0;
  try {
    const r = await fetch("/api/progress/add", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, keepalive });
    if (!r.ok) throw new Error();
    state = await r.json();
    if (state.justMet) celebrate();
  } catch { for (const k of Object.keys(body) as (keyof typeof body)[]) pending[k] += body[k]; } // try again next time
  draw();
}

function celebrate() {
  const t = document.createElement("div");
  t.className = "progress-toast";
  t.textContent = state.streak > 1 ? `Today's bar met — ${state.streak}-day streak 🔥` : "Today's bar met 🔥 Streak started.";
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

async function settings(b: object) {
  const r = await fetch("/api/progress/settings", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
  if (r.ok) state = await r.json();
  draw();
}

const h = (tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string | false | null | undefined)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith("on")) (el as any)[k] = v; else if (v !== false && v != null) el.setAttribute(k, String(v));
  el.append(...kids.filter((x): x is Node | string => !!x));
  return el;
};

function renderPop() {
  if (!state) return;
  const s = state, words = s.words + unsent();
  const lv = (l: string, label: string, sub: string) =>
    h("button", { type: "button", class: `lv${s.level === l ? " on" : ""}`, onclick: () => settings({ level: l }), title: `Set today's bar to ${s.settings.goals[l]} words` }, h("b", {}, label), h("span", {}, `${s.settings.goals[l]} words · ${sub}`));
  const max = Math.max(...s.last.map((d: any) => Math.max(d.words, d.goal)), 1);
  const rate = (x: any, verb: string, extra: number) => `${x.words + Math.round(extra / WORD)} ${verb}${x.minutes ? ` in ${x.minutes} min` : ""}${x.wpm ? ` · ${x.wpm} wpm` : ""}`;
  const typing = pop.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === "INPUT";
  if (typing) return; // never wipe what you are typing into a box (the pill keeps the countdown)
  pop.replaceChildren(
    ...focusSection(),
    h("div", { class: "pp-label" }, "Today"),
    h("div", { class: "pp-head" }, h("b", {}, s.streak ? `🔥 ${s.streak}-day streak` : "No streak yet"), h("span", {}, s.met ? "Today's bar is met." : `${Math.max(0, s.goal - words)} words to go today.`)),
    h("div", { class: "pp-bar" }, h("i", { style: `width:${Math.min(100, (words / Math.max(1, s.goal)) * 100)}%` })),
    h("p", {}, `⌨ ${rate(s.typed, "typed", pending.typedChars)}`), h("p", {}, `🎙 ${rate(s.dictated, "dictated", pending.dictatedChars)}`),
    h("div", { class: "pp-label" }, "Today's bar"),
    h("div", { class: "pp-levels" }, lv("easy", "Easy win", "low-energy day"), lv("normal", "Normal", "steady"), lv("push", "Push", "big day")),
    h("div", { class: "pp-label" }, "Last 14 days"),
    h("div", { class: "pp-days" }, ...s.last.map((d: any) => h("i", { class: d.met ? "met" : "", style: `height:${Math.max(3, (d.words / max) * 44)}px`, title: `${d.day}: ${d.words}/${d.goal} words` }))),
    h("div", { class: "pp-label" }, "Reminders"),
    h("label", { class: "pp-rem" },
      (() => { const c = h("input", { type: "checkbox" }) as HTMLInputElement; c.checked = s.settings.remindersOn; c.onchange = () => settings({ remindersOn: c.checked }); return c; })(),
      ` at `,
      (() => { const t = h("input", { type: "text", value: s.settings.reminders.join(", "), "aria-label": "Reminder times", size: 14 }) as HTMLInputElement; t.onchange = () => settings({ reminders: t.value.split(/[,\s]+/).filter(Boolean) }); return t; })(),
      h("button", { type: "button", class: "link", onclick: async () => { const r = await fetch("/api/progress/test-reminder", { method: "POST" }).then((x) => x.json()).catch(() => null); pushNote = r ? `Test sent to the Mac${r.devices ? ` and ${r.devices} device${r.devices === 1 ? "" : "s"}` : ""}.` : "Could not reach the Mac."; renderPop(); } }, "Test")),
    pushRow(),
    h("p", { class: "pp-note" }, "Only when today's bar isn't met yet, and only while Vega Fluo is running on the Mac. A day ends at 4 a.m. Words = 5 characters, as typing tests count them."),
  );
}


// ---------- reminders on this device (phone on the Home Screen, or this browser) ----------
const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let pushState: "on" | "off" | "denied" | "unsupported" | "busy" = "off";
let pushNote = "";
async function refreshPush() {
  if (!canPush()) { pushState = "unsupported"; return; }
  if (Notification.permission === "denied") { pushState = "denied"; return; }
  const reg = await navigator.serviceWorker.getRegistration("/");
  pushState = (await reg?.pushManager.getSubscription()) ? "on" : "off";
}
const b64 = (s: string) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
async function pushOn() {
  pushState = "busy"; renderPop();
  try {
    if ((await Notification.requestPermission()) !== "granted") { pushState = "denied"; pushNote = "Notifications were not allowed for Vega Fluo."; return; } // must come first, from the tap
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const { key } = await (await fetch("/api/push/key")).json();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "browser";
    const r = await fetch("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), label }), headers: { "content-type": "application/json" } });
    if (!r.ok) throw new Error((await r.json()).error);
    pushState = "on"; pushNote = "This device will get reminders. Tap Test to try one.";
  } catch (e) { pushState = "off"; pushNote = `Could not turn on reminders here: ${(e as Error).message}`; }
  finally { if (pushState === "busy") pushState = "off"; renderPop(); }
}
async function pushOff() {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await fetch("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }), headers: { "content-type": "application/json" } }); await sub.unsubscribe(); }
  pushState = "off"; pushNote = ""; renderPop();
}
function pushRow() {
  const standalone = (navigator as any).standalone || matchMedia("(display-mode: standalone)").matches;
  const iPhone = /iPhone|iPad/.test(navigator.userAgent);
  if (pushState === "unsupported")
    return h("p", { class: "pp-note" }, iPhone && !standalone ? "To get reminders on this iPhone, open Vega Fluo from its Home Screen icon, then turn them on here." : "This browser can't receive reminders.");
  return h("div", { class: "pp-rem" },
    pushState === "on"
      ? h("span", {}, "📱 This device gets reminders · ", h("button", { type: "button", class: "link", onclick: pushOff }, "Turn off"))
      : pushState === "denied"
        ? h("span", {}, "📱 Notifications are blocked for Vega Fluo on this device (allow them in Settings → Notifications).")
        : h("button", { type: "button", class: "link", disabled: pushState === "busy", onclick: pushOn }, pushState === "busy" ? "Turning on…" : "📱 Send reminders to this device"),
    pushNote && h("span", { class: "pp-note" }, pushNote));
}


// ---------- non-judgmental focus: one stone, the 45-minute Finish Game, stones at the top, a parking lot ----------
const MANTRAS = [
  "The whole list is not my task. This one thing is my task.",
  "Forward is more valuable than polished.",
  "Make it exist → make it right → make it clear → make it pretty.",
  "Reduce → Bound → Attack → Finish → Do not reopen.",
  "Overwhelm measures how much I'm holding, not what I can do.",
  "I have done hard things before. I can do hard things again.",
  "Unlike Sisyphus, my hill has an end.",
  "Wrong pass? Leave a [TODO] and keep moving.",
  "An ugly paragraph can be revised. An empty page cannot.",
];
let mantra = MANTRAS[Math.floor(Math.random() * MANTRAS.length)]!;
const GAME_MIN = 45;
type Game = { task: string; endsAt: number; askedAt?: number };
const loadGame = (): Game | null => { try { return JSON.parse(localStorage.getItem("fluo.game") ?? "null"); } catch { return null; } };
const saveGame = (g: Game | null) => { try { g ? localStorage.setItem("fluo.game", JSON.stringify(g)) : localStorage.removeItem("fluo.game"); } catch {} };
let game: Game | null = loadGame();
const left = () => (game ? Math.max(0, game.endsAt - Date.now()) : 0);
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

async function note(kind: "stone" | "park", body: object) {
  const r = await fetch("/api/progress/note", { method: "POST", body: JSON.stringify({ kind, ...body }), headers: { "content-type": "application/json" } });
  if (r.ok) state = await r.json();
  draw();
}
function toast(text: string) {
  const t = document.createElement("div");
  t.className = "progress-toast";
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}
function startGame(task: string) {
  game = { task: task.trim() || "This one thing", endsAt: Date.now() + GAME_MIN * 60000 };
  saveGame(game); mantra = "The whole paper is not my task. This one thing is my task."; draw();
}
function tickGame() {
  if (!game || left() > 0 || game.askedAt) return;
  game.askedAt = Date.now(); saveGame(game);
  toast(`Time. Ship what you have — did “${game.task}” get done?`);
  openPop();
}
async function finishGame(done: boolean, more = 0) {
  if (!game) return;
  if (more) { game = { task: game.task, endsAt: Date.now() + more * 60000 }; saveGame(game); return draw(); }
  if (done) { await note("stone", { text: game.task }); toast("A stone that stays at the top. ✓"); }
  else await note("park", { text: `Rest of: ${game.task}` });
  game = null; saveGame(null); draw();
}

function focusSection() {
  const s = state;
  const input = (placeholder: string, label: string, onEnter: (v: string) => void, id?: string) => {
    const el = h("input", { type: "text", placeholder, "aria-label": label, ...(id ? { id } : {}) }) as HTMLInputElement;
    el.onkeydown = (e) => { if (e.key === "Enter" && el.value.trim()) { onEnter(el.value); el.value = ""; } };
    return el;
  };
  const gameBox = game
    ? left() > 0
      ? h("div", { class: "pp-game" }, h("b", {}, `⏱ ${mmss(left())}`), h("span", {}, game.task),
          h("button", { type: "button", class: "link", onclick: () => finishGame(true) }, "Done ✓"),
          h("button", { type: "button", class: "link", onclick: () => { game = null; saveGame(null); draw(); } }, "Stop"))
      : h("div", { class: "pp-game ask" }, h("span", {}, `Did “${game.task}” get done?`),
          h("button", { type: "button", class: "link", onclick: () => finishGame(true) }, "Yes — stone ✓"),
          h("button", { type: "button", class: "link", onclick: () => finishGame(false, 15) }, "15 more min"),
          h("button", { type: "button", class: "link", onclick: () => finishGame(false) }, "Park the rest"))
    : h("div", { class: "pp-game" }, input("One bounded thing, e.g. “Figure 2 legend, ugly is fine”", "This one thing", startGame), h("span", { class: "pp-note" }, `Enter starts a ${GAME_MIN}-minute Finish Game.`));
  const stones = s?.stones;
  return [
    h("p", { class: "pp-mantra" }, mantra),
    h("div", { class: "pp-label" }, "This one thing"),
    gameBox,
    h("div", { class: "pp-label" }, `Stones at the top · ${stones?.today.length ?? 0} today · ${stones?.total ?? 0} in all`),
    stones?.today.length ? h("ul", { class: "pp-list" }, ...stones.today.slice(-5).reverse().map((n: any) => h("li", {}, `✓ ${n.text}`))) : h("p", { class: "pp-note" }, "Anything finished counts: a legend, a paragraph, an email, a [TODO] cleared."),
    input("Finished something? Add it here", "Add a finished thing", (v) => note("stone", { text: v })),
    h("div", { class: "pp-label" }, `Parking lot · Alt+P · ${s?.parked?.length ?? 0}`),
    input("Is this the boulder? If not, park it", "Park an idea", (v) => note("park", { text: v }), "pp-park"),
    s?.parked?.length ? h("ul", { class: "pp-list" }, ...s.parked.slice(0, 6).map((n: any) => h("li", {}, n.text, " ", h("button", { type: "button", class: "link", title: "Let it go", onclick: () => note("park", { remove: n.id }) }, "✕")))) : null,
  ];
}
function openPop(focusPark = false) {
  pop.hidden = false;
  const r = pill.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`; pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 340))}px`;
  renderPop(); refreshPush().then(renderPop, () => {});
  if (focusPark) setTimeout(() => (document.getElementById("pp-park") as HTMLInputElement | null)?.focus(), 0);
}

export async function mountProgress(anchor: HTMLElement) {
  // the web app manifest (for the Home Screen app and its reminders); added here so the bundler leaves it alone
  if (!document.querySelector('link[rel="manifest"]')) document.head.append(h("link", { rel: "manifest", href: "/manifest.webmanifest" }));
  pill = h("button", { type: "button", id: "progress", class: "ghost-btn progress-pill" }) as HTMLButtonElement;
  pop = h("div", { id: "progress-pop", class: "progress-pop", hidden: true }) as HTMLDivElement;
  anchor.after(pill);
  document.body.append(pop);
  pill.onclick = (e) => {
    e.stopPropagation();
    if (pop.hidden) openPop(); else pop.hidden = true;
  };
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target as Node) && e.target !== pill) pop.hidden = true; });
  try { state = await (await fetch("/api/progress")).json(); } catch { /* shows once the server answers */ }
  draw();
  setInterval(() => flush(), 30000);
  setInterval(() => { tickGame(); draw(); }, 1000); // the countdown, and the live rate easing off when you stop
  // Alt+P: park an idea without leaving what you are doing
  addEventListener("keydown", (e) => { if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyP") { e.preventDefault(); openPop(true); } }, true);
  setInterval(async () => { if (!unsent()) { try { state = await (await fetch("/api/progress")).json(); draw(); } catch {} } }, 120000); // other tabs, day rollover
  addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(true); });
}
