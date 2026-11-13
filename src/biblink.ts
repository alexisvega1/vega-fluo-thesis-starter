// Make a BibTeX entry's title a link to the paper, the way the Overleaf bibliography does it:
//   title = {\href{https://...}{Title of the paper}}
// so the title in the reference list is clickable. The link is the entry's own url, else its PubMed
// page, else its DOI. Entries that already have a link, or have nothing to link to, are left alone.

/** Find `name = {...}` or `name = "..."` in an entry; returns the value span (inside the delimiters). */
function field(raw: string, name: string): { start: number; end: number; value: string } | null {
  const m = new RegExp(`(^|[,\\s])${name}\\s*=\\s*([{"])`, "i").exec(raw);
  if (!m) return null;
  const open = m.index + m[0].length;
  if (m[2] === '"') { const end = raw.indexOf('"', open); return end < 0 ? null : { start: open, end, value: raw.slice(open, end) }; }
  let depth = 1, i = open;
  for (; i < raw.length && depth; i++) { if (raw[i] === "\\") { i++; continue; } if (raw[i] === "{") depth++; else if (raw[i] === "}") depth--; }
  return depth ? null : { start: open, end: i - 1, value: raw.slice(open, i - 1) };
}

/** The address a title should point to, escaped for \href. */
export function linkFor(raw: string): string | null {
  const url = field(raw, "url")?.value.trim();
  const pmid = field(raw, "pmid")?.value.trim();
  const doi = field(raw, "doi")?.value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const target = url && /^https?:\/\//i.test(url) ? url : pmid && /^\d+$/.test(pmid) ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : doi ? `https://doi.org/${doi}` : null;
  return target ? target.replace(/\\/g, "").replace(/([%#])/g, "\\$1") : null;
}

export function linkTitle(raw: string): string {
  const t = field(raw, "title");
  if (!t || /\\href\s*\{/.test(t.value) || !t.value.trim()) return raw;
  const link = linkFor(raw);
  if (!link) return raw;
  const quoted = raw[t.start - 1] === '"';
  const body = `\\href{${link}}{${t.value}}`;
  return quoted ? raw.slice(0, t.start - 1) + `{${body}}` + raw.slice(t.end + 1) : raw.slice(0, t.start) + body + raw.slice(t.end);
}

/**
 * Escape bare % and # inside \href{...} addresses. A raw % is read as a comment once the entry is
 * passed around as an argument (bibliography page back-references do this), and the title vanishes.
 */
export function escapeHrefs(raw: string): string {
  return raw.replace(/\\href\{([^{}]*)\}/g, (_m, url: string) => `\\href{${url.replace(/(?<!\\)([%#])/g, "\\$1")}}`);
}

/** Apply to every entry in a .bib file; returns the new text, how many titles were linked and how many links were repaired. */
export function linkAllTitles(bib: string): { text: string; linked: number; escaped: number } {
  let linked = 0, escaped = 0;
  const parts = bib.split(/(?=^@\w+\s*\{)/m).map((p) => {
    if (!/^@(?!comment|string|preamble)\w+\s*\{/i.test(p)) return p;
    const fixed = escapeHrefs(p);
    if (fixed !== p) escaped++;
    const next = linkTitle(fixed);
    if (next !== fixed) linked++;
    return next;
  });
  return { text: parts.join(""), linked, escaped };
}
