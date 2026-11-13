// Tracked changes and comments, independent of the editor.
//
// Two coordinate systems:
//   base — the accepted text. This is what is saved to the .tex file and what compiles.
//   doc  — what the editor shows: base with every pending suggestion applied
//          (suggested insertions present, suggested deletions removed and drawn as struck text).
// The sidecar file stores everything in base coordinates, with enough context to re-anchor
// if the file was changed outside the editor.

export interface Stamp { id: string; author: string; ts: number }

// --- stored (base coordinates) ---
export interface Ins extends Stamp { type: "ins"; at: number; text: string; before: string }
export interface Del extends Stamp { type: "del"; from: number; to: number; text: string }
export interface Reply { author: string; ts: number; text: string }
export interface Comment extends Stamp { from: number; to: number; quote: string; text: string; resolved: boolean; replies: Reply[] }
export interface Sidecar { version: 1; suggestions: (Ins | Del)[]; comments: Comment[]; orphans: (Ins | Del)[] }
export const emptySidecar = (): Sidecar => ({ version: 1, suggestions: [], comments: [], orphans: [] });

// --- live (doc coordinates) ---
export interface DocIns extends Stamp { from: number; to: number }
export interface DocDel extends Stamp { pos: number; text: string }
export interface DocComment extends Stamp { from: number; to: number; quote: string; text: string; resolved: boolean; replies: Reply[] }
export interface Review { ins: DocIns[]; dels: DocDel[]; comments: DocComment[] }

const CONTEXT = 24;

/** doc -> base: strip suggested insertions, put suggested deletions back. */
export function toBase(doc: string, r: Review): { base: string; sidecar: Sidecar } {
  const cuts = [...new Set([0, doc.length, ...r.ins.flatMap((i) => [i.from, i.to]), ...r.dels.map((d) => d.pos)])].sort((a, b) => a - b);
  const suggestions: (Ins | Del)[] = [];
  const pieces = new Map<string, number>();
  let base = "";
  // base offset for every cut point, taken before and after the deletions that sit at that point
  const beforeDels = new Map<number, number>(), afterDels = new Map<number, number>();

  for (let c = 0; c < cuts.length; c++) {
    const a = cuts[c]!;
    beforeDels.set(a, base.length);
    for (const d of r.dels) {
      if (d.pos !== a) continue;
      suggestions.push({ type: "del", id: d.id, author: d.author, ts: d.ts, from: base.length, to: base.length + d.text.length, text: d.text });
      base += d.text;
    }
    afterDels.set(a, base.length);
    const b = cuts[c + 1];
    if (b === undefined) break;
    const ins = r.ins.find((i) => i.from <= a && b <= i.to);
    if (!ins) { base += doc.slice(a, b); continue; }
    // an insertion split by a deletion inside it is stored as consecutive pieces
    const n = pieces.get(ins.id) ?? 0;
    pieces.set(ins.id, n + 1);
    suggestions.push({ type: "ins", id: n ? `${ins.id}~${n}` : ins.id, author: ins.author, ts: ins.ts, at: base.length, text: doc.slice(a, b), before: base.slice(-CONTEXT) });
  }

  /** Base offset of a doc position that is not itself a cut point. */
  const baseAt = (pos: number, after: boolean) => {
    const known = (after ? afterDels : beforeDels).get(pos);
    if (known !== undefined) return known;
    let lo = 0;
    for (const c of cuts) if (c <= pos) lo = c;
    const inside = r.ins.some((i) => i.from <= lo && pos <= i.to);
    return afterDels.get(lo)! + (inside ? 0 : pos - lo);
  };
  const comments: Comment[] = r.comments.map((c) => {
    const from = baseAt(c.from, true);
    return { id: c.id, author: c.author, ts: c.ts, from, to: Math.max(from, baseAt(c.to, false)), quote: c.quote, text: c.text, resolved: c.resolved, replies: c.replies };
  });
  return { base, sidecar: { version: 1, suggestions, comments, orphans: [] } };
}

/** Closest occurrence of `needle` in `hay` to position `near`, or -1. */
function nearest(hay: string, needle: string, near: number): number {
  if (!needle) return -1;
  let best = -1;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1))
    if (best === -1 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  return best;
}

/** base + sidecar -> doc. Suggestions that no longer fit the text are returned as orphans, never applied blindly. */
export function fromBase(base: string, side: Sidecar): { doc: string; review: Review; orphans: (Ins | Del)[] } {
  const orphans: (Ins | Del)[] = [...(side.orphans ?? [])];
  const items: (Ins | Del)[] = [];
  for (const s of side.suggestions ?? []) {
    if (s.type === "del") {
      if (base.slice(s.from, s.to) === s.text) { items.push(s); continue; }
      const i = nearest(base, s.text, s.from);
      if (i === -1) orphans.push(s);
      else items.push({ ...s, from: i, to: i + s.text.length });
    } else {
      if (s.at <= base.length && base.slice(Math.max(0, s.at - s.before.length), s.at) === s.before) { items.push(s); continue; }
      const i = nearest(base, s.before, s.at - s.before.length);
      if (i === -1) orphans.push(s);
      else items.push({ ...s, at: i + s.before.length });
    }
  }
  const key = (s: Ins | Del) => (s.type === "ins" ? s.at : s.from);
  // at the same offset an insertion sorts before a deletion that starts there
  items.sort((a, b) => key(a) - key(b) || (a.type === "ins" ? 0 : 1) - (b.type === "ins" ? 0 : 1));

  const review: Review = { ins: [], dels: [], comments: [] };
  // checkpoints: base offset -> doc offset at that point, for mapping comments
  const marks: { base: number; doc: number }[] = [{ base: 0, doc: 0 }];
  let doc = "", c = 0;
  for (const s of items) {
    if (s.type === "del") {
      if (s.from < c) { orphans.push(s); continue; } // overlaps an earlier deletion
      doc += base.slice(c, s.from);
      review.dels.push({ id: s.id, author: s.author, ts: s.ts, pos: doc.length, text: s.text });
      c = s.to;
    } else {
      if (s.at > c) { doc += base.slice(c, s.at); c = s.at; }
      const prev = review.ins[review.ins.length - 1];
      const root = s.id.split("~")[0]!;
      if (prev && prev.id === root && prev.to === doc.length) prev.to += s.text.length; // re-join split pieces
      else review.ins.push({ id: root, author: s.author, ts: s.ts, from: doc.length, to: doc.length + s.text.length });
      doc += s.text;
    }
    marks.push({ base: c, doc: doc.length });
  }
  doc += base.slice(c);

  const docAt = (b: number) => {
    let m = marks[0]!;
    for (const k of marks) if (k.base <= b) m = k;
    return Math.min(doc.length, m.doc + (b - m.base));
  };
  for (const cm of side.comments ?? []) {
    let { from, to } = cm;
    if (cm.quote && base.slice(from, to) !== cm.quote) {
      const i = nearest(base, cm.quote, from);
      if (i !== -1) { from = i; to = i + cm.quote.length; }
    }
    const f = docAt(Math.min(from, base.length));
    review.comments.push({ id: cm.id, author: cm.author, ts: cm.ts, from: f, to: Math.max(f, docAt(Math.min(to, base.length))), quote: cm.quote, text: cm.text, resolved: cm.resolved, replies: cm.replies ?? [] });
  }
  return { doc, review, orphans };
}

/** Remove [a,b) intervals covered by `holes` from the interval list. */
export function subtract(spans: [number, number][], holes: [number, number][]): [number, number][] {
  let out = spans;
  for (const [h0, h1] of holes) {
    const next: [number, number][] = [];
    for (const [a, b] of out) {
      if (h1 <= a || h0 >= b) { next.push([a, b]); continue; }
      if (a < h0) next.push([a, h0]);
      if (h1 < b) next.push([h1, b]);
    }
    out = next;
  }
  return out;
}
