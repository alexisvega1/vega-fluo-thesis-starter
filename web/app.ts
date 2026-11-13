import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, drawSelection, highlightActiveLineGutter, keymap, lineNumbers, placeholder,
  type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags as t } from "@lezer/highlight";
import { autocompletion, completionKeymap, completionStatus, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";

import { fromBase, toBase, type Ins, type Del } from "./review-model";
import {
  acceptSuggestion, addComment, currentAuthor, emptyReview, hue, rejectSuggestion, resolveAll,
  internal, reviewEdit, reviewField, setAuthor, setSuggesting, suggestingField,
} from "./review";
import type { Review } from "./review-model";
import { createMap, type MapData, type MapNode } from "./map";
import { createMinimap } from "./minimap";
import * as fmt from "./format";
import { merge3, textHash } from "./merge";
import { diffText, mapToB } from "../src/diff";
import { dictationCommands } from "./dictcommands";
import { dictationStarted, dictationStopped, mountProgress, noteDictated, noteTyped } from "./progress-ui";
import { setFigureVersion, visualFigures } from "./visual";
import { editFigure, parseFigure } from "./figure-edit";
import { CODE_FONTS, DEFAULT_LOOK, FONTS, PACKS, THEMES, applyLook, loadLook, playKey, setCustomSound, warmPack, type Look } from "./appearance";

// ---------- small helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Child = Node | string | null | undefined | false | 0;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const post = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;
const remember = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- state ----------
type Lang = "tex" | "md" | "plain";
interface Heading { file: string; line: number; level: number; title: string }
interface Issue { severity: "error" | "warn" | "info"; kind: string; message: string; file: string; line: number }
interface ProjectInfo {
  tree: string[]; root: string | null; bibFile: string; totalWords: number;
  files: { path: string; words: number; linked: boolean }[];
  outline: Heading[]; labels: string[]; issues: Issue[];
}
let current = "";
let lang: Lang = "tex";
let proj: ProjectInfo = { tree: [], root: null, bibFile: "references.bib", totalWords: 0, files: [], outline: [], labels: [], issues: [] };
let projectKeys = new Set<string>();
let libraryKeys = new Set<string>();
let suggesting = remember.get("margin.suggesting") === "1";

// ---------- panes ----------
// The editor area holds one or more panes side by side, each with its own document. `view`, `current`
// and `lang` always describe the pane you are working in, so everything that acts "at the cursor"
// (suggestions, citations, comments, dictation) follows your focus.
interface Pane {
  el: HTMLElement; head: HTMLElement; view: EditorView; minimap: ReturnType<typeof createMinimap>;
  file: string; lang: Lang; dirty: boolean; saveTimer?: ReturnType<typeof setTimeout>; saveTries?: number;
  synced?: string; // the file as this tab last loaded or saved it
  syncedReview?: any; // its review notes as last loaded or saved
  orphans: (Ins | Del)[]; // stored suggestions that no longer fit the text; kept, never applied
  hadReview: boolean;
}
const panes: Pane[] = [];
let active!: Pane;
let view!: EditorView;
const paneOf = (v: EditorView) => panes.find((p) => p.view === v);
const langOf = (path: string): Lang => (path.endsWith(".tex") ? "tex" : path.endsWith(".md") ? "md" : "plain");

const CITE_TEX = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]\n]*\])*\{([^}\n]*)\}/;
const texKeys = (s: string) => (CITE_TEX.exec(s)?.[1] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const mdKeys = (s: string) => [...s.matchAll(/@([\w:.\-]+)/g)].map((m) => m[1]!.replace(/[.:]+$/, ""));
const citeText = (ks: string[]) => (lang === "tex" ? `\\citep{${ks.join(", ")}}` : `[${ks.map((k) => "@" + k).join("; ")}]`);

// ---------- ghost text ----------
interface Ghost { pos: number; text: string }
const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: GhostWidget) { return o.text === this.text; }
  toDOM() { return h("span", { class: "cm-ghost", "aria-hidden": "true" }, this.text); }
  ignoreEvent() { return true; }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(g, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!g) return null;
    if (tr.docChanged) {
      // typing the suggestion's own next characters keeps the rest of it on screen
      let n = 0, typed = "";
      tr.changes.iterChanges((fromA, toA, _fb, _tb, ins) => { n++; if (fromA === g.pos && toA === g.pos) typed = ins.toString(); });
      if (n === 1 && typed && g.text.startsWith(typed) && g.text.length > typed.length)
        return { pos: g.pos + typed.length, text: g.text.slice(typed.length) };
      return null;
    }
    return tr.selection && tr.state.selection.main.head !== g.pos ? null : g;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (g) =>
      g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none),
});

let ghostTimer: ReturnType<typeof setTimeout> | undefined;
let ghostCtl: AbortController | null = null;
function cancelGhost() { clearTimeout(ghostTimer); ghostCtl?.abort(); ghostCtl = null; }
function scheduleGhost(v: EditorView, delay = 380) {
  cancelGhost();
  ghostTimer = setTimeout(() => requestGhost(v), delay);
}

/** Places where a prose suggestion would only get in the way. */
const IN_COMMAND = /\\[a-zA-Z]*$|\\(?:label|ref|eqref|autoref|[cC]ref|pageref|input|include|includegraphics|begin|end|[a-zA-Z]*cite[a-zA-Z]*)\*?(?:\[[^\]]*\])*\{[^}]*$/;

async function requestGhost(v: EditorView) {
  if (lang === "plain") return;
  const sel = v.state.selection.main;
  if (!sel.empty || completionStatus(v.state)) return;
  const pos = sel.head;
  const line = v.state.doc.lineAt(pos);
  if (v.state.sliceDoc(pos, line.to).trim()) return; // only at the end of a line
  const lineBefore = v.state.sliceDoc(line.from, pos);
  if (lang === "tex" && (lineBefore.trimStart().startsWith("%") || IN_COMMAND.test(lineBefore))) return;
  const before = v.state.sliceDoc(Math.max(0, pos - 6000), pos);
  if (before.trim().length < 12) return;
  const after = v.state.sliceDoc(pos, Math.min(v.state.doc.length, pos + 600));
  const outline = proj.outline.map((o) => "  ".repeat(o.level) + o.title).join("\n");
  const ctl = (ghostCtl = new AbortController());
  try {
    const res = await post("/api/complete", { before, after, lang, section: sectionAt(v.state).path, outline }, ctl.signal);
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (ctl.signal.aborted || v.state.selection.main.head !== pos) { ctl.abort(); return; }
      v.dispatch({ effects: setGhost.of({ pos, text }) });
    }
  } catch { /* aborted or model offline — stay quiet while writing */ }
}

function acceptGhost(v: EditorView, wordOnly = false) {
  const g = v.state.field(ghostField);
  if (!g) return false;
  const take = wordOnly ? (/^\s*\S+/.exec(g.text)?.[0] ?? g.text) : g.text;
  const rest = g.text.slice(take.length);
  const end = g.pos + take.length;
  cancelGhost();
  v.dispatch({
    changes: { from: g.pos, insert: take },
    selection: { anchor: end },
    effects: setGhost.of(rest ? { pos: end, text: rest } : null),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

const appKeys = Prec.highest(keymap.of([
  { key: "Tab", run: (v) => acceptGhost(v) || true },
  { key: "Mod-ArrowRight", run: (v) => acceptGhost(v, true) },
  { key: "Escape", run: (v) => { cancelGhost(); if (!v.state.field(ghostField)) return false; v.dispatch({ effects: setGhost.of(null) }); return true; } }, // also drops a suggestion still on its way
  { key: "Alt-\\", run: (v) => { scheduleGhost(v, 0); return true; } },
  { key: "Mod-j", run: () => { findArguments(); return true; } },
  { key: "Mod-k", run: () => { openPalette(); return true; } },
  { key: "Mod-.", run: (v) => { const hit = misspelledAt(v, v.state.selection.main.head); if (!hit) return false; const c = v.coordsAtPos(hit.from); openSpellMenu(v, hit, c?.left ?? 200, c?.bottom ?? 200); return true; } },
  { key: "Mod-b", run: (v) => { const p = paneOf(v); if (!p || p.lang === "plain") return false; fmt.bold(v, p.lang); return true; } },
  { key: "Mod-i", run: (v) => { const p = paneOf(v); if (!p || p.lang === "plain") return false; fmt.italic(v, p.lang); return true; } },
  { key: "Mod-m", run: (v) => { fmt.inlineMath(v); return true; } },
  ...["Mod-Shift-=", "Mod-+"].map((key) => ({ key, run: (v: EditorView) => { const p = paneOf(v); if (!p || p.lang === "plain") return false; fmt.script(v, p.lang, true); return true; } })),
  ...["Mod-Shift--", "Mod-_"].map((key) => ({ key, run: (v: EditorView) => { const p = paneOf(v); if (!p || p.lang === "plain") return false; fmt.script(v, p.lang, false); return true; } })),
  { key: "Mod-\\", run: () => { setSidebar(mainEl.classList.contains("no-side")); return true; } },
  { key: "Mod-Enter", run: () => { build(); return true; } },
  { key: "Mod-Shift-p", run: () => { toPdf(); return true; } },
  { key: "Mod-s", run: () => { active.dirty = true; save(); return true; } },
  { key: "Mod-Shift-d", run: () => { toggleDictation(); return true; } },
  { key: "Mod-Alt-m", run: () => { showTab("review"); $("comment-text").focus(); return true; } },
  { key: "Mod-Shift-e", run: () => { setMode(!suggesting); return true; } },
]));

// ---------- citations: marking ----------
function citeClass(ks: string[], l: Lang) {
  if (ks.every((k) => projectKeys.has(k))) return Decoration.mark({ class: "cm-cite" });
  if (ks.every((k) => projectKeys.has(k) || libraryKeys.has(k)))
    return l === "tex"
      ? Decoration.mark({ class: "cm-cite cm-cite-lib", attributes: { title: "In your library — copied into the bibliography when this file saves" } })
      : Decoration.mark({ class: "cm-cite" });
  return Decoration.mark({ class: "cm-cite cm-cite-unknown", attributes: { title: "This key is not in your library or bibliography" } });
}

function marker(deco: MatchDecorator) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) { this.decorations = deco.createDeco(v); }
      update(u: ViewUpdate) { this.decorations = deco.updateDeco(u, this.decorations); }
    },
    { decorations: (v) => v.decorations },
  );
}
const citeMarks = (l: Lang) =>
  l === "tex"
    ? marker(new MatchDecorator({ regexp: new RegExp(CITE_TEX.source, "g"), decoration: (m) => citeClass(texKeys(m[0]), l) }))
    : marker(new MatchDecorator({ regexp: /\[[^\[\]\n]*@[\w:.\-]+[^\[\]\n]*\]/g, decoration: (m) => citeClass(mdKeys(m[0]), l) }));
const headingMarks = () =>
  marker(new MatchDecorator({ regexp: /\\(?:chapter|(?:sub){0,2}section)\*?\{[^}\n]*\}/g, decoration: () => Decoration.mark({ class: "cm-heading-line" }) }));

// ---------- citations and cross-references: completion ----------
async function citeOptions(q: string) {
  const res = await fetch(`/api/cite?q=${encodeURIComponent(q)}`);
  return (await res.json()) as { key: string; title: string; authors: string; year: string }[];
}

async function complete(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (lang === "tex") {
    // inside \cite{...}: complete the key being typed
    const inCite = ctx.matchBefore(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*/);
    if (inCite) {
      const frag = /[^{,\s]*$/.exec(inCite.text)![0];
      const hits = await citeOptions(frag);
      return hits.length ? { from: ctx.pos - frag.length, filter: false, options: hits.map((r) => ({ label: r.key, detail: `${r.authors} ${r.year}`.trim(), info: r.title })) } : null;
    }
    // inside \ref{...}: complete from the labels defined anywhere in the dissertation
    const inRef = ctx.matchBefore(/\\(?:ref|eqref|autoref|[cC]ref|pageref|nameref)\{[^}]*/);
    if (inRef) {
      const frag = /[^{,\s]*$/.exec(inRef.text)![0];
      return { from: ctx.pos - frag.length, options: proj.labels.map((label) => ({ label, type: "variable" })) };
    }
  }
  // @fragment anywhere in prose: search the library and drop in a finished citation
  const at = ctx.matchBefore(/@[\w:.\-]*/);
  if (!at || (at.from > 0 && !/[\s(\[;~]/.test(ctx.state.sliceDoc(at.from - 1, at.from)))) return null;
  const hits = await citeOptions(at.text.slice(1));
  if (!hits.length) return null;
  const tex = lang === "tex";
  return {
    from: tex ? at.from : at.from + 1,
    filter: false,
    options: hits.map((r) => ({ label: r.key, detail: `${r.authors} ${r.year}`.trim(), info: r.title, apply: tex ? `\\citep{${r.key}}` : r.key })),
  };
}

/** Insert a citation at the cursor, merging into one that ends right there. */
function insertCite(key: string) {
  const pos = view.state.selection.main.head;
  const back = view.state.sliceDoc(Math.max(0, pos - 240), pos);
  const adjacent = lang === "tex" ? /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*\}(\s*)$/.exec(back) : /\[[^\[\]]*@[^\[\]]*\](\s*)$/.exec(back);
  if (adjacent) {
    const have = lang === "tex" ? texKeys(adjacent[0]) : mdKeys(adjacent[0]);
    const at = pos - adjacent[1]!.length - 1; // just before the closing bracket
    if (!have.includes(key)) view.dispatch({ changes: { from: at, insert: lang === "tex" ? `, ${key}` : `; @${key}` } });
  } else {
    const insert = `${back && !/\s$/.test(back) ? " " : ""}${citeText([key])}`;
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
  }
  view.focus();
}

// ---------- suggestions: references + evidence ----------
function paragraphAt(state: EditorState) {
  const doc = state.doc;
  let n = doc.lineAt(state.selection.main.head).number;
  while (n > 1 && !doc.line(n).text.trim()) n--;
  let from = n, to = n;
  while (from > 1 && doc.line(from - 1).text.trim()) from--;
  while (to < doc.lines && doc.line(to + 1).text.trim()) to++;
  return doc.sliceString(doc.line(from).from, doc.line(to).to);
}

const HEADING = /\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{(.*)\}|^(#{1,4})\s+(.+)$/;
/** The section the cursor is in: its heading path ("Introduction > Background") and its text. */
function sectionAt(state: EditorState) {
  const doc = state.doc;
  const here = doc.lineAt(state.selection.main.head).number;
  const levels = ["chapter", "section", "subsection", "subsubsection"];
  const path: string[] = [];
  let start = 1, depth = 99;
  for (let n = here; n >= 1; n--) {
    const m = HEADING.exec(doc.line(n).text);
    if (!m) continue;
    const level = m[1] ? levels.indexOf(m[1]) : m[3]!.length - 1;
    if (level >= depth) continue;
    if (depth === 99) start = n;
    depth = level;
    path.unshift((m[2] ?? m[4] ?? "").replace(/\\[a-zA-Z]+\s*|[{}]/g, "").trim());
  }
  if (!path.length) path.push(proj.outline.filter((o) => o.file === current && o.level === 0).map((o) => o.title)[0] ?? "");
  let end = doc.lines;
  for (let n = here + 1; n <= doc.lines; n++) if (HEADING.test(doc.line(n).text)) { end = n - 1; break; }
  return { path: path.filter(Boolean).join(" > "), title: path[path.length - 1] ?? "", text: doc.sliceString(doc.line(start).from, doc.line(end).to) };
}

/** Line number where the paragraph under the cursor starts. */
function paragraphLine(state: EditorState) {
  const doc = state.doc;
  let n = doc.lineAt(state.selection.main.head).number;
  while (n > 1 && !doc.line(n).text.trim()) n--;
  while (n > 1 && doc.line(n - 1).text.trim()) n--;
  return n;
}

let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let lastQuery = "";
function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    if (lang === "plain") return;
    if (!$("tab-library").hidden && !$<HTMLInputElement>("lib-q").value.trim()) loadLibrary();
    const text = paragraphAt(view.state);
    if (text === lastQuery) return;
    lastQuery = text;
    if (text.trim().length < 20) return;
    const res = await post("/api/suggest", { text }).catch(() => null);
    if (!res?.ok || text !== lastQuery) return;
    const { refs, evidence } = await res.json();
    renderRefs(refs);
    renderEvidence(evidence);
    mapCited = citedIn(text);
    mapSuggested = [...refs.map((r: any) => r.key), ...evidence.map((e: any) => e.cite).filter(Boolean)];
    updateMapFocus();
  }, 500);
}

function renderRefs(refs: any[]) {
  $("refs").replaceChildren(
    ...(refs.length
      ? refs.map((r) => withView(r.key,
          h("button", { class: "card", type: "button", title: "Insert citation", onclick: () => insertCite(r.key) },
            h("div", { class: "who" }, `${r.authors} ${r.year}`.trim() || r.key),
            h("div", { class: "title" }, r.title),
            h("div", { class: "meta" }, r.journal ? `${r.journal} · ` : "", h("span", { class: "key" }, r.key), r.inProject && " · cited", r.hasPdf && h("span", { class: "badge pdf", title: "You have the PDF: View opens it" }, "PDF")),
            r.abstract && h("div", { class: "body" }, r.abstract))))
      : [h("p", { class: "empty" }, "Nothing in your library matches this paragraph.")]),
  );
}

function renderEvidence(items: any[]) {
  $("evidence").replaceChildren(
    ...(items.length
      ? items.map((c) => {
          const card = h("button", { class: "card", type: "button", title: "Show the whole passage", onclick: () => card.classList.toggle("open") },
            h("div", { class: "meta" }, c.kind === "table" && h("span", { class: "badge" }, "table"), c.kind === "pdf" && h("span", { class: "badge" }, c.cite ? "paper" : "pdf"), c.path),
            c.cite && h("span", { class: "key", title: "Insert citation", onclick: (e: Event) => { e.stopPropagation(); insertCite(c.cite); } }, `cite ${c.cite}`),
            c.heading && h("div", { class: "who" }, c.heading),
            h("div", { class: "body" }, c.text));
          return card;
        })
      : [h("p", { class: "empty" }, "No matching passages.")]),
  );
}

// ---------- suggestions: arguments ----------
let argueCtl: AbortController | null = null;
async function findArguments() {
  showTab("suggest");
  const text = paragraphAt(view.state);
  const box = $("args");
  argueCtl?.abort();
  const ctl = (argueCtl = new AbortController());
  box.replaceChildren(h("p", { class: "busy" }, useCloud() ? `Sending this paragraph and library excerpts to ${currentJudge()!.model}…` : "Reading the paragraph against your library…"));
  box.scrollIntoView({ block: "nearest" });
  try {
    const res = await post("/api/arguments", { text, judge: judgeId }, ctl.signal);
    const data = await res.json();
    if (data.error) return box.replaceChildren(h("p", { class: "empty" }, `Could not get arguments: ${data.error}`));
    if (!data.args.length) return box.replaceChildren(h("p", { class: "empty" }, data.note ?? "No arguments found for this paragraph."));
    box.replaceChildren(...data.args.map((a: any) => {
      const refKeys = a.sources.filter((s: any) => s.id.startsWith("ref:")).map((s: any) => s.id.slice(4));
      return h("div", { class: "card" },
        h("div", {}, h("span", { class: `badge ${a.type}` }, a.type), !a.grounded && h("span", { class: "badge ungrounded" }, "no source")),
        h("div", { class: "title" }, a.text),
        a.sources.length > 0 && h("div", { class: "chips" }, ...a.sources.map((s: any) =>
          s.id.startsWith("ref:")
            ? h("button", { class: "chip", type: "button", title: "Insert citation", onclick: () => insertCite(s.id.slice(4)) }, s.label)
            : h("span", { class: "chip quiet", title: s.label }, s.label))),
        h("div", { class: "row" }, h("button", { type: "button", class: "link", onclick: () => insertText(a.text + (refKeys.length ? " " + citeText(refKeys) : "")) }, "Insert")));
    }), judgedBy(data));
  } catch {
    if (!ctl.signal.aborted) box.replaceChildren(h("p", { class: "empty" }, "Could not reach the server."));
  }
}

function insertText(text: string) {
  const pos = view.state.selection.main.head;
  const prev = view.state.sliceDoc(Math.max(0, pos - 1), pos);
  const insert = (prev && !/\s/.test(prev) ? " " : "") + text;
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
  view.focus();
}

// ---------- editor ----------
const proseStyle = HighlightStyle.define([
  { tag: t.heading1, class: "tok-h tok-h1" },
  { tag: t.heading2, class: "tok-h tok-h2" },
  { tag: t.heading, class: "tok-h" },
  { tag: t.emphasis, class: "tok-em" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.processingInstruction, class: "tok-meta" },
  { tag: t.monospace, class: "tok-code" },
  { tag: t.quote, class: "tok-quote" },
]);
const texStyle = HighlightStyle.define([
  { tag: [t.tagName, t.atom, t.standard(t.name)], class: "tok-cmd" },
  { tag: t.comment, class: "tok-comment" },
  { tag: t.bracket, class: "tok-brace" },
  { tag: [t.keyword, t.special(t.variableName), t.number], class: "tok-math" },
]);

const citeComp = new Compartment();
function languageFor(l: Lang): Extension[] {
  if (l === "tex") return [StreamLanguage.define(stex), syntaxHighlighting(texStyle), headingMarks(), citeComp.of(citeMarks(l))];
  if (l === "md") return [markdown(), syntaxHighlighting(proseStyle), citeComp.of(citeMarks(l))];
  return [citeComp.of([])];
}

// line numbers down the left edge: one per source line (a wrapped paragraph is one line), matching
// the file:line references in Checks, the Log and build errors
let showNumbers = remember.get("margin.lineNumbers") === "1";
const gutterComp = new Compartment();
const gutter = () => (showNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []);
function setNumbers(on: boolean) {
  showNumbers = on;
  remember.set("margin.lineNumbers", on ? "1" : "0");
  for (const p of panes) p.view.dispatch({ effects: gutterComp.reconfigure(gutter()) });
  $("numbers").setAttribute("aria-pressed", String(on));
}


// visual view: figures shown as figures, with a pencil that opens the Edit figure dialog
let showVisual = remember.get("margin.visual") === "1";
const visualComp = new Compartment();
const visual = (l: Lang) => (showVisual && l === "tex" ? visualFigures((v, from, to) => openFigureEdit(v, from, to)) : []);
function setVisual(on: boolean) {
  showVisual = on;
  remember.set("margin.visual", on ? "1" : "0");
  for (const p of panes) p.view.dispatch({ effects: visualComp.reconfigure(visual(p.lang)) });
  $("visual").setAttribute("aria-pressed", String(on));
}

let figEditing: { view: EditorView; from: number; to: number; width: number | null } | null = null;
async function openFigureEdit(v: EditorView, from: number, to: number) {
  const f = parseFigure(v.state.sliceDoc(from, to));
  const { figures } = await (await fetch("/api/figures")).json().catch(() => ({ figures: [] }));
  const files: string[] = [...new Set([f.file, ...figures.map((x: any) => x.file)].filter(Boolean))];
  const pick = $<HTMLSelectElement>("figedit-file");
  pick.replaceChildren(...files.map((x) => h("option", { value: x }, x)));
  pick.value = f.file;
  $<HTMLInputElement>("figedit-cap-on").checked = f.caption !== null;
  $<HTMLTextAreaElement>("figedit-cap").value = f.caption ?? "";
  $<HTMLInputElement>("figedit-label-on").checked = f.label !== null;
  $<HTMLInputElement>("figedit-label").value = f.label ?? `fig:${(f.file.split("/").pop() ?? "figure").replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  figEditing = { view: v, from, to, width: [0.25, 0.5, 0.75, 1].includes(f.width ?? -1) ? f.width : null };
  renderFigEdit();
  $<HTMLDialogElement>("figedit").showModal();
}
function renderFigEdit() {
  if (!figEditing) return;
  const file = $<HTMLSelectElement>("figedit-file").value;
  $<HTMLImageElement>("figedit-img").src = `/api/figure/thumb?file=${encodeURIComponent(file)}&size=large`;
  $<HTMLTextAreaElement>("figedit-cap").disabled = !$<HTMLInputElement>("figedit-cap-on").checked;
  $<HTMLInputElement>("figedit-label").disabled = !$<HTMLInputElement>("figedit-label-on").checked;
  for (const b of $("figedit-width").querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.w) === figEditing.width));
}
function applyFigEdit() {
  if (!figEditing) return;
  const { view: v, from, to, width } = figEditing;
  const next = editFigure(v.state.sliceDoc(from, to), {
    file: $<HTMLSelectElement>("figedit-file").value,
    width,
    caption: $<HTMLInputElement>("figedit-cap-on").checked ? $<HTMLTextAreaElement>("figedit-cap").value.trim() : null,
    label: $<HTMLInputElement>("figedit-label-on").checked ? $<HTMLInputElement>("figedit-label").value.trim() : null,
  });
  if (next !== v.state.sliceDoc(from, to)) v.dispatch({ changes: { from, to, insert: next }, userEvent: "input.figure" });
  figEditing = null;
  $<HTMLDialogElement>("figedit").close();
  v.focus();
}

// ---------- spelling: underlines, a correction menu, fix-all and remembered corrections ----------
const setSpell = StateEffect.define<DecorationSet>();
const spellField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) { for (const e of tr.effects) if (e.is(setSpell)) return e.value; return tr.docChanged ? v.map(tr.changes) : v; },
  provide: (f) => EditorView.decorations.from(f),
});
let spellOn = remember.get("margin.spell") !== "0";
let spellRules: Record<string, string> = {};
const spellCounts = new WeakMap<EditorView, Map<string, number>>();
const spellLangs = new WeakMap<EditorView, Map<string, string>>();
const spellTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();
const WORDCH = /[A-Za-z\u00C0-\u024F'’]/;

function scheduleSpell(v: EditorView, wait = 900) {
  clearTimeout(spellTimers.get(v));
  spellTimers.set(v, setTimeout(() => runSpell(v), wait));
}
async function runSpell(v: EditorView) {
  const p = paneOf(v);
  if (!p) return;
  if (!spellOn || p.lang === "plain") { v.dispatch({ effects: setSpell.of(Decoration.none) }); return; }
  const text = v.state.doc.toString();
  const r = await post("/api/spell", { text, lang: p.lang }).then((x) => x.json()).catch(() => null);
  if (!r?.misspelled || v.state.doc.toString() !== text) return; // typed since: the next run will catch up
  spellRules = r.rules ?? spellRules;
  const marks = r.misspelled.flatMap((m: { word: string; at: number[]; lang?: string }) => m.at.map((at) => Decoration.mark({ class: "cm-misspelled", attributes: { "data-word": m.word, "data-lang": m.lang ?? "en" } }).range(at, at + m.word.length)));
  spellLangs.set(v, new Map(r.misspelled.map((m: { word: string; lang?: string }) => [m.word, m.lang ?? "en"])));
  spellCounts.set(v, new Map(r.misspelled.map((m: { word: string; count: number }) => [m.word, m.count])));
  v.dispatch({ effects: setSpell.of(Decoration.set(marks, true)) });
}
function setSpelling(on: boolean) {
  spellOn = on;
  remember.set("margin.spell", on ? "1" : "0");
  for (const p of panes) runSpell(p.view);
}
/** Keep the capital of the word being replaced: "Teh" -> "The". */
const likeCase = (from: string, to: string) => (/^[A-Z]/.test(from) && /^[a-z]/.test(to) ? to[0]!.toUpperCase() + to.slice(1) : to);

/** The misspelled word at a position, if any. */
function misspelledAt(v: EditorView, pos: number): { from: number; to: number; word: string } | null {
  let hit: { from: number; to: number; word: string } | null = null;
  v.state.field(spellField).between(pos, pos, (from, to) => { hit = { from, to, word: v.state.sliceDoc(from, to) }; return false; });
  return hit;
}
function replaceEvery(v: EditorView, word: string, to: string): number {
  const changes: { from: number; to: number; insert: string }[] = [];
  const iter = v.state.field(spellField).iter();
  for (; iter.value; iter.next()) if (v.state.sliceDoc(iter.from, iter.to) === word) changes.push({ from: iter.from, to: iter.to, insert: likeCase(word, to) });
  if (changes.length) v.dispatch({ changes, userEvent: "input.spell" });
  return changes.length;
}
async function openSpellMenu(v: EditorView, hit: { from: number; to: number; word: string }, x: number, y: number) {
  const menu = $("spellmenu"), n = spellCounts.get(v)?.get(hit.word) ?? 1;
  const close = () => { menu.hidden = true; };
  const item = (label: string, run: () => void, cls = "") => h("button", { type: "button", class: cls, onclick: () => { close(); run(); v.focus(); } }, label);
  const tail = [
    h("hr", {}),
    item(`Add “${hit.word}” to the dictionary`, async () => { await post("/api/spell/words", { add: hit.word }); for (const p of panes) runSpell(p.view); }),
    item("Spelling words and corrections…", openSpellList),
  ];
  menu.replaceChildren(h("div", { class: "head" }, hit.word, spellLangs.get(v)?.get(hit.word) === "es" ? h("span", { class: "quiet" }, " · español") : "", n > 1 ? h("span", { class: "quiet" }, ` · ${n} times in this file`) : ""), h("p", { class: "empty" }, "Looking up…"), ...tail);
  menu.hidden = false;
  const z = Number(getComputedStyle(document.documentElement).zoom) || 1;
  Object.assign(menu.style, { left: `${Math.min(x / z, innerWidth / z - 300)}px`, top: `${Math.min(y / z + 6, innerHeight / z - 260)}px` });
  const { suggestions = [] } = await fetch(`/api/spell/suggest?word=${encodeURIComponent(hit.word)}&lang=${spellLangs.get(v)?.get(hit.word) ?? "en"}`).then((r) => r.json()).catch(() => ({}));
  if (menu.hidden) return;
  const rows = (suggestions as string[]).flatMap((s) => [
    h("div", { class: "row" },
      item(likeCase(hit.word, s), () => { const now = misspelledAt(v, hit.from) ?? hit; v.dispatch({ changes: { from: now.from, to: now.to, insert: likeCase(hit.word, s) }, userEvent: "input.spell" }); }, "fix"),
      item(n > 1 ? `all ${n} + remember` : "+ remember", async () => {
        replaceEvery(v, hit.word, s);
        const r = await post("/api/spell/words", { rule: { from: hit.word, to: s } }).then((x) => x.json()).catch(() => null);
        if (r?.rules) spellRules = r.rules;
        $("save").textContent = `“${hit.word}” will be corrected to “${s}” from now on`;
      }, "link"))]);
  menu.replaceChildren(menu.firstChild!, ...(rows.length ? rows : [h("p", { class: "empty" }, "No suggestions.")]), ...tail);
}
async function openSpellList() {
  const s = await fetch("/api/spell/words").then((r) => r.json()).catch(() => ({ words: [], rules: {} }));
  spellRules = s.rules;
  const change = async (body: object) => { await post("/api/spell/words", body); for (const p of panes) runSpell(p.view); openSpellList(); };
  $("spell-rules").replaceChildren(...(Object.keys(s.rules).length
    ? Object.entries(s.rules as Record<string, string>).map(([from, to]) => h("div", { class: "row" }, h("span", {}, `${from} → ${to}`), h("button", { type: "button", class: "link", onclick: () => change({ unrule: from }) }, "Remove")))
    : [h("p", { class: "empty" }, "None yet. Right-click a misspelled word and choose “remember”.")]));
  $("spell-words").replaceChildren(...(s.words.length
    ? (s.words as string[]).map((w) => h("div", { class: "row" }, h("span", {}, w), h("button", { type: "button", class: "link", onclick: () => change({ remove: w }) }, "Remove")))
    : [h("p", { class: "empty" }, "None yet.")]));
  const d = $<HTMLDialogElement>("spell-list");
  if (!d.open) d.showModal();
}
/** A remembered correction is applied the moment you finish typing the word. */
const autocorrect = EditorView.inputHandler.of((v, from, to, text) => {
  if (!spellOn || from !== to || text.length !== 1 || WORDCH.test(text)) return false;
  let start = from;
  while (start > 0 && WORDCH.test(v.state.sliceDoc(start - 1, start))) start--;
  const word = v.state.sliceDoc(start, from), fix = word && spellRules[word.toLowerCase()];
  if (!fix || (start > 0 && v.state.sliceDoc(start - 1, start) === "\\")) return false;
  // never inside a citation key, label or file name: those are identifiers, not words
  const lineStart = v.state.doc.lineAt(start).from;
  if (/\\[a-zA-Z]*(?:cite|ref|label|includegraphics|input|include|url)[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*$/.test(v.state.sliceDoc(lineStart, start))) return false;
  const insert = likeCase(word, fix) + text;
  v.dispatch({ changes: { from: start, to: from, insert }, selection: { anchor: start + insert.length }, userEvent: "input.type" });
  return true;
});
/** The same corrections for text that arrives whole, such as dictation. */
const applyRules = (text: string) => (Object.keys(spellRules).length ? text.replace(/[A-Za-z\u00C0-\u024F'’]+/g, (w) => (spellRules[w.toLowerCase()] ? likeCase(w, spellRules[w.toLowerCase()]!) : w)) : text);

// ---------- moving through the thesis: next / previous section at the ends of each file ----------
/** The thesis files in the order main.tex reads them (front matter, chapters, appendices). */
function readingOrder(): string[] {
  return (proj?.files ?? []).filter((f: any) => f.linked && /\.(tex|md)$/.test(f.path) && f.path !== proj.root && !/(^|\/)packages\.tex$/.test(f.path)).map((f: any) => f.path);
}
function neighbour(file: string, dir: 1 | -1): { path: string; title: string } | null {
  const order = readingOrder(), i = order.indexOf(file);
  const path = i < 0 ? null : order[i + dir];
  if (!path) return null;
  const head = proj.outline.find((o: any) => o.file === path);
  return { path, title: head?.title || path.split("/").pop()!.replace(/\.(tex|md)$/, "").replace(/_/g, " ") };
}
async function goToSection(p: Pane, path: string, atEnd: boolean) {
  await openFile(path, p);
  const v = p.view, pos = atEnd ? v.state.doc.length : 0;
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  v.scrollDOM.scrollTop = atEnd ? v.scrollDOM.scrollHeight : 0;
  v.focus();
}
class SectionNav extends WidgetType {
  constructor(readonly dir: 1 | -1, readonly target: { path: string; title: string }) { super(); }
  eq(o: SectionNav) { return o.dir === this.dir && o.target.path === this.target.path && o.target.title === this.target.title; }
  toDOM(view: EditorView) {
    const label = this.dir === 1 ? `Next: ${this.target.title}` : `Previous: ${this.target.title}`;
    const b = h("button", { type: "button", class: `secnav ${this.dir === 1 ? "next" : "prev"}`, title: this.target.path },
      h("span", { class: "arrow" }, this.dir === 1 ? "↓" : "↑"), h("span", {}, label),
      this.dir === 1 ? h("span", { class: "hint" }, "or keep scrolling") : "");
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { const p = paneOf(view); if (p) goToSection(p, this.target.path, this.dir === -1); });
    return h("div", { class: `secnav-wrap ${this.dir === 1 ? "next" : "prev"}` }, b);
  }
  ignoreEvent() { return true; }
}
type NavTargets = { prev: { path: string; title: string } | null; next: { path: string; title: string } | null };
const setNav = StateEffect.define<NavTargets>();
const navField = StateField.define<NavTargets>({
  create: () => ({ prev: null, next: null }),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setNav)) return e.value; return v; },
  // block widgets must come from state, not a view plugin
  provide: (f) => EditorView.decorations.compute([f, "doc"], (st) => {
    const n = st.field(f), marks = [];
    if (n.prev) marks.push(Decoration.widget({ widget: new SectionNav(-1, n.prev), block: true, side: -1 }).range(0));
    if (n.next) marks.push(Decoration.widget({ widget: new SectionNav(1, n.next), block: true, side: 1 }).range(st.doc.length));
    return Decoration.set(marks, true);
  }),
});
/** Point each pane's end-of-file buttons at the right neighbours. */
function refreshNav(only?: Pane) {
  for (const p of only ? [only] : panes) {
    if (!p.file) continue;
    const want = { prev: neighbour(p.file, -1), next: neighbour(p.file, 1) }, have = p.view.state.field(navField, false);
    if (have && JSON.stringify(have) === JSON.stringify(want)) continue;
    p.view.dispatch({ effects: setNav.of(want) });
  }
}
const sectionNav = [navField, EditorView.domEventHandlers({
    // scrolling on past the end of a file carries on into the next one, as in a Google Doc
    wheel(e, v) {
      const p = paneOf(v), s = v.scrollDOM;
      if (!p?.file || e.deltaY <= 0) { overscroll = 0; return false; }
      if (s.scrollTop + s.clientHeight < s.scrollHeight - 4) { overscroll = 0; return false; }
      const next = neighbour(p.file, 1);
      if (!next) return false;
      overscroll += e.deltaY;
      clearTimeout(overscrollTimer);
      overscrollTimer = setTimeout(() => { overscroll = 0; document.querySelectorAll(".secnav.next").forEach((b) => (b as HTMLElement).style.removeProperty("--pull")); }, 900);
      document.querySelectorAll<HTMLElement>(".secnav.next").forEach((b) => b.style.setProperty("--pull", String(Math.min(1, overscroll / 900))));
      if (overscroll > 900) { overscroll = 0; goToSection(p, next.path, false); }
      return false;
    },
})];
let overscroll = 0, overscrollTimer: ReturnType<typeof setTimeout> | undefined;

const extensions = (l: Lang, review: Review = emptyReview()) => [
  errSpotField,
  sectionNav,
  spellField,
  autocorrect,
  EditorView.domEventHandlers({
    contextmenu(e, v) {
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      const hit = pos === null ? null : misspelledAt(v, pos);
      if (!hit) return false;
      e.preventDefault();
      openSpellMenu(v, hit, e.clientX, e.clientY);
      return true;
    },
  }),
  visualComp.of(visual(l)),
  suggestingField.init(() => suggesting),
  reviewField.init(() => review),
  gutterComp.of(gutter()),
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  languageFor(l),
  placeholder("Start writing…"),
  ghostField,
  dictField,
  appKeys,
  autocompletion({ override: [complete], icons: false }),
  keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
  EditorView.contentAttributes.of({ spellcheck: l === "plain" ? "false" : "true" }),
  EditorView.domEventHandlers({
    dragover(e) { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); $("editor").classList.add("dropping"); return true; } return false; },
    dragleave() { $("editor").classList.remove("dropping"); return false; },
    drop(e, v) {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      $("editor").classList.remove("dropping");
      dropFigures(files, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head);
      return true;
    },
  }),
  EditorView.domEventHandlers({ focus(_e, v) { const p = paneOf(v); if (p) activate(p); return false; } }),
  // click commented (highlighted) words: open that comment in the Review panel
  EditorView.domEventHandlers({
    click(e, v) {
      const hit = (e.target as HTMLElement).closest?.(".cm-comment") as HTMLElement | null;
      if (!hit || e.button !== 0 || e.shiftKey || e.metaKey || e.altKey || !v.state.selection.main.empty) return false; // a drag or a modified click selects text
      const ids: string[] = [];
      for (let n: HTMLElement | null = hit; n && n !== v.contentDOM; n = n.parentElement) if (n.dataset.comment) ids.push(n.dataset.comment);
      setTimeout(() => openComments(ids), 0);
      return false; // the caret still goes where you clicked
    },
  }),
  EditorView.updateListener.of((u) => {
    const p = paneOf(u.view);
    if (!p) return;
    const reviewChanged = u.startState.field(reviewField) !== u.state.field(reviewField);
    // your own keystrokes only (not paste, accepted suggestions, citation picks or updates from elsewhere)
    for (const tr of u.transactions) if (tr.isUserEvent("input.type")) {
      let ins = 0, del = 0;
      tr.changes.iterChanges((a, b, _c, _d, text) => { ins += text.length; del += b - a; });
      noteTyped(Math.max(0, ins - del));
    }
    if (u.docChanged) scheduleSpell(u.view);
    if (u.docChanged) p.minimap.rebuild(); else if (reviewChanged || u.geometryChanged || u.viewportChanged) p.minimap.redraw();
    if (u.docChanged || reviewChanged) {
      p.dirty = true;
      clearTimeout(p.saveTimer);
      p.saveTimer = setTimeout(() => save(p), 700);
    }
    if (p !== active) return; // everything below is about the pane you are working in
    if (reviewChanged) renderReview();
    if (u.docChanged || reviewChanged) $("save").textContent = "Edited";
    if (u.docChanged && look.sound) {
      for (const tr of u.transactions) {
        if (tr.isUserEvent("delete")) { playKey(look, "delete"); break; }
        if (!tr.isUserEvent("input.type")) continue;
        let text = "";
        tr.changes.iterChanges((_a, _b, _c, _d, ins) => { text += ins.toString(); });
        playKey(look, text.includes("\n") ? "enter" : text === " " ? "space" : "key");
        break;
      }
    }
    if (u.docChanged) {
      if (u.state.field(ghostField)) cancelGhost(); // typed through the suggestion: keep what is shown
      else if (!rec) scheduleGhost(u.view); // no suggestions while you are dictating
    } else if (u.selectionSet && !u.state.field(ghostField)) cancelGhost();
    if (u.docChanged || u.selectionSet) scheduleSuggest();
    if (u.selectionSet || u.docChanged) { renderWords(); syncFormatBar(); markOutline(); }
  }),
];

/** True when a line cites a key that is in neither the bibliography nor the library. */
const hasUnknownCite = (line: string) => citedIn(line).some((k) => !projectKeys.has(k) && !libraryKeys.has(k));

const MAX_PANES = 4;
function createPane(): Pane {
  const head = h("div", { class: "pane-head" });
  const body = h("div", { class: "pane-body" });
  const el = h("div", { class: "pane" }, head, body);
  const v = new EditorView({ parent: body, state: EditorState.create({ doc: "", extensions: extensions("tex") }) });
  const canvas = h("canvas", { class: "minimap", "aria-label": "Document overview: click or drag to scroll", title: "Click or drag to move through the document" });
  body.append(canvas);
  const p: Pane = { el, head, view: v, minimap: createMinimap(v, canvas, () => v.state.field(reviewField), hasUnknownCite), file: "", lang: "tex", dirty: false, orphans: [], hadReview: false };
  el.addEventListener("pointerdown", () => activate(p), true);
  addGrip(el);
  dragToSnap(el, head);
  if (panes.length && active?.el.isConnected) dock(el, layoutReady ? active.el : panes[panes.length - 1]!.el, "right"); else $("editor").append(el);
  panes.push(p);
  return p;
}

/** Make `p` the pane that suggestions, citations, the side panel and the top bar refer to. */
function activate(p: Pane) {
  if (active === p) return;
  active = p; view = p.view; current = p.file; lang = p.lang;
  cancelGhost();
  for (const x of panes) x.el.classList.toggle("active", x === p);
  $("path").textContent = p.file;
  $("save").textContent = "";
  if (p.file) { document.title = `${p.file.split("/").pop()} — Vega Fluo`; remember.set("margin.file", p.file); }
  renderFiles();
  renderOutline();
  renderReview();
  renderWords();
  if (!$("tab-review").hidden) renderShare();
  lastQuery = "";
  scheduleSuggest();
}

function renderPaneHeads() {
  $("editor").classList.toggle("multi", panes.length > 1 || !!document.getElementById("figpane") || !!document.getElementById("paperpane"));
  remember.set("margin.panes", JSON.stringify(panes.map((p) => p.file).filter(Boolean)));
  panes.forEach((p) => p.head.replaceChildren(...[
    h("span", { class: "name" }, p.file || "(empty)"),
    panes.length > 1 && h("button", { type: "button", class: "link", title: "Close this pane", onclick: () => closePane(p) }, "×"),
  ].filter((x): x is HTMLElement => !!x)));
}

// ---------- pane layout: drag a pane by its title bar and drop it on a highlighted zone ----------
// The arrangement is a tree of splits kept in the DOM itself: #editor is the outermost split, and a
// .split element is a row or column of panes (or further splits). Halves, thirds and quadrants all
// fall out of two moves: drop on the edge of the whole editor, or on a side of another pane.
type Side = "left" | "right" | "top" | "bottom";
const isCol = (el: Element) => el.classList.contains("col");
const evenOut = (box: Element) => { for (const k of box.children) if (k.matches(".pane, .split")) (k as HTMLElement).style.flex = ""; };

/** Remove splits that hold one thing or nothing, so the tree never grows stale wrappers. */
function tidyLayout() {
  const root = $("editor");
  for (let again = true; again; ) {
    again = false;
    for (const sp of root.querySelectorAll<HTMLElement>(".split")) {
      const kids = [...sp.children].filter((k) => k.matches(".pane, .split"));
      if (kids.length > 1) continue;
      if (kids[0]) { (kids[0] as HTMLElement).style.flex = sp.style.flex; sp.replaceWith(kids[0]); } else sp.remove();
      again = true;
    }
    const kids = [...root.children].filter((k) => k.matches(".pane, .split"));
    if (kids.length === 1 && kids[0]!.matches(".split")) { // the editor holds a single split: become it
      root.classList.toggle("col", isCol(kids[0]!));
      kids[0]!.replaceWith(...[...kids[0]!.children].filter((k) => k.matches(".pane, .split")));
      again = true;
    }
  }
  // a split inside a split of the same direction is just more of the same row or column
  for (const sp of root.querySelectorAll<HTMLElement>(".split")) if (isCol(sp) === isCol(sp.parentElement!)) { sp.replaceWith(...[...sp.children].filter((k) => k.matches(".pane, .split"))); evenOut(root); }
}

/** Put `el` on `side` of `target` (a pane, or the whole editor). */
function dock(el: HTMLElement, target: HTMLElement, side: Side) {
  const root = $("editor");
  const scroll = panes.map((p) => [p, p.view.scrollDOM.scrollTop] as const); // moving an editor in the page resets its scroll
  const col = side === "top" || side === "bottom", first = side === "left" || side === "top";
  el.remove();
  el.style.flex = "";
  if (target === root) {
    if (isCol(root) !== col && root.querySelector(".pane, .split")) {
      const inner = h("div", { class: `split${isCol(root) ? " col" : ""}` }, ...[...root.children].filter((k) => k.matches(".pane, .split")));
      addGrip(inner);
      root.append(inner);
    }
    root.classList.toggle("col", col);
    if (first) root.prepend(el); else root.append(el);
    evenOut(root);
  } else {
    const parent = target.parentElement!;
    if (isCol(parent) === col) { target[first ? "before" : "after"](el); evenOut(parent); }
    else {
      const sp = h("div", { class: `split${col ? " col" : ""}` });
      sp.style.flex = target.style.flex;
      target.style.flex = "";
      target.replaceWith(sp);
      sp.append(...(first ? [el, target] : [target, el]));
      addGrip(sp);
    }
  }
  tidyLayout();
  for (const [p, top] of scroll) { p.view.requestMeasure(); p.view.scrollDOM.scrollTop = top; }
  saveLayout();
}

/** Where a pane would land if dropped at this point, and the rectangle to highlight. */
function snapZone(x: number, y: number, moving: HTMLElement): { target: HTMLElement; side: Side; rect: DOMRect } | null {
  const root = $("editor"), E = root.getBoundingClientRect(), edge = 44;
  if (x < E.left || x > E.right || y < E.top || y > E.bottom) return null;
  const others = [...root.querySelectorAll<HTMLElement>(".pane")].filter((p) => p !== moving);
  if (!others.length) return null;
  const outer: Side | null = x - E.left < edge ? "left" : E.right - x < edge ? "right" : y - E.top < edge ? "top" : E.bottom - y < edge ? "bottom" : null;
  if (outer) {
    const col = outer === "top" || outer === "bottom";
    const kids = [...root.children].filter((k) => k.matches(".pane, .split") && k !== moving).length;
    const share = isCol(root) === col ? 1 / (kids + 1) : 0.5; // joining a row of two makes thirds
    const w = col ? E.width : E.width * share, hh = col ? E.height * share : E.height;
    return { target: root, side: outer, rect: new DOMRect(outer === "right" ? E.right - w : E.left, outer === "bottom" ? E.bottom - hh : E.top, w, hh) };
  }
  const over = others.find((p) => { const r = p.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
  if (!over) return null;
  const r = over.getBoundingClientRect(), dx = (x - r.left) / r.width, dy = (y - r.top) / r.height;
  const side = ([["left", dx], ["right", 1 - dx], ["top", dy], ["bottom", 1 - dy]] as [Side, number][]).sort((a, b) => a[1] - b[1])[0]![0];
  const col = side === "top" || side === "bottom";
  return { target: over, side, rect: new DOMRect(side === "right" ? r.left + r.width / 2 : r.left, side === "bottom" ? r.top + r.height / 2 : r.top, col ? r.width : r.width / 2, col ? r.height / 2 : r.height) };
}

/** Let a pane be picked up by its title bar. */
function dragToSnap(el: HTMLElement, handle: HTMLElement) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, select, input, a")) return;
    const x0 = e.clientX, y0 = e.clientY;
    let zone: ReturnType<typeof snapZone> = null, started = false;
    const hint = $("snap");
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 7) return;
        started = true;
        document.body.classList.add("snapping");
        el.classList.add("moving");
        try { handle.setPointerCapture(e.pointerId); } catch { /* not essential */ }
      }
      zone = snapZone(ev.clientX, ev.clientY, el);
      hint.hidden = !zone;
      if (zone) { const z = Number(getComputedStyle(document.documentElement).zoom) || 1; Object.assign(hint.style, { left: `${zone.rect.left / z}px`, top: `${zone.rect.top / z}px`, width: `${zone.rect.width / z}px`, height: `${zone.rect.height / z}px` }); }
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("snapping");
      el.classList.remove("moving");
      hint.hidden = true;
      if (started && zone) { dock(el, zone.target, zone.side); renderPaneHeads(); }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
}

/** The arrangement as data, so it comes back the same after a reload. */
type Shape = string | { col: boolean; kids: Shape[] };
const shapeOf = (box: Element): Shape[] => [...box.children].filter((k) => k.matches(".pane, .split")).map((k) =>
  k.matches(".split") ? { col: isCol(k), kids: shapeOf(k) } : k.id === "figpane" ? "#figure" : panes.find((p) => p.el === k)?.file ?? "");
let layoutReady = false; // not until the saved arrangement has been put back at startup
function saveLayout() { if (layoutReady) remember.set("margin.layout", JSON.stringify({ col: isCol($("editor")), kids: shapeOf($("editor")) })); }
function restoreLayout() {
  layoutReady = true;
  let saved: { col: boolean; kids: Shape[] };
  try { saved = JSON.parse(remember.get("margin.layout") ?? ""); } catch { return; }
  const left = new Map(panes.map((p) => [p.file, p.el]));
  const files = (sh: Shape): string[] => (typeof sh === "string" ? [sh] : sh.kids.flatMap(files));
  if (!saved?.kids || panes.some((p) => !files(saved).includes(p.file))) return; // a different set of files: leave them side by side
  const place = (box: HTMLElement, kids: Shape[]) => {
    for (const k of kids) {
      if (typeof k === "string") { const el = left.get(k); if (el) { box.append(el); left.delete(k); } }
      else { const sp = h("div", { class: `split${k.col ? " col" : ""}` }); box.append(sp); addGrip(sp); place(sp, k.kids); }
    }
  };
  $("editor").classList.toggle("col", !!saved.col);
  place($("editor"), saved.kids);
  tidyLayout();
  for (const p of panes) p.view.requestMeasure();
}

async function closePane(p: Pane) {
  if (panes.length < 2) return;
  await save(p);
  panes.splice(panes.indexOf(p), 1);
  p.view.destroy();
  p.el.remove();
  tidyLayout();
  saveLayout();
  if (active === p) { active = undefined as any; activate(panes[0]!); panes[0]!.view.focus(); }
  renderPaneHeads();
  renderFiles();
  renderOutline();
}

/** Open a file in a second (or third) pane, next to what you already have open. */
async function openBeside(path: string) {
  const have = panes.find((p) => p.file === path);
  if (have) { activate(have); have.view.focus(); return; }
  const p = panes.length < MAX_PANES ? createPane() : panes[panes.length - 1]!;
  await openFile(path, p);
  activate(p);
  p.view.focus();
}

function setMinimap(on: boolean) { $("editor").classList.toggle("no-minimap", !on); remember.set("margin.minimap", on ? "1" : "0"); if (on) for (const p of panes) p.minimap.rebuild(); }

let autoBuild = remember.get("margin.autoBuild") === "1", autoTimer: ReturnType<typeof setTimeout> | undefined;
let buildAgain = false; // a change arrived while a build was running: build once more when it finishes
const citeSets = new Map<string, string>(); // cited keys per file at its last save
let refsTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Save review notes; if they changed elsewhere since this tab loaded them (comments imported, another
 * tab), combine: keep everything added elsewhere, apply this tab's additions, edits and deletions.
 */
async function saveReview(p: Pane, path: string, sidecar: any): Promise<Response | null> {
  const url = fileUrl(path).replace("/api/file", "/api/review");
  const put = (body: any, base: any) => fetch(url, { method: "PUT", body: JSON.stringify(body), keepalive: closing, headers: base ? { "x-base-hash": textHash(JSON.stringify(base)) } : {} }).catch(() => null);
  let r = await put(sidecar, p.syncedReview);
  if (r?.status === 409) {
    const disk = (await r.json()).disk;
    const ids = (x: any, k: string) => new Set<string>((x?.[k] ?? []).map((c: any) => c.id));
    const merged = { ...sidecar };
    for (const k of ["comments", "suggestions"]) {
      const had = ids(p.syncedReview, k), now = ids(sidecar, k);
      const deletedHere = new Set([...had].filter((id) => !now.has(id)));
      const mine = new Map((sidecar[k] ?? []).map((c: any) => [c.id, c]));
      merged[k] = [...(sidecar[k] ?? []), ...(disk[k] ?? []).filter((c: any) => !mine.has(c.id) && !deletedHere.has(c.id))];
    }
    r = await put(merged, disk);
    if (r?.ok) { p.syncedReview = merged; setTimeout(() => reloadKeepingPlace(p), 50); } // show the comments added elsewhere
    return r;
  }
  if (r?.ok) p.syncedReview = JSON.parse(JSON.stringify(sidecar));
  return r;
}
/** The file changed on disk while this tab had edits of its own: combine both, save, and show the result. */
async function mergeAndReload(p: Pane, mine: string, disk: string) {
  const { text, conflicts } = merge3(p.synced ?? disk, mine, disk);
  await fetch(fileUrl(p.file), { method: "PUT", body: text, headers: { "x-base-hash": textHash(disk) } }).catch(() => null);
  await reloadKeepingPlace(p);
  if (p === active) $("save").textContent = conflicts ? `Merged with a change made elsewhere; ${conflicts} spot${conflicts > 1 ? "s" : ""} edited in both kept your version (the other is in History)` : "Merged with a change made elsewhere";
}
/** Reload a pane from disk, keeping the cursor and scroll where they were. */
/**
 * Show what changed elsewhere (the live Google Doc, another tab) without moving what you are looking at:
 * the words at the top of the window and your cursor are followed through the change, so text added
 * above them pushes nothing on screen.
 */
async function reloadKeepingPlace(p: Pane) {
  const v = p.view, before = v.state.doc.toString(), path = p.file;
  const sel = v.state.selection.main;
  const scroller = v.scrollDOM, edge = scroller.getBoundingClientRect().top;
  const topBlock = v.lineBlockAtHeight(edge - v.documentTop);
  const topPos = topBlock.from, offset = edge - (v.documentTop + topBlock.top); // pixels of that line already scrolled past
  const hadFocus = v.hasFocus;
  p.dirty = false;
  await openFile(path, p);
  const after = p.view.state.doc.toString();
  const ops = before === after ? null : diffText(before, after);
  const map = (pos: number) => Math.min(ops ? mapToB(ops, pos) : pos, after.length);
  p.view.dispatch({ selection: { anchor: map(sel.anchor), head: map(sel.head) } });
  const anchor = map(topPos);
  const place = () => { const b = p.view.lineBlockAt(anchor); p.view.scrollDOM.scrollTop += p.view.documentTop + b.top + offset - p.view.scrollDOM.getBoundingClientRect().top; };
  place();
  requestAnimationFrame(place); // again once the new lines are measured
  if (hadFocus) p.view.focus();
}
// files changed outside this tab are picked up within a few seconds when the tab has no unsaved edits
setInterval(async () => {
  for (const p of panes) {
    if (!p.file || p.dirty || p.synced === undefined || document.hidden) continue;
    const r = await fetch(`/api/file/hash?path=${encodeURIComponent(p.file)}`).then((x) => x.json()).catch(() => null);
    const reviewChanged = r && r.review !== (p.syncedReview ? textHash(JSON.stringify(p.syncedReview)) : null);
    if (r?.hash && (r.hash !== textHash(p.synced) || reviewChanged) && !p.dirty) { await reloadKeepingPlace(p); if (p === active) $("save").textContent = "Updated from a change made elsewhere"; }
  }
}, 4000);
let closing = false; // set while the tab is closing: only then do saves need keepalive
async function save(p: Pane = active) {
  clearTimeout(p.saveTimer);
  if (!p.dirty || !p.file) return;
  p.dirty = false;
  const path = p.file;
  const say = (msg: string) => { if (p === active) $("save").textContent = msg; };
  say("Saving…");
  // the file gets accepted text only; pending suggestions and comments go to the review file beside it
  const { base, sidecar } = toBase(p.view.state.doc.toString(), p.view.state.field(reviewField));
  sidecar.orphans = p.orphans;
  const hasReview = sidecar.suggestions.length + sidecar.comments.length + p.orphans.length > 0;
  const [res, rev] = await Promise.all([
    fetch(fileUrl(path), { method: "PUT", body: base, keepalive: closing, headers: p.synced !== undefined ? { "x-base-hash": textHash(p.synced) } : {} }).catch(() => null),
    hasReview || p.hadReview ? saveReview(p, path, sidecar) : Promise.resolve({ ok: true }),
  ]);
  if (res?.status === 409) { await mergeAndReload(p, base, (await res.json()).disk); return; }
  if (!res?.ok || !rev?.ok) {
    // say what actually went wrong, and try again by itself rather than waiting for the next keystroke
    const bad = !res ? "no answer from Vega Fluo" : !res.ok ? `file save refused (${res.status})` : !rev ? "no answer saving review notes" : `review notes refused (${(rev as Response).status})`;
    const detail = res && !res.ok ? await res.text().catch(() => "") : "";
    console.warn("save failed", path, bad, detail);
    p.dirty = true;
    p.saveTries = (p.saveTries ?? 0) + 1;
    const wait = Math.min(30, 2 ** p.saveTries);
    say(`Not saved yet: ${bad}. Retrying in ${wait} s…`);
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => save(p), wait * 1000);
    return;
  }
  p.saveTries = 0;
  p.synced = base;
  p.hadReview = hasReview;
  const { added = [] } = (await res.json()) as { added?: string[] };
  say(added.length ? `Saved · added ${added.join(", ")} to ${proj.bibFile}` : "Saved");
  if (added.length || path.endsWith(".bib")) await loadKeys();
  if (autoBuild && /\.(tex|bib)$/.test(path)) { clearTimeout(autoTimer); autoTimer = setTimeout(() => build(true), 1200); }
  // a citation added to (or removed from) a chapter: rebuild quietly so its References section follows
  if (path.endsWith(".tex")) {
    const keys = [...new Set(citedIn(base))].sort().join(",");
    if (citeSets.has(path) && citeSets.get(path) !== keys) { clearTimeout(refsTimer); refsTimer = setTimeout(() => build(true), 2500); }
    citeSets.set(path, keys);
  }
  scheduleProject();
}

async function openFile(path: string, p: Pane = active) {
  // a file lives in one pane at a time, so two copies can never drift apart
  const elsewhere = panes.find((x) => x !== p && x.file === path);
  if (elsewhere) { activate(elsewhere); elsewhere.view.focus(); return; }
  await save(p);
  if (p === active) cancelGhost();
  const [res, rev] = await Promise.all([fetch(fileUrl(path)), fetch(fileUrl(path).replace("/api/file", "/api/review"))]);
  if (!res.ok) return;
  const diskText = await res.text();
  const reviewDisk = rev.ok ? await rev.json() : null;
  const loaded = fromBase(diskText, reviewDisk ?? { version: 1, suggestions: [], comments: [], orphans: [] });
  p.file = path;
  p.synced = diskText;
  p.syncedReview = reviewDisk;
  p.lang = langOf(path);
  p.orphans = loaded.orphans;
  p.hadReview = loaded.review.ins.length + loaded.review.dels.length + loaded.review.comments.length + p.orphans.length > 0;
  p.dirty = false;
  p.view.setState(EditorState.create({ doc: loaded.doc, extensions: extensions(p.lang, loaded.review) }));
  scheduleSpell(p.view, 200);
  refreshNav(p);
  p.minimap.rebuild();
  p.el.classList.toggle("plain", p.lang === "plain");
  renderPaneHeads();
  if (p !== active) { renderFiles(); return; }
  current = path;
  lang = p.lang;
  remember.set("margin.file", path);
  renderReview();
  if (!$("tab-review").hidden) renderShare();
  $("path").textContent = path;
  $("save").textContent = "";
  document.title = `${path.split("/").pop()} — Vega Fluo`;
  renderFiles();
  renderOutline();
  lastQuery = "";
  scheduleSuggest();
  p.view.focus();
}

/**
 * Open a file at a line and show where the problem is: the line is tinted, and when the column is
 * known the offending text (len characters ending at col, e.g. the command TeX choked on) is marked.
 */
async function jump(file: string, line: number, col?: number, len = 0) {
  if (file && !/\.\w+$/.test(file) && proj.tree.includes(`${file}.tex`)) file += ".tex";
  const open = panes.find((p) => p.file === file);
  if (open) activate(open); else if (file && file !== current) await openFile(file);
  const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  const at = col === undefined ? l.to : Math.min(l.from + col, l.to), from = Math.max(l.from, at - len);
  view.dispatch({
    selection: { anchor: at },
    effects: [EditorView.scrollIntoView(at, { y: "center" }), setErrSpot.of({ line: l.from, from, to: at })],
  });
  view.focus();
}
// the spot a check or build error points at: stays marked until that line is edited
const setErrSpot = StateEffect.define<{ line: number; from: number; to: number } | null>();
const errSpotField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setErrSpot)) {
      if (!e.value) return Decoration.none;
      const marks = [Decoration.line({ class: "cm-errline" }).range(e.value.line)];
      if (e.value.to > e.value.from) marks.push(Decoration.mark({ class: "cm-errspot" }).range(e.value.from, e.value.to));
      return Decoration.set(marks, true);
    }
    if (!tr.docChanged) return v;
    let touched = false;
    v.between(0, tr.startState.doc.length, (from, to) => { tr.changes.iterChangedRanges((a, b) => { if (a <= tr.startState.doc.lineAt(Math.min(to, tr.startState.doc.length)).to && b >= tr.startState.doc.lineAt(from).from) touched = true; }); });
    return touched ? Decoration.none : v.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- project: files, outline, checks ----------
/** Prose words in a stretch of LaTeX or Markdown: comments, maths, citation and reference commands and markup are not counted. */
const proseWords = (text: string) =>
  (text
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ")
    .replace(/\\(?:[a-zA-Z]*cite[a-zA-Z]*|ref|eqref|autoref|[cC]ref|pageref|label|input|include|includegraphics|begin|end)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, " ")
    .replace(/[{}~\\]/g, " ")
    .match(/[A-Za-z0-9][\w'’\-]*/g) ?? []).length;

/** The word counter: the whole dissertation normally, plus the selection while text is selected. */
function renderWords() {
  const total = `${proj.totalWords.toLocaleString()} words`;
  const picked = view.state.selection.ranges.filter((r) => !r.empty);
  const el = $("words");
  if (!picked.length) {
    el.textContent = total;
    el.title = "Approximate body-text words across the files main.tex includes";
    el.classList.remove("selected");
    return;
  }
  const text = picked.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
  const n = proseWords(text);
  el.textContent = `${n.toLocaleString()} selected · ${total}`;
  el.title = `${n.toLocaleString()} words and ${text.length.toLocaleString()} characters selected (markup and citations not counted)`;
  el.classList.add("selected");
}

let projectTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleProject() { clearTimeout(projectTimer); projectTimer = setTimeout(loadProject, 600); }

async function loadProject() {
  proj = await (await fetch("/api/project")).json();
  refreshNav();
  renderFiles();
  renderOutline();
  renderOutline();
  renderChecks();
  renderWords();
}

function renderFiles() {
  const info = new Map(proj.files.map((f) => [f.path, f]));
  const rows: Node[] = [];
  let dir = "";
  for (const path of proj.tree) {
    const d = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (d !== dir) { dir = d; rows.push(h("div", { class: "dir" }, d)); }
    const f = info.get(path);
    const inPane = panes.some((p) => p.file === path);
    rows.push(h("div", { class: "file-row" },
      h("button", { class: `row-btn${f && !f.linked ? " unlinked" : ""}${inPane && path !== current ? " open" : ""}`, type: "button", "aria-current": String(path === current), title: f && !f.linked ? `Not included from ${proj.root}` : `${path} (⌘-click to open beside)`,
          onclick: (e: MouseEvent) => { document.body.classList.remove("m-side"); return e.metaKey || e.ctrlKey ? openBeside(path) : openFile(path); } },
        h("span", { class: "name" }, path.split("/").pop()!),
        f && f.words > 0 && h("span", { class: "n" }, f.words.toLocaleString())),
      h("button", { class: "beside", type: "button", title: "Open beside what you have open", "aria-label": `Open ${path} beside`, onclick: () => openBeside(path) }, "⧉")));
  }
  $("files").replaceChildren(...rows);
}

// ---------- outline: its own panel under the files, like Overleaf's ----------
let outlineScope: "file" | "all" = remember.get("margin.outlineScope") === "all" ? "all" : "file";
function renderOutline() {
  const list = outlineScope === "file" ? proj.outline.filter((o: any) => o.file === current) : proj.outline;
  let lastFile = "";
  $("outline").replaceChildren(
    ...(list.length
      ? list.flatMap((o: any) => {
          const head = outlineScope === "all" && o.file !== lastFile ? [h("div", { class: "outline-file" }, o.file.split("/").pop())] : [];
          lastFile = o.file;
          return [...head, h("button", { class: `row-btn l${o.level}`, type: "button", title: `${o.file}:${o.line}`, "data-file": o.file, "data-line": String(o.line), onclick: () => jump(o.file, o.line) }, h("span", { class: "name" }, o.title || "(untitled)"))];
        })
      : [h("p", { class: "empty", style: "padding:0 8px" }, outlineScope === "file" ? "No headings in this file yet. Add \\chapter or \\section and they appear here." : "Headings appear here as you add \\chapter and \\section.")]),
  );
  markOutline();
}
/** Highlight the heading the cursor is under, and keep it in view. */
function markOutline() {
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  let here: HTMLElement | null = null;
  for (const b of $("outline").querySelectorAll<HTMLElement>(".row-btn")) {
    b.classList.remove("here");
    if (b.dataset.file === current && Number(b.dataset.line) <= line) here = b;
  }
  if (here) { here.classList.add("here"); here.scrollIntoView({ block: "nearest" }); }
}
for (const b of document.querySelectorAll<HTMLElement>(".outline-scope button")) {
  b.setAttribute("aria-pressed", String(b.dataset.scope === outlineScope));
  b.addEventListener("click", () => {
    outlineScope = b.dataset.scope as "file" | "all";
    remember.set("margin.outlineScope", outlineScope);
    for (const x of document.querySelectorAll(".outline-scope button")) x.setAttribute("aria-pressed", String(x === b));
    renderOutline();
  });
}
// fold either panel, and drag the line between them
for (const f of document.querySelectorAll<HTMLButtonElement>("#side .fold")) {
  const box = $(f.dataset.box!), key = `margin.fold.${f.dataset.box}`;
  const set = (open: boolean) => { box.classList.toggle("folded", !open); f.setAttribute("aria-expanded", String(open)); remember.set(key, open ? "1" : "0"); };
  set(remember.get(key) !== "0");
  f.addEventListener("click", () => set(box.classList.contains("folded")));
}
{
  const saved = remember.get("margin.outlineH");
  if (saved) $("side-outline").style.flexBasis = saved;
  dragDivider($("side-split"), (_x, y) => {
    const r = $("side").getBoundingClientRect();
    const hgt = Math.max(80, Math.min(r.height - 80, r.bottom - y));
    $("side-outline").style.flexBasis = `${Math.round(hgt)}px`;
    remember.set("margin.outlineH", `${Math.round(hgt)}px`);
  });
  $("side-split").addEventListener("dblclick", () => { $("side-outline").style.flexBasis = ""; remember.set("margin.outlineH", ""); });
}

type ProjIssue = { severity: string; kind: string; message: string; file: string; line: number; col?: number; fix?: { expect: string; insert: string } };

/** Apply the safe LaTeX repairs for one file in a single undoable edit. Returns how many were made. */
async function applyTexFixes(file: string, only?: ProjIssue): Promise<number> {
  const todo = (only ? [only] : (proj.issues as ProjIssue[]).filter((i) => i.file === file && i.fix)).filter((i) => i.fix && i.col !== undefined);
  if (!todo.length) return 0;
  await jump(file, todo[0]!.line);
  const doc = view.state.doc, changes: { from: number; to: number; insert: string }[] = [];
  for (const i of todo) {
    if (i.line > doc.lines) continue;
    const l = doc.line(i.line), from = l.from + i.col!;
    // the check ran on the saved file; only touch the spot if it still holds what was flagged
    if (doc.sliceString(from, from + i.fix!.expect.length) === i.fix!.expect) changes.push({ from, to: from + i.fix!.expect.length, insert: i.fix!.insert });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.fix" });
  await save();
  await loadProject();
  return changes.length;
}

function issueCards(list: ProjIssue[]) {
  return list.flatMap((i) => [
    h("button", { class: "card issue", type: "button", onclick: () => i.file && jump(i.file, i.line, i.col === undefined ? undefined : i.col + (i.fix?.expect.length ?? 1), i.col === undefined ? 0 : i.fix?.expect.length ?? 1) },
      h("span", { class: `badge ${i.severity}` }, i.kind === "open-item" ? "to do" : i.severity),
      h("span", { class: "msg" }, i.message),
      i.file && h("span", { class: "where" }, `${i.file}:${i.line}`)),
    i.fix && h("button", { class: "link fixit", type: "button", onclick: () => applyTexFixes(i.file, i) }, i.fix.insert ? `Fix: write ${i.fix.insert.trim()}` : "Fix: delete it"),
  ]).filter(Boolean) as HTMLElement[];
}

function renderChecks() {
  const issues = proj.issues as ProjIssue[];
  const serious = issues.filter((i) => i.severity !== "info").length;
  const count = $("check-count");
  count.textContent = issues.length ? String(serious || issues.length) : "";
  count.className = `count${serious ? " bad" : ""}`;
  const fixable = new Map<string, number>();
  for (const i of issues) if (i.fix) fixable.set(i.file, (fixable.get(i.file) ?? 0) + 1);
  $("checks").replaceChildren(
    ...[...fixable].map(([file, n]) => h("button", { class: "fixall", type: "button", onclick: () => applyTexFixes(file) }, `Fix all ${n} LaTeX character problem${n === 1 ? "" : "s"} in ${file}`)),
    ...(issues.length ? issueCards(issues) : [h("p", { class: "empty" }, "No problems found.")]),
  );
}

// ---------- panel tabs + PDF ----------
function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLElement>(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const id of ["suggest", "library", "map", "figures", "review", "checks", "log", "pdf"]) $(`tab-${id}`).hidden = id !== name;
  if (name === "library") loadLibrary();
  if (name === "review") renderShare();
  if (name === "figures") loadFigures();
  mainEl.classList.toggle("wide", name === "pdf" || name === "map");
  if (name === "pdf") loadPdf();
  if (name === "map") { ensureMap(); map?.wake(); }
  if (name === "log") loadLog();
}

let building = false;
async function build(quiet = false) {
  if (building) { if (quiet) buildAgain = true; return; }
  building = true;
  await Promise.all(panes.map((p) => save(p)));
  if (!quiet) showTab("pdf");
  const box = $("pdf-status");
  box.replaceChildren(h("p", { class: "busy" }, "Building…"));
  try {
    const r = await (await fetch("/api/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: panes.map((p) => p.file).filter(Boolean) }) })).json();
    // chapters open in the editor get their reference-list line through the editor, then one more build shows the lists
    const need: string[] = r.chapterRefs?.needInput ?? [];
    let inserted = 0;
    for (const path of need) {
      const p = panes.find((x) => x.file === path);
      if (!p) continue;
      const doc = p.view.state.doc.toString(), line = `\\input{.margin/chapter-refs/${path.split("/").pop()!.replace(/\.tex$/, "")}}`;
      if (doc.includes(line)) continue;
      const m = /^\s*\\section\*?\{\s*(References|Bibliography|Literature Cited)\s*\}.*$/im.exec(doc);
      if (!m) continue;
      let at = m.index + m[0].length;
      const after = doc.slice(at + 1).split("\n")[0] ?? "";
      if (/^\s*\\label\{/.test(after)) at += 1 + after.length;
      p.view.dispatch({ changes: { from: at, insert: `\n${line}` }, annotations: internal.of(true), userEvent: "input.refs" }); // machine bookkeeping, never a tracked suggestion
      inserted++;
    }
    if (inserted) { await Promise.all(panes.map((p) => save(p))); building = false; return build(quiet); }
    if (r.ok) {
      box.replaceChildren(h("p", { class: "empty" }, r.draft
        ? `Draft preview, built with ${r.engine} in ${(r.ms / 1000).toFixed(1)} s. This is your content in a plain report layout, not Rackham formatting: add the class file to the project for the real thing.`
        : `Built with ${r.engine} in ${(r.ms / 1000).toFixed(1)} s.`));
      await loadPdf(true);
    } else {
      const stale = await loadPdf(); // keep the last good PDF on screen, clearly marked as old
      await loadProject();
      const likely = (proj.issues as ProjIssue[]).filter((i) => i.kind.startsWith("tex-") && i.severity === "error").slice(0, 12);
      r.errors = r.errors.filter((e: any) => !(e.fix === "percent" && likely.length));
      box.replaceChildren(
        ...(likely.length ? [h("p", { class: "empty" }, "Most likely cause, found by the LaTeX checker:"), ...issueCards(likely), h("p", { class: "empty" }, "What TeX reported:")] : []),
        ...r.errors.flatMap((e: any) => [
          h("button", { class: "card issue", type: "button", title: e.file ? "Show this in the text" : "", onclick: () => e.file && jump(e.file, e.line, e.col, e.near?.length ?? 0) },
            h("span", { class: "badge error" }, "error"), h("span", { class: "msg" }, e.message, e.near ? h("span", { class: "near" }, ` near ${e.near}`) : ""), e.file && h("span", { class: "where" }, `${e.file}:${e.line}`)),
          e.fix === "percent" && h("button", { class: "link fixit", type: "button", onclick: () => fixPercent(e.file, e.line) }, `Fix it: escape the % signs on line ${e.line} and rebuild`),
        ]).filter(Boolean),
        r.log && h("details", { class: "log" }, h("summary", {}, "Full build log"), h("pre", {}, r.log)),
        stale && h("p", { class: "empty stale-note" }, "This build failed. The PDF below is from the last build that worked."),
      );
    }
  } catch {
    box.replaceChildren(h("p", { class: "empty" }, "Could not reach the server."));
  }
  building = false;
  if (buildAgain) { buildAgain = false; setTimeout(() => build(true), 300); }
  showTab("pdf");
}

/** Turn every bare % on a line into \\% (used when one has swallowed a closing brace), then rebuild. */
async function fixPercent(file: string, line: number) {
  await jump(file, line);
  const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
  const fixed = l.text.replace(/(?<!\\)%/g, "\\%");
  if (fixed !== l.text) view.dispatch({ changes: { from: l.from, to: l.to, insert: fixed }, userEvent: "input.fix" });
  building = false;
  await build();
}

// ---------- PDF viewer: pages as images, so Margin knows which page and spot you are looking at ----------
let pdfInfo: { pages: number; sizes: [number, number][]; builtAt: number } = { pages: 0, sizes: [], builtAt: 0 };
async function loadPdf(force = false) {
  const info = await (await fetch("/api/pdf/info")).json().catch(() => ({ pages: 0 }));
  if (!info.pages) return false;
  if (!force && info.builtAt === pdfInfo.builtAt && $("pdf-pages").childElementCount) return true;
  const keep = force && !$("pdf-pages").hidden && $("pdf-pages").clientHeight > 0 ? currentPdfPage() : 1;
  pdfInfo = info;
  const box = $("pdf-pages");
  box.replaceChildren(...info.sizes.map(([w, hh]: [number, number], i: number) => {
    const page = h("div", { class: "pdfpage", "data-n": String(i + 1), style: `aspect-ratio:${w}/${hh}`, title: "Double-click to go to this spot in the source" },
      h("img", { "data-src": `/api/pdf/page?n=${i + 1}&t=${info.builtAt}`, alt: `Page ${i + 1}`, draggable: "false" }));
    page.addEventListener("dblclick", (e) => {
      const r = page.getBoundingClientRect();
      toSource(i + 1, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    return page;
  }));
  box.hidden = false;
  // the strip of small pages beside the viewer: click one to go there
  const strip = $("pdf-thumbs");
  strip.replaceChildren(...info.sizes.map(([w, hh]: [number, number], i: number) => {
    const t = h("button", { type: "button", class: "pdfthumb", "data-n": String(i + 1), title: `Page ${i + 1}`, style: `aspect-ratio:${w}/${hh}` },
      h("img", { "data-src": `/api/pdf/page?n=${i + 1}&t=${info.builtAt}`, alt: "", draggable: "false" }), h("span", {}, String(i + 1)));
    t.addEventListener("click", () => { const pg = box.querySelector<HTMLElement>(`[data-n="${i + 1}"]`); if (pg) box.scrollTop = pg.offsetTop - box.offsetTop; });
    return t;
  }));
  strip.hidden = !thumbsOn;
  const sio = new IntersectionObserver((seen) => {
    for (const e of seen) { const img = e.target.querySelector("img") as HTMLImageElement | null; if (e.isIntersecting && img && !img.src) img.src = img.dataset.src!; }
  }, { root: strip, rootMargin: "600px 0px" });
  for (const t of strip.children) sio.observe(t);
  // load a page image only when it comes near the visible part of the viewer
  const io = new IntersectionObserver((seen) => {
    for (const e of seen) {
      const img = e.target.querySelector("img") as HTMLImageElement | null;
      if (e.isIntersecting && img && !img.src) img.src = img.dataset.src!;
    }
  }, { root: box, rootMargin: "800px 0px" });
  for (const p of box.children) io.observe(p);
  if ($("pdf-status").querySelector(".empty")?.textContent?.startsWith("Build the")) $("pdf-status").replaceChildren();
  box.onscroll = () => { $("pdf-pos").textContent = `page ${currentPdfPage()} of ${pdfInfo.pages}`; markThumb(); };
  const at = keep > 1 ? box.querySelector<HTMLElement>(`[data-n="${keep}"]`) : null;
  box.scrollTop = at ? at.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop : 0;
  $("pdf-pos").textContent = `page ${currentPdfPage()} of ${pdfInfo.pages}`;
  return true;
}

/** Highlight the current page in the strip and keep it in view. */
let thumbsOn = remember.get("margin.pdfThumbs") !== "0";
function markThumb() {
  const n = String(currentPdfPage()), strip = $("pdf-thumbs");
  for (const t of strip.children) t.classList.toggle("here", (t as HTMLElement).dataset.n === n);
  const here = strip.querySelector<HTMLElement>(".pdfthumb.here");
  if (here && !strip.hidden) { const top = here.offsetTop - strip.offsetTop; if (top < strip.scrollTop || top + here.offsetHeight > strip.scrollTop + strip.clientHeight) strip.scrollTop = top - strip.clientHeight / 3; }
}
function setThumbs(on: boolean) {
  thumbsOn = on;
  remember.set("margin.pdfThumbs", on ? "1" : "0");
  $("pdf-thumbs-toggle").setAttribute("aria-pressed", String(on));
  $("pdf-thumbs").hidden = !on || !$("pdf-thumbs").childElementCount;
  if (on) markThumb();
}

/** The page whose middle is nearest the middle of the viewer. */
function currentPdfPage(): number {
  const box = $("pdf-pages"), mid = box.getBoundingClientRect().top + box.clientHeight / 2;
  let best = 1, bd = Infinity;
  for (const p of box.children) {
    const r = p.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bd) { bd = d; best = Number((p as HTMLElement).dataset.n); }
  }
  return best;
}

/** PDF to source: open the file and line that produced this spot. */
async function toSource(page: number, x: number, y: number) {
  const r = await (await post("/api/pdf/locate", { page, x, y })).json();
  if (r.error) { $("pdf-pos").textContent = r.error; return; }
  await jump(r.file, r.line);
  $("pdf-pos").textContent = `page ${page} of ${pdfInfo.pages} → ${r.file}:${r.line}`;
}

/** Source to PDF: show where the text around the cursor sits in the built PDF. */
async function toPdf() {
  showTab("pdf");
  if (!(await loadPdf())) { await build(); if (!pdfInfo.pages) return; }
  const pos = view.state.selection.main.head;
  const clean = (t: string) => t.replace(/(^|[^\\])%.*$/gm, "$1").replace(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*\}/g, " ").replace(/\\(?:ref|eqref|autoref|[cC]ref|label)\{[^}]*\}/g, " ").replace(/\\[a-zA-Z@]+\*?/g, " ").replace(/[{}~$\\]/g, " ");
  const before = clean(view.state.sliceDoc(Math.max(0, pos - 500), pos)).match(/\S+/g) ?? [];
  const after = clean(view.state.sliceDoc(pos, Math.min(view.state.doc.length, pos + 500))).match(/\S+/g) ?? [];
  const words = [...before.slice(-30), ...after.slice(0, 30)];
  const r = await (await post("/api/pdf/find", { words, center: Math.min(before.length, 30) })).json();
  if (r.error) { $("pdf-pos").textContent = r.error; return; }
  showTab("pdf");
  const page = $("pdf-pages").querySelector<HTMLElement>(`[data-n="${r.page}"]`);
  if (!page) return;
  const box = $("pdf-pages");
  // measured against the viewer itself, so it is right however the panel is laid out
  box.scrollTop += page.getBoundingClientRect().top - box.getBoundingClientRect().top + r.y * page.offsetHeight - box.clientHeight / 3;
  page.querySelector(".hit")?.remove();
  const band = h("div", { class: "hit", style: `top:${(r.y * 100 - 0.4).toFixed(2)}%;height:${Math.max(1.6, r.h * 100 + 0.8).toFixed(2)}%` });
  page.append(band);
  requestAnimationFrame(() => band.classList.add("fade"));
  setTimeout(() => band.remove(), 2600);
}

// ---------- review: tracked changes and comments ----------
const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString();
};
const whoLine = (author: string, ts: number) =>
  h("div", { class: "who-line" }, h("span", { class: "who-dot", style: `--who:${hue(author)}` }), h("b", {}, author), ago(ts));
function goTo(pos: number) {
  view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
}

function setMode(on: boolean) {
  suggesting = on;
  remember.set("margin.suggesting", on ? "1" : "0");
  for (const p of panes) p.view.dispatch({ effects: setSuggesting.of(on) });
  $("mode").textContent = on ? "Suggesting" : "Editing";
  $("mode").classList.toggle("on", on);
}

let changesNewest = remember.get("margin.changesNewest") === "1";
function renderReview() {
  const r = view.state.field(reviewField);
  const open = r.comments.filter((c) => !c.resolved).length;
  const n = r.ins.length + r.dels.length + open;
  $("review-count").textContent = n ? String(n) : "";
  const changes = [
    ...r.ins.map((i) => ({ ...i, kind: "ins", pos: i.from, text: view.state.sliceDoc(i.from, i.to) })),
    ...r.dels.map((d) => ({ ...d, kind: "del" })),
  ].sort((a, b) =>
    changesNewest
      ? b.ts - a.ts || a.pos - b.pos || (a.kind === "del" ? -1 : 1)
      : a.pos - b.pos || (a.kind === "del" ? -1 : 1)); // a replacement reads "deleted, then added"
  $("changes-sort").textContent = changesNewest ? "Newest first" : "In text order";
  $("changes").replaceChildren(
    ...(changes.length
      ? changes.map((c) =>
          h("div", { class: "card", "data-card": c.id },
            whoLine(c.author, c.ts),
            h("div", { class: `change-text ${c.kind}`, title: "Show in the document", onclick: () => goTo(c.pos) }, c.text.replace(/\n/g, "¶\n")),
            h("div", { class: "row" },
              h("button", { type: "button", class: "link", onclick: () => rejectSuggestion(view, c.id) }, "Reject"),
              h("button", { type: "button", class: "link", onclick: () => acceptSuggestion(view, c.id) }, c.kind === "ins" ? "Accept addition" : "Accept deletion"))))
      : [h("p", { class: "empty" }, suggesting ? "Your edits are being recorded as suggestions." : "No pending changes. Switch to Suggesting to propose edits instead of making them.")]),
  );
  $("comments").replaceChildren(
    ...r.comments.map((c) => {
      const reply = h("input", { type: "text", placeholder: "Reply…", "aria-label": "Reply" });
      reply.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !reply.value.trim()) return;
        view.dispatch({ effects: reviewEdit.of({ op: "setComment", comment: { ...c, replies: [...c.replies, { author: currentAuthor(), ts: Date.now(), text: reply.value.trim() }] } }) });
      });
      return h("div", { class: `card thread${c.resolved ? " resolved" : ""}`, "data-card": c.id },
        whoLine(c.author, c.ts),
        c.quote && h("div", { class: "quote", title: "Show in the document", onclick: () => goTo(c.from) }, c.quote),
        h("div", {}, c.text),
        ...c.replies.map((x) => h("div", { class: "reply" }, whoLine(x.author, x.ts), h("div", {}, x.text))),
        !c.resolved && reply,
        h("div", { class: "row" },
          h("button", { type: "button", class: "link", onclick: () => view.dispatch({ effects: reviewEdit.of({ op: "dropComment", id: c.id }) }) }, "Delete"),
          h("button", { type: "button", class: "link", onclick: () => view.dispatch({ effects: reviewEdit.of({ op: "setComment", comment: { ...c, resolved: !c.resolved } }) }) }, c.resolved ? "Reopen" : "Resolve")));
    }),
  );
  $("orphans").textContent = active.orphans.length
    ? `${active.orphans.length} stored suggestion${active.orphans.length > 1 ? "s" : ""} no longer match${active.orphans.length > 1 ? "" : "es"} the text (the file changed outside Vega Fluo). Kept in the review file, not applied.`
    : "";
}

/** Show these comment threads in the Review panel (innermost first), scrolled to and outlined. */
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function openComments(ids: string[]) {
  if (!ids.length) return;
  if (mainEl.classList.contains("no-panel")) setPanel(true);
  showTab("review");
  renderReview();
  const box = $("comments");
  for (const c of box.querySelectorAll(".card.flash")) c.classList.remove("flash");
  const cards = ids.map((id) => box.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)).filter((x): x is HTMLElement => !!x);
  if (!cards.length) return;
  for (const c of cards) c.classList.add("flash");
  cards[0]!.scrollIntoView({ block: "center", behavior: "smooth" });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { for (const c of cards) c.classList.remove("flash"); }, 4000);
}

function submitComment() {
  const box = $<HTMLTextAreaElement>("comment-text");
  if (!box.value.trim()) return box.focus();
  if (addComment(view, box.value)) box.value = "";
  else { box.placeholder = "Select the text you are commenting on first"; view.focus(); }
}

// ---------- knowledge map ----------
let map: ReturnType<typeof createMap> | null = null;
let mapData: MapData | null = null;
let mapCited: string[] = [], mapSuggested: string[] = [];
let mapFollow = remember.get("margin.mapFollow") !== "0";

/** Papers cited in the paragraph being written, in either citation syntax. */
function citedIn(text: string): string[] {
  const tex = [...text.matchAll(new RegExp(CITE_TEX.source, "g"))].flatMap((m) => m[1]!.split(",").map((k) => k.trim()));
  const md = [...text.matchAll(/\[[^\[\]\n]*@[^\[\]\n]*\]/g)].flatMap((m) => mdKeys(m[0]));
  return [...new Set([...tex, ...md].filter(Boolean))];
}

function updateMapFocus() {
  if (!map || !mapData) return;
  const n = map.setFocus(mapCited, mapSuggested);
  const missing = mapCited.filter((k) => !map!.has(k)).length;
  $("map-note").replaceChildren(
    h("span", {}, `${mapData.nodes.length} papers, map built ${mapData.generated || "?"}.`),
    h("span", { class: "legend-dot", style: "background:var(--accent)" }), `${n.cited} cited here`,
    h("span", { class: "legend-dot", style: "box-shadow:inset 0 0 0 2px var(--warn)" }), `${n.suggested} suggested`,
    missing ? ` · ${missing} cited here not in the map` : "",
  );
}

async function ensureMap() {
  if (!map) {
    mapData = await (await fetch("/api/map")).json();
    if (!mapData!.nodes.length) { $("map-note").textContent = (mapData as any).error ?? "No knowledge map is configured (knowledgeMap in config.json)."; return; }
    map = createMap($<HTMLCanvasElement>("map-canvas"), showMapNode);
    map.setFollow(mapFollow);
    map.setData(mapData!);
  }
  updateMapFocus();
  map.redraw();
}

function showMapNode(n: MapNode | null) {
  if (!n) return $("map-detail").replaceChildren();
  const known = !!n.key;
  const act = h("button", { type: "button", class: "link" }, known ? `Cite ${n.key}` : n.pmid ? "Add from PubMed and cite" : "Not in your library");
  act.addEventListener("click", async () => {
    let key = n.key ?? "";
    if (!key && n.pmid) {
      act.textContent = "Adding…";
      const a = await (await post("/api/pubmed/add", { pmid: n.pmid })).json();
      if (a.error) { act.textContent = `Failed: ${a.error}`; return; }
      key = n.key = a.key;
      await loadKeys();
      act.textContent = `Cite ${key}`;
    }
    if (key) insertCite(key);
  });
  $("map-detail").replaceChildren(
    h("div", { class: "card" },
      h("div", { class: "who" }, n.short, n.review && h("span", { class: "badge", style: "margin-left:6px" }, "review")),
      h("div", { class: "title" }, n.title),
      n.claim && h("div", { class: "note" }, n.claim),
      n.tags.length > 0 && h("div", { class: "chips" }, ...n.tags.map((t) => h("span", { class: "chip quiet", title: t }, mapData?.labels[t] ?? t))),
      h("div", { class: "row" }, n.pmid && h("a", { class: "link", href: `https://pubmed.ncbi.nlm.nih.gov/${n.pmid}/`, target: "_blank", rel: "noopener noreferrer" }, `PMID ${n.pmid}`), act)));
}

// ---------- off-machine backup ----------
function renderBackup(b: any) {
  const el = $("backup");
  el.hidden = !b?.enabled;
  if (!b?.enabled) return;
  el.textContent = !b.ok ? "Backup failed" : b.pending ? `${b.pending} to back up` : `Backed up ${ago(b.lastAt)}`;
  el.classList.toggle("bad", !b.ok);
  el.title = `${b.lastResult || "Backs up every ten minutes"}\n${b.remote}\nClick to back up now`;
}
$("backup").addEventListener("click", async () => {
  await Promise.all(panes.map((p) => save(p)));
  $("backup").textContent = "Backing up…";
  renderBackup(await (await fetch("/api/backup", { method: "POST" })).json());
});

// ---------- file history ----------
async function openHistory() {
  await save();
  const path = current;
  const r = await (await fetch(`/api/history?path=${encodeURIComponent(path)}`)).json();
  $("history-title").textContent = `Earlier versions of ${path}`;
  $("history-note").textContent = r.list.length
    ? `${r.total} saved version${r.total === 1 ? "" : "s"}. Restoring keeps the current text as a new version, so it can be undone.`
    : "No earlier versions yet. Vega Fluo keeps one whenever you change this file, at most every five minutes.";
  $("history-list").replaceChildren(...r.list.map((v: any) =>
    h("button", { class: "row-btn", type: "button", title: v.preview, onclick: async () => {
        if (!confirm(`Replace ${path} with the version from ${new Date(v.at).toLocaleString()}?\n\nThe current text is kept in History.`)) return;
        await post("/api/history", { path, id: v.id });
        $<HTMLDialogElement>("history").close();
        const p = active; p.file = ""; // force a reload from disk
        await openFile(path, p);
        scheduleProject();
      } },
      h("span", { class: "name" }, new Date(v.at).toLocaleString()),
      h("span", { class: "n" }, `${v.words.toLocaleString()} words`))));
  $<HTMLDialogElement>("history").showModal();
}
$("history").addEventListener("click", (e) => { if (e.target === e.currentTarget) $<HTMLDialogElement>("history").close(); });

// ---------- disagreement log ----------
async function loadLog() {
  const r = await fetch("/api/disagreements").catch(() => null);
  if (!r?.ok) return;
  const { list, tally } = await r.json();
  const open = list.filter((d: any) => !d.ruling).length;
  $("log-count").textContent = open ? String(open) : "";
  $("log-count").className = `count${open ? " bad" : ""}`;
  if ($("tab-log").hidden) return;
  const scores = Object.entries(tally as Record<string, { right: number; ruled: number }>).map(([m, t]) => `${m} ${t.right}/${t.ruled}`);
  $("log-head").textContent = !list.length
    ? "When two models judge a claim differently, both verdicts and their reasons are recorded here for you to decide. Choose a second opinion in the Suggest tab to start."
    : `${list.length} disagreement${list.length === 1 ? "" : "s"}, ${open} awaiting your ruling.${scores.length ? ` Sided with so far: ${scores.join(", ")}.` : ""}`;
  const word = (v: string) => (v === "unsupported" ? "no source found" : v);
  $("log-list").replaceChildren(...list.map((d: any) => {
    const rule = async (ruling: string | null) => { await post("/api/disagreements", { id: d.id, ruling }); loadLog(); };
    const note = h("textarea", { rows: "1", placeholder: "Your note (why, what you checked)" }, d.comment ?? "");
    note.addEventListener("change", () => post("/api/disagreements", { id: d.id, comment: (note as HTMLTextAreaElement).value }));
    const side = (o: any) => h("div", {},
      h("div", { class: "opinion" }, h("b", {}, `${o.model}: ${word(o.verdict)}`), o.note ? ` — ${o.note}` : " — (no reason given)"),
      o.sources.length > 0 && h("div", { class: "srcs" }, `cited: ${o.sources.join("; ")}`));
    const pick = (value: string, label: string) => h("button", { type: "button", "aria-pressed": String(d.ruling === value), onclick: () => rule(d.ruling === value ? null : value) }, label);
    return h("div", { class: `card dispute${d.ruling ? " ruled" : ""}` },
      d.file && h("div", { class: "where", title: "Go to this paragraph", onclick: () => jump(d.file, d.line) }, `${d.file}:${d.line} · ${ago(d.ts)}`),
      h("div", { class: "title" }, d.claim),
      side(d.a), side(d.b),
      h("div", { class: "ruling" }, pick("a", `${d.a.model} right`), pick("b", `${d.b.model} right`), pick("both", "Both have a point"), pick("neither", "Neither")),
      note);
  }));
}

// ---------- which model judges arguments and claims ----------
interface JudgeInfo { id: string; label: string; provider: string; model: string; ready: boolean; reason: string }
let judges: JudgeInfo[] = [];
let judgeId = remember.get("margin.judgeId") ?? "";
let secondId = remember.get("margin.secondId") ?? "";
const currentJudge = () => judges.find((j) => j.id === judgeId) ?? judges[0];
const useCloud = () => [currentJudge(), judges.find((x) => x.id === secondId)].some((x) => x && x.provider !== "local");

function setJudge(id: string) {
  judgeId = judges.some((j) => j.id === id) ? id : (judges[0]?.id ?? "");
  remember.set("margin.judgeId", judgeId);
  const sel = $<HTMLSelectElement>("judge");
  sel.replaceChildren(...judges.map((j) => h("option", { value: j.id, disabled: !j.ready }, j.label + (j.ready ? "" : " — unavailable"))));
  sel.value = judgeId;
  // second opinion: any other available model, or none
  if (secondId === judgeId || !judges.some((x) => x.id === secondId && x.ready)) secondId = "";
  const sel2 = $<HTMLSelectElement>("judge2");
  sel2.replaceChildren(h("option", { value: "" }, "None"), ...judges.filter((x) => x.id !== judgeId).map((x) => h("option", { value: x.id, disabled: !x.ready }, x.label)));
  sel2.value = secondId;
  remember.set("margin.secondId", secondId);
  const j = currentJudge();
  const j2 = judges.find((x) => x.id === secondId);
  const away = [j, j2].filter((x) => x && x.provider !== "local").map((x) => (x!.provider === "openai" ? "OpenAI" : "Anthropic"));
  $("judge-note").textContent = !j ? "" : !j.ready ? `${j.label} is not available: ${j.reason}.`
    : !away.length ? ""
    : `Checks will send the paragraph and matching library excerpts to ${[...new Set(away)].join(" and ")}. Ghost text always stays local.`;
}
const judgedBy = (d: any) => h("p", { class: "empty" }, d.secondBy ? `Judged independently by ${d.by} and ${d.secondBy}` : `Judged by ${d.by}${d.cloud ? " (cloud)" : " (local)"}`, d.secondError ? ` · ${d.secondError}` : "");

// ---------- claim check ----------
async function checkClaims() {
  showTab("suggest");
  const text = paragraphAt(view.state);
  const box = $("args");
  box.replaceChildren(h("p", { class: "busy" }, useCloud() ? `Sending this paragraph and library excerpts to ${currentJudge()!.model}…` : "Checking each claim against your library…"));
  box.scrollIntoView({ block: "nearest" });
  const data = await (await post("/api/verify", { text, judge: judgeId, second: secondId, file: current, line: paragraphLine(view.state) })).json().catch(() => ({ error: "Could not reach the server" }));
  if (data.error) return box.replaceChildren(h("p", { class: "empty" }, `Could not check claims: ${data.error}`));
  if (!data.claims.length) return box.replaceChildren(h("p", { class: "empty" }, data.note ?? "No claims found in this paragraph."));
  const word = (v: string) => (v === "unsupported" ? "no source found" : v);
  const chips = (list: any[]) => list.length > 0 && h("div", { class: "chips" }, ...list.map((s: any) =>
    s.id.startsWith("ref:")
      ? h("button", { class: "chip", type: "button", title: "Insert citation", onclick: () => insertCite(s.id.slice(4)) }, s.label)
      : h("span", { class: "chip quiet", title: s.label }, s.label)));
  box.replaceChildren(...data.claims.map((c: any) =>
    h("div", { class: `card${c.second && !c.agree ? " split" : ""}` },
      h("div", {},
        h("span", { class: `badge ${c.verdict}` }, word(c.verdict)),
        c.second && (c.agree ? h("span", { class: "badge agree" }, "both agree") : h("span", { class: "badge disagree" }, "models disagree"))),
      h("div", { class: "title" }, c.claim),
      // when the two models differ, show each one's verdict and reason so you can judge between them
      c.second && !c.agree
        ? h("div", {},
            h("div", { class: "opinion" }, h("b", {}, `${data.by}: ${word(c.verdict)}`), c.note ? ` — ${c.note}` : ""), chips(c.sources),
            h("div", { class: "opinion" }, h("b", {}, `${data.secondBy}: ${word(c.second.verdict)}`), c.second.note ? ` — ${c.second.note}` : ""), chips(c.second.sources))
        : h("div", {}, c.note && h("div", { class: "note" }, c.note), chips(c.sources)),
      c.verdict !== "supported" && h("div", { class: "row" },
        h("a", { class: "link", href: `https://scholar.google.com/scholar?q=${encodeURIComponent(c.claim)}`, target: "_blank", rel: "noopener noreferrer", title: "Opens Google Scholar with this sentence as the search" }, "Google Scholar ↗"),
        h("button", { type: "button", class: "link", onclick: () => { showTab("library"); setSource(true); $<HTMLInputElement>("lib-q").value = c.claim; searchPubmedNow(); } }, "Search PubMed")))), judgedBy(data),
    data.claims.some((c: any) => c.second && !c.agree) && h("button", { type: "button", class: "link", onclick: () => showTab("log") }, "Disagreements are kept in the Log, with both rationales"));
  loadLog();
}

// ---------- figures ----------
const figLatex = (file: string, id: string) => `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${file}}\n  \\caption{}\n  \\label{fig:${id}}\n\\end{figure}\n`;

function insertFigure(file: string, id: string, at: number | null = null) {
  if (lang !== "tex") { $("fig-note").textContent = "Open a .tex file to place a figure."; return; }
  const line = view.state.doc.lineAt(at ?? view.state.selection.main.head);
  const insert = `${line.text.trim() ? "\n\n" : ""}${figLatex(file, id)}`;
  const caption = line.to + insert.indexOf("\\caption{") + "\\caption{".length;
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: caption }, scrollIntoView: true }); // cursor lands in the caption
  view.focus();
}

const CODE_EXT = /\.(r|py|m|groovy|ijm|sh|sql|jl)$/i;

/** A dropped script becomes a numbered, page-breaking listing; the cursor lands in its caption. */
async function dropCode(f: File, at: number | null) {
  const r = await (await fetch(`/api/code?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f })).json().catch(() => ({ error: "upload failed" }));
  $("save").textContent = r.error ? `${f.name}: ${r.error}` : `Added ${r.file} (${r.lines} lines)`;
  if (r.error || lang !== "tex") return;
  const line = view.state.doc.lineAt(at ?? view.state.selection.main.head);
  const insert = `${line.text.trim() ? "\n\n" : ""}${r.latex}`;
  const caption = line.to + insert.indexOf("}{}{") + 2;
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: caption }, scrollIntoView: true });
  view.focus();
  scheduleProject();
}

async function dropFigures(files: File[], at: number | null) {
  // an SVG dropped together with pictures: the pictures are the files it links to, so they go in first
  if (files.some((f) => /\.svg$/i.test(f.name))) {
    const pics = files.filter((f) => /\.(png|jpe?g|gif|webp|tiff?)$/i.test(f.name));
    for (const f of pics) await fetch(`/api/figure?companion=1&name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
    files = files.filter((f) => !pics.includes(f));
  }
  for (const f of files) {
    if (CODE_EXT.test(f.name)) { await dropCode(f, at); continue; }
    $("fig-note").textContent = `Adding ${f.name}…`;
    const r = await (await fetch(`/api/figure?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f })).json().catch(() => ({ error: "upload failed" }));
    if (r.error) { $("fig-note").textContent = `${f.name}: ${r.error}`; showTab("figures"); continue; }
    $("fig-note").textContent = `Added ${r.file}${r.converted ? " (converted so LaTeX can include it; the original is kept)" : ""}.`
      + (r.embedded?.length ? ` Embedded ${r.embedded.length} linked image${r.embedded.length === 1 ? "" : "s"}: ${r.embedded.join(", ")}.` : "")
      + (r.missing?.length ? ` MISSING: this SVG links to ${r.missing.join(", ")}, which could not be found, so those panels will be blank. Drop them together with the SVG, or re-export it with images embedded.` : "")
      + (r.warnings?.length ? ` NOTE: ${r.warnings.join(" ")}` : "");
    if (at === null && !r.missing?.length) $("fig-note").textContent += " Click it below to place it at the cursor.";
    if (r.missing?.length || r.warnings?.length || at === null) showTab("figures");
    if (at !== null) insertFigure(r.file, r.id, at);
  }
  if (!$("tab-figures").hidden) loadFigures();
  scheduleProject();
}

/** A pane that shows a figure large, so you can look at it while writing about it. */
let figShown = "";
async function openFigurePane(file?: string) {
  const { figures } = await (await fetch("/api/figures")).json();
  if (!figures.length) { showTab("figures"); $("fig-note").textContent = "No figures yet. Drop one here or onto the page."; return; }
  figShown = file ?? (figShown || figures[0].file);
  let el = document.getElementById("figpane");
  if (!el) { el = h("div", { class: "pane figpane", id: "figpane" }); dock(el, $("editor"), "right"); }
  const pick = h("select", { "aria-label": "Figure to show" }, ...figures.map((f: any) => h("option", { value: f.file }, f.file.split("/").pop())));
  (pick as HTMLSelectElement).value = figShown;
  pick.addEventListener("change", () => openFigurePane((pick as HTMLSelectElement).value));
  const fig = figures.find((f: any) => f.file === figShown) ?? figures[0];
  el.replaceChildren(
    (() => { const hd = h("div", { class: "pane-head" }, pick,
      h("button", { type: "button", class: "link", title: "Insert this figure where the cursor is", onclick: () => insertFigure(fig.file, fig.id) }, "Insert"),
      h("button", { type: "button", class: "link", title: "Close", onclick: () => { el!.remove(); tidyLayout(); renderPaneHeads(); } }, "×")); dragToSnap(el!, hd); return hd; })(),
    h("div", { class: "figview" }, h("img", { src: `/api/figure/thumb?file=${encodeURIComponent(fig.file.split("/").pop())}&size=large&t=${Math.round(fig.mtime)}`, alt: fig.file })));
  addGrip(el);
  renderPaneHeads();
}

async function loadFigures() {
  const { figures, manifest } = await (await fetch("/api/figures")).json();
  $("fig-sync").hidden = !manifest;
  $("fig-grid").replaceChildren(...figures.map((f: any) =>
    h("button", { class: "fig", type: "button", title: `Click to insert ${f.file} at the cursor; ⌘-click to view it beside the text`, onclick: (e: MouseEvent) => (e.metaKey || e.ctrlKey ? openFigurePane(f.file) : insertFigure(f.file, f.id)) },
      h("img", { src: `/api/figure/thumb?file=${encodeURIComponent(f.file.split("/").pop())}&t=${Math.round(f.mtime)}`, alt: "", loading: "lazy" }),
      h("span", {}, f.file.split("/").pop()))));
}

async function syncFigureManifest() {
  const r = await (await fetch("/api/figures/sync", { method: "POST" })).json();
  $("fig-note").textContent = [`${r.updated.length} updated`, `${r.unchanged} unchanged`, r.missing.length && `missing: ${r.missing.join("; ")}`, r.errors.length && `errors: ${r.errors.join("; ")}`].filter(Boolean).join(" · ");
  loadFigures();
}

async function dropPapers(files: File[]) {
  const note = $("papers-note");
  for (const f of files) {
    note.textContent = `Reading ${f.name}…`;
    const r = await (await fetch(`/api/paper?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f })).json().catch(() => ({ error: "upload failed" }));
    note.textContent = r.error ? `${f.name}: ${r.error}`
      : !r.indexed ? `${f.name} was saved, but no text could be read from it (a scanned PDF?).`
      : `${f.name}: ${r.pages} pages indexed${r.cite ? `, matched to ${r.cite}` : ". Not matched to a bibliography entry yet; search PubMed to add it."}`;
  }
  await refreshStatusQuiet();
  lastQuery = "";
  scheduleSuggest();
}
const refreshStatusQuiet = () => fetch("/api/status").catch(() => null);

function dropZone(el: HTMLElement, onFiles: (files: File[]) => void) {
  el.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); el.classList.add("dropping"); } });
  el.addEventListener("dragleave", () => el.classList.remove("dropping"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("dropping"); const files = [...(e.dataTransfer?.files ?? [])]; if (files.length) onFiles(files); });
}

// ---------- dictation (Whisper, on this machine) ----------

/** 16 kHz mono 16-bit WAV, which is what whisper.cpp reads. */
export function encodeWav(chunks: Float32Array[], rate: number): Blob {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = rate / 16000;
  const len = Math.floor(n / ratio);
  const buf = new DataView(new ArrayBuffer(44 + len * 2));
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) buf.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); buf.setUint32(4, 36 + len * 2, true); str(8, "WAVE"); str(12, "fmt "); buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, 16000, true); buf.setUint32(28, 32000, true);
  buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); str(36, "data"); buf.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) { // linear resample when the browser would not record at 16 kHz
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    const v = Math.max(-1, Math.min(1, all[i0]! * (1 - f) + (all[i0 + 1] ?? all[i0]!) * f));
    buf.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Live dictation: the words appear as you speak. Audio is cut into phrases at natural pauses; the
// phrase being spoken is shown faded and may still change as Whisper hears more of it, and it turns
// solid once you pause. Everything is ordinary text you can edit afterwards.
const setDict = StateEffect.define<{ live: number; to: number } | null>();
const dictField = StateField.define<{ live: number; to: number } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDict)) return e.value;
    return v && tr.docChanged ? { live: tr.changes.mapPos(v.live, 1), to: tr.changes.mapPos(v.to, 1) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v && v.live < v.to ? Decoration.set([Decoration.mark({ class: "cm-dictating" }).range(v.live, v.to)]) : Decoration.none)),
});

interface Rec {
  ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[];
  view: EditorView; seg: number; said: string; busy: Promise<void> | null; timer: ReturnType<typeof setInterval>;
  from: number; citeTimer?: ReturnType<typeof setTimeout>; // where this dictation began; pending citation pass
}
let rec: Rec | null = null;
const rms = (parts: Float32Array[]) => { let s = 0, n = 0; for (const p of parts) { for (let i = 0; i < p.length; i += 4) s += p[i]! * p[i]!; n += p.length / 4; } return n ? Math.sqrt(s / n) : 0; };
const QUIET = 0.012; // below this the microphone is hearing room noise, not speech

/** Put the latest hearing of the current phrase into the text, replacing the previous hearing of it. */
function showPhrase(r: Rec, text: string, done: boolean) {
  const v = r.view.state.field(dictField, false);
  if (!v) return;
  const prev = r.view.state.sliceDoc(Math.max(0, v.live - 1), v.live);
  text = applyRules(text);
  // spoken "new paragraph" / "new section Results" … become LaTeX, only where a sentence starts
  const before = r.view.state.sliceDoc(Math.max(0, v.live - 4), v.live);
  text = dictationCommands(text, !before.trim() || /[.!?}\n]\s*$/.test(before));
  const insert = text ? (prev && !/\s/.test(prev) && !text.startsWith("\n") ? " " : "") + text : "";
  const to = v.live + insert.length;
  r.view.dispatch({
    changes: { from: v.live, to: v.to, insert },
    effects: setDict.of({ live: done ? to : v.live, to }),
    selection: { anchor: to },
    scrollIntoView: true,
    userEvent: "input.dictate",
  });
  if (done && text) {
    r.said = `${r.said} ${text}`.slice(-400);
    noteDictated(insert.length); // each phrase counted once, when it is final
    clearTimeout(r.citeTimer);
    r.citeTimer = setTimeout(() => dictatedCites(r), 600);
  }
}

/**
 * Spoken citations in the finished part of this dictation ("Peyron et al. 1998") become \citep{…} when the
 * bibliography or library has one clear match. Only text dictated in this session is touched, and only
 * if it has not changed while the server was looking.
 */
async function dictatedCites(r: Rec, final = false) {
  const v = r.view, f = v.state.field(dictField, false);
  const end = final || !f ? v.state.selection.main.head : f.live;
  const from = Math.min(r.from, end);
  const text = v.state.sliceDoc(from, end);
  if (!/\d{4}/.test(text)) return;
  const res = await fetch("/api/dictate/cites", { method: "POST", body: JSON.stringify({ text }), headers: { "content-type": "application/json" } }).then((x) => x.json()).catch(() => null);
  if (!res?.edits?.length || v.state.sliceDoc(from, from + text.length) !== text) return;
  v.dispatch({ changes: res.edits.map((e: any) => ({ from: from + e.from, to: from + e.to, insert: e.insert })), userEvent: "input.dictate.cite" });
}

/** Send the phrase in progress to Whisper; close it off when the speaker has paused. */
async function hearPhrase(r: Rec, final = false) {
  const end = r.chunks.length, part = r.chunks.slice(r.seg, end);
  const secs = (part.length * 4096) / r.ctx.sampleRate;
  if (!final && secs < 1.3) return; // a clip shorter than this makes Whisper guess
  const tail = part.slice(-Math.ceil((0.7 * r.ctx.sampleRate) / 4096));
  const paused = rms(tail) < QUIET;
  if (rms(part) < QUIET) { if (paused) r.seg = end; if (final) showPhrase(r, "", true); return; } // nothing but silence: never ask Whisper to invent words
  const res = await fetch("/api/dictate?live=1", { method: "POST", body: encodeWav(part, r.ctx.sampleRate), headers: { "x-dictation-context": encodeURIComponent(r.said.slice(-300)) } })
    .then((x) => x.json()).catch(() => ({ error: "Could not reach the server" }));
  if (res.error) { $("save").textContent = `Dictation: ${res.error}`; return; }
  const done = final || (paused && secs > 1.5) || secs > 24;
  showPhrase(r, res.text ?? "", done);
  if (done) r.seg = end;
}

async function toggleDictation() {
  const btn = $<HTMLButtonElement>("dictate");
  if (btn.disabled) return;
  if (!rec) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(ctx.destination);
      const v = view, head = v.state.selection.main.head;
      v.dispatch({ effects: setDict.of({ live: head, to: head }) });
      const r: Rec = { ctx, stream, node, chunks, view: v, seg: 0, said: v.state.sliceDoc(Math.max(0, head - 300), head), busy: null, timer: 0 as any, from: head };
      r.timer = setInterval(() => { if (!r.busy) r.busy = hearPhrase(r).finally(() => { r.busy = null; }); }, 700);
      rec = r;
      dictationStarted();
      cancelGhost();
      btn.classList.add("on");
      btn.firstChild!.textContent = "● Stop ";
      $("save").textContent = "Listening…";
    } catch { $("save").textContent = "Microphone access was not granted"; }
    return;
  }
  const r = rec;
  rec = null;
  dictationStopped();
  clearInterval(r.timer);
  r.node.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  btn.classList.remove("on");
  btn.firstChild!.textContent = "Finishing… ";
  await r.busy;
  await hearPhrase(r, true); // the last phrase, heard in full
  clearTimeout(r.citeTimer);
  await dictatedCites(r, true);
  await r.ctx.close();
  r.view.dispatch({ effects: setDict.of(null) });
  btn.firstChild!.textContent = "Dictate ";
  r.view.focus();
}

// ---------- Google Docs review rounds ----------
let shareNote = "";
async function renderShare() {
  const box = $("gdocs");
  const st = await (await fetch("/api/google/status")).json().catch(() => null);
  if (!st) return;
  if (!st.configured)
    return box.replaceChildren(h("p", { class: "empty" }, "To send chapters to Google Docs, save your Google client file as ", h("code", {}, st.clientFile), "."));
  if (!st.connected)
    return box.replaceChildren(h("button", { type: "button", onclick: connectGoogle }, "Connect Google"), h("p", { class: "empty" }, "Opens Google's own sign-in page. Vega Fluo is only allowed to touch documents it creates."));
  const rounds = current.endsWith(".tex") ? await (await fetch(`/api/share?path=${encodeURIComponent(current)}`)).json() : [];
  const liveRound = rounds.find((r: any) => r.live);
  box.replaceChildren(
    liveRound
      ? h("div", { class: "card" },
          h("div", { class: "who" }, "● Live Google Doc"),
          h("div", { class: "meta" },
            liveRound.pushedAt ? `Sent ${ago(liveRound.pushedAt)}` : "Waiting for the first change",
            liveRound.pulledAt ? ` · checked for edits ${ago(liveRound.pulledAt)}` : "",
            liveRound.conflicts ? ` · ${liveRound.conflicts} change${liveRound.conflicts === 1 ? "" : "s"} not sent because the reviewer edited the same words` : ""),
          liveRound.error && h("p", { class: "empty" }, `Problem: ${liveRound.error}`),
          h("p", { class: "empty" }, "Updates a few seconds after each save, dictation included. Edits and comments made in the doc arrive in the Review tab as suggestions, never straight into the file."),
          h("div", { class: "row" },
            h("a", { href: liveRound.url, target: "_blank", rel: "noopener noreferrer", class: "link" }, "Open in Google Docs"),
            h("button", { type: "button", class: "link", onclick: syncLive }, "Sync now"),
            h("button", { type: "button", class: "link", onclick: () => setLive(false) }, "Stop live")))
      : h("button", { type: "button", disabled: !current.endsWith(".tex"), onclick: () => setLive(true), title: "Creates a Google Doc that follows this chapter as you write" }, "Start a live Google Doc for this chapter"),
    h("button", { type: "button", class: "link", disabled: !current.endsWith(".tex"), onclick: sendForReview }, "Send a one-off copy for review"),
    shareNote && h("p", { class: "empty" }, shareNote),
    ...rounds.filter((r: any) => !r.live).map((r: any) =>
      h("div", { class: "card" },
        h("div", { class: "who" }, r.title),
        h("div", { class: "meta" }, `Sent ${ago(r.sentAt)}`, r.pulledAt ? ` · pulled ${ago(r.pulledAt)} · ${r.imported} brought in` : " · not pulled yet"),
        h("div", { class: "row" },
          h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", class: "link" }, "Open in Google Docs"),
          h("button", { type: "button", class: "link", onclick: () => pullReview(r.docId) }, "Pull review")))),
    h("div", { class: "row" }, h("button", { type: "button", class: "link", onclick: async () => { await fetch("/api/google/disconnect", { method: "POST" }); renderShare(); } }, "Disconnect Google")),
  );
}

async function connectGoogle() {
  const r = await (await fetch("/api/google/connect", { method: "POST" })).json();
  if (r.error) { shareNote = r.error; return renderShare(); }
  window.open(r.url, "_blank", "noopener,noreferrer");
  for (let i = 0; i < 90; i++) { // wait for the sign-in to finish in the other tab
    await new Promise((ok) => setTimeout(ok, 2000));
    if ((await (await fetch("/api/google/status")).json()).connected) break;
  }
  renderShare();
}

async function sendForReview() {
  await save();
  shareNote = "Creating the document…";
  renderShare();
  const r = await (await post("/api/share/send", { path: current })).json();
  shareNote = r.error ? `Could not send: ${r.error}` : "Sent. Open it in Google Docs and share it with your collaborator as a Commenter so their edits arrive as suggestions.";
  renderShare();
}

async function setLive(on: boolean) {
  await save();
  shareNote = on ? "Setting up the live doc…" : "";
  renderShare();
  const r = await (await post("/api/share/live", { path: current, on })).json();
  shareNote = r.error
    ? `Could not ${on ? "start" : "stop"} the live doc: ${r.error}`
    : on ? "Live. To let your collaborator see it and edit, open it in Google Docs and use Share (Editor, or Commenter if you only want suggestions)." : "Live updates stopped. The doc stays in your Drive.";
  renderShare();
}
async function syncLive() {
  await save();
  const r = await (await post("/api/share/live/sync", { path: current })).json();
  const n = (r.pull?.suggestions ?? 0) + (r.pull?.comments ?? 0);
  shareNote = r.error ? `Sync problem: ${r.error}` : `Synced${r.push?.pushed ? " (sent your latest)" : ""}${n ? `; brought in ${n} item${n === 1 ? "" : "s"} from the doc` : ""}.`;
  renderShare();
}
// keep the live card's times and status fresh while the panel shows it
setInterval(() => { if (!document.hidden && $("gdocs")?.querySelector(".card .who")?.textContent?.startsWith("●")) renderShare(); }, 15000);

async function pullReview(docId: string) {
  await save();
  const r = await (await post("/api/share/pull", { path: current, docId })).json();
  shareNote = r.error
    ? `Could not pull: ${r.error}`
    : r.suggestions + r.comments === 0
      ? "Nothing new in that document."
      : `Brought in ${r.suggestions} suggested change${r.suggestions === 1 ? "" : "s"} and ${r.comments} comment${r.comments === 1 ? "" : "s"}${r.unplaced ? ` (${r.unplaced} need placing by hand)` : ""}.`;
  if (!r.error) await openFile(current);
  renderShare();
}

// ---------- library: every reference that fits this section ----------
let libTimer: ReturnType<typeof setTimeout> | undefined;
let pubmedMode = false;
function setSource(pubmed: boolean) {
  pubmedMode = pubmed;
  $("src-lib").setAttribute("aria-pressed", String(!pubmed));
  $("src-pubmed").setAttribute("aria-pressed", String(pubmed));
  $<HTMLInputElement>("lib-q").placeholder = pubmed ? "Search PubMed, then press Enter" : "Search your library, or leave empty for this section";
  $("lib-list").replaceChildren();
  $("lib-head").textContent = pubmed ? "Nothing is sent to PubMed until you press Enter." : "";
  if (!pubmed) loadLibrary();
}

async function searchPubmedNow() {
  const q = $<HTMLInputElement>("lib-q").value.trim();
  if (q.length < 3) return;
  $("lib-head").textContent = "Searching PubMed…";
  const r = await (await post("/api/pubmed/search", { q })).json().catch(() => ({ error: "Could not reach the server" }));
  if (r.error) { $("lib-head").textContent = `PubMed search failed: ${r.error}`; return; }
  $("lib-head").textContent = `${r.hits.length} PubMed result${r.hits.length === 1 ? "" : "s"} for “${q}”`;
  $("lib-list").replaceChildren(
    ...r.hits.map((x: any) => {
      const act = h("button", { type: "button", class: "link" }, x.key ? `Cite ${x.key}` : "Add to bibliography and cite");
      act.addEventListener("click", async () => {
        let key = x.key;
        if (!key) {
          act.textContent = "Adding…";
          const a = await (await post("/api/pubmed/add", { pmid: x.pmid })).json();
          if (a.error) { act.textContent = `Failed: ${a.error}`; return; }
          key = x.key = a.key;
          await loadKeys();
          act.textContent = `Cite ${key}`;
        }
        insertCite(key);
      });
      return h("div", { class: "card compact" },
        h("div", { class: "meta" }, h("b", {}, `${x.authors} ${x.year}`.trim()), x.journal && ` · ${x.journal}`),
        h("div", { class: "title" }, x.title),
        h("div", { class: "row" }, h("a", { class: "link", href: `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/`, target: "_blank", rel: "noopener noreferrer" }, `PMID ${x.pmid}`), act));
    }),
  );
}

async function loadLibrary() {
  if (pubmedMode) return;
  const q = $<HTMLInputElement>("lib-q").value.trim();
  const sec = sectionAt(view.state);
  const text = q || `${sec.title} ${sec.title} ${sec.text.slice(0, 4000)}`;
  const res = await post("/api/library", { text, k: 40 }).catch(() => null);
  if (!res?.ok) return;
  const { refs, total } = await res.json();
  $("lib-head").textContent = q
    ? `${refs.length} of ${total} references match “${q}”`
    : `${refs.length} of ${total} references fit ${sec.title ? `“${sec.title}”` : "this section"}, best first`;
  $("lib-list").replaceChildren(
    ...refs.map((r: any) => withView(r.key,
      h("button", { class: "card compact", type: "button", title: "Insert citation", onclick: () => insertCite(r.key) },
        h("div", { class: "meta" }, h("b", {}, `${r.authors} ${r.year}`.trim() || r.key), r.journal && ` · ${r.journal}`, r.inProject && h("span", { class: "badge", style: "margin-left:6px" }, "cited"), r.hasPdf && h("span", { class: "badge pdf", style: "margin-left:6px", title: "You have the PDF: View opens it" }, "PDF")),
        h("div", { class: "title" }, r.title)))),
  );
  renderPdfLibrary();
}

// ---------- thesis styles (styles/*.tex, picked by one \\input line in main.tex) ----------
let thesisStyles: { names: string[]; current: string | null; root: string; about: Record<string, string>; figures: "text" | "clean" | null } = { names: [], current: null, root: "main.tex", about: {}, figures: null };
const loadStyles = () => fetch("/api/styles").then((r) => r.json()).then((s) => {
  const was = thesisStyles.figures;
  thesisStyles = s;
  setFigureVersion(s.figures ?? "text");
  if (was !== s.figures && showVisual) for (const p of panes) p.view.dispatch({ effects: visualComp.reconfigure(visual(p.lang)) });
}).catch(() => {});
/** Figures with their statistics text (to see what is what) or clean (statistics in the legend and Results). */
async function setFigureVersionTo(version: "text" | "clean") {
  const p = panes.find((x) => x.file === thesisStyles.root);
  if (p) {
    const doc = p.view.state.doc.toString(), m = /^(\s*)\\figureversion\{\w*\}/m.exec(doc);
    if (!m) { $("save").textContent = "main.tex has no \\figureversion line"; return; }
    p.view.dispatch({ changes: { from: m.index, to: m.index + m[0].length, insert: `${m[1]}\\figureversion{${version}}` }, annotations: internal.of(true), userEvent: "input.style" });
    await save(p);
  } else {
    const r = await post("/api/figure-version", { version }).then((x) => x.json()).catch(() => ({ error: "Could not reach the server" }));
    if (r.error) { $("save").textContent = r.error; return; }
  }
  await loadStyles();
  $("save").textContent = `Figures: ${version === "clean" ? "clean (statistics in the legends)" : "with statistics text"}. Building…`;
  build();
}
async function setThesisStyle(name: string) {
  const p = panes.find((x) => x.file === thesisStyles.root);
  if (p) { // main.tex is open: change it in the editor so the next save cannot undo it
    const doc = p.view.state.doc.toString(), m = /^(\s*)\\input\{styles\/[\w-]+\}/m.exec(doc);
    if (!m) { $("save").textContent = "main.tex has no \\input{styles/...} line"; return; }
    p.view.dispatch({ changes: { from: m.index, to: m.index + m[0].length, insert: `${m[1]}\\input{styles/${name}}` }, annotations: internal.of(true), userEvent: "input.style" });
    await save(p);
  } else {
    const r = await post("/api/styles", { name }).then((x) => x.json()).catch(() => ({ error: "Could not reach the server" }));
    if (r.error) { $("save").textContent = r.error; return; }
  }
  await loadStyles();
  $("save").textContent = `Thesis style: ${name}. Building…`;
  build();
}

// ---------- formatting toolbar ----------
const fmtLang = (): "tex" | "md" | "plain" => active?.lang ?? "tex";
function buildFormatBar() {
  const bar = $("fmtbar");
  const btn = (label: string, title: string, run: () => void, cls = "") => {
    const b = h("button", { type: "button", class: `fbtn ${cls}`, title, "aria-label": title }, label);
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor's selection
    b.addEventListener("click", run);
    return b;
  };
  const level = h("select", { id: "fmt-level", title: "Heading level of this line", "aria-label": "Heading level" },
    ...fmt.LEVELS.map((l) => h("option", { value: l.id }, l.label))) as HTMLSelectElement;
  level.addEventListener("change", () => fmt.setLevel(view, fmtLang(), level.value));
  const pop = (id: string, build: () => HTMLElement[]) => {
    const box = $(id);
    return () => {
      const open = box.hidden;
      for (const p of document.querySelectorAll<HTMLElement>(".fpop")) p.hidden = true;
      if (!open) return;
      box.replaceChildren(...build());
      box.hidden = false;
    };
  };
  // symbol picker: tabs of groups, a search box, click to insert
  const symbols = pop("fmt-symbols", () => {
    let group = remember.get("margin.symgroup") ?? "Greek";
    const grid = h("div", { class: "symgrid" });
    const fill = (q = "") => grid.replaceChildren(...Object.entries(fmt.SYMBOLS)
      .flatMap(([g, list]) => (q ? list : g === group ? list : []).filter(([cmd, glyph]) => !q || cmd.toLowerCase().includes(q) || glyph.includes(q)))
      .map(([cmd, glyph]) => { const b = h("button", { type: "button", title: cmd }, glyph); b.addEventListener("mousedown", (e) => e.preventDefault()); b.addEventListener("click", () => fmt.insertSymbol(view, cmd, Object.values(fmt.SYMBOLS.Text!).some(([c]) => c === cmd))); return b; }));
    const tabs = h("div", { class: "symtabs" }, ...Object.keys(fmt.SYMBOLS).map((g) => { const t = h("button", { type: "button", "aria-pressed": String(g === group) }, g); t.addEventListener("click", () => { group = g; remember.set("margin.symgroup", g); for (const x of tabs.children) x.setAttribute("aria-pressed", String(x === t)); fill(); }); return t; }));
    const search = h("input", { type: "search", placeholder: "Search…" }) as HTMLInputElement;
    search.addEventListener("input", () => fill(search.value.trim().toLowerCase()));
    fill();
    return [h("div", { class: "symhead" }, tabs, search), grid];
  });
  // table picker: hover a grid to choose rows × columns
  const tables = pop("fmt-table", () => {
    const note = h("div", { class: "quiet" }, "Choose a size");
    const grid = h("div", { class: "tgrid" });
    for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) {
      const cell = h("button", { type: "button", "data-r": String(r), "data-c": String(c), "aria-label": `${r} by ${c} table` });
      cell.addEventListener("mouseenter", () => { note.textContent = `${r} × ${c}`; for (const x of grid.children) x.classList.toggle("on", Number((x as HTMLElement).dataset.r) <= r && Number((x as HTMLElement).dataset.c) <= c); });
      cell.addEventListener("mousedown", (e) => e.preventDefault());
      cell.addEventListener("click", () => { $("fmt-table").hidden = true; fmt.table(view, r, c); });
      grid.append(cell);
    }
    return [note, grid];
  });
  const tex = () => fmtLang() !== "plain";
  bar.replaceChildren(
    btn("↶", "Undo (⌘Z)", () => { undo(view); view.focus(); }), btn("↷", "Redo (⌘⇧Z)", () => { redo(view); view.focus(); }),
    h("span", { class: "fsep" }), level, h("span", { class: "fsep" }),
    btn("B", "Bold (⌘B)", () => tex() && fmt.bold(view, fmtLang()), "b"), btn("I", "Italic (⌘I)", () => tex() && fmt.italic(view, fmtLang()), "i"),
    btn("x²", "Superscript (⌘⇧=)", () => tex() && fmt.script(view, fmtLang(), true)), btn("x₂", "Subscript (⌘⇧−)", () => tex() && fmt.script(view, fmtLang(), false)),
    h("span", { class: "fsep" }),
    btn("√x", "Inline maths $…$ (⌘M)", () => fmt.inlineMath(view)), btn("∑", "Display equation", () => fmt.displayMath(view)),
    btn("Ω", "Symbols", symbols),
    h("span", { class: "fsep" }),
    btn("⊞", "Insert table", tables), btn("•≡", "Bulleted list", () => fmt.list(view, fmtLang(), false)), btn("1≡", "Numbered list", () => fmt.list(view, fmtLang(), true)),
    btn("💬", "Comment on the selection (⌘⌥M)", () => { if (view.state.selection.main.empty) { $("save").textContent = "Select the text to comment on first"; return; } showTab("review"); $("comment-text").focus(); }),
  );
  document.addEventListener("pointerdown", (e) => { if (!(e.target as HTMLElement).closest(".fpop, #fmtbar")) for (const p of document.querySelectorAll<HTMLElement>(".fpop")) p.hidden = true; }, true);
}
/** Keep the heading-level menu in step with the line the cursor is on. */
function syncFormatBar() {
  const sel = document.getElementById("fmt-level") as HTMLSelectElement | null;
  if (!sel || !view) return;
  const lvl = fmt.levelAt(view.state, fmtLang());
  sel.value = fmt.LEVELS.some((l) => l.id === lvl) ? lvl : "text";
  document.getElementById("fmtbar")!.classList.toggle("disabled", fmtLang() === "plain");
}

// ---------- viewing a paper: its PDF if you have it, otherwise its abstract and links ----------
/** A reference card plus a small View button (a button cannot sit inside the card, which is itself a button). */
function withView(key: string, card: HTMLElement) {
  return h("div", { class: "refrow" }, card, h("button", { class: "viewref", type: "button", title: "View this paper beside the text", onclick: () => openPaperPane(key) }, "View"));
}
async function openPaperPane(key: string) {
  let el = document.getElementById("paperpane");
  if (!el) { el = h("div", { class: "pane paperpane", id: "paperpane" }); dock(el, $("editor"), "right"); }
  const close = h("button", { type: "button", class: "link", title: "Close", onclick: () => { el!.remove(); tidyLayout(); renderPaneHeads(); } }, "×");
  const head = h("div", { class: "pane-head" }, h("span", { class: "name" }, key), close);
  const body = h("div", { class: "paperview" }, h("p", { class: "empty" }, "Loading…"));
  el.replaceChildren(head, body);
  dragToSnap(el, head);
  addGrip(el);
  renderPaneHeads();
  const p = await fetch(`/api/paper/info?key=${encodeURIComponent(key)}&fetch=1`).then((r) => r.json()).catch(() => ({ error: "Could not reach the server" }));
  if (!el.isConnected) return;
  if (p.error) { body.replaceChildren(h("p", { class: "empty" }, p.error)); return; }
  const out = (label: string, href: string) => h("a", { class: "link", href, target: "_blank", rel: "noopener noreferrer" }, label);
  const links = [
    h("button", { type: "button", onclick: () => insertCite(key) }, "Insert citation"),
    p.hasPdf && out("Open PDF in a tab ↗", `/api/paper/pdf?key=${encodeURIComponent(key)}`),
    p.pmid && out("PubMed ↗", `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`),
    p.doi && out("Publisher (DOI) ↗", `https://doi.org/${p.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`),
    !p.pmid && !p.doi && out("Search Google Scholar ↗", `https://scholar.google.com/scholar?q=${encodeURIComponent(p.title)}`),
  ].filter(Boolean) as HTMLElement[];
  body.replaceChildren(
    h("div", { class: "paperinfo" }, ...[
      h("div", { class: "title" }, p.title || key),
      h("div", { class: "meta" }, [p.authors, p.year, p.journal].filter(Boolean).join(" · ")),
      h("div", { class: "row" }, ...links),
      !p.hasPdf && p.abstract && h("p", { class: "abstract" }, p.abstract),
      p.hasPdf && p.abstract && h("details", {}, h("summary", {}, "Abstract"), h("p", { class: "abstract" }, p.abstract))].filter(Boolean) as HTMLElement[]),
    p.hasPdf
      ? h("iframe", { class: "paperframe", src: `/api/paper/pdf?key=${encodeURIComponent(key)}#view=FitH`, title: `PDF of ${key}` })
      : attachZone(key),
  );
}

/** No PDF for this paper yet: drop one here (or pick a file) and it is kept with the project for this reference. */
function attachZone(key: string) {
  const input = h("input", { type: "file", accept: "application/pdf,.pdf", hidden: true }) as HTMLInputElement;
  const note = h("p", { class: "empty" }, "PDF not found in your collections.");
  const zone = h("div", { class: "attachzone" },
    note,
    h("p", {}, "Drop the PDF here, or ", h("button", { type: "button", class: "link", onclick: () => input.click() }, "choose a file"), "."),
    input);
  const send = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { note.textContent = "That is not a PDF."; return; }
    note.textContent = `Adding ${f.name}…`;
    const r = await fetch(`/api/paper/attach?key=${encodeURIComponent(key)}`, { method: "PUT", body: f }).then((x) => x.json()).catch(() => ({ error: "Could not reach the server" }));
    if (r.error) { note.textContent = r.error; return; }
    openPaperPane(key);
  };
  input.addEventListener("change", () => send(input.files?.[0]));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove("over"); send(e.dataTransfer?.files[0]); });
  return zone;
}

/** The line in the Library tab that says which folders hold your PDFs and how many were matched. */
let pdfPoll = 0;
async function renderPdfLibrary() {
  const st = await fetch("/api/pdf-library").then((r) => r.json()).catch(() => null);
  if (!st) return;
  const input = h("input", { type: "text", spellcheck: "false", placeholder: "~/path/to/your/PDF folder (several: separate with ;)", value: st.folders.join("; "), "aria-label": "PDF folders" }) as HTMLInputElement;
  const note = st.error ? st.error : st.scanning ? `Reading PDFs… ${st.done} checked, ${st.matched} matched to references so far`
    : st.folders.length ? `${st.files} PDFs indexed, ${st.matched} matched to references. Matched papers open with View.` : "Point this at the folder that holds your PDFs. Only the first two pages of each are read, to match it to a reference; nothing is copied or uploaded.";
  const go = async () => {
    const r = await post("/api/pdf-library", { folders: input.value.split(";").map((x) => x.trim()).filter(Boolean) }).then((x) => x.json()).catch(() => ({ error: "Could not reach the server" }));
    if (r.error) { $("pdf-lib").querySelector(".empty")!.textContent = r.error; return; }
    renderPdfLibrary();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("pdf-lib").replaceChildren(h("div", { class: "row" }, input, h("button", { type: "button", onclick: go }, st.folders.length ? "Rescan" : "Index")), h("p", { class: "empty" }, note));
  clearTimeout(pdfPoll);
  if (st.scanning && !$("tab-library").hidden) pdfPoll = setTimeout(renderPdfLibrary, 2000) as unknown as number;
}

// ---------- palette ----------
interface Item { kind: string; label: string; hint?: string; run: () => void }
let items: Item[] = [];
let picked = 0;

function paletteItems(): Item[] {
  return [
    ...proj.tree.map((p) => ({ kind: "File", label: p, run: () => openFile(p) })),
    ...proj.tree.filter((p) => !panes.some((x) => x.file === p)).map((p) => ({ kind: "Beside", label: p, hint: "open beside", run: () => openBeside(p) })),
    ...(panes.length > 1 ? [{ kind: "Action", label: "Close this pane", run: () => closePane(active) }] : []),
    { kind: "Action", label: "Show figures beside the text", run: () => openFigurePane() },
    ...proj.outline.map((o) => ({ kind: "Heading", label: o.title, hint: o.file, run: () => jump(o.file, o.line) })),
    { kind: "Action", label: "Build PDF", run: build },
    { kind: "Action", label: "Show the cursor position in the PDF", run: toPdf },
    { kind: "Action", label: "Go to the source for this PDF page", run: () => toSource(currentPdfPage(), 0.5, 0.35) },
    { kind: "Action", label: "Find arguments for this paragraph", run: findArguments },
    { kind: "Action", label: "Show checks", run: () => showTab("checks") },
    { kind: "Action", label: "Check the claims in this paragraph", run: checkClaims },
    { kind: "Action", label: rec ? "Stop dictation" : "Dictate", run: toggleDictation },
    { kind: "Action", label: showVisual ? "Show figures as code" : "Show figures visually", run: () => setVisual(!showVisual) },
    { kind: "Action", label: spellOn ? "Turn spell check off" : "Turn spell check on", run: () => setSpelling(!spellOn) },
    { kind: "Action", label: "Spelling: my words and remembered corrections", run: openSpellList },
    { kind: "Action", label: "Appearance: colours, fonts, size, sounds", run: openLook },
    { kind: "Action", label: autoBuild ? "Turn auto-compile off" : "Turn auto-compile on", run: () => setAutoBuild(!autoBuild) },
    { kind: "Action", label: "Dark PDF pages on or off", run: () => setPdfDark(!document.body.classList.contains("pdf-dark")) },
    ...(thesisStyles.figures ? [{ kind: "Figures", label: thesisStyles.figures === "clean" ? "Show figures with their statistics text" : "Show clean figures (statistics in the legends)", hint: `now: ${thesisStyles.figures === "clean" ? "clean" : "with statistics text"}`, run: () => setFigureVersionTo(thesisStyles.figures === "clean" ? "text" : "clean") }] : []),
    ...thesisStyles.names.map((n) => ({ kind: "Thesis style", label: `${n}${n === thesisStyles.current ? "  ✓ in use" : ""}`, hint: thesisStyles.about[n] ?? "", run: () => setThesisStyle(n) })),
    ...THEMES.map((t) => ({ kind: "Theme", label: t.name, run: () => setLook({ theme: t.id }) })),
    { kind: "Action", label: "Zoom in", run: () => setLook({ zoom: Math.min(160, look.zoom + 10) }) },
    { kind: "Action", label: "Zoom out", run: () => setLook({ zoom: Math.max(70, look.zoom - 10) }) },
    { kind: "Action", label: look.sound ? "Turn typing sounds off" : "Turn typing sounds on", run: () => setLook({ sound: !look.sound }) },
    { kind: "Action", label: "Show or hide the side panel", run: () => setPanel(mainEl.classList.contains("no-panel")) },
    { kind: "Action", label: $("editor").classList.contains("no-minimap") ? "Show the minimap" : "Hide the minimap", run: () => setMinimap($("editor").classList.contains("no-minimap")) },
    { kind: "Action", label: showNumbers ? "Hide line numbers" : "Show line numbers", run: () => setNumbers(!showNumbers) },
    { kind: "Action", label: "Show or hide the file list", run: () => setSidebar(mainEl.classList.contains("no-side")) },
    { kind: "Action", label: "File history (earlier versions)", run: openHistory },
    { kind: "Action", label: "Model disagreement log", run: () => showTab("log") },
    { kind: "Action", label: "Knowledge map", run: () => showTab("map") },
    { kind: "Action", label: "Figures", run: () => showTab("figures") },
    { kind: "Action", label: "Search PubMed", run: () => { showTab("library"); setSource(true); $("lib-q").focus(); } },
    { kind: "Action", label: suggesting ? "Switch to editing" : "Switch to suggesting (track changes)", run: () => setMode(!suggesting) },
    { kind: "Action", label: "Review changes and comments", run: () => showTab("review") },
    { kind: "Action", label: "Browse references for this section", run: () => showTab("library") },
    { kind: "Action", label: "Rebuild the library index", run: reindex },
    { kind: "Action", label: "New file", run: newFile },
  ];
}

function renderPalette() {
  const words = $<HTMLInputElement>("palette-input").value.toLowerCase().split(/\s+/).filter(Boolean);
  items = paletteItems().filter((i) => words.every((w) => `${i.label} ${i.hint ?? ""} ${i.kind}`.toLowerCase().includes(w))).slice(0, 40);
  picked = Math.min(picked, Math.max(0, items.length - 1));
  $("palette-list").replaceChildren(
    ...items.map((i, n) =>
      h("button", { class: "row-btn", type: "button", role: "option", "aria-selected": String(n === picked), onclick: () => runItem(n) },
        h("span", { class: "kind" }, i.kind), h("span", { class: "name" }, i.label), i.hint && h("span", { class: "n" }, i.hint))),
  );
  $("palette-list").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
function openPalette() {
  const input = $<HTMLInputElement>("palette-input");
  input.value = "";
  picked = 0;
  renderPalette();
  $<HTMLDialogElement>("palette").showModal();
  input.focus();
}
function runItem(n: number) {
  $<HTMLDialogElement>("palette").close();
  items[n]?.run();
}
$("palette-input").addEventListener("input", () => { picked = 0; renderPalette(); });
$("palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    picked = (picked + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
    renderPalette();
  } else if (e.key === "Enter") { e.preventDefault(); runItem(picked); }
});
$("palette").addEventListener("click", (e) => { if (e.target === e.currentTarget) $<HTMLDialogElement>("palette").close(); });

// ---------- resizable layout ----------
const rootStyle = document.documentElement.style;
const mainEl = document.querySelector("main")!;


/** Drag a divider: `width(x)` turns the pointer position into the new width of the thing being resized. */
function dragDivider(handle: HTMLElement, onMove: (x: number, y: number) => void, onDone?: () => void) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* capture is a nicety, not a requirement */ }
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => onMove(ev.clientX, ev.clientY);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      onDone?.();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
// ---------- column sizes, computed here rather than in CSS so they are always exact ----------
// The file list has a width in pixels; the side panel a share of the window (one for the PDF and map,
// one for the other tabs). The text always keeps at least MIN_TEXT pixels: the panel gives way first.
const MIN_TEXT = 512, SIDE_DEFAULT = 232, PANEL_DEFAULT = 0.26, WIDE_DEFAULT = 0.46;
const num = (k: string, fallback: number) => { const v = parseFloat(remember.get(k) ?? ""); return Number.isFinite(v) && v > 0 ? v : fallback; };
let sideW = num("margin.sideW", SIDE_DEFAULT), panelShare = num("margin.panelShare", PANEL_DEFAULT), wideShare = num("margin.wideShare", WIDE_DEFAULT);
// sizes saved by earlier versions (--side-w in px, panels in px or vw)
{
  const old = (k: string) => remember.get(`margin.${k}`) ?? "";
  const asShare = (v: string) => (v.endsWith("vw") ? parseFloat(v) / 100 : v.endsWith("px") ? parseFloat(v) / window.innerWidth : NaN);
  if (old("--side-w").endsWith("px") && !remember.get("margin.sideW")) sideW = parseFloat(old("--side-w")) || SIDE_DEFAULT;
  if (old("--panel-w") && !remember.get("margin.panelShare")) panelShare = asShare(old("--panel-w")) || PANEL_DEFAULT;
  if (old("--panel-wide") && !remember.get("margin.wideShare")) wideShare = asShare(old("--panel-wide")) || WIDE_DEFAULT;
  for (const k of ["--side-w", "--panel-w", "--panel-wide"]) { remember.set(`margin.${k}`, ""); rootStyle.removeProperty(k); }
}
const isWide = () => mainEl.classList.contains("wide");
function layout() {
  const W = mainEl.getBoundingClientRect().width;
  if (window.innerWidth <= 640 || !W) { mainEl.style.removeProperty("grid-template-columns"); return; }
  const sideOn = !mainEl.classList.contains("no-side"), panelOn = !mainEl.classList.contains("no-panel");
  const side = sideOn ? clamp(sideW, 150, Math.min(520, W * 0.4)) : 0;
  const want = (isWide() ? wideShare : panelShare) * W;
  const room = W - side - MIN_TEXT; // what the panel may take without squeezing the text
  const panel = !panelOn ? 0 : room >= 260 ? clamp(want, 260, room) : clamp(Math.min(want, W - side - 280), 0, W); // tight window: text keeps 280px at least
  mainEl.style.setProperty("grid-template-columns", `${Math.round(side)}px minmax(0, 1fr) ${Math.round(panel)}px`, "important");
  $("split-side").style.left = `${Math.round(side) - 5}px`;
  $("split-panel").style.left = `${Math.round(W - panel) - 4}px`;
  $("split-panel").style.right = "auto";
}
new ResizeObserver(() => layout()).observe(mainEl);
new MutationObserver(() => layout()).observe(mainEl, { attributes: true, attributeFilter: ["class"] });
dragDivider($("split-side"), (x) => { sideW = clamp(x - mainEl.getBoundingClientRect().left, 150, 520); remember.set("margin.sideW", String(Math.round(sideW))); layout(); });
dragDivider($("split-panel"), (x) => {
  const r = mainEl.getBoundingClientRect(), share = clamp((r.right - x) / r.width, 0.12, 0.8);
  if (isWide()) { wideShare = share; remember.set("margin.wideShare", share.toFixed(3)); } else { panelShare = share; remember.set("margin.panelShare", share.toFixed(3)); }
  layout();
});
$("split-side").addEventListener("dblclick", () => { sideW = SIDE_DEFAULT; remember.set("margin.sideW", ""); layout(); });
$("split-panel").addEventListener("dblclick", () => { if (isWide()) { wideShare = WIDE_DEFAULT; remember.set("margin.wideShare", ""); } else { panelShare = PANEL_DEFAULT; remember.set("margin.panelShare", ""); } layout(); });

/** A handle on the leading edge of a pane (or split) that trades space with the one before it. */
function addGrip(el: HTMLElement) {
  const grip = h("div", { class: "pane-grip", title: "Drag to resize" });
  el.append(grip);
  let prev: HTMLElement, start = 0, total = 0, col = false;
  const size = (x: Element) => (col ? x.getBoundingClientRect().height : x.getBoundingClientRect().width);
  grip.addEventListener("pointerdown", () => {
    const box = el.parentElement!;
    col = isCol(box);
    prev = el.previousElementSibling as HTMLElement;
    // freeze every sibling at its current size so only the two neighbours trade space
    for (const p of box.children) if (p.matches(".pane, .split")) (p as HTMLElement).style.flex = `${size(p)} 1 0`;
    start = col ? prev.getBoundingClientRect().top : prev.getBoundingClientRect().left;
    total = size(prev) + size(el);
  }, true);
  dragDivider(grip, (x, y) => {
    const w = clamp((col ? y : x) - start, Math.min(120, total / 2), total - Math.min(120, total / 2));
    prev.style.flex = `${w} 1 0`;
    el.style.flex = `${total - w} 1 0`;
  });
}

// On a phone the editor gets the whole screen; the file list and the side panel open over it instead.
const phone = () => matchMedia("(max-width: 640px)").matches;
let phoneReady = false; // after the saved desktop arrangement is put back
function phoneLayer(which: "m-side" | "m-panel", on: boolean) {
  document.body.classList.toggle(which, on);
  if (on) document.body.classList.remove(which === "m-side" ? "m-panel" : "m-side");
}
function setSidebar(on: boolean) {
  if (phone() && phoneReady) return phoneLayer("m-side", !document.body.classList.contains("m-side"));
  mainEl.classList.toggle("no-side", !on);
  $("side-toggle").setAttribute("aria-pressed", String(on));
  remember.set("margin.sidebar", on ? "1" : "0");
}
function setPanel(on: boolean) {
  if (phone() && phoneReady) return phoneLayer("m-panel", on);
  mainEl.classList.toggle("no-panel", !on);
  $("panel-toggle").setAttribute("aria-pressed", String(on));
  remember.set("margin.panel", on ? "1" : "0");
}
$("side-toggle").addEventListener("click", () => setSidebar(mainEl.classList.contains("no-side")));
$("panel-toggle").addEventListener("click", () => (phone() ? phoneLayer("m-panel", !document.body.classList.contains("m-panel")) : setPanel(mainEl.classList.contains("no-panel"))));
setPanel(remember.get("margin.panel") !== "0");
setSidebar(remember.get("margin.sidebar") !== "0");
phoneReady = true;

// ---------- appearance: colours, fonts, size, zoom, sounds ----------
let look: Look = loadLook();
applyLook(look);
const isDark = () => document.documentElement.hasAttribute("data-dark");

function setLook(change: Partial<Look>) {
  look = { ...look, ...change };
  applyLook(look);
  renderLook();
  for (const p of panes) { p.view.requestMeasure(); p.minimap.redraw(); }
  map?.redraw();
}

function renderLook() {
  $("look-themes").replaceChildren(...THEMES.map((t) =>
    h("button", { class: "swatch", type: "button", "aria-pressed": String(look.theme === t.id), onclick: () => setLook({ theme: t.id }) },
      h("div", { class: "chip-row", style: `background:${t.swatch[0]};color:${t.swatch[1]}` }, "Aa", h("i", { style: `background:${t.swatch[2]}` })),
      h("span", {}, t.name))));
  const set = (id: string, v: string | number) => { ($(id) as HTMLInputElement).value = String(v); };
  set("look-font", look.font); set("look-ui", look.ui); set("look-size", look.size); set("look-leading", look.leading);
  set("look-measure", look.measure); set("look-zoom", look.zoom); set("look-sound", look.sound ? "on" : "off"); set("look-pack", look.pack); set("look-volume", look.volume); set("look-mono", look.mono);
  warmPack(look);
  $("look-size-v").textContent = `${look.size} px`;
  $("look-leading-v").textContent = look.leading.toFixed(2);
  $("look-measure-v").textContent = `${look.measure}`;
  $("look-zoom-v").textContent = `${look.zoom}%`;
  $("look-volume-v").textContent = `${Math.round(look.volume * 100)}%`;
}
$("look-font").replaceChildren(...FONTS.map((f) => h("option", { value: f.id }, f.name)));
$("look-pack").replaceChildren(...[...new Set(PACKS.map((p) => p.group))].map((g) => h("optgroup", { label: g }, ...PACKS.filter((p) => p.group === g).map((p) => h("option", { value: p.id }, p.name)))));
$("look-mono").replaceChildren(...CODE_FONTS.map((f) => h("option", { value: f.id }, f.name)));
const onInput = (id: string, apply: (v: string) => Partial<Look>) => $(id).addEventListener("input", (e) => setLook(apply((e.target as HTMLInputElement).value)));
onInput("look-font", (v) => ({ font: v }));
onInput("look-mono", (v) => ({ mono: v }));
onInput("look-ui", (v) => ({ ui: v }));
onInput("look-size", (v) => ({ size: Number(v) }));
onInput("look-leading", (v) => ({ leading: Number(v) }));
onInput("look-measure", (v) => ({ measure: Number(v) }));
onInput("look-zoom", (v) => ({ zoom: Number(v) }));
onInput("look-sound", (v) => ({ sound: v === "on" }));
onInput("look-pack", (v) => ({ pack: v }));
onInput("look-volume", (v) => ({ volume: Number(v) }));
$("look-try").addEventListener("click", async () => { warmPack({ ...look, sound: true }); await new Promise((r) => setTimeout(r, 350)); for (const [i, k] of (["key", "key", "space", "key", "enter"] as const).entries()) setTimeout(() => playKey({ ...look, sound: true }, k), i * 110); });
$("look-custom").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null;
  $("look-note").textContent = await setCustomSound(f);
  if (f) setLook({ pack: "custom", sound: true });
});
$("look-reset").addEventListener("click", () => setLook({ ...DEFAULT_LOOK }));
$("look").addEventListener("click", (e) => { if (e.target === e.currentTarget) $<HTMLDialogElement>("look").close(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setLook({}));
const openLook = () => { renderLook(); $<HTMLDialogElement>("look").showModal(); };

// ---------- top bar ----------
let bootId = 0;
async function refreshStatus() {
  const s = await (await fetch("/api/status")).json();
  if (bootId && s.boot && s.boot !== bootId) $("stale").hidden = false; // Margin was restarted with newer code than this tab is running
  bootId ||= s.boot;
  setAuthor(s.user);
  renderBackup(s.backup);
  judges = s.judges;
  setJudge(judgeId);
  const d = $<HTMLButtonElement>("dictate");
  d.disabled = !s.dictation.ready;
  if (!s.dictation.ready) d.title = s.dictation.reason;
  $("papers-note").textContent = `${s.papers} PDF paper${s.papers === 1 ? "" : "s"} indexed. Drop PDFs here to add more; their text becomes searchable evidence.`;
  $("dot").className = `dot ${s.llm.ok ? "ok" : "off"}`;
  $("status-text").textContent = `${s.refs.toLocaleString()} refs · ${s.passages.toLocaleString()} passages · ${s.llm.ok ? s.llm.model : "model offline"}`;
  $("status").title = `${s.llm.ok ? "Model: " + s.llm.model : "Model offline: " + s.llm.error}\nLibrary: ${s.files} files indexed in ${s.indexMs} ms\nBibliography: ${s.projectRefs} entries\nClick to rebuild the index`;
}

async function loadKeys() {
  const k = await (await fetch("/api/keys")).json();
  projectKeys = new Set(k.project);
  libraryKeys = new Set(k.library);
  // re-run the citation marks against the new key sets; cursor and undo history are untouched
  for (const p of panes) {
    if (p.file) p.view.dispatch({ effects: citeComp.reconfigure(p.lang === "plain" ? [] : citeMarks(p.lang)) });
    p.minimap.rebuild();
  }
}

async function reindex() {
  $("status-text").textContent = "Rebuilding index…";
  await fetch("/api/reindex", { method: "POST" });
  await Promise.all([loadKeys(), refreshStatus(), loadProject()]);
  lastQuery = "";
  scheduleSuggest();
}

async function newFile() {
  const raw = prompt("Path for the new file, for example chapters/chapter_03.tex");
  const path = raw?.trim().replace(/^\/+/, "");
  if (!path || !/^[\w][\w .\-/]*\.(tex|bib|md|txt)$/.test(path) || path.includes("..")) return;
  if (!(await fetch(fileUrl(path))).ok) {
    const stub = /^chapters\/.*\.tex$/.test(path) ? "\\chapter{Title}\n\\label{ch:}\n\n" : "";
    await fetch(fileUrl(path), { method: "PUT", body: stub });
  }
  await loadProject();
  await openFile(path);
}

for (const b of document.querySelectorAll<HTMLElement>(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab!));
$("mode").addEventListener("click", () => setMode(!suggesting));
$("theme").addEventListener("click", openLook);
$("numbers").setAttribute("aria-pressed", String(showNumbers));
$("numbers").addEventListener("click", () => setNumbers(!showNumbers));
$("changes-sort").addEventListener("click", () => { changesNewest = !changesNewest; remember.set("margin.changesNewest", changesNewest ? "1" : "0"); renderReview(); });
$("accept-all").addEventListener("click", () => resolveAll(view, true));
$("reject-all").addEventListener("click", () => resolveAll(view, false));
$("comment-add").addEventListener("click", submitComment);
$("comment-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment(); });
$("lib-q").addEventListener("input", () => { if (pubmedMode) return; clearTimeout(libTimer); libTimer = setTimeout(loadLibrary, 250); });
$("lib-q").addEventListener("keydown", (e) => { if (e.key === "Enter" && pubmedMode) searchPubmedNow(); });
$("src-lib").addEventListener("click", () => setSource(false));
$("src-pubmed").addEventListener("click", () => setSource(true));
$("verify").addEventListener("click", checkClaims);
$("map-follow").setAttribute("aria-pressed", String(mapFollow));
$("map-follow").addEventListener("click", () => { mapFollow = !mapFollow; remember.set("margin.mapFollow", mapFollow ? "1" : "0"); $("map-follow").setAttribute("aria-pressed", String(mapFollow)); map?.setFollow(mapFollow); });
$("map-labels").addEventListener("click", () => { const on = $("map-labels").getAttribute("aria-pressed") !== "true"; $("map-labels").setAttribute("aria-pressed", String(on)); map?.setLabels(on); });
$("map-fit").addEventListener("click", () => map?.fit());
$("judge").addEventListener("change", (e) => setJudge((e.target as HTMLSelectElement).value));
$("judge2").addEventListener("change", (e) => { secondId = (e.target as HTMLSelectElement).value; setJudge(judgeId); });
$("dictate").addEventListener("click", toggleDictation);
$("fig-sync").addEventListener("click", syncFigureManifest);
$("fig-beside").addEventListener("click", () => openFigurePane());
$("history-open").addEventListener("click", openHistory);
// Anywhere on the side panel accepts a drop: papers when the Library tab is showing, figures otherwise.
dropZone($("panel"), (files) => {
  if (!$("tab-library").hidden) return dropPapers(files);
  showTab("figures");
  dropFigures(files, null);
});
// a file dropped anywhere else must never make the browser leave Margin to open it
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => { if ((e as DragEvent).dataTransfer?.types.includes("Files")) e.preventDefault(); });
$("new").addEventListener("click", newFile);
$("argue").addEventListener("click", findArguments);
$("build").addEventListener("click", () => build());
// comments from a Word file (a Google Doc downloaded as .docx)
$("import-comments").addEventListener("click", () => $<HTMLInputElement>("import-file").click());
$("import-file").addEventListener("change", async () => {
  const f = $<HTMLInputElement>("import-file").files?.[0];
  if (!f) return;
  const note = $("import-note");
  note.hidden = false; note.textContent = `Reading ${f.name}…`;
  await Promise.all(panes.map((p) => save(p)));
  const r = await fetch("/api/review/import", { method: "POST", body: f }).then((x) => x.json()).catch(() => ({ error: "Could not reach the server" }));
  $<HTMLInputElement>("import-file").value = "";
  if (r.error) { note.textContent = r.error; return; }
  const missing = r.unplaced.filter((u: any) => u.context !== "(reply)");
  note.replaceChildren(
    `${r.added} comment thread${r.added === 1 ? "" : "s"} added from ${f.name}` + (r.added < r.placed.length ? ` (${r.placed.length - r.added} were already here)` : "") + ".",
    ...(missing.length ? [h("br"), `${missing.length} could not be placed, because their text is not in the thesis yet:`, h("ul", {}, ...missing.map((u: any) => h("li", {}, `${u.author}: ${u.text.slice(0, 140)}`)))] : []),
  );
  for (const p of panes) if (!p.dirty) await reloadKeepingPlace(p);
  renderReview();
});
const setAutoBuild = (on: boolean) => {
  autoBuild = on;
  remember.set("margin.autoBuild", on ? "1" : "0");
  $("autobuild").setAttribute("aria-pressed", String(on));
  $("autobuild").textContent = on ? "Auto ●" : "Auto";
  if (!on) { clearTimeout(autoTimer); buildAgain = false; }
  else build(true);
};
setAutoBuild(autoBuild);
$("autobuild").addEventListener("click", () => setAutoBuild(!autoBuild));
// dark PDF pages: a display filter only, the built PDF is untouched
const setPdfDark = (on: boolean) => { document.body.classList.toggle("pdf-dark", on); $("pdf-dark").setAttribute("aria-pressed", String(on)); remember.set("margin.pdfDark", on ? "1" : "0"); };
setPdfDark(remember.get("margin.pdfDark") === "1");
$("pdf-thumbs-toggle").addEventListener("click", () => setThumbs(!thumbsOn));
$("pdf-thumbs-toggle").setAttribute("aria-pressed", String(thumbsOn));
$("pdf-dark").addEventListener("click", () => setPdfDark(!document.body.classList.contains("pdf-dark")));
buildFormatBar();
loadStyles();
document.addEventListener("pointerdown", (e) => { if (!$("spellmenu").hidden && !(e.target as HTMLElement).closest("#spellmenu")) $("spellmenu").hidden = true; }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("spellmenu").hidden = true; });
$("spell-list").addEventListener("click", (e) => { if (e.target === e.currentTarget) $<HTMLDialogElement>("spell-list").close(); });
fetch("/api/spell/words").then((r) => r.json()).then((s) => { spellRules = s.rules ?? {}; }).catch(() => {});
$("visual").addEventListener("click", () => setVisual(!showVisual));
$("visual").setAttribute("aria-pressed", String(showVisual));
$("figedit-file").addEventListener("change", renderFigEdit);
$("figedit-cap-on").addEventListener("change", renderFigEdit);
$("figedit-label-on").addEventListener("change", renderFigEdit);
$("figedit-width").addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest("button"); if (b && figEditing) { const w = Number(b.dataset.w); figEditing.width = figEditing.width === w ? null : w; renderFigEdit(); } });
$("figedit-done").addEventListener("click", applyFigEdit);
$("figedit-cancel").addEventListener("click", () => $<HTMLDialogElement>("figedit").close());
$("to-pdf").addEventListener("click", toPdf);
$("pdf-to-source").addEventListener("click", () => toSource(currentPdfPage(), 0.5, 0.35));
$("status").addEventListener("click", reindex);
$("palette-open").addEventListener("click", openPalette);
window.addEventListener("beforeunload", () => { closing = true; for (const p of panes) save(p); });
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
  if (e.key === "k") { e.preventDefault(); openPalette(); }
  else if (e.code === "Backslash" && e.altKey) { e.preventDefault(); setPanel(mainEl.classList.contains("no-panel")); }
  else if (e.key === "\\") { e.preventDefault(); setSidebar(mainEl.classList.contains("no-side")); }
  else if (e.key === "=" || e.key === "+") { e.preventDefault(); setLook({ zoom: Math.min(160, look.zoom + 10) }); }
  else if (e.key === "-") { e.preventDefault(); setLook({ zoom: Math.max(70, look.zoom - 10) }); }
  else if (e.key === "0") { e.preventDefault(); setLook({ zoom: 100 }); }
  else if (e.key === "Enter") { e.preventDefault(); build(); }
});

activate(createPane());
setMinimap(remember.get("margin.minimap") !== "0");
await refreshStatus();
setMode(suggesting);
await loadKeys();
await loadProject();
// reopen what was open last time: the first file in the first pane, the rest beside it
let reopen: string[] = [];
try { reopen = (JSON.parse(remember.get("margin.panes") ?? "[]") as string[]).filter((f) => proj.tree.includes(f)).slice(0, MAX_PANES); } catch {}
const start = remember.get("margin.file");
const first = reopen[0] ?? (start && proj.tree.includes(start) ? start : (proj.outline[0]?.file ?? proj.root ?? proj.tree[0] ?? ""));
await openFile(first);
for (const f of reopen.slice(1)) await openFile(f, createPane());
restoreLayout();
renderPaneHeads();
refreshStatus();
loadLog();
setInterval(refreshStatus, 30_000);

mountProgress($("words"));
