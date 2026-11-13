// SyncTeX: TeX's own record of which source line put each box, kern and glue on each PDF page.
// Read in TypeScript from .build/<name>.synctex.gz (Bun's gunzip; no native SyncTeX library needed).
//
// Units, checked against `pdftotext -bbox` on a Tectonic build: positions are scaled points (sp),
// measured from the page's top-left corner with TeX's 1in offset already included, and y is the
// baseline. sp × 72 / 72.27 / 65536 gives PDF points.
//
// XeTeX tags each line box of a paragraph with the line where the paragraph ENDED (the blank line),
// so source lines are read from the kern, glue and math records inside those boxes, which carry the
// line that produced them.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SyncRecord { page: number; file: number; line: number; x: number; y: number; top: number; bottom: number; point: boolean }
export interface SyncData { inputs: Map<number, string>; records: SyncRecord[] }

const SP = 72 / 72.27 / 65536; // scaled points → PDF points

/** Parse the text of a .synctex file. Coordinates come back in PDF points. */
export function parseSynctex(text: string): SyncData {
  const inputs = new Map<number, string>();
  const records: SyncRecord[] = [];
  let page = 0, mag = 1, unit = 1;
  const boxes: { top: number; bottom: number }[] = []; // enclosing hboxes, for each point record's line height
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const c = line[0]!;
    if (c === "I" && line.startsWith("Input:")) {
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m && m[2]) inputs.set(Number(m[1]), m[2]);
      continue;
    }
    if (line.startsWith("Magnification:")) { mag = Number(line.slice(14)) / 1000 || 1; continue; }
    if (line.startsWith("Unit:")) { unit = Number(line.slice(5)) || 1; continue; }
    if (c === "{") { page = Number(line.slice(1)); boxes.length = 0; continue; }
    if (c === "}") { page = 0; continue; }
    if (!page) continue;
    if (c === ")" || c === "]") { if (c === ")") boxes.pop(); continue; }
    // <type><file>,<line>[,<column>]:<x>,<y>[:<W>,<H>,<D> | :<W>]
    const m = /^([\[(vhkgx$])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/.exec(line);
    if (!m) continue;
    const k = unit * mag * SP;
    const x = Number(m[4]) * k, y = Number(m[5]) * k;
    const H = m[7] !== undefined ? Number(m[7]) * k : 0, D = m[8] !== undefined ? Number(m[8]) * k : 0;
    const type = m[1]!;
    if (type === "(") boxes.push({ top: y - H, bottom: y + D });
    const point = type === "k" || type === "g" || type === "x" || type === "$";
    const box = boxes[boxes.length - 1];
    records.push({
      page, file: Number(m[2]), line: Number(m[3]), x, y,
      top: point ? (box?.top ?? y - 8) : y - H, bottom: point ? (box?.bottom ?? y + 2) : y + D,
      point,
    });
  }
  return { inputs, records };
}

/** The synctex file Tectonic writes next to a PDF, parsed once per build; null when there is none or it is older than the PDF. */
const cache = new Map<string, { mtime: number; data: SyncData }>();
export async function loadSynctex(pdf: string): Promise<SyncData | null> {
  const file = pdf.replace(/\.pdf$/, ".synctex.gz");
  const [st, pst] = await Promise.all([stat(file).catch(() => null), stat(pdf).catch(() => null)]);
  if (!st || !pst || st.mtimeMs < pst.mtimeMs - 60_000) return null; // left over from an older build
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.data;
  try {
    const data = parseSynctex(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(file).arrayBuffer()))));
    cache.set(file, { mtime: st.mtimeMs, data });
    return data;
  } catch { return null; }
}

/** Input ids → project-relative paths. Paths outside the project (class files, packages) are dropped. */
export async function projectInputs(data: SyncData, projectDir: string): Promise<Map<number, string>> {
  const roots = [resolve(projectDir), await realpath(projectDir).catch(() => resolve(projectDir))];
  const out = new Map<number, string>();
  for (const [id, p] of data.inputs) {
    for (const root of roots) {
      const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
      // a file that is gone (the draft-preview wrapper is deleted after each build) cannot be jumped to
      if (abs.startsWith(root + sep) && (await stat(abs).catch(() => null))?.isFile()) { out.set(id, relative(root, abs).split(sep).join("/")); break; }
    }
  }
  return out;
}

export interface Spot { page: number; x: number; y: number; h: number }

/**
 * Source → PDF: every place the given line of `file` put something, top of the first one first.
 * Sizes are the page sizes in points (from the PDF), to turn positions into fractions of the page.
 */
export function forward(data: SyncData, files: Map<number, string>, file: string, line: number, sizes: [number, number][]): Spot[] {
  const ids = [...files].filter(([, p]) => p === file).map(([id]) => id);
  if (!ids.length) return [];
  const mine = data.records.filter((r) => ids.includes(r.file) && r.point);
  // the exact line, else the nearest line after it that produced output (a blank or comment line produces none)
  let hits = mine.filter((r) => r.line === line);
  if (!hits.length) {
    const after = mine.filter((r) => r.line > line && r.line - line <= 5).sort((a, b) => a.line - b.line);
    hits = after.length ? mine.filter((r) => r.line === after[0]!.line) : [];
  }
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.page - b.page || a.top - b.top || a.x - b.x)
    .filter((r) => { const k = `${r.page}:${Math.round(r.top)}`; return !seen.has(k) && !!seen.add(k); }) // one spot per PDF line
    .map((r) => {
      const [w, h] = sizes[r.page - 1] ?? [612, 792];
      return { page: r.page, x: r.x / w, y: r.top / h, h: (r.bottom - r.top) / h };
    });
}

/** PDF → source: the file and line that produced what is at (x, y) on a page (fractions of the page). */
export function reverse(data: SyncData, files: Map<number, string>, page: number, x: number, y: number, size: [number, number]): { file: string; line: number } | null {
  const px = x * size[0], py = y * size[1];
  let best: SyncRecord | null = null, bd = Infinity;
  for (const r of data.records) {
    if (r.page !== page || !r.point || !files.has(r.file) || r.line <= 0) continue;
    const dy = py < r.top ? r.top - py : py > r.bottom ? py - r.bottom : 0;
    // a glue or kern sits at the end of the word before it: prefer the record just right of the pointer
    const dx = r.x >= px ? r.x - px : (px - r.x) * 1.5;
    if (dy > 30) continue; // more than about two lines away: nothing here was written by the source
    const d = dy * 6 + dx;
    if (d < bd) { bd = d; best = r; }
  }
  return best ? { file: files.get(best.file)!, line: best.line } : null;
}
