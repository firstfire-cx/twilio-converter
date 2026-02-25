// src/utils/csv.ts
// src/utils/csv.ts
import Papa from "papaparse";
import type { IR, IVRNode, IVRContent, SayText } from "../types";

const ATOMIC_TYPES = new Set<string>([
  "START",
  "PLAY",
  "GATHER",
  "CHECK",
  "SET",
  "TRANSFER",
  "HANGUP",
  "HOURS",
  "WAIT",
]);

// ─── MENU expansion ───────────────────────────────────────────────────────────
/**
 * Expand a single editor MENU node into fully-atomic nodes.
 *
 * Mirrors the converter's expandMenu() logic so both code paths produce
 * identical output. MENU content fields:
 *   variable    — variable name to store the digit (e.g. "KPCOMenu_RES")
 *   num_digits  — max digits to collect (default "1")
 *   timeout     — seconds to wait for input (default "5")
 *   text        — SayText prompt
 *   max_retries — how many times to retry on invalid/no input (default 3)
 *   retry_text  — SayText played on invalid input
 *   invalid_exit — step_id to go to after max retries (default: flow's END sentinel)
 *   branches    — digit → step_id mapping (e.g. { "1": "step_a", "2": "step_b" })
 *
 * Expansion (with retries):
 *   {id}_reset      SET    variable=null, counterVar=0
 *   {id}_gather     GATHER play prompt, collect digit → default_next {id}_check
 *   {id}_check      CHECK  var mode: digit→target, null→{id}_incr
 *   {id}_incr       SET    counterVar++  → {id}_limit
 *   {id}_limit      CHECK  counterVar < max_retries → {id}_retry_play : invalid_exit
 *   {id}_retry_play PLAY   retry_text  → {id}_gather
 *
 * Expansion (no retries / max_retries === 0):
 *   {id}_reset      SET    variable=null
 *   {id}_gather     GATHER play prompt, collect digit → default_next {id}_check
 *   {id}_check      CHECK  var mode: digit→target, null→invalid_exit
 */
export function expandMenuNode(node: IVRNode, flow_id: string): IVRNode[] {
  const id = node.step_id;
  const c = node.content ?? {};
  const variable = (c.variable ?? c.var ?? "menu_var") as string;
  const num_digits = String(c.num_digits ?? "1");
  const timeout = String(c.timeout ?? "5");
  const text = c.text as SayText | undefined;
  const maxRetries = typeof c.max_retries === "number" ? c.max_retries : 3;
  const invalidExit: string = (c.invalid_exit as string | undefined) ?? "END";
  const digitBranches: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.branches ?? {})) {
    if (k !== "" && k != null) digitBranches[k] = v as string;
  }

  const counterVar = `MenuLoop_${id}`;

  const node_ = (
    step_id: string,
    action_type: string,
    content: IVRContent,
    default_next?: string,
  ): IVRNode => ({
    step_id,
    action_type: action_type as IVRNode["action_type"],
    label: `${node.label}: ${step_id.slice(id.length + 1)}`,
    content,
    flow_id,
    default_next,
  });

  const resetId = `${id}_reset`;
  const gatherId = `${id}_gather`;
  const checkId = `${id}_check`;

  if (maxRetries === 0) {
    // Simple: no retry loop — on null go straight to invalid_exit
    return [
      node_(
        resetId,
        "SET",
        { assignments: { [variable]: null as any }, branches: {} },
        gatherId,
      ),
      node_(
        gatherId,
        "GATHER",
        { text, variable, num_digits, timeout, branches: {} },
        checkId,
      ),
      node_(checkId, "CHECK", {
        var: variable,
        branches: { ...digitBranches, null: invalidExit },
      }),
    ];
  }

  // Full retry loop
  const incrId = `${id}_incr`;
  const limitId = `${id}_limit`;
  const retryPlayId = `${id}_retry_play`;

  const retryText: SayText = (c.retry_text as SayText | undefined) ?? {
    eng: "I'm sorry, that was not a valid option. Please try again.",
    spa: "Lo sentimos, esa opción no es válida. Por favor, intente de nuevo.",
  };

  return [
    node_(
      resetId,
      "SET",
      {
        assignments: { [variable]: null as any, [counterVar]: 0 as any },
        branches: {},
      },
      gatherId,
    ),
    node_(
      gatherId,
      "GATHER",
      { text, variable, num_digits, timeout, branches: {} },
      checkId,
    ),
    node_(checkId, "CHECK", {
      var: variable,
      branches: { ...digitBranches, null: incrId },
    }),
    node_(
      incrId,
      "SET",
      { assignments: { [counterVar]: `${counterVar}++` }, branches: {} },
      limitId,
    ),
    node_(limitId, "CHECK", {
      expression: `${counterVar} < ${maxRetries}`,
      branches: { True: retryPlayId, False: invalidExit },
    }),
    node_(retryPlayId, "PLAY", { text: retryText, branches: {} }, gatherId),
  ];
}

/**
 * Expand all MENU nodes in an IR into atomics.
 * Returns a new nodes map with MENU nodes replaced by their expanded equivalents.
 */
export function expandAllMenus(ir: IR): Record<string, IVRNode> {
  const out: Record<string, IVRNode> = {};
  for (const node of Object.values(ir.nodes)) {
    if (node.action_type === "MENU") {
      for (const expanded of expandMenuNode(node, ir.flow_id)) {
        out[expanded.step_id] = expanded;
      }
    } else {
      out[node.step_id] = node;
    }
  }
  return out;
}

// ─── Optimization: Merge sequential SET blocks ────────────────────────────────

/**
 * Merge consecutive SET nodes that have no branches and only one exit.
 * This reduces the number of steps and makes flows cleaner.
 *
 * Example:
 *   SET x=1 → SET y=2 → SET z=3 → PLAY
 * Becomes:
 *   SET x=1, y=2, z=3 → PLAY
 */
function mergeSequentialSets(
  nodes: Record<string, IVRNode>,
): Record<string, IVRNode> {
  const out: Record<string, IVRNode> = { ...nodes };
  const merged = new Set<string>();

  for (const node of Object.values(nodes)) {
    if (node.action_type !== "SET" || merged.has(node.step_id)) continue;
    if (
      !node.default_next ||
      Object.keys(node.content?.branches || {}).length > 0
    )
      continue;

    // Collect sequential SETs
    const chain: IVRNode[] = [node];
    let current = node;

    while (current.default_next && nodes[current.default_next]) {
      const next = nodes[current.default_next];
      if (next.action_type !== "SET") break;
      if (Object.keys(next.content?.branches || {}).length > 0) break;
      chain.push(next);
      current = next;
    }

    // Merge if we found multiple SETs in a row
    if (chain.length > 1) {
      const mergedAssignments: Record<string, any> = {};
      for (const n of chain) {
        Object.assign(mergedAssignments, n.content?.assignments || {});
        if (n !== node) merged.add(n.step_id);
      }

      out[node.step_id] = {
        ...node,
        content: {
          ...node.content,
          assignments: mergedAssignments,
        },
        default_next: current.default_next,
      };

      // Remove merged nodes
      for (const n of chain.slice(1)) {
        delete out[n.step_id];
      }
    }
  }

  return out;
}

// ─── Optimization: Merge sequential CHECK blocks ──────────────────────────────

/**
 * Merge consecutive CHECK nodes with no branches into switch statements.
 * This is useful when multiple checks are chained together.
 *
 * Note: Only merges expression-based CHECKs, not var-mode CHECKs.
 */
function mergeSequentialChecks(
  nodes: Record<string, IVRNode>,
): Record<string, IVRNode> {
  const out: Record<string, IVRNode> = { ...nodes };
  const merged = new Set<string>();

  for (const node of Object.values(nodes)) {
    if (node.action_type !== "CHECK" || merged.has(node.step_id)) continue;
    if (!node.content?.expression) continue; // Only merge expression-based checks
    if (!node.content.branches?.False) continue; // Must have False branch

    // Collect sequential CHECKs
    const chain: IVRNode[] = [node];
    let current = node;

    while (
      current.content?.branches?.False &&
      nodes[current.content.branches.False]
    ) {
      const next = nodes[current.content.branches.False];
      if (next.action_type !== "CHECK" || !next.content?.expression) break;
      if (!next.content.branches?.False) break;
      chain.push(next);
      current = next;
    }

    // Merge if we found multiple CHECKs in a row (2+ is worth merging)
    if (chain.length >= 2) {
      // Create switch-style branches
      const branches: Record<string, string> = {};
      for (let i = 0; i < chain.length; i++) {
        const n = chain[i];
        const trueTarget = n.content?.branches?.True;
        if (trueTarget) {
          branches[`case_${i}`] = trueTarget;
        }
        if (i > 0) merged.add(n.step_id);
      }

      // Add final false target
      const finalFalse = chain[chain.length - 1].content?.branches?.False;
      if (finalFalse) {
        branches["default"] = finalFalse;
      }

      // Create merged switch-style CHECK
      out[node.step_id] = {
        ...node,
        label: `${node.label} (merged ${chain.length} checks)`,
        content: {
          ...node.content,
          branches,
          _switch_cases: chain.map((n) => n.content?.expression || ""),
        },
      };

      // Remove merged nodes
      for (const n of chain.slice(1)) {
        delete out[n.step_id];
      }
    }
  }

  return out;
}

// ─── Combined optimization ─────────────────────────────────────────────────────

/**
 * Apply all optimization passes to an IR.
 * This should be called after expandAllMenus and before export.
 */
export function optimizeIR(ir: IR): Record<string, IVRNode> {
  let nodes = expandAllMenus(ir);
  nodes = mergeSequentialSets(nodes);
  nodes = mergeSequentialChecks(nodes);
  return nodes;
}

// ─── CSV export / import ──────────────────────────────────────────────────────

export function exportCSV(ir: IR): string {
  const rows: Record<string, string>[] = [];
  // Optimize: expand MENUs, merge sequential SETs and CHECKs
  const nodes = optimizeIR(ir);

  for (const n of Object.values(nodes)) {
    if (!ATOMIC_TYPES.has(n.action_type)) {
      console.warn(
        `[exportCSV] Skipping non-atomic node ${n.step_id} (${n.action_type})`,
      );
      continue;
    }
    rows.push({
      flow_id: ir.flow_id,
      step_id: n.step_id,
      action_type: n.action_type,
      label: n.label,
      content: JSON.stringify(n.content ?? {}),
      default_next: n.default_next || "",
    });
  }

  return Papa.unparse(rows);
}

export function importCSV(csv: string): IR {
  const result = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const nodes: Record<string, IVRNode> = {};

  (result.data as any[]).forEach((row) => {
    if (!row.step_id) return;

    let content: IVRContent = {};
    try {
      const parsed = JSON.parse(row.content || "{}");
      content = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      // Leave content empty if unparseable
    }

    nodes[row.step_id] = {
      step_id: row.step_id,
      action_type: row.action_type,
      label: row.label || row.step_id,
      content,
      default_next: row.default_next || undefined,
      flow_id: row.flow_id || undefined,
    };
  });

  const flow_id = (result.data as any[])[0]?.flow_id || "flow";
  // Try to derive start_step from a START node, fall back to first row
  const startNode = Object.values(nodes).find((n) => n.action_type === "START");
  const start_step = startNode?.step_id ?? Object.keys(nodes)[0];

  return { flow_id, nodes, start_step };
}
