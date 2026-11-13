// Reads a reviewed Word file (as exported from Google Docs) with pandoc and returns the reviewer's
// tracked changes and comments, positioned against the text as it was before their suggestions.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface Tracked { type: "ins" | "del"; at: number; text: string; author: string; ts: number }
export interface DocxComment { id: string; author: string; ts: number; text: string; from: number; to: number }
export interface Reviewed { original: string; tracked: Tracked[]; comments: DocxComment[] }

type Node = { t: string; c?: any };
type Mode = { type: "ins" | "del"; author: string; ts: number } | null;
const attr = (a: any, name: string) => (a[2] as [string, string][]).find(([k]) => k === name)?.[1] ?? "";
const when = (s: string) => Date.parse(s) || Date.now();

/** Walk a pandoc JSON document produced with --track-changes=all. */
export function readPandoc(doc: { blocks: Node[] }): Reviewed {
  let original = "";
  const tracked: Tracked[] = [];
  const comments: DocxComment[] = [];
  const openComments = new Map<string, DocxComment>();
  let lineStart = true;

  function text(s: string, mode: Mode) {
    if (!s) return;
    if (s === " " && !mode && (lineStart || original.endsWith(" "))) return;
    const last = tracked[tracked.length - 1];
    if (mode?.type === "ins") {
      if (last && last.type === "ins" && last.at === original.length && last.author === mode.author) last.text += s;
      else tracked.push({ type: "ins", at: original.length, text: s, author: mode.author, ts: mode.ts });
      return;
    }
    if (mode?.type === "del") {
      if (last && last.type === "del" && last.at + last.text.length === original.length && last.author === mode.author) last.text += s;
      else tracked.push({ type: "del", at: original.length, text: s, author: mode.author, ts: mode.ts });
    }
    original += s;
    lineStart = false;
  }
  const plain = (nodes: Node[]): string =>
    nodes.map((n) => (n.t === "Str" ? n.c : n.t === "Space" || n.t === "SoftBreak" ? " " : Array.isArray(n.c) ? plain(n.c.flat(3).filter((x: any) => x?.t)) : "")).join("");

  function inlines(nodes: Node[], mode: Mode) {
    for (const n of nodes) {
      switch (n.t) {
        case "Str": text(n.c, mode); break;
        case "Space": case "SoftBreak": case "LineBreak": text(" ", mode); break;
        case "Code": case "Math": text(n.c[1], mode); break;
        case "Quoted": {
          const dbl = n.c[0].t === "DoubleQuote";
          text(dbl ? "“" : "‘", mode); inlines(n.c[1], mode); text(dbl ? "”" : "’", mode);
          break;
        }
        case "Span": {
          const cls: string[] = n.c[0][1];
          const who = { author: attr(n.c[0], "author") || "Reviewer", ts: when(attr(n.c[0], "date")) };
          if (cls.includes("insertion")) inlines(n.c[1], { type: "ins", ...who });
          else if (cls.includes("deletion")) inlines(n.c[1], { type: "del", ...who });
          else if (cls.includes("comment-start")) openComments.set(attr(n.c[0], "id"), { id: attr(n.c[0], "id"), ...who, text: plain(n.c[1]).trim(), from: original.length, to: original.length });
          else if (cls.includes("comment-end")) {
            const c = openComments.get(attr(n.c[0], "id"));
            if (c) { c.to = original.length; comments.push(c); openComments.delete(c.id); }
          } else if (cls.includes("paragraph-insertion")) pendingBreak = { type: "ins", ...who };
          else if (cls.includes("paragraph-deletion")) pendingBreak = { type: "del", ...who };
          else inlines(n.c[1], mode);
          break;
        }
        case "Link": case "Image": inlines(n.c[1], mode); break;
        case "Note": break;
        default: if (Array.isArray(n.c)) inlines(n.c.filter((x: any) => x?.t), mode);
      }
    }
  }

  let pendingBreak: Mode = null; // a paragraph break the reviewer added or removed
  let first = true;
  function line(nodes: Node[]) {
    if (!first) {
      if (original.endsWith(" ")) {
        original = original.slice(0, -1);
        // anything recorded after that trailing space (an insertion typed after it) now sits at the line's end
        const n = original.length;
        for (const t of tracked) if (t.at > n) t.at = n;
        for (const c of [...comments, ...openComments.values()]) { if (c.from > n) c.from = n; if (c.to > n) c.to = n; }
      }
      text("\n", pendingBreak);
    }
    first = false;
    pendingBreak = null;
    lineStart = true;
    inlines(nodes, null);
  }
  function blocks(list: Node[]) {
    for (const b of list) {
      if (b.t === "Header") line(b.c[2]);
      else if (b.t === "Para" || b.t === "Plain") line(b.c);
      else if (b.t === "BlockQuote") blocks(b.c);
      else if (b.t === "Div") blocks(b.c[1]);
      else if (b.t === "BulletList") for (const item of b.c) blocks(item);
      else if (b.t === "OrderedList") for (const item of b.c[1]) blocks(item);
    }
  }
  blocks(doc.blocks);
  if (original.endsWith(" ")) original = original.slice(0, -1);
  for (const c of openComments.values()) comments.push({ ...c, to: original.length });
  return { original, tracked, comments };
}

export async function readDocx(bytes: Uint8Array): Promise<Reviewed> {
  if (!Bun.which("pandoc")) throw new Error("pandoc is not installed; it is needed to read the reviewed document");
  const dir = await mkdtemp(join(tmpdir(), "margin-"));
  try {
    const file = join(dir, "review.docx");
    await Bun.write(file, bytes);
    const p = Bun.spawn(["pandoc", "-f", "docx", "-t", "json", "--track-changes=all", file], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if ((await p.exited) !== 0) throw new Error(`pandoc could not read the document: ${err.slice(0, 200)}`);
    return readPandoc(JSON.parse(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
