// A whole-document overview down the right edge of the editor, like Sublime's minimap.
// Every line is drawn as a short bar; headings stand out; tracked changes, comments and
// unresolved citations show as coloured ticks. Click or drag to move through the document.
import type { EditorView } from "@codemirror/view";
import type { Review } from "./review-model";
import { hue } from "./review";

interface Row { indent: number; len: number; kind: "text" | "heading" | "comment" | "blank" | "command" }

const HEADING = /^\s*(?:\\(?:chapter|(?:sub){0,2}section)\*?\{|#{1,4}\s)/;

export function createMinimap(view: EditorView, canvas: HTMLCanvasElement, getReview: () => Review, isUnknownCite: (line: string) => boolean) {
  const ctx = canvas.getContext("2d")!;
  let rows: Row[] = [];
  let flagged = new Set<number>(); // 0-based lines holding a citation that is not in the library
  let w = 0, h = 0, raf = 0, dragging = false;

  /** Height of one document line in the minimap: 3px when it fits, squeezed when the document is long. */
  const lineH = () => Math.min(3, h / Math.max(1, rows.length));

  function rebuild() {
    const doc = view.state.doc;
    rows = [];
    flagged = new Set();
    for (let n = 1; n <= doc.lines; n++) {
      const text = doc.line(n).text;
      const trimmed = text.trimStart();
      const kind: Row["kind"] = !trimmed ? "blank" : HEADING.test(text) ? "heading" : trimmed.startsWith("%") ? "comment" : /^\\(?:begin|end|label|input|include|usepackage|documentclass)\b/.test(trimmed) ? "command" : "text";
      rows.push({ indent: text.length - trimmed.length, len: Math.min(trimmed.length, 110), kind });
      if (kind === "text" && isUnknownCite(text)) flagged.add(n - 1);
    }
    schedule();
  }

  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }
  new ResizeObserver(resize).observe(canvas);

  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }

  /** First and last document line (0-based) currently on screen. */
  function visible(): [number, number] {
    const s = view.scrollDOM, doc = view.state.doc;
    const top = view.lineBlockAtHeight(s.scrollTop), bottom = view.lineBlockAtHeight(s.scrollTop + s.clientHeight);
    return [doc.lineAt(top.from).number - 1, doc.lineAt(Math.min(bottom.to, doc.length)).number - 1];
  }

  function draw() {
    if (!w) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const ink = v("--ink"), accent = v("--accent"), warn = v("--warn"), muted = v("--muted");
    ctx.clearRect(0, 0, w, h);
    const lh = lineH(), scale = (w - 16) / 110, bar = Math.max(0.6, lh - 0.8);

    // the part of the document on screen
    const [a, b] = visible();
    ctx.fillStyle = accent; ctx.globalAlpha = 0.14;
    ctx.fillRect(0, a * lh, w, Math.max(8, (b - a + 1) * lh));
    ctx.globalAlpha = 0.55; ctx.fillRect(0, a * lh, 2, Math.max(8, (b - a + 1) * lh));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.kind === "blank") continue;
      const y = i * lh;
      if (r.kind === "heading") { ctx.globalAlpha = 0.95; ctx.fillStyle = accent; ctx.fillRect(6, y, Math.max(18, r.len * scale), Math.max(1.6, bar + 0.8)); continue; }
      ctx.fillStyle = r.kind === "text" ? ink : muted;
      ctx.globalAlpha = r.kind === "text" ? 0.36 : 0.2;
      ctx.fillRect(6 + Math.min(r.indent, 12) * scale, y, Math.max(1, r.len * scale), bar);
    }

    // ticks in the right margin: tracked changes, comments, citations not in the library
    const doc = view.state.doc, rv = getReview();
    const tick = (line: number, color: string) => { ctx.fillStyle = color; ctx.globalAlpha = 0.95; ctx.fillRect(w - 6, line * lh - 0.5, 5, Math.max(2, lh)); };
    const lineOf = (pos: number) => doc.lineAt(Math.min(pos, doc.length)).number - 1;
    // each person's changes in their own colour, as in the text (e.g. the doc reviewer's red, your purple)
    const who = (author: string) => `hsl(${hue(author)} 65% 60%)`;
    for (const i of rv.ins) for (let n = lineOf(i.from); n <= lineOf(i.to); n++) tick(n, who(i.author));
    for (const d of rv.dels) tick(lineOf(d.pos), who(d.author));
    for (const c of rv.comments) if (!c.resolved) tick(lineOf(c.from), "#e0a800");
    for (const n of flagged) tick(n, warn);
    ctx.globalAlpha = 1;
  }

  /** Scroll the editor so the line under the pointer sits mid-screen. */
  function go(ev: PointerEvent) {
    const y = ev.clientY - canvas.getBoundingClientRect().top;
    const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(y / lineH()) + 1));
    const block = view.lineBlockAt(view.state.doc.line(n).from);
    view.scrollDOM.scrollTop = Math.max(0, block.top - view.scrollDOM.clientHeight / 2);
  }
  canvas.addEventListener("pointerdown", (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); go(e); });
  canvas.addEventListener("pointermove", (e) => { if (dragging) go(e); });
  canvas.addEventListener("pointerup", (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener("pointercancel", () => { dragging = false; });
  view.scrollDOM.addEventListener("scroll", schedule, { passive: true });

  return { rebuild, redraw: schedule };
}
