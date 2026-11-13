// Add a reference by DOI. The metadata is asked of doi.org in CSL-JSON, turned into one BibTeX entry
// (key Surname+Year+FirstWord), and appended to the project's .bib.
//
// Hosts contacted (the only ones): https://doi.org, then at most ONE redirect it sends, and only to
//   api.crossref.org  (Crossref DOIs)   or   api.datacite.org  (DataCite DOIs), over https.
// (Checked 13 Nov 2026: DataCite DOIs such as 10.5281/zenodo.* are sent to data.crosscite.org, which is
// not on this list, so those are refused rather than followed.)
// doi.org itself does not serve the metadata; it answers with a 302 to the registration agency's API.
// redirect: "manual" means fetch never follows anything on its own; any other target is refused.
// Only the DOI is sent: no cookies, no user data, a generic User-Agent.
// Config "doi": { "followRegistry": false } keeps lookups to doi.org alone.

/** A DOI from what was pasted ("10.1234/x", "doi:10.1234/x", "https://doi.org/10.1234/x"), or null if it is not one. */
export function parseDoi(input: string): string | null {
  let s = input.trim();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
  // 10.<registrant, 4-9 digits, optional .sub>/<suffix of visible characters>
  return /^10\.\d{4,9}(?:\.\d+)*\/[^\s"<>{}\\]+$/.test(s) && s.length <= 300 ? s : null;
}

export const REGISTRY_HOSTS = ["api.crossref.org", "api.datacite.org"] as const;

/**
 * CSL-JSON for a DOI. Contacts https://doi.org only; follows one redirect only when its host is in
 * `follow` (e.g. REGISTRY_HOSTS). Times out, caps the size and checks the content type.
 */
export async function fetchCsl(doi: string, follow: readonly string[] = [], fetcher: typeof fetch = fetch): Promise<any> {
  const headers = { accept: "application/vnd.citationstyles.csl+json", "user-agent": "VegaFluo/0.1" };
  let url = `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/").replace(/^10%2E/, "10.")}`;
  for (let hop = 0; hop < 2; hop++) {
    const res = await fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    if (res.status >= 300 && res.status < 400) {
      const to = new URL(res.headers.get("location") ?? "", url);
      if (hop > 0 || to.protocol !== "https:" || !follow.includes(to.hostname))
        throw new Error(follow.length
          ? `doi.org sent this request on to ${to.origin}, which is not one of the hosts Vega Fluo contacts (${REGISTRY_HOSTS.map((h) => `https://${h}`).join(", ")}). This DOI cannot be looked up here; add it to the .bib by hand.`
          : `doi.org sent this request on to ${to.hostname}, which Vega Fluo is not set to contact. Only the DOI registries (${REGISTRY_HOSTS.join(", ")}) are ever followed; to allow them, remove "doi": { "followRegistry": false } from config.json.`);
      url = to.toString();
      continue;
    }
    if (res.status === 404) throw new Error("doi.org does not know that DOI.");
    if (!res.ok) throw new Error(`The DOI lookup failed (HTTP ${res.status}).`);
    if (!/json/i.test(res.headers.get("content-type") ?? "")) throw new Error("The DOI service did not return citation data.");
    const body = await res.text();
    if (body.length > 2_000_000) throw new Error("The citation data is implausibly large.");
    return JSON.parse(body);
  }
  throw new Error("Too many redirects.");
}

/** Make text safe inside a BibTeX {…} value: no unbalanced braces, TeX specials escaped, no control characters. */
export function bibSafe(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "") // JATS tags in Crossref titles and abstracts (<i>, <sub>, <jats:p>)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\\/g, "") // no TeX commands from outside
    .replace(/[{}]/g, "")
    .replace(/([&%#_$])/g, "\\$1")
    .replace(/[~^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["a", "an", "the", "on", "of", "in", "for", "and", "to", "with", "at", "by", "from", "is", "are"]);
const ascii = (s: string) => s.normalize("NFD").replace(/[^A-Za-z0-9]/g, "");

/** Surname + year + first meaningful title word: Smith2020Sleep. `taken` adds b, c, … on collision. */
export function citeKey(csl: any, taken: (k: string) => boolean): string {
  const a = (csl.author ?? csl.editor ?? [])[0] ?? {};
  const surname = ascii(a.family ?? a.literal ?? "").replace(/^./, (c) => c.toUpperCase()) || "Anon";
  const year = cslYear(csl) || "nd";
  const word = String(csl.title ?? "").replace(/<[^>]+>/g, "").split(/[^\p{L}\p{N}]+/u).find((w) => w && !STOP.has(w.toLowerCase())) ?? "";
  const base = `${surname}${year}${ascii(word).replace(/^./, (c) => c.toUpperCase())}`;
  let key = base;
  for (let i = 0; taken(key); i++) key = `${base}${"bcdefghijklmnopqrstuvwxyz"[i] ?? i}`;
  return key;
}

function cslYear(csl: any): string {
  for (const f of ["issued", "published-print", "published-online", "created"]) {
    const y = csl[f]?.["date-parts"]?.[0]?.[0];
    if (y && /^\d{4}$/.test(String(y))) return String(y);
  }
  return "";
}

const TYPE: Record<string, string> = {
  "article-journal": "article", "journal-article": "article", article: "article", "paper-conference": "inproceedings",
  "proceedings-article": "inproceedings", book: "book", chapter: "incollection", "book-chapter": "incollection",
  thesis: "phdthesis", report: "techreport", "posted-content": "misc", dataset: "misc",
};

/** One BibTeX entry from CSL-JSON. Every value is sanitised; the DOI is the one asked for, not the one returned. */
export function cslToBibtex(csl: any, doi: string, taken: (k: string) => boolean): { key: string; bib: string } {
  const key = citeKey(csl, taken);
  const type = TYPE[String(csl.type ?? "")] ?? "misc";
  const name = (p: any) => (p.family ? `${bibSafe(p.family)}${p.given ? `, ${bibSafe(p.given)}` : ""}` : p.literal ? `{${bibSafe(p.literal)}}` : "");
  const authors = (csl.author ?? []).map(name).filter(Boolean).join(" and ");
  const editors = (csl.editor ?? []).map(name).filter(Boolean).join(" and ");
  const container = bibSafe(Array.isArray(csl["container-title"]) ? csl["container-title"][0] : csl["container-title"]);
  const fields: [string, string][] = [
    ["author", authors],
    ["editor", type === "book" || type === "incollection" ? editors : ""],
    ["title", csl.title ? `{${bibSafe(Array.isArray(csl.title) ? csl.title[0] : csl.title)}}` : ""],
    [type === "inproceedings" || type === "incollection" ? "booktitle" : "journal", type === "book" ? "" : container],
    ["publisher", type === "book" || type === "incollection" ? bibSafe(csl.publisher) : ""],
    ["year", cslYear(csl)],
    ["volume", bibSafe(csl.volume)],
    ["number", bibSafe(csl.issue)],
    ["pages", bibSafe(csl.page).replace(/(\d)-(\d)/, "$1--$2")],
    ["doi", bibSafe(doi)],
  ];
  return { key, bib: `@${type}{${key},\n${fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}` };
}
