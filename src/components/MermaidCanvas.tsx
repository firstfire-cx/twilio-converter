// src/components/MermaidCanvas.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import type { IR } from "../types";
import { buildMermaid, collectGhostRefs } from "../utils/mermaidBuilder";

interface Props {
  ir: IR;
  selectedId: string | null;
  onSelect?: (id: string | null) => void;
  onPickNode?: ((id: string) => void) | null;
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.12;

export default function MermaidCanvas({ ir, selectedId, onSelect, onPickNode }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const isEmpty = Object.keys(ir.nodes).length === 0;

  // ── Transform state ──────────────────────────────────────────────────────
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

  // ── Debug: ghost / dangling-reference overlay ────────────────────────────
  const [showGhosts, setShowGhosts] = useState(false);
  const ghostRefs = collectGhostRefs(ir);
  const ghostCount = new Set(ghostRefs.map((r) => r.targetId)).size;

  // ── Mermaid init ─────────────────────────────────────────────────────────
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "loose",
      flowchart: { curve: "basis", padding: 20, nodeSpacing: 50, rankSpacing: 60 },
      themeVariables: {
        primaryColor: "#1a1a1d",
        primaryBorderColor: "#3d3d41",
        primaryTextColor: "#f0f0f2",
        lineColor: "#3d8ef0",
        edgeLabelBackground: "#141416",
        clusterBkg: "#1a1a1d",
        titleColor: "#f0f0f2",
        fontSize: "13px",
      },
    });
  }, []);

  // ── Render SVG ───────────────────────────────────────────────────────────
  useEffect(() => {
    const render = async () => {
      if (!svgContainerRef.current || isEmpty) return;
      try {
        const code = buildMermaid(ir, selectedId, showGhosts);
        const { svg } = await mermaid.render(`mid_${Date.now()}`, code);
        svgContainerRef.current.innerHTML = svg;

        const svgEl = svgContainerRef.current.querySelector("svg");
        if (svgEl) {
          svgEl.style.maxWidth = "none";
          const viewBox = svgEl.getAttribute("viewBox");
          if (viewBox) {
            const parts = viewBox.split(" ");
            if (parts.length === 4) {
              svgEl.setAttribute("width", parts[2]);
              svgEl.setAttribute("height", parts[3]);
              svgEl.style.width = `${parts[2]}px`;
              svgEl.style.height = `${parts[3]}px`;
            }
          }
        }
      } catch (e) {
        console.error("Mermaid render error", e);
      }
    };
    render();
  }, [ir, selectedId, isEmpty, showGhosts]);

  // ── Fit to view ──────────────────────────────────────────────────────────
  const fitToView = useCallback(() => {
    setScale(0.7);
    setOffset({ x: 40, y: 40 });
  }, []);

  useEffect(() => {
    if (!isEmpty) setTimeout(fitToView, 100);
  }, [ir.flow_id, isEmpty]);

  // ── Wheel zoom ───────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setScale((prev) => {
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev + delta));
        const ratio = next / prev;
        setOffset((o) => ({
          x: mx - ratio * (mx - o.x),
          y: my - ratio * (my - o.y),
        }));
        return next;
      });
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // ── Pan drag ─────────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const nodeEl = (e.target as HTMLElement).closest("g.node");
    if (nodeEl) return;
    if (e.button !== 0 && e.button !== 1) return;
    setDragging(true);
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };
    e.preventDefault();
  }, [offset]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    setOffset({
      x: dragStart.current.ox + (e.clientX - dragStart.current.mx),
      y: dragStart.current.oy + (e.clientY - dragStart.current.my),
    });
  };

  const handleMouseUp = useCallback(() => setDragging(false), []);

  // ── Node click ───────────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent) => {
    const nodeEl = (e.target as HTMLElement).closest("g.node");
    if (nodeEl) {
      // Ghost nodes ("ghost_…") are not selectable
      if (nodeEl.id.includes("ghost_")) return;
      // Mermaid DOM ids look like "[<diagramId>-]flowchart-n_<stepId>-<counter>".
      // Anchor on the "n_" marker instead of a fixed dash-segment index (which
      // breaks when a build prefixes the id), then drop the trailing "-<counter>".
      const marker = nodeEl.id.indexOf("n_");
      if (marker === -1) return;
      const id = nodeEl.id.slice(marker + 2).replace(/-\d+$/, "");
      if (onPickNode) {
        onPickNode(id);
      } else {
        onSelect?.(id === selectedId ? null : id);
      }
    } else if (!onPickNode) {
      onSelect?.(null);
    }
  }, [onPickNode, onSelect, selectedId]);

  const isPicking = Boolean(onPickNode);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "absolute", inset: 0,
        background: "var(--bg-1)",
        overflow: "hidden",
        cursor: isPicking ? "crosshair" : dragging ? "grabbing" : "grab",
        userSelect: "none",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
    >
      {/* Grid */}
      <div className="canvas-grid" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />

      {/* Pick mode banner */}
      {isPicking && (
        <div style={{
          position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
          background: "rgba(61,142,240,0.9)", color: "#fff", borderRadius: 4,
          padding: "4px 14px", fontSize: 11, fontWeight: 600, zIndex: 10,
          fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.05em",
          pointerEvents: "none",
        }}>
          ↗ Click a node to select it as target
        </div>
      )}

      {isEmpty ? (
        <div className="canvas-empty" style={{ position: "absolute", inset: 0 }}>
          <div className="canvas-empty-icon">⬡</div>
          <span className="canvas-empty-text">Import a flow or add nodes to get started</span>
        </div>
      ) : (
        <>
          {/* Panned/zoomed content */}
          <div style={{
            position: "absolute", top: 0, left: 0,
            transformOrigin: "0 0",
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transition: dragging ? "none" : "transform 0.05s ease-out",
          }}>
            <div ref={svgContainerRef} style={{ padding: 16 }} />
          </div>

          {/* ── Bottom-left: ghost toggle ── */}
          <div style={{
            position: "absolute", bottom: 12, left: 12,
            display: "flex", alignItems: "center", gap: 6,
            zIndex: 5,
          }}>
            <button
              className="btn btn-ghost"
              onClick={(e) => { e.stopPropagation(); setShowGhosts((v) => !v); }}
              title={showGhosts ? "Hide missing-node references" : "Show missing-node references"}
              style={{
                height: 26, padding: "0 10px", fontSize: 11,
                fontFamily: "'IBM Plex Mono', monospace",
                borderColor: showGhosts ? "var(--red)" : ghostCount > 0 ? "rgba(192,96,112,0.5)" : "var(--border)",
                color: showGhosts ? "var(--red)" : ghostCount > 0 ? "#c06070" : "var(--text-3)",
                background: showGhosts ? "rgba(122,48,64,0.18)" : "transparent",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              {/* Ghost icon */}
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M6 1a4 4 0 00-4 4v5l1.5-1.5L5 10l1.5-1.5L8 10l1.5-1.5L11 10V5a4 4 0 00-4-4z"
                  stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <circle cx="4.2" cy="5.5" r="0.7" fill="currentColor" />
                <circle cx="7.8" cy="5.5" r="0.7" fill="currentColor" />
              </svg>
              {showGhosts ? "Hide" : "Show"} missing
              {ghostCount > 0 && (
                <span style={{
                  background: showGhosts ? "rgba(192,96,112,0.3)" : "rgba(192,96,112,0.2)",
                  borderRadius: 10, padding: "0 5px", fontSize: 10, fontWeight: 600,
                  color: showGhosts ? "#f0a0b0" : "#c06070",
                  minWidth: 16, textAlign: "center",
                }}>
                  {ghostCount}
                </span>
              )}
            </button>

            {/* Ghost detail popover — shown when ghosts are visible */}
            {showGhosts && ghostCount > 0 && (
              <GhostPopover ghostRefs={ghostRefs} />
            )}
          </div>

          {/* ── Bottom-right: zoom controls ── */}
          <div style={{
            position: "absolute", bottom: 12, right: 12,
            display: "flex", flexDirection: "column", gap: 2,
            zIndex: 5,
          }}>
            <button className="btn btn-ghost"
              style={{ width: 28, height: 28, padding: 0, justifyContent: "center", fontSize: 16 }}
              onClick={(e) => { e.stopPropagation(); setScale((s) => Math.min(ZOOM_MAX, s + ZOOM_STEP)); }}
              title="Zoom in">+</button>
            <button className="btn btn-ghost"
              style={{
                width: 28, height: 28, padding: 0, justifyContent: "center", fontSize: 11,
                fontFamily: "'IBM Plex Mono', monospace", color: "var(--text-2)"
              }}
              onClick={(e) => { e.stopPropagation(); fitToView(); }}
              title="Fit to view">{Math.round(scale * 100)}%</button>
            <button className="btn btn-ghost"
              style={{ width: 28, height: 28, padding: 0, justifyContent: "center", fontSize: 16 }}
              onClick={(e) => { e.stopPropagation(); setScale((s) => Math.max(ZOOM_MIN, s - ZOOM_STEP)); }}
              title="Zoom out">−</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Ghost detail popover ─────────────────────────────────────────────────────
import type { GhostRef } from "../utils/mermaidBuilder";

function GhostPopover({ ghostRefs }: { ghostRefs: GhostRef[] }) {
  // Group by targetId so each missing step is listed once with all its inbound refs
  const byTarget = new Map<string, GhostRef[]>();
  for (const ref of ghostRefs) {
    const list = byTarget.get(ref.targetId) ?? [];
    list.push(ref);
    byTarget.set(ref.targetId, list);
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: "var(--bg-2)", border: "1px solid rgba(122,48,64,0.5)",
        borderRadius: "var(--radius-lg)", padding: "10px 12px",
        maxWidth: 340, maxHeight: 260, overflowY: "auto",
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        fontFamily: "'IBM Plex Mono', monospace",
        // Anchor above the button row
        position: "absolute", bottom: 34, left: 0,
      }}
    >
      <div style={{
        fontSize: 9, fontWeight: 600, letterSpacing: "0.12em",
        color: "#c06070", textTransform: "uppercase", marginBottom: 8,
      }}>
        Missing targets — {byTarget.size} unique step{byTarget.size !== 1 ? "s" : ""}
      </div>

      {Array.from(byTarget.entries()).map(([targetId, refs]) => (
        <div key={targetId} style={{
          marginBottom: 8, paddingBottom: 8,
          borderBottom: "1px solid rgba(122,48,64,0.2)",
        }}>
          {/* Missing target ID */}
          <div style={{
            fontSize: 11, color: "#f0a0b0", fontWeight: 600, marginBottom: 3,
            wordBreak: "break-all",
          }}>
            ⚠ {targetId}
          </div>
          {/* Each node that references it */}
          {refs.map((r, i) => (
            <div key={i} style={{ fontSize: 10, color: "var(--text-3)", paddingLeft: 8 }}>
              ← <span style={{ color: "var(--text-2)" }}>{r.fromId}</span>
              {" "}<span style={{ color: "var(--text-3)" }}>via</span>
              {" "}<span style={{ color: "#e8955a" }}>{r.via}</span>
            </div>
          ))}
        </div>
      ))}

      <div style={{ fontSize: 9, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5 }}>
        These step IDs are referenced but not present in the IR.
        They may be unexported CXone steps or conversion gaps.
      </div>
    </div>
  );
}