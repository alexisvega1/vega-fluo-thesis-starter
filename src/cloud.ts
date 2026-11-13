// Optional cloud model for the two judgment tasks (arguments, claim check). Never used for ghost text,
// and only ever called when the author presses a button with "cloud" selected, because the paragraph
// and the matching library excerpts leave the machine.
//
// Credentials are never stored by Margin. Claude: the Anthropic SDK reads ANTHROPIC_API_KEY (or an
// `ant auth login` profile). OpenAI: OPENAI_API_KEY from the environment.
import Anthropic from "@anthropic-ai/sdk";
import { stat } from "node:fs/promises";

export interface CloudConfig { provider: "anthropic" | "openai"; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" }

const FALLBACK_OK = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export async function cloudStatus(cfg: CloudConfig | undefined) {
  if (!cfg?.model) return { configured: false, ready: false, provider: "", model: "", reason: "No cloud model is set in config.json" };
  const ready =
    cfg.provider === "openai"
      ? !!process.env.OPENAI_API_KEY
      : !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) || !!(await stat(`${process.env.HOME}/.config/anthropic`).catch(() => null));
  const name = cfg.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  return { configured: true, ready, provider: cfg.provider, model: cfg.model, reason: ready ? "" : `Set ${name} in your shell, then restart Margin from that shell (margin stop; margin)` };
}

export async function cloudOnce(cfg: CloudConfig, system: string, user: string, signal?: AbortSignal): Promise<{ text: string; model: string }> {
  if (cfg.provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`OpenAI: ${j.error?.message ?? res.status}`);
    return { text: String(j.choices?.[0]?.message?.content ?? ""), model: j.model ?? cfg.model };
  }

  const client = new Anthropic(); // resolves credentials from the environment
  try {
    const res = await client.beta.messages.create(
      {
        model: cfg.model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
        ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
        // if the model declines for policy reasons, let the API retry on its default fallback model
        // (only the larger models have a server-side fallback)
        ...(FALLBACK_OK.has(cfg.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      } as any,
      { signal },
    );
    if (res.stop_reason === "refusal") throw new Error(`Claude declined this request${(res as any).stop_details?.category ? ` (${(res as any).stop_details.category})` : ""}`);
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off before it finished");
    return { text: res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""), model: res.model };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Claude rejected the API key");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("This API key is not allowed to use that model");
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Claude does not know the model "${cfg.model}"`);
    if (e instanceof Anthropic.RateLimitError) throw new Error("Claude rate limit reached; try again shortly");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Could not reach Claude (no network, or no credentials found)");
    if (e instanceof Anthropic.APIError) throw new Error(`Claude: ${e.message}`);
    throw e;
  }
}
