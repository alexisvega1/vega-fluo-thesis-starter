// Bring comments from a Word file (for example a Google Doc downloaded as .docx) into the thesis.
// Each comment is placed on the same words in the LaTeX source when they can be found: the text it was
// attached to, or, for comments on a figure or an empty spot, the start of its paragraph. Replies that
// Google exported as separate comments are threaded back onto the comment they answer.
import type { Reviewed } from "./docxreview";
import { renderProse, sourceStartPos } from "./texprose";

export interface Placed { file: string; from: number; to: number; quote: string; author: string; ts: number; text: string; replies: { author: string; ts: number; text: string }[]; how: "words" | "paragraph" | "nearby" }
export interface Unplaced { author: string; ts: number; text: string; context: string }

/** Lower-case, one kind of quote and dash, single spaces; with a map back to the original index. */
function normalise(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    if (/\s/.test(ch)) { if (!space && text) { text += " "; at.push(i); } space = true; continue; }
    space = false;
    ch = ch.replace(/[‘’ʼ`]/, "'").replace(/[“”]/, '"').replace(/[–—−]/, "-").toLowerCase();
    text += ch; at.push(i);
  }
  return { text, at };
}

/** Letters only (no digits, spaces or punctuation): "Medina1,2, J. Nate" and "Medina, J. Nate" agree. */
function lettersOnly(n: ReturnType<typeof normalise>): ReturnType<typeof normalise> {
  let text = ""; const at: number[] = [];
  for (let i = 0; i < n.text.length; i++) if (/[a-z]/.test(n.text[i]!)) { text += n.text[i]; at.push(n.at[i]!); }
  return { text, at };
}
const loose = new WeakMap<object, ReturnType<typeof normalise>>();

/** Where `needle` occurs in `hay` (both raw), tolerant of spacing, quotes, dashes and case; then of anything but letters. */
function find(hay: ReturnType<typeof normalise>, needle: string, near = 0): [number, number] | null {
  return findIn(hay, normalise(needle).text.trim(), near) ?? (() => {
    let l = loose.get(hay); if (!l) { l = lettersOnly(hay); loose.set(hay, l); }
    const n = normalise(needle).text.replace(/[^a-z]/g, "");
    return n.length >= 12 ? findIn(l, n, near) : null;
  })();
}
function findIn(hay: ReturnType<typeof normalise>, n: string, near: number): [number, number] | null {
  if (n.length < 4) return null;
  let best = -1, bestDist = Infinity;
  for (let i = hay.text.indexOf(n); i >= 0; i = hay.text.indexOf(n, i + 1)) {
    const d = Math.abs(hay.at[i]! - near);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best < 0 ? null : [hay.at[best]!, hay.at[best + n.length - 1]! + 1];
}

/**
 * Some run of the paragraph's words that can be found, longest first: the whole paragraph, then
 * windows of 12, 8, 6 and 4 words anywhere in it, so a label ("Title:") or a superscript that the
 * thesis writes differently does not stop the match.
 */
function findParagraph(hay: ReturnType<typeof normalise>, para: string): [number, number] | null {
  const words = para.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  for (const n of [words.length, 12, 8, 6, 4]) {
    if (n > words.length) continue;
    for (let i = 0; i + n <= words.length; i += Math.max(1, Math.floor(n / 3))) {
      const chunk = words.slice(i, i + n).join(" ");
      if (normalise(chunk).text.replace(/[^a-z]/g, "").length < 14) continue; // too little to be sure
      const hit = find(hay, chunk);
      if (hit) return hit;
    }
  }
  return null;
}

export function placeComments(r: Reviewed, chapters: { path: string; src: string }[]): { placed: Placed[]; unplaced: Unplaced[] } {
  const o = r.original;
  const all = chapters.map((c) => { const prose = renderProse(c.src); return { ...c, prose, n: normalise(prose.text) }; });
  // the draft's home: the file where most of its paragraphs are found is tried first, so a list of
  // names that also appears in the acknowledgements still lands in the chapter
  const paras = o.split("\n").map((x) => x.trim()).filter((x) => x.length > 40);
  const score = new Map(all.map((d) => [d, paras.filter((x) => findParagraph(d.n, x)).length]));
  const docs = [...all].sort((a, b) => score.get(b)! - score.get(a)!);
  // thread replies: a later comment by someone else, attached at (nearly) the same place, answers it
  const sorted = [...r.comments].sort((a, b) => a.ts - b.ts || a.from - b.from);
  const parents = new Map<string, typeof sorted[number]>();
  const repliesOf = new Map<string, typeof sorted>();
  for (const c of sorted) {
    const parent = sorted.find((p) => p !== c && p.ts <= c.ts && p.author !== c.author && !parents.has(p.id) && Math.abs(p.from - c.from) <= 250 && (repliesOf.get(p.id) ?? []).every((x) => x.author !== c.author));
    if (parent) { parents.set(c.id, parent); repliesOf.set(parent.id, [...(repliesOf.get(parent.id) ?? []), c]); }
  }
  const clean = (t: string) => t.replace(/_Assigned to [^_]+_/g, (m) => ` (${m.replace(/_/g, "").trim()})`).replace(/\s+/g, " ").trim();
  const placed: Placed[] = [], unplaced: Unplaced[] = [];
  for (const c of sorted) {
    if (parents.has(c.id)) continue;
    const anchor = o.slice(c.from, c.to);
    const p0 = o.lastIndexOf("\n", c.from - 1) + 1;
    let p1 = o.indexOf("\n", Math.max(c.from, c.to)); if (p1 < 0) p1 = o.length;
    const para = o.slice(p0, p1).trim() || o.slice(c.to, c.to + 200).split("\n").find((l) => l.trim()) || "";
    let hit: { doc: typeof docs[number]; r: [number, number]; how: Placed["how"] } | null = null;
    for (const d of docs) {
      const pr = findParagraph(d.n, para);
      if (!pr) continue;
      // the commented words themselves, inside that paragraph when possible
      const w = anchor.trim().length >= 4 ? find(d.n, anchor.trim(), pr[0]) : null;
      hit = w ? { doc: d, r: w, how: "words" } : { doc: d, r: [pr[0], Math.min(pr[1], pr[0] + 80)], how: "paragraph" };
      break;
    }
    if (!hit) {
      for (const d of docs) { const w = anchor.trim().length >= 12 ? find(d.n, anchor.trim()) : null; if (w) { hit = { doc: d, r: w, how: "words" }; break; } }
    }
    // nothing at the spot itself (a comment on a figure image or a working note): use the nearest
    // paragraph before it in the draft that is in the thesis, e.g. the figure's legend
    for (let q = p0 - 1, tries = 0; !hit && q > 0 && tries < 12; tries++) {
      const a = o.lastIndexOf("\n", q - 1) + 1, prev = o.slice(a, q).trim();
      q = a - 1;
      if (prev.length < 20) continue;
      for (const d of docs) { const pr = findParagraph(d.n, prev); if (pr) { hit = { doc: d, r: [pr[0], Math.min(pr[1], pr[0] + 80)], how: "nearby" }; break; } }
    }
    const replies = (repliesOf.get(c.id) ?? []).map((x) => ({ author: x.author, ts: x.ts, text: clean(x.text) }));
    if (!hit) { unplaced.push({ author: c.author, ts: c.ts, text: clean(c.text), context: (anchor.trim() || para).slice(0, 120) }); for (const x of replies) unplaced.push({ ...x, context: "(reply)" }); continue; }
    const from = sourceStartPos(hit.doc.prose, hit.r[0]);
    let to = sourceStartPos(hit.doc.prose, Math.max(hit.r[0], hit.r[1] - 1)) + 1;
    if (to - from < 3) { const eol = hit.doc.src.indexOf("\n", from); to = eol > from ? Math.min(eol, from + 120) : from + 1; } // a command, not words: take the rest of its line
    placed.push({ file: hit.doc.path, from, to, quote: hit.doc.src.slice(from, to).slice(0, 200), author: c.author, ts: c.ts, text: clean(c.text), replies, how: hit.how });
  }
  return { placed, unplaced };
}
