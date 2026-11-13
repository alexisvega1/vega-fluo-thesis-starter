// Turns raw streamed model output into the ghost text shown in the editor.
// Called repeatedly on the growing raw string; the returned text only ever grows by appending,
// so the server can stream `text.slice(alreadySent)`.

const ABBR = /(?:\bet al|\be\.g|\bi\.e|\bFig|\bFigs|\bvs|\betc|\bcf|\bca|\bDr|\bno|\bapprox|\b[A-Z])$/;

export function shape(
  raw: string,
  before: string,
  hasKey: (key: string) => boolean,
  final: boolean,
  lang: "md" | "tex" = "md",
): { text: string; done: boolean } {
  // reasoning models: drop <think> blocks, including one still being written
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = s.indexOf("<think>");
  if (open !== -1) s = s.slice(0, open);
  const lt = s.lastIndexOf("<");
  if (!final && lt !== -1 && "<think>".startsWith(s.slice(lt))) s = s.slice(0, lt);

  s = s.replace(/^\s*\n+/, "").replace(/^["“`]+/, "");
  if (before === "" || /\s$/.test(before)) s = s.trimStart();
  // Models often drop the leading space. After punctuation or a finished word, put it back.
  else if (/[,.;:)\]}A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9(\[\\]/.test(s)) s = " " + s;

  // a citation survives only if every key in it exists in the library
  if (lang === "tex") {
    s = s.replace(/\s*\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g, (all, inner: string) => {
      const keys = inner.split(",").map((k) => k.trim()).filter(Boolean);
      return keys.length && keys.every(hasKey) ? all : "";
    });
    // hold back a command that is still being written, e.g. "\\cite" or "\\citep{Saku"
    const cmd = /\\[a-zA-Z]*\*?(?:\[[^\]]*\]?)*(?:\{[^}]*)?$/.exec(s);
    if (cmd) s = s.slice(0, cmd.index);
  } else {
    s = s.replace(/\s*\[([^\]]*@[^\]]*)\]/g, (all, inner: string) => {
      const keys = [...inner.matchAll(/@([\w:.\-]+)/g)].map((m) => m[1]!.replace(/[.:]+$/, ""));
      return keys.length && keys.every(hasKey) ? all : "";
    });
    const ob = s.lastIndexOf("[");
    if (ob > s.lastIndexOf("]")) s = s.slice(0, ob); // unfinished bracket: hold it back
  }

  let done = false;
  const nl = s.indexOf("\n");
  if (nl !== -1) { s = s.slice(0, nl); done = true; }

  // stop at the end of the first sentence
  const re = /[.!?]["”)]?(?=\s|$)/g;
  for (let m; (m = re.exec(s)); ) {
    const end = m.index + m[0].length;
    if (end < 12) continue;
    if (m[0][0] === "." && ABBR.test(s.slice(0, m.index))) continue;
    if (end === s.length && !final) break; // could still be "0." of "0.05" — wait for more
    s = s.slice(0, end);
    done = true;
    break;
  }
  return { text: s.trimEnd(), done };
}
