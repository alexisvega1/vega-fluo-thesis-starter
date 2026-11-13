#!/usr/bin/env bun
// Whole-draft passes for Margin.
//   bun passes.ts abstracts [--limit N]     fetch missing abstracts from PubMed (free, no API key)
//   bun passes.ts prepare <pass|all>        build the requests and print a cost estimate (free)
//   bun passes.ts submit <pass> --yes       send to the Batch API (this is the step that spends credit)
//   bun passes.ts collect <pass>            fetch results when the batch has finished
//   bun passes.ts status
// Passes: cite-audit (does each cited paper support its sentence), claims (every paragraph checked
// against the library), cards (a one-line claim for each paper that has an abstract).
import { join } from "node:path";
import { loadConfig } from "./src/config";
import { Index } from "./src/index";
import { PASSES, collect, estimate, load, prepare, save, submit, type PassName } from "./src/passes";
import { abstractsFor, pmidsForDois } from "./src/pubmed";

const skip = new Set(["--config", "--model", "--limit"].flatMap((f) => { const i = process.argv.indexOf(f); return i === -1 ? [] : [i, i + 1]; }));
const [cmd, arg] = process.argv.filter((_, i) => i >= 2 && !skip.has(i));
const flag = (name: string) => process.argv.includes(name);
const cfg = await loadConfig();
// --model <judge id or model name>: run a pass on a different (for example cheaper) Claude model
const want = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "";
if (want) {
  const j = cfg.judges?.find((x) => x.provider === "anthropic" && (x.id === want || x.model === want));
  cfg.cloud = { provider: "anthropic", model: j?.model ?? want, effort: j ? j.effort : cfg.cloud?.effort };
}
const build = async () => {
  const lib = await Index.build([...cfg.sources, join(cfg.project, "papers")], { pdfCache: join(cfg.cacheDir, "pdftext"), quiet: [join(cfg.project, "papers")] });
  const own = await Index.build([cfg.project], { bibOnly: true });
  lib.linkPapers([...own.keys.values(), ...lib.keys.values()]);
  return { lib, own };
};
const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const which = (a?: string): PassName[] => (a === "all" ? PASSES : PASSES.includes(a as PassName) ? [a as PassName] : (console.error(`Name a pass: ${PASSES.join(", ")}, or all`), process.exit(1)));

async function mapIds() {
  const ids = new Set<string>();
  if (!cfg.knowledgeMap) return ids;
  const f = Bun.file(join(cfg.knowledgeMap, "citation_graph.json"));
  if (await f.exists()) for (const n of ((await f.json()) as any).nodes) { ids.add(n.id); if (n.doi) ids.add(String(n.doi).toLowerCase()); }
  return ids;
}

try {
if (cmd === "abstracts") {
  const { lib, own } = await build();
  const seen = new Set<string>();
  const need = [...own.keys.values(), ...lib.keys.values()].filter((e) => !e.abstract && (e.pmid || e.doi) && !seen.has(e.key) && seen.add(e.key));
  const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || need.length;
  const todo = need.slice(0, limit);
  console.log(`${need.length} references have no abstract but do have a DOI or PMID; looking up ${todo.length} on PubMed.`);
  const byDoi = await pmidsForDois(todo.filter((e) => !e.pmid && e.doi).map((e) => e.doi), (n) => process.stdout.write(`\r  DOI lookups: ${n}`));
  const pmidOf = (e: (typeof todo)[number]) => e.pmid || byDoi.get(e.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim()) || "";
  const abs = await abstractsFor([...new Set(todo.map(pmidOf).filter(Boolean))], (n) => process.stdout.write(`\r  abstracts fetched for: ${n}        `));
  const found: Record<string, string> = {};
  for (const e of todo) { const a = abs.get(pmidOf(e)); if (a) found[e.key] = a; }
  for (const root of [...cfg.sources, cfg.project]) {
    const f = Bun.file(join(root, "abstracts.json"));
    await Bun.write(f, JSON.stringify({ ...((await f.exists()) ? await f.json() : {}), ...found }, null, 1));
  }
  console.log(`\nSaved ${Object.keys(found).length} abstracts (${todo.length - Object.keys(found).length} not on PubMed or without an abstract there). Restart Margin to use them.`);
} else if (cmd === "prepare") {
  const { lib, own } = await build();
  const ids = await mapIds();
  let low = 0, high = 0;
  for (const pass of which(arg)) {
    const p = await prepare(pass, cfg, lib, own, ids);
    await save(cfg, p);
    const e = estimate(p);
    low += e.low; high += e.high;
    console.log(`${pass.padEnd(11)} ${String(e.requests).padStart(5)} requests, about ${(e.inputTokens / 1000).toFixed(0)}k input tokens on ${p.model}: ${e.known ? `${money(e.low)} to ${money(e.high)} at batch prices` : "price unknown for this model"}${p.skipped.length ? `  (${p.skipped.length} skipped: no abstract, or nothing related in the library)` : ""}`);
    if (pass === "cite-audit") { const none = Object.values(p.meta).reduce((n: number, m: any) => n + m.noAbstract.length, 0); if (none) console.log(`            ${none} cited papers have no abstract yet and can only come back "cannot tell"; run: bun passes.ts abstracts`); }
  }
  console.log(`Estimate only: output length, which includes the model's reasoning, is the unknown. Total ${money(low)} to ${money(high)}. Nothing has been sent.`);
} else if (cmd === "submit") {
  if (!flag("--yes")) { console.error("This sends the prepared requests to the Batch API and spends credit. Add --yes to confirm."); process.exit(1); }
  for (const pass of which(arg)) console.log(`${pass}: submitted as ${(await submit(cfg, pass)).join(", ")}. Run "bun passes.ts collect ${pass}" later (most batches finish within an hour).`);
} else if (cmd === "collect") {
  for (const pass of which(arg)) {
    const r = await collect(cfg, pass);
    if (!r.done) { console.log(`${pass}: still ${r.status} (${JSON.stringify(r.counts)})`); continue; }
    console.log(`${pass}: ${JSON.stringify(r.counts)}`);
    const out = join(cfg.project, ".margin", "passes", `${pass}.report.md`);
    let md = `# ${pass} — ${new Date().toISOString().slice(0, 10)}\n\n`;
    if (pass === "cite-audit") {
      const rows = r.items.flatMap((it: any) => (it.data ?? []).map((v: any) => ({ ...v, file: it.file, line: it.line, sentence: it.sentence })));
      const tally = rows.reduce((m: Record<string, number>, v: any) => ((m[v.verdict] = (m[v.verdict] ?? 0) + 1), m), {});
      md += `${rows.length} citations judged: ${JSON.stringify(tally)}\n\n`;
      for (const v of rows.filter((x: any) => x.verdict !== "supports")) md += `- **${v.verdict}** \`${v.key}\` at ${v.file}:${v.line} — ${v.reason}\n  > ${v.sentence}\n`;
      console.log(`  ${JSON.stringify(tally)}; problems are now listed in Margin's Checks tab.`);
    } else if (pass === "claims") {
      for (const it of r.items as any[]) for (const c of it.data ?? []) if (c.verdict !== "supported") md += `- **${c.verdict}** at ${it.file}:${it.line} — ${c.claim}${c.note ? ` (${c.note})` : ""}\n`;
    } else {
      const claims: Record<string, string> = {};
      for (const it of r.items as any[]) if (it.data?.claim) claims[it.key] = it.data.claim;
      for (const root of cfg.sources) { const f = Bun.file(join(root, "claims.json")); await Bun.write(f, JSON.stringify({ ...((await f.exists()) ? await f.json() : {}), ...claims }, null, 1)); }
      md += `${Object.keys(claims).length} claim cards written to claims.json in the library.\n`;
    }
    await Bun.write(out, md);
    console.log(`  report: ${out}`);
  }
} else if (cmd === "status") {
  for (const pass of PASSES) {
    const [req, b, res] = await Promise.all([load(cfg, pass, "requests"), load(cfg, pass, "batch"), load(cfg, pass, "results")]);
    console.log(`${pass.padEnd(11)} prepared: ${req ? req.requests.length + " requests" : "no"} | submitted: ${b ? new Date(b.submittedAt).toLocaleString() : "no"} | collected: ${res ? JSON.stringify(res.counts) : "no"}`);
  }
} else {
  console.log("Usage: bun passes.ts abstracts | prepare <pass|all> | submit <pass> --yes | collect <pass> | status");
}
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
