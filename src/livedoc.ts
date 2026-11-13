// Live Google Doc: keep a chapter's Google Doc up to date as you write, without overwriting anyone.
//
// Each push is a three-way merge done on the document itself:
//   base   = the prose last pushed (what the doc held, as far as Vega Fluo knows)
//   mine   = the chapter's prose now
//   theirs = the doc's text now (the reviewer may have typed into it)
// Only the changes from base to mine are sent, as small inserts and deletes at the matching places in
// the live doc. A change that touches text the reviewer has also changed is not sent (it is counted
// as a conflict), so the reviewer's own words are never deleted by a push. The request carries the
// revision it was planned against; if the reviewer typed in between, Google refuses it and the push
// is planned again on the fresh text.
import { diffText, mapToB, type Op } from "./diff";

/** The parts of a Docs API document that are read here. */
export interface GDoc {
  revisionId?: string;
  body?: { content?: { startIndex?: number; endIndex?: number; paragraph?: { paragraphStyle?: { namedStyleType?: string }; elements?: { startIndex?: number; endIndex?: number; textRun?: { content?: string; suggestedInsertionIds?: string[] } }[] } }[] };
}

/**
 * The doc's accepted text (a reviewer's pending suggested insertions left out), with the document index
 * of every character. `idx` has one extra entry: the index just past the text.
 */
export function docText(doc: GDoc): { text: string; idx: number[] } {
  let text = "";
  const idx: number[] = [];
  let next = 1;
  for (const el of doc.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const run = pe.textRun;
      if (!run?.content || pe.startIndex === undefined) continue;
      if (run.suggestedInsertionIds?.length) continue; // not part of the text until someone accepts it
      for (let i = 0; i < run.content.length; i++) idx.push(pe.startIndex + i);
      text += run.content;
      next = pe.startIndex + run.content.length;
    }
  }
  // every doc ends with a paragraph mark that cannot be removed; prose has no trailing newline
  if (text.endsWith("\n")) { text = text.slice(0, -1); next = idx.pop()!; }
  idx.push(next);
  return { text, idx };
}

export interface Edit { from: number; to: number; text: string } // in `theirs` coordinates

/** The base→mine changes, placed in `theirs`. Changes where the reviewer has also edited are skipped. */
export function planPush(base: string, mine: string, theirs: string): { edits: Edit[]; conflicts: number } | null {
  const ours = diffText(base, mine), others = diffText(base, theirs);
  if (!ours || !others) return null;
  const touched = others.filter((o) => o.type !== "eq");
  // a change of ours over base [a0, a1) clashes with theirs if the ranges overlap; two insertions clash at the same point
  const clash = (a0: number, a1: number) =>
    touched.some((t) => (t.a0 < a1 && a0 < t.a1) || (t.a0 === t.a1 ? t.a0 >= a0 && t.a0 <= a1 : a0 === a1 && a0 > t.a0 && a0 < t.a1));
  // pair a deletion with the insertion that follows it, so a replacement is one edit
  const changes: { a0: number; a1: number; text: string }[] = [];
  for (let i = 0; i < ours.length; i++) {
    const o = ours[i]!;
    if (o.type === "eq") continue;
    if (o.type === "del") {
      const n = ours[i + 1];
      if (n?.type === "ins" && n.a0 === o.a1) { changes.push({ a0: o.a0, a1: o.a1, text: mine.slice(n.b0, n.b1) }); i++; }
      else changes.push({ a0: o.a0, a1: o.a1, text: "" });
    } else changes.push({ a0: o.a0, a1: o.a0, text: mine.slice(o.b0, o.b1) });
  }
  const edits: Edit[] = [];
  let conflicts = 0;
  for (const c of changes) {
    if (clash(c.a0, c.a1)) { conflicts++; continue; }
    edits.push({ from: mapToB(others, c.a0), to: c.a1 === c.a0 ? mapToB(others, c.a0) : mapPast(others, c.a1), text: c.text });
  }
  return { edits, conflicts };
}

/** End of a range: map the last character and step past it (mapToB sends a range end to the next op's start). */
function mapPast(ops: Op[], a1: number) { return mapToB(ops, a1 - 1) + 1; }

/** Docs API requests for the edits, last first so earlier indices stay valid. */
export function toRequests(edits: Edit[], idx: number[]): object[] {
  const reqs: object[] = [];
  for (const e of [...edits].sort((x, y) => y.from - x.from)) {
    if (e.text) reqs.push({ insertText: { location: { index: e.to > e.from ? idx[e.to - 1]! + 1 : idx[e.from]! }, text: e.text } });
    // delete in runs of consecutive indices, so a reviewer's pending suggestion in between is left alone
    const runs: [number, number][] = [];
    for (let p = e.from; p < e.to; p++) {
      const i = idx[p]!, last = runs[runs.length - 1];
      if (last && last[1] === i) last[1] = i + 1;
      else runs.push([i, i + 1]);
    }
    for (const [s, t] of runs.reverse()) reqs.push({ deleteContentRange: { range: { startIndex: s, endIndex: t } } });
  }
  return reqs;
}
