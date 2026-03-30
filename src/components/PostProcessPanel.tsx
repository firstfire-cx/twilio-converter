// src/components/PostProcessPanel.tsx
//
// Manual post-processing passes for imported CXone flows.
// Each pass is triggered individually so the user can inspect diffs
// before committing to the next transformation.

import { useState } from "react";
import type { IR } from "../types";
import {
  applyDeferLangDefault,
  applyP1RemoveBlockCall,
  applyP2NormaliseLang,
  applyP3SwapLangMenu,
  applyP4RemoveRedundantNull,
  applyP5MergeSequentialSets,
  applyP6NormalisePolyHandoff,
  applyP7CollapseExprChains,
  applyP7bConvertExprChains,
  applyP8NullToDefaultNext,
  applyP9RemoveUnreachable,
  applyP10AutoRename,
  applyAllPostProcessing,
} from "../converter/convertCXJson";

// ─── Types ───────────────────────────────────────────────────────────────────

type PassStatus = "idle" | "applied" | "no-change";

interface PassState {
  status: PassStatus;
  log: string[];
  nodesBefore: number;
  nodesAfter: number;
}

const EMPTY_PASS: PassState = {
  status: "idle",
  log: [],
  nodesBefore: 0,
  nodesAfter: 0,
};

interface PassDef {
  id: string;
  label: string;
  badge: string;
  badgeColor: string;
  description: string;
  apply: (ir: IR) => { ir: IR; log: string[] };
}

const PASSES: PassDef[] = [
  {
    id: "defer-lang",
    label: "Defer Lang Default",
    badge: "P0",
    badgeColor: "var(--cyan)",
    description:
      "Bypasses upfront SET Lang=eng nodes so Lang is only assigned after the caller explicitly selects a language. Callers who time out get bilingual prompts.",
    apply: applyDeferLangDefault,
  },
  {
    id: "p1-block-call",
    label: "Remove BlockCall Check",
    badge: "P1",
    badgeColor: "var(--red)",
    description:
      'Removes CHECK nodes whose expression is "BlockCall == 1" (always false in live flows). Rewires predecessors to the False branch and prunes the unreachable True subtree.',
    apply: applyP1RemoveBlockCall,
  },
  {
    id: "p2-lang-assign",
    label: "Normalise Lang Assignments",
    badge: "P2",
    badgeColor: "var(--accent)",
    description:
      'Rewrites SET Lang values to ISO 639-2 engine convention using LANG_CODE_MAP: "EN"→"eng", "SP"/"ES"→"spa", "FR"→"fra", etc. Also strips surrounding quotes that CXone sometimes emits.',
    apply: applyP2NormaliseLang,
  },
  {
    id: "p3-swap-lang",
    label: "English-First Lang Menu",
    badge: "P3",
    badgeColor: "var(--green)",
    description:
      'Swaps lang-select CHECK branches so key "1" maps to English and "2" to Spanish. Only fires when key 1 currently points directly to a SET Lang=spa node. (English/Spanish convention — other languages are unaffected.)',
    apply: applyP3SwapLangMenu,
  },
  {
    id: "p4-null-branch",
    label: "Remove Redundant Null Branches",
    badge: "P4",
    badgeColor: "var(--orange)",
    description:
      "Drops CHECK branches whose target is empty, and removes null branches that duplicate default_next. Leaves intentional null branches (var-mode timeout handling) untouched.",
    apply: applyP4RemoveRedundantNull,
  },
  {
    id: "p5-merge-sets",
    label: "Merge Sequential SETs",
    badge: "P5",
    badgeColor: "var(--purple)",
    description:
      "Collapses consecutive SET nodes with a single inbound edge and no branches into one combined SET. Also strips CXone inline comments (// …) from assignment values.",
    apply: applyP5MergeSequentialSets,
  },
  {
    id: "p6-poly-handoff",
    label: "Normalise PolyAI Handoff",
    badge: "P6",
    badgeColor: "#e8955a",
    description:
      "Replaces the old PolyReason/PolyNote chain after a SIP TRANSFER with the correct engine pattern: SET Handoff → CHECK Handoff == \"Yes\" → True: SET HandoffReason + REQAGENT / False: HANGUP.",
    apply: applyP6NormalisePolyHandoff,
  },
  {
    id: "p7-collapse-expr-chains",
    label: "Collapse Menu Expr Chains",
    badge: "P7",
    badgeColor: "var(--text-2)",
    description:
      "When a var-mode CHECK branches into a chain of expression CHECKs testing the same variable, inlines the correct True-branch target directly and prunes the now-unreachable expression nodes.",
    apply: applyP7CollapseExprChains,
  },
  {
    id: "p7b-convert-expr-chains",
    label: "Expression Chain → Var-Check",
    badge: "P7b",
    badgeColor: "var(--text-2)",
    description:
      "Finds standalone chains of expression CHECKs on the same variable (e.g. QueueSkill == '18556549' → False → QueueSkill == '18556551') and collapses them into a single var-mode CHECK with direct branches per value.",
    apply: applyP7bConvertExprChains,
  },
  {
    id: "p8-null-to-default",
    label: "Null Branch → Default Next",
    badge: "P8",
    badgeColor: "var(--green)",
    description:
      "Promotes any \"null\" branch key (no-input / timeout path) to the node's default_next field, the canonical representation in the editor. Cleans up the branch list so only explicit digit/value routes remain.",
    apply: applyP8NullToDefaultNext,
  },
  {
    id: "p9-remove-unreachable",
    label: "Remove Unreachable Nodes",
    badge: "P9",
    badgeColor: "var(--red)",
    description:
      "DFS from the start node and deletes anything with no path from the entry point. Run after all other passes to clean up orphaned nodes left by inlining and rewiring.",
    apply: applyP9RemoveUnreachable,
  },
  {
    id: "p10-auto-rename",
    label: "Auto-Rename from Content",
    badge: "P10",
    badgeColor: "var(--purple)",
    description:
      "Updates every node label to reflect its current content: SET shows assignments, CHECK shows expression or variable, PLAY shows the first line of the prompt, etc.",
    apply: applyP10AutoRename,
  },
];

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace" };

function badge(color: string): React.CSSProperties {
  return {
    fontSize: 9, borderRadius: 3, padding: "1px 6px", fontWeight: 700,
    letterSpacing: "0.05em", ...MONO,
    color, background: `${color}22`,
    border: `1px solid ${color}55`,
    flexShrink: 0,
  };
}

// ─── PassRow ─────────────────────────────────────────────────────────────────

function PassRow({
  pass,
  state,
  onApply,
}: {
  pass: PassDef;
  state: PassState;
  onApply: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasLog = state.log.length > 0;
  const delta = state.nodesAfter - state.nodesBefore;

  const statusColor =
    state.status === "applied"
      ? "var(--green)"
      : state.status === "no-change"
        ? "var(--text-3)"
        : "var(--text-3)";

  const statusLabel =
    state.status === "applied"
      ? `✓ applied${delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta} nodes)` : ""}`
      : state.status === "no-change"
        ? "— no change"
        : "";

  return (
    <div
      style={{
        border: `1px solid ${state.status === "applied" ? "rgba(61,186,126,0.25)" : state.status === "no-change" ? "var(--border)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        background:
          state.status === "applied"
            ? "rgba(61,186,126,0.04)"
            : "var(--bg-3)",
        overflow: "hidden",
        transition: "border-color 0.15s",
      }}
    >
      {/* Compact row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
        }}
      >
        <span style={badge(pass.badgeColor)}>{pass.badge}</span>

        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-0)",
          }}
        >
          {pass.label}
        </span>

        {statusLabel && (
          <span style={{ fontSize: 10, color: statusColor, ...MONO }}>
            {statusLabel}
          </span>
        )}

        {hasLog && (
          <button
            className="btn btn-ghost"
            onClick={() => setExpanded((v) => !v)}
            style={{ fontSize: 10, padding: "1px 6px", height: 20 }}
          >
            {expanded ? "▲ log" : "▼ log"}
          </button>
        )}

        <button
          className={`btn ${state.status === "applied" ? "btn-ghost" : "btn-primary"}`}
          onClick={onApply}
          style={{ fontSize: 10, padding: "2px 10px", height: 24, flexShrink: 0 }}
        >
          {state.status === "applied" ? "Re-apply" : "Apply"}
        </button>
      </div>

      {/* Description */}
      <div
        style={{
          padding: "0 12px 8px",
          fontSize: 10,
          color: "var(--text-3)",
          lineHeight: 1.65,
          ...MONO,
        }}
      >
        {pass.description}
      </div>

      {/* Log output */}
      {expanded && hasLog && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "8px 12px",
            background: "var(--bg-0)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {state.log.map((line, i) => (
            <div
              key={i}
              style={{ fontSize: 10, color: "var(--green)", ...MONO, lineHeight: 1.5 }}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface Props {
  ir: IR;
  setIR: (ir: IR) => void;
  onClose: () => void;
}

export default function PostProcessPanel({ ir, setIR, onClose }: Props) {
  const [passStates, setPassStates] = useState<Record<string, PassState>>(
    () => Object.fromEntries(PASSES.map((p) => [p.id, { ...EMPTY_PASS }])),
  );
  const [applyingAll, setApplyingAll] = useState(false);

  const applyPass = (pass: PassDef) => {
    const nodesBefore = Object.keys(ir.nodes).length;
    const { ir: newIR, log } = pass.apply(ir);
    const nodesAfter = Object.keys(newIR.nodes).length;

    // Detect whether anything actually changed
    const changed = JSON.stringify(ir.nodes) !== JSON.stringify(newIR.nodes);

    setPassStates((prev) => ({
      ...prev,
      [pass.id]: {
        status: changed ? "applied" : "no-change",
        log,
        nodesBefore,
        nodesAfter,
      },
    }));

    if (changed) setIR(newIR);
  };

  const applyAll = () => {
    setApplyingAll(true);
    const nodesBefore = Object.keys(ir.nodes).length;
    const { ir: newIR, log } = applyAllPostProcessing(ir);
    const nodesAfter = Object.keys(newIR.nodes).length;
    const changed = JSON.stringify(ir.nodes) !== JSON.stringify(newIR.nodes);

    // Mark all passes as applied collectively
    const newStates: Record<string, PassState> = {};
    PASSES.forEach((p) => {
      newStates[p.id] = {
        status: changed ? "applied" : "no-change",
        log: p === PASSES[PASSES.length - 1] ? log : [],
        nodesBefore,
        nodesAfter,
      };
    });
    setPassStates(newStates);
    if (changed) setIR(newIR);
    setApplyingAll(false);
  };

  const appliedCount = Object.values(passStates).filter(
    (s) => s.status === "applied",
  ).length;
  const nodeCount = Object.keys(ir.nodes).length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "var(--bg-2)",
          borderRadius: "var(--radius-lg)",
          width: 640,
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 32px 64px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            background: "var(--bg-3)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                background: "rgba(162,90,232,0.15)",
                border: "1px solid rgba(162,90,232,0.3)",
                borderRadius: 3,
                padding: "2px 7px",
                ...MONO,
                fontSize: 10,
                fontWeight: 600,
                color: "var(--purple)",
                letterSpacing: "0.05em",
              }}
            >
              POST-PROCESS
            </span>
            <span
              style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}
            >
              Landing Flow Transforms
            </span>
            <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
              {nodeCount} nodes · {appliedCount}/{PASSES.length} passes applied
            </span>
          </div>
          <button
            className="btn btn-ghost"
            onClick={onClose}
            style={{ padding: "2px 8px", height: 24, fontSize: 16 }}
          >
            ×
          </button>
        </div>

        {/* Info banner */}
        <div
          style={{
            padding: "8px 16px",
            background: "rgba(61,142,240,0.06)",
            borderBottom: "1px solid rgba(61,142,240,0.15)",
            fontSize: 11,
            color: "var(--text-2)",
            lineHeight: 1.6,
          }}
        >
          Apply each pass individually to inspect changes, or use{" "}
          <b>Apply All</b> to run every pass in order. Passes are safe to
          re-apply — each is idempotent. The canvas updates live after each
          application.
        </div>

        {/* Pass list */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {PASSES.map((pass) => (
            <PassRow
              key={pass.id}
              pass={pass}
              state={passStates[pass.id]}
              onApply={() => applyPass(pass)}
            />
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "var(--bg-3)",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
            {appliedCount > 0
              ? `${appliedCount} pass${appliedCount !== 1 ? "es" : ""} applied this session`
              : "No passes applied yet"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Close
            </button>
            <button
              className="btn btn-primary"
              onClick={applyAll}
              disabled={applyingAll || nodeCount === 0}
              style={{ borderColor: "var(--purple)", background: "rgba(162,90,232,0.15)", color: "var(--purple)" }}
            >
              ⚡ Apply All Passes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
