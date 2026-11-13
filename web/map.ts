// The knowledge map as a side-panel graph: papers are nodes, citations are edges.
// It reacts to writing: papers cited in the current paragraph are filled, suggested papers are ringed,
// and (when "Follow writing" is on) the view glides to wherever those papers sit in the map.
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";

export interface MapNode { id: string; short: string; title: string; year: number; review: boolean; tags: string[]; indeg: number; claim: string; pmid: string; key: string | null; x?: number; y?: number; fx?: number | null; fy?: number | null }
export interface MapData { generated: string; labels: Record<string, string>; nodes: MapNode[]; edges: [number, number][] }

const radius = (n: MapNode) => 2.6 + Math.sqrt(n.indeg) * 0.85;
const hueOf = (n: MapNode) => ((parseInt(n.tags[0]?.slice(1) ?? "0", 10) || 0) * 47) % 360;

export function createMap(canvas: HTMLCanvasElement, onPick: (n: MapNode | null) => void) {
  const ctx = canvas.getContext("2d")!;
  let data: MapData = { generated: "", labels: {}, nodes: [], edges: [] };
  let neighbours: Set<number>[] = [];
  let index = new Map<string, number>();
  let cited = new Set<number>(), suggested = new Set<number>();
  let picked = -1;
  let follow = true, labels = false;
  let t: ZoomTransform = zoomIdentity;
  let w = 0, h = 0, raf = 0, flight = 0;

  let sim: ReturnType<typeof forceSimulation> | null = null;
  let dragging = -1, moved = false;
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Wake the layout so the graph eases into place instead of jumping. */
  const stir = (alpha: number) => { if (sim && !still()) sim.alpha(Math.max(sim.alpha(), alpha)).restart(); };

  // dragging empty space pans and the wheel zooms; dragging a paper moves that paper (handled below)
  const z = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.15, 12])
    .filter((e: any) => (e.type === "wheel" || !e.button) && !(e.type !== "wheel" && nodeAt(e) >= 0))
    .on("zoom", (e) => { t = e.transform; schedule(); });
  const sel = select(canvas).call(z).on("dblclick.zoom", null);

  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }
  new ResizeObserver(resize).observe(canvas);

  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }

  function draw() {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const ink = v("--ink"), accent = v("--accent"), warn = v("--warn"), paper = v("--paper"), rule = v("--muted");
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
    const focus = new Set<number>([...cited, ...suggested, ...(picked >= 0 ? [picked] : [])]);
    const lit = new Set<number>(focus);
    for (const i of focus) for (const j of neighbours[i] ?? []) lit.add(j);
    const any = focus.size > 0;

    ctx.lineWidth = 0.6 / t.k;
    for (const [a, b] of data.edges) {
      const hot = focus.has(a) || focus.has(b);
      if (any && !hot) continue; // with a focus, only its own citations are drawn
      ctx.strokeStyle = rule; ctx.globalAlpha = hot ? 0.55 : 0.13;
      ctx.beginPath(); ctx.moveTo(data.nodes[a]!.x!, data.nodes[a]!.y!); ctx.lineTo(data.nodes[b]!.x!, data.nodes[b]!.y!); ctx.stroke();
    }
    data.nodes.forEach((n, i) => {
      const r = radius(n), isCited = cited.has(i), isSug = suggested.has(i);
      ctx.globalAlpha = !any || lit.has(i) ? 1 : 0.16;
      ctx.beginPath(); ctx.arc(n.x!, n.y!, isCited || isSug || i === picked ? r + 1.5 : r, 0, 6.2832);
      ctx.fillStyle = isCited ? accent : `hsl(${hueOf(n)} 42% 56%)`;
      ctx.fill();
      if (isSug || i === picked) { ctx.lineWidth = 2 / t.k; ctx.strokeStyle = i === picked ? ink : warn; ctx.stroke(); }
      else if (n.review) { ctx.lineWidth = 0.8 / t.k; ctx.strokeStyle = ink; ctx.setLineDash([1.5 / t.k, 1.5 / t.k]); ctx.stroke(); ctx.setLineDash([]); }
    });
    ctx.globalAlpha = 1;
    ctx.font = `${11 / t.k}px -apple-system, system-ui, sans-serif`;
    ctx.lineWidth = 3 / t.k; ctx.strokeStyle = paper; ctx.fillStyle = ink;
    data.nodes.forEach((n, i) => {
      if (!(focus.has(i) || (labels && t.k > 1.4) || (any && lit.has(i) && t.k > 2.2))) return;
      const x = n.x! + radius(n) + 3 / t.k, y = n.y! + 3.5 / t.k;
      ctx.strokeText(n.short, x, y); ctx.fillText(n.short, x, y);
    });
    ctx.restore();
  }

  /** Glide the view so the given nodes (and a little context) fill the panel. */
  function flyTo(ids: Iterable<number>) {
    const pts = [...ids].map((i) => data.nodes[i]!).filter(Boolean);
    if (!pts.length || !w) return;
    const xs = pts.map((p) => p.x!), ys = pts.map((p) => p.y!);
    const x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 60, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 60;
    const k = Math.max(0.3, Math.min(3.2, 0.9 * Math.min(w / (x1 - x0), h / (y1 - y0))));
    const target = zoomIdentity.translate(w / 2 - (k * (x0 + x1)) / 2, h / 2 - (k * (y0 + y1)) / 2).scale(k);
    const from = t, start = performance.now(), id = ++flight;
    const step = (now: number) => {
      if (id !== flight) return;
      const u = still() ? 1 : Math.min(1, (now - start) / 650), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const k2 = from.k + (target.k - from.k) * e;
      sel.call(z.transform, zoomIdentity.translate(from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e).scale(k2));
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const fit = () => flyTo(data.nodes.map((_, i) => i));

  function nodeAt(ev: MouseEvent): number {
    const r = canvas.getBoundingClientRect();
    const [x, y] = t.invert([ev.clientX - r.left, ev.clientY - r.top]);
    let best = -1, bd = Infinity;
    data.nodes.forEach((n, i) => { const d = Math.hypot(n.x! - x, n.y! - y); if (d < radius(n) + 5 / t.k && d < bd) { bd = d; best = i; } });
    return best;
  }
  canvas.addEventListener("click", (e) => { if (moved) { moved = false; return; } picked = nodeAt(e); onPick(picked >= 0 ? data.nodes[picked]! : null); schedule(); });
  // pick a paper up and the rest of the graph flows around it, as in the knowledge-map explorer
  canvas.addEventListener("pointerdown", (e) => {
    const i = e.button === 0 ? nodeAt(e) : -1;
    if (i < 0) return;
    dragging = i; moved = false;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    const n = data.nodes[i]!;
    n.fx = n.x; n.fy = n.y;
    if (sim && !still()) sim.alphaTarget(0.3).restart();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging < 0) return;
    const r = canvas.getBoundingClientRect(), [x, y] = t.invert([e.clientX - r.left, e.clientY - r.top]);
    const n = data.nodes[dragging]!;
    n.fx = x; n.fy = y; moved = true;
    if (still()) { n.x = x; n.y = y; }
    schedule();
  });
  const drop = () => {
    if (dragging < 0) return;
    const n = data.nodes[dragging]!;
    n.fx = null; n.fy = null; dragging = -1;
    sim?.alphaTarget(0);
  };
  canvas.addEventListener("pointerup", drop);
  canvas.addEventListener("pointercancel", drop);
  canvas.addEventListener("mousemove", (e) => {
    const i = nodeAt(e);
    canvas.style.cursor = dragging >= 0 ? "grabbing" : i >= 0 ? "pointer" : "grab";
    canvas.title = i >= 0 ? `${data.nodes[i]!.short}: ${data.nodes[i]!.claim.slice(0, 220)}` : "";
  });

  return {
    setData(d: MapData) {
      data = d;
      index = new Map(d.nodes.flatMap((n, i) => (n.key && n.key !== n.id ? [[n.id, i], [n.key, i]] : [[n.id, i]]) as [string, number][]));
      neighbours = d.nodes.map(() => new Set<number>());
      for (const [a, b] of d.edges) { neighbours[a]!.add(b); neighbours[b]!.add(a); }
      // the same forces as the knowledge-map explorer; it starts roughly settled, then keeps easing live
      sim?.stop();
      sim = forceSimulation(d.nodes as any)
        .force("link", forceLink(d.edges.map(([source, target]) => ({ source, target }))).distance(44).strength(0.32))
        .force("charge", forceManyBody().strength(-85).distanceMax(520))
        .force("x", forceX(0).strength(0.045)).force("y", forceY(0).strength(0.045)) // keeps unlinked papers from drifting off
        .force("center", forceCenter(0, 0))
        .force("collide", forceCollide((n: any) => radius(n) + 2))
        .velocityDecay(0.32)
        .stop();
      for (let i = 0, n = still() ? 300 : 90; i < n; i++) sim.tick();
      let first = true;
      sim.on("tick", schedule).on("end", () => { if (first && !cited.size && !suggested.size && picked < 0) fit(); first = false; });
      if (!still()) sim.alpha(0.5).restart();
      resize();
      fit();
    },
    /** Returns how many of the given keys exist in the map. */
    setFocus(citedKeys: Iterable<string>, suggestedKeys: Iterable<string>) {
      const pick = (keys: Iterable<string>) => new Set([...keys].map((k) => index.get(k)).filter((i): i is number => i !== undefined));
      const c = pick(citedKeys), s = pick(suggestedKeys);
      for (const i of c) s.delete(i);
      const changed = c.size !== cited.size || s.size !== suggested.size || [...c].some((i) => !cited.has(i)) || [...s].some((i) => !suggested.has(i));
      cited = c; suggested = s;
      if (changed) stir(0.12); // a small ripple each time the writing moves to different papers
      if (changed && follow && c.size + s.size > 0) flyTo([...c, ...s]);
      schedule();
      return { cited: c.size, suggested: s.size };
    },
    setFollow(on: boolean) { follow = on; if (on && cited.size + suggested.size) flyTo([...cited, ...suggested]); },
    setLabels(on: boolean) { labels = on; schedule(); },
    has: (key: string) => index.has(key),
    fit,
    redraw: schedule,
    /** Call when the map comes back into view, so it moves again. */
    wake: () => stir(0.25),
  };
}
