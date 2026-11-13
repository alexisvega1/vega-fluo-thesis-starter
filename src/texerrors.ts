// Plain-English build problems. TeX's messages are terse and often point at the wrong line (a runaway
// argument is reported where the file ends; an undefined citation is reported with no file at all).
// This turns Tectonic's output and its .log into problems with a source file, a line and a one-sentence fix.

export type Kind =
  | "undefined-command" | "missing-dollar" | "runaway" | "file-not-found" | "undefined-citation"
  | "undefined-reference" | "float-too-large" | "dimension-too-large" | "missing-begin-document" | "other";

export interface Problem { file: string; line: number; message: string; kind: Kind; hint?: string; key?: string; snippet?: string }

/** Which kind of problem a TeX message describes, and the one-sentence fix. `near` is the command TeX stopped at, when known. */
export function explain(message: string, near = ""): { kind: Kind; hint?: string } {
  const m = message.replace(/^!\s*/, "");
  if (/Undefined control sequence/i.test(m)) {
    const cmd = /^\\[a-zA-Z@]+$/.test(near) ? near : "A command on this line";
    return { kind: "undefined-command", hint: `${cmd} is not defined: check its spelling, or add the \\usepackage{…} that provides it to main.tex.` };
  }
  if (/Missing \$ inserted/i.test(m))
    return { kind: "missing-dollar", hint: "A math-only character (_ ^ or a math command like \\alpha) is outside math: wrap it in $…$, or write \\_ for a literal underscore." };
  if (/File ended while scanning use of|Paragraph ended before .* was complete|Runaway argument/i.test(m))
    return { kind: "runaway", hint: "A { opened here is never closed (or a blank line sits inside a command's argument): add the missing } before the paragraph ends." };
  if (/Unable to load picture or PDF file|File `[^']*' not found|cannot find image file|LaTeX Error: File/i.test(m)) {
    const f = /[`']([^'`]+)'/.exec(m)?.[1];
    return { kind: "file-not-found", hint: `${f ? `"${f}"` : "A file"} is not in the project at that path: check the spelling and folder (paths are relative to main.tex), or add the file.` };
  }
  if (/Citation [`'].*' .*undefined/i.test(m))
    return { kind: "undefined-citation", hint: "This citation key is not in the .bib: fix the key, or add the reference (for example by DOI), then build again." };
  if (/Reference [`'].*' .*undefined/i.test(m))
    return { kind: "undefined-reference", hint: "No \\label with this name exists (or the label is on a figure without a \\caption): check the name, then build again." };
  if (/Float too large for page/i.test(m))
    return { kind: "float-too-large", hint: "This figure or table is taller than the page: scale it down (e.g. \\includegraphics[height=0.8\\textheight]{…}) or split it." };
  if (/Dimension too large/i.test(m))
    return { kind: "dimension-too-large", hint: "A length on this line is beyond TeX's limit (about 5.75 m): look for a huge number or a unit typo such as cm for mm." };
  if (/Missing \\begin\{document\}/i.test(m))
    return { kind: "missing-begin-document", hint: "Text appears before \\begin{document}: move it into the document body, or check that main.tex has \\begin{document} and that the preamble has no stray characters." };
  return { kind: "other" };
}

/** Tectonic's own wrapper lines, which say nothing about the source. */
const NOISE = /^(something bad happened inside XeTeX|the XeTeX engine had an unrecoverable error|halted on potentially-recoverable error)/;

/**
 * Errors from Tectonic's stdout/stderr ("error: ch/body:2: Undefined control sequence"), with the
 * runaway text and the line TeX stopped on taken from the log, plus the warnings that matter
 * (undefined citations and references, oversize floats) from the .log with the file they occurred in.
 */
export function diagnose(output: string, log: string, failed = /^error: /m.test(output)): { errors: Problem[]; warnings: Problem[] } {
  const errors: Problem[] = [];
  for (const raw of output.split("\n")) {
    if (raw.startsWith("warning:") || raw.startsWith("note:")) continue;
    const line = raw.replace(/\s+$/, "");
    const m = /^(?:error: )?((?:\.\/)?[\w.\/-]+?(?:\.(?:tex|bib|cls|sty))?):(\d+): (.+)$/.exec(line);
    if (m) {
      const message = m[3]!.replace(/^!\s*/, "").replace(/\.\.$/, ".");
      errors.push({ file: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), message, ...explain(message) });
    } else if (/^(! |error: )/.test(line)) {
      const message = line.replace(/^(! |error: )/, "");
      if (!NOISE.test(message)) errors.push({ file: "", line: 0, message, ...explain(message) });
    }
  }
  // the text TeX was reading when an argument ran away: "Runaway argument?\n{bold never closes \par ..."
  const run = /Runaway argument\?\n(.+)/.exec(log);
  if (run) for (const e of errors) if (e.kind === "runaway") e.snippet = run[1]!.replace(/\\par\b.*$/, "").replace(/^\{/, "").trim();
  // Tectonic repeats each error inside its dump of TeX's output ("! Undefined control sequence."): keep the located one
  const same = (a: string) => a.replace(/[\s.]+$/, "");
  const kept = errors.filter((e, n) => e.file || !errors.some((x, k) => k !== n && x.file && same(x.message) === same(e.message)));
  // a run that stopped early never read the .aux: every citation and reference looks undefined, so say nothing about them
  const warnings = logWarnings(log).filter((w) => !failed || (w.kind !== "undefined-citation" && w.kind !== "undefined-reference"));
  return { errors: kept, warnings };
}

/**
 * LaTeX warnings worth showing, each with the file it came from. TeX writes "(file" when it opens a
 * file and ")" when it closes it, so a stack of open parentheses says which file a warning belongs to.
 */
export function logWarnings(log: string): Problem[] {
  const out: Problem[] = [];
  // TeX wraps log lines at 79 characters; a warning can be split across lines, so join each paragraph
  const text = log.replace(/\r/g, "");
  const stack: string[] = [];
  let i = 0;
  const want = /^LaTeX Warning: (Citation [`'][^']*' (?:on page \d+ )?undefined|Reference [`'][^']*' (?:on page \d+ )?undefined|Float too large for page[^\n]*?)(?:\s+on input line\s+(\d+))?\.?$/;
  while (i < text.length) {
    const head = /^(?:LaTeX|Package natbib) Warning: /.exec(text.slice(i, i + 40));
    if (head && (i === 0 || text[i - 1] === "\n")) {
      const end = text.indexOf("\n\n", i);
      const para = text.slice(i, end === -1 ? undefined : end).replace(/\n/g, "");
      const m = want.exec(para.replace(head[0], "LaTeX Warning: "));
      if (m) {
        const message = m[1]!.replace(/ on page \d+/, "");
        const key = /[`']([^']*)'/.exec(message)?.[1];
        out.push({ file: stack[stack.length - 1] ?? "", line: m[2] ? Number(m[2]) : 0, message, key, ...explain(message) });
      }
      i = end === -1 ? text.length : end;
      continue;
    }
    const c = text[i]!;
    if (c === "(") {
      const f = /^\(([^\s()]+)/.exec(text.slice(i, i + 300))?.[1] ?? "";
      stack.push(/\.(tex|cls|sty|clo|cfg|def|fd|aux|bbl|toc|lof|lot)$|^[\w.\/-]+\/[\w.-]+$|^[\w-]+$/.test(f) && !/^\d/.test(f) ? f.replace(/^\.\//, "") : "");
      i++;
    } else if (c === ")") { stack.pop(); i++; }
    else i++;
  }
  // keep project sources only: package-internal warnings are not the author's to fix
  return out.filter((w) => !w.file || !/\.(cls|sty|clo|cfg|def|fd)$/.test(w.file)).filter((w, n, a) => a.findIndex((x) => x.message === w.message && x.file === w.file && x.line === w.line) === n);
}

/**
 * Point problems at the line the author must change, using the source text:
 * a runaway argument at the line where its text begins; an undefined citation or reference at the
 * line that uses the key. `files` are the project's .tex files.
 */
export function refine(problems: Problem[], files: { path: string; text: string }[]): Problem[] {
  const find = (re: RegExp, prefer?: string) => {
    const order = prefer ? [...files.filter((f) => f.path === prefer), ...files.filter((f) => f.path !== prefer)] : files;
    for (const f of order) {
      const lines = f.text.split("\n");
      for (let n = 0; n < lines.length; n++) if (re.test(lines[n]!.replace(/(^|[^\\])%.*$/, "$1"))) return { file: f.path, line: n + 1 };
    }
    return null;
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const p of problems) {
    if (p.kind === "runaway" && p.snippet) {
      const words = p.snippet.split(/\s+/).filter(Boolean).slice(0, 4);
      if (words.length) { const at = find(new RegExp(words.map(esc).join("\\s+"))); if (at) Object.assign(p, at); }
    } else if ((p.kind === "undefined-citation" || p.kind === "undefined-reference") && p.key) {
      const re = p.kind === "undefined-citation"
        ? new RegExp(`\\\\\\w*cite\\w*\\*?(?:\\[[^\\]]*\\])*\\{[^}]*(?<=[{,\\s])${esc(p.key)}\\s*[,}]`)
        : new RegExp(`\\\\\\w*ref\\*?\\{${esc(p.key)}\\}`);
      const at = find(re, p.file || undefined);
      if (at) Object.assign(p, at);
    }
  }
  return problems;
}
