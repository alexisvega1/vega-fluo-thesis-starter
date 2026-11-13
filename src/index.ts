import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
import { BM25 } from "./bm25";
import { parseBib, type BibEntry } from "./bib";
import { findDoi, pdfPages } from "./pdftext";

export interface Chunk {
  id: string; // "<path>#<n>"
  path: string; // relative to its source root
  heading: string;
  text: string;
  kind: "note" | "table" | "pdf";
  cite?: string; // citekey of the paper this passage comes from, once the PDF is matched to the bibliography
}

export interface Paper { path: string; pages: number; doi: string; head: string; cite?: string }
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const SKIP_DIR = /^(\.git|node_modules|\.?venv.*|site-packages|__pycache__|\.pixi|\.cache|dist|build|\.build|\.margin)$/;
const TEXT_EXT = new Set([".md", ".txt", ".tex", ".qmd"]);
const TABLE_EXT = new Set([".csv", ".tsv"]);
const MAX_BYTES = 2_000_000;
const CHUNK_CHARS = 800;

export async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith("~$") || e.name === ".DS_Store") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) yield* walk(p); }
    else if (e.isFile()) yield p;
  }
}

/** Split prose into ~CHUNK_CHARS chunks on paragraph boundaries, tracking the nearest heading. */
export function chunkText(text: string, path: string): Chunk[] {
  const out: Chunk[] = [];
  let heading = "", buf = "", bufHeading = "";
  const flush = () => {
    const t = buf.trim();
    if (t.length >= 40) out.push({ id: `${path}#${out.length}`, path, heading: bufHeading, text: t, kind: "note" });
    buf = "";
  };
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    const h = /^(#{1,6})\s+(.+)$/.exec(p) ?? /^\\(?:sub)*section\*?\{(.+?)\}/.exec(p);
    if (h) { flush(); heading = (h[2] ?? h[1])!.trim(); continue; }
    if (buf && buf.length + p.length > CHUNK_CHARS) flush();
    if (!buf) bufHeading = heading;
    buf += (buf ? "\n\n" : "") + p;
  }
  flush();
  return out;
}

function tableChunk(text: string, path: string): Chunk | null {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 6);
  if (!lines.length) return null;
  return { id: `${path}#0`, path, heading: "columns: " + lines[0]!.slice(0, 300), text: lines.join("\n").slice(0, 900), kind: "table" };
}

export class Index {
  refs = new BM25<BibEntry>();
  chunks = new BM25<Chunk>();
  keys = new Map<string, BibEntry>();
  papers: Paper[] = [];
  claims = new Map<string, string>(); // one-line claim cards written by the cards pass
  files = 0;
  builtAt = 0;
  ms = 0;

  static async build(sources: string[], opts: { bibOnly?: boolean; pdfCache?: string; quiet?: string[] } = {}): Promise<Index> {
    const t0 = performance.now();
    const ix = new Index();
    for (const root of sources) {
      const st = await stat(root).catch(() => null);
      if (!st) { if (!opts.quiet?.includes(root)) console.warn(`[index] source not found: ${root}`); continue; }
      const files = st.isDirectory() ? walk(root) : (async function* () { yield root; })();
      const base = st.isDirectory() ? root : join(root, "..");
      for await (const file of files) {
        const ext = extname(file).toLowerCase();
        if (opts.bibOnly && ext !== ".bib") continue;
        if (ext === ".pdf" && opts.pdfCache) {
          // a paper dropped into a folder: index its text page by page (figure PDFs have no text and are skipped)
          const pages = await pdfPages(file, opts.pdfCache);
          if (pages.join("").length < 1500) continue;
          const rel = relative(base, file);
          ix.files++;
          ix.papers.push({ path: rel, pages: pages.length, doi: findDoi(pages.slice(0, 2).join(" ")), head: squash(pages.slice(0, 2).join(" ")).slice(0, 8000) });
          pages.forEach((page, n) => {
            chunkText(page, rel).forEach((c, i) => {
              const chunk: Chunk = { ...c, id: `${rel}#p${n + 1}.${i}`, heading: `p. ${n + 1}`, kind: "pdf" };
              ix.chunks.add(chunk, `${basename(rel)} ${chunk.text}`);
            });
          });
          continue;
        }
        if (ext !== ".bib" && !TEXT_EXT.has(ext) && !TABLE_EXT.has(ext)) continue;
        const f = Bun.file(file);
        if (f.size > (ext === ".bib" ? 60_000_000 : MAX_BYTES)) continue; // a reference manager's export can be large
        const text = await f.text().catch(() => "");
        if (!text) continue;
        const rel = relative(base, file);
        ix.files++;
        if (ext === ".bib") {
          for (const e of parseBib(text)) {
            if (ix.keys.has(e.key)) continue; // first definition wins across overlapping libraries
            ix.keys.set(e.key, e);
          }
        } else if (TABLE_EXT.has(ext)) {
          const c = tableChunk(text, rel);
          if (c) ix.chunks.add(c, `${basename(rel)} ${rel} ${c.text}`);
        } else {
          for (const c of chunkText(text, rel)) ix.chunks.add(c, `${c.heading} ${basename(rel)} ${c.text}`);
        }
      }
    }
    // abstracts fetched from PubMed and one-line claim cards live beside the .bib files, keyed by citekey
    for (const root of sources) {
      for (const [name, field] of [["abstracts.json", "abstract"], ["claims.json", "claim"]] as const) {
        const f = Bun.file(join(root, name));
        if (!(await f.exists())) continue;
        const extra = (await f.json().catch(() => ({}))) as Record<string, string>;
        for (const [key, value] of Object.entries(extra)) {
          const e = ix.keys.get(key);
          if (!e || !value) continue;
          if (field === "abstract") { if (!e.abstract) e.abstract = value; } else ix.claims.set(key, value);
        }
      }
    }
    // title weighted double so title matches outrank abstract mentions
    for (const e of ix.keys.values()) ix.refs.add(e, `${e.title} ${e.title} ${e.authors} ${e.year} ${e.journal} ${e.abstract} ${ix.claims.get(e.key) ?? ""}`);
    ix.builtAt = Date.now();
    ix.ms = Math.round(performance.now() - t0);
    return ix;
  }

  /** Tie each PDF to its bibliography entry (by DOI, else by title on the first pages) so its passages can be cited. */
  linkPapers(entries: Iterable<BibEntry>) {
    const list = [...entries].map((e) => ({ key: e.key, doi: e.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, ""), title: squash(e.title) }));
    for (const p of this.papers) {
      const hit = list.find((e) => (e.doi && e.doi === p.doi) || (e.title.length >= 25 && p.head.includes(e.title)));
      p.cite = hit?.key;
    }
    const byPath = new Map(this.papers.map((p) => [p.path, p.cite]));
    for (const c of this.chunks.docs) if (c.kind === "pdf") c.cite = byPath.get(c.path);
  }

  /** Keep hits that clear an absolute floor and are within `rel` of the best hit. */
  private static keep<T>(hits: { doc: T; score: number }[], floor = 1.5, rel = 0.35) {
    const top = hits[0]?.score ?? 0;
    return hits.filter((h) => h.score >= floor && h.score >= top * rel);
  }

  searchRefs(q: string, k = 6) { return Index.keep(this.refs.search(q, k)); }
  /** Every reference that matches at all, best first — for browsing rather than suggesting. */
  rankRefs(q: string, k = 40) { return this.refs.search(q, k); }
  searchChunks(q: string, k = 5) { return Index.keep(this.chunks.search(q, k)); }

  /** Citekey lookup for the `@` completer: key substring matches first, then full-text hits. */
  cite(q: string, k = 12): BibEntry[] {
    const ql = q.toLowerCase();
    const out = new Map<string, BibEntry>();
    for (const [key, e] of this.keys) {
      if (out.size >= k) break;
      if (!ql || key.toLowerCase().includes(ql)) out.set(key, e);
    }
    if (ql) for (const h of this.refs.search(q, k)) if (out.size < k) out.set(h.doc.key, h.doc);
    return [...out.values()];
  }
}
