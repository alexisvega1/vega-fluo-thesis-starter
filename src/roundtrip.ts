// Send a chapter out as reviewer-friendly prose; bring the reviewer's suggestions and comments
// back as tracked changes on the LaTeX source.
import { diffText, mapToA, mapToB } from "./diff";
import type { Reviewed } from "./docxreview";
import { escapeTex, sourceDeleteRanges, sourceInsertPos, sourceStartPos, type Prose } from "./texprose";
import type { Comment, Del, Ins } from "../web/review-model";

export interface Round {
  docId: string;
  url: string;
  title: string;
  sentAt: number;
  pulledAt?: number;
  base: string; // the .tex exactly as it was sent
  prose: Prose; // what the reviewer was given, with its map back to `base`
  seen: string[]; // ids already brought in, so a second pull never duplicates or resurrects them
  // live rounds: the doc follows the chapter as it is written (see livedoc.ts)
  live?: boolean;
  pushedAt?: number;
  revision?: string; // the doc's revision as of the last pull, or our own last push if nobody edited since
  conflicts?: number; // changes not sent because the reviewer had edited the same words
  error?: string;
  retired?: boolean; // replaced by a fresh live doc; never reused
  markSig?: string; // what was last drawn in the doc of your own suggestions and notes
  mirror?: Record<string, { cid: string; content: string; replies: number; resolved: boolean }>; // your item id -> its Google comment
  mirrorKinds?: Record<string, "ins" | "del" | "note">;
}

export interface Imported { suggestions: (Ins | Del)[]; comments: Comment[]; unplaced: number }

/** Same length, so offsets survive: typographic variants a word processor may introduce on its own. */
const normalize = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, " ");

function hash(...parts: (string | number)[]) {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0001")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return "g" + h.toString(16).padStart(8, "0");
}
const clip = (s: string) => (s.length > 120 ? s.slice(0, 117) + "…" : s);

export function importReview(round: Pick<Round, "docId" | "base" | "prose">, reviewed: Reviewed, currentBase: string): Imported {
  const R = round.prose.text, O = reviewed.original;
  // 1. line the returned document up with what was sent
  const sent = diffText(normalize(R), normalize(O));
  if (!sent) throw new Error("The reviewed document no longer resembles the chapter that was sent, so changes cannot be placed safely.");
  const toR = (o: number) => mapToA(sent, o);

  // 2. every change, in prose coordinates
  type Change = { type: "ins"; r: number; text: string; author: string; ts: number } | { type: "del"; r0: number; r1: number; text: string; author: string; ts: number };
  const changes: Change[] = [];
  const direct = { author: "Google Docs (direct edit)", ts: Date.now() };
  for (const op of sent) {
    if (op.type === "eq") continue;
    const text = op.type === "del" ? R.slice(op.a0, op.a1) : O.slice(op.b0, op.b1);
    // text that only exists as a tracked insertion/deletion is reported by the tracked list below, not here
    if (op.type === "ins" && !text.trim()) continue;
    if (op.type === "del") changes.push({ type: "del", r0: op.a0, r1: op.a1, text, ...direct });
    else changes.push({ type: "ins", r: op.a0, text, ...direct });
  }
  // Google sends a new paragraph's text and its paragraph mark as separate insertions at the same spot:
  // join insertions by the same person at the same place first, so the break stays with its text
  const tracked: typeof reviewed.tracked = [];
  for (const t of reviewed.tracked) {
    const last = tracked[tracked.length - 1];
    if (last && t.type === "ins" && last.type === "ins" && last.at === t.at && last.author === t.author) last.text += t.text;
    else tracked.push({ ...t });
  }
  for (const t of tracked) {
    // blank lines alone mean nothing in LaTeX; runs of paragraph breaks become one
    if (t.type === "ins" && !t.text.trim()) continue;
    // text typed into an empty paragraph (Return, then type) is a new paragraph even though Google
    // does not mark that paragraph's break as part of the suggestion
    const fillsEmpty = t.type === "ins" && O[t.at - 1] === "\n" && O[t.at] === "\n" && !t.text.endsWith("\n");
    if (t.type === "ins") changes.push({ type: "ins", r: toR(t.at), text: (t.text + (fillsEmpty ? "\n" : "")).replace(/\n{2,}/g, "\n"), author: t.author, ts: t.ts });
    else {
      const r0 = toR(t.at), r1 = toR(t.at + t.text.length);
      if (r1 > r0) changes.push({ type: "del", r0, r1, text: t.text, author: t.author, ts: t.ts });
    }
  }

  // 3. the .tex may have moved on since it was sent
  const moved = round.base === currentBase ? null : diffText(round.base, currentBase);
  if (round.base !== currentBase && !moved) throw new Error("The chapter has changed too much since it was sent; send a fresh copy for review.");
  const now = (pos: number) => (moved ? mapToB(moved, pos) : pos);

  // ids must survive the chapter being edited between pulls (a live doc is pulled again and again), so
  // they are built from who changed what next to which words, not from positions, which move
  const ctx = (r: number) => R.slice(Math.max(0, r - 32), r);
  const seenKeys = new Map<string, number>();
  const key = (...parts: (string | number)[]) => { const k = hash(...parts); const n = seenKeys.get(k) ?? 0; seenKeys.set(k, n + 1); return n ? hash(k, n) : k; };
  const out: Imported = { suggestions: [], comments: [], unplaced: 0 };
  const note = (pos: number, author: string, ts: number, text: string, id: string) => {
    out.unplaced++;
    out.comments.push({ id, author, ts, from: pos, to: pos, quote: "", text: `Could not be placed automatically — ${text}`, resolved: false, replies: [] });
  };

  for (const c of changes) {
    if (c.type === "ins") {
      let at = now(sourceInsertPos(round.prose, c.r));
      // a new paragraph belongs outside the markup around it: after the closing braces of the line before
      // (\textit{…}, \section{…}) and before the command that opens the next one (\paragraph{…})
      if (c.text.startsWith("\n")) while (currentBase[at] === "}") at++;
      if (c.text.endsWith("\n")) { const m = /\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{$/.exec(currentBase.slice(Math.max(0, at - 80), at)); if (m) at -= m[0].length; }
      out.suggestions.push({ type: "ins", id: key(round.docId, "ins", c.author, ctx(c.r), c.text), author: c.author, ts: c.ts, at, text: escapeTex(c.text), before: currentBase.slice(Math.max(0, at - 24), at) });
      continue;
    }
    const { ranges, partial } = sourceDeleteRanges(round.prose, c.r0, c.r1);
    let ok = !partial && ranges.length > 0;
    const dels: Del[] = [];
    for (const [s0, s1] of ranges) {
      const from = now(s0), to = now(s1), text = round.base.slice(s0, s1);
      if (currentBase.slice(from, to) !== text) { ok = false; continue; } // that text has since been edited
      dels.push({ type: "del", id: key(round.docId, "del", c.author, ctx(c.r0), c.text, s1 - s0, round.base.slice(s0, s1)), author: c.author, ts: c.ts, from, to, text });
    }
    out.suggestions.push(...dels);
    if (!ok) note(now(sourceStartPos(round.prose, c.r0)), c.author, c.ts, `suggested deleting “${clip(c.text)}”, which runs through a citation, equation, paragraph break or text edited since.`, key(round.docId, "note", c.author, ctx(c.r0), c.text));
  }

  for (const c of reviewed.comments) {
    const from = now(sourceStartPos(round.prose, toR(c.from)));
    const to = Math.max(from, now(sourceInsertPos(round.prose, toR(c.to))));
    out.comments.push({ id: key(round.docId, "comment", c.author, c.ts, c.text), author: c.author, ts: c.ts, from, to, quote: currentBase.slice(from, to).slice(0, 200), text: c.text, resolved: false, replies: [] });
  }
  return out;
}
