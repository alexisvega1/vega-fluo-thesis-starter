// Three-way line merge for when a file changed on disk while it was open (another tab, or Vega Fluo
// itself adding to it). base = what this tab last loaded or saved; mine = this tab's text now;
// theirs = what is on disk. Edits to different lines are combined; where both changed the same lines,
// this tab's version is kept and the other is reported (it stays in History).

/** FNV-1a, the same on the server and in the browser. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + ":" + s.length;
}

interface Hunk { a0: number; a1: number; lines: string[] } // replace base lines [a0, a1) with lines

/** Line hunks turning a into b (LCS on lines; fine for chapter-sized files). */
function hunks(a: string[], b: string[]): Hunk[] {
  const n = a.length, m = b.length;
  // trim the common start and end first so the table stays small
  let s = 0; while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0; while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  const A = a.slice(s, n - e), B = b.slice(s, m - e);
  const dp: Uint32Array[] = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { flush(); i++; j++; continue; }
    cur ??= { a0: s + i, a1: s + i, lines: [] };
    if (j < B.length && (i >= A.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { cur.lines.push(B[j]!); j++; }
    else { cur.a1 = s + i + 1; i++; }
  }
  flush();
  return out;
}

export function merge3(base: string, mine: string, theirs: string): { text: string; conflicts: number } {
  if (mine === base) return { text: theirs, conflicts: 0 };
  if (theirs === base || theirs === mine) return { text: mine, conflicts: 0 };
  const b = base.split("\n");
  const hm = hunks(b, mine.split("\n")).map((h) => ({ ...h, who: "mine" as const }));
  const ht = hunks(b, theirs.split("\n")).map((h) => ({ ...h, who: "theirs" as const }));
  const overlap = (x: Hunk, y: Hunk) => x.a0 < y.a1 && y.a0 < x.a1 || (x.a0 === x.a1 && y.a0 === y.a1 && x.a0 === y.a0) || (x.a0 === x.a1 && x.a0 > y.a0 && x.a0 < y.a1) || (y.a0 === y.a1 && y.a0 > x.a0 && y.a0 < x.a1);
  let conflicts = 0;
  const keep = [...hm];
  for (const t of ht) {
    if (hm.some((x) => overlap(x, t))) { conflicts++; continue; } // both changed these lines: this tab wins
    keep.push(t);
  }
  keep.sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const out: string[] = [];
  let at = 0;
  for (const h of keep) { if (h.a0 < at) continue; out.push(...b.slice(at, h.a0), ...h.lines); at = h.a1; }
  out.push(...b.slice(at));
  return { text: out.join("\n"), conflicts };
}
