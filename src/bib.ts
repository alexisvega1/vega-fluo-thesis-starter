export interface BibEntry {
  key: string;
  type: string;
  title: string;
  authors: string; // short form: "Sakurai et al."
  year: string;
  journal: string;
  abstract: string;
  doi: string;
  pmid: string;
  raw: string; // the entry exactly as written, for copying into another .bib
}

const clean = (s: string) =>
  s
    .replace(/\\href\s*\{[^{}]*\}/g, "") // \href{url}{Title} -> Title (the link part goes)
    .replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, "$1") // \textit{x} -> x
    .replace(/\\([&%_#$])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function shortAuthors(raw: string): string {
  const names = raw.split(/\s+and\s+/i).map((n) => n.trim()).filter(Boolean);
  if (!names.length) return "";
  const last = (n: string) => (n.includes(",") ? n.split(",")[0]! : n.split(/\s+/).pop()!).trim();
  if (names.length === 1) return last(names[0]!);
  if (names.length === 2) return `${last(names[0]!)} & ${last(names[1]!)}`;
  return `${last(names[0]!)} et al.`;
}

/** Read one field value starting at src[j]; returns [value, nextIndex]. */
function readValue(src: string, j: number): [string, number] {
  if (src[j] === "{") {
    let depth = 0;
    const start = j + 1;
    for (; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return [src.slice(start, j), j + 1];
    }
    return [src.slice(start), j];
  }
  if (src[j] === '"') {
    let depth = 0;
    const start = ++j;
    for (; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      else if (src[j] === '"' && depth === 0) return [src.slice(start, j), j + 1];
    }
    return [src.slice(start), j];
  }
  const start = j;
  while (j < src.length && src[j] !== "," && src[j] !== "}" && src[j] !== "\n") j++;
  return [src.slice(start, j), j];
}

/**
 * Tolerant BibTeX parser: brace-matched values, skips @comment/@string/@preamble.
 * The file is first cut at every line that starts a new entry, and each entry is parsed on its own,
 * so one malformed entry (an unbalanced brace, a stray backslash) cannot swallow the entries after it.
 */
export function parseBib(src: string): BibEntry[] {
  const out: BibEntry[] = [];
  const starts = [...src.matchAll(/^[ \t]*@[a-zA-Z]+\s*[{(]/gm)].map((m) => m.index! + m[0].indexOf("@"));
  for (let n = 0; n < starts.length; n++) {
    const chunk = src.slice(starts[n]!, starts[n + 1] ?? src.length);
    const head = /^@(\w+)\s*[{(]\s*([^,\s{}]+)\s*,/.exec(chunk.slice(0, 300));
    if (!head || /^(comment|string|preamble)$/i.test(head[1]!)) continue;
    let j = head[0].length;
    const f: Record<string, string> = {};
    while (j < chunk.length) {
      while (j < chunk.length && /[\s,]/.test(chunk[j]!)) j++;
      if (chunk[j] === "}" || chunk[j] === ")") break;
      const fm = /^([\w-]+)\s*=\s*/.exec(chunk.slice(j, j + 80));
      if (!fm) break;
      j += fm[0].length;
      const [val, next] = readValue(chunk, j);
      f[fm[1]!.toLowerCase()] = clean(val);
      j = next;
    }
    out.push({
      key: head[2]!,
      type: head[1]!.toLowerCase(),
      title: f.title ?? "",
      authors: shortAuthors(f.author ?? f.editor ?? ""),
      year: (f.year ?? f.date ?? "").slice(0, 4),
      journal: f.journal ?? f.journaltitle ?? f.booktitle ?? f.publisher ?? "",
      abstract: f.abstract ?? "",
      doi: f.doi ?? "",
      pmid: f.pmid ?? "",
      raw: chunk.trim(),
    });
  }
  return out;
}
