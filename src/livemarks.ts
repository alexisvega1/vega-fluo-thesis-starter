// What a live Google Doc shows of your own review work, which the Docs API cannot express natively
// (an app cannot create Google suggestions, and a comment it posts cannot be pinned to words):
//   - your suggested insertions: purple, underlined
//   - your suggested deletions: kept, red, struck through
//   - words your notes are about: shaded in a soft yellow
// Each of these also gets a Google comment from your account (so it carries your name, email and the
// time), quoting the words. Only runs carrying exactly these marker colours are ever reset, so formatting
// or highlights a reviewer adds in the doc are left alone.
import { diffText, mapToA, mapToB } from "./diff";
import { docText, type GDoc } from "./livedoc";

export type MarkKind = "ins" | "del" | "note";
export interface Mark { id: string; kind: MarkKind; r0: number; r1: number } // prose coordinates

type RGB = { red?: number; green?: number; blue?: number };
export const COLORS: Record<MarkKind, RGB> = {
  ins: { red: 0.416, green: 0.239, blue: 0.784 },
  del: { red: 0.788, green: 0.114, blue: 0.122 },
  note: { red: 0.996, green: 0.937, blue: 0.639 },
};
const near = (a: RGB | undefined, b: RGB) => !!a && ["red", "green", "blue"].every((k) => Math.abs(((a as any)[k] ?? 0) - ((b as any)[k] ?? 0)) < 0.004);
const styleFor = (k: MarkKind) =>
  k === "note"
    ? { textStyle: { backgroundColor: { color: { rgbColor: COLORS.note } } }, fields: "backgroundColor" }
    : { textStyle: { foregroundColor: { color: { rgbColor: COLORS[k] } }, ...(k === "ins" ? { underline: true } : { strikethrough: true }) }, fields: k === "ins" ? "foregroundColor,underline" : "foregroundColor,strikethrough" };

/** Requests that clear the old markers and draw the current ones. `prose` is the text these marks index. */
const STYLE: Record<string, string> = { h1: "HEADING_1", h2: "HEADING_2", h3: "HEADING_3", h4: "HEADING_4", p: "NORMAL_TEXT" };

export function markRequests(doc: GDoc, prose: string, marks: Mark[], blocks: { kind: string; r0: number }[] = []): object[] {
  const reqs: object[] = [];
  // 1. clear runs that carry our markers (and only those)
  for (const el of doc.body?.content ?? []) for (const pe of el.paragraph?.elements ?? []) {
    const st = (pe.textRun as any)?.textStyle;
    if (!st || pe.startIndex === undefined || pe.endIndex === undefined) continue;
    const fg = st.foregroundColor?.color?.rgbColor, bg = st.backgroundColor?.color?.rgbColor;
    const fields = [
      ...(near(fg, COLORS.ins) ? ["foregroundColor", "underline"] : []),
      ...(near(fg, COLORS.del) ? ["foregroundColor", "strikethrough"] : []),
      ...(near(bg, COLORS.note) ? ["backgroundColor"] : []),
    ];
    if (fields.length) reqs.push({ updateTextStyle: { range: { startIndex: pe.startIndex, endIndex: pe.endIndex }, textStyle: {}, fields: [...new Set(fields)].join(",") } });
  }
  // 2. draw the current marks where their words now sit in the doc
  const { text, idx } = docText(doc);
  const ops = diffText(prose, text);
  if (!ops) return reqs;
  // 3. each paragraph takes the style its LaTeX has: text added after a heading must not stay a heading
  if (blocks.length) {
    const posOf = new Map(idx.map((d, p) => [d, p]));
    for (const el of doc.body?.content ?? []) {
      const para = el.paragraph;
      const first = para?.elements?.find((pe) => pe.textRun?.content && !pe.textRun.suggestedInsertionIds?.length && pe.textRun.content !== "\n");
      if (!para || !first || first.startIndex === undefined || el.startIndex === undefined || el.endIndex === undefined) continue;
      const p = posOf.get(first.startIndex);
      if (p === undefined) continue;
      const r = mapToA(ops, p);
      let k = -1;
      for (let i = 0; i < blocks.length && blocks[i]!.r0 <= r; i++) k = i;
      const want = k >= 0 ? STYLE[blocks[k]!.kind] : undefined;
      if (want && para.paragraphStyle?.namedStyleType && para.paragraphStyle.namedStyleType !== want)
        reqs.push({ updateParagraphStyle: { range: { startIndex: el.startIndex, endIndex: el.endIndex }, paragraphStyle: { namedStyleType: want }, fields: "namedStyleType" } });
    }
  }
  for (const m of marks) {
    if (m.r1 <= m.r0) continue;
    const a = mapToB(ops, m.r0), b = mapToB(ops, m.r1 - 1) + 1;
    for (let p = a; p < b;) { // consecutive document indices only
      let q = p + 1;
      while (q < b && idx[q] === idx[q - 1]! + 1) q++;
      if (idx[p] !== undefined && idx[q - 1] !== undefined) reqs.push({ updateTextStyle: { range: { startIndex: idx[p]!, endIndex: idx[q - 1]! + 1 }, ...styleFor(m.kind) } });
      p = q;
    }
  }
  return reqs;
}

/** One Google comment per suggestion or note of yours. */
export interface MirrorItem { id: string; content: string; quote: string; replies: string[]; resolved: boolean }
export interface MirrorState { cid: string; content: string; replies: number; resolved: boolean }
export interface CommentApi {
  addComment(docId: string, content: string, quote: string): Promise<string>;
  editComment(docId: string, id: string, content: string): Promise<void>;
  deleteComment(docId: string, id: string): Promise<void>;
  addReply(docId: string, id: string, content: string, action?: "resolve" | "reopen"): Promise<void>;
}

/** Bring the doc's comments in line with your items; returns the new mirror state. */
export async function syncComments(api: CommentApi, docId: string, items: MirrorItem[], mirror: Record<string, MirrorState>, closing: (id: string) => "delete" | string) {
  const next: Record<string, MirrorState> = {};
  for (const it of items) {
    const was = mirror[it.id];
    if (!was) {
      const cid = await api.addComment(docId, it.content, it.quote);
      for (const r of it.replies) await api.addReply(docId, cid, r);
      if (it.resolved) await api.addReply(docId, cid, "Resolved in Vega Fluo.", "resolve");
      next[it.id] = { cid, content: it.content, replies: it.replies.length, resolved: it.resolved };
      continue;
    }
    const st = { ...was };
    if (st.content !== it.content) { await api.editComment(docId, st.cid, it.content); st.content = it.content; }
    for (const r of it.replies.slice(st.replies)) await api.addReply(docId, st.cid, r);
    st.replies = Math.max(st.replies, it.replies.length);
    if (it.resolved !== st.resolved) { await api.addReply(docId, st.cid, it.resolved ? "Resolved in Vega Fluo." : "Reopened in Vega Fluo.", it.resolved ? "resolve" : "reopen"); st.resolved = it.resolved; }
    next[it.id] = st;
  }
  for (const [id, st] of Object.entries(mirror)) {
    if (next[id]) continue;
    const how = closing(id);
    if (how === "delete") await api.deleteComment(docId, st.cid).catch(() => {});
    else if (!st.resolved) await api.addReply(docId, st.cid, how, "resolve").catch(() => {});
  }
  return next;
}
