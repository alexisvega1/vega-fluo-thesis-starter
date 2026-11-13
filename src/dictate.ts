// Local speech-to-text with whisper.cpp. Audio never leaves the machine and is deleted after transcription.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DictationConfig { model: string; vocabulary: string; language: string }

export async function dictationStatus(cfg: DictationConfig) {
  const model = await Bun.file(cfg.model).exists();
  const cli = !!Bun.which("whisper-cli");
  return { ready: model && cli, reason: !cli ? "whisper-cli is not installed" : !model ? `No Whisper model at ${cfg.model}` : "" };
}

/** Terms Whisper should expect, from a one-per-line vocabulary file. The prompt only holds ~220 tokens. */
async function vocabularyPrompt(path: string) {
  const f = Bun.file(path);
  if (!(await f.exists())) return "";
  return (await f.text()).split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).slice(0, 45).join(", ");
}

/** Transcribe 16 kHz mono 16-bit WAV audio. */
export async function transcribe(wav: Uint8Array, cfg: DictationConfig): Promise<string> {
  const head = new TextDecoder().decode(wav.slice(0, 12));
  if (!head.startsWith("RIFF") || head.slice(8) !== "WAVE") throw new Error("Expected WAV audio");
  const dir = await mkdtemp(join(tmpdir(), "margin-dictate-"));
  try {
    const file = join(dir, "audio.wav");
    await Bun.write(file, wav);
    const prompt = await vocabularyPrompt(cfg.vocabulary);
    const cmd = ["whisper-cli", "-m", cfg.model, "-f", file, "-l", cfg.language, "-nt", "-np", "-sns"];
    if (prompt) cmd.push("--carry-initial-prompt", "--prompt", prompt);
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if ((await p.exited) !== 0) throw new Error(`Whisper failed: ${err.trim().split("\n").pop() ?? ""}`);
    return out.replace(/\[[A-Z_ ]+\]|\([a-z ]+\)/g, " ").replace(/\s+/g, " ").trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- live dictation: the model stays loaded so short clips come back quickly ----------
const clean = (out: string) => out.replace(/\[[A-Z_ ]+\]|\([a-z ]+\)/g, " ").replace(/\s+/g, " ").trim();
let live: { port: number; proc: ReturnType<typeof Bun.spawn> } | null = null;
let starting: Promise<number | null> | null = null;

async function liveServer(cfg: DictationConfig): Promise<number | null> {
  if (live && live.proc.exitCode === null) return live.port;
  if (!Bun.which("whisper-server")) return null;
  return (starting ??= (async () => {
    try {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = probe.port;
      probe.stop(true);
      // loopback only; it holds no data, it just turns audio it is handed into text
      const proc = Bun.spawn(["whisper-server", "-m", cfg.model, "-l", cfg.language, "--host", "127.0.0.1", "--port", String(port), "-nt", "-sns"], { stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 80; i++) { // the model takes a moment to load
        await Bun.sleep(250);
        if (proc.exitCode !== null) return null;
        if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { live = { port, proc }; return port; }
      }
      proc.kill();
      return null;
    } finally { starting = null; }
  })());
}
export function stopLiveServer() { live?.proc.kill(); live = null; }
process.on("exit", stopLiveServer);

/** Transcribe a short clip while recording is still going on. `context` is what was said just before. */
export async function transcribeLive(wav: Uint8Array, cfg: DictationConfig, context = ""): Promise<string> {
  const port = await liveServer(cfg);
  if (!port) return transcribe(wav, cfg); // no server binary: slower, but the same result
  const form = new FormData();
  form.set("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.set("response_format", "json");
  form.set("temperature", "0");
  const vocab = await vocabularyPrompt(cfg.vocabulary);
  // a bare word list makes Whisper drop punctuation, so the terms are wrapped in a sentence that models the style
  const prompt = [vocab && `Dissertation dictation that uses terms such as ${vocab}.`, "It is written in full sentences, with punctuation.", context.slice(-300)].filter(Boolean).join(" ");
  if (prompt) form.set("prompt", prompt);
  const r = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`Whisper server answered ${r.status}`);
  return clean(String(((await r.json()) as { text?: string }).text ?? ""));
}
