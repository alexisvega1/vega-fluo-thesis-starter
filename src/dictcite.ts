// Dictated citations into LaTeX: "Peyron et al. 1998", "Anand and Brobeck, 1951", "de Lecea et al., in 1998"
// become \citep{key} when one reference clearly matches. Whisper often mishears surnames ("Delicea",
// "Shemali" for Chemelli), so the surname is compared by spelling and by sound, and the year must match
// exactly. When two references are about equally close, nothing is changed: a wrong citation is worse
// than a spoken one left for you to fix.

export interface CiteEntry { key: string; authors: string; year: string; own?: boolean }
export interface CiteEdit { from: number; to: number; insert: string; heard: string; keys: string[] }

const PARTICLE = "(?:[Vv]an|[Dd]e|[Dd]en|[Dd]er|[Vv]on|[Dd]i|[Dd]u|[Ll]a|[Ll]e|[Dd]el|[Dd]a|[Mm]ac|[Mm]c)";
const NAME = `(?:${PARTICLE}\\s+){0,2}[A-Z][A-Za-zÀ-ÿ'’\\-]+`;
const YEAR = "(?:in\\s+)?(\\d{4})([a-c])?";
// "X et al. 1998" · "X et al., 1998" · "X, et al. 2011" · "X and Y, 1951" · "X & Y 1951" · "X, 1998" (stricter)
const RE = new RegExp(
  `(${NAME})(?:,?\\s+et\\s+al\\.?|\\s+(?:and|&)\\s+(${NAME}))?,?\\s*\\.?\\s*${YEAR}\\b`,
  "g",
);

/** Lowercase letters only, no accents or particles' spaces. */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
/** A rough "how it sounds": the confusions Whisper makes with names. */
const sound = (s: string) =>
  norm(s).replace(/^mac/, "mc").replace(/ph/g, "f").replace(/(sh|ch|sch)/g, "x").replace(/c(?=[eiy])/g, "s").replace(/[ck]/g, "k")
    .replace(/[yi]/g, "i").replace(/(ee|ea|ie)/g, "i").replace(/[aeiou]+/g, "a").replace(/h/g, "").replace(/(.)\1+/g, "$1");

/** 1 − edits / length: how much of the whole name is the same (a shared first syllable is not enough). */
function likeness(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}
export const nameScore = (heard: string, actual: string) => Math.max(likeness(norm(heard), norm(actual)), likeness(sound(heard), sound(actual)) - 0.02);

/** First author's surname from a short author form ("Sakurai et al.", "Anand and Brobeck", "de Lecea et al."). */
export function firstSurname(authors: string): string {
  return authors.replace(/\s+et al\.?.*$/, "").split(/\s+(?:and|&)\s+/)[0]!.trim();
}

/** Citations heard in `text`, as edits; adjacent ones join into one \citep, and a citation spoken as its
 *  own sentence ("… narcoleptics. Peyron et al. 2000.") moves inside the sentence before it. */
export function dictatedCitations(text: string, entries: CiteEntry[]): CiteEdit[] {
  const byYear = new Map<string, CiteEntry[]>();
  for (const e of entries) if (/^\d{4}$/.test(e.year)) (byYear.get(e.year) ?? byYear.set(e.year, []).get(e.year)!).push(e);
  const found: { from: number; to: number; key: string; heard: string }[] = [];
  for (const m of text.matchAll(RE)) {
    const [whole, name, second, year] = m;
    const etAl = /et\s+al/.test(whole), pair = !!second;
    if (!etAl && !pair && !/,\s*(?:in\s+)?\d{4}/.test(whole)) continue; // "X 1998" alone is too loose
    if (/^(In|The|This|These|By|From|Since|Until|After|Before|During|And|But)$/.test(name!.trim())) continue;
    const pool = byYear.get(year!) ?? [];
    const scored = pool
      .map((e) => {
        const authors = e.authors.split(/\s+(?:and|&)\s+/);
        let s = nameScore(name!, firstSurname(e.authors));
        if (pair) s = (s + (authors[1] ? nameScore(second!, authors[1].replace(/\s+et al\.?$/, "")) : 0)) / 2;
        if (etAl !== /et al/.test(e.authors) && !pair) s -= 0.05; // "et al." said for a single author, or not said for many
        return { e, s };
      })
      .sort((a, b) => b.s - a.s || Number(!!b.e.own) - Number(!!a.e.own));
    const best = scored[0], next = scored[1];
    const need = pair ? 0.78 : etAl ? 0.8 : 0.88;
    if (!best || best.s < need) continue;
    if (next && best.s - next.s < 0.03 && next.e.key !== best.e.key && !(best.e.own && !next.e.own)) continue; // too close to call
    found.push({ from: m.index!, to: m.index! + whole.length, key: best.e.key, heard: whole });
  }
  // join neighbours: "A et al. 1998. B et al. 1999." -> one \citep{a,b}
  const groups: { from: number; to: number; keys: string[]; heard: string[] }[] = [];
  for (const f of found) {
    const g = groups[groups.length - 1];
    if (g && /^[\s.,;]*$/.test(text.slice(g.to, f.from))) { g.to = f.to; if (!g.keys.includes(f.key)) g.keys.push(f.key); g.heard.push(f.heard); }
    else groups.push({ from: f.from, to: f.to, keys: [f.key], heard: [f.heard] });
  }
  return groups.map((g) => {
    const cite = `\\citep{${g.keys.join(",")}}`;
    // a citation spoken as its own sentence belongs inside the sentence before it: "claim. Cite." -> "claim \citep{}."
    const prev = /\.\s+$/.exec(text.slice(0, g.from));
    const ownSentence = prev && prev.index > 0 && /[^\s.]/.test(text[prev.index - 1]!) && /^\s*\./.test(text.slice(g.to));
    return ownSentence
      ? { from: prev!.index, to: g.to, insert: ` ${cite}`, heard: g.heard.join(" "), keys: g.keys }
      : { from: g.from, to: g.to, insert: cite, heard: g.heard.join(" "), keys: g.keys };
  });
}
