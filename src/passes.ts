// Whole-draft passes that run through the Message Batches API (asynchronous, half price).
// Nothing here spends anything until `submit` is run with --yes.
import Anthropic from "@anthropic-ai/sdk";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BibEntry } from "./bib";
import type { Config } from "./config";
import type { Index } from "./index";
import { Project, citedKeys } from "./project";
import { CARD_SYSTEM, CITE_AUDIT_SYSTEM, VERIFY_SYSTEM } from "./prompts";
import { renderProse } from "./texprose";

export type PassName = "cite-audit" | "claims" | "cards";
export const PASSES: PassName[] = ["cite-audit", "claims", "cards"];

interface Req { custom_id: string; params: Record<string, unknown> }
interface Prepared { pass: PassName; model: string; requests: Req[]; meta: Record<string, any>; skipped: string[] }

/** $ per million tokens (input, output), list price as of 2026-11-03; batches are billed at half. */
const PRICE: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-fable-5-2": [8, 40] };
const tokens = (s: string) => Math.ceil(s.length / 3.6);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export interface CitedSentence { file: string; line: number; sentence: string; paragraph: string; keys: string[] }

/** Every sentence that carries a citation, with where it is. */
export function citedSentences(file: string, tex: string): CitedSentence[] {
  const out = new Map<string, CitedSentence>();
  for (const m of tex.matchAll(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]\n]*\])*\{[^}\n]*\}/g)) {
    const at = m.index!;
    if (/(^|[^\\])%[^\n]*$/.test(tex.slice(tex.lastIndexOf("\n", at) + 1, at))) continue; // inside a comment
    const p0 = Math.max(0, tex.lastIndexOf("\n\n", at) + 2), pe = tex.indexOf("\n\n", at), p1 = pe === -1 ? tex.length : pe;
    const para = tex.slice(p0, p1);
    const rel = at - p0;
    // sentence bounds: the nearest sentence end before the citation, and the first one after it
    const before = [...para.slice(0, rel).matchAll(/[.!?]["')\]}]*\s+(?=[A-Z\\])/g)].pop();
    const s0 = before ? before.index! + before[0].length : 0;
    const after = /[.!?]["')\]}]*(\s|$)/.exec(para.slice(rel + m[0].length));
    const s1 = after ? rel + m[0].length + after.index + after[0].length : para.length;
    const id = `${p0 + s0}`;
    const hit = out.get(id) ?? { file, line: tex.slice(0, p0 + s0).split("\n").length, sentence: para.slice(s0, s1).trim(), paragraph: para.trim(), keys: [] };
    for (const k of citedKeys(m[0])) if (!hit.keys.includes(k)) hit.keys.push(k);
    out.set(id, hit);
  }
  return [...out.values()];
}

export async function prepare(pass: PassName, cfg: Config, lib: Index, own: Index, mapIds: Set<string>): Promise<Prepared> {
  const model = cfg.cloud?.model ?? "claude-opus-5-5";
  const base = { model, max_tokens: 8000, ...(cfg.cloud?.effort ? { output_config: { effort: cfg.cloud.effort } } : {}) };
  const entry = (k: string): BibEntry | undefined => own.keys.get(k) ?? lib.keys.get(k);
  const out: Prepared = { pass, model, requests: [], meta: {}, skipped: [] };
  const project = new Project(cfg.project);
  const texFiles = (await project.tree()).filter((p) => p.endsWith(".tex") && p !== "main.tex" && p !== "packages.tex");

  if (pass === "cite-audit") {
    for (const file of texFiles) {
      for (const s of citedSentences(file, await Bun.file(join(cfg.project, file)).text())) {
        const papers = s.keys.map((k) => ({ k, e: entry(k) }));
        const id = `c${out.requests.length}`;
        out.meta[id] = { file: s.file, line: s.line, sentence: clip(s.sentence, 400), keys: s.keys, noAbstract: papers.filter((p) => !p.e?.abstract).map((p) => p.k) };
        out.requests.push({ custom_id: id, params: { ...base, system: CITE_AUDIT_SYSTEM, messages: [{ role: "user", content:
          `SENTENCE:\n${s.sentence}\n\nPARAGRAPH (context only):\n${clip(s.paragraph, 2500)}\n\nPAPERS:\n${papers.map(({ k, e }) =>
            e ? `[${k}] ${e.authors} (${e.year}). ${e.title}. ${e.journal}\nAbstract: ${e.abstract || "(no abstract available)"}` : `[${k}] (not found in the library)`).join("\n\n")}` }] } });
      }
    }
  } else if (pass === "claims") {
    for (const file of texFiles) {
      const tex = await Bun.file(join(cfg.project, file)).text();
      const prose = renderProse(tex, (k) => { const e = entry(k); return e ? `${e.authors} ${e.year}` : k; });
      for (const b of prose.blocks) {
        if (b.kind !== "p" || b.text.length < 200 || b.text.startsWith("[")) continue;
        const refs = [...own.searchRefs(b.text, 6), ...lib.searchRefs(b.text, 6)].sort((x, y) => y.score - x.score).slice(0, 6).map((h) => h.doc);
        const sources = [
          ...refs.map((e) => ({ label: `${e.authors} ${e.year}`, key: e.key, body: `[${e.key}] ${e.authors} (${e.year}). ${e.title}. ${clip(e.abstract, 900)}` })),
          ...lib.searchChunks(b.text, 6).map((h) => ({ label: h.doc.path, key: h.doc.cite ?? "", body: `(${h.doc.path} ${h.doc.heading}) ${clip(h.doc.text, 700)}` })),
        ];
        if (!sources.length) { out.skipped.push(`${file}: paragraph with nothing related in the library`); continue; }
        const first = prose.segs.find((s) => s.r0 >= b.r0);
        const id = `p${out.requests.length}`;
        out.meta[id] = { file, line: tex.slice(0, first?.s0 ?? 0).split("\n").length, paragraph: clip(b.text, 300), sources: sources.map((s) => ({ label: s.label, key: s.key })) };
        out.requests.push({ custom_id: id, params: { ...base, system: VERIFY_SYSTEM, messages: [{ role: "user", content: `SOURCES:\n${sources.map((s, i) => `${i + 1}. ${s.body}`).join("\n")}\n\nPARAGRAPH:\n${b.text}` }] } });
      }
    }
  } else {
    const seen = new Set<string>();
    for (const e of [...own.keys.values(), ...lib.keys.values()]) {
      const doi = e.doi.toLowerCase();
      if (seen.has(e.key) || (doi && seen.has(doi))) continue;
      seen.add(e.key); if (doi) seen.add(doi);
      if (mapIds.has(e.key) || (doi && mapIds.has(doi))) continue; // the knowledge map already has a verified card
      if (e.abstract.length < 200) { out.skipped.push(e.key); continue; }
      const id = `k${out.requests.length}`;
      out.meta[id] = { key: e.key };
      out.requests.push({ custom_id: id, params: { ...base, max_tokens: 3000, system: CARD_SYSTEM, messages: [{ role: "user", content: `TITLE: ${e.title}\nYEAR: ${e.year}\nABSTRACT: ${clip(e.abstract, 4000)}` }] } });
    }
  }
  return out;
}

/** A rough bill for a prepared pass. Output size (thinking included) is the unknown, so it is a range. */
export function estimate(p: Prepared) {
  const [pin, pout] = PRICE[p.model] ?? [0, 0];
  const input = p.requests.reduce((n, r: any) => n + tokens(r.params.system) + tokens(r.params.messages[0].content), 0);
  const cost = (outPer: number) => ((input * pin + p.requests.length * outPer * pout) / 1e6) * 0.5;
  return { requests: p.requests.length, inputTokens: input, low: cost(400), high: cost(2500), known: p.model in PRICE };
}

const dir = (cfg: Config) => join(cfg.project, ".margin", "passes");
const file = (cfg: Config, pass: PassName, kind: string) => join(dir(cfg), `${pass}.${kind}.json`);

export async function save(cfg: Config, p: Prepared) {
  await mkdir(dir(cfg), { recursive: true });
  await Bun.write(file(cfg, p.pass, "requests"), JSON.stringify(p));
}
export const load = async (cfg: Config, pass: PassName, kind: string) => {
  const f = Bun.file(file(cfg, pass, kind));
  return (await f.exists()) ? await f.json() : null;
};

export async function submit(cfg: Config, pass: PassName) {
  const p = (await load(cfg, pass, "requests")) as Prepared | null;
  if (!p?.requests.length) throw new Error(`Nothing prepared for ${pass}; run: bun passes.ts prepare ${pass}`);
  const client = new Anthropic();
  const ids: string[] = [];
  for (let i = 0; i < p.requests.length; i += 5000) { // well under the 100,000-request and 256 MB limits
    const batch = await client.messages.batches.create({ requests: p.requests.slice(i, i + 5000) as any });
    ids.push(batch.id);
  }
  await Bun.write(file(cfg, pass, "batch"), JSON.stringify({ ids, submittedAt: Date.now(), model: p.model, requests: p.requests.length }));
  return ids;
}

const parse = (text: string) => {
  const a = Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i !== -1));
  const b = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
};

/** Fetch finished results. Returns null while any batch is still processing. */
export async function collect(cfg: Config, pass: PassName) {
  const b = await load(cfg, pass, "batch");
  const p = (await load(cfg, pass, "requests")) as Prepared | null;
  if (!b || !p) throw new Error(`No submitted batch for ${pass}`);
  const client = new Anthropic();
  const counts = { succeeded: 0, errored: 0, refused: 0, unparsed: 0 };
  const results: Record<string, any> = {};
  for (const id of b.ids as string[]) {
    const batch = await client.messages.batches.retrieve(id);
    if (batch.processing_status !== "ended") return { done: false as const, status: batch.processing_status, counts: batch.request_counts };
    for await (const r of await client.messages.batches.results(id)) {
      if (r.result.type !== "succeeded") { counts.errored++; results[r.custom_id] = { error: r.result.type }; continue; }
      const msg = r.result.message;
      if (msg.stop_reason === "refusal") { counts.refused++; results[r.custom_id] = { error: "declined" }; continue; }
      const data = parse(msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""));
      if (data === null) { counts.unparsed++; results[r.custom_id] = { error: "unreadable answer" }; continue; }
      counts.succeeded++;
      results[r.custom_id] = { data };
    }
  }
  const merged = Object.entries(p.meta).map(([id, meta]) => ({ id, ...meta, ...(results[id] ?? { error: "no result" }) }));
  await Bun.write(file(cfg, pass, "results"), JSON.stringify({ pass, model: b.model, collectedAt: Date.now(), counts, items: merged }, null, 1));
  return { done: true as const, counts, items: merged };
}
