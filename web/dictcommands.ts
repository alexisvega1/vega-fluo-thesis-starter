// Spoken structure commands in dictation, turned into LaTeX:
//   "new paragraph"                         -> a blank line
//   "new chapter Introduction"              -> \chapter{Introduction}
//   "new section Results", "new subsection …", "new sub-subsection …" -> \section{…}, \subsection{…}, \subsubsection{…}
// Only at the start of a sentence ("a new section of the hippocampus" stays prose).
// The heading's title is what you say after the command, up to the end of that sentence. With no title,
// a [TITLE] placeholder is left to fill in. Whisper writes these in many ways ("New section, Results.",
// "new sub sub section:"), so punctuation and spacing around the command are forgiving.

const LEVELS: [RegExp, string][] = [
  [/sub[\s-]*sub[\s-]*section/, "subsubsection"],
  [/sub[\s-]*section/, "subsection"],
  [/section/, "section"],
  [/chapter/, "chapter"],
];
const COMMAND = /\bnew[\s,]+(paragraph|chapter|sub[\s-]*sub[\s-]*section|sub[\s-]*section|section)\b[\s.,:;!?—-]*/gi;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const escape = (s: string) => s.replace(/[&%$#_{}]/g, "\\$&");

/** Rewrite spoken commands in one dictated phrase. Text before and after is kept as it was said. */
export function dictationCommands(text: string, startsSentence = true): string {
  if (!/\bnew\b/i.test(text)) return text;
  let out = "", at = 0;
  for (const m of text.matchAll(COMMAND)) {
    if (m.index! < at) continue;
    // a command only where a sentence starts: "a new section of the hippocampus" is tissue, not a heading
    if (!(startsSentence ? /(^|[.!?]|\n)\s*$/ : /([.!?]|\n)\s*$/).test(text.slice(0, m.index!))) continue;
    const before = text.slice(at, m.index!).replace(/[\s,;:—-]+$/, "");
    out += before;
    const kind = m[1]!.toLowerCase();
    let next = m.index! + m[0].length;
    if (kind === "paragraph") {
      out += "\n\n";
    } else {
      const cmd = LEVELS.find(([re]) => re.test(kind))![1];
      // the title runs to the end of the sentence (or of the phrase, or up to the next command)
      const rest = text.slice(next);
      const stop = rest.search(/[.!?](\s|$)|\bnew[\s,]+(paragraph|chapter|sub[\s-]*sub[\s-]*section|sub[\s-]*section|section)\b/i);
      const raw = (stop === -1 ? rest : rest.slice(0, stop)).trim().replace(/[,;:—-]+$/, "");
      out += `\n\n\\${cmd}{${raw ? escape(cap(raw)) : "[TITLE]"}}\n`;
      next += stop === -1 ? rest.length : stop + (/^[.!?]/.test(rest.slice(stop)) ? 1 : 0);
    }
    at = next;
  }
  out += text.slice(at).replace(/^\s+/, "");
  return out.replace(/\n{3,}/g, "\n\n");
}
