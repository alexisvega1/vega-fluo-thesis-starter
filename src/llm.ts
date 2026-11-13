import type { Config } from "./config";

export type Msg = { role: "system" | "user" | "assistant"; content: string };
interface Opts { max_tokens: number; temperature: number }

function request(cfg: Config["llm"], messages: Msg[], opts: Opts, stream: boolean, signal?: AbortSignal) {
  return fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages, stream, ...opts, ...(cfg.extraBody ?? {}) }),
  });
}

/** Stream content deltas from any OpenAI-compatible endpoint (Ollama, llama-server, LM Studio, mlx). */
export async function* chatStream(cfg: Config["llm"], messages: Msg[], opts: Opts, signal?: AbortSignal) {
  const res = await request(cfg, messages, opts, true, signal);
  if (!res.ok || !res.body) throw new Error(`model endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) yield delta as string;
        } catch { /* partial or keep-alive line */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function chatOnce(cfg: Config["llm"], messages: Msg[], opts: Opts, signal?: AbortSignal) {
  const res = await request(cfg, messages, opts, false, signal);
  if (!res.ok) throw new Error(`model endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  return String(json.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
}

export async function llmStatus(cfg: Config["llm"]) {
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      signal: AbortSignal.timeout(1500),
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    return { ok: res.ok, model: cfg.model, error: res.ok ? "" : `HTTP ${res.status}` };
  } catch {
    return { ok: false, model: cfg.model, error: `nothing listening at ${cfg.baseUrl}` };
  }
}
