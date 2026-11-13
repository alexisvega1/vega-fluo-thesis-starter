// Keeps live Google Docs current: pushes the chapter a few seconds after it is saved (dictation included,
// since dictated words are saved like typed ones), and pulls the reviewer's edits and comments back
// into the Review tab when the doc changes. One chapter's work runs at a time, so a push and a pull
// never interleave.
import { docText, planPush, toRequests } from "./livedoc";
import { markRequests, syncComments, type CommentApi, type Mark, type MarkKind, type MirrorState } from "./livemarks";
import type { Round } from "./roundtrip";
import { proseRange, type Prose } from "./texprose";

/** Your own review items, in the coordinates of the text `read` returned. */
export interface SourceMark { id: string; kind: MarkKind; s0: number; s1: number; content: string; replies: string[]; resolved: boolean }

export interface LiveDeps {
  getDoc(id: string): Promise<any>;
  batchUpdate(id: string, requests: object[], revisionId: string): Promise<string | false>;
  read(path: string): Promise<string>;
  prose(tex: string): Prose;
  load(path: string): Promise<Round[]>;
  save(path: string, rounds: Round[]): Promise<void>;
  /** Bring the reviewer's changes into the file's Review sidecar; mutates round.seen / pulledAt. */
  pull(path: string, round: Round): Promise<{ suggestions: number; comments: number; warning?: string }>;
  livePaths(): Promise<string[]>;
  /** Your pending suggestions and notes (optional: without it the doc shows text only). */
  marks?(path: string, tex: string): Promise<SourceMark[]>;
  comments?: CommentApi;
}

export class LiveSync {
  quiet = 1200; // push this long after the last save…
  maxWait = 4000; // …but at least this often while saves keep coming (dictating)
  pollEvery = 5000; // a cheap revision check
  forcePullEvery = 60000; // comments may not move the doc's revision, so pull this often regardless
  maxSettle = 20000; // while the reviewer keeps typing, still pull at least this often
  private changing = new Map<string, { rev: string; since: number }>();
  private timers = new Map<string, { t: ReturnType<typeof setTimeout>; first: number }>();
  private chains = new Map<string, Promise<unknown>>();
  private poller?: ReturnType<typeof setInterval>;
  constructor(private d: LiveDeps) {}

  private serial<T>(path: string, job: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(path) ?? Promise.resolve()).then(job, job);
    this.chains.set(path, run.catch(() => {}));
    return run;
  }

  /** A file was saved. */
  touched(path: string) {
    if (!path.endsWith(".tex")) return;
    const old = this.timers.get(path);
    const first = old?.first ?? Date.now();
    if (old) clearTimeout(old.t);
    const wait = Math.max(0, Math.min(this.quiet, first + this.maxWait - Date.now()));
    this.timers.set(path, { first, t: setTimeout(() => { this.timers.delete(path); this.push(path).catch(() => {}); }, wait) });
  }

  start() { this.poller ??= setInterval(() => this.pollAll().catch(() => {}), this.pollEvery); }
  stop() { clearInterval(this.poller); this.poller = undefined; for (const { t } of this.timers.values()) clearTimeout(t); this.timers.clear(); }

  async pollAll() { for (const p of await this.d.livePaths()) await this.poll(p).catch(() => {}); }

  /** Send what changed since the last push. */
  push(path: string) {
    return this.serial(path, async () => {
      const rounds = await this.d.load(path);
      const r = rounds.find((x) => x.live);
      if (!r) return { pushed: false };
      const tex = await this.d.read(path);
      const mine = this.d.prose(tex);
      const src = (await this.d.marks?.(path, tex).catch(() => [])) ?? [];
      const marks = src.map((m) => ({ ...m, r: proseRange(mine, m.s0, m.s1) }));
      const sig = JSON.stringify(marks.map((m) => [m.id, m.kind, m.r, m.content, m.replies.length, m.resolved]));
      try {
        if (mine.text === r.prose.text) {
          if (r.base !== tex) r.base = tex;
          if (sig !== r.markSig) await this.decorate(r, mine, marks);
          await this.d.save(path, rounds);
          return { pushed: false };
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          const doc = await this.d.getDoc(r.docId);
          const { text, idx } = docText(doc);
          const plan = planPush(r.prose.text, mine.text, text);
          if (!plan) throw new Error("The doc and the chapter have drifted too far apart to merge. Turn live sync off and on to start a fresh doc.");
          const reqs = toRequests(plan.edits, idx);
          const rev = reqs.length ? await this.d.batchUpdate(r.docId, reqs, doc.revisionId) : doc.revisionId;
          if (rev === false) continue; // the reviewer typed in between: read again and re-plan
          // if nobody else had edited since our last look, the doc now holds nothing we have not seen
          if (doc.revisionId === r.revision && rev) r.revision = rev;
          r.prose = mine; r.base = tex; r.pushedAt = Date.now();
          r.conflicts = (r.conflicts ?? 0) + plan.conflicts;
          delete r.error;
          // inserted text takes on its neighbour's colour, so markers are redrawn after every text change
          await this.decorate(r, mine, marks); // also fixes paragraph styles new text picked up
          await this.d.save(path, rounds);
          return { pushed: true, edits: plan.edits.length, conflicts: plan.conflicts };
        }
        throw new Error("The doc kept changing while sending; will try again on the next save.");
      } catch (e) {
        r.error = (e as Error).message;
        await this.d.save(path, rounds);
        throw e;
      }
    });
  }

  /** Draw your suggestions and noted words in the doc, and keep a Google comment for each. */
  private async decorate(r: Round, mine: Prose, marks: (SourceMark & { r: [number, number] | null })[]) {
    const shown: Mark[] = marks.filter((m) => m.r).map((m) => ({ id: m.id, kind: m.kind, r0: m.r![0], r1: m.r![1] }));
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await this.d.getDoc(r.docId);
      const reqs = markRequests(doc, mine.text, shown, mine.blocks);
      if (!reqs.length) break;
      const rev = await this.d.batchUpdate(r.docId, reqs, doc.revisionId);
      if (rev === false) continue;
      if (doc.revisionId === r.revision && rev) r.revision = rev;
      break;
    }
    if (this.d.comments) {
      const quote = (m: (typeof marks)[number]) => (m.r ? mine.text.slice(m.r[0], m.r[1]) : "").slice(0, 500);
      const items = marks.map((m) => ({ id: m.id, content: m.content, quote: quote(m), replies: m.replies, resolved: m.resolved }));
      const kinds = new Map(Object.keys(r.mirror ?? {}).map((id) => [id, (r.mirrorKinds ?? {})[id] ?? "note"]));
      r.mirror = await syncComments(this.d.comments, r.docId, items, r.mirror ?? {}, (id) => (kinds.get(id) === "note" ? "delete" : "Closed in Vega Fluo (accepted or rejected)."));
      r.mirrorKinds = Object.fromEntries(marks.map((m) => [m.id, m.kind]));
    }
    r.markSig = JSON.stringify(marks.map((m) => [m.id, m.kind, m.r, m.content, m.replies.length, m.resolved]));
  }

  /** If the doc changed since we last looked, bring the reviewer's edits and comments in. */
  poll(path: string, force = false) {
    return this.serial(path, async () => {
      const rounds = await this.d.load(path);
      const r = rounds.find((x) => x.live);
      if (!r) return { pulled: false };
      try {
        const doc = await this.d.getDoc(r.docId);
        const now = Date.now();
        if (!force && doc.revisionId && doc.revisionId === r.revision && now - (r.pulledAt ?? 0) < this.forcePullEvery) return { pulled: false };
        // wait until the doc stops changing between two checks (so a suggestion being typed comes in whole),
        // but never longer than maxSettle
        if (!force && doc.revisionId !== r.revision) {
          const c = this.changing.get(path);
          if (!c || c.rev !== doc.revisionId) {
            this.changing.set(path, { rev: doc.revisionId, since: c?.since ?? now });
            if (now - (c?.since ?? now) < this.maxSettle) return { pulled: false, settling: true };
          }
        }
        this.changing.delete(path);
        const got = await this.d.pull(path, r);
        r.revision = doc.revisionId;
        if (got.warning) r.error = got.warning; else delete r.error;
        await this.d.save(path, rounds);
        return { pulled: true, ...got };
      } catch (e) {
        r.error = (e as Error).message;
        await this.d.save(path, rounds);
        throw e;
      }
    });
  }
}
