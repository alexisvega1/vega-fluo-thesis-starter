// The visual view: each figure environment is shown as the figure itself with its caption and
// label, and a pencil that opens the Edit figure dialog. The LaTeX underneath is untouched until
// you change something; switching back to Code shows it again.
import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { findFigures, parseFigure } from "./figure-edit";

type Open = (view: EditorView, from: number, to: number) => void;

/** "clean": show figures/<name>_clean.pdf where it exists, as the build does after \figureversion{clean}. */
let figureVersion: "text" | "clean" = "text";
export const setFigureVersion = (v: "text" | "clean") => { figureVersion = v; };
const cleanName = (f: string) => f.replace(/\.pdf$/i, "") + "_clean.pdf";

class FigureCard extends WidgetType {
  constructor(readonly block: string, readonly open: Open) { super(); }
  eq(o: FigureCard) { return o.block === this.block; }
  get estimatedHeight() { return 300; }
  toDOM(view: EditorView) {
    const f = parseFigure(this.block);
    const el = document.createElement("div");
    el.className = "figcard";
    const img = document.createElement("img");
    img.alt = f.file;
    img.loading = "lazy";
    const thumb = (file: string) => `/api/figure/thumb?file=${encodeURIComponent(file)}&size=large`;
    const clean = figureVersion === "clean" && f.file && !/_clean\.pdf$/i.test(f.file);
    img.src = thumb(clean ? cleanName(f.file) : f.file);
    img.style.width = `${Math.round((f.width ?? 1) * 100)}%`;
    if (clean) img.dataset.fallback = thumb(f.file);
    img.onerror = () => {
      if (img.dataset.fallback) { img.src = img.dataset.fallback; delete img.dataset.fallback; return; } // no clean version of this one
      const miss = document.createElement("p"); miss.className = "figmiss"; miss.textContent = f.file ? `No preview for ${f.file}` : "This figure has no \\includegraphics yet"; img.replaceWith(miss); };
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "figedit"; edit.title = "Edit figure"; edit.textContent = "✎";
    edit.setAttribute("aria-label", "Edit figure");
    const go = () => { const from = view.posAtDOM(el); const hit = findFigures(view.state.doc.toString()).find((r) => r.from <= from + 1 && r.to >= from); if (hit) this.open(view, hit.from, hit.to); };
    edit.onclick = go;
    el.ondblclick = go;
    el.append(edit, img);
    if (f.caption !== null) { const c = document.createElement("div"); c.className = "figcap"; c.textContent = f.caption || "(empty caption)"; el.append(c); }
    if (f.label !== null) { const l = document.createElement("div"); l.className = "figlabel"; l.textContent = f.label + (clean ? "  · clean version" : ""); el.append(l); }
    return el;
  }
  ignoreEvent() { return true; }
}

function build(state: EditorState, open: Open): DecorationSet {
  const text = state.doc.toString(), marks: Range<Decoration>[] = [];
  for (const r of findFigures(text)) {
    const a = state.doc.lineAt(r.from), b = state.doc.lineAt(r.to);
    if (a.text.slice(0, r.from - a.from).trim() || b.text.slice(r.to - b.from).trim()) continue; // shares a line with other text: leave as code
    marks.push(Decoration.replace({ widget: new FigureCard(text.slice(r.from, r.to), open), block: true }).range(a.from, b.to));
  }
  return Decoration.set(marks);
}

export function visualFigures(open: Open): Extension {
  const field = StateField.define<DecorationSet>({
    create: (s) => build(s, open),
    update: (v, tr) => (tr.docChanged ? build(tr.state, open) : v),
    provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
  });
  return field;
}
