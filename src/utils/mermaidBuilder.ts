// src/utils/mermaidBuilder.ts
import type { IR } from "../types";

const ACTION_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  PLAY:     { fill: "#1a2e1a", stroke: "#3dba7e", text: "#a8e6bc" },
  GATHER:   { fill: "#1a2240", stroke: "#3d8ef0", text: "#9dc4f8" },
  CHECK:    { fill: "#2a1f0f", stroke: "#e8955a", text: "#f5c08a" },
  TRANSFER: { fill: "#22112a", stroke: "#9b7fe8", text: "#c8b0f5" },
  HANGUP:   { fill: "#2a1111", stroke: "#e05a5a", text: "#f0a0a0" },
  SET:      { fill: "#0f2229", stroke: "#4cc9c9", text: "#8ee8e8" },
  HOURS:    { fill: "#1f1f0a", stroke: "#cccc44", text: "#e8e880" },
  WAIT:     { fill: "#1a1a20", stroke: "#888",    text: "#bbb"    },
  START:    { fill: "#0a1a2a", stroke: "#3dba7e", text: "#7de8b0" },
  // Editor-only composite — distinct dashed style handled in classDef
  MENU:     { fill: "#131e30", stroke: "#3d8ef0", text: "#7aaad0" },
};

export interface GhostRef {
  fromId: string;
  via: string;
  targetId: string;
}

/** Collect every branch/default_next pointer that targets a non-existent node. */
export function collectGhostRefs(ir: IR): GhostRef[] {
  const refs: GhostRef[] = [];
  for (const node of Object.values(ir.nodes)) {
    for (const [label, target] of Object.entries(node.content?.branches ?? {})) {
      if (target && !ir.nodes[target]) {
        refs.push({ fromId: node.step_id, via: label, targetId: target });
      }
    }
    if (node.default_next && !ir.nodes[node.default_next]) {
      refs.push({ fromId: node.step_id, via: "default_next", targetId: node.default_next });
    }
  }
  return refs;
}

export function buildMermaid(
  ir: IR,
  selectedId?: string | null,
  showGhosts = false,
): string {
  const nodes = Object.values(ir.nodes);
  let m = "flowchart TD\n";

  // ClassDefs for each action type
  for (const [type, c] of Object.entries(ACTION_COLORS)) {
    if (type === "MENU") {
      m += `classDef at_MENU fill:${c.fill},stroke:${c.stroke},color:${c.text},stroke-width:1.5px,stroke-dasharray:5 3;\n`;
    } else {
      m += `classDef at_${type} fill:${c.fill},stroke:${c.stroke},color:${c.text},stroke-width:1.5px;\n`;
    }
  }
  m += "classDef selected   fill:#0e3a6e,stroke:#4fc1ff,stroke-width:3px,color:#e0f0ff;\n";
  m += "classDef start_node fill:#0a1f0f,stroke:#3dba7e,stroke-width:2.5px,color:#7de8b0,stroke-dasharray:4 2;\n";
  m += "classDef ghost      fill:#1a1014,stroke:#7a3040,stroke-width:1.5px,color:#c06070,stroke-dasharray:6 3;\n";
  m += "classDef dead_end   fill:#1f1008,stroke:#c08030,stroke-width:2px,color:#e8b060,stroke-dasharray:3 2;\n";
  m += "classDef default    fill:#1e1e22,stroke:#444,color:#ccc,stroke-width:1px;\n";

  const sanitize = (s: string) =>
    s.replace(/"/g, "'").replace(/[<>]/g, "").replace(/\n/g, " ").trim();

  const ghostNodeId = (id: string) =>
    "ghost_" + id.replace(/[^A-Za-z0-9_]/g, "_");

  const startStep = ir.start_step;

  // Pre-compute which nodes are dead-ends (no outgoing edges to existing nodes)
  const isDeadEnd = (node: ReturnType<typeof Object.values<typeof ir.nodes>>[number]): boolean => {
    if (node.action_type === "HANGUP") return false; // HANGUP is intentional terminal
    const hasRealBranch = Object.values(node.content?.branches ?? {}).some(t => t && ir.nodes[t]);
    const hasRealNext = !!node.default_next && !!ir.nodes[node.default_next];
    return !hasRealBranch && !hasRealNext;
  };

  // ── Real nodes + edges ──────────────────────────────────────────────────
  for (const node of nodes) {
    const nid = `n_${node.step_id}`;
    const isSelected = node.step_id === selectedId;
    const isStart = node.step_id === startStep;
    const isHangup = node.action_type === "HANGUP";
    const deadEnd = isDeadEnd(node);

    // HANGUP: compact label — just the ✕ symbol and type
    const topLine = sanitize(node.step_id);
    const midLine = isHangup ? "✕ HANGUP" : node.action_type;
    const botLine = isHangup ? "" : sanitize(node.label || node.step_id).slice(0, 40);
    const startPrefix = isStart ? "▶ " : "";
    const deadPrefix = deadEnd ? "⚠ " : "";
    const labelHtml = isHangup
      ? `<b>${midLine}</b>`
      : `<small>${startPrefix}${deadPrefix}${topLine}</small><br/><b>${midLine}</b><br/>${botLine}`;

    const styleClass = isSelected
      ? ":::selected"
      : isStart
        ? ":::start_node"
        : deadEnd
          ? ":::dead_end"
          : ACTION_COLORS[node.action_type]
            ? `:::at_${node.action_type}`
            : ":::default";

    m += isHangup
      ? `${nid}(["${labelHtml}"])${ACTION_COLORS.HANGUP ? `:::at_HANGUP` : ":::default"}\n`
      : `${nid}["${labelHtml}"]${styleClass}\n`;

    const branches = node.content?.branches ?? {};

    for (const [branchLabel, target] of Object.entries(branches)) {
      if (!target) continue;
      if (ir.nodes[target]) {
        const edgeLabel = branchLabel ? `|"${sanitize(branchLabel)}"|` : "";
        m += `${nid} -->${edgeLabel} n_${target}\n`;
      } else if (showGhosts) {
        const edgeLabel = branchLabel ? `|"${sanitize(branchLabel)}"|` : "";
        m += `${nid} -.${edgeLabel}.-> ${ghostNodeId(target)}\n`;
      }
    }

    if (node.default_next) {
      if (ir.nodes[node.default_next] && !branches["default"]) {
        m += `${nid} --> n_${node.default_next}\n`;
      } else if (!ir.nodes[node.default_next] && showGhosts) {
        m += `${nid} -.-> ${ghostNodeId(node.default_next)}\n`;
      }
    }
  }

  // ── Ghost nodes ─────────────────────────────────────────────────────────
  if (showGhosts) {
    const ghostIds = new Set<string>();
    for (const node of nodes) {
      for (const target of Object.values(node.content?.branches ?? {})) {
        if (target && !ir.nodes[target]) ghostIds.add(target);
      }
      if (node.default_next && !ir.nodes[node.default_next]) {
        ghostIds.add(node.default_next);
      }
    }
    for (const gid of ghostIds) {
      const displayId =
        gid.length > 30 ? `${gid.slice(0, 12)}…${gid.slice(-14)}` : gid;
      m += `${ghostNodeId(gid)}["<small>⚠ missing</small><br/>${sanitize(displayId)}"]:::ghost\n`;
    }
  }

  return m;
}
