// LaTeX -> readable prose for a reviewer who should never see markup, with a map back to the source.
//
// Every visible character of the prose belongs to a segment that knows which source range produced it:
//   "text"  — copied character for character from the source; an edit inside it maps exactly
//   "atom"  — a rendered stand-in for markup (a citation, an equation, "~"); it can only be kept or removed whole
// Markup that renders to nothing (\label, comments, the \textbf{ } wrapper) has no segment, so an edit
// to the prose can never delete it by accident.

export interface Seg { r0: number; r1: number; s0: number; s1: number; kind: "text" | "atom" }
export interface Block { kind: "h1" | "h2" | "h3" | "h4" | "p"; text: string; r0: number }
export interface Prose { text: string; segs: Seg[]; blocks: Block[] }

const HEADINGS: Record<string, Block["kind"]> = { chapter: "h1", section: "h2", subsection: "h3", subsubsection: "h4", paragraph: "h4" };
const FORMAT = new Set(["textbf", "textit", "emph", "underline", "textsc", "textrm", "textsf", "texttt", "text", "mbox", "textsuperscript", "textsubscript", "uline"]);
const DROP = new Set(["label", "index", "input", "include", "bibliography", "bibliographystyle", "vspace", "hspace", "includegraphics", "todo", "pagestyle", "thispagestyle", "setcounter", "addcontentsline", "phantomsection", "caption", "footnotetext"]);
const TRANSPARENT = new Set(["document", "abstract", "quote", "quotation", "center", "itemize", "enumerate", "description", "flushleft", "flushright"]);
const SPECIAL_CHAR = new Set(["%", "&", "_", "#", "$", "{", "}"]);


// ---------- LaTeX snippets as readable Unicode (math, escapes, references) ----------
const SYM: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ", delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ",
  iota: "ι", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ",
  upsilon: "υ", phi: "φ", varphi: "φ", Phi: "Φ", chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω",
  times: "×", cdot: "·", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", leftrightarrow: "↔", infty: "∞", circ: "∘", degree: "°", ldots: "…", cdots: "⋯", dots: "…",
  in: "∈", propto: "∝", partial: "∂", sum: "Σ", prod: "Π", int: "∫", mid: "|", lvert: "|", rvert: "|", vert: "|", ll: "≪", gg: "≫",
  langle: "⟨", rangle: "⟩", lbrace: "{", rbrace: "}", backslash: "\\", percent: "%", textendash: "–", textemdash: "—", S: "§", dagger: "†", ddagger: "‡",
  textasciitilde: "~", textdegree: "°", textmu: "µ", micro: "µ", textpm: "±", texttimes: "×", ast: "*", star: "⋆", prime: "′", AA: "Å",
};
const SPACE = new Set(["quad", "qquad", "enspace", "thinspace", "space", "medspace", "thickspace"]);
const KEEP = new Set(["text", "textrm", "textit", "textbf", "textsf", "texttt", "mathrm", "mathit", "mathbf", "mathsf", "mathtt", "mathcal", "mathbb", "operatorname", "mbox", "emph", "hat", "bar", "tilde", "vec", "overline", "underline", "boldsymbol", "bm", "textup", "textnormal", "uline", "textsc"]);
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", "*": "*", "∘": "°", "′": "′", T: "ᵀ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ", i: "ᵢ", r: "ᵣ", u: "ᵤ", v: "ᵥ", j: "ⱼ" };
const script = (t: string, map: Record<string, string>, mark: string) =>
  [...t].every((c) => map[c] !== undefined) ? [...t].map((c) => map[c]).join("") : t.length === 1 ? mark + t : `${mark}(${t})`;

/** A {...} group at s[j] (after spaces): [inner, end]; otherwise the single next character or command. */
function arg(s: string, j: number): [string, number] {
  while (s[j] === " ") j++;
  if (s[j] === "{") {
    let d = 0;
    for (let k = j; k < s.length; k++) { if (s[k] === "\\") { k++; continue; } if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return [s.slice(j + 1, k), k + 1]; }
    return [s.slice(j + 1), s.length];
  }
  const c = /^\\[a-zA-Z]+|^./s.exec(s.slice(j));
  return c ? [c[0], j + c[0].length] : ["", j];
}

/** Math as plain readable text: η²ₚ, ×, −, ≤, a/b. */
export function mathText(m: string): string {
  let out = "";
  for (let i = 0; i < m.length;) {
    const c = m[i]!;
    if (c === "\\") {
      const cm = /^\\([a-zA-Z]+)\*?/.exec(m.slice(i));
      if (!cm) { const n = m[i + 1] ?? ""; out += n === "," || n === ";" || n === ":" || n === " " || n === "!" ? (n === "!" ? "" : " ") : n === "\\" ? " " : n; i += 2; continue; }
      const name = cm[1]!; i += cm[0].length;
      if (SYM[name]) { out += SYM[name]; continue; }
      if (SPACE.has(name)) { out += " "; continue; }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, i1] = arg(m, i), [b, i2] = arg(m, i1); i = i2;
        const wrap = (x: string) => (/^[\w.′]+$/u.test(x) ? x : `(${x})`);
        out += `${wrap(mathText(a))}/${wrap(mathText(b))}`; continue;
      }
      if (name === "sqrt") { const [a, i1] = arg(m, i); i = i1; out += `√${/^\w+$/.test(mathText(a)) ? mathText(a) : `(${mathText(a)})`}`; continue; }
      if (KEEP.has(name)) { const [a, i1] = arg(m, i); i = i1; out += mathText(a); continue; }
      if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg" || name === "displaystyle" || name === "limits") continue;
      out += name.length > 1 ? name : ""; // \log, \exp, \min…: their name reads fine
      continue;
    }
    if (c === "^" || c === "_") { const [a, i1] = arg(m, i + 1); i = i1; out += script(mathText(a), c === "^" ? SUP : SUB, c); continue; }
    if (c === "{" || c === "}") { i++; continue; }
    if (c === "~") { out += " "; i++; continue; }
    out += c === "-" ? "−" : c === "*" ? "∗" : c === "'" ? "′" : c;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** A text-mode snippet (a caption) as plain text: escapes, dashes, quotes, math, references, citations. */
export function inlineText(s: string, cite: (k: string) => string = (k) => k, ref: (k: string) => string | undefined = () => undefined): string {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i]!, rest = s.slice(i, i + 3);
    if (c === "%") { const nl = s.indexOf("\n", i); i = nl === -1 ? s.length : nl + 1; continue; }
    if (c === "$") { const dbl = s[i + 1] === "$"; let j = i + (dbl ? 2 : 1); while (j < s.length && !(s[j] === "$" && s[j - 1] !== "\\")) j++; out += mathText(s.slice(i + (dbl ? 2 : 1), j)); i = j + (dbl ? 2 : 1); continue; }
    if (c === "\\") {
      const cm = /^\\([a-zA-Z]+)\*?/.exec(s.slice(i));
      if (!cm) {
        const n = s[i + 1] ?? "";
        if (n === "(" || n === "[") { const close = n === "(" ? "\\)" : "\\]"; const j = s.indexOf(close, i + 2); const e = j === -1 ? s.length : j; out += mathText(s.slice(i + 2, e)); i = e + 2; continue; }
        out += n === "\\" || n === "," || n === ";" || n === " " ? " " : n; i += 2; continue;
      }
      const name = cm[1]!; let j = i + cm[0].length;
      const opt = /^\s*\[[^\]]*\]/.exec(s.slice(j)); if (opt) j += opt[0].length;
      if (/cite/.test(name)) { const [a, e] = arg(s, j); out += `(${a.split(",").map((k) => cite(k.trim())).join("; ")})`; i = e; continue; }
      if (/^(ref|eqref|autoref|[cC]ref|pageref|nameref)$/.test(name)) { const [a, e] = arg(s, j); out += ref(a.trim()) ?? "??"; i = e; continue; }
      if (name === "label" || name === "index") { i = arg(s, j)[1]; continue; }
      if (SYM[name]) { out += SYM[name]; i = j; continue; }
      if (KEEP.has(name) || name === "textsuperscript" || name === "textsubscript") { const [a, e] = arg(s, j); const t = inlineText(a, cite, ref); out += name === "textsuperscript" ? script(t, SUP, "^") : name === "textsubscript" ? script(t, SUB, "_") : t; i = e; continue; }
      i = j; // other commands render as nothing; their braces are dropped below
      continue;
    }
    if (rest.startsWith("---")) { out += "—"; i += 3; continue; }
    if (rest.startsWith("--")) { out += "–"; i += 2; continue; }
    if (rest.startsWith("``")) { out += "“"; i += 2; continue; }
    if (rest.startsWith("''")) { out += "”"; i += 2; continue; }
    if (c === "~") { out += " "; i++; continue; }
    if (c === "{" || c === "}") { i++; continue; }
    out += c; i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function renderProse(src: string, citeLabel: (key: string) => string = (k) => k, refLabel: (key: string) => string | undefined = () => undefined): Prose {
  const out: Prose = { text: "", segs: [], blocks: [] };
  let block: { kind: Block["kind"]; text: string; segs: Seg[] } | null = null;

  const open = (kind: Block["kind"]) => { close(); block = { kind, text: "", segs: [] }; };
  function close() {
    if (!block) return;
    const b = block;
    block = null;
    const tail = b.segs[b.segs.length - 1];
    if (tail && tail.kind === "atom" && b.text.endsWith(" ") && tail.r1 - tail.r0 === 1) { b.segs.pop(); b.text = b.text.slice(0, -1); }
    if (!b.text) return;
    const r0 = out.text.length + (out.blocks.length ? 1 : 0);
    if (out.blocks.length) out.text += "\n";
    out.text += b.text;
    out.blocks.push({ kind: b.kind, text: b.text, r0 });
    for (const s of b.segs) out.segs.push({ ...s, r0: s.r0 + r0, r1: s.r1 + r0 });
  }
  function emit(text: string, s0: number, s1: number, kind: Seg["kind"]) {
    if (!text) return;
    if (!block) block = { kind: "p", text: "", segs: [] };
    if (text === " " && kind === "atom" && (!block.text || block.text.endsWith(" "))) return; // never two spaces, never a leading one
    const prev = block.segs[block.segs.length - 1];
    if (kind === "text" && prev && prev.kind === "text" && prev.s1 === s0) { prev.s1 = s1; prev.r1 += text.length; }
    else block.segs.push({ r0: block.text.length, r1: block.text.length + text.length, s0, s1, kind });
    block.text += text;
  }

  /** The {...} group starting at or after j (skipping spaces): [openBrace, afterCloseBrace], or null. */
  function group(j: number, end: number): [number, number] | null {
    while (j < end && (src[j] === " " || src[j] === "\t")) j++;
    if (src[j] !== "{") return null;
    let depth = 0;
    for (let i = j; i < end; i++) {
      if (src[i] === "\\") { i++; continue; }
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return [j, i + 1];
    }
    return null;
  }
  const skipOpt = (j: number) => { const m = /^(?:\s*\[[^\]]*\])*/.exec(src.slice(j, j + 400)); return j + (m ? m[0].length : 0); };
  const plain = (s: string) => s.replace(/\\[a-zA-Z]+\*?|[{}]/g, "").replace(/\s+/g, " ").trim();

  function scan(i: number, end: number) {
    while (i < end) {
      const ch = src[i]!;
      const rest = src.slice(i, Math.min(end, i + 60));

      const blank = /^\n[ \t]*\n\s*/.exec(src.slice(i, end));
      if (blank) { close(); i += blank[0].length; continue; }

      if (ch === "%") { const nl = src.indexOf("\n", i); i = nl === -1 || nl > end ? end : nl; continue; }

      if (ch === "\\") {
        const cmd = /^\\([a-zA-Z]+)\*?/.exec(rest);
        if (!cmd) {
          const next = src[i + 1] ?? "";
          if (SPECIAL_CHAR.has(next)) emit(next, i, i + 2, "atom");
          else if (next === "\\" || next === "," || next === ";" || next === " " || next === ":") emit(" ", i, i + 2, "atom");
          else if (next === "(") { const j = src.indexOf("\\)", i); const e = j === -1 ? end : j + 2; emit(mathText(src.slice(i + 2, e - 2)) || " ", i, e, "atom"); i = e; continue; }
          else if (next === "[") { const j = src.indexOf("\\]", i); const e = j === -1 ? end : j + 2; open("p"); emit(mathText(src.slice(i + 2, e - 2)) || "[Equation]", i, e, "atom"); close(); i = e; continue; }
          i += 2;
          continue;
        }
        const name = cmd[1]!;
        const afterName = i + cmd[0].length;
        const j = skipOpt(afterName);
        const g = group(j, end);

        if (HEADINGS[name] && g) { open(HEADINGS[name]!); scan(g[0] + 1, g[1] - 1); close(); i = g[1]; continue; }
        if (FORMAT.has(name) && g) { scan(g[0] + 1, g[1] - 1); i = g[1]; continue; }
        if (/cite/.test(name) && g) {
          const keys = src.slice(g[0] + 1, g[1] - 1).split(",").map((k) => k.trim()).filter(Boolean);
          emit(`[${keys.map(citeLabel).join("; ")}]`, i, g[1], "atom");
          i = g[1];
          continue;
        }
        if (/^(ref|eqref|autoref|[cC]ref|pageref|nameref)$/.test(name) && g) { { const key = src.slice(g[0] + 1, g[1] - 1).trim(); emit(refLabel(key) ?? `[→${key}]`, i, g[1], "atom"); } i = g[1]; continue; }
        if (name === "footnote" && g) { emit("[footnote]", i, g[1], "atom"); i = g[1]; continue; }
        if (name === "item") { open("p"); emit("• ", i, j, "atom"); i = j; continue; }
        if (name === "begin" && g) {
          const env = src.slice(g[0] + 1, g[1] - 1).replace("*", "");
          if (TRANSPARENT.has(env)) { i = skipOpt(g[1]); continue; }
          const stop = src.indexOf(`\\end{${src.slice(g[0] + 1, g[1] - 1)}}`, g[1]);
          const e = stop === -1 ? end : stop + `\\end{${src.slice(g[0] + 1, g[1] - 1)}}`.length;
          const cap = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(src.slice(g[1], e));
          const cg = cap ? group(g[1] + cap.index + cap[0].length - 1, e) : null;
          const isFig = /^(figure|table)/.test(env), isEq = /^(equation|align|gather|multline|eqnarray)/.test(env);
          const kind = isFig ? env[0]!.toUpperCase() + env.replace(/\*$/, "").slice(1) : isEq ? "Equation" : env;
          const lab = /\\label\{([^}]*)\}/.exec(src.slice(g[1], e));
          const num = lab ? refLabel(lab[1]!.trim()) : undefined;
          open("p");
          if (isEq) emit(mathText(src.slice(g[1], stop === -1 ? end : stop).replace(/\\label\{[^}]*\}|\\nonumber|&/g, " ")) + (num ? `   (${num})` : "") || "[Equation]", i, e, "atom");
          else emit(`[${kind}${num ? " " + num : ""}${cg ? ": " + inlineText(src.slice(cg[0] + 1, cg[1] - 1), citeLabel, refLabel) : ""}]`, i, e, "atom");
          close();
          i = e;
          continue;
        }
        if (name === "end" && g) { i = g[1]; continue; }
        if (DROP.has(name)) { let k = j, gg = group(k, end); while (gg) { k = gg[1]; gg = group(k, end); } i = k; continue; }
        if (g) { // unknown macro with arguments: show what is inside, keep the wrapper out of reach
          let k = j, gg: [number, number] | null = g;
          while (gg) { scan(gg[0] + 1, gg[1] - 1); k = gg[1]; gg = src[k] === "{" ? group(k, end) : null; }
          i = k;
          continue;
        }
        i = afterName; // bare command such as \noindent
        if (src[i] === " ") i++;
        continue;
      }

      if (ch === "$") {
        if (src[i + 1] === "$") { const j = src.indexOf("$$", i + 2); const e = j === -1 ? end : j + 2; open("p"); emit(mathText(src.slice(i + 2, e - 2)) || "[Equation]", i, e, "atom"); close(); i = e; continue; }
        let j = i + 1;
        while (j < end && !(src[j] === "$" && src[j - 1] !== "\\")) j++;
        const e = Math.min(end, j + 1);
        emit(mathText(src.slice(i + 1, e - 1)) || " ", i, e, "atom");
        i = e;
        continue;
      }
      if (ch === "{" || ch === "}") { i++; continue; }
      if (ch === "~") { emit(" ", i, i + 1, "atom"); i++; continue; }
      if (rest.startsWith("``")) { emit("“", i, i + 2, "atom"); i += 2; continue; }
      if (rest.startsWith("''")) { emit("”", i, i + 2, "atom"); i += 2; continue; }
      if (rest.startsWith("---")) { emit("—", i, i + 3, "atom"); i += 3; continue; }
      if (rest.startsWith("--")) { emit("–", i, i + 2, "atom"); i += 2; continue; }

      const ws = /^[ \t]+|^\n(?![ \t]*\n)/.exec(rest); // a line break inside a paragraph is just a space
      if (ws) { emit(" ", i, i + ws[0].length, "atom"); i += ws[0].length; continue; }

      const run = /^[^\\%${}~\s`'\-]+|^[`'\-]/.exec(src.slice(i, end))!;
      emit(run[0], i, i + run[0].length, "text");
      i += run[0].length;
    }
  }

  const body = src.indexOf("\\begin{document}");
  scan(body === -1 ? 0 : body + "\\begin{document}".length, src.length);
  close();
  return out;
}

/** The prose range showing source [s0, s1) (an atom counts whole), or null if none of it is visible. */
export function proseRange(p: Prose, s0: number, s1: number): [number, number] | null {
  let a = Infinity, b = -Infinity;
  for (const g of p.segs) {
    if (g.s1 <= s0 || g.s0 >= s1) continue;
    if (g.kind === "atom") { a = Math.min(a, g.r0); b = Math.max(b, g.r1); continue; }
    a = Math.min(a, g.r0 + Math.max(0, s0 - g.s0));
    b = Math.max(b, g.r0 + Math.min(g.s1, s1) - g.s0);
  }
  return a < b ? [a, b] : null;
}

/** Source position where text typed at prose offset `r` belongs. */
export function sourceInsertPos(p: Prose, r: number): number {
  let before: Seg | null = null;
  for (const s of p.segs) {
    if (s.r0 < r && r < s.r1) return s.kind === "text" ? s.s0 + (r - s.r0) : s.s1;
    if (s.r1 === r) before = s;
    if (s.r0 === r && !before) return s.s0;
    if (s.r0 >= r) break;
  }
  return before ? before.s1 : (p.segs[p.segs.length - 1]?.s1 ?? 0);
}

/** Source position where the prose at offset `r` starts (for anchoring a comment). */
export function sourceStartPos(p: Prose, r: number): number {
  for (const s of p.segs) if (r < s.r1) return s.kind === "text" ? s.s0 + Math.max(0, r - s.r0) : s.s0;
  return p.segs[p.segs.length - 1]?.s1 ?? 0;
}

/**
 * Source ranges to remove for deleting prose [r0, r1).
 * `partial` is true when the deletion cut through a stand-in (half a citation) or across a paragraph break;
 * those parts are left alone and should be shown to the author instead of guessed.
 */
export function sourceDeleteRanges(p: Prose, r0: number, r1: number): { ranges: [number, number][]; partial: boolean } {
  const ranges: [number, number][] = [];
  let partial = p.text.slice(r0, r1).includes("\n");
  for (const s of p.segs) {
    if (s.r1 <= r0 || s.r0 >= r1) continue;
    let range: [number, number];
    if (s.kind === "text") range = [s.s0 + Math.max(0, r0 - s.r0), s.s0 + Math.min(s.r1, r1) - s.r0];
    else if (r0 <= s.r0 && s.r1 <= r1) range = [s.s0, s.s1];
    else { partial = true; continue; }
    const last = ranges[ranges.length - 1];
    if (last && last[1] === range[0]) last[1] = range[1];
    else ranges.push(range);
  }
  return { ranges, partial };
}

/** Make text typed in a word processor safe to drop into LaTeX. */
export const escapeTex = (text: string) =>
  text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[&%$#_{}]/g, "\\$&")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/ /g, "~")
    .replace(/\n/g, "\n\n");

export const proseToHtml = (p: Prose, title: string) => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>\n${p.blocks.map((b) => `<${b.kind}>${esc(b.text)}</${b.kind}>`).join("\n")}\n</body></html>`;
};
