// Catches characters and structure that LaTeX will choke on, before a build does.
// It reads a .tex file the way TeX roughly would: it knows when it is inside maths, a table, a
// verbatim block or an argument where special characters are literal (labels, citation keys, file
// names, URLs), so it only complains where the character really is a problem.

export interface Lint {
  line: number; // 1-based
  col: number; // 0-based column in that line
  severity: "error" | "warn";
  kind: string;
  message: string;
  /** A safe mechanical repair: replace `expect` at line:col with `insert`. */
  fix?: { expect: string; insert: string };
}

const VERBATIM = /^(verbatim|lstlisting|minted|comment|filecontents|Verbatim|alltt)\*?$/;
const MATH_ENV = /^(equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|subequations|dmath)\*?$/;
const TABLE_ENV = /(tabular|tabu|tblr|longtable|array|align|matrix|cases|split|eqnarray|aligned|gathered|alignat)/;
/** Commands whose arguments are names, keys or paths: which arguments (0-based) to skip. "all" skips every one. */
const LITERAL: [RegExp, number[] | "all"][] = [
  [/^[a-zA-Z]*(cite|ref)[a-zA-Z]*\*?$/, "all"],
  [/^(label|input|include|includeonly|includegraphics|bibliography|bibliographystyle|addbibresource|usepackage|RequirePackage|documentclass|graphicspath|url|nolinkurl|path|lstinputlisting|hypersetup|ce|si|SI|num|begin|end|pagestyle|hyperref|hypertarget|lstset|definecolor|color|textcolor|setcounter|addtocounter|newcounter|input@path)$/, [0]],
  [/^(href|hyperlink)$/, [0]],
  [/^codefile$/, [0, 2]],
  [/^(newcommand|renewcommand|providecommand|newenvironment|renewenvironment|def|DeclareMathOperator|DeclareRobustCommand|newcolumntype|lstdefinestyle|lstdefinelanguage)\*?$/, "all"],
];

/** Unicode that pdfLaTeX has no definition for, or that is invisible, and what to write instead. */
const UNICODE: Record<string, [string, string]> = {
  "α": ["$\\alpha$", "Greek alpha"], "β": ["$\\beta$", "Greek beta"], "γ": ["$\\gamma$", "Greek gamma"], "δ": ["$\\delta$", "Greek delta"],
  "Δ": ["$\\Delta$", "Greek Delta"], "θ": ["$\\theta$", "Greek theta"], "λ": ["$\\lambda$", "Greek lambda"], "μ": ["$\\mu$", "Greek mu"],
  "σ": ["$\\sigma$", "Greek sigma"], "τ": ["$\\tau$", "Greek tau"], "χ": ["$\\chi$", "Greek chi"], "ω": ["$\\omega$", "Greek omega"], "π": ["$\\pi$", "Greek pi"],
  "η": ["$\\eta$", "Greek eta"], "ε": ["$\\epsilon$", "Greek epsilon"], "ρ": ["$\\rho$", "Greek rho"], "φ": ["$\\phi$", "Greek phi"], "Ω": ["$\\Omega$", "Greek Omega"],
  "≤": ["$\\leq$", "less-than-or-equal sign"], "≥": ["$\\geq$", "greater-than-or-equal sign"], "≠": ["$\\neq$", "not-equal sign"], "≈": ["$\\approx$", "approximately sign"],
  "→": ["$\\rightarrow$", "arrow"], "←": ["$\\leftarrow$", "arrow"], "↑": ["$\\uparrow$", "arrow"], "↓": ["$\\downarrow$", "arrow"], "∼": ["$\\sim$", "tilde operator"],
  "−": ["$-$", "Unicode minus sign"], "∞": ["$\\infty$", "infinity sign"], "√": ["$\\surd$", "square-root sign"], "∆": ["$\\Delta$", "increment sign"],
  "\u00A0": ["~", "non-breaking space pasted from another program"], "\u200B": ["", "invisible zero-width space"], "\u200C": ["", "invisible zero-width character"],
  "\u200D": ["", "invisible zero-width character"], "\uFEFF": ["", "invisible byte-order mark"], "\u2028": [" ", "invisible line separator"], "\u00AD": ["", "invisible soft hyphen"],
  "\u2009": ["\\,", "thin space pasted from another program"], "\u202F": ["\\,", "narrow space pasted from another program"],
};
/** Fine with utf8 input in current LaTeX: accented Latin letters and ordinary typographic punctuation. */
/** Symbol commands that only exist in maths: written in running text they stop the build ("Missing $ inserted"). */
const MATH_ONLY = new Set(("geq leq neq ge le ne approx times pm mp div cdot sim simeq equiv propto ll gg infty partial nabla " +
  "rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow uparrow downarrow mapsto to " +
  "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega " +
  "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega").split(" "));
const SAFE_UNICODE = /[\u00A1-\u024F\u2010-\u2015\u2018-\u201F\u2020-\u2022\u2026\u2030\u2032\u2033\u20AC\u2122]/;

export function lintTex(text: string, opts: { preambleUntilDocument?: boolean } = {}): Lint[] {
  const out: Lint[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const where = (pos: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= pos) lo = mid; else hi = mid - 1; } return { line: lo + 1, col: pos - lineStarts[lo]! }; };
  const add = (pos: number, severity: Lint["severity"], kind: string, message: string, fix?: Lint["fix"]) => out.push({ ...where(pos), severity, kind, message, fix });
  const lineOf = (pos: number) => { const s = text.lastIndexOf("\n", pos - 1) + 1; let e = text.indexOf("\n", pos); if (e < 0) e = text.length; return { s, e, text: text.slice(s, e) }; };

  let i = 0;
  if (opts.preambleUntilDocument) { const d = text.indexOf("\\begin{document}"); if (d < 0) return out; i = d; }

  const envs: { name: string; pos: number }[] = [];
  const braces: number[] = []; // positions of unclosed {
  let math: { pos: number; close: string } | null = null; // inline or display maths opened with $ $$ \( \[
  const inMath = () => !!math || envs.some((e) => MATH_ENV.test(e.name));
  const inTable = () => envs.some((e) => TABLE_ENV.test(e.name));
  let quoteOpen = false;

  /** Skip a balanced {...} or [...] starting at `at`; returns the index after it, or `at` if there is none. */
  const skipGroup = (at: number, open: string, close: string) => {
    if (text[at] !== open) return at;
    let depth = 0;
    for (let k = at; k < text.length; k++) {
      if (text[k] === "\\") { k++; continue; }
      if (text[k] === open) depth++;
      else if (text[k] === close && !--depth) return k + 1;
    }
    return at;
  };
  const skipSpace = (at: number) => { while (text[at] === " " || text[at] === "\t") at++; return at; };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "%") { // a comment runs to the end of the line; is it hiding a closing brace?
      const l = lineOf(i), before = text.slice(l.s, i).replace(/\\[{}]/g, "");
      const open = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
      if (open > 0 && text.slice(i, l.e).includes("}") && before.trim())
      {
        add(i, "error", "tex-percent", "A % inside braces starts a comment, so TeX never sees the closing }. Write \\% for a percent sign.", { expect: "%", insert: "\\%" });
        // read on as if it were \%, so the braces it hid are counted and not reported a second time
        i++;
        continue;
      }
      i = l.e;
      continue;
    }

    if (ch === "\\") {
      const m = /^\\([a-zA-Z@]+\*?|.)/s.exec(text.slice(i, i + 40));
      const name = m?.[1] ?? "";
      let j = i + 1 + name.length;
      if (name === "(" || name === "[") { math ??= { pos: i, close: name === "(" ? ")" : "]" }; i = j; continue; }
      if (name === ")" || name === "]") { if (math && math.close === name) math = null; i = j; continue; }
      if (name === "verb" || name === "lstinline") { const d = text[j]; const end = d ? text.indexOf(d, j + 1) : -1; i = end > 0 && d !== "{" ? end + 1 : skipGroup(j, "{", "}"); continue; }
      if (name === "begin" || name === "end") {
        const a = skipSpace(j), b = skipGroup(a, "{", "}");
        const env = b > a ? text.slice(a + 1, b - 1) : "";
        if (name === "begin") {
          envs.push({ name: env, pos: i });
          if (VERBATIM.test(env)) { // nothing inside is LaTeX: jump to its end
            const close = text.indexOf(`\\end{${env}}`, b);
            if (close < 0) { add(i, "error", "tex-env", `\\begin{${env}} is never closed with \\end{${env}}`); return out; }
            envs.pop();
            i = close + `\\end{${env}}`.length;
            continue;
          }
        } else {
          const top = envs[envs.length - 1];
          if (!top) add(i, "error", "tex-env", `\\end{${env}} has no matching \\begin{${env}}`);
          else if (top.name !== env) { add(i, "error", "tex-env", `\\end{${env}} closes \\begin{${top.name}} from line ${where(top.pos).line}`); if (envs.some((e) => e.name === env)) while (envs.length && envs.pop()!.name !== env); else envs.pop(); }
          else envs.pop();
        }
        i = Math.max(b, j);
        continue;
      }
      if (/^[0-9]$/.test(name)) {
        add(i, "error", "tex-undefined", `\\${name} is not a LaTeX command, so the build stops here ("Undefined control sequence"). Remove the backslash, or write $${name}$ for maths.`, { expect: `\\${name}`, insert: name });
      }
      if (MATH_ONLY.has(name) && !inMath()) {
        const cmd = `\\${name}`;
        add(i, "error", "tex-mathcmd", `${cmd} only works in maths, so here it stops the build ("Missing $ inserted"). Write $${cmd}$.`, { expect: cmd, insert: `$${cmd}$` });
      }
      const literal = LITERAL.find(([re]) => re.test(name));
      if (literal) { // names, keys and paths: special characters are fine in here
        let n = 0;
        for (;;) {
          let a = skipSpace(j);
          let b = skipGroup(a, "[", "]");
          if (b > a) { j = b; continue; }
          b = skipGroup(a, "{", "}");
          if (b === a) break;
          if (literal[1] === "all" || literal[1].includes(n)) j = b; else break;
          n++;
          if (literal[1] !== "all" && n > Math.max(...literal[1])) break;
        }
      }
      i = j;
      continue;
    }

    if (ch === "{") braces.push(i);
    else if (ch === "}") { if (braces.length) braces.pop(); else add(i, "error", "tex-brace", "This } has no opening { before it"); }
    else if (ch === "$") {
      const dbl = text[i + 1] === "$";
      if (math && (math.close === "$" || math.close === "$$")) { math = null; if (dbl) i++; }
      else if (!math) { math = { pos: i, close: dbl ? "$$" : "$" }; if (dbl) i++; }
    }
    else if (ch === "\n" && text[i + 1] === "\n") {
      if (math && math.close === "$") { // inline maths cannot cross a paragraph: the $ was a lone one
        const after = text.slice(math.pos + 1, math.pos + 12);
        add(math.pos, "error", "tex-dollar", /^\d/.test(after) ? "A lone $ starts maths. For a dollar amount write \\$." : "This $ opens maths that is never closed. Add the closing $, or write \\$ for a dollar sign.", /^\d/.test(after) ? { expect: "$", insert: "\\$" } : undefined);
        math = null;
      }
      quoteOpen = false;
    }
    else if (ch === "&" && !inTable()) add(i, "error", "tex-amp", "A bare & only works inside tables and aligned equations. Write \\& for an ampersand.", { expect: "&", insert: "\\&" });
    else if (ch === "#") add(i, "error", "tex-hash", "A bare # is reserved for macro arguments. Write \\# for a number sign.", { expect: "#", insert: "\\#" });
    else if (ch === "_" && !inMath()) add(i, "error", "tex-underscore", "An underscore outside maths stops the build (\"Missing $ inserted\"). Write \\_ for an underscore.", { expect: "_", insert: "\\_" });
    else if (ch === "^" && !inMath()) add(i, "error", "tex-caret", "A ^ outside maths stops the build. Use \\textsuperscript{...} or put it in $...$.");
    else if (ch === '"' && !inMath()) {
      add(i, "warn", "tex-quote", quoteOpen ? "Straight quote: LaTeX closes a quotation with ''" : "Straight quote: LaTeX opens a quotation with ``", { expect: '"', insert: quoteOpen ? "''" : "``" });
      quoteOpen = !quoteOpen;
    }
    else if (ch > "\u007F") {
      const known = UNICODE[ch];
      if (known) {
        const insert = inMath() && known[0].startsWith("$") ? known[0].slice(1, -1) + " " : known[0];
        add(i, known[0] === "" || /space|invisible/.test(known[1]) ? "warn" : "error", "tex-unicode", `${known[1][0]!.toUpperCase()}${known[1].slice(1)} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}): pdfLaTeX on Overleaf cannot typeset it. Use ${insert.trim() || "nothing (delete it)"}.`, { expect: ch, insert });
      } else if (!SAFE_UNICODE.test(ch)) {
        const cp = text.codePointAt(i)!;
        add(i, "warn", "tex-unicode", `"${String.fromCodePoint(cp)}" (U+${cp.toString(16).toUpperCase().padStart(4, "0")}) may be missing from the PDF font. Use the LaTeX command for it.`);
        if (cp > 0xffff) i++;
      }
    }
    i++;
  }

  if (math) add(math.pos, "error", "tex-dollar", "Maths opened here is never closed.");
  for (const b of braces.slice(0, 3)) add(b, "error", "tex-brace", "This { is never closed. Everything after it becomes part of the same argument.");
  for (const e of envs.filter((e) => e.name !== "document").slice(0, 3)) add(e.pos, "error", "tex-env", `\\begin{${e.name}} is never closed with \\end{${e.name}}`);
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}
