// Jumping between the built PDF and the LaTeX source.
// There is no SyncTeX reader on this machine, so this works from the text itself: the words at a spot
// in the PDF are looked up in the source prose, and the words around the cursor are looked up in the PDF.
// It is exact for ordinary prose and approximate around citations, equations and hyphenated line breaks.
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { renderProse, sourceStartPos } from "./texprose";

export interface PdfWord { t: string; x0: number; y0: number; x1: number; y1: number }
export interface PdfPage { w: number; h: number; words: PdfWord[] }

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
const cache = new Map<string, { mtime: number; pages: PdfPage[] }>();

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return (await p.exited) === 0 ? out : "";
}

/** Every word on every page, with its box, read once per build. */
export async function pdfPages(pdf: string): Promise<PdfPage[]> {
  const st = await stat(pdf).catch(() => null);
  if (!st) return [];
  const hit = cache.get(pdf);
  if (hit && hit.mtime === st.mtimeMs) return hit.pages;
  const xml = await run(["pdftotext", "-bbox", "-enc", "UTF-8", pdf, "-"]);
  const pages: PdfPage[] = [];
  for (const m of xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    const words: PdfWord[] = [];
    for (const w of m[3]!.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
      const t = norm(w[5]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'));
      if (t) words.push({ t, x0: +w[1]!, y0: +w[2]!, x1: +w[3]!, y1: +w[4]! });
    }
    pages.push({ w: +m[1]!, h: +m[2]!, words });
  }
  cache.set(pdf, { mtime: st.mtimeMs, pages });
  return pages;
}

/** A PNG of one page, cached until the PDF is rebuilt. */
export async function pageImage(pdf: string, n: number): Promise<string | null> {
  const st = await stat(pdf).catch(() => null);
  if (!st) return null;
  const dir = join(pdf, "..", "pages");
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${Math.round(st.mtimeMs)}-${n}`);
  if (!(await stat(`${out}.png`).catch(() => null)))
    await run(["pdftoppm", "-png", "-r", "120", "-f", String(n), "-l", String(n), "-singlefile", pdf, out]);
  return (await stat(`${out}.png`).catch(() => null)) ? `${out}.png` : null;
}

/**
 * Find a run of words inside a longer list. Tries windows of the query, widest first and nearest
 * `center` first, and returns the index in `hay` where the best window starts, plus how many words matched.
 */
function locate(hay: string[], query: string[], center: number): { at: number; len: number; offset: number } | null {
  const starts = new Map<string, number[]>();
  hay.forEach((w, i) => { const l = starts.get(w); if (l) l.push(i); else starts.set(w, [i]); });
  for (const size of [8, 6, 5, 4, 3]) {
    if (query.length < size) continue;
    const windows = Array.from({ length: query.length - size + 1 }, (_, i) => i).sort((a, b) => Math.abs(a + size / 2 - center) - Math.abs(b + size / 2 - center));
    for (const w of windows) {
      const hits = (starts.get(query[w]!) ?? []).filter((i) => query.slice(w, w + size).every((q, k) => hay[i + k] === q));
      if (hits.length === 1) return { at: hits[0]!, len: size, offset: w }; // unique match only: a repeated phrase proves nothing
    }
  }
  return null;
}

/** Where in the PDF do these source words appear? */
export async function findInPdf(pdf: string, words: string[], center: number) {
  const pages = await pdfPages(pdf);
  const flat: { p: number; w: PdfWord }[] = [];
  pages.forEach((pg, p) => pg.words.forEach((w) => flat.push({ p, w })));
  const q = words.map(norm).filter(Boolean);
  const hit = locate(flat.map((f) => f.w.t), q, Math.min(center, q.length));
  if (!hit) return null;
  // aim at the word nearest the cursor inside the matched window
  const aim = flat[Math.min(flat.length - 1, hit.at + clampInt(center - hit.offset, 0, hit.len - 1))]!;
  const pg = pages[aim.p]!;
  return { page: aim.p + 1, x: aim.w.x0 / pg.w, y: aim.w.y0 / pg.h, h: (aim.w.y1 - aim.w.y0) / pg.h };
}
const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** Which source line produced the text at this spot on a PDF page? (x, y are fractions of the page.) */
export async function findInSource(pdf: string, projectDir: string, texFiles: string[], page: number, x: number, y: number) {
  const pg = (await pdfPages(pdf))[page - 1];
  if (!pg?.words.length) return null;
  const px = x * pg.w, py = y * pg.h;
  // the word under (or nearest to) the pointer
  let best = 0, bd = Infinity;
  pg.words.forEach((w, i) => {
    const dy = py < w.y0 ? w.y0 - py : py > w.y1 ? py - w.y1 : 0, dx = px < w.x0 ? w.x0 - px : px > w.x1 ? px - w.x1 : 0;
    const d = dy * 3 + dx;
    if (d < bd) { bd = d; best = i; }
  });
  const from = Math.max(0, best - 7), query = pg.words.slice(from, best + 8).map((w) => w.t);
  for (const file of texFiles) {
    const tex = await Bun.file(join(projectDir, file)).text().catch(() => "");
    if (!tex) continue;
    const prose = renderProse(tex);
    const toks = [...prose.text.matchAll(/\S+/g)].map((m) => ({ t: norm(m[0]), r: m.index! })).filter((t) => t.t);
    const hit = locate(toks.map((t) => t.t), query, best - from);
    if (!hit) continue;
    const tok = toks[Math.min(toks.length - 1, hit.at + clampInt(best - from - hit.offset, 0, hit.len - 1))]!;
    const pos = sourceStartPos(prose, tok.r);
    return { file, line: tex.slice(0, pos).split("\n").length, matched: hit.len };
  }
  return null;
}
