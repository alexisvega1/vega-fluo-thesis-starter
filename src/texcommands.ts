// Which LaTeX commands exist in this thesis? Asked of TeX itself, so the answer covers the class,
// every package, the styles and the thesis's own \newcommands: a small probe document with the real
// preamble checks each name with \ifdefined. Answers are cached, so a name is only ever asked once
// (until the preamble changes).
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const NAME = /\\([a-zA-Z@]+)/g;

/** Command names used in prose and markup, skipping comments and verbatim-like blocks. */
export function commandsUsed(text: string): Set<string> {
  const clean = text
    .replace(/\\begin\{(verbatim|lstlisting|minted|comment|filecontents)\*?\}[\s\S]*?\\end\{\1\*?\}/g, "")
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\(?:url|href|path|lstinline|verb)\s*\{[^}]*\}/g, "");
  const out = new Set<string>();
  for (const m of clean.matchAll(NAME)) if (!m[1]!.includes("@")) out.add(m[1]!);
  return out;
}

/** Names the thesis defines itself, anywhere (so a \newcommand in a chapter counts). */
export function commandsDefined(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z@]+)|\\(?:providecommand|DeclareRobustCommand|DeclareMathOperator)\*?\s*\{?\\([a-zA-Z@]+)|\\(?:def|gdef|edef|xdef|let|newlength|newif|newcounter)\s*\\([a-zA-Z@]+)|\\newenvironment\*?\s*\{([a-zA-Z@]+)\}|\\newcounter\{([a-zA-Z]+)\}/g)) {
    const n = m[1] ?? m[2] ?? m[3];
    if (n) out.add(n);
    if (m[4]) { out.add(m[4]); out.add(`end${m[4]}`); }
    if (m[5]) out.add(`the${m[5]}`);
  }
  return out;
}

export class CommandCheck {
  private known = new Map<string, boolean>();
  private preambleKey = "";
  private running: Promise<void> | null = null;
  constructor(private projectDir: string, private cacheFile: string) {}

  async load() {
    try { const j = await Bun.file(this.cacheFile).json(); this.preambleKey = j.preambleKey ?? ""; this.known = new Map(Object.entries(j.known ?? {})); } catch { /* first run */ }
  }
  private async save() {
    await Bun.write(this.cacheFile, JSON.stringify({ preambleKey: this.preambleKey, known: Object.fromEntries(this.known) }));
  }

  private packageDefs: Set<string> | null = null;
  /**
   * Names the TeX packages in use define somewhere, even only inside an environment (the acronym
   * package's \acro exists only within \begin{acronym}). Read once from tectonic's local copies.
   */
  async packageDefined(): Promise<Set<string>> {
    if (this.packageDefs) return this.packageDefs;
    const set = new Set<string>();
    const root = join(process.env.HOME ?? "", "Library", "Caches", "TectonicProject.Tectonic", "bundles", "data");
    for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue;
      for (const f of await readdir(join(root, dir.name)).catch(() => [] as string[]))
        if (/\.(sty|cls|def|cfg|clo)$/.test(f)) for (const n of commandsDefined(await Bun.file(join(root, dir.name, f)).text().catch(() => ""))) set.add(n);
    }
    return (this.packageDefs = set);
  }

  /** false when TeX said the name is undefined, true when defined, undefined when not asked yet. */
  status(name: string): boolean | undefined { return this.known.get(name); }

  /** Ask TeX about any names not yet known. Runs in the background; safe to call often. */
  ask(root: string, rootText: string, names: Iterable<string>, onDone: () => void) {
    const pre = rootText.slice(0, Math.max(0, rootText.indexOf("\\begin{document}")));
    const key = Bun.hash(pre).toString(36);
    if (key !== this.preambleKey) { this.known.clear(); this.preambleKey = key; }
    const todo = [...names].filter((n) => !this.known.has(n)).slice(0, 400);
    if (!todo.length || this.running || !pre) return;
    this.running = this.probe(pre, todo).then(onDone).catch(() => {}).finally(() => { this.running = null; });
  }

  private async probe(preamble: string, names: string[]) {
    const dir = join(this.projectDir, ".margin", "probe");
    await mkdir(dir, { recursive: true });
    const tests = names.map((n) => `\\message{VFCMD:${n}:\\ifdefined\\${n}1\\else\\ifcsname ${n}\\endcsname1\\else0\\fi\\fi}`).join("\n");
    const doc = `${preamble}\n\\begin{document}\n${tests}\n\\end{document}\n`;
    const file = join(dir, "probe.tex");
    await Bun.write(file, doc);
    // the probe lives in .margin/probe, so TeX is told to look for the class and packages in the thesis folder
    const p = Bun.spawn(["tectonic", "-X", "compile", ".margin/probe/probe.tex", "--outdir", ".margin/probe", "--keep-logs", "-Z", `search-path=${resolve(this.projectDir)}`], { cwd: this.projectDir, stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => p.kill(), 60_000);
    await p.exited;
    clearTimeout(kill);
    const log = await Bun.file(join(dir, "probe.log")).text().catch(() => "");
    const seen = new Set<string>();
    for (const m of log.replace(/\n/g, "").matchAll(/VFCMD:([a-zA-Z@]+):([01])/g)) { this.known.set(m[1]!, m[2] === "1"); seen.add(m[1]!); }
    // a name the probe could not report on (the probe itself failed): treat as defined, never as an error
    for (const n of names) if (!seen.has(n)) this.known.set(n, true);
    await this.save();
    await rm(join(dir, "probe.pdf"), { force: true });
  }
}
