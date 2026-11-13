import { resolve, dirname } from "node:path";

export interface Config {
  port: number;
  project: string; // the dissertation folder: main.tex, chapters/, references.bib
  llm: { baseUrl: string; model: string; apiKey?: string; extraBody?: Record<string, unknown> };
  sources: string[];
  google: { clientFile: string; authUrl?: string; tokenUrl?: string; revokeUrl?: string; apiUrl?: string; docsUrl?: string; tokenStore?: string };
  dictation: { model: string; vocabulary: string; language: string };
  progressFile: string; // daily writing log (default: the app's own .cache)
  remote?: { host: string; user: string }; // reach it from your phone through `tailscale serve`, for this tailnet login only
  cacheDir: string;
  cloud?: { provider: "anthropic" | "openai"; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };
  /** Models offered for arguments and claim checks, besides whatever is installed locally. */
  judges?: { id: string; label?: string; provider: "anthropic" | "openai"; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" }[];
  knowledgeMap?: string; // folder holding citation_graph.json and map.json
  user: { name: string }; // whose name goes on suggestions and comments made on this machine
}

/** Load config.json (or the file given by --config). Relative paths resolve against the config file. */
export async function loadConfig(argv = process.argv): Promise<Config> {
  const flag = argv.indexOf("--config");
  const file = resolve(flag !== -1 ? argv[flag + 1]! : "config.json");
  const base = dirname(file);
  const raw = (await Bun.file(file).json()) as Config;
  const home = process.env.HOME ?? "";
  const abs = (p: string) => resolve(base, p.replace(/^~(?=\/|$)/, home));
  return {
    port: raw.port ?? 4317,
    project: abs(raw.project ?? "./thesis"),
    llm: { ...raw.llm, baseUrl: (raw.llm?.baseUrl ?? "http://127.0.0.1:11434/v1").replace(/\/+$/, "") }, // default: a local Ollama
    sources: (raw.sources ?? []).map(abs),
    google: { ...raw.google, clientFile: abs(raw.google?.clientFile ?? "./google-client.json"), tokenStore: raw.google?.tokenStore && raw.google.tokenStore !== "keychain" ? abs(raw.google.tokenStore) : raw.google?.tokenStore },
    progressFile: abs(raw.progressFile ?? "./.cache/progress.json"),
    remote: raw.remote?.host && raw.remote?.user ? { host: String(raw.remote.host), user: String(raw.remote.user) } : undefined,
    dictation: {
      model: abs(raw.dictation?.model ?? "~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin"),
      vocabulary: abs(raw.dictation?.vocabulary ?? "./vocabulary.txt"),
      language: raw.dictation?.language ?? "en",
    },
    cacheDir: abs("./.cache"),
    cloud: raw.cloud,
    judges: raw.judges,
    knowledgeMap: raw.knowledgeMap ? abs(raw.knowledgeMap) : undefined,
    user: { name: raw.user?.name?.trim() || (await gitName()) || "Me" },
  };
}

async function gitName(): Promise<string> {
  try {
    const p = Bun.spawn(["git", "config", "--global", "user.name"], { stdout: "pipe", stderr: "ignore" });
    return (await new Response(p.stdout).text()).trim();
  } catch {
    return "";
  }
}
