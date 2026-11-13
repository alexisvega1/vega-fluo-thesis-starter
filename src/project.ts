import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { walk } from "./index";
import { lintTex } from "./texlint";

export interface Issue {
  severity: "error" | "warn" | "info";
  kind: string;
  message: string;
  file: string;
  line: number;
  /** For LaTeX character problems: where on the line, and the safe replacement if there is one. */
  col?: number;
  fix?: { expect: string; insert: string };
}
export interface Heading { file: string; line: number; level: number; title: string }
export interface Analysis {
  root: string | null;
  bibFile: string;
  files: { path: string; words: number; linked: boolean }[];
  outline: Heading[];
  labels: string[];
  issues: Issue[];
  totalWords: number;
}

const EDITABLE = new Set([".tex", ".bib", ".md", ".txt", ".cls", ".sty", ".bst", ...Object.keys({ ".r": 1, ".py": 1, ".m": 1, ".groovy": 1, ".sh": 1, ".jl": 1, ".ijm": 1, ".sql": 1 })]);
/** Code files that can be printed in the dissertation, and the listings language for each. */
export const CODE_LANG: Record<string, string> = { ".r": "R", ".py": "Python", ".m": "Matlab", ".groovy": "Java", ".ijm": "Java", ".sh": "bash", ".sql": "SQL", ".jl": "" };
const STANDARD_CLASSES = new Set(["article", "report", "book", "memoir", "letter", "beamer", "scrartcl", "scrreprt", "scrbook"]);
const LEVELS: Record<string, number> = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 };

const stripComment = (line: string) => line.replace(/(^|[^\\])%.*$/, "$1");

/** Rough prose word count for LaTeX: drops math, reference-like commands and markup. */
export function countWords(tex: string): number {
  const s = tex
    .split("\n").map(stripComment).join("\n")
    .replace(/\\begin\{(equation|align|gather|multline|tabular|verbatim|lstlisting)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ")
    .replace(/\\(cite[a-zA-Z]*|ref|eqref|autoref|[cC]ref|pageref|label|input|include|includegraphics|bibliography|bibliographystyle|usepackage|documentclass|begin|end)\*?(\[[^\]]*\])*\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/[{}~\\]/g, " ");
  return (s.match(/[A-Za-z0-9][\w'’\-]*/g) ?? []).length;
}

/** Keys inside every \cite-family command on a line: \cite, \citep, \citet*, \citep[see][p. 3]{a,b}. */
export function citedKeys(line: string): string[] {
  const out: string[] = [];
  // \setcitestyle{...} and \bibliographystyle hold settings, not keys
  for (const m of line.matchAll(/\\(?![a-zA-Z]*style)[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g))
    for (const k of m[1]!.split(",")) if (k.trim()) out.push(k.trim());
  return out;
}

export class Project {
  constructor(readonly root: string) {}

  /** Create the project from the template on first run. */
  static async open(root: string, template: string): Promise<Project> {
    if (!(await stat(root).catch(() => null))) {
      await cp(template, root, { recursive: true });
      console.log(`[project] created ${root} from the dissertation template`);
    }
    return new Project(root);
  }

  /** Absolute path for a project-relative one, or null if it would leave the project. */
  resolve(rel: string | null): string | null {
    if (!rel || rel.includes("\0")) return null;
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) return null;
    return EDITABLE.has(extname(abs).toLowerCase()) ? abs : null;
  }

  async tree(): Promise<string[]> {
    const out: string[] = [];
    for await (const f of walk(this.root)) if (EDITABLE.has(extname(f).toLowerCase()) && !f.endsWith("margin-preview.tex")) out.push(relative(this.root, f)); // the draft-preview wrapper is a build by-product
    return out.sort((a, b) => {
      const da = a.includes("/") ? 1 : 0, db = b.includes("/") ? 1 : 0;
      return da - db || a.localeCompare(b);
    });
  }

  async write(rel: string, text: string) {
    const abs = this.resolve(rel);
    if (!abs) return false;
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, text);
    this.onWrite?.(rel);
    return true;
  }
  /** Told about every file written through write(), e.g. to keep a live Google Doc current. */
  onWrite?: (rel: string) => void;

  /**
   * Read every .tex file and report structure and problems.
   * inProject / inLibrary say whether a citekey exists in the project's .bib or the wider library.
   */
  async analyze(inProject: (k: string) => boolean, inLibrary: (k: string) => boolean, isUndefined: (name: string) => boolean = () => false): Promise<Analysis> {
    const paths = await this.tree();
    const tex = new Map<string, string>();
    for (const p of paths) if (p.endsWith(".tex")) tex.set(p, await Bun.file(join(this.root, p)).text());

    const root = tex.has("main.tex") ? "main.tex" : ([...tex].find(([, t]) => /\\documentclass/.test(t))?.[0] ?? null);
    const issues: Issue[] = [];

    // file order = the order main.tex pulls them in
    const order: string[] = [];
    const visit = (p: string) => {
      if (order.includes(p)) return;
      order.push(p);
      tex.get(p)!.split("\n").forEach((raw, i) => {
        for (const m of stripComment(raw).matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
          const target = extname(m[1]!) ? m[1]! : m[1]! + ".tex";
          if (tex.has(target)) visit(target);
          else if (!target.startsWith(".margin/")) issues.push({ severity: "error", kind: "missing-file", message: `${target} is included here but does not exist`, file: p, line: i + 1 });
        }
      });
    };
    if (root) visit(root);
    const linked = new Set(order);
    for (const p of tex.keys()) if (!linked.has(p)) order.push(p);

    let bibFile = "references.bib";
    const outline: Heading[] = [];
    const labels = new Map<string, { file: string; line: number }>();
    const refs: { name: string; file: string; line: number }[] = [];
    const files: Analysis["files"] = [];
    const graphics: { path: string; file: string; line: number }[] = [];

    for (const p of order) {
      const text = tex.get(p)!;
      const body = p === root ? text.slice(Math.max(0, text.indexOf("\\begin{document}"))) : text;
      files.push({ path: p, words: countWords(body), linked: linked.has(p) });
      if (!linked.has(p) && root && !p.startsWith("styles/")) issues.push({ severity: "info", kind: "unlinked", message: `${p} is not included from ${root}`, file: p, line: 1 });

      // characters and structure that would stop the build; preamble and package files are macro code, not prose
      if (p.endsWith(".tex") && linked.has(p) && (p === root || !/\\(usepackage|RequirePackage|lstdefinestyle|ProvidesPackage)\b/.test(text)))
        for (const l of lintTex(text, { preambleUntilDocument: p === root }).slice(0, 200))
          issues.push({ severity: l.severity, kind: l.kind, message: l.message, file: p, line: l.line, col: l.col, fix: l.fix });

      // commands TeX says do not exist (asked in the background with the real preamble)
      if (p.endsWith(".tex") && linked.has(p)) {
        let inVerb = false;
        text.split("\n").forEach((raw, i) => {
          if (/\\begin\{(verbatim|lstlisting|minted|comment)\*?\}/.test(raw)) inVerb = true;
          if (inVerb) { if (/\\end\{(verbatim|lstlisting|minted|comment)\*?\}/.test(raw)) inVerb = false; return; }
          const seen = new Set<string>();
          for (const m of stripComment(raw).replace(/\\(?:url|href|path)\s*\{[^}]*\}/g, (x) => " ".repeat(x.length)).matchAll(/\\([a-zA-Z]+)/g)) {
            if (seen.has(m[1]!) || !isUndefined(m[1]!)) continue;
            seen.add(m[1]!);
            issues.push({ severity: "error", kind: "tex-undefined", message: `\\${m[1]} is not defined: no package or command in this thesis provides it, so the build will stop here. Check the spelling.`, file: p, line: i + 1, col: m.index! + m[0].length });
          }
        });
      }

      text.split("\n").forEach((raw, i) => {
        const line = stripComment(raw), n = i + 1;
        const at = (severity: Issue["severity"], kind: string, message: string) => issues.push({ severity, kind, message, file: p, line: n });

        const hd = /\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{(.*)\}/.exec(line);
        if (hd) outline.push({ file: p, line: n, level: LEVELS[hd[1]!]!, title: hd[2]!.replace(/\\[a-zA-Z]+\s*|[{}]/g, "").trim() });

        for (const m of line.matchAll(/\\label\{([^}]+)\}/g)) {
          const prev = labels.get(m[1]!);
          if (prev) at("error", "duplicate-label", `Label "${m[1]}" is also defined in ${prev.file}:${prev.line}`);
          else labels.set(m[1]!, { file: p, line: n });
        }
        for (const m of line.matchAll(/\\(?:ref|eqref|autoref|[cC]ref|pageref|nameref)\{([^}]+)\}/g))
          for (const name of m[1]!.split(",")) refs.push({ name: name.trim(), file: p, line: n });

        for (const key of citedKeys(line)) {
          if (inProject(key)) continue;
          if (inLibrary(key)) at("warn", "cite-not-in-bib", `"${key}" is in your library but not yet in the project bibliography`);
          else at("error", "unknown-cite", `"${key}" is not in your library or the project bibliography`);
        }

        for (const m of line.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) graphics.push({ path: m[1]!.trim(), file: p, line: n });

        const cls = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/.exec(line);
        if (cls && !STANDARD_CLASSES.has(cls[1]!) && !paths.includes(`${cls[1]}.cls`))
          at("error", "missing-class", `${cls[1]}.cls is not in the project — copy it in from the template`);
        const bib = /\\(?:bibliography|addbibresource)\{([^}]+)\}/.exec(line);
        if (bib) bibFile = extname(bib[1]!) ? bib[1]! : bib[1]! + ".bib";
        if (/\\singlespacing/.test(line) && p === root) at("warn", "spacing", "Single spacing is set; Rackham asks for at least 1.5 spacing in the main text");

        // open items: TODOs and bracketed placeholders the author still owes
        const raws = raw.match(/\b(?:TODO|FIXME|TK)\b[^\n]{0,80}|\\todo\{[^}]*\}|\[[^\]\n]*(?:UNVERIFIED|CITE|CITATION NEEDED|TBD|\?\?)[^\]\n]*\]/g);
        for (const r of raws ?? []) at("info", "open-item", r.trim());
      });
    }

    for (const g of graphics) {
      const found = (await Promise.all(["", ".pdf", ".png", ".jpg", ".jpeg"].map((e) => stat(join(this.root, g.path + e)).catch(() => null)))).some(Boolean);
      if (!found) issues.push({ severity: "error", kind: "missing-figure", message: `Figure file ${g.path} does not exist`, file: g.file, line: g.line });
    }
    for (const r of refs) if (!labels.has(r.name)) issues.push({ severity: "error", kind: "undefined-ref", message: `No \\label{${r.name}} exists`, file: r.file, line: r.line });
    if (!root) issues.push({ severity: "error", kind: "no-root", message: "No main.tex with \\documentclass was found", file: "", line: 0 });

    const rank = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { root, bibFile, files, outline, labels: [...labels.keys()], issues, totalWords: files.reduce((n, f) => n + (f.linked ? f.words : 0), 0) };
  }
}
