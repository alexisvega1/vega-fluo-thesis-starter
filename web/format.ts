// Formatting commands for LaTeX (and a Markdown fallback): bold, italic, maths, symbols, headings,
// lists and tables, as used by the toolbar and the keyboard shortcuts.
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type Lang = "tex" | "md" | "plain";

/** Wrap each selection in before/after; unwrap if it is already wrapped. Empty selection: cursor goes inside. */
export function wrap(view: EditorView, before: string, after: string) {
  const { state } = view;
  view.dispatch(state.changeByRange((r) => {
    const outside = state.sliceDoc(r.from - before.length, r.from) === before && state.sliceDoc(r.to, r.to + after.length) === after;
    if (outside) return { changes: [{ from: r.from - before.length, to: r.from }, { from: r.to, to: r.to + after.length }], range: EditorSelection.range(r.from - before.length, r.to - before.length) };
    const text = state.sliceDoc(r.from, r.to);
    if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length)
      return { changes: { from: r.from, to: r.to, insert: text.slice(before.length, text.length - after.length) }, range: EditorSelection.range(r.from, r.to - before.length - after.length) };
    return { changes: [{ from: r.from, insert: before }, { from: r.to, insert: after }], range: EditorSelection.range(r.from + before.length, r.to + before.length) };
  }), { userEvent: "input.format", scrollIntoView: true });
  view.focus();
}

export const bold = (v: EditorView, lang: Lang) => (lang === "md" ? wrap(v, "**", "**") : wrap(v, "\\textbf{", "}"));
export const italic = (v: EditorView, lang: Lang) => (lang === "md" ? wrap(v, "*", "*") : wrap(v, "\\textit{", "}"));
export const inlineMath = (v: EditorView) => wrap(v, "$", "$");
/** Superscript/subscript: ^{...} / _{...} inside maths, \textsuperscript{...} / \textsubscript{...} in prose. */
export function script(v: EditorView, lang: Lang, up: boolean) {
  const math = inMath(v.state, v.state.selection.main.from);
  if (lang === "md") return wrap(v, up ? "<sup>" : "<sub>", up ? "</sup>" : "</sub>");
  if (math) return wrap(v, up ? "^{" : "_{", "}");
  return wrap(v, up ? "\\textsuperscript{" : "\\textsubscript{", "}");
}
export function displayMath(v: EditorView) {
  const r = v.state.selection.main, text = v.state.sliceDoc(r.from, r.to);
  insertBlock(v, `\\begin{equation}\n  ${text || ""}\n  \\label{eq:}\n\\end{equation}`, text ? -1 : "\\begin{equation}\n  ".length, true);
}

/** True when the cursor sits inside $...$ on its line, or inside a maths environment above it. */
export function inMath(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos), before = line.text.slice(0, pos - line.from).replace(/\\\$/g, "");
  if ((before.match(/\$/g) ?? []).length % 2 === 1) return true;
  const above = state.sliceDoc(Math.max(0, pos - 4000), pos);
  const open = above.lastIndexOf("\\begin{equation"), close = above.lastIndexOf("\\end{equation");
  const o2 = Math.max(above.lastIndexOf("\\begin{align"), above.lastIndexOf("\\["));
  const c2 = Math.max(above.lastIndexOf("\\end{align"), above.lastIndexOf("\\]"));
  return open > close || o2 > c2;
}

/** Insert a LaTeX symbol; outside maths it is wrapped in $...$ so it compiles. */
export function insertSymbol(v: EditorView, cmd: string, textOk = false) {
  const r = v.state.selection.main, math = inMath(v.state, r.from);
  const next = v.state.sliceDoc(r.to, r.to + 1);
  const body = cmd + (/^\\[a-zA-Z]+$/.test(cmd) && /[a-zA-Z]/.test(next) ? " " : "");
  const insert = math || textOk ? body : `$${cmd}$`;
  v.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length }, userEvent: "input.format", scrollIntoView: true });
  v.focus();
}

/** Insert a block on its own lines below the current one. `cursor` is an offset into `text`, or -1 for the end. */
export function insertBlock(v: EditorView, text: string, cursor: number, replaceSelection = false) {
  const r = v.state.selection.main;
  const line = v.state.doc.lineAt(replaceSelection ? r.from : r.head);
  const from = replaceSelection && !r.empty ? r.from : line.to, to = replaceSelection && !r.empty ? r.to : line.to;
  const lead = replaceSelection && !r.empty ? "" : line.text.trim() ? "\n\n" : line.number > 1 ? "\n" : "";
  const insert = lead + text + "\n";
  v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + lead.length + (cursor < 0 ? text.length : cursor) }, userEvent: "input.format", scrollIntoView: true });
  v.focus();
}

export const LEVELS = [
  { id: "text", label: "Normal text" },
  { id: "chapter", label: "Chapter" },
  { id: "section", label: "Section" },
  { id: "subsection", label: "Subsection" },
  { id: "subsubsection", label: "Subsubsection" },
  { id: "paragraph", label: "Paragraph" },
];
const HEAD_TEX = /^(\s*)\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{(.*)\}\s*$/;
const HEAD_MD = /^(#{1,6})\s+(.*)$/;

/** The heading level of the line the cursor is on. */
export function levelAt(state: EditorState, lang: Lang): string {
  const text = state.doc.lineAt(state.selection.main.head).text;
  if (lang === "md") { const m = HEAD_MD.exec(text); return m ? LEVELS[Math.min(m[1]!.length, 5)]!.id : "text"; }
  return HEAD_TEX.exec(text)?.[2] ?? "text";
}

/** Make the current line a heading of the given level (or plain text). */
export function setLevel(v: EditorView, lang: Lang, level: string) {
  const line = v.state.doc.lineAt(v.state.selection.main.head);
  let indent = "", body = line.text;
  if (lang === "md") { const m = HEAD_MD.exec(line.text); if (m) body = m[2]!; }
  else { const m = HEAD_TEX.exec(line.text); if (m) { indent = m[1]!; body = m[3]!; } else { indent = line.text.match(/^\s*/)![0]; body = line.text.trim(); } }
  const n = LEVELS.findIndex((l) => l.id === level);
  const insert = level === "text" ? indent + body : lang === "md" ? `${"#".repeat(Math.max(1, n))} ${body}` : `${indent}\\${level}{${body}}`;
  const cursor = level === "text" || lang === "md" ? line.from + insert.length : line.from + insert.length - 1;
  v.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: cursor }, userEvent: "input.format" });
  v.focus();
}

/** Turn the selected lines (or a new empty one) into a bulleted or numbered list. */
export function list(v: EditorView, lang: Lang, numbered: boolean) {
  const r = v.state.selection.main;
  const a = v.state.doc.lineAt(r.from), b = v.state.doc.lineAt(r.to);
  const lines = r.empty ? [""] : v.state.sliceDoc(a.from, b.to).split("\n").filter((l) => l.trim());
  if (lang === "md") {
    const text = lines.map((l, i) => `${numbered ? `${i + 1}.` : "-"} ${l.trim()}`).join("\n");
    v.dispatch({ changes: { from: a.from, to: r.empty ? a.to : b.to, insert: r.empty ? a.text + (a.text ? "\n" : "") + text : text }, userEvent: "input.format" });
    return v.focus();
  }
  const env = numbered ? "enumerate" : "itemize";
  const text = `\\begin{${env}}\n${lines.map((l) => `  \\item ${l.trim()}`).join("\n")}\n\\end{${env}}`;
  if (r.empty) insertBlock(v, text, `\\begin{${env}}\n  \\item `.length);
  else { v.dispatch({ changes: { from: a.from, to: b.to, insert: text }, selection: { anchor: a.from + text.length }, userEvent: "input.format" }); v.focus(); }
}

/** A table with a caption and label, the cursor in the first cell. */
export function table(v: EditorView, rows: number, cols: number) {
  const row = (cells: string[]) => `    ${cells.join(" & ")} \\\\`;
  const head = row(Array.from({ length: cols }, (_, i) => `Heading ${i + 1}`));
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => row(Array.from({ length: cols }, () => " "))).join("\n");
  const text = [
    "\\begin{table}[htbp]", "  \\centering", "  \\caption{}", "  \\label{tab:}",
    `  \\begin{tabular}{${"l".repeat(cols)}}`, "    \\hline", head, "    \\hline", body, "    \\hline", "  \\end{tabular}", "\\end{table}",
  ].join("\n");
  insertBlock(v, text, text.indexOf("\\caption{") + "\\caption{".length);
}

/** Symbol groups for the picker: [LaTeX, shown as, works outside maths]. */
export const SYMBOLS: Record<string, [string, string][]> = {
  Greek: [["\\alpha", "α"], ["\\beta", "β"], ["\\gamma", "γ"], ["\\delta", "δ"], ["\\epsilon", "ε"], ["\\varepsilon", "ϵ"], ["\\zeta", "ζ"], ["\\eta", "η"], ["\\theta", "θ"], ["\\vartheta", "ϑ"], ["\\iota", "ι"], ["\\kappa", "κ"], ["\\lambda", "λ"], ["\\mu", "μ"], ["\\nu", "ν"], ["\\xi", "ξ"], ["\\pi", "π"], ["\\rho", "ρ"], ["\\sigma", "σ"], ["\\tau", "τ"], ["\\upsilon", "υ"], ["\\phi", "ϕ"], ["\\varphi", "φ"], ["\\chi", "χ"], ["\\psi", "ψ"], ["\\omega", "ω"], ["\\Gamma", "Γ"], ["\\Delta", "Δ"], ["\\Theta", "Θ"], ["\\Lambda", "Λ"], ["\\Xi", "Ξ"], ["\\Pi", "Π"], ["\\Sigma", "Σ"], ["\\Phi", "Φ"], ["\\Psi", "Ψ"], ["\\Omega", "Ω"]],
  Arrows: [["\\rightarrow", "→"], ["\\leftarrow", "←"], ["\\leftrightarrow", "↔"], ["\\uparrow", "↑"], ["\\downarrow", "↓"], ["\\Rightarrow", "⇒"], ["\\Leftarrow", "⇐"], ["\\Leftrightarrow", "⇔"], ["\\mapsto", "↦"], ["\\longrightarrow", "⟶"], ["\\rightleftharpoons", "⇌"], ["\\nearrow", "↗"], ["\\searrow", "↘"]],
  Operators: [["\\pm", "±"], ["\\mp", "∓"], ["\\times", "×"], ["\\div", "÷"], ["\\cdot", "·"], ["\\sum", "∑"], ["\\prod", "∏"], ["\\int", "∫"], ["\\partial", "∂"], ["\\nabla", "∇"], ["\\sqrt{}", "√"], ["\\frac{}{}", "a/b"], ["^{}", "xⁿ"], ["_{}", "xₙ"], ["\\infty", "∞"], ["\\cup", "∪"], ["\\cap", "∩"]],
  Relations: [["\\leq", "≤"], ["\\geq", "≥"], ["\\neq", "≠"], ["\\approx", "≈"], ["\\sim", "∼"], ["\\simeq", "≃"], ["\\equiv", "≡"], ["\\propto", "∝"], ["\\ll", "≪"], ["\\gg", "≫"], ["\\in", "∈"], ["\\notin", "∉"], ["\\subset", "⊂"], ["\\subseteq", "⊆"]],
  Text: [["\\%", "%"], ["\\&", "&"], ["\\#", "#"], ["\\_", "_"], ["\\$", "$"], ["\\textdegree{}", "°"], ["\\textmu{}", "µ"], ["~", "nbsp"], ["--", "–"], ["---", "—"], ["\\ldots{}", "…"], ["``''", "“ ”"], ["\\textsuperscript{}", "ˢᵘᵖ"], ["\\textsubscript{}", "ₛᵤ♭"]],
};
