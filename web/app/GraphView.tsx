'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import { sans, mono } from './fonts';

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
  sources: { channel?: string; ts?: string; excerpt?: string; permalink?: string }[];
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

// SE3K brand palette (matches the landing page) rather than the design
// handoff's own warm-neutral oklch scheme.
const BG = '#26082A';
const PANEL_BG = '#2B0A32';
const BORDER = 'rgba(255,255,255,0.08)';
const BORDER_STRONG = 'rgba(255,255,255,0.15)';
const TEXT_PRIMARY = '#F3EAF4';
const TEXT_SECONDARY = '#D8C6DB';
const TEXT_MUTED = '#9C889F';
const TEXT_FAINT = '#7A6A7D';

const COLORS: Record<NodeType, string> = {
  Person: '#36C5F0',
  Project: '#2EB67D',
  Decision: '#ECB22E',
  Channel: '#E01E5A',
};
const TYPES = Object.keys(COLORS) as NodeType[];
const SHAPE_SHRINK: Record<NodeType, number> = {
  Person: 1,
  Project: 1,
  Decision: 0.82,
  Channel: 1.05,
};

const LABEL_AT_SCALE = 1.5; // labels only draw once zoomed past this — kills the clutter
const LABEL_MAX_CHARS = 26; // decision summaries are full sentences — clip them so they don't blanket the canvas

function truncateLabel(label: string, max = LABEL_MAX_CHARS) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

// Node visual radius scales with involvement (degree). baseR is the
// unshrunk size used for label offset/hit-testing; r is the drawn shape size.
function nodeRadius(n: { type: NodeType; __deg?: number }) {
  const baseR = 3.5 + Math.sqrt(n.__deg || 0) * 1.7;
  return { baseR, r: baseR * SHAPE_SHRINK[n.type] };
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
function rectsOverlap(a: Rect, b: Rect) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// CSS swatch for a node's type — mirrors the canvas shape (circle / squircle /
// diamond / hexagon) so the legend, directory, and detail chips read as the
// same shape language as the graph itself.
function shapeSwatchStyle(type: NodeType, size = 10): CSSProperties {
  const color = COLORS[type];
  const base: CSSProperties = { display: 'inline-block', flexShrink: 0, background: color };
  switch (type) {
    case 'Person':
      return { ...base, width: size, height: size, borderRadius: '50%' };
    case 'Project':
      return { ...base, width: size, height: size, borderRadius: '24%' };
    case 'Decision':
      return {
        ...base,
        width: size * 0.82,
        height: size * 0.82,
        borderRadius: '2px',
        transform: 'rotate(45deg)',
      };
    case 'Channel':
      return {
        ...base,
        width: size * 1.15,
        height: size * 1.15,
        clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
      };
  }
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws the per-type shape path for a node onto the force-graph canvas.
// Caller is responsible for beginPath()/fill()/stroke() around this.
function traceNodeShape(
  ctx: CanvasRenderingContext2D,
  type: NodeType,
  x: number,
  y: number,
  r: number,
) {
  switch (type) {
    case 'Person':
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      break;
    case 'Project': {
      const s = r * 1.7;
      roundedRectPath(ctx, x - s / 2, y - s / 2, s, s, s * 0.24);
      break;
    }
    case 'Decision': {
      const s = r * 1.5;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      roundedRectPath(ctx, -s / 2, -s / 2, s, s, 2);
      ctx.restore();
      break;
    }
    case 'Channel': {
      const pts: [number, number][] = [
        [-0.5, -1],
        [0.5, -1],
        [1, 0],
        [0.5, 1],
        [-0.5, 1],
        [-1, 0],
      ];
      pts.forEach(([px, py], i) => {
        const X = x + px * r;
        const Y = y + py * r;
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      ctx.closePath();
      break;
    }
  }
}

// Missing-data-friendly relative time — every timestamp in this view comes
// straight from the graph (edge.last_active / source.ts), never hardcoded.
function relTime(iso: string | undefined | null) {
  if (!iso) return 'unknown time';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown time';
  const diffMin = Math.round((Date.now() - t) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const hours = Math.round(diffMin / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
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
  const [zen, setZen] = useState(false);
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
      // Draw higher-degree nodes first so their labels claim space and
      // lower-degree neighbors yield instead of overlapping them.
      const nodes = [...nm.values()].sort(
        (a, b) => (b.__deg || 0) - (a.__deg || 0),
      );
      setGraphData({ nodes, links: [...lm.values()] });
    } else {
      fgRef.current?.refresh?.();
    }
  }, [teamId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Default d3-force repulsion is too weak once a hub has several satellite
  // nodes — they pile up on top of each other. Push harder around bigger
  // (higher-degree) nodes and give links more room so clusters spread out.
  useEffect(() => {
    if (graphData.nodes.length === 0) return;
    const fg = fgRef.current;
    const charge = fg?.d3Force('charge');
    charge?.strength((n: any) => -140 - (n.__deg || 0) * 22);
    const link = fg?.d3Force('link');
    link?.distance((l: any) => 60 + Math.min(l.weight || 1, 5) * 10);
    fg?.d3ReheatSimulation?.();
  }, [graphData]);

  const counts: Record<string, number> = {};
  for (const n of snap.nodes) counts[n.type] = (counts[n.type] || 0) + 1;

  // ---- Data derived straight from the live snapshot: no static/mock content
  // for the panel. The DB only stores node id/type/label and edge weight +
  // sources, so "meta", "connected", and "evidence" are all computed here from
  // whatever edges actually exist for the selected node — with honest fallback
  // copy when a node has no incident edges or no sourced excerpts yet. -------
  const edgesByNode = useMemo(() => {
    const m = new Map<string, GEdge[]>();
    const push = (id: string, e: GEdge) => {
      const arr = m.get(id);
      if (arr) arr.push(e);
      else m.set(id, [e]);
    };
    for (const e of snap.edges) {
      push(e.from, e);
      push(e.to, e);
    }
    return m;
  }, [snap.edges]);

  const detailMeta = useMemo(() => {
    if (!selected) return '';
    const inc = edgesByNode.get(selected.id) || [];
    if (inc.length === 0) return 'No recorded connections yet.';
    const last = inc.reduce((max, e) => {
      const t = new Date(e.last_active).getTime();
      return Number.isNaN(t) ? max : Math.max(max, t);
    }, 0);
    return `${inc.length} connection${inc.length === 1 ? '' : 's'} · last active ${
      last ? relTime(new Date(last).toISOString()) : 'unknown time'
    }`;
  }, [selected, edgesByNode]);

  const detailConnections = useMemo(() => {
    if (!selected) return [];
    const inc = [...(edgesByNode.get(selected.id) || [])].sort(
      (a, b) => b.weight - a.weight,
    );
    const seen = new Set<string>();
    const list: GNode[] = [];
    for (const e of inc) {
      const otherId = e.from === selected.id ? e.to : e.from;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const other = snap.nodes.find((n) => n.id === otherId);
      if (other) list.push(other);
    }
    return list;
  }, [selected, edgesByNode, snap.nodes]);

  const detailEvidence = useMemo(() => {
    if (!selected) return [];
    const inc = edgesByNode.get(selected.id) || [];
    const items: { channel: string; time: string; text: string; ts: number; permalink?: string }[] = [];
    for (const e of inc) {
      for (const s of e.sources || []) {
        if (!s.excerpt) continue;
        const t = s.ts ? new Date(s.ts).getTime() : NaN;
        items.push({
          channel: s.channel || 'unknown channel',
          time: relTime(s.ts),
          text: s.excerpt,
          ts: Number.isNaN(t) ? 0 : t,
          permalink: s.permalink,
        });
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, 6);
  }, [selected, edgesByNode]);

  const directory = useMemo(
    () =>
      TYPES.map((t) => ({
        type: t,
        items: snap.nodes.filter((n) => n.type === t).sort((a, b) => a.label.localeCompare(b.label)),
      })).filter((g) => g.items.length > 0),
    [snap.nodes],
  );

  // ---- Interaction handlers --------------------------------------------------
  const handleHover = useCallback(
    (node: any) => {
      hoverId.current = node?.id ?? null;
      if (wrapRef.current)
        wrapRef.current.style.cursor = node ? 'pointer' : 'grab';
      recomputeHighlight();
    },
    [recomputeHighlight],
  );

  const focusNode = useCallback((n: any) => {
    if (n?.x == null) return;
    fgRef.current?.centerAt(n.x, n.y, 600);
    fgRef.current?.zoom(2.4, 600);
  }, []);

  const selectAndFocus = useCallback(
    (id: string) => {
      const n = nodeMap.current.get(id);
      if (!n) return;
      setSelected(n);
      focusNode(n);
    },
    [focusNode],
  );

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

  const fit = () => fgRef.current?.zoomToFit(500, 70);

  const sidebarOpen = !zen;
  const panelOpen = !zen;

  return (
    <div
      style={{
        height: '100dvh',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: BG,
        color: TEXT_PRIMARY,
        fontFamily: sans,
      }}
    >
      <style jsx>{`
        .se3k-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .se3k-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .se3k-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 999px;
        }
        .se3k-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.28);
        }
        .se3k-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
        }
      `}</style>
      {/* HEADER */}
      <div
        style={{
          flex: 'none',
          padding: '20px 28px 16px',
          borderBottom: `1px solid ${BORDER}`,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Link
            href="/workspaces"
            aria-label="Back to workspaces"
            title="Back to workspaces"
            style={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 9,
              background: 'rgba(255,255,255,0.06)',
              border: `1px solid ${BORDER_STRONG}`,
              textDecoration: 'none',
              color: TEXT_PRIMARY,
              fontSize: 16,
              marginRight: 4,
            }}
          >
            <ArrowLeft size={17} strokeWidth={2} />
          </Link>
          <Image
            src="/logo.png"
            alt="SE3K"
            width={40}
            height={40}
            style={{ width: 40, height: 40, borderRadius: 11 }}
          />
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 700,
                color: '#FFFFFF',
                letterSpacing: '-0.01em',
              }}
            >
              SE3K
            </h1>
            <p style={{ margin: '5px 0 0', fontSize: 13, color: TEXT_SECONDARY }}>
              &ldquo;Who actually knows this?&rdquo; &mdash; ranked by demonstrated
              involvement, not assignment.
            </p>
          </div>
        </div>
        <button
          onClick={() => setZen((z) => !z)}
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            background: 'rgba(255,255,255,0.06)',
            border: `1px solid ${BORDER_STRONG}`,
            color: TEXT_PRIMARY,
            fontSize: 12.5,
            fontWeight: 500,
            padding: '9px 14px',
            borderRadius: 9,
            cursor: 'pointer',
            fontFamily: sans,
          }}
        >
          {zen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span>{zen ? 'Exit zen' : 'Zen mode'}</span>
        </button>
      </div>

      {/* BODY: sidebar / canvas / detail panel */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* DIRECTORY SIDEBAR */}
        <div
          style={{
            flex: 'none',
            width: sidebarOpen ? 260 : 0,
            opacity: sidebarOpen ? 1 : 0,
            padding: sidebarOpen ? '20px 16px' : '0px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            boxSizing: 'border-box',
            background: PANEL_BG,
            borderRight: `1px solid ${BORDER}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            transition:
              'width .35s cubic-bezier(.2,.8,.2,1), opacity .25s ease, padding .35s ease',
          }}
        >
          <input
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && focusFirstMatch()}
            placeholder="Search people, projects…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: BG,
              border: `1px solid ${BORDER_STRONG}`,
              borderRadius: 8,
              padding: '9px 12px',
              fontSize: 13,
              color: TEXT_PRIMARY,
              outline: 'none',
              fontFamily: sans,
            }}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {TYPES.map((t) => {
              const off = hidden.has(t);
              const count = counts[t] || 0;
              const disabled = count === 0;
              return (
                <button
                  key={t}
                  onClick={() => !disabled && toggleType(t)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    boxSizing: 'border-box',
                    background: 'rgba(255,255,255,0.05)',
                    border: `1px solid ${BORDER_STRONG}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: disabled ? 'default' : 'pointer',
                    fontFamily: sans,
                    opacity: disabled ? 0.35 : off ? 0.4 : 1,
                  }}
                >
                  <span style={shapeSwatchStyle(t, 10)} />
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: TEXT_PRIMARY, flex: 1, textAlign: 'left' }}>
                    {t}
                  </span>
                  <span style={{ fontSize: 11, fontFamily: mono, color: TEXT_MUTED }}>{count}</span>
                </button>
              );
            })}
          </div>

          <button
            onClick={fit}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.07)',
              border: `1px solid ${BORDER_STRONG}`,
              color: TEXT_PRIMARY,
              fontSize: 12.5,
              fontWeight: 500,
              padding: '8px 14px',
              borderRadius: 8,
              cursor: 'pointer',
              fontFamily: sans,
            }}
          >
            Fit view
          </button>

          <div style={{ height: 1, width: '100%', background: BORDER }} />

          <div
            className="se3k-scroll"
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}
          >
            {directory.length === 0 && (
              <p style={{ margin: 0, fontSize: 12.5, color: TEXT_FAINT }}>No nodes yet.</p>
            )}
            {directory.map((grp) => (
              <div key={grp.type}>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: mono,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: TEXT_MUTED,
                    marginBottom: 8,
                  }}
                >
                  {grp.type}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {grp.items.map((n) => (
                    <button
                      key={n.id}
                      title={n.label}
                      onClick={() => selectAndFocus(n.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        minWidth: 0,
                        background: selected?.id === n.id ? 'rgba(255,255,255,0.1)' : 'transparent',
                        border: 'none',
                        borderRadius: 7,
                        padding: '7px 8px',
                        cursor: 'pointer',
                        fontFamily: sans,
                        textAlign: 'left',
                        boxSizing: 'border-box',
                      }}
                    >
                      <span style={shapeSwatchStyle(n.type, 8)} />
                      <span
                        style={{
                          flex: '1 1 0%',
                          minWidth: 0,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          fontSize: 12.5,
                          color: TEXT_PRIMARY,
                          lineHeight: 1.3,
                        }}
                      >
                        {n.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CANVAS */}
        <div
          ref={wrapRef}
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            cursor: 'grab',
            backgroundColor: '#200620',
            backgroundImage: 'radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1px)',
            backgroundSize: '26px 26px',
          }}
        >
          {snap.nodes.length === 0 ? (
            <div
              style={{
                display: 'flex',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 24px',
                textAlign: 'center',
                color: TEXT_FAINT,
                fontSize: 14,
              }}
            >
              No graph data yet &mdash; connect a Slack workspace and start a backfill
              from{' '}
              <a href="/workspaces" style={{ color: '#36C5F0', marginLeft: 4 }}>
                /workspaces
              </a>
              .
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              width={dims.w || undefined}
              height={dims.h || undefined}
              graphData={graphData}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={6}
              nodeVal={(n: any) => 1 + (n.__deg || 0)}
              cooldownTicks={300}
              d3VelocityDecay={0.3}
              nodeVisibility={(n: any) => !hidden.has(n.type)}
              linkVisibility={(l: any) =>
                !hidden.has(l.fromType) && !hidden.has(l.toType)
              }
              linkColor={(l: any) =>
                dimming.current
                  ? hiLinks.current.has(l.id)
                    ? 'rgba(243,234,244,0.55)'
                    : 'rgba(216,198,219,0.04)'
                  : 'rgba(216,198,219,0.16)'
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
                const { r } = nodeRadius(node);
                const lit = hiNodes.current.has(node.id);
                const isSel = node.id === selected?.id;
                const dim = dimming.current && !lit;
                const base = COLORS[node.type as NodeType] || TEXT_MUTED;

                ctx.beginPath();
                traceNodeShape(ctx, node.type, node.x, node.y, r);
                ctx.fillStyle = dim ? withAlpha(base, 0.15) : base;
                ctx.fill();

                if (lit || isSel) {
                  ctx.lineWidth = 1.6 / scale;
                  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                  ctx.stroke();
                }
              }}
              // Labels are drawn in one pass AFTER every node shape, so a
              // label can be skipped when it would land on top of another
              // node's shape — not just on top of another label.
              onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => {
                const showAll = scale > LABEL_AT_SCALE;
                const priorityIds = new Set<string>();
                if (hoverId.current) priorityIds.add(hoverId.current);
                if (selected) priorityIds.add(selected.id);

                const visible = [...nodeMap.current.values()].filter(
                  (n) => !hidden.has(n.type) && n.x != null && n.y != null,
                );
                if (visible.length === 0) return;

                const shapeRects = visible.map((n) => {
                  const { r } = nodeRadius(n);
                  return { id: n.id, x0: n.x! - r, x1: n.x! + r, y0: n.y! - r, y1: n.y! + r };
                });

                const candidates = visible
                  .filter(
                    (n) => showAll || hiNodes.current.has(n.id) || priorityIds.has(n.id),
                  )
                  .sort((a, b) => {
                    const pa = priorityIds.has(a.id) || hiNodes.current.has(a.id) ? 1 : 0;
                    const pb = priorityIds.has(b.id) || hiNodes.current.has(b.id) ? 1 : 0;
                    if (pa !== pb) return pb - pa;
                    return (b.__deg || 0) - (a.__deg || 0);
                  });

                const placed: Rect[] = [];
                for (const n of candidates) {
                  const lit = hiNodes.current.has(n.id);
                  const isSel = n.id === selected?.id;
                  const priority = lit || isSel;
                  const dim = dimming.current && !lit;
                  const { baseR } = nodeRadius(n);
                  const text = priority ? n.label : truncateLabel(n.label);
                  const fs = Math.max(11 / scale, 2.5);
                  ctx.font = `${fs}px Inter, system-ui, sans-serif`;
                  const w = ctx.measureText(text).width;
                  const labelY = n.y! + baseR + fs + 1;
                  const pad = 2 / scale;
                  const rect: Rect = {
                    x0: n.x! - w / 2 - pad,
                    x1: n.x! + w / 2 + pad,
                    y0: labelY - fs,
                    y1: labelY + pad,
                  };

                  const blocked =
                    placed.some((o) => rectsOverlap(rect, o)) ||
                    shapeRects.some((s) => s.id !== n.id && rectsOverlap(rect, s));

                  if (priority || !blocked) {
                    ctx.textAlign = 'center';
                    ctx.fillStyle = dim ? 'rgba(243,234,244,0.25)' : TEXT_PRIMARY;
                    ctx.fillText(text, n.x!, labelY);
                    placed.push(rect);
                  }
                }
              }}
              nodePointerAreaPaint={(
                node: any,
                color: string,
                ctx: CanvasRenderingContext2D,
              ) => {
                const { baseR } = nodeRadius(node);
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, baseR + 2, 0, 2 * Math.PI);
                ctx.fill();
              }}
            />
          )}
        </div>

        {/* DETAIL PANEL */}
        <div
          style={{
            flex: 'none',
            width: panelOpen ? 320 : 0,
            opacity: panelOpen ? 1 : 0,
            overflow: 'hidden',
            boxSizing: 'border-box',
            background: PANEL_BG,
            borderLeft: `1px solid ${BORDER}`,
            transition: 'width .35s cubic-bezier(.2,.8,.2,1), opacity .25s ease',
          }}
        >
          {selected ? (
            <div style={{ padding: '24px 22px', width: 320, boxSizing: 'border-box', overflowY: 'auto', height: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={shapeSwatchStyle(selected.type, 10)} />
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: mono,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: TEXT_SECONDARY,
                    }}
                  >
                    {selected.type}
                  </span>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  aria-label="Close panel"
                  style={{ background: 'none', border: 'none', color: TEXT_MUTED, cursor: 'pointer', lineHeight: 1, padding: 0, display: 'flex' }}
                >
                  <X size={18} />
                </button>
              </div>

              <h2 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 600, lineHeight: 1.35, color: '#FFFFFF' }}>
                {selected.label}
              </h2>
              <p style={{ margin: '0 0 22px', fontSize: 13.5, lineHeight: 1.6, color: TEXT_SECONDARY }}>
                {detailMeta}
              </p>

              {detailConnections.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: mono,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: TEXT_MUTED,
                      marginBottom: 10,
                    }}
                  >
                    Connected
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {detailConnections.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => selectAndFocus(c.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          background: 'rgba(255,255,255,0.06)',
                          border: `1px solid ${BORDER_STRONG}`,
                          borderRadius: 999,
                          padding: '6px 11px',
                          cursor: 'pointer',
                          fontFamily: sans,
                        }}
                      >
                        <span style={shapeSwatchStyle(c.type, 8)} />
                        <span style={{ fontSize: 12, color: TEXT_PRIMARY }}>{c.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div
                style={{
                  fontSize: 11,
                  fontFamily: mono,
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: TEXT_MUTED,
                  marginBottom: 10,
                }}
              >
                Slack evidence
              </div>
              {detailEvidence.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12.5, color: TEXT_FAINT, lineHeight: 1.5 }}>
                  No sourced Slack messages yet for this node.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {detailEvidence.map((ev, i) => (
                    <div
                      key={i}
                      style={{
                        background: BG,
                        border: `1px solid ${BORDER}`,
                        borderRadius: 10,
                        padding: '12px 13px',
                      }}
                    >
                      <p style={{ margin: '0 0 9px', fontSize: 13, lineHeight: 1.55, color: TEXT_PRIMARY }}>
                        {ev.text}
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: mono, color: TEXT_MUTED }}>
                        <span>{ev.channel}</span>
                        <span>&middot;</span>
                        <span>{ev.time}</span>
                        {ev.permalink && (
                          <>
                            <span style={{ flex: 1 }} />
                            <a
                              href={ev.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open in Slack"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                color: '#36C5F0',
                                textDecoration: 'none',
                              }}
                            >
                              <span>View in Slack</span>
                              <ExternalLink size={11} />
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                height: '100%',
                minHeight: 400,
                width: 320,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                padding: 40,
                gap: 12,
              }}
            >
              <div style={{ width: 44, height: 44, borderRadius: '50%', border: `1.5px dashed ${BORDER_STRONG}` }} />
              <p style={{ margin: 0, fontSize: 13.5, color: TEXT_FAINT, lineHeight: 1.6, maxWidth: 200 }}>
                Select a person, project, or decision to see who actually knows this.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
