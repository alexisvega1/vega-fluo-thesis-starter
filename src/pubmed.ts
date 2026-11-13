// PubMed lookups through NCBI's public E-utilities. Only ever called for a search the author typed
// or a button they pressed; the manuscript itself is never sent.
const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const COMMON = "tool=margin-editor&retmode=json";

export interface PubmedHit { pmid: string; title: string; authors: string[]; journal: string; year: string; volume: string; pages: string; doi: string }

async function get(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`PubMed answered ${res.status}`);
  return res;
}

export async function searchPubmed(query: string, max = 12): Promise<PubmedHit[]> {
  const ids = ((await (await get(`${BASE}/esearch.fcgi?db=pubmed&${COMMON}&sort=relevance&retmax=${max}&term=${encodeURIComponent(query)}`)).json()) as any).esearchresult?.idlist as string[] | undefined;
  return ids?.length ? summaries(ids) : [];
}

export async function summaries(ids: string[]): Promise<PubmedHit[]> {
  const r = ((await (await get(`${BASE}/esummary.fcgi?db=pubmed&${COMMON}&id=${ids.join(",")}`)).json()) as any).result ?? {};
  return ids.filter((id) => r[id]?.title).map((id) => {
    const d = r[id];
    return {
      pmid: id,
      title: String(d.title).replace(/\.$/, ""),
      authors: (d.authors ?? []).filter((a: any) => a.authtype === "Author").map((a: any) => String(a.name)),
      journal: d.fulljournalname || d.source || "",
      year: String(d.pubdate ?? "").slice(0, 4),
      volume: d.volume ?? "",
      pages: d.pages ?? "",
      doi: (d.articleids ?? []).find((a: any) => a.idtype === "doi")?.value ?? "",
    };
  });
}

export async function abstractOf(pmid: string): Promise<string> {
  const xml = await (await get(`${BASE}/efetch.fcgi?db=pubmed&tool=margin-editor&rettype=abstract&retmode=xml&id=${pmid}`)).text();
  return [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "")).join(" ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#x?[0-9a-f]+;/gi, " ").trim();
}

/** "Sakurai T" -> "Sakurai, T"; citekey = first author's surname + year, made unique against `taken`. */
export function toBibtex(h: PubmedHit, abstract: string, taken: (key: string) => boolean): { key: string; bib: string } {
  const surname = (h.authors[0] ?? "Anon").replace(/\s+[A-Z]{1,3}$/, "").normalize("NFD").replace(/[^A-Za-z]/g, "") || "Anon";
  let key = `${surname}${h.year}`;
  for (let i = 0; taken(key); i++) key = `${surname}${h.year}${"bcdefghijk"[i] ?? i}`;
  const esc = (s: string) => s.replace(/[{}]/g, "").replace(/([&%#_])/g, "\\$1");
  const fields: [string, string][] = [
    ["author", h.authors.map((a) => a.replace(/^(.*)\s+([A-Z]{1,3})$/, "$1, $2")).join(" and ")],
    ["title", `{${esc(h.title)}}`],
    ["journal", esc(h.journal)], ["year", h.year], ["volume", h.volume], ["pages", h.pages.replace(/-/g, "--")],
    ["doi", h.doi], ["pmid", h.pmid], ["abstract", esc(abstract)],
  ];
  return { key, bib: `@article{${key},\n${fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}` };
}

// ---------- bulk lookups for the abstracts pass ----------
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const cleanDoi = (d: string) => d.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();

/** DOI -> PMID, 40 DOIs per request. NCBI allows about three requests a second without a key. */
export async function pmidsForDois(dois: string[], onProgress?: (done: number) => void): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < dois.length; i += 40) {
    const chunk = dois.slice(i, i + 40).map(cleanDoi);
    try {
      const ids = ((await (await get(`${BASE}/esearch.fcgi?db=pubmed&${COMMON}&retmax=200&term=${encodeURIComponent(chunk.map((d) => `"${d}"[doi]`).join(" OR "))}`)).json()) as any).esearchresult?.idlist as string[] | undefined;
      await pause(380);
      if (ids?.length) {
        const want = new Set(chunk);
        for (const h of await summaries(ids)) if (h.doi && want.has(cleanDoi(h.doi))) out.set(cleanDoi(h.doi), h.pmid);
        await pause(380);
      }
    } catch (e) { console.warn(`  PubMed lookup failed for one group of DOIs: ${(e as Error).message}`); await pause(1500); }
    onProgress?.(Math.min(dois.length, i + 40));
  }
  return out;
}

/** PMID -> abstract, 150 per request. */
export async function abstractsFor(pmids: string[], onProgress?: (done: number) => void): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unescape = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#x?[0-9a-f]+;/gi, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < pmids.length; i += 150) {
    try {
      const xml = await (await get(`${BASE}/efetch.fcgi?db=pubmed&tool=margin-editor&rettype=abstract&retmode=xml&id=${pmids.slice(i, i + 150).join(",")}`)).text();
      for (const art of xml.split("<PubmedArticle>").slice(1)) {
        const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(art)?.[1];
        const text = [...art.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => unescape(m[1]!)).join(" ");
        if (pmid && text) out.set(pmid, text);
      }
    } catch (e) { console.warn(`  PubMed fetch failed for one group: ${(e as Error).message}`); await pause(1500); }
    await pause(380);
    onProgress?.(Math.min(pmids.length, i + 150));
  }
  return out;
}
