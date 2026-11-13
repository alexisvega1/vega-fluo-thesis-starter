// Spell check for prose in a LaTeX or Markdown file. Runs on this machine with an open English
// dictionary (hunspell en-US); commands, citation keys, labels, file names, maths and comments are
// never checked. Words you add, and corrections you ask to be remembered, live with the project.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import nspell from "nspell";

type Engine = ReturnType<typeof nspell>;
const engines = new Map<string, Promise<Engine>>();
/** The English (en-US) or Spanish dictionary, loaded once on first use. */
function checker(lang: "en" | "es" = "en"): Promise<Engine> {
  let e = engines.get(lang);
  if (!e) {
    e = (async () => {
      const dir = dirname(Bun.resolveSync(lang === "es" ? "dictionary-es" : "dictionary-en", import.meta.dir));
      return nspell({ aff: Buffer.from(await Bun.file(join(dir, "index.aff")).arrayBuffer()), dic: Buffer.from(await Bun.file(join(dir, "index.dic")).arrayBuffer()) });
    })();
    engines.set(lang, e);
  }
  return e;
}

/**
 * Character ranges written in Spanish. Marked ones always count: babel's otherlanguage environment,
 * \foreignlanguage{spanish}{...}, \selectlanguage{spanish} until another \selectlanguage, and the
 * comments "% spellcheck: es" ... "% spellcheck: en".
 */
export function spanishMarks(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\\begin\{otherlanguage\*?\}\{spanish\}([\s\S]*?)\\end\{otherlanguage\*?\}/g)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(/\\foreignlanguage\{spanish\}\{/g)) {
    let depth = 1, i = m.index! + m[0].length;
    for (; i < text.length && depth; i++) { if (text[i] === "\\") i++; else if (text[i] === "{") depth++; else if (text[i] === "}") depth--; }
    out.push([m.index!, i]);
  }
  const switches = [...text.matchAll(/\\selectlanguage\{(\w+)\}|%\s*spellcheck:\s*(es|en|spanish|english)\b/gi)];
  let open: number | null = null;
  for (const m of switches) {
    const es = /^(es|spanish)$/i.test(m[1] ?? m[2] ?? "");
    if (es && open === null) open = m.index!;
    else if (!es && open !== null) { out.push([open, m.index!]); open = null; }
  }
  if (open !== null) out.push([open, text.length]);
  return out;
}

/** Blank out everything that is not prose, keeping every character at the same offset. */
export function maskTex(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/(?<!\\)%.*$/gm, blank)
    .replace(/\\begin\{(verbatim|lstlisting|minted|comment|equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|eqnarray\*?|tikzpicture)\}[\s\S]*?\\end\{\1\}/g, blank)
    .replace(/\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, blank)
    // citations and cross-references first, in every form: \cite, \citep[see][p. 3]{a, b}, \textcite, \autoref,
    // keys split over several lines, and one still being typed (no closing brace yet)
    .replace(/\\[a-zA-Z]*(?:cite|ref)[a-zA-Z]*\*?(?:\s*\[[^\]]*\])*\s*\{[^{}]*(?:\}|$)/gm, blank)
    // other commands whose arguments are names, paths or settings rather than prose; (?![a-zA-Z]) stops
    // \ce from eating the start of \centering, and options may come before or after the braces
    .replace(/\\(?:label|includegraphics|input|include|url|href|nolinkurl|bibliography|bibliographystyle|addbibresource|usepackage|documentclass|begin|end|codefile|lstinputlisting|graphicspath|hypersetup|si|SI|ce|acro|email|orcid|pagestyle|setcounter|vspace|hspace|input@path)\*?(?![a-zA-Z])(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\})?(?:\s*\[[^\]]*\])*/g, blank)
    .replace(/\\[a-zA-Z@]+\*?|\\./g, blank)
    .replace(/https?:\/\/\S+|\S+@\S+\.\S+/g, blank);
}
export function maskMarkdown(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?```|`[^`\n]*`/g, blank).replace(/\[[^\]]*@[^\]]*\]|@[\w:./-]+/g, blank).replace(/\]\([^)]*\)/g, blank).replace(/https?:\/\/\S+/g, blank);
}

export interface Misspelling { word: string; count: number; at: number[]; lang: "en" | "es" }

/**
 * Misspelled words in prose, each with every position it occurs at. Text is judged a sentence or
 * clause at a time (split at full stops, ¡ ¿, semicolons and spaced dashes), because a paragraph can
 * switch language halfway: "Kelvin - sin ti no tengo idea donde estaría. The Golden Age in a lab...".
 * A clause reads as Spanish when at least two of its words are Spanish-only and they outnumber the
 * English-only ones; marked sections are always Spanish. In Spanish a word correct in either language
 * passes, since English technical terms turn up there too.
 */
export async function spellCheck(text: string, lang: string, known: (w: string, capital: boolean) => boolean): Promise<Misspelling[]> {
  const [en, es] = await Promise.all([checker("en"), checker("es")]);
  const prose = lang === "tex" ? maskTex(text) : lang === "md" ? maskMarkdown(text) : text;
  const marked = spanishMarks(text);
  const inMarked = (i: number) => marked.some(([a, b]) => i >= a && i < b);
  const okIn = new Map<string, [boolean, boolean]>();
  const verdict = (w: string): [boolean, boolean] => {
    let v = okIn.get(w);
    if (!v) {
      const plain = w.replace(/’/g, "'"), base = plain.replace(/'s$/, ""), lower = plain.toLowerCase();
      v = [en.correct(plain) || en.correct(lower) || en.correct(base), es.correct(plain) || es.correct(lower)];
      okIn.set(w, v);
    }
    return v;
  };
  // words, grouped by paragraph
  const paras: { words: { w: string; i: number }[]; es: boolean }[] = [];
  let cur: { words: { w: string; i: number }[]; es: boolean } = { words: [], es: false }, lastEnd = 0;
  for (const m of prose.matchAll(/[A-Za-z\u00C0-\u024F]+(?:['’][A-Za-z]+)?/g)) {
    const w = m[0], i = m.index!;
    if (cur.words.length && /\n[ \t]*\n|[.!?;:]["'’”)\]]*\s|\s[-–—]\s|[¡¿]/.test(prose.slice(lastEnd, i))) { paras.push(cur); cur = { words: [], es: false }; }
    lastEnd = i + w.length;
    if (w.length < 3 || /[0-9_]/.test(prose[i - 1] ?? "") || /[0-9_]/.test(prose[i + w.length] ?? "")) continue; // part of ab12Cd, file_name, etc.
    if (/[A-Z]/.test(w.slice(1))) continue; // acronyms and names like mCherry, DREADDs, CA1
    cur.words.push({ w, i });
  }
  if (cur.words.length) paras.push(cur);
  for (const p of paras) {
    let esOnly = 0, enOnly = 0;
    for (const { w } of p.words) { const [a, b] = verdict(w); if (b && !a) esOnly++; else if (a && !b) enOnly++; }
    p.es = esOnly >= 2 && esOnly > enOnly;
  }
  const found = new Map<string, Misspelling>();
  for (const p of paras) for (const { w, i } of p.words) {
    const base = w.replace(/’/g, "'").replace(/'s$/, "");
    if (known(base.toLowerCase(), /^[A-Z]/.test(w))) continue;
    const [okEn, okEs] = verdict(w), spanish = p.es || inMarked(i);
    // a capitalised Spanish word in English text is usually a name or title: Tío Marcel, San Juan
    if (spanish ? okEn || okEs : okEn || (okEs && /^[A-ZÁÉÍÓÚÑ]/.test(w))) continue;
    const hit = found.get(w) ?? { word: w, count: 0, at: [], lang: spanish ? "es" : "en" };
    hit.count++; hit.at.push(i);
    found.set(w, hit);
  }
  return [...found.values()];
}

export async function suggest(word: string, lang: "en" | "es" = "en"): Promise<string[]> {
  const sp = await checker(lang);
  let out = sp.suggest(word.replace(/’/g, "'"));
  if (lang === "es") {
    // the commonest Spanish slip is a missing accent or tilde (raton -> ratón, ano -> año): try those first
    const swap: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", n: "ñ" };
    const accented: string[] = [];
    for (let i = 0; i < word.length; i++) {
      const c = swap[word[i]!.toLowerCase()];
      if (!c) continue;
      const v = word.slice(0, i) + (word[i] === word[i]!.toUpperCase() ? c.toUpperCase() : c) + word.slice(i + 1);
      if (sp.correct(v)) accented.push(v);
    }
    out = [...new Set([...accented, ...out])];
  }
  out = out.slice(0, 6);
  return /^[A-Z]/.test(word) ? out : out.sort((a, b) => Number(/^[A-Z]/.test(a)) - Number(/^[A-Z]/.test(b))); // lower-case word: common words before proper nouns
}

// ---------- the project's own words and remembered corrections ----------
export interface SpellStore { words: string[]; rules: Record<string, string> }
const storePath = (project: string) => join(project, ".margin", "spelling.json");

export async function loadSpelling(project: string): Promise<SpellStore> {
  try { const s = await Bun.file(storePath(project)).json(); return { words: Array.isArray(s.words) ? s.words : [], rules: s.rules && typeof s.rules === "object" ? s.rules : {} }; }
  catch { return { words: [], rules: {} }; }
}
export async function saveSpelling(project: string, s: SpellStore) {
  await mkdir(dirname(storePath(project)), { recursive: true });
  s.words = [...new Set(s.words.map((w) => w.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  await Bun.write(storePath(project), JSON.stringify(s, null, 2) + "\n");
}
const WORD = /^[A-Za-zÀ-ɏ'’-]{1,60}$/;
export const validWord = (w: unknown): w is string => typeof w === "string" && WORD.test(w);
