// src/utils/mermaidBuilder.ts
import type { IR, IVRNode } from "../types";

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

/**
 * Sort branch entries by the horizontal position of their target node so that
 * edges are emitted left-to-right matching the layout order. This is topology-
 * aware and avoids crossings regardless of what the branch labels are called —
 * fixing cases where a fixed "True before False" order would itself cause a
 * crossing because the layout placed False's target to the left.
 *
 * For targets with no known position (ghost refs, targets in a later level not
 * yet ranked), fall back to alphabetical label order as a stable tiebreaker.
 */
function sortBranchEntriesByTargetPosition(
  entries: [string, string][],
  horizontalOrder: Map<string, number>,
): [string, string][] {
  return [...entries].sort(([labelA, targetA], [labelB, targetB]) => {
    const posA = horizontalOrder.get(targetA) ?? Infinity;
    const posB = horizontalOrder.get(targetB) ?? Infinity;
    if (posA !== posB) return posA - posB;
    return labelA.localeCompare(labelB);
  });
}

/**
 * Compute a topological ordering of nodes and a level map.
 *
 * Strategy:
 * 1. Build an adjacency list from branches and default_next pointers.
 * 2. Perform a topological sort (Kahn's algorithm) to get rank levels.
 * 3. Within each rank level, order nodes by the average position of their
 *    connected predecessors (barycenter heuristic) to reduce crossings.
 *
 * Returns both the ordered node array and a Map<nodeId, levelIndex> used
 * by buildMermaid to detect long-range edges and insert relay nodes.
 */
export function orderNodes(ir: IR): {
  nodes: IVRNode[];
  levelMap: Map<string, number>;
  horizontalOrder: Map<string, number>;
} {
  const nodeMap = ir.nodes;
  const nodeIds = Object.keys(nodeMap);
  const nodeSet = new Set(nodeIds);

  if (nodeIds.length === 0) return { nodes: [], levelMap: new Map(), horizontalOrder: new Map() };

  // Build adjacency: for each node, what nodes does it point to?
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of nodeIds) {
    successors.set(id, []);
    predecessors.set(id, []);
    inDegree.set(id, 0);
  }

  for (const [id, node] of Object.entries(nodeMap)) {
    const targets = new Set<string>();

    for (const target of Object.values(node.content?.branches ?? {})) {
      if (target && nodeSet.has(target)) targets.add(target);
    }
    if (node.default_next && nodeSet.has(node.default_next)) {
      targets.add(node.default_next);
    }

    for (const target of targets) {
      successors.get(id)!.push(target);
      predecessors.get(target)!.push(id);
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  // Kahn's algorithm with level assignment
  const levels: string[][] = [];
  const visited = new Set<string>();

  let currentLevel = nodeIds
    .filter(id => inDegree.get(id) === 0)
    .map(id => { visited.add(id); return id; });

  while (currentLevel.length > 0) {
    const orderedLevel = orderLevelByBarycenter(currentLevel, levels, predecessors);
    levels.push(orderedLevel);

    const nextLevel: string[] = [];
    const nextInDegree = new Map<string, number>();

    for (const id of orderedLevel) {
      for (const succ of successors.get(id) ?? []) {
        const newDeg = (inDegree.get(succ) ?? 0) - 1;
        nextInDegree.set(succ, newDeg);
        if (newDeg === 0 && !visited.has(succ)) {
          visited.add(succ);
          nextLevel.push(succ);
        }
      }
    }

    for (const [id, deg] of nextInDegree) inDegree.set(id, deg);

    currentLevel = nextLevel;

    if (visited.size >= nodeIds.length) break;
    if (currentLevel.length === 0 && visited.size < nodeIds.length) {
      const remaining = nodeIds.filter(id => !visited.has(id));
      currentLevel = remaining;
      remaining.forEach(id => visited.add(id));
    }
  }

  // Build level map and horizontal order (position within each level)
  const levelMap = new Map<string, number>();
  const horizontalOrder = new Map<string, number>();
  for (let l = 0; l < levels.length; l++) {
    for (let i = 0; i < levels[l].length; i++) {
      levelMap.set(levels[l][i], l);
      horizontalOrder.set(levels[l][i], i);
    }
  }

  // Flatten levels into final order
  const nodes: IVRNode[] = [];
  for (const level of levels) {
    for (const id of level) nodes.push(nodeMap[id]);
  }

  return { nodes, levelMap, horizontalOrder };
}

/**
 * Order nodes within a level using the barycenter heuristic.
 */
function orderLevelByBarycenter(
  level: string[],
  previousLevels: string[][],
  predecessors: Map<string, string[]>
): string[] {
  if (level.length <= 1) return level;

  const position = new Map<string, number>();
  for (let l = 0; l < previousLevels.length; l++) {
    for (let i = 0; i < previousLevels[l].length; i++) {
      position.set(previousLevels[l][i], l * 10000 + i);
    }
  }

  const barycenters = level.map(id => {
    const preds = predecessors.get(id) ?? [];
    const relevantPreds = preds.filter(p => position.has(p));
    if (relevantPreds.length === 0) return { id, avg: Infinity };
    const avg = relevantPreds.reduce((sum, p) => sum + (position.get(p) ?? 0), 0) / relevantPreds.length;
    return { id, avg };
  });

  barycenters.sort((a, b) => {
    if (a.avg === Infinity && b.avg === Infinity) return 0;
    if (a.avg === Infinity) return 1;
    if (b.avg === Infinity) return -1;
    return a.avg - b.avg;
  });

  return barycenters.map(bc => bc.id);
}

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

/**
 * Edges spanning more than this many levels get an invisible relay node
 * inserted mid-way so the layout engine doesn't have to route them across
 * the whole diagram and distort everything in between.
 */
const RELAY_THRESHOLD = 3;

export function buildMermaid(
  ir: IR,
  selectedId?: string | null,
  showGhosts = false,
): string {
  const { nodes, levelMap, horizontalOrder } = orderNodes(ir);

  // ELK produces far better layouts than the default Dagre for graphs with
  // many cross-level edges and fan-out/fan-in patterns.
  let m = `%%{init: {"flowchart": {"defaultRenderer": "elk"}}}%%\n`;
  m += "flowchart TD\n";

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
  // Invisible relay nodes used to break up long-range edges
  m += "classDef relay      fill:none,stroke:none,color:none;\n";
  // Exit stub: replaces a long edge to a terminal (HANGUP) with a small inline node,
  // keeping the edge local and eliminating long diagonals that cause crossings.
  m += "classDef exit_stub  fill:#1e0f0f,stroke:#e05a5a,stroke-width:1px,stroke-dasharray:3 2,color:#f0a0a0;\n";

  const sanitize = (s: string) =>
    s.replace(/"/g, "'").replace(/[<>]/g, "").replace(/\n/g, " ").trim();

  const ghostNodeId = (id: string) =>
    "ghost_" + id.replace(/[^A-Za-z0-9_]/g, "_");

  const startStep = ir.start_step;

  const isDeadEnd = (node: IVRNode): boolean => {
    if (node.action_type === "HANGUP") return false;
    const hasRealBranch = Object.values(node.content?.branches ?? {}).some(t => t && ir.nodes[t]);
    const hasRealNext = !!node.default_next && !!ir.nodes[node.default_next];
    return !hasRealBranch && !hasRealNext;
  };

  // Relay / stub node counters — each gets a unique id
  let relaySeq = 0;
  let stubSeq  = 0;

  /**
   * Emit a directed edge, inserting an invisible relay node if the two
   * endpoints are more than RELAY_THRESHOLD levels apart. This prevents the
   * layout engine from having to route the edge across the entire height of
   * the diagram, which is the main cause of crossing lines and blown-out spacing.
   */
  const emitEdge = (
    fromNid: string,
    toNid: string,
    label: string,
    dashed = false,
  ) => {
    const edgeLabel = label ? `|"${sanitize(label)}"|` : "";

    if (dashed) {
      m += `${fromNid} -.${edgeLabel}.-> ${toNid}\n`;
      return;
    }

    const fromId = fromNid.slice(2); // strip "n_"
    const toId   = toNid.slice(2);
    const fromLevel = levelMap.get(fromId) ?? 0;
    const toLevel   = levelMap.get(toId)   ?? 0;
    const dist = Math.abs(toLevel - fromLevel);

    if (dist > RELAY_THRESHOLD) {
      // Insert one invisible waypoint node so the router treats this as two
      // short hops instead of one long diagonal.
      const relayId = `relay_${relaySeq++}`;
      m += `${relayId}[ ]:::relay\n`;
      m += `${fromNid} -->${edgeLabel} ${relayId}\n`;
      m += `${relayId} --> ${toNid}\n`;
    } else {
      m += `${fromNid} -->${edgeLabel} ${toNid}\n`;
    }
  };

  // ── Real nodes + edges ──────────────────────────────────────────────────
  for (const node of nodes) {
    const nid = `n_${node.step_id}`;
    const isSelected = node.step_id === selectedId;
    const isStart    = node.step_id === startStep;
    const isHangup   = node.action_type === "HANGUP";
    const deadEnd    = isDeadEnd(node);

    const topLine = sanitize(node.step_id);
    const midLine = isHangup ? "✕ HANGUP" : node.action_type;
    const botLine = isHangup ? "" : sanitize(node.label || node.step_id).slice(0, 40);
    const startPrefix = isStart  ? "▶ " : "";
    const deadPrefix  = deadEnd  ? "⚠ " : "";
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
      ? `${nid}(["${labelHtml}"]):::at_HANGUP\n`
      : `${nid}["${labelHtml}"]${styleClass}\n`;

    // ── Collect outgoing edges ──────────────────────────────────────────
    // Deduplicate by target (first wins — labeled branch beats bare default_next).
    // For edges pointing at HANGUP nodes that are many levels away, emit a small
    // exit-stub terminal node instead of a long diagonal edge — the stub sits
    // adjacent to the source and the long edge disappears entirely, eliminating
    // the class of crossings caused by HANGUP edges skipping across the diagram.
    const seenTargets = new Set<string>();

    const addEdge = (target: string, label: string) => {
      if (!target || seenTargets.has(target)) return;
      seenTargets.add(target);

      if (!ir.nodes[target]) {
        if (showGhosts) {
          const edgeLabel = label ? `|"${sanitize(label)}"|` : "";
          m += `${nid} -.${edgeLabel}.-> ${ghostNodeId(target)}\n`;
        }
        return;
      }

      const targetNode = ir.nodes[target];
      const fromLevel  = levelMap.get(node.step_id) ?? 0;
      const toLevel    = levelMap.get(target) ?? 0;
      const dist       = Math.abs(toLevel - fromLevel);

      // Replace long HANGUP edges with an inline exit stub so the layout engine
      // never has to route a diagonal across the whole diagram.
      if (targetNode.action_type === "HANGUP" && dist > RELAY_THRESHOLD) {
        const edgeLabelText = label ? ` ${sanitize(label)}` : "";
        const stubId = `stub_${stubSeq++}`;
        m += `${stubId}(["✕ HANGUP${edgeLabelText}"]):::exit_stub\n`;
        m += `${nid} --> ${stubId}\n`;
        return;
      }

      emitEdge(nid, `n_${target}`, label);
    };

    const branchEntries = sortBranchEntriesByTargetPosition(
      Object.entries(node.content?.branches ?? {}) as [string, string][],
      horizontalOrder,
    );
    for (const [branchLabel, target] of branchEntries) {
      addEdge(target, branchLabel);
    }
    if (node.default_next) {
      addEdge(node.default_next, "");
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