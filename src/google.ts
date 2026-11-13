// Google Drive access for sending a chapter out for review and reading it back.
//
// Security choices, all standard practice for an installed app:
//  - OAuth 2.0 authorization-code flow with PKCE (S256) and a random `state`, in the system browser,
//    returning to a loopback address. No password ever passes through Margin.
//  - One scope only: drive.file. Margin can see and change only the documents it created itself.
//  - The refresh token lives in the macOS Keychain, not in a project file. The access token stays in memory.
//  - The OAuth client file is read from disk on demand and never sent anywhere but Google's token endpoint.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface GoogleConfig {
  clientFile: string; // the JSON downloaded from Google Cloud ("Desktop app" client)
  redirect: string; // http://127.0.0.1:<port>/api/google/callback
  authUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  apiUrl?: string;
  docsUrl?: string; // Google Docs API (documents.get / batchUpdate); same scope, documents Vega Fluo created
  tokenStore?: string; // "keychain" (default on macOS) or a file path
}

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const b64url = (b: Buffer) => b.toString("base64url");

interface TokenStore { get(): Promise<string | null>; set(token: string): Promise<void>; clear(): Promise<void> }

/** macOS Keychain via the system `security` tool. */
class KeychainStore implements TokenStore {
  private args = ["-s", "Margin Google Drive", "-a", "refresh-token"];
  private async run(cmd: string[]) {
    const p = Bun.spawn(["security", ...cmd], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  }
  get() { return this.run(["find-generic-password", ...this.args, "-w"]); }
  async set(token: string) { if ((await this.run(["add-generic-password", "-U", ...this.args, "-w", token])) === null) throw new Error("Could not save the Google token to the Keychain"); }
  async clear() { await this.run(["delete-generic-password", ...this.args]); }
}

/** A file readable only by the owner; used where there is no Keychain, and by the tests. */
class FileStore implements TokenStore {
  constructor(private path: string) {}
  async get() { const f = Bun.file(this.path); return (await f.exists()) ? (await f.text()).trim() || null : null; }
  async set(token: string) { await mkdir(dirname(this.path), { recursive: true }); await Bun.write(this.path, token); await chmod(this.path, 0o600); }
  async clear() { await rm(this.path, { force: true }); }
}

export class Google {
  private store: TokenStore;
  private pending = new Map<string, { verifier: string; at: number }>();
  private access: { token: string; expires: number } | null = null;
  private auth: string; private token: string; private revoke: string; private api: string; private docs: string;

  constructor(private cfg: GoogleConfig) {
    this.auth = cfg.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
    this.token = cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.revoke = cfg.revokeUrl ?? "https://oauth2.googleapis.com/revoke";
    this.api = cfg.apiUrl ?? "https://www.googleapis.com";
    this.docs = cfg.docsUrl ?? "https://docs.googleapis.com";
    const where = cfg.tokenStore ?? (process.platform === "darwin" ? "keychain" : "");
    this.store = where === "keychain" ? new KeychainStore() : new FileStore(where || `${process.env.HOME}/.config/margin/google-token`);
  }

  private async client(): Promise<{ client_id: string; client_secret: string } | null> {
    const f = Bun.file(this.cfg.clientFile);
    if (!(await f.exists())) return null;
    try {
      const j = await f.json();
      const c = j.installed ?? j.web ?? j;
      return c?.client_id ? { client_id: c.client_id, client_secret: c.client_secret ?? "" } : null;
    } catch { return null; }
  }

  async status() {
    const configured = !!(await this.client());
    return { configured, connected: configured && !!(await this.store.get()), clientFile: this.cfg.clientFile };
  }

  /** Step 1: the URL to open in the browser. */
  async startAuth(): Promise<string> {
    const c = await this.client();
    if (!c) throw new Error("No Google client file found");
    for (const [k, v] of this.pending) if (Date.now() - v.at > 600_000) this.pending.delete(k);
    const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
    this.pending.set(state, { verifier, at: Date.now() });
    const q = new URLSearchParams({
      client_id: c.client_id, redirect_uri: this.cfg.redirect, response_type: "code", scope: SCOPE, state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
      access_type: "offline", prompt: "consent",
    });
    return `${this.auth}?${q}`;
  }

  /** Step 2: Google sent the browser back with a code. `state` must be one we issued, and is single-use. */
  async finishAuth(code: string, state: string) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > 600_000) throw new Error("This sign-in link is not one Margin issued, or it expired. Start again from Margin.");
    const c = (await this.client())!;
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirect, code_verifier: p.verifier, ...c });
    if (!t.refresh_token) throw new Error("Google did not return a refresh token");
    await this.store.set(t.refresh_token);
    this.access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  }

  private async tokenRequest(body: Record<string, string>) {
    const res = await fetch(this.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
    return j as { access_token: string; refresh_token?: string; expires_in: number };
  }

  private async accessToken(): Promise<string> {
    if (this.access && Date.now() < this.access.expires) return this.access.token;
    const refresh = await this.store.get(), c = await this.client();
    if (!refresh || !c) throw new Error("Not connected to Google");
    const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, ...c });
    this.access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  async disconnect() {
    const refresh = await this.store.get();
    if (refresh) await fetch(this.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }) }).catch(() => {});
    await this.store.clear();
    this.access = null;
  }

  /** Create a Google Doc from HTML. Drive converts it on upload. */
  async createDoc(title: string, html: string): Promise<{ id: string; url: string }> {
    const boundary = "margin" + b64url(randomBytes(12));
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: title, mimeType: "application/vnd.google-apps.document" })}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
    const res = await fetch(`${this.api}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !j.id) throw new Error(`Google Drive refused the upload: ${j.error?.message ?? res.status}`);
    return { id: j.id, url: `https://docs.google.com/document/d/${j.id}/edit` };
  }

  /** The reviewed document as a Word file, which carries suggestions and comments with their authors. */
  async exportDocx(id: string): Promise<Uint8Array> {
    const res = await fetch(`${this.api}/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(DOCX)}`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok) throw new Error(`Google Drive could not export the document (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The document's structure and current revision (Docs API). */
  async getDoc(id: string): Promise<any> {
    const res = await fetch(`${this.docs}/v1/documents/${encodeURIComponent(id)}?fields=revisionId,body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,paragraph.elements(startIndex,endIndex,textRun(content,suggestedInsertionIds,textStyle(foregroundColor,backgroundColor,underline,strikethrough))))`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Google Docs could not read the document: ${j.error?.message ?? res.status}`);
    return j;
  }

  /**
   * Apply edits, but only if nobody changed the document since `revisionId`. Returns false when Google
   * refuses because the revision moved on (the caller re-reads and plans again); otherwise the new revision.
   */
  async batchUpdate(id: string, requests: object[], revisionId: string): Promise<string | false> {
    const res = await fetch(`${this.docs}/v1/documents/${encodeURIComponent(id)}:batchUpdate`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } }),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (res.ok) return String(j.writeControl?.requiredRevisionId ?? "");
    const msg = String(j.error?.message ?? "");
    if (res.status === 400 && /revision/i.test(msg)) return false;
    throw new Error(`Google Docs refused the update: ${msg || res.status}`);
  }

  // ---------- Drive comments on documents Vega Fluo created (drive.file scope) ----------
  private async drive(method: string, path: string, body?: object): Promise<any> {
    const res = await fetch(`${this.api}/drive/v3/files/${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (method === "DELETE" && (res.ok || res.status === 404)) return {};
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Google Drive comments: ${j.error?.message ?? res.status}`);
    return j;
  }
  /** A comment from you, quoting the words it is about (Google shows your name, email and the time). */
  async addComment(docId: string, content: string, quote: string): Promise<string> {
    const j = await this.drive("POST", `${encodeURIComponent(docId)}/comments?fields=id`, { content, ...(quote ? { quotedFileContent: { mimeType: "text/plain", value: quote } } : {}) });
    return j.id;
  }
  async editComment(docId: string, id: string, content: string) { await this.drive("PATCH", `${encodeURIComponent(docId)}/comments/${encodeURIComponent(id)}?fields=id`, { content }); }
  async deleteComment(docId: string, id: string) { await this.drive("DELETE", `${encodeURIComponent(docId)}/comments/${encodeURIComponent(id)}`); }
  async addReply(docId: string, id: string, content: string, action?: "resolve" | "reopen") {
    await this.drive("POST", `${encodeURIComponent(docId)}/comments/${encodeURIComponent(id)}/replies?fields=id`, { content, ...(action ? { action } : {}) });
  }
}
