// Zip files for moving a project to and from Overleaf, with no native dependencies.
// Writing uses DEFLATE; reading accepts stored and DEFLATE entries and refuses anything that could
// land outside the destination folder (absolute paths, "..", symlinks) or that is implausibly large.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const crc32 = (b: Uint8Array) => Bun.hash.crc32(b) >>> 0;

/** Build a zip archive from (path, bytes) pairs. */
export function makeZip(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // DOS time/date: 1 Jan 1980 is the epoch; use a fixed stamp so the same project gives the same zip
  const time = 0, date = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = new TextEncoder().encode(f.path);
    const packed = deflateRawSync(f.data);
    const useDeflate = packed.length < f.data.length;
    const body = useDeflate ? new Uint8Array(packed) : f.data;
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, useDeflate ? 8 : 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, (3 << 8) | 20, true); // made by Unix
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, useDeflate ? 8 : 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

// What goes to Overleaf: the sources and figures, never build output, editor state, secrets or dotfiles
// (except .margin/chapter-refs, which the chapters \input).
const SKIP_DIRS = new Set(["node_modules", "papers"]);
const SKIP_FILE = /(^margin-preview\.tex$|\.(pem|key|p12|zip|synctex\.gz)$)/i;

/** Every file of the project that belongs in an Overleaf upload, as project-relative paths. */
export async function projectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      if (name.startsWith(".")) continue; // .build, .margin, .git, .env and every other dotfile
      const abs = join(dir, name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) continue; // never follow a link out of the project
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) await walk(abs); }
      else if (st.isFile() && !SKIP_FILE.test(name)) out.push(relative(root, abs).split(sep).join("/"));
    }
  }
  await walk(root);
  // the one piece of editor state the sources depend on: chapters \input their reference lists from here
  const refs = join(root, ".margin", "chapter-refs");
  if ((await lstat(refs).catch(() => null))?.isDirectory())
    for (const name of (await readdir(refs)).sort()) {
      const st = await lstat(join(refs, name));
      if (st.isFile() && name.endsWith(".tex")) out.push(`.margin/chapter-refs/${name}`);
    }
  return out;
}

export async function zipProject(root: string): Promise<{ zip: Uint8Array; files: string[] }> {
  const files = await projectFiles(root);
  const data = await Promise.all(files.map(async (p) => ({ path: p, data: new Uint8Array(await Bun.file(join(root, p)).arrayBuffer()) })));
  return { zip: makeZip(data), files };
}

export interface ZipEntry { path: string; data: Uint8Array }
export const LIMITS = { entries: 5000, bytes: 500 * 1024 * 1024 };

/** Read a zip (stored or DEFLATE entries). Throws on anything unsafe or malformed. */
export function readZip(buf: Uint8Array, limits = LIMITS): ZipEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This is not a zip file.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count > limits.entries) throw new Error(`The zip has ${count} entries; the limit is ${limits.entries}.`);
  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("The zip's directory is damaged.");
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const madeBy = v.getUint16(p + 4, true) >> 8, attrs = v.getUint32(p + 38, true), lho = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error(`"${name}" is encrypted.`);
    if (madeBy === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) throw new Error(`"${name}" is a symbolic link; refusing.`);
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) continue;
    const parts = name.split("/");
    if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || parts.some((s) => s === ".." || s === ""))
      throw new Error(`"${name}" would land outside the folder; refusing.`);
    total += usize;
    if (total > limits.bytes) throw new Error("The zip unpacks to more than the size limit.");
    if (v.getUint32(lho, true) !== 0x04034b50) throw new Error("The zip's entries are damaged.");
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) })) : null;
    if (!data) throw new Error(`"${name}" uses an unsupported compression method (${method}).`);
    if (data.length !== usize || crc32(data) !== v.getUint32(p - 46 - nlen - xlen - clen + 16, true)) throw new Error(`"${name}" is damaged (size or checksum mismatch).`);
    out.push({ path: name, data: new Uint8Array(data) });
  }
  return out;
}

/** Strip a single folder that wraps everything (Overleaf zips are flat; hand-made ones often are not). */
export function unwrap(entries: ZipEntry[]): ZipEntry[] {
  const tops = new Set(entries.map((e) => e.path.split("/")[0]));
  if (tops.size !== 1 || entries.some((e) => !e.path.includes("/"))) return entries;
  const top = [...tops][0]! + "/";
  return entries.map((e) => ({ ...e, path: e.path.slice(top.length) }));
}

/**
 * Unpack an Overleaf zip into a NEW folder beside `projectRoot`, named after `name` (made unique).
 * Never writes into the project itself or into an existing folder. Returns the folder's absolute path.
 */
export async function importZip(buf: Uint8Array, projectRoot: string, name: string): Promise<{ dir: string; files: string[] }> {
  const entries = unwrap(readZip(buf));
  if (!entries.length) throw new Error("The zip is empty.");
  if (!entries.some((e) => e.path.endsWith(".tex"))) throw new Error("The zip has no .tex file, so it does not look like an Overleaf project.");
  const parent = dirname(resolve(projectRoot));
  const base = (name.replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "overleaf-import").slice(0, 60);
  let dir = "";
  for (let i = 0; i < 100; i++) {
    const cand = join(parent, i ? `${base}-${i + 1}` : base);
    if (!(await stat(cand).catch(() => null))) { dir = cand; break; }
  }
  if (!dir) throw new Error("Could not find a free folder name.");
  const project = resolve(projectRoot);
  if (dir === project || dir.startsWith(project + sep) || project.startsWith(dir + sep)) throw new Error("Refusing to unpack over the current project.");
  await mkdir(dir);
  for (const e of entries) {
    const abs = resolve(dir, e.path);
    if (!abs.startsWith(dir + sep)) throw new Error(`"${e.path}" would land outside the folder; refusing.`);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, e.data);
  }
  return { dir, files: entries.map((e) => e.path) };
}
