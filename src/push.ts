// Reminders on your phone: Web Push to Vega Fluo added to the Home Screen (iOS 16.4+), or any browser
// that subscribed. Messages are encrypted end to end (the push service, e.g. Apple's, cannot read them).
// Keys and the list of subscribed devices stay in the app's own .cache, never in git.
import webpush from "web-push";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string }; added: number; label?: string }

// only the browser vendors' push services, so a stored "subscription" can never point the server elsewhere
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export const validEndpoint = (u: string) => {
  try { const x = new URL(u); return x.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; }
};

export class Push {
  private keys: { publicKey: string; privateKey: string } | null = null;
  private subs: PushSub[] | null = null;
  constructor(private dir: string) {}
  private file = (n: string) => join(this.dir, n);

  async publicKey() {
    if (!this.keys) {
      const f = Bun.file(this.file("vapid.json"));
      this.keys = (await f.exists()) ? await f.json() : webpush.generateVAPIDKeys();
      if (!(await f.exists())) { await mkdir(this.dir, { recursive: true }); await Bun.write(f, JSON.stringify(this.keys)); }
      await chmod(this.file("vapid.json"), 0o600).catch(() => {}); // the signing key: readable by you only
    }
    return this.keys!.publicKey;
  }
  async list() {
    if (!this.subs) { const f = Bun.file(this.file("push.json")); this.subs = (await f.exists()) ? await f.json() : []; }
    return this.subs!;
  }
  private async save() { await mkdir(dirname(this.file("push.json")), { recursive: true }); await Bun.write(this.file("push.json"), JSON.stringify(this.subs)); await chmod(this.file("push.json"), 0o600).catch(() => {}); }

  async add(s: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, label = "") {
    if (!s?.endpoint || !validEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw new Error("Not a push subscription");
    const subs = (await this.list()).filter((x) => x.endpoint !== s.endpoint);
    subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, added: Date.now(), label: label.slice(0, 80) });
    this.subs = subs.slice(-10);
    await this.save();
  }
  async remove(endpoint: string) { this.subs = (await this.list()).filter((x) => x.endpoint !== endpoint); await this.save(); }

  /** Send to every subscribed device; devices that have gone away are forgotten. */
  async send(title: string, body: string) {
    await this.publicKey();
    const subs = await this.list();
    let sent = 0;
    const gone: string[] = [];
    for (const s of subs) {
      try {
        await webpush.sendNotification(s, JSON.stringify({ title, body }), {
          TTL: 4 * 3600,
          urgency: "normal",
          // a contact the push service may use; deliberately not your own address
          vapidDetails: { subject: "mailto:reminders@example.com", publicKey: this.keys!.publicKey, privateKey: this.keys!.privateKey },
        });
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(s.endpoint);
        else console.log(`[push] ${e?.statusCode ?? ""} ${String(e?.body ?? e?.message ?? e).slice(0, 200)}`);
      }
    }
    if (gone.length) { this.subs = subs.filter((s) => !gone.includes(s.endpoint)); await this.save(); }
    return { sent, devices: subs.length };
  }
}
