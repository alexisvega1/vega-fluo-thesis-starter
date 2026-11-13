// Reading and rewriting a LaTeX figure environment without disturbing anything else in it.
// Used by the visual view's "Edit figure" dialog; pure functions so they can be tested.

export interface FigureParts { file: string; options: string; width: number | null; caption: string | null; label: string | null }
export interface FigureEdit { file: string; width: number | null; caption: string | null; label: string | null }

/** Every figure environment in a document, as character ranges. Commented-out ones are skipped. */
export function findFigures(doc: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const re = /\\begin\{figure(\*?)\}/g;
  for (let m; (m = re.exec(doc)); ) {
    const lineStart = doc.lastIndexOf("\n", m.index) + 1;
    if (doc.slice(lineStart, m.index).includes("%")) continue;
    const close = `\\end{figure${m[1]}}`, end = doc.indexOf(close, m.index);
    if (end < 0) break;
    out.push({ from: m.index, to: end + close.length });
    re.lastIndex = end + close.length;
  }
  return out;
}

interface Cmd { start: number; end: number; opt: string; arg: string; argFrom: number; argTo: number }

/** Locate `\name[opt]{arg}` with balanced braces in the argument. */
function findCmd(block: string, name: string): Cmd | null {
  const re = new RegExp(`\\\\${name}\\s*(\\[[^\\]]*\\])?\\s*\\{`, "g");
  for (let m; (m = re.exec(block)); ) {
    const lineStart = block.lastIndexOf("\n", m.index) + 1;
    if (block.slice(lineStart, m.index).includes("%")) continue; // commented out
    let depth = 1, i = m.index + m[0].length;
    for (; i < block.length && depth; i++) {
      if (block[i] === "\\") i++;
      else if (block[i] === "{") depth++;
      else if (block[i] === "}") depth--;
    }
    if (depth) return null;
    return { start: m.index, end: i, opt: (m[1] ?? "").slice(1, -1), arg: block.slice(m.index + m[0].length, i - 1), argFrom: m.index + m[0].length, argTo: i - 1 };
  }
  return null;
}

/** `width=0.5\linewidth` -> 0.5; anything that is not a plain fraction of the line gives null. */
function widthOf(options: string): number | null {
  const m = options.match(/(?:^|,)\s*width\s*=\s*([\d.]*)\s*\\(?:line|text|column)width\s*(?:,|$)/);
  return m ? (m[1] ? Number(m[1]) : 1) : null;
}

export function parseFigure(block: string): FigureParts {
  const g = findCmd(block, "includegraphics"), c = findCmd(block, "caption"), l = findCmd(block, "label");
  return { file: g?.arg.trim() ?? "", options: g?.opt ?? "", width: g ? widthOf(g.opt) : null, caption: c ? c.arg.replace(/\s*\n\s*/g, " ").trim() : null, label: l?.arg.trim() ?? null };
}

/** Remove a command; if it was alone on its line, the line goes too. */
function cut(block: string, c: Cmd): string {
  const lineStart = block.lastIndexOf("\n", c.start) + 1;
  let lineEnd = block.indexOf("\n", c.end);
  if (lineEnd < 0) lineEnd = block.length;
  const alone = !block.slice(lineStart, c.start).trim() && !block.slice(c.end, lineEnd).trim();
  return alone ? block.slice(0, lineStart) + block.slice(Math.min(block.length, lineEnd + 1)) : block.slice(0, c.start) + block.slice(c.end);
}

/** Add a line straight after the line that holds `after`, with the same indentation. */
function addLineAfter(block: string, after: Cmd, text: string): string {
  const lineStart = block.lastIndexOf("\n", after.start) + 1;
  const indent = block.slice(lineStart).match(/^[ \t]*/)![0];
  let lineEnd = block.indexOf("\n", after.end);
  if (lineEnd < 0) lineEnd = block.length;
  return `${block.slice(0, lineEnd)}\n${indent}${text}${block.slice(lineEnd)}`;
}

/** Apply the dialog's choices. `width: null` leaves the existing size options alone. */
export function editFigure(block: string, next: FigureEdit): string {
  let g = findCmd(block, "includegraphics");
  if (g) {
    let opts = g.opt.split(",").map((o) => o.trim()).filter(Boolean);
    if (next.width !== null) {
      opts = opts.filter((o) => !/^(width|scale|height)\s*=/.test(o));
      opts.unshift(`width=${next.width === 1 ? "" : String(next.width)}\\linewidth`);
    }
    block = `${block.slice(0, g.start)}\\includegraphics${opts.length ? `[${opts.join(", ")}]` : ""}{${next.file || g.arg}}${block.slice(g.end)}`;
  }
  let c = findCmd(block, "caption");
  if (c && next.caption === null) block = cut(block, c);
  else if (c && next.caption !== null) block = block.slice(0, c.argFrom) + next.caption + block.slice(c.argTo);
  else if (!c && next.caption !== null && (g = findCmd(block, "includegraphics"))) block = addLineAfter(block, g, `\\caption{${next.caption}}`);

  const l = findCmd(block, "label");
  if (l && next.label === null) block = cut(block, l);
  else if (l && next.label !== null) block = block.slice(0, l.argFrom) + next.label + block.slice(l.argTo);
  else if (!l && next.label !== null) {
    // a label must follow the caption to pick up the figure number
    const anchor = findCmd(block, "caption") ?? findCmd(block, "includegraphics");
    if (anchor) block = addLineAfter(block, anchor, `\\label{${next.label}}`);
  }
  return block;
}
