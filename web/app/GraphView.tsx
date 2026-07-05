'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

// react-force-graph uses canvas + window, so it must be client-only.
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
});

type NodeType = 'Person' | 'Project' | 'Decision' | 'Channel';

interface GNode {
  id: string;
  type: NodeType;
  label: string;
}
interface GEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  weight: number;
  last_active: string;
  sources: { channel?: string; ts?: string; excerpt?: string }[];
}
interface Snapshot {
  nodes: GNode[];
  edges: GEdge[];
  updatedAt: string | null;
}

// Mutable shapes the force engine augments with x/y/vx/vy in place.
type FNode = GNode & {
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  __deg?: number;
};
type FLink = {
  id: string;
  source: any;
  target: any;
  type: string;
  weight: number;
  fromType: NodeType;
  toType: NodeType;
};

const COLORS: Record<NodeType, string> = {
  Person: '#36C5F0',
  Project: '#2EB67D',
  Decision: '#ECB22E',
  Channel: '#9b59b6',
};
const TYPES = Object.keys(COLORS) as NodeType[];

const LABEL_AT_SCALE = 1.5; // labels only draw once zoomed past this — kills the clutter

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function GraphView({ teamId }: { teamId: string }) {
  const [snap, setSnap] = useState<Snapshot>({
    nodes: [],
    edges: [],
    updatedAt: null,
  });
  const [graphData, setGraphData] = useState<{
    nodes: FNode[];
    links: FLink[];
  }>({
    nodes: [],
    links: [],
  });
  const [selected, setSelected] = useState<GNode | null>(null);
  const [hidden, setHidden] = useState<Set<NodeType>>(new Set());
  const [query, setQuery] = useState('');
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Stable identity caches: reusing the same node/link objects across polls is
  // what stops the simulation from re-heating every tick.
  const nodeMap = useRef(new Map<string, FNode>());
  const linkMap = useRef(new Map<string, FLink>());
  const contentSig = useRef('');
  const memberSig = useRef('');

  // Highlight + adjacency live in refs so hover never triggers a React re-render
  // (we just repaint the canvas via fgRef.refresh()).
  const adjNodes = useRef(new Map<string, Set<string>>());
  const adjLinks = useRef(new Map<string, Set<string>>());
  const hoverId = useRef<string | null>(null);
  const hiNodes = useRef(new Set<string>());
  const hiLinks = useRef(new Set<string>());
  const dimming = useRef(false);
  const queryRef = useRef('');
  const didFit = useRef(false);

  // ---- Responsive sizing. Container is fixed-size, so measuring it can't feed
  // back into its own size → no resize loop. rAF debounces the observer. -------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        setDims({ w: el.clientWidth, h: el.clientHeight }),
      );
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // ---- Recompute which nodes/links are "lit". Reads hover + search, never sets
  // React state — just refills the ref sets and repaints. --------------------
  const recomputeHighlight = useCallback(() => {
    const hi = new Set<string>();
    const hl = new Set<string>();
    const q = queryRef.current.trim().toLowerCase();
    const hov = hoverId.current;
    if (q) {
      for (const n of nodeMap.current.values())
        if (n.label.toLowerCase().includes(q)) hi.add(n.id);
    } else if (hov) {
      hi.add(hov);
      for (const id of adjNodes.current.get(hov) ?? []) hi.add(id);
      for (const lid of adjLinks.current.get(hov) ?? []) hl.add(lid);
    }
    hiNodes.current = hi;
    hiLinks.current = hl;
    dimming.current = hi.size > 0;
    fgRef.current?.refresh?.();
  }, []);

  const load = useCallback(async () => {
    let json: Snapshot;
    try {
      const res = await fetch(`/api/graph?team=${encodeURIComponent(teamId)}`, {
        cache: 'no-store',
      });
      json = await res.json();
    } catch {
      return; // transient — retry next tick without disturbing the view
    }

    const sig = JSON.stringify(json);
    if (sig === contentSig.current) return;
    contentSig.current = sig;
    setSnap(json);

    // Reconcile nodes into the identity cache, reusing existing objects in place.
    const nm = nodeMap.current;
    const seenN = new Set<string>();
    for (const n of json.nodes) {
      seenN.add(n.id);
      const ex = nm.get(n.id);
      if (ex) {
        ex.label = n.label;
        ex.type = n.type;
      } else {
        nm.set(n.id, { ...n });
      }
    }
    for (const id of [...nm.keys()]) if (!seenN.has(id)) nm.delete(id);

    // Reconcile links.
    const lm = linkMap.current;
    const seenL = new Set<string>();
    for (const e of json.edges) {
      if (!nm.has(e.from) || !nm.has(e.to)) continue;
      seenL.add(e.id);
      const ex = lm.get(e.id);
      if (ex) {
        ex.weight = e.weight;
        ex.type = e.type;
      } else {
        lm.set(e.id, {
          id: e.id,
          source: e.from,
          target: e.to,
          type: e.type,
          weight: e.weight,
          fromType: nm.get(e.from)!.type,
          toType: nm.get(e.to)!.type,
        });
      }
    }
    for (const id of [...lm.keys()]) if (!seenL.has(id)) lm.delete(id);

    // Degree + adjacency (drives node sizing and hover highlighting).
    const an = new Map<string, Set<string>>();
    const al = new Map<string, Set<string>>();
    for (const n of nm.values()) n.__deg = 0;
    const push = (m: Map<string, Set<string>>, k: string, v: string) => {
      let s = m.get(k);
      if (!s) m.set(k, (s = new Set()));
      s.add(v);
    };
    for (const e of json.edges) {
      if (!nm.has(e.from) || !nm.has(e.to)) continue;
      nm.get(e.from)!.__deg!++;
      nm.get(e.to)!.__deg!++;
      push(an, e.from, e.to);
      push(an, e.to, e.from);
      push(al, e.from, e.id);
      push(al, e.to, e.id);
    }
    adjNodes.current = an;
    adjLinks.current = al;

    // New graphData reference only when the node/link SET changes.
    const sigNow =
      [...seenN].sort().join(',') + '|' + [...seenL].sort().join(',');
    if (sigNow !== memberSig.current) {
      memberSig.current = sigNow;
      setGraphData({ nodes: [...nm.values()], links: [...lm.values()] });
    } else {
      fgRef.current?.refresh?.();
    }
  }, [teamId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const counts: Record<string, number> = {};
  for (const n of snap.nodes) counts[n.type] = (counts[n.type] || 0) + 1;

  // ---- Interaction handlers --------------------------------------------------
  const handleHover = useCallback(
    (node: any) => {
      hoverId.current = node?.id ?? null;
      if (wrapRef.current)
        wrapRef.current.style.cursor = node ? 'pointer' : 'default';
      recomputeHighlight();
    },
    [recomputeHighlight],
  );

  const focusNode = useCallback((n: any) => {
    if (n?.x == null) return;
    fgRef.current?.centerAt(n.x, n.y, 600);
    fgRef.current?.zoom(2.4, 600);
  }, []);

  const onSearch = (v: string) => {
    setQuery(v);
    queryRef.current = v;
    recomputeHighlight();
  };

  const focusFirstMatch = () => {
    const q = queryRef.current.trim().toLowerCase();
    if (!q) return;
    const m = [...nodeMap.current.values()].find((n) =>
      n.label.toLowerCase().includes(q),
    );
    if (m) {
      setSelected(m);
      focusNode(m);
    }
  };

  const toggleType = (t: NodeType) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  return (
    <div
      ref={wrapRef}
      className="relative h-[100dvh] w-full overflow-hidden bg-[#0b0b12] text-zinc-100"
    >
      {/* Header: title, search, clickable legend (doubles as a type filter) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-3 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            SE3K — Org Knowledge Graph
          </h1>
          <p className="hidden text-sm text-zinc-400 sm:block">
            “Who actually knows this?” — ranked by demonstrated involvement, not
            assignment.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <input
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && focusFirstMatch()}
            placeholder="Search people, projects…"
            className="pointer-events-auto w-44 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-sm outline-none backdrop-blur placeholder:text-zinc-500 focus:border-zinc-600 sm:w-60"
          />
          <button
            onClick={() => fgRef.current?.zoomToFit(500, 70)}
            className="pointer-events-auto rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur hover:border-zinc-600"
          >
            Fit
          </button>

          <div className="flex flex-wrap gap-2">
            {TYPES.map((t) => {
              const off = hidden.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`pointer-events-auto flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/80 px-2.5 py-1 text-xs backdrop-blur transition ${
                    off ? 'opacity-35' : 'hover:border-zinc-600'
                  }`}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: COLORS[t] }}
                  />
                  <span className={off ? 'line-through' : ''}>{t}</span>
                  <span className="text-zinc-500">{counts[t] || 0}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Detail panel — right rail on desktop, bottom sheet on mobile */}
      {selected && (
        <div
          className="pointer-events-auto absolute z-20 border border-zinc-800 bg-zinc-900/95 backdrop-blur
            inset-x-0 bottom-0 max-h-[55vh] overflow-y-auto rounded-t-2xl p-4
            sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-0 sm:m-4 sm:w-80 sm:max-h-[calc(100vh-2rem)] sm:rounded-xl"
        >
          <div className="flex items-center justify-between">
            <span
              className="rounded px-2 py-0.5 text-xs font-medium text-black"
              style={{ background: COLORS[selected.type] }}
            >
              {selected.type}
            </span>
            <button
              onClick={() => setSelected(null)}
              className="text-zinc-500 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
          <h2 className="mt-2 text-lg font-semibold">{selected.label}</h2>
          <div className="mt-3 space-y-2 text-sm">
            {snap.edges
              .filter((e) => e.from === selected.id || e.to === selected.id)
              .sort((a, b) => b.weight - a.weight)
              .map((e) => {
                const otherId = e.from === selected.id ? e.to : e.from;
                const other = snap.nodes.find((n) => n.id === otherId);
                return (
                  <button
                    key={e.id}
                    onClick={() => {
                      if (other) {
                        setSelected(other);
                        focusNode(nodeMap.current.get(other.id));
                      }
                    }}
                    className="block w-full rounded-lg bg-zinc-800/60 p-2 text-left hover:bg-zinc-800"
                  >
                    <div className="text-xs text-zinc-400">
                      {e.type} · weight {e.weight} ·{' '}
                      {new Date(e.last_active).toLocaleDateString()}
                    </div>
                    <div className="font-medium">{other?.label || otherId}</div>
                    {e.sources?.[0]?.excerpt && (
                      <div className="mt-1 text-xs italic text-zinc-400">
                        “{e.sources[0].excerpt}”
                      </div>
                    )}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {snap.nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-zinc-500">
          No graph data yet — seed the demo or ingest some Slack messages.
        </div>
      ) : (
        <ForceGraph2D
          ref={fgRef}
          width={dims.w || undefined}
          height={dims.h || undefined}
          graphData={graphData}
          backgroundColor="#0b0b12"
          nodeRelSize={6}
          nodeVal={(n: any) => 1 + (n.__deg || 0)}
          cooldownTicks={120}
          d3VelocityDecay={0.3}
          nodeVisibility={(n: any) => !hidden.has(n.type)}
          linkVisibility={(l: any) =>
            !hidden.has(l.fromType) && !hidden.has(l.toType)
          }
          linkColor={(l: any) =>
            dimming.current
              ? hiLinks.current.has(l.id)
                ? 'rgba(255,255,255,0.55)'
                : 'rgba(255,255,255,0.04)'
              : 'rgba(255,255,255,0.13)'
          }
          linkWidth={(l: any) =>
            hiLinks.current.has(l.id)
              ? Math.min(1 + (l.weight || 1) * 0.5, 5)
              : Math.min(0.4 + (l.weight || 1) * 0.3, 3)
          }
          // Particles only on the links you're hovering → clean by default.
          linkDirectionalParticles={(l: any) =>
            hiLinks.current.has(l.id) ? 3 : 0
          }
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleSpeed={0.006}
          onNodeHover={handleHover}
          onNodeClick={(n: any) => {
            setSelected(n);
            focusNode(n);
          }}
          onNodeDragEnd={(n: any) => {
            // Pin where dropped so the layout stops shoving it around.
            n.fx = n.x;
            n.fy = n.y;
          }}
          onBackgroundClick={() => {
            setSelected(null);
            hoverId.current = null;
            recomputeHighlight();
          }}
          onEngineStop={() => {
            if (!didFit.current) {
              didFit.current = true;
              fgRef.current?.zoomToFit(500, 70);
            }
          }}
          nodeCanvasObject={(
            node: any,
            ctx: CanvasRenderingContext2D,
            scale: number,
          ) => {
            const r = 3.5 + Math.sqrt(node.__deg || 0) * 1.7; // size = involvement
            const lit = hiNodes.current.has(node.id);
            const isSel = node.id === selected?.id;
            const dim = dimming.current && !lit;
            const base = COLORS[node.type as NodeType] || '#888';

            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = dim ? withAlpha(base, 0.15) : base;
            ctx.fill();

            if (lit || isSel) {
              ctx.lineWidth = 1.6 / scale;
              ctx.strokeStyle = 'rgba(255,255,255,0.9)';
              ctx.stroke();
            }

            // Label only when zoomed in, highlighted, or selected.
            if (scale > LABEL_AT_SCALE || lit || isSel) {
              const fs = Math.max(11 / scale, 2.5);
              ctx.font = `${fs}px Inter, system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.fillStyle = dim ? 'rgba(228,228,231,0.25)' : '#e4e4e7';
              ctx.fillText(node.label, node.x, node.y + r + fs + 1);
            }
          }}
          nodePointerAreaPaint={(
            node: any,
            color: string,
            ctx: CanvasRenderingContext2D,
          ) => {
            const r = 3.5 + Math.sqrt(node.__deg || 0) * 1.7;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      )}
    </div>
  );
}
