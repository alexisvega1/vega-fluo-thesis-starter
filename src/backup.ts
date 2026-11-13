// Off-machine backup: the thesis folder is its own git repository with a private remote.
// Margin commits whatever changed and pushes it, on a timer and on request. Nothing is ever
// force-pushed or rewritten; if the push fails (offline), the commit stays local and goes up next time.
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface BackupState { enabled: boolean; remote: string; lastAt: number; lastResult: string; ok: boolean; pending: number }
const state: BackupState = { enabled: false, remote: "", lastAt: 0, lastResult: "", ok: true, pending: 0 };

async function git(dir: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
}

export async function backupStatus(dir: string): Promise<BackupState> {
  state.enabled = !!(await stat(join(dir, ".git")).catch(() => null));
  if (!state.enabled) return { ...state };
  state.remote = (await git(dir, "remote", "get-url", "origin")).out.replace(/^https:\/\/[^@]+@/, "https://");
  const changed = (await git(dir, "status", "--porcelain")).out.split("\n").filter(Boolean).length;
  const ahead = Number((await git(dir, "rev-list", "--count", "@{u}..HEAD")).out) || 0;
  state.pending = changed + ahead;
  if (!state.lastAt) state.lastAt = Number((await git(dir, "log", "-1", "--format=%ct")).out) * 1000 || 0;
  return { ...state };
}

let running = false;
/** Commit anything that changed and push. Safe to call often; does nothing when there is nothing new. */
export async function backupNow(dir: string): Promise<BackupState> {
  if (running || !(await backupStatus(dir)).enabled) return { ...state };
  running = true;
  try {
    await git(dir, "add", "-A");
    const staged = (await git(dir, "diff", "--cached", "--quiet")).code !== 0;
    if (staged) {
      const c = await git(dir, "commit", "-q", "-m", `Autosave ${new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace("T", " ")}`);
      if (c.code !== 0) { state.ok = false; state.lastResult = `Could not commit: ${c.err.split("\n")[0]}`; return { ...state }; }
    }
    if (!state.remote) { state.ok = true; state.lastResult = "Committed locally (no remote set)"; state.lastAt = Date.now(); return backupStatus(dir); }
    const push = await git(dir, "push", "-q", "origin", "HEAD");
    state.ok = push.code === 0;
    state.lastResult = state.ok ? (staged ? "Backed up to GitHub" : "Already up to date") : `Saved locally; push failed: ${push.err.split("\n").pop()}`;
    if (state.ok) state.lastAt = Date.now();
    return backupStatus(dir);
  } finally {
    running = false;
  }
}
