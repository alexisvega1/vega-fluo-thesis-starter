// Fails if a folder meant for other people (the starter template) contains anything personal.
// Usage: bun tools/check-no-personal-data.ts [path]   (default: starter/)
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.argv[2] ?? join(import.meta.dir, "..", "starter");
// Generic markers anyone would want caught, plus your own words from tools/personal-markers.txt
// (git-ignored; one word or phrase per line), so the names themselves are never published.
const MARKERS: [string, RegExp][] = [
  ["university email", /\b(?!uniqname@|youremail@)[a-z0-9._-]+@[a-z0-9-]+\.edu\b/i],
  ["tailnet host", /\.ts\.net\b/i],
  ["home path", /\/Users\/[A-Za-z]|\/home\/[a-z]/],
];
const own = Bun.file(join(import.meta.dir, "personal-markers.txt"));
if (await own.exists())
  for (const w of (await own.text()).split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean))
    MARKERS.push(["personal word", new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i")]);
const SKIP = new Set([".git", "node_modules", ".build", ".cache", ".margin"]);
const TEXT = /\.(tex|bib|cls|sty|json|md|txt|ts|js|html|css|yml|yaml)$/i;

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (TEXT.test(e.name)) yield p;
  }
}

let hits = 0, scanned = 0;
for await (const f of files(root)) {
  scanned++;
  const lines = (await Bun.file(f).text()).split("\n");
  lines.forEach((line, i) => {
    for (const [what, re] of MARKERS) if (re.test(line)) { hits++; console.log(`${relative(root, f)}:${i + 1}  ${what}: ${line.trim().slice(0, 120)}`); }
  });
}
console.log(hits ? `\n${hits} personal marker(s) in ${scanned} files under ${root}` : `clean: ${scanned} files under ${relative(process.cwd(), root) || root}`);
process.exit(hits ? 1 : 0);
