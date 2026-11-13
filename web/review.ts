// CodeMirror side of tracked changes: records edits as suggestions while "Suggesting" is on,
// keeps suggestion and comment anchors in step with every edit, and draws them.
import { Annotation, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { subtract, type DocComment, type DocDel, type DocIns, type Review } from "./review-model";

export const emptyReview = (): Review => ({ ins: [], dels: [], comments: [] });

/** Marks a change the review layer made itself (accept/reject), so it is not tracked as a new suggestion. */
export const internal = Annotation.define<boolean>();

export const setSuggesting = StateEffect.define<boolean>();
export const suggestingField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setSuggesting)) return e.value; return v; },
});

type Edit =
  | { op: "dropIns" | "dropDel" | "dropComment"; id: string }
  | { op: "addComment" | "setComment"; comment: DocComment };
export const reviewEdit = StateEffect.define<Edit>();

let author = "Me";
export const setAuthor = (name: string) => { author = name; };
export const currentAuthor = () => author;
const newId = () => crypto.randomUUID().slice(0, 8);

/** A stable hue per author so each person's changes are recognisable. */
export function hue(name: string) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return [172, 28, 265, 330, 210, 95][n % 6]!;
}

function track(v: Review, tr: Transaction): Review {
  const tracking = tr.startState.field(suggestingField) && !tr.annotation(internal);
  const ts = Date.now();
  const cancelled = new Set<string>();
  const grown = new Map<string, [number, number]>(); // own insertion extended by typing at its edge
  const newIns: DocIns[] = [];
  const newDels: (DocDel & { order: number })[] = [];

  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (toA > fromA && tracking) {
      // only accepted text becomes a suggested deletion; deleting inside a suggested insertion just shrinks it
      let spans = subtract([[fromA, toA]], v.ins.map((i) => [i.from, i.to] as [number, number]));
      // keep text order right around deletions that already sit inside the range
      for (const d of v.dels) spans = spans.flatMap(([a, b]) => (a < d.pos && d.pos < b ? [[a, d.pos], [d.pos, b]] : [[a, b]]) as [number, number][]);
      for (const [a, b] of spans)
        newDels.push({ id: newId(), author, ts, pos: tr.changes.mapPos(a, -1), text: tr.startState.sliceDoc(a, b), order: a + 0.5 });
    }
    if (toB > fromB) {
      const text = inserted.toString();
      // putting deleted text back where it was (undo, or retyping it) cancels the deletion
      const undone = fromA === toA && v.dels.find((d) => d.pos === fromA && d.text === text && !cancelled.has(d.id));
      if (undone) { cancelled.add(undone.id); return; }
      if (!tracking) return;
      const own = v.ins.find((i) => i.author === author && i.from <= fromA && toA <= i.to);
      if (own) grown.set(own.id, [fromB, toB]);
      else newIns.push({ id: newId(), author, ts, from: fromB, to: toB });
    }
  });

  const ins = v.ins
    .map((i) => {
      let from = tr.changes.mapPos(i.from, 1), to = tr.changes.mapPos(i.to, -1);
      const g = grown.get(i.id);
      if (g) { from = Math.min(from, g[0]); to = Math.max(to, g[1]); }
      return { ...i, from, to };
    })
    .filter((i) => i.to > i.from)
    .concat(newIns)
    .sort((a, b) => a.from - b.from);

  // deletions: existing ones keep their place; text deleted next to one joins it in reading order
  const all = v.dels
    .filter((d) => !cancelled.has(d.id))
    .map((d) => ({ ...d, order: d.pos, pos: tr.changes.mapPos(d.pos, -1) }))
    .concat(newDels)
    .sort((a, b) => a.pos - b.pos || a.order - b.order);
  const dels: DocDel[] = [];
  for (const { order: _o, ...d } of all) {
    const prev = dels[dels.length - 1];
    if (prev && prev.pos === d.pos && prev.author === d.author) prev.text += d.text;
    else dels.push(d);
  }

  const comments = v.comments.map((c) => {
    const from = tr.changes.mapPos(c.from, 1);
    return { ...c, from, to: Math.max(from, tr.changes.mapPos(c.to, -1)) };
  });
  return { ins, dels, comments };
}

class DelWidget extends WidgetType {
  constructor(readonly d: DocDel) { super(); }
  eq(o: DelWidget) { return o.d.id === this.d.id && o.d.text === this.d.text; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-del";
    el.style.setProperty("--who", String(hue(this.d.author)));
    el.title = `${this.d.author} suggests deleting this`;
    el.dataset.review = this.d.id;
    el.textContent = this.d.text.replace(/\n/g, "¶");
    return el;
  }
  ignoreEvent() { return false; }
}

export const reviewField = StateField.define<Review>({
  create: emptyReview,
  update(v, tr) {
    if (tr.docChanged) v = track(v, tr);
    for (const e of tr.effects) {
      if (!e.is(reviewEdit)) continue;
      const x = e.value;
      if (x.op === "dropIns") v = { ...v, ins: v.ins.filter((i) => i.id !== x.id) };
      else if (x.op === "dropDel") v = { ...v, dels: v.dels.filter((d) => d.id !== x.id) };
      else if (x.op === "dropComment") v = { ...v, comments: v.comments.filter((c) => c.id !== x.id) };
      else if (x.op === "addComment") v = { ...v, comments: [...v.comments, x.comment].sort((a, b) => a.from - b.from) };
      else v = { ...v, comments: v.comments.map((c) => (c.id === x.comment.id ? x.comment : c)) };
    }
    return v;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (v) =>
      Decoration.set(
        [
          ...v.ins.map((i) => Decoration.mark({ class: "cm-ins", attributes: { style: `--who:${hue(i.author)}`, title: `${i.author} suggests adding this`, "data-review": i.id } }).range(i.from, i.to)),
          ...v.dels.map((d) => Decoration.widget({ widget: new DelWidget(d), side: -1 }).range(d.pos)),
          ...v.comments.filter((c) => !c.resolved && c.to > c.from).map((c) => Decoration.mark({ class: "cm-comment", attributes: { "data-comment": c.id, title: `${c.author}: ${c.text.slice(0, 140)}${c.text.length > 140 ? "…" : ""} (click to open)` } }).range(c.from, c.to)),
        ],
        true,
      )),
});

// ---------- actions ----------
export function acceptSuggestion(view: EditorView, id: string) {
  const r = view.state.field(reviewField);
  view.dispatch({ effects: [reviewEdit.of({ op: "dropIns", id }), reviewEdit.of({ op: "dropDel", id })] });
  return r;
}

export function rejectSuggestion(view: EditorView, id: string) {
  const r = view.state.field(reviewField);
  const i = r.ins.find((x) => x.id === id);
  const d = r.dels.find((x) => x.id === id);
  if (i) view.dispatch({ changes: { from: i.from, to: i.to }, effects: reviewEdit.of({ op: "dropIns", id }), annotations: internal.of(true) });
  else if (d) view.dispatch({ changes: { from: d.pos, insert: d.text }, effects: reviewEdit.of({ op: "dropDel", id }), annotations: internal.of(true) });
}

export function resolveAll(view: EditorView, accept: boolean) {
  const r = view.state.field(reviewField);
  const effects = [...r.ins.map((i) => reviewEdit.of({ op: "dropIns", id: i.id })), ...r.dels.map((d) => reviewEdit.of({ op: "dropDel", id: d.id }))];
  if (accept) return view.dispatch({ effects });
  const changes = [...r.ins.map((i) => ({ from: i.from, to: i.to })), ...r.dels.map((d) => ({ from: d.pos, insert: d.text }))];
  view.dispatch({ changes, effects, annotations: internal.of(true) });
}

export function addComment(view: EditorView, text: string) {
  const sel = view.state.selection.main;
  if (sel.empty || !text.trim()) return false;
  const comment: DocComment = { id: newId(), author, ts: Date.now(), from: sel.from, to: sel.to, quote: view.state.sliceDoc(sel.from, sel.to).slice(0, 200), text: text.trim(), resolved: false, replies: [] };
  view.dispatch({ effects: reviewEdit.of({ op: "addComment", comment }) });
  return true;
}
