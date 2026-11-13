// Word-level Myers diff with character offsets. Used to line up two versions of the same text
// (what was sent for review vs. what came back; the .tex then vs. the .tex now).

export interface Op { type: "eq" | "del" | "ins"; a0: number; a1: number; b0: number; b1: number }

interface Tok { s: string; at: number }
const tokens = (text: string): Tok[] =>
  [...text.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)].map((m) => ({ s: m[0], at: m.index! }));

/** Edit script from `a` to `b`, or null if they differ by more than `maxD` word-level edits. */
export function diffText(a: string, b: string, maxD = 1500): Op[] | null {
  if (a === b) return a ? [{ type: "eq", a0: 0, a1: a.length, b0: 0, b1: b.length }] : [];
  const A = tokens(a), B = tokens(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre]!.s === B[pre]!.s) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf]!.s === B[B.length - 1 - suf]!.s) suf++;
  const N = A.length - pre - suf, M = B.length - pre - suf;

  // Myers O(ND), keeping only the live diagonal band of each round for the backtrack
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[pre + x]!.s === B[pre + y]!.s) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break outer; }
    }
  }
  if (found === -1) return null;

  // backtrack into per-token steps (reversed)
  const steps: ("eq" | "del" | "ins")[] = [];
  let x = N, y = M;
  for (let d = found; d >= 0; d--) {
    const row = trace[d]!, o = d + 1; // row[o + k] is v[k] as it stood before round d
    const k = x - y;
    const prevK = k === -d || (k !== d && row[o + k - 1]! < row[o + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : row[o + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) { steps.push("eq"); x--; y--; }
    if (d > 0) { steps.push(x === prevX ? "ins" : "del"); }
    x = prevX; y = prevY;
  }
  const all: ("eq" | "del" | "ins")[] = [...Array(pre).fill("eq"), ...steps.reverse(), ...Array(suf).fill("eq")];

  // group into ops with character offsets
  const ops: Op[] = [];
  let i = 0, j = 0;
  const ca = (n: number) => (n < A.length ? A[n]!.at : a.length);
  const cb = (n: number) => (n < B.length ? B[n]!.at : b.length);
  for (const type of all) {
    const a0 = ca(i), b0 = cb(j);
    if (type !== "ins") i++;
    if (type !== "del") j++;
    const last = ops[ops.length - 1];
    if (last && last.type === type) { last.a1 = ca(i); last.b1 = cb(j); }
    else ops.push({ type, a0, a1: ca(i), b0, b1: cb(j) });
  }
  return ops;
}

/** Position in `a` for a position in `b` (text present only in `b` maps to the point where it was added). */
export function mapToA(ops: Op[], posB: number): number {
  for (const op of ops) {
    if (posB < op.b0 || posB > op.b1) continue;
    if (op.type === "eq") return op.a0 + (posB - op.b0);
    if (op.type === "ins" && posB < op.b1) return op.a0;
  }
  const last = ops[ops.length - 1];
  return last ? last.a1 : 0;
}

/** Position in `b` for a position in `a` (text removed from `a` maps to the point where it was). */
export function mapToB(ops: Op[], posA: number): number {
  for (const op of ops) {
    if (posA < op.a0 || posA > op.a1) continue;
    if (op.type === "eq") return op.b0 + (posA - op.a0);
    if (op.type === "del" && posA < op.a1) return op.b0;
  }
  const last = ops[ops.length - 1];
  return last ? last.b1 : 0;
}
