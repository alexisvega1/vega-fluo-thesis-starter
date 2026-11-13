import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import page from "./web/index.html";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PdfLibrary } from "./src/pdflib";
import { placeComments } from "./src/importcomments";
import { textHash } from "./web/merge";
import { CommandCheck, commandsDefined, commandsUsed } from "./src/texcommands";
import { escapeHrefs, linkAllTitles, linkTitle } from "./src/biblink";
import { ensureStubs, updateChapterRefs, withRefsInput, type ChapterRefsResult } from "./src/chapterrefs";
import { loadSpelling, saveSpelling, spellCheck, suggest, validWord, type SpellStore } from "./src/spell";
import { loadConfig } from "./src/config";
import { Index } from "./src/index";
import { chatOnce, chatStream, llmStatus, type Msg } from "./src/llm";
import { shape } from "./src/shape";
import { CODE_LANG, Project, citedKeys } from "./src/project";
import { buildPdf } from "./src/build";
import type { BibEntry } from "./src/bib";
import { Google } from "./src/google";
import { readDocx } from "./src/docxreview";
import { importReview, type Round } from "./src/roundtrip";
import { LiveSync, type SourceMark } from "./src/livesync";
import { dictatedCitations, type CiteEntry } from "./src/dictcite";
import { Push } from "./src/push";
import { DEFAULTS as PROGRESS_DEFAULTS, add as addProgress, addStone, park, unpark, dueReminder, markReminded, summary as progressSummary, type Level, type Progress } from "./src/progress";
import { fromBase } from "./web/review-model";
import { proseToHtml, renderProse, inlineText } from "./src/texprose";
import { FIGURE_EXT, addFigure, figureLatex, listFigures, syncFigures, thumbnail } from "./src/figures";
import { dictationStatus, transcribe, transcribeLive } from "./src/dictate";
import { abstractOf, searchPubmed, summaries, toBibtex, pmidsForDois, abstractsFor } from "./src/pubmed";
import { extname } from "node:path";
import { cloudOnce, cloudStatus } from "./src/cloud";
import { backupNow, backupStatus } from "./src/backup";
import { findInPdf, findInSource, pageImage, pdfPages } from "./src/pdfsync";
import { forward as syncForward, loadSynctex, projectInputs, reverse as syncReverse } from "./src/synctex";
import { SECOND_OPINION_SYSTEM, VERIFY_SYSTEM } from "./src/prompts";
import { importZip, zipProject } from "./src/zip";
import { REGISTRY_HOSTS, cslToBibtex, fetchCsl, parseDoi } from "./src/doi";

const cfg = await loadConfig();
const project = await Project.open(cfg.project, join(import.meta.dir, "template"));
// the wider library: references, notes, data, and any PDFs of papers (including those dropped into <project>/papers)
const papersDir = join(cfg.project, "papers");
const buildLib = () => Index.build([...cfg.sources, papersDir], { pdfCache: join(cfg.cacheDir, "pdftext"), quiet: [papersDir] });
const buildOwn = () => Index.build([cfg.project], { bibOnly: true }); // the dissertation's own .bib
let lib = await buildLib();
let own = await buildOwn();
const link = () => lib.linkPapers([...own.keys.values(), ...lib.keys.values()]);
link();
console.log(`[index] ${lib.keys.size} library references, ${lib.chunks.docs.length} passages from ${lib.files} files in ${lib.ms} ms`);
console.log(`[project] ${cfg.project} (${own.keys.size} entries in its bibliography)`);

const google = new Google({ ...cfg.google, redirect: `http://127.0.0.1:${cfg.port}/api/google/callback` });
/** Figure/section numbers from the last build, so a reviewer reads "Fig. 2.5", not a label. */
let auxCache = { at: 0, map: new Map<string, string>() };
function refLabel(key: string): string | undefined {
  const f = join(cfg.project, ".build", "main.aux");
  try {
    const at = statSync(f).mtimeMs;
    if (at !== auxCache.at) {
      const map = new Map<string, string>();
      for (const m of readFileSync(f, "utf8").matchAll(/\\newlabel\{([^}]*)\}\{\{([^}]*)\}/g)) map.set(m[1], m[2]);
      auxCache = { at, map };
    }
  } catch { return undefined; }
  return auxCache.map.get(key) || undefined;
}
const citeLabel = (k: string) => { const e = own.keys.get(k) ?? lib.keys.get(k); return e ? `${e.authors} ${e.year}`.trim() : k; };
let lastPdf: string | null = null; // the most recent successful build
/** The built PDF: this run's latest build, else whatever a previous run left in .build. */
async function currentPdf(): Promise<string | null> {
  const rel = lastPdf ?? `.build/${((await analyze()).root ?? "main.tex").replace(/\.tex$/, ".pdf")}`;
  const abs = join(cfg.project, rel);
  return (await Bun.file(abs).exists()) ? abs : null;
}
const hasKey = (k: string) => own.keys.has(k) || lib.keys.has(k);
const commands = new CommandCheck(cfg.project, join(cfg.cacheDir, "texcommands.json"));
await commands.load();
let definedHere = new Set<string>();
const analyze = async () => {
  const a = await project.analyze((k) => own.keys.has(k), (k) => lib.keys.has(k), (n) => !definedHere.has(n) && commands.status(n) === false);
  // look for names TeX has not been asked about yet (in the background; the next analysis shows the result)
  const used = new Set<string>(), defined = new Set<string>();
  for (const f of a.files) {
    if (!f.linked || !f.path.endsWith(".tex")) continue;
    const t = await Bun.file(join(cfg.project, f.path)).text().catch(() => "");
    for (const n of commandsUsed(t)) used.add(n);
    for (const n of commandsDefined(t)) defined.add(n);
  }
  for (const n of await commands.packageDefined()) defined.add(n);
  // the class and any local packages may define commands only inside a block (\acro inside \acronyms{...})
  for (const rel of (await project.tree()).filter((p) => /\.(cls|sty)$/.test(p)))
    for (const n of commandsDefined(await Bun.file(join(cfg.project, rel)).text().catch(() => ""))) defined.add(n);
  definedHere = defined;
  if (a.root) commands.ask(a.root, await Bun.file(join(cfg.project, a.root)).text().catch(() => ""), [...used].filter((n) => !defined.has(n)), () => {});
  return a;
};

/** Reference search across the library and the project's own bibliography, best first, no duplicates. */
function searchRefs(q: string, k: number) {
  const seen = new Set<string>();
  return [...own.searchRefs(q, k), ...lib.searchRefs(q, k)]
    .sort((a, b) => b.score - a.score)
    .filter((h) => !seen.has(h.doc.key) && seen.add(h.doc.key))
    .slice(0, k);
}
function cite(q: string): BibEntry[] {
  const out = new Map<string, BibEntry>();
  for (const e of [...own.cite(q), ...lib.cite(q)]) if (!out.has(e.key)) out.set(e.key, e);
  return [...out.values()].slice(0, 14);
}

/** Copy library entries into the project's .bib the first time a .tex file cites them. */
async function syncBib(tex: string): Promise<string[]> {
  const missing = [...new Set(tex.split("\n").flatMap(citedKeys))].filter((k) => !own.keys.has(k) && lib.keys.has(k));
  if (!missing.length) return [];
  const { bibFile } = await analyze();
  const abs = project.resolve(bibFile);
  if (!abs) return [];
  const f = Bun.file(abs);
  const current = (await f.exists()) ? await f.text() : "";
  // titles become links to the paper, as in the rest of the bibliography
  await Bun.write(abs, current.replace(/\s*$/, "\n\n") + missing.map((k) => linkTitle(escapeHrefs(lib.keys.get(k)!.raw))).join("\n\n") + "\n");
  own = await buildOwn();
  link();
  return missing;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);

/** Retrieve what the author's own library says about `query`, as numbered sources for a prompt. */
/** `roomy` sends whole abstracts and longer passages: right for a cloud model, too much for the small local one. */
function gather(query: string, nRefs: number, nChunks: number, roomy = false) {
  const sources: { id: string; label: string; body: string }[] = [];
  for (const h of searchRefs(query, nRefs)) {
    const e = h.doc;
    sources.push({ id: `ref:${e.key}`, label: `${e.authors} ${e.year}`.trim(), body: `[@${e.key}] ${e.authors} (${e.year}). ${e.title}. ${clip(e.abstract, roomy ? 2400 : 320)}` });
  }
  for (const h of lib.searchChunks(query, nChunks)) {
    const c = h.doc;
    // a passage from a matched PDF is citable evidence for that paper
    sources.push(c.cite
      ? { id: `ref:${c.cite}`, label: `${citeLabel(c.cite)}, ${c.heading}`, body: `[@${c.cite}] full text, ${c.heading}: ${clip(c.text, roomy ? 1400 : 420)}` }
      : { id: `doc:${c.id}`, label: c.path, body: `(${c.path}${c.heading ? " › " + c.heading : ""}) ${clip(c.text, roomy ? 1400 : 360)}` });
  }
  return sources;
}

// ---------- request guard ----------
// The server only listens on loopback, but a web page open in the same browser can still aim
// requests at localhost. Refuse anything that is not this app talking to itself:
//  - Host must be our own (blocks DNS rebinding)
//  - Origin / Sec-Fetch-Site must be same-origin (blocks cross-site requests, including "simple" POSTs)
const HOSTS = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
type Handler = (req: Request) => Response | Promise<Response>;
// From your phone: `tailscale serve` (tailnet only, HTTPS) forwards to this loopback port and says who is
// asking. Only your own tailnet login is let in, and only for the Mac's own tailnet name.
const REMOTE = cfg.remote;
const viaTailnet = (req: Request) => !!REMOTE && req.headers.get("tailscale-user-login") === REMOTE.user;
const guard = (handler: Handler, sameSiteOnly = true): Handler => async (req) => {
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const host = req.headers.get("host") ?? "";
  const remote = viaTailnet(req);
  const hostOk = HOSTS.has(host) || (remote && host === REMOTE!.host);
  const originOk = !origin || ORIGINS.has(origin) || (remote && origin === `https://${REMOTE!.host}`);
  if (!hostOk || (sameSiteOnly && (!originOk || (site && site !== "same-origin" && site !== "none"))))
    return new Response("Forbidden", { status: 403 });
  const res = await handler(req);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cross-origin-resource-policy", "same-origin");
  res.headers.set("cache-control", res.headers.get("cache-control") ?? "no-store");
  return res;
};
function secure(routes: Record<string, any>) {
  for (const [path, v] of Object.entries(routes)) {
    if (path === "/") continue; // the page itself; every API call it makes is guarded
    // Google sends the browser back here from its own site, so this one route cannot demand same-origin.
    // It is protected instead by the single-use `state` and the PKCE verifier, and it only ever reads a code.
    if (path === "/api/google/callback") { routes[path] = guard(v, false); continue; }
    routes[path] = typeof v === "function" ? guard(v) : Object.fromEntries(Object.entries(v).map(([m, fn]) => [m, guard(fn as Handler)]));
  }
  return routes;
}

interface Judge { id: string; label: string; provider: "local" | "anthropic" | "openai"; model: string; effort?: any; ready: boolean; reason: string }

/** Every model that can judge arguments and claims: whatever is installed locally, plus the configured cloud ones. */
async function judgeList(): Promise<Judge[]> {
  const out: Judge[] = [];
  const st = await llmStatus(cfg.llm);
  const bare = (m: string) => m.replace(/:latest$/, "");
  let local = [bare(cfg.llm.model)];
  try {
    const r = await fetch(`${cfg.llm.baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    local = [...new Set([...local, ...(((await r.json()) as any).data ?? []).map((m: any) => bare(String(m.id)))])];
  } catch { /* offline: only the configured one is listed */ }
  for (const m of local) out.push({ id: `local:${m}`, label: `${m} (on your machines, free)`, provider: "local", model: m, ready: st.ok, reason: st.ok ? "" : st.error });
  for (const j of cfg.judges ?? (cfg.cloud ? [{ id: "cloud", ...cfg.cloud }] : [])) {
    const s = await cloudStatus(j);
    out.push({ id: j.id, label: (j as any).label ?? j.model, provider: j.provider, model: j.model, effort: j.effort, ready: s.ready, reason: s.reason });
  }
  return out;
}

/** Which judge a request means: a named one, else the old cloud switch, else the default local model. */
async function resolveJudge(id?: string, cloud?: boolean): Promise<Judge> {
  const all = await judgeList();
  return all.find((j) => j.id === id) ?? (cloud ? all.find((j) => j.provider !== "local") : undefined) ?? all[0]!;
}

/** One judgment call on the chosen model. Cloud models are only ever reached through here. */
async function judge(j: Judge, system: string, user: string, max_tokens: number, temperature: number, signal: AbortSignal) {
  if (!j.ready) throw new Error(j.reason || `${j.label} is not available`);
  if (j.provider === "local")
    return { text: await chatOnce({ ...cfg.llm, model: j.model }, [{ role: "system", content: system }, { role: "user", content: user }], { max_tokens, temperature }, signal), by: j.model, cloud: false };
  const r = await cloudOnce({ provider: j.provider, model: j.model, effort: j.effort }, system, user, signal);
  return { text: r.text.replace(/^```(?:json)?\s*|\s*```$/g, ""), by: r.model, cloud: true };
}

/** The citation graph from the knowledge map, slimmed down for the side panel; re-read when the file changes. */
let mapCache: { mtime: number; body: unknown } | null = null;
async function knowledgeMap() {
  if (!cfg.knowledgeMap) return { generated: "", labels: {}, nodes: [], edges: [] };
  const file = Bun.file(join(cfg.knowledgeMap, "citation_graph.json"));
  if (!(await file.exists())) return { generated: "", labels: {}, nodes: [], edges: [], error: `No citation_graph.json in ${cfg.knowledgeMap}` };
  if (mapCache && mapCache.mtime === file.lastModified) return mapCache.body;
  const g = (await file.json()) as { generated?: string; nodes: any[]; edges: { source: string; target: string }[] };
  const at = new Map(g.nodes.map((n, i) => [n.id, i]));
  const topics = Bun.file(join(cfg.knowledgeMap, "map.json"));
  const labels = (await topics.exists()) ? Object.fromEntries(((await topics.json()) as any[]).map((t) => [t.id, t.title])) : {};
  const body = {
    generated: g.generated ?? "",
    labels,
    nodes: g.nodes.map((n) => ({ id: n.id, short: n.short ?? n.id, title: n.title ?? "", year: n.year ?? 0, review: !!n.is_review, tags: n.nodes ?? [], indeg: n.indeg ?? 0, claim: n.claim ?? "", pmid: n.pmid ?? "" })),
    edges: g.edges.map((e) => [at.get(e.source), at.get(e.target)]).filter(([a, b]) => a !== undefined && b !== undefined),
  };
  mapCache = { mtime: file.lastModified, body };
  return body;
}

// ---------- disagreement log ----------
// Whenever two models judge the same claim differently, both verdicts and both rationales are kept,
// exactly as given, so the author can decide who was right. Nothing is filtered or tidied.
interface Opinion { model: string; verdict: string; note: string; sources: string[] }
interface Dispute { id: string; ts: number; file: string; line: number; paragraph: string; claim: string; a: Opinion; b: Opinion; ruling: "a" | "b" | "neither" | "both" | null; comment: string; ruledAt?: number }
const disputesFile = () => join(cfg.project, ".margin", "disagreements.json");
async function loadDisputes(): Promise<Dispute[]> {
  const f = Bun.file(disputesFile());
  return (await f.exists()) ? await f.json() : [];
}
async function saveDisputes(list: Dispute[]) {
  await mkdir(dirname(disputesFile()), { recursive: true });
  await Bun.write(disputesFile(), JSON.stringify(list, null, 1));
  // a plain-text copy that can be read anywhere
  const word = (r: Dispute["ruling"], d: Dispute) => (r === "a" ? `${d.a.model} was right` : r === "b" ? `${d.b.model} was right` : r === "neither" ? "neither was right" : r === "both" ? "both had a point" : "not yet ruled");
  const md = `# Where the models disagreed\n\n${list.length} entries. Verdicts and reasons are the models' own words.\n\n` + list.map((d) =>
    `## ${new Date(d.ts).toISOString().slice(0, 16).replace("T", " ")} — ${d.file}:${d.line}\n\n**Claim:** ${d.claim}\n\n- **${d.a.model}: ${d.a.verdict}** — ${d.a.note || "(no reason given)"}${d.a.sources.length ? ` [${d.a.sources.join("; ")}]` : ""}\n- **${d.b.model}: ${d.b.verdict}** — ${d.b.note || "(no reason given)"}${d.b.sources.length ? ` [${d.b.sources.join("; ")}]` : ""}\n\n**Your ruling:** ${word(d.ruling, d)}${d.comment ? ` — ${d.comment}` : ""}\n\n> ${d.paragraph}\n`).join("\n");
  await Bun.write(join(cfg.project, ".margin", "disagreements.md"), md);
}
const disputeId = (claim: string, a: string, b: string) => { let h = 0x811c9dc5; for (const ch of `${claim.toLowerCase().replace(/\W+/g, " ").trim()}|${[a, b].sort().join("|")}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return "d" + h.toString(16).padStart(8, "0"); };

// ---------- snapshots ----------
// Every file Margin saves also gets timestamped copies under .margin/history, so an accidental
// deletion, a bad paste or a wrong "reject all" can be undone long after the editor's own undo is gone.
// A copy is kept when the text differs from the newest snapshot and that one is at least five minutes old
// (always for the first save after the server starts). The newest 300 per file are kept.
const historyDir = (rel: string) => join(cfg.project, ".margin", "history", rel);
const snapshotAt = new Map<string, number>();
async function snapshot(rel: string, previous: string | null, force = false) {
  if (previous === null || !previous.trim()) return;
  const last = snapshotAt.get(rel) ?? 0;
  if (!force && Date.now() - last < 5 * 60_000) return;
  const dir = historyDir(rel);
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".txt")).sort();
  const newest = names.length ? await Bun.file(join(dir, names[names.length - 1]!)).text() : null;
  snapshotAt.set(rel, Date.now());
  if (newest === previous) return;
  await Bun.write(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`), previous);
  for (const old of names.slice(0, Math.max(0, names.length + 1 - 300))) await rm(join(dir, old), { force: true });
}

/** Review rounds sent to Google Docs for a file. */
const roundsPath = (rel: string | null) => (project.resolve(rel) ? join(cfg.project, ".margin", "gdocs", `${rel}.json`) : null);
async function loadRounds(rel: string | null): Promise<Round[]> {
  const p = roundsPath(rel);
  const f = p ? Bun.file(p) : null;
  return f && (await f.exists()) ? await f.json() : [];
}
async function saveRounds(rel: string, rounds: Round[]) {
  const p = roundsPath(rel)!;
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, JSON.stringify(rounds));
}
const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where a file's suggestions and comments are kept: beside the project, never inside the .tex. */
const reviewPath = (rel: string | null) => (project.resolve(rel) ? join(cfg.project, ".margin", "review", `${rel}.json`) : null);

/** Bring a Google Doc's suggestions, comments and direct edits into the file's Review sidecar. */
async function pullRound(path: string, round: Round) {
  const abs = project.resolve(path)!;
  const reviewed = await readDocx(await google.exportDocx(round.docId));
  const got = importReview(round, reviewed, await Bun.file(abs).text());
  // Many "direct edits" at once means the doc's text never matched what was sent (a conversion
  // difference), not that someone typed hundreds of changes: keep the real suggestions and comments only.
  const direct = (x: { author: string }) => x.author === "Google Docs (direct edit)";
  const nDirect = got.suggestions.filter(direct).length + got.comments.filter(direct).length;
  let warning = "";
  if (nDirect > 25) {
    got.suggestions = got.suggestions.filter((x) => !direct(x));
    got.comments = got.comments.filter((x) => !direct(x));
    warning = `Skipped ${nDirect} untracked differences between the doc and the chapter (likely formatting). Suggestions and comments were still brought in.`;
  }
  const rp = reviewPath(path)!;
  const f = Bun.file(rp);
  const side = (await f.exists()) ? await f.json() : { version: 1, suggestions: [], comments: [], orphans: [] };
  const known = new Set<string>([...round.seen, ...side.suggestions.map((x: any) => x.id), ...side.comments.map((x: any) => x.id)]);
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const mirrored = new Set(Object.values(round.mirror ?? {}).map((m) => norm(m.content)));
  const suggestions = got.suggestions.filter((x) => !known.has(x.id));
  const comments = got.comments.filter((x) => !known.has(x.id) && !mirrored.has(norm(x.text))); // our own, posted from here
  // The doc is the record for its own suggestions: one still pending here that the doc no longer has
  // (typed further, withdrawn, accepted or rejected there) is replaced by what the doc has now.
  const current = new Set(got.suggestions.map((x) => x.id));
  const stale = new Set<string>(side.suggestions.filter((x: any) => round.seen.includes(x.id) && !current.has(x.id)).map((x: any) => x.id));
  if (stale.size) { side.suggestions = side.suggestions.filter((x: any) => !stale.has(x.id)); round.seen = round.seen.filter((id) => !stale.has(id)); }
  // and where it sits follows the doc too (the chapter may have moved, or placement improved)
  const byId = new Map(got.suggestions.map((x) => [x.id, x]));
  let moved = 0;
  for (const x of side.suggestions as any[]) {
    const g = byId.get(x.id) as any;
    if (!g || !round.seen.includes(x.id)) continue;
    for (const k of ["at", "from", "to", "before", "text"]) if (g[k] !== undefined && g[k] !== x[k]) { x[k] = g[k]; moved++; }
  }
  if (suggestions.length || comments.length || stale.size || moved) {
    side.suggestions.push(...suggestions);
    side.comments.push(...comments);
    await mkdir(dirname(rp), { recursive: true });
    await Bun.write(rp, JSON.stringify(side, null, 1));
  }
  round.seen.push(...suggestions.map((x) => x.id), ...comments.map((x) => x.id));
  round.pulledAt = Date.now();
  return { warning, removed: stale.size, suggestions: suggestions.length, comments: comments.length, unplaced: comments.filter((c) => c.text.startsWith("Could not be placed")).length, trackedFound: reviewed.tracked.length };
}

/** Your own pending suggestions and notes on a chapter, as the live doc shows them. */
async function ownView(path: string): Promise<{ tex: string; marks: SourceMark[] }> {
  const file = await Bun.file(project.resolve(path)!).text();
  const f = Bun.file(reviewPath(path)!);
  if (!(await f.exists())) return { tex: file, marks: [] };
  let side: any;
  try { side = await f.json(); } catch { return { tex: file, marks: [] }; }
  const fromDoc = new Set((await loadRounds(path)).flatMap((r) => r.seen));
  const mine = (x: any) => x.author === cfg.user.name && !fromDoc.has(x.id);
  // every suggestion made in Vega Fluo (whatever name it carries, e.g. typing that continues one from the doc)
  const sugg = (side.suggestions ?? []).filter((x: any) => !fromDoc.has(x.id)) as any[];
  const ins = sugg.filter((x) => x.type === "ins" && x.at >= 0 && x.at <= file.length).sort((a, b) => a.at - b.at);
  const dels = sugg.filter((x) => x.type === "del" && x.from >= 0 && x.to <= file.length && file.slice(x.from, x.to) === x.text);
  const shift = (pos: number, incl: boolean) => pos + ins.reduce((n, i) => n + (i.at < pos || (incl && i.at === pos) ? i.text.length : 0), 0);
  let tex = "", at = 0;
  const marks: SourceMark[] = [];
  const when = (ts: number) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const read = (t: string) => inlineText(t, citeLabel, refLabel);
  for (const i of ins) {
    tex += file.slice(at, i.at);
    marks.push({ id: i.id, kind: "ins", s0: tex.length, s1: tex.length + i.text.length, content: `Suggested addition (from Vega Fluo, ${when(i.ts)}): “${read(i.text)}”`, replies: [], resolved: false });
    tex += i.text; at = i.at;
  }
  tex += file.slice(at);
  for (const d of dels) marks.push({ id: d.id, kind: "del", s0: shift(d.from, true), s1: shift(d.to, false), content: `Suggested deletion (from Vega Fluo, ${when(d.ts)}): “${read(d.text)}”`, replies: [], resolved: false });
  for (const c of (side.comments ?? []).filter(mine)) {
    if (!(c.from >= 0 && c.to <= file.length)) continue;
    marks.push({ id: c.id, kind: "note", s0: shift(c.from, false), s1: Math.max(shift(c.from, false), shift(c.to, false)), content: c.text, replies: (c.replies ?? []).map((r: any) => (r.author === cfg.user.name ? r.text : `${r.author}: ${r.text}`)), resolved: !!c.resolved });
  }
  return { tex, marks };
}

// ---------- daily writing progress (kept in the app's own .cache, not in the thesis repo) ----------
const progressFile = cfg.progressFile;
let progressCache: Progress | null = null;
async function loadProgress(): Promise<Progress> {
  if (progressCache) return progressCache;
  const f = Bun.file(progressFile);
  const p = (await f.exists()) ? ((await f.json().catch(() => null)) as Progress | null) : null;
  progressCache = { stones: p?.stones ?? [], parked: p?.parked ?? [], days: p?.days ?? {}, settings: { ...PROGRESS_DEFAULTS, ...(p?.settings ?? {}), goals: { ...PROGRESS_DEFAULTS.goals, ...(p?.settings?.goals ?? {}) } }, reminded: p?.reminded ?? {} };
  return progressCache;
}
let progressSaving: Promise<unknown> = Promise.resolve();
function saveProgress() {
  progressSaving = progressSaving.then(async () => { await mkdir(dirname(progressFile), { recursive: true }); await Bun.write(progressFile, JSON.stringify(progressCache)); }).catch(() => {});
  return progressSaving;
}
/**
 * A macOS notification with Vega Fluo's own name and icon: a tiny app (.cache/Vega Fluo.app, built by
 * tools/build-notifier.sh) opens, posts it, and quits. Only while this server runs; nothing runs in the background.
 */
const notifierApp = join(import.meta.dir, ".cache", "Vega Fluo.app");
const push = new Push(join(import.meta.dir, ".cache"));
async function notify(text: string, subtitle = "") {
  push.send(subtitle ? `Vega Fluo · ${subtitle}` : "Vega Fluo", text).catch(() => {}); // your phone, if it asked for reminders
  if (!(await Bun.file(join(notifierApp, "Contents", "Info.plist")).exists()))
    await Bun.spawn(["zsh", join(import.meta.dir, "tools", "build-notifier.sh")], { stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.write(join(import.meta.dir, ".cache", "notify.txt"), subtitle ? `${subtitle}\n${text}` : text);
  Bun.spawn(["open", "-g", "-n", notifierApp], { stdout: "ignore", stderr: "ignore" });
}
setInterval(async () => {
  const p = await loadProgress();
  const r = dueReminder(p);
  if (!r) return;
  markReminded(p, r.slots);
  await saveProgress();
  notify(r.text);
}, 60_000);

const live = new LiveSync({
  getDoc: (id) => google.getDoc(id),
  batchUpdate: (id, reqs, rev) => google.batchUpdate(id, reqs, rev),
  // what the live doc shows: the file plus your own pending insertions (your deletions stay visible, struck through)
  read: async (path) => (await ownView(path)).tex,
  marks: async (path) => (await ownView(path)).marks,
  comments: { addComment: (d, c, q) => google.addComment(d, c, q), editComment: (d, i, c) => google.editComment(d, i, c), deleteComment: (d, i) => google.deleteComment(d, i), addReply: (d, i, c, a) => google.addReply(d, i, c, a) },
  prose: (tex) => renderProse(tex, citeLabel, refLabel),
  load: loadRounds,
  save: saveRounds,
  pull: pullRound,
  livePaths: async () => {
    const dir = join(cfg.project, ".margin", "gdocs"), out: string[] = [];
    try {
      for await (const f of new Bun.Glob("**/*.tex.json").scan({ cwd: dir })) {
        const rel = f.replace(/\.json$/, "");
        if ((await loadRounds(rel)).some((r) => r.live)) out.push(rel);
      }
    } catch { /* nothing sent yet */ }
    return out;
  },
});
project.onWrite = (rel) => live.touched(rel);
live.start();

const COMPLETE_SYSTEM = `You are the autocomplete inside a scientist's thesis editor. Continue the author's TEXT from exactly where it stops.
Rules:
- Output only the continuation: at most one sentence, under 30 words. No preamble, no quotes, do not repeat the text.
- Match the author's voice and tense. Start with a space if one is needed.
- Use only facts found in SOURCES or already in TEXT. Never invent a number, statistic, p-value, or finding.
- Cite only with keys that appear in SOURCES. If unsure, do not cite.`;
const CITE_FORM = {
  md: "This is Markdown: cite as [@key].",
  tex: "This is LaTeX: cite as \\citep{key} (or \\citet{key} when the authors are the subject). Write plain LaTeX, no Markdown.",
};

const ARGUE_SYSTEM = `You help a scientist find arguments while drafting a thesis. You get the PARAGRAPH being written and numbered SOURCES drawn from the author's own references and notes.
Propose up to 4 points the author could make next:
- "support": evidence in SOURCES that backs a claim in the paragraph
- "counter": a limitation or alternative explanation in SOURCES the author should address
- "gap": a claim in the paragraph that none of the SOURCES back
Every "support" and "counter" must list the source numbers it relies on. Do not state any number, statistic or finding that is not in SOURCES. One sentence each.
Reply with a JSON array and nothing else: [{"type":"support","text":"...","sources":[1,3]}]`;

const BOOT = Date.now();

// ---------- the PDF collection: which file is which reference ----------
const pdfs = new PdfLibrary(join(cfg.cacheDir, "pdf-library.json"));
const allEntries = () => [...new Map([...lib.keys.values(), ...own.keys.values()].map((e) => [e.key, e])).values()];
await pdfs.load();
pdfs.link(allEntries());
if (pdfs.folders.length) pdfs.scan().then(() => pdfs.link(allEntries())); // pick up new files, in the background
/** The chapter files main.tex includes (those with a \\chapter), with their text. */
async function chapterTexts(a: Awaited<ReturnType<typeof analyze>>) {
  const out: { path: string; text: string }[] = [];
  for (const f of a.files) {
    if (!f.linked || !f.path.endsWith(".tex") || f.path === a.root) continue;
    const text = await Bun.file(join(cfg.project, f.path)).text().catch(() => "");
    if (/^\s*\\chapter\*?\{/m.test(text)) out.push({ path: f.path, text });
  }
  return out;
}
const entryFor = (key: string) => own.keys.get(key) ?? lib.keys.get(key) ?? null;
/** PDFs you attached to a reference by hand live in thesis/papers/attached/<key>.pdf and win over the index. */
const attachedDir = join(cfg.project, "papers", "attached");
const attachedPath = (key: string) => join(attachedDir, `${key.replace(/[^\w.:-]+/g, "_")}.pdf`);
/** Quick check for lists (no disk access for the index; attached PDFs are checked by name). */
const hasPdf = (key: string) => pdfs.has(key) || existsSync(attachedPath(key));
async function pdfPathFor(key: string) {
  const own = attachedPath(key);
  return (await Bun.file(own).exists()) ? own : pdfs.pathFor(key);
}

// ---------- spelling: what counts as a known word beyond the English dictionary ----------
let spelling: SpellStore = await loadSpelling(cfg.project);
let names: Set<string> | null = null;
let terms = new Set<string>();
/** Author surnames from the bibliography and library, and the dictation vocabulary: never flagged. */
async function knownNames() {
  if (names) return names;
  const set = new Set<string>();
  for (const idx of [own, lib]) for (const e of idx.keys.values()) {
    const a = /author\s*=\s*[{"]([^\n]*)/i.exec((e as any).raw ?? "")?.[1] ?? (e as any).authors ?? "";
    for (const w of a.matchAll(/[A-Za-z\u00C0-\u024F]{3,}/g)) set.add(w[0].toLowerCase());
  }
  const vocab = await Bun.file(cfg.dictation.vocabulary).text().catch(() => "");
  terms = new Set([...vocab.replace(/#.*/g, "").matchAll(/[A-Za-z\u00C0-\u024F]{3,}/g)].map((w) => w[0].toLowerCase()));
  return (names = set);
}

// The local model is reached through an SSH tunnel that the launcher opens. Tunnels die (sleep, Wi-Fi
// changes); when the model stops answering, reopen it rather than waiting for the next `margin` run.
let lastHeal = 0;
async function modelStatus() {
  let st = await llmStatus(cfg.llm);
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(cfg.llm.baseUrl ?? "");
  if (st.ok || !m || Date.now() - lastHeal < 60_000) return st;
  lastHeal = Date.now();
  for (const host of ["neversleeps", "gpu2"]) {
    const p = Bun.spawn(["ssh", "-f", "-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `${m[1]}:localhost:${m[1]}`, host], { stdout: "ignore", stderr: "ignore" });
    if ((await p.exited) !== 0) continue;
    st = await llmStatus(cfg.llm);
    if (st.ok) { console.log(`[model] tunnel reopened to ${host}`); break; }
  }
  return st;
}
const server = Bun.serve({
  port: cfg.port,
  hostname: "127.0.0.1", // local only
  idleTimeout: 255, // seconds; a PDF build or a slow local model can take far longer than the 10 s default
  development: process.env.NODE_ENV !== "production",
  routes: secure({
    "/": page,
    /** Recorded typing sounds: only a known folder and a numbered .wav are ever read. */
    "/sounds/:pack/:file": async (req: Request & { params: { pack: string; file: string } }) => {
      const { pack, file } = req.params;
      if (!/^click\d{1,2}$/.test(pack) || !/^\d{1,2}\.wav$/.test(file)) return new Response("not found", { status: 404 });
      const f = Bun.file(join(import.meta.dir, "sounds", pack, file));
      return (await f.exists()) ? new Response(f, { headers: { "content-type": "audio/wav", "cache-control": "max-age=86400" } }) : new Response("not found", { status: 404 });
    },

    "/api/status": async () =>
      json({ boot: BOOT, refs: lib.keys.size, projectRefs: own.keys.size, passages: lib.chunks.docs.length, files: lib.files, indexMs: lib.ms, sources: cfg.sources, project: cfg.project, user: cfg.user.name, papers: lib.papers.length, backup: await backupStatus(cfg.project), dictation: await dictationStatus(cfg.dictation), cloud: await cloudStatus(cfg.cloud), judges: await judgeList(), llm: await modelStatus() }),

    "/api/keys": () => json({ project: [...own.keys.keys()], library: [...lib.keys.keys()] }),

    "/api/reindex": {
      POST: async () => {
        [lib, own] = await Promise.all([buildLib(), buildOwn()]);
        names = null;
        pdfs.link(allEntries());
        link();
        return json({ refs: lib.keys.size, passages: lib.chunks.docs.length, files: lib.files, indexMs: lib.ms });
      },
    },

    /** Files, outline, labels, word counts and problems for the whole dissertation. */
    "/api/project": async () => {
      const a = await analyze();
      // findings from the last citation-fit pass, if one has been collected
      const f = Bun.file(join(cfg.project, ".margin", "passes", "cite-audit.results.json"));
      if (await f.exists()) {
        const r = (await f.json()) as { items: { file: string; line: number; data?: { key: string; verdict: string; reason: string }[] }[] };
        for (const it of r.items) for (const v of it.data ?? [])
          if (v.verdict === "does_not" || v.verdict === "partly")
            a.issues.push({ severity: "warn", kind: "citation-fit", message: `${v.key} ${v.verdict === "does_not" ? "does not appear to support" : "only partly supports"} this sentence: ${v.reason}`, file: it.file, line: it.line });
      }
      return json({ tree: await project.tree(), ...a });
    },

    "/api/file/hash": async (req) => {
      const abs = project.resolve(new URL(req.url).searchParams.get("path"));
      if (!abs || !(await Bun.file(abs).exists())) return json({ hash: null });
      const rp = reviewPath(new URL(req.url).searchParams.get("path"));
      const review = rp && (await Bun.file(rp).exists()) ? textHash(JSON.stringify(await Bun.file(rp).json().catch(() => null))) : null;
      return json({ hash: textHash(await Bun.file(abs).text()), review });
    },
    "/api/file": {
      GET: async (req) => {
        const abs = project.resolve(new URL(req.url).searchParams.get("path"));
        if (!abs) return json({ error: "bad path" }, 400);
        const f = Bun.file(abs);
        return (await f.exists()) ? new Response(await f.text(), { headers: { "content-type": "text/plain; charset=utf-8" } }) : json({ error: "not found" }, 404);
      },
      PUT: async (req) => {
        const rel = new URL(req.url).searchParams.get("path");
        const text = await req.text();
        const abs = project.resolve(rel);
        if (!rel || !abs) return json({ error: "bad path" }, 400);
        // keep what was there before it is replaced
        const before = (await Bun.file(abs).exists()) ? await Bun.file(abs).text() : null;
        // the tab says which version it started from; if the file changed since (another tab, or Vega
        // Fluo adding to it), refuse and hand back what is on disk so the tab can merge instead of overwrite
        const baseHash = req.headers.get("x-base-hash");
        if (baseHash && before !== null && textHash(before) !== baseHash && before !== text) return json({ error: "changed", disk: before }, 409);
        if (before !== text) await snapshot(rel, before, new URL(req.url).searchParams.get("snapshot") === "1");
        if (!(await project.write(rel, text))) return json({ error: "bad path" }, 400);
        let added: string[] = [];
        if (rel.endsWith(".bib")) { own = await buildOwn(); link(); }
        else if (rel.endsWith(".tex")) added = await syncBib(text);
        return json({ ok: true, added });
      },
    },

    "/api/review": {
      GET: async (req) => {
        const p = reviewPath(new URL(req.url).searchParams.get("path"));
        if (!p) return json({ error: "bad path" }, 400);
        const f = Bun.file(p);
        return json((await f.exists()) ? await f.json() : { version: 1, suggestions: [], comments: [], orphans: [] });
      },
      PUT: async (req) => {
        const p = reviewPath(new URL(req.url).searchParams.get("path"));
        const body = await req.text();
        if (!p || body.length > 2_000_000) return json({ error: "bad request" }, 400);
        let data: any;
        try { data = JSON.parse(body); } catch { return json({ error: "not JSON" }, 400); }
        if (data?.version !== 1 || !Array.isArray(data.suggestions) || !Array.isArray(data.comments)) return json({ error: "bad shape" }, 400);
        // same guard as for the text: comments added elsewhere (an import, another tab) are not overwritten
        const baseHash = req.headers.get("x-base-hash");
        const onDisk = (await Bun.file(p).exists()) ? await Bun.file(p).json().catch(() => null) : null;
        if (baseHash && onDisk && textHash(JSON.stringify(onDisk)) !== baseHash) return json({ error: "changed", disk: onDisk }, 409);
        await mkdir(dirname(p), { recursive: true });
        await Bun.write(p, JSON.stringify(data, null, 1));
        live.touched(new URL(req.url).searchParams.get("path") ?? ""); // your own suggestions show in a live doc too
        return json({ ok: true });
      },
    },

    /**
     * Comments from a Word file (e.g. a Google Doc downloaded as .docx), placed on the matching words in
     * the thesis and added to each file's review notes. Importing the same file twice adds nothing new.
     */
    "/api/review/import": {
      POST: async (req) => {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length < 100 || bytes.length > 80_000_000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return json({ error: "That is not a Word (.docx) file" }, 400);
        let reviewed;
        try { reviewed = await readDocx(bytes); } catch (e) { return json({ error: `Could not read it: ${(e as Error).message}` }, 400); }
        const a = await analyze();
        const files = [];
        for (const f of a.files) if (f.linked && f.path.endsWith(".tex") && f.path !== a.root) files.push({ path: f.path, src: await Bun.file(join(cfg.project, f.path)).text() });
        const { placed, unplaced } = placeComments(reviewed, files);
        let added = 0;
        for (const path of new Set(placed.map((x) => x.file))) {
          const rp = reviewPath(path)!;
          const side = (await Bun.file(rp).exists()) ? await Bun.file(rp).json() : { version: 1, suggestions: [], comments: [], orphans: [] };
          const have = new Set((side.comments ?? []).map((c: any) => c.id));
          for (const c of placed.filter((x) => x.file === path)) {
            const id = `imp-${Bun.hash(`${c.author}|${c.ts}|${c.text}`).toString(36)}`;
            if (have.has(id)) continue;
            side.comments.push({ id, author: c.author, ts: c.ts, from: c.from, to: c.to, quote: c.quote, text: c.text, resolved: false, replies: c.replies });
            added++;
          }
          await mkdir(dirname(rp), { recursive: true });
          await Bun.write(rp, JSON.stringify(side, null, 1));
        }
        return json({ comments: reviewed.comments.length, threads: placed.length + unplaced.filter((u) => u.context !== "(reply)").length, added, placed: placed.map((x) => ({ file: x.file, how: x.how, author: x.author, text: x.text.slice(0, 120), quote: x.quote.slice(0, 80), replies: x.replies.length })), unplaced });
      },
    },

    /** A long, ranked list of references for the section being written (or a search). */
    "/api/library": {
      POST: async (req) => {
        const { text = "", k = 40 } = (await req.json()) as { text?: string; k?: number };
        const seen = new Set<string>();
        const entries = text.trim()
          ? [...own.rankRefs(text, k), ...lib.rankRefs(text, k)].sort((a, b) => b.score - a.score).map((h) => h.doc)
          : [...own.keys.values(), ...lib.keys.values()];
        const refs = entries.filter((e) => !seen.has(e.key) && seen.add(e.key)).slice(0, k);
        const total = new Set([...own.keys.keys(), ...lib.keys.keys()]).size;
        return json({ total, refs: refs.map((e) => ({ key: e.key, title: e.title, authors: e.authors, year: e.year, journal: e.journal, inProject: own.keys.has(e.key), hasPdf: hasPdf(e.key) })) });
      },
    },

    // ---------- figures ----------
    "/api/figures": async () => json({ figures: await listFigures(cfg.project), manifest: await Bun.file(join(cfg.project, "figures.json")).exists() }),
    "/api/figure": {
      PUT: async (req) => {
        const name = new URL(req.url).searchParams.get("name") ?? "";
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.length || bytes.length > 150_000_000) return json({ error: "Empty file or larger than 150 MB" }, 400);
        if (new URL(req.url).searchParams.get("companion") === "1") {
          const clean = name.split(/[\\/]/).pop()!.replace(/[^\w.\- ()]+/g, "-");
          if (!/\.(png|jpe?g|gif|webp|tiff?)$/i.test(clean)) return json({ error: "not an image" }, 400);
          await mkdir(join(cfg.project, "figures", "originals"), { recursive: true });
          await Bun.write(join(cfg.project, "figures", "originals", clean), bytes);
          return json({ ok: true, companion: clean });
        }
        try {
          const fig = await addFigure(cfg.project, name, bytes);
          return json({ ...fig, latex: figureLatex(fig.file, fig.id) });
        } catch (e) { return json({ error: (e as Error).message }, 400); }
      },
    },
    "/api/figure/thumb": async (req) => {
      const q = new URL(req.url).searchParams;
      const t = await thumbnail(cfg.project, q.get("file") ?? "", q.get("size") === "large");
      return t ? new Response(Bun.file(t), { headers: { "content-type": "image/png" } }) : new Response("no preview", { status: 404 });
    },
    "/api/figures/sync": { POST: async () => json(await syncFigures(cfg.project)) },

    // ---------- code listings ----------
    "/api/code": {
      PUT: async (req) => {
        const name = (new URL(req.url).searchParams.get("name") ?? "").split(/[\\/]/).pop()!.replace(/[^\w.\-]+/g, "-").replace(/^[.\-]+/, "");
        const ext = extname(name).toLowerCase();
        if (!(ext in CODE_LANG)) return json({ error: `${ext || "That file type"} is not a code format Margin prints` }, 400);
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.length || bytes.length > 2_000_000) return json({ error: "Empty file or larger than 2 MB" }, 400);
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return json({ error: "That file is not plain text" }, 400); }
        await mkdir(join(cfg.project, "code"), { recursive: true });
        await Bun.write(join(cfg.project, "code", name), text);
        const id = name.slice(0, -ext.length).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return json({ file: `code/${name}`, lines: text.split("\n").length, latex: `\\codefile[${CODE_LANG[ext]}]{code/${name}}{}{prog:${id}}\n` });
      },
    },

    // ---------- papers as PDFs ----------
    /** Everything known about one reference, for the paper viewer. The abstract is fetched from PubMed only if it is missing. */
    "/api/paper/info": async (req) => {
      const key = new URL(req.url).searchParams.get("key") ?? "";
      const e = entryFor(key);
      if (!e) return json({ error: "No such reference" }, 404);
      let abstract = e.abstract, pmid = e.pmid;
      if (!abstract && new URL(req.url).searchParams.get("fetch") === "1") {
        try {
          if (!pmid && e.doi) pmid = (await pmidsForDois([e.doi])).get(e.doi) ?? "";
          if (pmid) abstract = (await abstractsFor([pmid])).get(pmid) ?? "";
        } catch { /* offline: show what we have */ }
      }
      return json({ key, title: e.title, authors: e.authors, year: e.year, journal: e.journal, doi: e.doi, pmid, abstract, hasPdf: !!(await pdfPathFor(key)), inProject: own.keys.has(key) });
    },
    /** The PDF for a reference. Only files the index matched to a reference can be read, never a path from the page. */
    "/api/paper/pdf": async (req) => {
      const path = await pdfPathFor(new URL(req.url).searchParams.get("key") ?? "");
      const remote = path ? PdfLibrary.remote(path) : null;
      if (remote) { // stream it from the machine that holds it; the path goes over stdin, never through a shell
        const p = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", remote.host, `IFS= read -r p; exec cat -- "$p"`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        p.stdin.write(remote.path + "\n"); p.stdin.end();
        return new Response(p.stdout, { headers: { "content-type": "application/pdf", "content-disposition": "inline", "cache-control": "max-age=3600" } });
      }
      const f = path ? Bun.file(path) : null;
      return f && (await f.exists()) ? new Response(f, { headers: { "content-type": "application/pdf", "content-disposition": "inline", "cache-control": "no-store" } }) : new Response("no PDF for this reference", { status: 404 });
    },
    /** Attach a PDF to a reference by hand (dropped on the paper pane). */
    "/api/paper/attach": {
      PUT: async (req) => {
        const key = new URL(req.url).searchParams.get("key") ?? "";
        if (!entryFor(key)) return json({ error: "No such reference" }, 404);
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return json({ error: "That file is not a PDF" }, 400);
        if (bytes.length > 150_000_000) return json({ error: "Larger than 150 MB" }, 400);
        await mkdir(attachedDir, { recursive: true });
        await Bun.write(attachedPath(key), bytes);
        return json({ ok: true });
      },
    },
    /** Turn every unlinked title in the thesis bibliography into a link to its paper. */
    "/api/bib/link-titles": {
      POST: async () => {
        const { bibFile } = await analyze();
        const abs = project.resolve(bibFile);
        if (!abs || !(await Bun.file(abs).exists())) return json({ error: "No bibliography file" }, 404);
        const before = await Bun.file(abs).text(), { text, linked, escaped } = linkAllTitles(before);
        if (linked || escaped) { await snapshot(bibFile, before); await Bun.write(abs, text); own = await buildOwn(); link(); }
        return json({ linked, escaped, file: bibFile });
      },
    },
    /** Thesis styles: files in styles/, chosen by the \\input{styles/...} line in main.tex. */
    "/api/styles": {
      GET: async () => {
        const names = (await readdir(join(cfg.project, "styles")).catch(() => [] as string[])).filter((f) => f.endsWith(".tex")).map((f) => f.slice(0, -4)).sort();
        const root = (await analyze()).root ?? "main.tex";
        const main = await Bun.file(join(cfg.project, root)).text().catch(() => "");
        const current = /^\s*\\input\{styles\/([\w-]+)\}/m.exec(main)?.[1] ?? null;
        const figures = /^\s*\\figureversion\{(text|clean)\}/m.exec(main)?.[1] ?? null;
        const about = Object.fromEntries(await Promise.all(names.map(async (n) => [n, ((await Bun.file(join(cfg.project, "styles", `${n}.tex`)).text()).match(/^% Thesis style: (.*)$/m)?.[1] ?? "").trim()])));
        return json({ names, current, root, about, figures });
      },
      /** Switch style in main.tex (only when main.tex is not open in the editor; otherwise the editor does it). */
      POST: async (req) => {
        const { name = "" } = (await req.json()) as { name?: string };
        if (!/^[\w-]+$/.test(name) || !(await Bun.file(join(cfg.project, "styles", `${name}.tex`)).exists())) return json({ error: "No such style" }, 400);
        const root = (await analyze()).root ?? "main.tex";
        const main = await Bun.file(join(cfg.project, root)).text();
        const next = main.replace(/^(\s*)\\input\{styles\/[\w-]+\}/m, `$1\\input{styles/${name}}`);
        if (next === main && !/\\input\{styles\//.test(main)) return json({ error: "main.tex has no style line" }, 400);
        if (next !== main) { await snapshot(root, main); await project.write(root, next); }
        return json({ ok: true });
      },
    },
    /** Figures with their statistics text, or the clean versions (\figureversion line in main.tex; main.tex not open). */
    "/api/figure-version": {
      POST: async (req) => {
        const { version = "" } = (await req.json()) as { version?: string };
        if (version !== "text" && version !== "clean") return json({ error: "text or clean" }, 400);
        const root = (await analyze()).root ?? "main.tex";
        const main = await Bun.file(join(cfg.project, root)).text();
        if (!/^\s*\\figureversion\{/m.test(main)) return json({ error: "main.tex has no \\figureversion line" }, 400);
        const next = main.replace(/^(\s*)\\figureversion\{\w*\}/m, `$1\\figureversion{${version}}`);
        if (next !== main) { await snapshot(root, main); await project.write(root, next); }
        return json({ ok: true });
      },
    },
    "/api/pdf-library": {
      GET: () => json(pdfs.status()),
      POST: async (req) => {
        const { folders = [] } = (await req.json()) as { folders?: string[] };
        const list = folders.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()).slice(0, 8);
        for (const f of list) {
          if (PdfLibrary.remote(f)) continue; // checked when it is read
          const st = await stat(resolve(f.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))).catch(() => null);
          if (!st?.isDirectory()) return json({ error: `Not a folder: ${f}` }, 400);
        }
        pdfs.link(allEntries());
        pdfs.scan(list); // keeps going after this answer; poll GET for progress
        return json(pdfs.status());
      },
    },
    "/api/papers": () => json(lib.papers.map(({ path, pages, doi, cite }) => ({ path, pages, doi, cite, label: cite ? citeLabel(cite) : "" }))),
    "/api/paper": {
      PUT: async (req) => {
        const name = (new URL(req.url).searchParams.get("name") ?? "").split(/[\\/]/).pop()!.replace(/[^\w.\- ()]+/g, "-");
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!/\.pdf$/i.test(name) || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return json({ error: "Only PDF files can be added as papers" }, 400);
        if (bytes.length > 150_000_000) return json({ error: "Larger than 150 MB" }, 400);
        await mkdir(papersDir, { recursive: true });
        await Bun.write(join(papersDir, name), bytes);
        lib = await buildLib();
        link();
        const paper = lib.papers.find((p) => p.path === name);
        return json({ ok: true, indexed: !!paper, pages: paper?.pages ?? 0, cite: paper?.cite ?? null, doi: paper?.doi ?? "" });
      },
    },

    // ---------- dictation ----------
    "/api/spell": {
      POST: async (req) => {
        const { text = "", lang = "tex" } = (await req.json()) as { text?: string; lang?: string };
        if (typeof text !== "string" || text.length > 3_000_000) return json({ error: "too long" }, 400);
        const extra = await knownNames(), mine = new Set(spelling.words.map((w) => w.toLowerCase()));
        // a surname only excuses a capitalised word: "Teh" the author must not hide "teh" the typo
        return json({ misspelled: await spellCheck(text, lang, (w, capital) => mine.has(w) || terms.has(w) || (capital && extra.has(w))), rules: spelling.rules });
      },
    },
    "/api/spell/suggest": async (req) => {
      const word = new URL(req.url).searchParams.get("word") ?? "";
      const lang = new URL(req.url).searchParams.get("lang") === "es" ? "es" : "en";
      return validWord(word) ? json({ suggestions: await suggest(word, lang) }) : json({ suggestions: [] });
    },
    /** The project's own dictionary and remembered corrections (thesis/.margin/spelling.json). */
    "/api/spell/words": {
      GET: () => json(spelling),
      POST: async (req) => {
        const b = (await req.json()) as { add?: string; remove?: string; rule?: { from: string; to: string }; unrule?: string };
        if (validWord(b.add)) spelling.words.push(b.add);
        if (validWord(b.remove)) spelling.words = spelling.words.filter((w) => w !== b.remove);
        if (b.rule && validWord(b.rule.from) && validWord(b.rule.to)) spelling.rules[b.rule.from.toLowerCase()] = b.rule.to;
        if (validWord(b.unrule)) delete spelling.rules[b.unrule.toLowerCase()];
        await saveSpelling(cfg.project, spelling);
        return json(spelling);
      },
    },
    "/api/dictate": {
      POST: async (req) => {
        const wav = new Uint8Array(await req.arrayBuffer());
        if (wav.length < 2000 || wav.length > 60_000_000) return json({ error: "Recording is empty or too long" }, 400);
        const url = new URL(req.url);
        try {
          if (url.searchParams.get("live") !== "1") return json({ text: await transcribe(wav, cfg.dictation) });
          let context = "";
          try { context = decodeURIComponent(req.headers.get("x-dictation-context") ?? "").slice(-400); } catch { /* ignore a malformed hint */ }
          return json({ text: await transcribeLive(wav, cfg.dictation, context) });
        } catch (e) { return json({ error: (e as Error).message }, 500); }
      },
    },

    // ---------- PubMed (only on an explicit search or button press) ----------
    "/api/pubmed/search": {
      POST: async (req) => {
        const { q = "" } = (await req.json()) as { q?: string };
        if (q.trim().length < 3) return json({ hits: [] });
        try {
          const hits = await searchPubmed(q.trim().slice(0, 300));
          const have = new Map([...own.keys.values(), ...lib.keys.values()].filter((e) => e.pmid || e.doi).flatMap((e) => [[e.pmid, e.key], [e.doi.toLowerCase(), e.key]] as [string, string][]));
          return json({ hits: hits.map((h) => ({ ...h, authors: h.authors.slice(0, 3).join(", ") + (h.authors.length > 3 ? " et al." : ""), key: have.get(h.pmid) ?? (h.doi ? have.get(h.doi.toLowerCase()) : undefined) ?? null })) });
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },
    "/api/pubmed/add": {
      POST: async (req) => {
        const { pmid = "" } = (await req.json()) as { pmid?: string };
        if (!/^\d{1,9}$/.test(pmid)) return json({ error: "bad PMID" }, 400);
        try {
          const [hit] = await summaries([pmid]);
          if (!hit) return json({ error: "PubMed has no record with that PMID" }, 404);
          const { key, bib } = toBibtex(hit, await abstractOf(pmid), hasKey);
          const abs = project.resolve((await analyze()).bibFile);
          if (!abs) return json({ error: "No bibliography file" }, 400);
          const f = Bun.file(abs);
          await Bun.write(abs, ((await f.exists()) ? await f.text() : "").replace(/\s*$/, "\n\n") + bib + "\n");
          own = await buildOwn();
          link();
          return json({ ok: true, key });
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },

    /** Add a reference by DOI: CSL-JSON from doi.org, one BibTeX entry appended to the project's .bib. */
    "/api/doi/add": {
      POST: async (req) => {
        const { doi: raw = "" } = (await req.json().catch(() => ({}))) as { doi?: string };
        const doi = parseDoi(String(raw));
        if (!doi) return json({ error: "That is not a DOI. A DOI looks like 10.1038/nature14539." }, 400);
        const have = [...own.keys.values()].find((e) => e.doi && e.doi.toLowerCase() === doi.toLowerCase());
        if (have) return json({ ok: true, key: have.key, existing: true });
        try {
          // already in the wider library: copy that entry, as citing it would (no network)
          const inLib = [...lib.keys.values()].find((e) => e.doi && e.doi.toLowerCase() === doi.toLowerCase());
          let key: string, bib: string;
          if (inLib) ({ key, bib } = { key: inLib.key, bib: linkTitle(escapeHrefs(inLib.raw)) });
          else {
            const csl = await fetchCsl(doi, cfg.doi.followRegistry ? REGISTRY_HOSTS : []);
            if (!csl || typeof csl !== "object" || (!csl.title && !csl.author)) return json({ error: "doi.org returned no usable citation data for that DOI." }, 502);
            ({ key, bib } = cslToBibtex(csl, doi, hasKey));
          }
          const abs = project.resolve((await analyze()).bibFile);
          if (!abs) return json({ error: "No bibliography file" }, 400);
          const f = Bun.file(abs);
          const before = (await f.exists()) ? await f.text() : "";
          await snapshot(relative(cfg.project, abs), before);
          await Bun.write(abs, before.replace(/\s*$/, "\n\n") + bib + "\n");
          own = await buildOwn();
          link();
          return json({ ok: true, key, bib });
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },
    /** The project as a zip Overleaf can open: sources, .bib, class/style files and figures; no build output, editor state or dotfiles. */
    "/api/export/overleaf.zip": async () => {
      const { zip } = await zipProject(cfg.project);
      const name = (cfg.project.split("/").filter(Boolean).pop() ?? "thesis").replace(/[^\w.-]+/g, "-");
      return new Response(zip, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}-overleaf.zip"` } });
    },
    /** An Overleaf download, unpacked into a NEW folder beside the project. The open project is never touched. */
    "/api/import/overleaf": {
      POST: async (req) => {
        const name = new URL(req.url).searchParams.get("name") ?? "overleaf-import";
        const buf = new Uint8Array(await req.arrayBuffer());
        if (!buf.length) return json({ error: "No file was sent." }, 400);
        try {
          const r = await importZip(buf, cfg.project, name);
          return json({ ok: true, dir: r.dir, files: r.files.length });
        } catch (e) { return json({ error: (e as Error).message }, 400); }
      },
    },

    /** Check each claim in a paragraph against the library; a verdict without a source is never reported as support. */
    "/api/verify": {
      POST: async (req) => {
        const body = (await req.json()) as { text?: string; cloud?: boolean; judge?: string; second?: string; file?: string; line?: number };
        const text = body.text ?? "";
        const who = await resolveJudge(body.judge, body.cloud);
        const other = body.second ? (await judgeList()).find((j) => j.id === body.second && j.id !== who.id) : undefined;
        const cloud = who.provider !== "local" || (!!other && other.provider !== "local");
        if (text.trim().length < 40) return json({ claims: [], note: "Write a little more first." });
        const sources = gather(text, cloud ? 10 : 6, cloud ? 10 : 8, cloud);
        if (!sources.length) return json({ claims: [], note: "Nothing in your library relates to this paragraph, so there is nothing to check it against." });
        const sourceText = `SOURCES:\n${sources.map((s, i) => `${i + 1}. ${s.body}`).join("\n")}`;
        /** A verdict only counts as support or contradiction if it points at a real source. */
        const settle = (x: any) => {
          const cited = (Array.isArray(x?.sources) ? x.sources : []).map((n: unknown) => sources[Number(n) - 1]).filter(Boolean).map((s: (typeof sources)[number]) => ({ id: s.id, label: s.label }));
          const said = ["supported", "contradicted"].includes(x?.verdict) ? x.verdict : "unsupported";
          return { verdict: cited.length ? said : "unsupported", sources: cited, note: typeof x?.note === "string" ? x.note : "" };
        };
        let out: string, by: string;
        try {
          const r = await judge(who, VERIFY_SYSTEM, `${sourceText}\n\nPARAGRAPH:\n${text.slice(-3000)}`, 900, 0.1, req.signal);
          out = r.text; by = r.by;
        } catch (e) { return json({ claims: [], error: (e as Error).message }, 502); }
        let parsed: any[] = [];
        try { parsed = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)); } catch { return json({ claims: [], error: "The model did not return a usable list." }, 502); }
        const claims: any[] = parsed.filter((x) => x && typeof x.claim === "string").slice(0, 12).map((x) => ({ claim: String(x.claim), ...settle(x) }));

        // Second opinion: a different model judges the same claims against the same sources, without
        // seeing the first model's verdicts. Agreement raises confidence; disagreement marks the claim for you.
        let secondBy = "", secondError = "";
        if (other && claims.length) {
          try {
            const r = await judge(other, SECOND_OPINION_SYSTEM, `${sourceText}\n\nCLAIMS:\n${claims.map((c, i) => `${i + 1}. ${c.claim}`).join("\n")}`, 900, 0.1, req.signal);
            secondBy = r.by;
            const list = JSON.parse(r.text.slice(r.text.indexOf("["), r.text.lastIndexOf("]") + 1)) as any[];
            claims.forEach((c, i) => {
              const hit = list.find((x) => Number(x?.n) === i + 1) ?? list[i];
              if (!hit) return;
              c.second = settle(hit);
              c.agree = c.second.verdict === c.verdict;
            });
          } catch (e) { secondError = `The second opinion failed: ${(e as Error).message}`; }
        }
        // keep every disagreement, with both rationales, for the author to review
        let logged = 0;
        const split = claims.filter((c) => c.second && !c.agree);
        if (split.length) {
          const list = await loadDisputes();
          for (const c of split) {
            const id = disputeId(c.claim, by, secondBy);
            const entry: Dispute = {
              id, ts: Date.now(), file: body.file ?? "", line: body.line ?? 0, paragraph: clip(text.trim(), 700), claim: c.claim,
              a: { model: by, verdict: c.verdict, note: c.note, sources: c.sources.map((x: any) => x.label) },
              b: { model: secondBy, verdict: c.second.verdict, note: c.second.note, sources: c.second.sources.map((x: any) => x.label) },
              ruling: null, comment: "",
            };
            const at = list.findIndex((d) => d.id === id);
            if (at === -1) { list.unshift(entry); logged++; }
            else list[at] = { ...entry, ruling: list[at]!.ruling, comment: list[at]!.comment, ruledAt: list[at]!.ruledAt }; // same claim re-checked: refresh, keep your ruling
          }
          await saveDisputes(list);
        }
        return json({ claims, by, cloud, secondBy, secondError, logged });
      },
    },

    "/api/map": async () => {
      // The map names papers "Adamantidis2007"; the bibliography may call the same paper something else.
      // Tie them together by DOI, then PMID, so a map node can be cited with the key that actually exists.
      const m = (await knowledgeMap()) as any;
      const entries = [...lib.keys.values(), ...own.keys.values()]; // project bibliography wins
      const clean = (d: string) => d.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
      const byDoi = new Map(entries.filter((e) => e.doi).map((e) => [clean(e.doi), e.key]));
      const byPmid = new Map(entries.filter((e) => e.pmid).map((e) => [e.pmid, e.key]));
      const raw = cfg.knowledgeMap ? ((await Bun.file(join(cfg.knowledgeMap, "citation_graph.json")).json().catch(() => ({ nodes: [] }))) as any).nodes : [];
      const doiOf = new Map<string, string>(raw.map((n: any) => [n.id, n.doi ?? ""]));
      return json({ ...m, nodes: m.nodes.map((n: any) => ({ ...n, key: hasKey(n.id) ? n.id : (byDoi.get(clean(doiOf.get(n.id) ?? "")) ?? byPmid.get(n.pmid) ?? null) })) });
    },

    "/api/disagreements": {
      GET: async () => {
        const list = await loadDisputes();
        // how often each model was the one you sided with, among entries you have ruled on
        const tally: Record<string, { right: number; ruled: number }> = {};
        for (const d of list) {
          if (!d.ruling) continue;
          for (const [side, o] of [["a", d.a], ["b", d.b]] as const) {
            const t = (tally[o.model] ??= { right: 0, ruled: 0 });
            t.ruled++;
            if (d.ruling === side || d.ruling === "both") t.right++;
          }
        }
        return json({ list, tally });
      },
      POST: async (req) => {
        const { id, ruling, comment } = (await req.json()) as { id?: string; ruling?: Dispute["ruling"]; comment?: string };
        const list = await loadDisputes();
        const d = list.find((x) => x.id === id);
        if (!d) return json({ error: "unknown entry" }, 404);
        if (ruling !== undefined) { d.ruling = ["a", "b", "neither", "both"].includes(ruling as string) ? ruling : null; d.ruledAt = Date.now(); }
        if (typeof comment === "string") d.comment = comment.slice(0, 2000);
        await saveDisputes(list);
        return json({ ok: true });
      },
    },

    "/api/backup": { POST: async () => json(await backupNow(cfg.project)) },

    "/api/history": {
      GET: async (req) => {
        const rel = new URL(req.url).searchParams.get("path");
        if (!project.resolve(rel)) return json({ error: "bad path" }, 400);
        const dir = historyDir(rel!);
        const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".txt")).sort().reverse();
        const list = await Promise.all(names.slice(0, 120).map(async (n) => {
          const text = await Bun.file(join(dir, n)).text();
          return { id: n, at: Date.parse(n.slice(0, -4).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, "T$1:$2:$3.$4Z")), chars: text.length, words: (text.match(/\S+/g) ?? []).length, preview: text.trim().slice(0, 160) };
        }));
        return json({ total: names.length, list });
      },
      /** Put an earlier version back. What is there now is snapshotted first, so a restore can itself be undone. */
      POST: async (req) => {
        const { path: rel, id } = (await req.json()) as { path?: string; id?: string };
        const abs = project.resolve(rel ?? null);
        if (!abs || !id || !/^[\w.\-]+\.txt$/.test(id)) return json({ error: "bad request" }, 400);
        const f = Bun.file(join(historyDir(rel!), id));
        if (!(await f.exists())) return json({ error: "no such version" }, 404);
        const old = await f.text();
        await snapshot(rel!, (await Bun.file(abs).exists()) ? await Bun.file(abs).text() : null, true);
        await project.write(rel!, old);
        if (rel!.endsWith(".bib")) { own = await buildOwn(); link(); }
        return json({ ok: true });
      },
    },

    "/api/google/status": async () => json(await google.status()),
    "/api/google/connect": {
      POST: async () => {
        try { return json({ url: await google.startAuth() }); } catch (e) { return json({ error: (e as Error).message }, 400); }
      },
    },
    "/api/google/callback": async (req) => {
      const q = new URL(req.url).searchParams;
      let ok = true, msg = "Vega Fluo is connected to Google Drive. You can close this tab.";
      try {
        if (q.get("error")) throw new Error(`Google reported: ${q.get("error")}`);
        await google.finishAuth(q.get("code") ?? "", q.get("state") ?? "");
      } catch (e) { ok = false; msg = (e as Error).message; }
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Margin</title><body style="font:16px system-ui;max-width:32rem;margin:18vh auto;padding:0 16px"><h1 style="font-size:20px">${ok ? "Connected" : "Not connected"}</h1><p>${escHtml(msg)}</p>`,
        { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } },
      );
    },
    "/api/google/disconnect": { POST: async () => { await google.disconnect(); return json({ ok: true }); } },

    /** Review rounds for a file (without the stored text). */
    "/api/share": async (req) =>
      json((await loadRounds(new URL(req.url).searchParams.get("path"))).filter((r) => !r.retired).map(({ docId, url, title, sentAt, pulledAt, seen, live: on, pushedAt, conflicts, error }) => ({ docId, url, title, sentAt, pulledAt, imported: seen.length, live: !!on, pushedAt, conflicts: conflicts ?? 0, error }))),

    /**
     * Live doc on/off for a chapter. Turning it on reuses the chapter's live doc if it has one, else
     * creates a new Google Doc (only Vega Fluo's own docs can be touched: drive.file scope). Sharing the
     * doc with anyone stays in Google's own Share dialog.
     */
    "/api/share/live": {
      POST: async (req) => {
        const { path, on, docId } = (await req.json()) as { path?: string; on?: boolean; docId?: string };
        const abs = project.resolve(path ?? null);
        if (!abs || !path!.endsWith(".tex")) return json({ error: "Only .tex files can be shared live" }, 400);
        const rounds = await loadRounds(path!);
        if (!on) { for (const r of rounds) if (!docId || r.docId === docId) r.live = false; await saveRounds(path!, rounds); return json({ ok: true }); }
        const again = rounds.find((r) => r.docId === docId) ?? rounds.find((r) => r.title.includes("— live") && !r.retired);
        try {
          if (again) {
            for (const r of rounds) r.live = r === again;
            await saveRounds(path!, rounds);
            await live.push(path!).catch(() => {}); // catch up on what was written while it was off
            return json({ ok: true, url: again.url, title: again.title });
          }
          const base = await Bun.file(abs).text();
          const prose = renderProse(base, citeLabel, refLabel);
          if (!prose.text.trim()) return json({ error: "There is no text in this file to share yet" }, 400);
          const title = `${prose.blocks.find((b) => b.kind !== "p")?.text ?? path} — live`;
          const doc = await google.createDoc(title, proseToHtml(prose, title));
          for (const r of rounds) r.live = false;
          rounds.unshift({ docId: doc.id, url: doc.url, title, sentAt: Date.now(), base, prose, seen: [], live: true });
          await saveRounds(path!, rounds);
          return json({ ok: true, url: doc.url, title });
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },
    /** Push now / pull now for the live doc (the same work the background loop does). */
    "/api/share/live/sync": {
      POST: async (req) => {
        const { path } = (await req.json()) as { path?: string };
        if (!project.resolve(path ?? null)) return json({ error: "bad path" }, 400);
        try { return json({ ok: true, push: await live.push(path!), pull: await live.poll(path!, true) }); }
        catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },

    /** Send the accepted text of a chapter to a new Google Doc as plain prose. */
    "/api/share/send": {
      POST: async (req) => {
        const { path } = (await req.json()) as { path?: string };
        const abs = project.resolve(path ?? null);
        if (!abs || !path!.endsWith(".tex")) return json({ error: "Only .tex files can be sent for review" }, 400);
        const base = await Bun.file(abs).text();
        const prose = renderProse(base, citeLabel, refLabel);
        if (!prose.text.trim()) return json({ error: "There is no text in this file to review yet" }, 400);
        const title = `${prose.blocks.find((b) => b.kind !== "p")?.text ?? path} — review ${new Date().toISOString().slice(0, 10)}`;
        try {
          const doc = await google.createDoc(title, proseToHtml(prose, title));
          const rounds = await loadRounds(path!);
          rounds.unshift({ docId: doc.id, url: doc.url, title, sentAt: Date.now(), base, prose, seen: [] });
          await saveRounds(path!, rounds);
          return json({ ok: true, url: doc.url, title });
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },

    /** Read the reviewer's suggestions and comments back and add them to the file's tracked changes. */
    "/api/share/pull": {
      POST: async (req) => {
        const { path, docId } = (await req.json()) as { path?: string; docId?: string };
        const abs = project.resolve(path ?? null);
        const rounds = await loadRounds(path ?? null);
        const round = rounds.find((r) => r.docId === docId);
        if (!abs || !round) return json({ error: "Unknown review round" }, 400);
        try {
          const got = await pullRound(path!, round);
          await saveRounds(path!, rounds);
          return json({ ok: true, ...got });
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      },
    },

    // ---------- daily progress ----------
    "/api/progress": async () => json(progressSummary(await loadProgress())),
    "/api/progress/add": {
      POST: async (req) => {
        const d = (await req.json().catch(() => ({}))) as Record<string, number>;
        const p = await loadProgress();
        const before = progressSummary(p);
        addProgress(p, d);
        await saveProgress();
        const after = progressSummary(p);
        return json({ ...after, justMet: !before.met && after.met });
      },
    },
    "/api/progress/settings": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { level?: Level; goals?: Partial<Record<Level, number>>; reminders?: string[]; remindersOn?: boolean };
        const p = await loadProgress();
        const levels: Level[] = ["easy", "normal", "push"];
        if (b.level && levels.includes(b.level)) {
          p.settings.level = b.level; // the default from now on, and today's bar
          const key = progressSummary(p).day;
          p.days[key] = { ...(p.days[key] ?? { typedChars: 0, typedMs: 0, dictatedChars: 0, dictatedMs: 0 }), level: b.level };
        }
        for (const l of levels) { const g = Number(b.goals?.[l]); if (Number.isFinite(g) && g >= 1 && g <= 50000) p.settings.goals[l] = Math.round(g); }
        if (Array.isArray(b.reminders)) p.settings.reminders = b.reminders.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 6).sort();
        if (typeof b.remindersOn === "boolean") p.settings.remindersOn = b.remindersOn;
        await saveProgress();
        return json(progressSummary(p));
      },
    },
    /** Stones (finished things) and the parking lot. */
    "/api/progress/note": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { kind?: string; text?: string; remove?: string };
        const p = await loadProgress();
        if (b.kind === "stone" && b.text) addStone(p, String(b.text));
        else if (b.kind === "park" && b.text) park(p, String(b.text));
        else if (b.kind === "park" && b.remove) unpark(p, String(b.remove));
        else return json({ error: "bad request" }, 400);
        await saveProgress();
        return json(progressSummary(p));
      },
    },
    "/api/progress/test-reminder": { POST: async () => { await notify("Reminders are on. This is what one looks like."); return json({ ok: true, devices: (await push.list()).length }); } },

    /** Citations spoken in dictated text ("Peyron et al. 1998"), matched against the bibliography and library. */
    "/api/dictate/cites": {
      POST: async (req) => {
        const { text = "" } = (await req.json().catch(() => ({}))) as { text?: string };
        if (typeof text !== "string" || text.length > 20000) return json({ error: "bad request" }, 400);
        const entries: CiteEntry[] = [...[...own.keys.values()].map((e) => ({ key: e.key, authors: e.authors, year: e.year, own: true })), ...[...lib.keys.values()].filter((e) => !own.keys.has(e.key)).map((e) => ({ key: e.key, authors: e.authors, year: e.year }))];
        return json({ edits: dictatedCitations(text, entries) });
      },
    },

    // ---------- reminders on your phone (Web Push) ----------
    "/sw.js": async () => new Response(Bun.file(join(import.meta.dir, "web", "sw.js")), { headers: { "content-type": "text/javascript; charset=utf-8", "service-worker-allowed": "/" } }),
    "/icon-180.png": async () => new Response(Bun.file(join(import.meta.dir, "web", "apple-touch-icon.png")), { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } }),
    "/manifest.webmanifest": async () =>
      new Response(JSON.stringify({ name: "Vega Fluo", short_name: "Vega Fluo", start_url: "/", scope: "/", display: "standalone", background_color: "#06080f", theme_color: "#06080f", icons: [{ src: "/icon-180.png", sizes: "180x180", type: "image/png" }, { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }] }), { headers: { "content-type": "application/manifest+json" } }),
    "/icon-192.png": async () => new Response(Bun.file(join(import.meta.dir, "web", "icon-192.png")), { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } }),
    "/icon-512.png": async () => new Response(Bun.file(join(import.meta.dir, "web", "icon-512.png")), { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } }),
    /** The Chrome extension (side panel), zipped from extension/ so another computer can fetch it over the tailnet. */
    "/vega-fluo-extension.zip": async () => {
      const out = join(import.meta.dir, ".cache", "vega-fluo-extension.zip");
      await rm(out, { force: true });
      const p = Bun.spawn(["zip", "-q", "-r", out, "."], { cwd: join(import.meta.dir, "extension"), stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) !== 0) return json({ error: "Could not package the extension" }, 500);
      return new Response(Bun.file(out), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="vega-fluo-extension.zip"' } });
    },
    "/api/push/key": async () => json({ key: await push.publicKey() }),
    "/api/push/status": async () => json({ devices: (await push.list()).map((d) => ({ label: d.label, added: d.added, endpoint: d.endpoint.slice(-12) })) }),
    "/api/push/subscribe": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { subscription?: any; label?: string };
        try { await push.add(b.subscription, String(b.label ?? "")); return json({ ok: true, devices: (await push.list()).length }); }
        catch (e) { return json({ error: (e as Error).message }, 400); }
      },
    },
    "/api/push/unsubscribe": { POST: async (req) => { const b = (await req.json().catch(() => ({}))) as { endpoint?: string }; await push.remove(String(b.endpoint ?? "")); return json({ ok: true }); } },

    "/api/build": {
      POST: async (req) => {
        const { open = [] } = (await req.json().catch(() => ({}))) as { open?: string[] };
        await syncFigures(cfg.project);
        const a = await analyze();
        const chapters = await chapterTexts(a);
        await ensureStubs(cfg.project, chapters);
        let r = await buildPdf(cfg.project, a.root);
        let refs: ChapterRefsResult = { written: [], needInput: [] };
        const bbl = join(cfg.project, ".build", `${(a.root ?? "main.tex").replace(/\.tex$/, "")}.bbl`);
        if (r.ok && (await Bun.file(bbl).exists())) {
          refs = await updateChapterRefs(cfg.project, chapters, await Bun.file(bbl).text());
          // chapters not open in the editor get the include line here; open ones are left to the editor, so nothing is overwritten
          const added: string[] = [];
          for (const path of refs.needInput) {
            if (open.includes(path)) continue;
            const c = chapters.find((x) => x.path === path)!;
            const next = withRefsInput(c.text, path);
            if (next && (await project.write(path, next))) { await snapshot(path, c.text); added.push(path); }
          }
          // a list changed, or a chapter now shows one: build again so the PDF has them (once; it settles)
          if (added.length || refs.written.some((p) => !refs.needInput.includes(p) || added.includes(p))) r = await buildPdf(cfg.project, a.root);
          refs.needInput = refs.needInput.filter((p) => !added.includes(p));
        }
        if (r.pdf) lastPdf = r.pdf;
        return json({ ...r, chapterRefs: refs });
      },
    },

    "/api/pdf": async () => {
      const f = await currentPdf();
      return f ? new Response(Bun.file(f), { headers: { "content-type": "application/pdf", "cache-control": "no-store" } }) : json({ error: "not built yet" }, 404);
    },
    "/api/pdf/info": async () => {
      const f = await currentPdf();
      if (!f) return json({ pages: 0 });
      const pages = await pdfPages(f);
      return json({ pages: pages.length, sizes: pages.map((p) => [p.w, p.h]), builtAt: Bun.file(f).lastModified });
    },
    "/api/pdf/page": async (req) => {
      const f = await currentPdf();
      const n = Number(new URL(req.url).searchParams.get("n"));
      const img = f && Number.isInteger(n) && n > 0 ? await pageImage(f, n) : null;
      return img ? new Response(Bun.file(img), { headers: { "content-type": "image/png", "cache-control": "max-age=3600" } }) : new Response("no such page", { status: 404 });
    },
    /**
     * Source to PDF. With SyncTeX (written by every build) the file and line say exactly which PDF lines they
     * produced; the words around the cursor then pick the spot within them. Without it, the words alone are used.
     */
    "/api/pdf/find": {
      POST: async (req) => {
        const { words = [], center = 0, file, line } = (await req.json()) as { words?: string[]; center?: number; file?: string; line?: number };
        const f = await currentPdf();
        if (!f) return json({ error: "Build the PDF first" }, 404);
        const text = await findInPdf(f, words.slice(0, 80), center);
        const sync = typeof file === "string" && Number.isInteger(line) && line! > 0 ? await loadSynctex(f) : null;
        if (sync) {
          const sizes = (await pdfPages(f)).map((p) => [p.w, p.h] as [number, number]);
          const spots = syncForward(sync, await projectInputs(sync, cfg.project), file!, line!, sizes);
          if (spots.length) {
            // a source line that is a whole paragraph spans several PDF lines: the words say which one
            const near = text && spots.some((s) => s.page === text.page && text.y >= s.y - 0.012 && text.y <= s.y + s.h + 0.012);
            return json(near ? { ...text, via: "synctex+text" } : { ...spots[0]!, via: "synctex" });
          }
        }
        return json(text ? { ...text, via: "text" } : { error: "Could not find that passage in the PDF. Rebuild if the text is new." });
      },
    },
    /** PDF to source: which line produced the text at this spot? SyncTeX when the build wrote it, else text matching. */
    "/api/pdf/locate": {
      POST: async (req) => {
        const { page = 1, x = 0.5, y = 0.5 } = (await req.json()) as { page?: number; x?: number; y?: number };
        const f = await currentPdf();
        if (!f) return json({ error: "Build the PDF first" }, 404);
        const sync = await loadSynctex(f);
        if (sync) {
          const size = (await pdfPages(f))[page - 1];
          const hit = size ? syncReverse(sync, await projectInputs(sync, cfg.project), page, x, y, [size.w, size.h]) : null;
          if (hit && project.resolve(hit.file)) return json({ ...hit, via: "synctex" });
        }
        const a = await analyze();
        const files = a.files.filter((x) => x.linked && x.path !== a.root).map((x) => x.path);
        const r = await findInSource(f, cfg.project, files, page, x, y);
        return json(r ? { ...r, via: "text" } : { error: "Could not match that spot to the source (front matter, a figure, or text that has changed since the build)." });
      },
    },

    "/api/cite": (req) => {
      const q = new URL(req.url).searchParams.get("q") ?? "";
      return json(cite(q).map(({ key, title, authors, year }) => ({ key, title, authors, year, inProject: own.keys.has(key) })));
    },

    /** References and passages relevant to what is being written right now. No model involved. */
    "/api/suggest": {
      POST: async (req) => {
        const { text = "" } = (await req.json()) as { text?: string };
        return json({
          refs: searchRefs(text, 6).map(({ doc: e, score }) => ({ inProject: own.keys.has(e.key), hasPdf: hasPdf(e.key), key: e.key, title: e.title, authors: e.authors, year: e.year, journal: e.journal, abstract: clip(e.abstract, 420), score })),
          evidence: lib.searchChunks(text, 6).map(({ doc: c, score }) => ({ cite: c.cite, id: c.id, path: c.path, heading: c.heading, text: clip(c.text, 700), kind: c.kind, score })),
        });
      },
    },

    /** Ghost text: streams a one-sentence continuation as plain text. */
    "/api/complete": {
      POST: async (req) => {
        const { before = "", after = "", lang = "md", section = "", outline = "" } = (await req.json()) as
          { before?: string; after?: string; lang?: "md" | "tex"; section?: string; outline?: string };
        if (before.trim().length < 12) return new Response("");
        // retrieval follows the sentence being written right now, then the paragraph, then the section
        const sentence = before.slice(-400).split(/(?<=[.!?])\s+/).pop() ?? "";
        const sources = gather(`${sentence} ${sentence} ${before.slice(-600)} ${section}`, 4, 3);
        const messages: Msg[] = [
          { role: "system", content: `${COMPLETE_SYSTEM}\n- ${CITE_FORM[lang] ?? CITE_FORM.md}\n- Stay consistent with what the author has already written: same terms, same claims, no repeating a point already made.` },
          {
            role: "user",
            content: [
              outline && `DISSERTATION OUTLINE (the author is in: ${section || "unknown"}):\n${outline.slice(0, 1500)}`,
              `SOURCES:\n${sources.map((s) => "- " + s.body).join("\n") || "(none)"}`,
              after.trim() && `TEXT AFTER THE CURSOR (already written; lead into it, do not repeat it):\n${after.slice(0, 600)}`,
              `TEXT (continue from the end):\n${before.slice(-6000)}`,
            ].filter(Boolean).join("\n\n"),
          },
        ];
        const abort = new AbortController();
        req.signal.addEventListener("abort", () => abort.abort());
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            let raw = "", sent = 0;
            const push = (final: boolean) => {
              const { text, done } = shape(raw, before, hasKey, final, lang);
              if (text.length > sent) { ctrl.enqueue(enc.encode(text.slice(sent))); sent = text.length; }
              return done;
            };
            try {
              for await (const delta of chatStream(cfg.llm, messages, { max_tokens: 64, temperature: 0.3 }, abort.signal)) {
                raw += delta;
                if (push(false)) break;
              }
              push(true);
            } catch (e) {
              if (!abort.signal.aborted) console.error("[complete]", (e as Error).message);
            } finally {
              abort.abort();
              try { ctrl.close(); } catch {}
            }
          },
          cancel() { abort.abort(); },
        });
        return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      },
    },

    /** Arguments the paragraph could make, each tied to the sources that back it. */
    "/api/arguments": {
      POST: async (req) => {
        const body = (await req.json()) as { text?: string; cloud?: boolean; judge?: string };
        const text = body.text ?? "";
        const who = await resolveJudge(body.judge, body.cloud);
        const cloud = who.provider !== "local";
        if (text.trim().length < 40) return json({ args: [], note: "Write a little more first." });
        const sources = gather(text, cloud ? 8 : 5, cloud ? 8 : 5, cloud);
        let out: string, by: string;
        try {
          const r = await judge(who, ARGUE_SYSTEM, `SOURCES:\n${sources.map((s, i) => `${i + 1}. ${s.body}`).join("\n") || "(none)"}\n\nPARAGRAPH:\n${text.slice(-2500)}`, 500, 0.4, req.signal);
          out = r.text; by = r.by;
        } catch (e) {
          return json({ args: [], error: (e as Error).message }, 502);
        }
        const a = out.indexOf("["), b = out.lastIndexOf("]");
        let parsed: any[] = [];
        try { parsed = JSON.parse(out.slice(a, b + 1)); } catch { return json({ args: [], error: "The model did not return a usable list." }, 502); }
        const args = parsed
          .filter((x) => x && typeof x.text === "string")
          .slice(0, 4)
          .map((x) => {
            const cited = (Array.isArray(x.sources) ? x.sources : [])
              .map((n: unknown) => sources[Number(n) - 1])
              .filter(Boolean)
              .map((s: (typeof sources)[number]) => ({ id: s.id, label: s.label }));
            const type = ["support", "counter", "gap"].includes(x.type) ? x.type : "support";
            // a support/counter with no valid source is not grounded in the library — say so
            return { type, text: String(x.text), sources: cited, grounded: type === "gap" || cited.length > 0 };
          });
        return json({ args, by, cloud });
      },
    },
  }),
});

console.log(`Vega Fluo (Margin) is running at ${server.url}`);

// back the thesis up every ten minutes while Margin is running (no-op when nothing changed)
setInterval(() => { backupNow(cfg.project).catch((e) => console.error("[backup]", e.message)); }, 10 * 60_000);
