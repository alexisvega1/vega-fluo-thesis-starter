// Daily writing progress: what you typed and dictated, a goal you can set low on hard days, a streak,
// and reminders. Words are "standard words" (5 characters, as typing tests count them), so typing and
// dictation are measured in the same unit.
//
// A day runs from 4 a.m. to 4 a.m., so a session past midnight counts toward the evening it began in.
// The streak counts consecutive days that met that day's own bar: an "easy win" day counts fully.
// Today not met yet does not break the streak until the day is over.

export type Level = "easy" | "normal" | "push";
export interface Day { typedChars: number; typedMs: number; dictatedChars: number; dictatedMs: number; level?: Level }
export interface Settings { goals: Record<Level, number>; level: Level; reminders: string[]; remindersOn: boolean }
export interface Note { id: string; ts: number; text: string }
// stones: things finished that stay finished (the done-list your attention tends to skip);
// parked: ideas that would turn delivery back into exploration, kept for later instead of followed now
export interface Progress { days: Record<string, Day>; settings: Settings; reminded?: Record<string, string[]>; stones?: Note[]; parked?: Note[] }

export const DEFAULTS: Settings = { goals: { easy: 100, normal: 500, push: 1500 }, level: "normal", reminders: ["14:00", "20:00"], remindersOn: true };
const ROLLOVER_H = 4;
export const words = (chars: number) => Math.round(chars / 5);

/** The writing day a moment belongs to, as YYYY-MM-DD in local time. */
export function dayOf(t: Date | number): string {
  const d = new Date(typeof t === "number" ? t : t.getTime());
  d.setHours(d.getHours() - ROLLOVER_H);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const prevDay = (key: string) => { const d = new Date(`${key}T12:00:00`); d.setDate(d.getDate() - 1); return dayOf(d.getTime() + ROLLOVER_H * 3600e3); };

export const emptyDay = (): Day => ({ typedChars: 0, typedMs: 0, dictatedChars: 0, dictatedMs: 0 });
export const dayWords = (d: Day | undefined) => (d ? words(d.typedChars + d.dictatedChars) : 0);
export const goalFor = (p: Progress, key: string) => p.settings.goals[p.days[key]?.level ?? p.settings.level];
export const met = (p: Progress, key: string) => dayWords(p.days[key]) >= goalFor(p, key) && goalFor(p, key) > 0;

/** Consecutive days that met their bar, ending today (or yesterday while today is still open). */
export function streak(p: Progress, now = Date.now()): number {
  let key = dayOf(now), n = 0;
  if (!met(p, key)) key = prevDay(key);
  while (met(p, key)) { n++; key = prevDay(key); }
  return n;
}

/** Add what one editor reported (deltas, so several tabs never overwrite each other). */
export function add(p: Progress, delta: Partial<Day>, now = Date.now()) {
  const key = dayOf(now);
  const d = (p.days[key] ??= { ...emptyDay(), level: p.settings.level });
  for (const k of ["typedChars", "typedMs", "dictatedChars", "dictatedMs"] as const) {
    const v = Number(delta[k] ?? 0);
    if (Number.isFinite(v) && v > 0 && v < 1e7) d[k] += v;
  }
  return key;
}

/** Summary for the editor: today, streak, the last two weeks. */
export function summary(p: Progress, now = Date.now()) {
  const key = dayOf(now), d = p.days[key] ?? emptyDay();
  const wpm = (chars: number, ms: number) => (ms > 20_000 ? Math.round(words(chars) / (ms / 60_000)) : null);
  const last: { day: string; words: number; goal: number; met: boolean }[] = [];
  let k = key;
  for (let i = 0; i < 14; i++) { last.unshift({ day: k, words: dayWords(p.days[k]), goal: goalFor(p, k), met: met(p, k) }); k = prevDay(k); }
  return {
    day: key,
    level: p.days[key]?.level ?? p.settings.level,
    goal: goalFor(p, key),
    words: dayWords(d),
    typed: { words: words(d.typedChars), minutes: Math.round(d.typedMs / 60_000), wpm: wpm(d.typedChars, d.typedMs) },
    dictated: { words: words(d.dictatedChars), minutes: Math.round(d.dictatedMs / 60_000), wpm: wpm(d.dictatedChars, d.dictatedMs) },
    met: met(p, key),
    streak: streak(p, now),
    last,
    settings: p.settings,
    stones: { today: (p.stones ?? []).filter((n) => dayOf(n.ts) === key), total: (p.stones ?? []).length, recent: (p.stones ?? []).slice(-6).reverse() },
    parked: (p.parked ?? []).slice().reverse(),
  };
}

/** Reminder text, if one is due now: a set time has passed today, the bar is not met, not yet sent for that time. */
export function dueReminder(p: Progress, now = Date.now()): { slots: string[]; text: string } | null {
  if (!p.settings.remindersOn) return null;
  const key = dayOf(now);
  if (met(p, key)) return null;
  const t = new Date(now), hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const sent = p.reminded?.[key] ?? [];
  const slots = p.settings.reminders.filter((s) => s <= hm && !sent.includes(s)); // one message for all that are due
  if (!slots.length || hm < "05:00") return null; // never in the small hours
  const have = dayWords(p.days[key]), goal = goalFor(p, key), s = streak(p, now), easy = p.settings.goals.easy;
  const keep = s ? `Keep your ${s}-day streak: ` : "Start a streak: ";
  const text = have >= easy || goalFor(p, key) <= easy
    ? `${keep}${goal - have} more words today (${have}/${goal}).`
    : `${keep}${have}/${goal} words so far. Low on energy? An easy win is ${easy} words — dictate for two minutes.`;
  return { slots, text };
}
export function markReminded(p: Progress, slots: string[], now = Date.now()) {
  const key = dayOf(now);
  p.reminded = { [key]: [...(p.reminded?.[key] ?? []), ...slots] }; // only today's are kept
}

const nid = () => Math.random().toString(36).slice(2, 10);
/** A finished thing, recorded so it counts. */
export function addStone(p: Progress, text: string, now = Date.now()) {
  const t = text.trim().slice(0, 300);
  if (!t) return;
  (p.stones ??= []).push({ id: nid(), ts: now, text: t });
  if (p.stones.length > 2000) p.stones.splice(0, p.stones.length - 2000);
}
/** "Not now": an idea parked instead of followed. */
export function park(p: Progress, text: string, now = Date.now()) {
  const t = text.trim().slice(0, 500);
  if (t) (p.parked ??= []).push({ id: nid(), ts: now, text: t });
}
export function unpark(p: Progress, id: string) { p.parked = (p.parked ?? []).filter((n) => n.id !== id); }
