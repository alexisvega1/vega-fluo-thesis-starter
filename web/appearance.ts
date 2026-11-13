// How Margin looks and sounds: colour scheme, typefaces, text size, line spacing, column width,
// zoom, and optional typing sounds. One settings object, remembered in this browser.

export interface Look {
  theme: string; font: string; ui: string; size: number; leading: number; measure: number; zoom: number;
  sound: boolean; pack: string; volume: number; mono: string;
}
export const DEFAULT_LOOK: Look = { theme: "auto", font: "iowan", ui: "system", size: 18, leading: 1.72, measure: 46, zoom: 100, sound: false, pack: "soft", volume: 0.5, mono: "sfmono" };

/** id, name, whether it is dark, and three swatch colours (page, text, accent) for the picker. */
export const THEMES: { id: string; name: string; dark: boolean | null; swatch: [string, string, string] }[] = [
  { id: "auto", name: "Match system", dark: null, swatch: ["#faf8f3", "#181715", "#0f6b63"] },
  { id: "light", name: "Paper", dark: false, swatch: ["#faf8f3", "#23201b", "#0f6b63"] },
  { id: "mist", name: "Mist", dark: false, swatch: ["#f6f8fa", "#1f2933", "#2f6fde"] },
  { id: "sepia", name: "Sepia", dark: false, swatch: ["#f4ecd8", "#433422", "#9a5b1e"] },
  { id: "solarized", name: "Solarized", dark: false, swatch: ["#fdf6e3", "#33454d", "#268bd2"] },
  { id: "dark", name: "Ink", dark: true, swatch: ["#181715", "#e8e3d8", "#5cc4b8"] },
  { id: "graphite", name: "Graphite", dark: true, swatch: ["#212121", "#ececec", "#4fd1a5"] },
  { id: "nord", name: "Nord", dark: true, swatch: ["#2e3440", "#e5e9f0", "#88c0d0"] },
  { id: "tokyo", name: "Tokyo Night", dark: true, swatch: ["#1a1b26", "#c0caf5", "#7aa2f7"] },
];

export const FONTS: { id: string; name: string; stack: string }[] = [
  { id: "iowan", name: "Iowan Old Style (serif)", stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
  { id: "newyork", name: "New York (serif)", stack: 'ui-serif, "New York", Georgia, serif' },
  { id: "charter", name: "Charter (serif)", stack: 'Charter, "Bitstream Charter", Georgia, serif' },
  { id: "georgia", name: "Georgia (serif)", stack: "Georgia, serif" },
  { id: "inter", name: "Inter (sans)", stack: '"Inter Variable", Inter, system-ui, sans-serif' },
  { id: "system", name: "San Francisco (sans)", stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' },
  { id: "avenir", name: "Avenir Next (sans)", stack: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif' },
  { id: "mono", name: "SF Mono (monospace)", stack: 'ui-monospace, "SF Mono", Menlo, monospace' },
  { id: "geist", name: "Geist Mono (monospace)", stack: '"Geist Mono", ui-monospace, Menlo, monospace' },
  { id: "jetbrains", name: "JetBrains Mono (monospace)", stack: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  { id: "fira", name: "Fira Code (monospace)", stack: '"Fira Code", ui-monospace, Menlo, monospace' },
  { id: "plex", name: "IBM Plex Mono (monospace)", stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
  { id: "sourcecode", name: "Source Code Pro (monospace)", stack: '"Source Code Pro", ui-monospace, Menlo, monospace' },
];
/** The font for code, keys, file names and the plain-text view. */
export const CODE_FONTS: { id: string; name: string; stack: string }[] = [
  { id: "sfmono", name: "SF Mono", stack: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace' },
  { id: "geist", name: "Geist Mono", stack: '"Geist Mono", ui-monospace, Menlo, monospace' },
  { id: "jetbrains", name: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  { id: "fira", name: "Fira Code", stack: '"Fira Code", ui-monospace, Menlo, monospace' },
  { id: "plex", name: "IBM Plex Mono", stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
  { id: "sourcecode", name: "Source Code Pro", stack: '"Source Code Pro", ui-monospace, Menlo, monospace' },
];
const UI: Record<string, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  inter: '"Inter Variable", Inter, system-ui, sans-serif',
};

export function loadLook(): Look {
  try {
    const saved = JSON.parse(localStorage.getItem("margin.look") ?? "{}");
    const legacy = localStorage.getItem("margin.theme"); // the old light/dark switch
    return { ...DEFAULT_LOOK, ...(legacy && !saved.theme ? { theme: legacy } : {}), ...saved };
  } catch { return { ...DEFAULT_LOOK }; }
}

export function applyLook(l: Look) {
  const root = document.documentElement, s = root.style;
  const theme = THEMES.find((t) => t.id === l.theme) ?? THEMES[0]!;
  if (theme.id === "auto") delete root.dataset.theme; else root.dataset.theme = theme.id;
  const dark = theme.dark ?? matchMedia("(prefers-color-scheme: dark)").matches;
  root.toggleAttribute("data-dark", dark);
  s.setProperty("--serif", (FONTS.find((f) => f.id === l.font) ?? FONTS[0]!).stack);
  s.setProperty("--sans", UI[l.ui] ?? UI.system!);
  s.setProperty("--mono", (CODE_FONTS.find((f) => f.id === l.mono) ?? CODE_FONTS[0]!).stack);
  s.setProperty("--write-size", `${l.size}px`);
  s.setProperty("--leading", String(l.leading));
  s.setProperty("--measure", `${l.measure}rem`);
  (s as any).zoom = l.zoom === 100 ? "" : String(l.zoom / 100);
  try {
    localStorage.setItem("margin.look", JSON.stringify(l));
    localStorage.setItem("margin.theme", theme.id === "auto" ? "" : theme.id); // read before first paint
  } catch {}
}

// ---------- typing sounds ----------
// Synthesised in the browser, so there is nothing to download; a custom sound is any short audio
// file you choose, kept in this browser only.
export const PACKS: { id: string; name: string; group: string; folder?: string; count?: number }[] = [
  { id: "soft", name: "Soft click", group: "Synthesised" },
  { id: "typewriter", name: "Typewriter (with bell)", group: "Synthesised" },
  { id: "mechanical", name: "Mechanical keyboard", group: "Synthesised" },
  { id: "bubble", name: "Bubble", group: "Synthesised" },
  { id: "blip", name: "Blip", group: "Synthesised" },
  // recordings, the same sets TypeAlgo uses (from MonkeyType; see sounds/ATTRIBUTION.md)
  { id: "click-1", name: "Click", group: "Recorded", folder: "click1", count: 3 },
  { id: "click-2", name: "Beep", group: "Recorded", folder: "click2", count: 3 },
  { id: "click-3", name: "Pop", group: "Recorded", folder: "click3", count: 3 },
  { id: "click-5", name: "Typewriter", group: "Recorded", folder: "click5", count: 6 },
  { id: "click-4", name: "NK Creams", group: "Recorded keyboards", folder: "click4", count: 6 },
  { id: "click-15", name: "Rubber keys", group: "Recorded keyboards", folder: "click15", count: 5 },
  { id: "click-17", name: "Akko Lavenders", group: "Recorded keyboards", folder: "click17", count: 10 },
  { id: "click-18", name: "Cherry MX Black ABS", group: "Recorded keyboards", folder: "click18", count: 10 },
  { id: "click-19", name: "Cherry MX Black PBT", group: "Recorded keyboards", folder: "click19", count: 10 },
  { id: "click-20", name: "Cherry MX Blue ABS", group: "Recorded keyboards", folder: "click20", count: 10 },
  { id: "click-21", name: "Cherry MX Blue PBT", group: "Recorded keyboards", folder: "click21", count: 10 },
  { id: "click-22", name: "Cherry MX Brown PBT", group: "Recorded keyboards", folder: "click22", count: 10 },
  { id: "click-23", name: "Kailh Box White", group: "Recorded keyboards", folder: "click23", count: 10 },
  { id: "click-24", name: "Razer Green", group: "Recorded keyboards", folder: "click24", count: 10 },
  { id: "click-25", name: "Tealios V2", group: "Recorded keyboards", folder: "click25", count: 10 },
  { id: "custom", name: "Your own sound", group: "Yours" },
];

/** Recorded packs are fetched from Margin itself the first time they are chosen, then kept in memory. */
const samples = new Map<string, AudioBuffer[]>();
const loading = new Set<string>();
function loadPack(c: AudioContext, id: string) {
  const pack = PACKS.find((p) => p.id === id);
  if (!pack?.folder || samples.has(id) || loading.has(id)) return;
  loading.add(id);
  Promise.all(Array.from({ length: pack.count! }, (_, i) =>
    fetch(`/sounds/${pack.folder}/${i + 1}.wav`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject())).then((b) => c.decodeAudioData(b))))
    .then((bufs) => samples.set(id, bufs)).catch(() => {}).finally(() => loading.delete(id));
}
/** Fetch a pack ahead of the first keystroke. */
export function warmPack(l: Look) { if (l.sound && PACKS.find((p) => p.id === l.pack)?.folder) loadPack((ctx ??= new AudioContext()), l.pack); }

type Key = "key" | "space" | "enter" | "delete";
let ctx: AudioContext | null = null;
let custom: AudioBuffer | null = null;
let customTried = false;

function noise(c: AudioContext, seconds: number) {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}
function tone(c: AudioContext, out: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, gain: number) {
  const o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + dur + 0.02);
}
function burst(c: AudioContext, out: AudioNode, filter: BiquadFilterType, freq: number, dur: number, gain: number) {
  const n = noise(c, dur), f = c.createBiquadFilter(), g = c.createGain();
  f.type = filter; f.frequency.value = freq;
  g.gain.value = gain;
  n.connect(f).connect(g).connect(out);
  n.start();
}

export async function setCustomSound(file: File | null): Promise<string> {
  if (!file) { localStorage.removeItem("margin.sound.custom"); custom = null; return "Custom sound removed."; }
  if (file.size > 400_000) return "That file is over 400 KB; a typing sound should be a fraction of a second.";
  const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(file); });
  try {
    ctx ??= new AudioContext();
    custom = await ctx.decodeAudioData(await (await fetch(data)).arrayBuffer());
    localStorage.setItem("margin.sound.custom", data);
    return `Using ${file.name} (${custom.duration.toFixed(2)} s).`;
  } catch { return "That file could not be read as audio."; }
}

export function playKey(l: Look, key: Key) {
  if (!l.sound) return;
  const c = (ctx ??= new AudioContext());
  if (c.state === "suspended") c.resume();
  const out = c.createGain();
  out.gain.value = l.volume;
  out.connect(c.destination);
  const jitter = 0.94 + Math.random() * 0.12; // a little variation so it does not sound like a machine gun
  if (l.pack === "custom") {
    if (!custom && !customTried) {
      customTried = true;
      const data = localStorage.getItem("margin.sound.custom");
      if (data) fetch(data).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b)).then((b) => { custom = b; }).catch(() => {});
    }
    if (custom) { const s = c.createBufferSource(); s.buffer = custom; s.playbackRate.value = jitter * (key === "delete" ? 0.8 : key === "enter" ? 0.7 : 1); s.connect(out); s.start(); return; }
  }
  if (PACKS.find((p) => p.id === l.pack)?.folder) {
    const bufs = samples.get(l.pack);
    if (!bufs) { loadPack(c, l.pack); return; } // first key of a new pack is silent while it loads
    const s = c.createBufferSource();
    s.buffer = bufs[Math.floor(Math.random() * bufs.length)]!;
    s.connect(out); s.start();
    return;
  }
  if (l.pack === "blip") { tone(c, out, "sine", key === "delete" ? 220 : 920, key === "delete" ? 200 : 900, key === "delete" ? 0.07 : 0.045, 0.3); return; }
  const pack = l.pack === "custom" ? "soft" : l.pack;
  if (pack === "soft") {
    burst(c, out, "lowpass", (key === "space" ? 1400 : 2600) * jitter, 0.03, 0.5);
    tone(c, out, "sine", (key === "enter" ? 150 : 210) * jitter, 90, 0.05, 0.25);
  } else if (pack === "typewriter") {
    burst(c, out, "highpass", 1800 * jitter, 0.045, 0.7);
    tone(c, out, "square", (key === "delete" ? 300 : 520) * jitter, 180, 0.02, 0.12);
    if (key === "enter") tone(c, out, "sine", 1760, 1740, 0.7, 0.18); // the carriage bell
  } else if (pack === "mechanical") {
    burst(c, out, "bandpass", (key === "space" ? 900 : 1500) * jitter, 0.022, 0.9);
    tone(c, out, "triangle", (key === "space" ? 120 : 180) * jitter, 70, 0.06, 0.35);
    setTimeout(() => burst(c, out, "bandpass", 2200 * jitter, 0.014, 0.35), 55); // the key coming back up
  } else {
    tone(c, out, "sine", (key === "delete" ? 700 : key === "enter" ? 420 : 520) * jitter, (key === "delete" ? 380 : 880) * jitter, 0.07, 0.3);
  }
}
