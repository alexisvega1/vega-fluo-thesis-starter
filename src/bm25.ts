const STOP = new Set(
  ("a an the of and or in on at to for with by from as is are was were be been being this that these those it its " +
    "we our their they which who whom not no but than then into during after before between also can could may might " +
    "have has had using used via such both each more most other some only over under about there here when where while " +
    "will would should do does did if so").split(" "),
);

const stem = (t: string) => {
  if (t.length > 4) {
    if (t.endsWith("ies")) return t.slice(0, -3) + "y";
    if (t.endsWith("s") && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  }
  return t;
};

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of s.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    const parts = t.includes("-") ? [t.replace(/-/g, ""), ...t.split("-")] : [t];
    for (const p of parts) if (p.length > 1 && !STOP.has(p)) out.push(stem(p));
  }
  return out;
}

export interface Hit<T> { doc: T; score: number }

/** Small in-memory BM25 index. add() everything, then search(). */
export class BM25<T> {
  docs: T[] = [];
  private lens: number[] = [];
  private postings = new Map<string, number[]>(); // term -> [docId, tf, docId, tf, ...]
  private total = 0;
  constructor(private k1 = 1.4, private b = 0.75) {}

  add(doc: T, text: string) {
    const id = this.docs.length;
    const tf = new Map<string, number>();
    const toks = tokenize(text);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = []));
      p.push(id, n);
    }
    this.docs.push(doc);
    this.lens.push(toks.length);
    this.total += toks.length;
  }

  search(query: string, k = 5): Hit<T>[] {
    const N = this.docs.length;
    if (!N) return [];
    const avg = this.total / N || 1;
    const scores = new Float32Array(N);
    const touched: number[] = [];
    for (const t of new Set(tokenize(query))) {
      const p = this.postings.get(t);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < p.length; i += 2) {
        const id = p[i]!, tf = p[i + 1]!;
        if (scores[id] === 0) touched.push(id);
        scores[id]! += (idf * tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * this.lens[id]!) / avg));
      }
    }
    touched.sort((a, b) => scores[b]! - scores[a]!);
    return touched.slice(0, k).map((id) => ({ doc: this.docs[id]!, score: scores[id]! }));
  }
}
