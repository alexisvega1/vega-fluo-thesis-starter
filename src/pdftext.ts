// Text of a PDF via pdftotext, cached by path + size + modification time so each paper is read once.
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function pdfPages(file: string, cacheDir: string, maxPages = 60): Promise<string[]> {
  if (!Bun.which("pdftotext")) return [];
  const st = await stat(file).catch(() => null);
  if (!st) return [];
  const key = createHash("sha1").update(`${file}\0${st.size}\0${st.mtimeMs}`).digest("hex");
  const cached = Bun.file(join(cacheDir, `${key}.txt`));
  let text: string;
  if (await cached.exists()) text = await cached.text();
  else {
    const p = Bun.spawn(["pdftotext", "-l", String(maxPages), "-enc", "UTF-8", file, "-"], { stdout: "pipe", stderr: "ignore" });
    text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) text = "";
    await mkdir(cacheDir, { recursive: true });
    await Bun.write(cached, text);
  }
  return text.split("\f");
}

export const findDoi = (text: string) => /\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)\]])/.exec(text)?.[1]?.toLowerCase() ?? "";
