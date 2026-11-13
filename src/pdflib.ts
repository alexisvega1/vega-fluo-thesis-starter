// A light index of a large PDF collection: which PDF is which reference.
// Nothing is copied and the PDFs are not full-text indexed. For each file it reads the first two
// pages once (cached by path and modification time), takes the DOI if one is printed there, and
// otherwise matches the reference's title against that text. Folders are ones you name yourself.
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BibEntry } from "./bib";

interface Seen { mtime: number; size: number; dois: string[]; head: string }
export interface PdfLibStatus { folders: string[]; files: number; matched: number; scanning: boolean; done: number; error: string }

/** Topics read first when a large folder is scanned, most important first (matched against file names). */
export const PRIORITY: string[][] = [
  ["sleep", "rem ", "nrem", "slow-wave", "slow wave", "circadian", "wake"],
  ["learning", "memory", "consolidat", "recall", "fear", "conditioning"],
  ["plasticity", "ltp", "synap"],
  ["dendritic", "spine"],
  ["hippocamp", "ca1", "ca3", "dentate"],
  ["amygdala", "bla "],
  ["cortex", "cortical", "prefrontal", "pfc"],
  ["sex difference", "sex-specific", "sex specific", "female", "male", "sexual dimorph", "estrous", "estrogen"],
];
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const DOI = /\b10\.\d{4,9}\/[^\s"<>{}|\\^`]+/g;

export class PdfLibrary {
  folders: string[] = [];
  private seen = new Map<string, Seen>();
  private byKey = new Map<string, string>();
  private state: { scanning: boolean; done: number; error: string; total?: number } = { scanning: false, done: 0, error: "" };
  private entries: BibEntry[] = [];

  constructor(private cacheFile: string) {}

  status(): PdfLibStatus { return { folders: this.folders, files: this.seen.size, matched: this.byKey.size, ...this.state }; }
  pathFor(key: string): string | null { return this.byKey.get(key) ?? null; }
  has(key: string) { return this.byKey.has(key); }
  /** Files the index read but could not tie to any reference, with what was read from them. */
  unmatched(): { path: string; dois: string[]; head: string }[] {
    const used = new Set(this.byKey.values());
    return [...this.seen].filter(([p]) => !used.has(p)).map(([path, s]) => ({ path, dois: s.dois ?? [], head: s.head }));
  }

  async load() {
    try {
      const saved = await Bun.file(this.cacheFile).json();
      this.folders = Array.isArray(saved.folders) ? saved.folders : [];
      this.seen = new Map(Object.entries(saved.seen ?? {}) as [string, Seen][]);
    } catch { /* first run */ }
  }
  private async save() {
    await mkdir(join(this.cacheFile, ".."), { recursive: true });
    await Bun.write(this.cacheFile, JSON.stringify({ folders: this.folders, seen: Object.fromEntries(this.seen) }));
  }

  /** Match what has been read so far against the references. Cheap; run after every scan or reindex. */
  link(entries: BibEntry[]) {
    this.entries = entries;
    const byDoi = new Map<string, string>(), titles: [string, string][] = [];
    for (const e of entries) {
      if (e.doi) byDoi.set(e.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, ""), e.key);
      const t = norm(e.title);
      if (t.length >= 28) titles.push([t, e.key]);
    }
    this.byKey.clear();
    const claim = (key: string | undefined, path: string) => { if (key && !this.byKey.has(key)) { this.byKey.set(key, path); return true; } return false; };
    const dois = [...byDoi.keys()];
    const unmatched: [string, Seen][] = [];
    for (const [path, s] of this.seen) {
      // the paper's own DOI is usually the first printed; text run on after it ("...001Article") is tolerated
      const key = (s.dois ?? []).map((d) => byDoi.get(d) ?? byDoi.get(dois.find((k) => k.length > 12 && d.startsWith(k)) ?? "")).find(Boolean);
      if (!claim(key, path)) unmatched.push([path, s]);
    }
    for (const [path, s] of unmatched) {
      // no usable DOI: the title printed on the first pages, or a file named after the title
      const name = norm(path.split("/").pop()!.replace(/\.pdf$/i, ""));
      const hit = titles.find(([t, key]) => !this.byKey.has(key) && ((s.head.length >= 40 && s.head.includes(t)) || (name.length >= 25 && (t.startsWith(name) || name.startsWith(t)))));
      if (hit) this.byKey.set(hit[1], path);
    }
    // the same paper often appears twice (your thesis .bib and the Mendeley export, under different keys):
    // a PDF found for one copy serves every copy with the same DOI or title
    const groups = new Map<string, string[]>();
    for (const e of entries) {
      const ids = [e.doi ? `doi:${e.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}` : "", norm(e.title).length >= 28 ? `t:${norm(e.title)}` : ""];
      for (const id of ids) if (id) { const g = groups.get(id); if (g) g.push(e.key); else groups.set(id, [e.key]); }
    }
    for (const keys of groups.values()) {
      const path = keys.map((k) => this.byKey.get(k)).find(Boolean);
      if (path) for (const k of keys) if (!this.byKey.has(k)) this.byKey.set(k, path);
    }
  }

  /** A folder on another machine, written host:/path, is read there over SSH (only the first pages' text comes back). */
  static remote(f: string) { const m = /^([\w.-]+):(\/.*)$/.exec(f); return m ? { host: m[1]!, path: m[2]! } : null; }

  private async scanRemote(host: string, root: string, live: Set<string>) {
    const prefix = `${host}:`;
    const known: Record<string, [number, number]> = {};
    for (const [p, s] of this.seen) if (p.startsWith(prefix + root)) known[p.slice(prefix.length)] = [Math.round(s.mtime), s.size];
    const script = await Bun.file(join(import.meta.dir, "..", "nodes", "pdfscan.py")).text();
    // the scanner is sent on each run, so nothing has to be installed on the other machine
    const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, `python3 -c 'import sys,json;exec(json.loads(sys.stdin.readline()))'`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(`${JSON.stringify(script)}\n${JSON.stringify({ root, known, priority: PRIORITY })}\n`);
    proc.stdin.end();
    let buf = "", dirty = 0;
    const reader = proc.stdout.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.listing) { for (const p of r.listing) live.add(prefix + p); this.state.total = (this.state.total ?? 0) + r.listing.length; continue; }
        this.seen.set(prefix + r.path, { mtime: r.mtime, size: r.size, dois: r.dois, head: r.head });
        this.state.done++;
        if (++dirty % 200 === 0) { await this.save(); this.link(this.entries); }
      }
    }
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n").pop() ?? "";
      throw new Error(`Could not read ${host}:${root} (${err || "connection failed"})`);
    }
  }

  /** Read any new or changed PDFs under the folders. Runs in the background; safe to call again. */
  async scan(folders?: string[]) {
    if (folders) this.folders = folders.map((f) => (PdfLibrary.remote(f) ? f : resolve(f.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))));
    if (this.state.scanning) return;
    this.state = { scanning: true, done: 0, error: "", total: 0 };
    try {
      const files: string[] = [];
      const walk = async (dir: string, depth: number) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (e.name.startsWith(".")) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) { if (depth < 6 && e.name !== "node_modules") await walk(p, depth + 1); }
          else if (/\.pdf$/i.test(e.name)) files.push(p);
        }
      };
      const live = new Set<string>();
      for (const f of this.folders) if (!PdfLibrary.remote(f)) await walk(f, 0);
      for (const f of files) live.add(f);
      for (const f of this.folders) { const r = PdfLibrary.remote(f); if (r) await this.scanRemote(r.host, r.path, live); }
      for (const p of [...this.seen.keys()]) if (!live.has(p)) this.seen.delete(p);
      let dirty = 0;
      const one = async (p: string) => {
        const st = await stat(p).catch(() => null);
        this.state.done++;
        if (!st || st.size < 2000) return;
        const had = this.seen.get(p);
        if (had && had.dois && had.mtime === st.mtimeMs && had.size === st.size) return;
        // an iCloud file that is not on this Mac is skipped: reading it would download it and use disk space
        if (st.blocks === 0) return;
        const proc = Bun.spawn(["pdftotext", "-l", "2", "-q", p, "-"], { stdout: "pipe", stderr: "ignore" });
        const kill = setTimeout(() => proc.kill(), 15_000);
        const text = (await new Response(proc.stdout).text()).slice(0, 6000);
        clearTimeout(kill);
        const dois = [...new Set([...text.matchAll(DOI)].map((m) => m[0].replace(/[.,;)\]]+$/, "").toLowerCase()))].slice(0, 6);
        this.seen.set(p, { mtime: st.mtimeMs, size: st.size, dois, head: norm(text).slice(0, 2500) });
        if (++dirty % 200 === 0) { await this.save(); this.link(this.entries); }
      };
      this.state.total = files.length;
      for (let i = 0; i < files.length; i += 6) await Promise.all(files.slice(i, i + 6).map(one)); // six at a time
      await this.save();
      this.link(this.entries);
    } catch (e) { this.state.error = (e as Error).message; }
    this.state.scanning = false;
  }
}
