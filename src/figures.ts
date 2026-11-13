// Figures: accept any common format, keep the original, and give LaTeX something it can include.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

const NATIVE = new Set([".pdf", ".png", ".jpg", ".jpeg"]); // what pdfLaTeX includes directly
const TO_PNG = new Set([".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic"]);
const TO_PDF = new Set([".svg", ".eps"]);
export const FIGURE_EXT = new Set([...NATIVE, ...TO_PNG, ...TO_PDF]);

export interface Figure { file: string; id: string; bytes: number; mtime: number; original?: string }

const safeName = (name: string) => basename(name).replace(/[^\w.\-]+/g, "-").replace(/^[.\-]+/, "") || "figure";
export const figureId = (file: string) => basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(err.trim().split("\n").pop() || `${cmd[0]} failed`);
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".svg": "image/svg+xml" };

/** Pixel size of an image file, or null. */
async function pixelSize(file: string): Promise<[number, number] | null> {
  const p = Bun.spawn(["sips", "-g", "pixelWidth", "-g", "pixelHeight", file], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  const w = /pixelWidth: (\d+)/.exec(out), h = /pixelHeight: (\d+)/.exec(out);
  return w && h ? [Number(w[1]), Number(h[1])] : null;
}

/**
 * Illustrator and Inkscape often save an SVG that only LINKS to its photos and schematics. Converted as
 * is, those panels silently vanish. This finds each linked file and writes a self-contained copy with the
 * images embedded. A linked file is looked for, in order: uploaded alongside the SVG; at its relative path
 * from wherever a copy of the SVG (or an already-found sibling) lives on this Mac; under the home folder;
 * by exact name through Spotlight. A candidate must be about the pixel size the SVG declares.
 */
export async function embedLinkedImages(svg: string, besideDir: string, svgName = ""): Promise<{ svg: string; embedded: string[]; missing: string[]; warnings: string[] }> {
  const embedded: string[] = [], missing: string[] = [], warnings: string[] = [];
  const home = process.env.HOME ?? "";
  const spotlight = async (name: string) => {
    const p = Bun.spawn(["mdfind", "-name", name], { stdout: "pipe", stderr: "ignore" });
    return (await new Response(p.stdout).text()).split("\n").filter((f) => f && basename(f) === name && !f.includes("/.margin/") && !f.includes("/figures/originals/"));
  };
  const exists = async (f: string) => !!(await stat(f).catch(() => null));
  const bases = new Set<string>([besideDir]);
  if (svgName) for (const f of await spotlight(svgName)) bases.add(dirname(f));
  let out = svg;
  // siblings (plain file names) first, so the folder they are found in can anchor the relative paths
  const tags = [...svg.matchAll(/<image\b[^>]*>/g)].sort((x, y) => Number(/href="[^"]*[\\/]/.test(x[0])) - Number(/href="[^"]*[\\/]/.test(y[0])));
  for (const t of tags) {
    const href = /(?:xlink:)?href="([^"]+)"/.exec(t[0])?.[1];
    if (!href || href.startsWith("data:")) continue;
    const rel = decodeURIComponent(href), name = rel.split(/[\\/]/).pop()!;
    const w = /\bwidth="([\d.]+)/.exec(t[0]), h = /\bheight="([\d.]+)/.exec(t[0]);
    const fits = async (f: string) => {
      if (!w || !h) return true;
      const sz = await pixelSize(f);
      return !!sz && Math.abs(sz[0] - Number(w[1])) <= Number(w[1]) * 0.02 + 1 && Math.abs(sz[1] - Number(h[1])) <= Number(h[1]) * 0.02 + 1;
    };
    const candidates = [
      join(besideDir, name),
      ...[...bases].map((b) => resolve(b, rel)),
      join(home, rel.replace(/^(\.\.[\\/])+/, "")),
      ...(await spotlight(name)),
    ];
    let found = "";
    for (const c of candidates) if ((await exists(c)) && (await fits(c))) { found = c; break; }
    const mime = MIME[extname(name).toLowerCase()];
    if (!found || !mime) { missing.push(name); continue; }
    bases.add(dirname(found));
    if (/scale\(0\)/.test(t[0])) warnings.push(`${name} is placed with scale(0) in the SVG, so it is invisible in every viewer. Re-export with more decimal places, or save the figure as PDF from Illustrator.`);
    // very large photos are embedded at up to 2400 px on the long side: plenty for print at figure size
    let bytes = await Bun.file(found).bytes(), type = mime;
    const sz = await pixelSize(found);
    if (sz && Math.max(sz[0], sz[1]) > 2400 && type !== "image/svg+xml") {
      const tmp = join(besideDir, `.embed-${Date.now()}.png`);
      const p = Bun.spawn(["sips", "-Z", "2400", "-s", "format", "png", found, "--out", tmp], { stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) === 0) { bytes = await Bun.file(tmp).bytes(); type = "image/png"; }
      await rm(tmp, { force: true });
    }
    out = out.replace(t[0], t[0].replace(/((?:xlink:)?href=")[^"]+"/, `$1data:${type};base64,${Buffer.from(bytes).toString("base64")}"`));
    embedded.push(name);
  }
  return { svg: out, embedded, missing, warnings };
}

/** Save a figure into <project>/figures, converting formats LaTeX cannot include. Returns the path to \includegraphics. */
export async function addFigure(projectDir: string, name: string, bytes: Uint8Array): Promise<{ file: string; id: string; converted: boolean; embedded?: string[]; missing?: string[]; warnings?: string[] }> {
  const clean = safeName(name);
  const ext = extname(clean).toLowerCase();
  if (!FIGURE_EXT.has(ext)) throw new Error(`${ext || "That file type"} is not a figure format Margin knows`);
  const dir = join(projectDir, "figures");
  await mkdir(join(dir, "originals"), { recursive: true });
  const stem = clean.slice(0, -ext.length);
  if (NATIVE.has(ext)) {
    await Bun.write(join(dir, clean), bytes);
    return { file: `figures/${clean}`, id: figureId(clean), converted: false };
  }
  const original = join(dir, "originals", clean);
  await Bun.write(original, bytes);
  const outExt = TO_PDF.has(ext) ? ".pdf" : ".png";
  const out = join(dir, stem + outExt);
  if (ext === ".svg") {
    const fixed = await embedLinkedImages(new TextDecoder().decode(bytes), join(dir, "originals"), clean);
    const source = fixed.embedded.length ? join(dir, "originals", `${stem}.embedded.svg`) : original;
    if (fixed.embedded.length) await Bun.write(source, fixed.svg);
    await run(["rsvg-convert", "--unlimited", "-f", "pdf", "-o", out, source]); // --unlimited: embedded photos make very long lines
    return { file: `figures/${stem}${outExt}`, id: figureId(stem), converted: true, embedded: fixed.embedded, missing: fixed.missing, warnings: fixed.warnings };
  }
  else if (ext === ".eps") await run(["magick", original, out]);
  else await run(["sips", "-s", "format", "png", original, "--out", out]);
  return { file: `figures/${stem}${outExt}`, id: figureId(stem), converted: true };
}

export async function listFigures(projectDir: string): Promise<Figure[]> {
  const dir = join(projectDir, "figures");
  const names = await readdir(dir).catch(() => [] as string[]);
  const originals = await readdir(join(dir, "originals")).catch(() => [] as string[]);
  const out: Figure[] = [];
  for (const n of names.sort()) {
    if (!NATIVE.has(extname(n).toLowerCase())) continue;
    const st = await stat(join(dir, n));
    const stem = n.slice(0, -extname(n).length);
    out.push({ file: `figures/${n}`, id: figureId(n), bytes: st.size, mtime: st.mtimeMs, original: originals.find((o) => o.slice(0, -extname(o).length) === stem) });
  }
  return out;
}

/** A small PNG preview, cached. Never serves the original file, so an SVG can never run script in the page. */
/** A project-relative path as LaTeX would write it (extension optional), or just a name inside figures/. */
async function resolveFigure(projectDir: string, file: string): Promise<string | null> {
  const root = resolve(projectDir);
  const tries = [file, join("figures", safeName(file))].flatMap((p) => [p, ...[...NATIVE].map((e) => p + e)]);
  for (const t of tries) {
    const abs = resolve(root, t);
    if (!abs.startsWith(root + "/") || !NATIVE.has(extname(abs).toLowerCase())) continue; // never outside the project
    if ((await stat(abs).catch(() => null))?.isFile()) return abs;
  }
  return null;
}

export async function thumbnail(projectDir: string, file: string, large = false): Promise<string | null> {
  const src = file && !file.includes("\0") ? await resolveFigure(projectDir, file) : null;
  if (!src) return null;
  const st = await stat(src);
  const name = src.slice(resolve(projectDir).length + 1).replace(/^figures\//, "").replace(/[^\w.\-]+/g, "_");
  const dir = join(projectDir, ".margin", "thumbs");
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${name}${large ? ".large" : ""}.png`);
  const have = await stat(out).catch(() => null);
  if (have && have.mtimeMs >= st.mtimeMs) return out;
  try {
    if (extname(name).toLowerCase() === ".pdf") await run(["pdftoppm", "-png", "-r", large ? "170" : "60", "-f", "1", "-l", "1", "-singlefile", src, out.slice(0, -4)]);
    else await run(["sips", "-Z", large ? "2000" : "560", "-s", "format", "png", src, "--out", out]);
    return out;
  } catch { return null; }
}

export const figureLatex = (file: string, id: string, caption = "") =>
  `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${file}}\n  \\caption{${caption}}\n  \\label{fig:${id}}\n\\end{figure}\n`;

/**
 * Programmatic figures: figures.json lists where each figure is produced, e.g.
 *   [{ "id": "sleep-suppression", "source": "~/analysis/out/fig2.pdf", "caption": "..." }]
 * Syncing copies (and converts) any source that is newer than the copy in the dissertation.
 */
export async function syncFigures(projectDir: string) {
  const f = Bun.file(join(projectDir, "figures.json"));
  const report = { updated: [] as string[], unchanged: 0, missing: [] as string[], errors: [] as string[], entries: [] as { id: string; file: string; caption: string }[] };
  if (!(await f.exists())) return report;
  let list: { id: string; source: string; caption?: string }[];
  try { list = await f.json(); } catch { report.errors.push("figures.json is not valid JSON"); return report; }
  const have = await listFigures(projectDir);
  for (const e of Array.isArray(list) ? list : []) {
    if (!e?.id || !e?.source) continue;
    const src = e.source.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
    const st = await stat(src).catch(() => null);
    const id = figureId(e.id);
    const existing = have.find((h) => h.id === id);
    if (existing) report.entries.push({ id, file: existing.file, caption: e.caption ?? "" });
    if (!st) { report.missing.push(`${e.id}: ${e.source}`); continue; }
    if (existing && existing.mtime >= st.mtimeMs) { report.unchanged++; continue; }
    try {
      const added = await addFigure(projectDir, id + extname(src).toLowerCase(), await Bun.file(src).bytes());
      report.updated.push(added.file);
      if (!existing) report.entries.push({ id, file: added.file, caption: e.caption ?? "" });
    } catch (err) { report.errors.push(`${e.id}: ${(err as Error).message}`); }
  }
  return report;
}
