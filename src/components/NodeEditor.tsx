// src/components/NodeEditor.tsx
import { useState, useEffect, useCallback } from "react";
import type { IR, IVRNode, ActionType, IVRContent, SayText } from "../types";

// ── Creatable action types (what users can set on new/existing nodes) ─────────
const ACTION_TYPES: ActionType[] = [
  "PLAY", "GATHER", "CHECK", "SET", "TRANSFER",
  "HANGUP", "WAIT", "HOURS", "START",
];

// MENU is editor-only — it only appears if imported from CXone and not yet exported.
// We show it with a warning but don't offer it as a new option.
const COMPOSITE_TYPES = new Set<ActionType>(["MENU"]);

// ── Expression validator / highlighter ────────────────────────────────────────
const KEYWORDS = new Set(["and", "or", "not", "True", "False", "None", "in", "is"]);
const RESERVED_PYTHON = /^(and|or|not|True|False|None|in|is)$/;

interface ExprToken {
  text: string;
  kind: "var" | "keyword" | "op" | "literal" | "string" | "number" | "paren" | "unknown";
}

function tokenizeExpression(expr: string): ExprToken[] {
  if (!expr) return [];
  const tokens: ExprToken[] = [];
  const re =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\\b\d+\\.?\d*\\b)|(==|!=|>=|<=|>|<|&&|\|\||&|\|)|([\w]+)|([(){}[\]])|([^\s\w"'<>=!&|()\[\]{}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const [full, str, num, op, word, paren] = m;
    if (str) tokens.push({ text: full, kind: "string" });
    else if (num) tokens.push({ text: full, kind: "number" });
    else if (op) tokens.push({ text: full, kind: "op" });
    else if (paren) tokens.push({ text: full, kind: "paren" });
    else if (word) {
      if (KEYWORDS.has(word.toLowerCase()))
        tokens.push({ text: full, kind: "keyword" });
      else tokens.push({ text: full, kind: "var" });
    } else tokens.push({ text: m[0], kind: "unknown" });
  }
  return tokens;
}

function ExpressionEditor({
  value,
  onChange,
  knownVars,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  knownVars: string[];
  placeholder?: string;
}) {
  const tokens = tokenizeExpression(value);
  const vars = tokens.filter((t) => t.kind === "var").map((t) => t.text);
  // Exclude numeric literals (e.g. "3" in "MenuLoop < 3") from unknown var warnings
  const unknownVars = vars.filter(
    (v) => !knownVars.includes(v) && !RESERVED_PYTHON.test(v) && !/^\d+(\.\d+)?$/.test(v),
  );

  return (
    <div>
      <textarea
        className="input"
        style={{
          minHeight: 64,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "e.g. Lang == 'spa'  or  RetryCount >= 3"}
        spellCheck={false}
      />
      {value && (
        <div
          style={{
            marginTop: 6,
            display: "flex",
            flexWrap: "wrap",
            gap: "3px",
            background: "var(--bg-0)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "6px 8px",
          }}
        >
          {tokens.map((t, i) => {
            const color =
              t.kind === "var"
                ? /^\d+(\.\d+)?$/.test(t.text)
                  ? "#b5cea8" // numeric literal — green-ish like numbers
                  : knownVars.includes(t.text)
                    ? "var(--cyan)"
                    : "var(--orange)"
                : t.kind === "string"
                  ? "var(--green)"
                  : t.kind === "number"
                    ? "#b5cea8"
                    : t.kind === "keyword"
                      ? "var(--purple)"
                      : t.kind === "op"
                        ? "var(--accent)"
                        : "var(--text-2)";
            return (
              <span
                key={i}
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 11,
                  color,
                  padding: "1px 3px",
                  background:
                    t.kind === "var" &&
                      !knownVars.includes(t.text) &&
                      !RESERVED_PYTHON.test(t.text) &&
                      !/^\d+(\.\d+)?$/.test(t.text)
                      ? "rgba(232,149,90,0.1)"
                      : "transparent",
                  borderRadius: 2,
                }}
              >
                {t.text}
              </span>
            );
          })}
        </div>
      )}
      {unknownVars.length > 0 && (
        <div
          style={{
            marginTop: 5,
            fontSize: 10,
            color: "var(--orange)",
            fontFamily: "'IBM Plex Mono', monospace",
            lineHeight: 1.6,
          }}
        >
          ⚠ Unknown vars: <b>{unknownVars.join(", ")}</b> — evaluates as False
          if not in state
        </div>
      )}
      {vars.length > 0 && (
        <div
          style={{
            marginTop: 3,
            fontSize: 10,
            color: "var(--text-3)",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <span style={{ color: "var(--cyan)" }}>■</span> cyan = known &nbsp;
          <span style={{ color: "var(--orange)" }}>■</span> orange =
          unrecognised &nbsp;
          <span style={{ color: "var(--green)" }}>■</span> string literal
        </div>
      )}
    </div>
  );
}

// ── Node target picker ────────────────────────────────────────────────────────
function NodePicker({
  value,
  onChange,
  nodes,
  selfId,
  onStartPick,
  pickingActive,
}: {
  value: string;
  onChange: (id: string) => void;
  nodes: Record<string, IVRNode>;
  selfId: string;
  onStartPick: () => void;
  pickingActive: boolean;
}) {
  const nodeIds = Object.keys(nodes)
    .filter((id) => id !== selfId)
    .sort();
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <select
        className="input"
        style={{ flex: 1 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">(End Flow)</option>
        {nodeIds.map((id) => {
          const n = nodes[id];
          return (
            <option key={id} value={id}>
              [{id}] {n.label || n.action_type}
            </option>
          );
        })}
      </select>
      <button
        className="btn"
        onClick={onStartPick}
        title="Click a node on the canvas to set target"
        style={{
          padding: "4px 8px",
          height: 28,
          flexShrink: 0,
          background: pickingActive ? "var(--accent)" : undefined,
          color: pickingActive ? "#fff" : "var(--text-2)",
          borderColor: pickingActive ? "var(--accent)" : undefined,
          fontSize: 14,
        }}
      >
        ↗
      </button>
    </div>
  );
}

// ── Action badge ──────────────────────────────────────────────────────────────
function ActionBadge({ action }: { action: ActionType }) {
  const isComposite = COMPOSITE_TYPES.has(action);
  return (
    <span
      className={`action-badge badge-${action}`}
      style={
        isComposite
          ? { opacity: 0.7, border: "1px dashed currentColor" }
          : undefined
      }
      title={
        isComposite
          ? "Editor-only composite — will expand to atomics on export"
          : undefined
      }
    >
      {action}
      {isComposite ? " ◈" : ""}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getBranches(node: IVRNode): Record<string, string> {
  return node.content?.branches ?? {};
}

function collectFlowVars(ir: IR): string[] {
  const vars = new Set<string>([
    "uid",
    "Lang",
    "QueueSkill",
    "SkillWhisper",
    "IsSystemOpen",
    "caller",
    "dialed",
    "CallSid",
    "step_id",
    "flow_id",
    "ACHP",
    "BlockCall",
  ]);
  for (const node of Object.values(ir.nodes)) {
    // Pick up any explicitly assigned variables
    const asgn = node.content?.assignments ?? {};
    for (const k of Object.keys(asgn)) vars.add(k);
    // Pick up GATHER target variables
    if (node.content?.variable) vars.add(node.content.variable);
    if (node.content?.var) vars.add(node.content.var);
  }
  return Array.from(vars).sort();
}

// ── Main NodeEditor ───────────────────────────────────────────────────────────
interface Props {
  ir: IR;
  selectedId: string | null;
  setIR: (ir: IR) => void;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onStartPick: (callback: (id: string) => void) => void;
  pickingBranch: string | null;
}

export default function NodeEditor({
  ir,
  selectedId,
  setIR,
  onSelect,
  onDelete,
  onStartPick,
  pickingBranch,
}: Props) {
  const [localId, setLocalId] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const node: IVRNode | null = selectedId ? ir.nodes[selectedId] : null;
  const knownVars = collectFlowVars(ir);

  useEffect(() => {
    if (selectedId) setLocalId(selectedId);
  }, [selectedId]);

  if (!node || !selectedId) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-icon">◈</div>
        <div className="editor-empty-title">No node selected</div>
        <div className="editor-empty-sub">
          Click a node on the canvas
          <br />
          to inspect and edit it
        </div>
      </div>
    );
  }

  const updateNode = (updates: Partial<IVRNode>) =>
    setIR({
      ...ir,
      nodes: { ...ir.nodes, [selectedId]: { ...node, ...updates } },
    });

  const updateContent = (patch: Partial<IVRContent>) =>
    updateNode({ content: { ...node.content, ...patch } });

  // ── Rename ──────────────────────────────────────────────────────────────
  const handleRename = () => {
    const trimmed = localId.trim();
    if (!trimmed || trimmed === selectedId || ir.nodes[trimmed]) return;
    const newNodes: Record<string, IVRNode> = {};
    Object.entries(ir.nodes).forEach(([k, n]) => {
      const updated = { ...n };
      if (updated.default_next === selectedId) updated.default_next = trimmed;
      const branches: Record<string, string> = {};
      Object.entries(getBranches(n)).forEach(([bk, bv]) => {
        branches[bk] = bv === selectedId ? trimmed : bv;
      });
      updated.content = { ...updated.content, branches };
      newNodes[k === selectedId ? trimmed : k] = updated;
    });
    newNodes[trimmed] = { ...newNodes[trimmed], step_id: trimmed };
    const newStartStep =
      ir.start_step === selectedId ? trimmed : ir.start_step;
    setIR({ ...ir, nodes: newNodes, start_step: newStartStep });
    onSelect(trimmed);
  };

  // ── Branch helpers ───────────────────────────────────────────────────────
  const branches = getBranches(node);

  const addBranch = () => {
    const key = `branch_${Date.now().toString(36)}`;
    updateContent({ branches: { ...branches, [key]: "" } });
  };

  const removeBranch = (key: string) => {
    const nb = { ...branches };
    delete nb[key];
    updateContent({ branches: nb });
  };

  const renameBranchKey = (oldKey: string, newKey: string) => {
    const nb: Record<string, string> = {};
    Object.entries(branches).forEach(([k, v]) => {
      nb[k === oldKey ? newKey : k] = v;
    });
    updateContent({ branches: nb });
  };

  const setBranchTarget = (key: string, target: string) =>
    updateContent({ branches: { ...branches, [key]: target } });

  // ── Swap with predecessor ────────────────────────────────────────────────
  // Finds every node that points HERE (via default_next or a branch target)
  // and swaps the order: predecessors now skip directly to our default_next,
  // and we point at them (or rather, we insert ourselves after them).
  //
  // Concretely, given:   [pred] → [B] → [C] → ...
  // After swap:          [pred] → [C] → ...   and   [B] → [C] → ...
  //                      (...and we select [C] so you can chain further)
  //
  // The canonical use-case: [block-check] → [SET Lang=eng] → [greeting] → [lang menu]
  // After swap of SET Lang=eng:  [block-check] → [greeting] → [lang menu]
  //                              [SET Lang=eng] still exists, pointed to by lang menu branch

  // Find all nodes that point to selectedId
  const predecessors: Array<{ nodeId: string; via: "default_next" | string }> = [];
  for (const [nid, n] of Object.entries(ir.nodes)) {
    if (nid === selectedId) continue;
    if (n.default_next === selectedId) predecessors.push({ nodeId: nid, via: "default_next" });
    for (const [bk, bv] of Object.entries(getBranches(n))) {
      if (bv === selectedId) predecessors.push({ nodeId: nid, via: bk });
    }
  }

  const canSwap = predecessors.length > 0 && !!node.default_next;

  const swapWithPredecessor = () => {
    if (!canSwap) return;
    const myNext = node.default_next!;
    const newNodes = { ...ir.nodes };

    // Rewire: every inbound edge that pointed to us now points to our default_next
    for (const { nodeId, via } of predecessors) {
      const pred = { ...newNodes[nodeId] };
      if (via === "default_next") {
        pred.default_next = myNext;
      } else {
        pred.content = {
          ...pred.content,
          branches: { ...getBranches(pred), [via]: myNext },
        };
      }
      newNodes[nodeId] = pred;
    }

    // We stay in the graph, still pointing to myNext — no change to our node needed
    // (our default_next is already myNext)
    setIR({ ...ir, nodes: newNodes });
  };

  // ── Text helpers ─────────────────────────────────────────────────────────
  const getText = (lang: "eng" | "spa"): string => {
    const t = node.content?.text;
    if (!t) return "";
    if (typeof t === "string") return lang === "eng" ? t : "";
    return (t as SayText)[lang] ?? "";
  };

  const setText = (lang: "eng" | "spa", value: string) => {
    const existing = node.content?.text;
    const prev: SayText =
      existing && typeof existing === "object"
        ? (existing as SayText)
        : { eng: typeof existing === "string" ? existing : "", spa: "" };
    updateContent({ text: { ...prev, [lang]: value } });
  };

  const isTextAction =
    node.action_type === "PLAY" || node.action_type === "GATHER";
  const isCheck = node.action_type === "CHECK";
  const isGather = node.action_type === "GATHER";
  const isStart = node.action_type === "START";
  const isComposite = COMPOSITE_TYPES.has(node.action_type);
  const isCurrentStart = ir.start_step === selectedId;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* ── Header ── */}
      <div className="editor-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="editor-header-label">Inspector</span>
          <ActionBadge action={node.action_type} />
          {isCurrentStart && (
            <span
              style={{
                fontSize: 9,
                fontFamily: "'IBM Plex Mono', monospace",
                background: "rgba(61,186,126,0.15)",
                border: "1px solid rgba(61,186,126,0.3)",
                color: "var(--green)",
                borderRadius: 3,
                padding: "1px 5px",
                letterSpacing: "0.05em",
              }}
            >
              START
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="editor-header-id">{selectedId}</span>
          {canSwap && (
            <button
              className="btn btn-ghost"
              onClick={swapWithPredecessor}
              style={{ padding: "2px 6px", height: 22, fontSize: 11 }}
              title={`Bypass this node — rewire ${predecessors.length} predecessor(s) to skip directly to "${node.default_next}"`}
            >
              ↑ Bypass
            </button>
          )}
          <button
            className="btn btn-ghost btn-danger"
            onClick={() => onDelete(selectedId)}
            style={{ padding: "2px 6px", height: 22, fontSize: 11 }}
            title="Delete node"
          >
            Del
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => onSelect(null)}
            style={{ padding: "2px 6px", height: 22, fontSize: 14 }}
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* ── Composite warning ── */}
      {isComposite && (
        <div
          style={{
            margin: "0 12px",
            marginTop: 8,
            background: "rgba(61,142,240,0.06)",
            border: "1px solid rgba(61,142,240,0.25)",
            borderRadius: "var(--radius)",
            padding: "8px 12px",
            fontSize: 11,
            color: "var(--accent)",
            lineHeight: 1.6,
          }}
        >
          <b>Editor-only node.</b> MENU expands to GATHER + CHECK + retry logic
          at export time. To edit the generated atomics directly, export and
          re-import.
        </div>
      )}

      {/* ── Scrollable body ── */}
      <div className="editor-scroll">
        {/* Identity */}
        <div className="form-section">
          <div className="form-section-title">Identity</div>
          <div>
            <label className="form-label">Step ID</label>
            <div className="rename-row">
              <input
                className="input"
                value={localId}
                onChange={(e) => setLocalId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
                spellCheck={false}
              />
              <button
                className="btn btn-primary"
                onClick={handleRename}
                style={{ flex: "0 0 auto" }}
              >
                Rename
              </button>
            </div>
            {localId !== selectedId && localId && !ir.nodes[localId] && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--green)",
                  marginTop: 4,
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                ↵ Enter or Rename to apply
              </div>
            )}
            {localId !== selectedId && ir.nodes[localId] && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--red)",
                  marginTop: 4,
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                ✕ ID already exists
              </div>
            )}
          </div>

          <div>
            <label className="form-label">Label</label>
            <input
              className="input"
              value={node.label}
              onChange={(e) => updateNode({ label: e.target.value })}
              spellCheck={false}
            />
          </div>

          {/* Inbound edges */}
          <div>
            <label className="form-label">Inbound edges</label>
            {predecessors.length === 0 ? (
              <div style={{
                fontSize: 10,
                color: "var(--text-3)",
                fontFamily: "'IBM Plex Mono', monospace",
                padding: "3px 0",
              }}>
                None — {ir.start_step === selectedId ? "this is the start node" : "unreachable"}
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {predecessors.map(({ nodeId, via }) => (
                  <button
                    key={`${nodeId}:${via}`}
                    className="btn btn-ghost"
                    style={{ fontSize: 10, height: 20, padding: "0 6px", fontFamily: "'IBM Plex Mono', monospace" }}
                    onClick={() => onSelect(nodeId)}
                    title={`Go to ${nodeId} (via ${via})`}
                  >
                    {nodeId}
                    <span style={{ color: "var(--text-3)", marginLeft: 3 }}>
                      {via === "default_next" ? "→" : `[${via}]`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="form-label">Action Type</label>
            <select
              className="input"
              value={node.action_type}
              onChange={(e) =>
                updateNode({ action_type: e.target.value as ActionType })
              }
            >
              {ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              {/* Show composite type if node currently has it (imported) */}
              {COMPOSITE_TYPES.has(node.action_type) && (
                <option value={node.action_type}>
                  {node.action_type} (editor composite)
                </option>
              )}
            </select>
          </div>

          {/* Start step */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: isCurrentStart
                ? "rgba(61,186,126,0.08)"
                : "var(--bg-0)",
              border: `1px solid ${isCurrentStart ? "rgba(61,186,126,0.3)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              padding: "8px 12px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: isCurrentStart ? "var(--green)" : "var(--text-2)",
                }}
              >
                {isCurrentStart ? "✓ Entry Point" : "Entry Point"}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-3)",
                  fontFamily: "'IBM Plex Mono', monospace",
                  marginTop: 2,
                }}
              >
                {isCurrentStart
                  ? "Flow begins here"
                  : "First step callers reach"}
              </div>
            </div>
            {!isCurrentStart && (
              <button
                className="btn"
                style={{ fontSize: 10, height: 24, padding: "2px 10px" }}
                onClick={() => setIR({ ...ir, start_step: selectedId })}
              >
                Set as Start
              </button>
            )}
          </div>
        </div>

        {/* START info */}
        {isStart && (
          <div className="form-section">
            <div className="form-section-title">Start Node</div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-2)",
                lineHeight: 1.7,
                background: "var(--bg-0)",
                borderRadius: "var(--radius)",
                padding: "10px 12px",
                border: "1px solid var(--border)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              Synthetic entry node generated from BEGIN.
              <br />
              <span style={{ color: "var(--text-3)", fontSize: 10 }}>
                Set <b>Default Next</b> below to the first real step.
              </span>
            </div>
          </div>
        )}

        {/* Prompt text (PLAY / GATHER) */}
        {isTextAction && (
          <div className="form-section">
            <div className="form-section-title">Prompt Text</div>
            <div>
              <label className="form-label">English (eng)</label>
              <textarea
                className="input"
                style={{ minHeight: 80 }}
                value={getText("eng")}
                onChange={(e) => setText("eng", e.target.value)}
                placeholder="English prompt text…"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="form-label">Spanish (spa)</label>
              <textarea
                className="input"
                style={{ minHeight: 80 }}
                value={getText("spa")}
                onChange={(e) => setText("spa", e.target.value)}
                placeholder="Spanish prompt text…"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {/* GATHER config */}
        {isGather && (
          <div className="form-section">
            <div className="form-section-title">Gather Config</div>
            <div>
              <label className="form-label">Store result in variable</label>
              <input
                className="input"
                value={node.content?.variable ?? ""}
                onChange={(e) => updateContent({ variable: e.target.value })}
                placeholder="e.g. KPMAMenu_RES"
                spellCheck={false}
              />
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-3)",
                  marginTop: 4,
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                CHECK node reads this variable to route the call
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="form-label">Max Digits</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="20"
                  value={node.content?.num_digits ?? "1"}
                  onChange={(e) =>
                    updateContent({ num_digits: e.target.value })
                  }
                />
              </div>
              <div style={{ flex: 1 }}>
                <label className="form-label">Timeout (sec)</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="30"
                  value={node.content?.timeout ?? "5"}
                  onChange={(e) => updateContent({ timeout: e.target.value })}
                />
              </div>
            </div>
          </div>
        )}

        {/* CHECK config */}
        {isCheck && (
          <div className="form-section">
            <div className="form-section-title">
              Check Mode
              <span
                style={{
                  fontSize: 9,
                  color: "var(--text-3)",
                  letterSpacing: "0.08em",
                  marginLeft: 8,
                }}
              >
                {node.content?.var ? "VAR MODE" : "EXPRESSION MODE"}
              </span>
            </div>

            {/* Var mode toggle */}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 4,
              }}
            >
              <button
                className={`btn ${!node.content?.var ? "btn-primary" : ""}`}
                style={{ fontSize: 10, height: 24, padding: "2px 10px" }}
                onClick={() => updateContent({ var: undefined })}
              >
                Expression
              </button>
              <button
                className={`btn ${node.content?.var ? "btn-primary" : ""}`}
                style={{ fontSize: 10, height: 24, padding: "2px 10px" }}
                onClick={() =>
                  updateContent({ var: node.content?.var ?? "menu_var" })
                }
              >
                Variable
              </button>
            </div>

            {node.content?.var ? (
              <div>
                <label className="form-label">Branch on variable</label>
                <input
                  className="input"
                  value={node.content.var}
                  onChange={(e) => updateContent({ var: e.target.value })}
                  placeholder="e.g. KPMAMenu_RES"
                  spellCheck={false}
                />
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-3)",
                    marginTop: 4,
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  Branch keys below are matched against this variable's value.
                  Use <code style={{ color: "var(--cyan)" }}>null</code> for
                  no-input / timeout.
                </div>
              </div>
            ) : (
              <div>
                <label className="form-label">
                  Expression{" "}
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-3)",
                      fontWeight: 400,
                    }}
                  >
                    — branches: True / False
                  </span>
                </label>
                <ExpressionEditor
                  value={node.content?.expression ?? ""}
                  onChange={(v) => updateContent({ expression: v })}
                  knownVars={knownVars}
                  placeholder="e.g. Lang == 'spa'  or  RetryCount >= 3"
                />
              </div>
            )}
          </div>
        )}

        {/* WAIT config */}
        {node.action_type === "WAIT" && (
          <div className="form-section">
            <div className="form-section-title">Wait Config</div>
            <div>
              <label className="form-label">Pause Duration (seconds)</label>
              <input
                className="input"
                type="number"
                min="1"
                max="120"
                value={node.content?.seconds ?? "1"}
                onChange={(e) => updateContent({ seconds: e.target.value })}
              />
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-3)",
                  marginTop: 4,
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                Emits{" "}
                <code style={{ color: "var(--cyan)" }}>
                  &lt;Pause length="{node.content?.seconds ?? "1"}"&gt;
                </code>
              </div>
            </div>
          </div>
        )}

        {/* TRANSFER config */}
        {node.action_type === "TRANSFER" && (
          <div className="form-section">
            <div className="form-section-title">Transfer Config</div>
            <div>
              <label className="form-label">Type</label>
              <select
                className="input"
                value={node.content?.transferType ?? "CONNECT"}
                onChange={(e) =>
                  updateContent({
                    transferType: e.target.value as "CONNECT" | "SIP",
                  })
                }
              >
                <option value="CONNECT">CONNECT (AWS Connect + DTMF)</option>
                <option value="SIP">SIP (PolyAI)</option>
              </select>
            </div>
            {node.content?.transferType === "CONNECT" && (
              <div>
                <label className="form-label">DTMF Digits</label>
                <input
                  className="input"
                  value={node.content?.digits ?? "{{uid}}"}
                  onChange={(e) => updateContent({ digits: e.target.value })}
                  placeholder="{{uid}}"
                  spellCheck={false}
                />
              </div>
            )}
            {node.content?.transferType === "CONNECT" && node.content?.agentSkill && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-3)",
                  fontFamily: "'IBM Plex Mono', monospace",
                  padding: "6px 10px",
                  background: "var(--bg-0)",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                }}
              >
                <div style={{ color: "var(--text-2)", marginBottom: 2 }}>CXone Agent Skill</div>
                <span style={{ color: "var(--orange)" }}>{node.content.agentSkill}</span>
                {node.content?.queueArn ? (
                  <div style={{ marginTop: 4, color: "var(--green)", fontSize: 9 }}>
                    ✓ Queue ARN: {node.content.queueArn}
                  </div>
                ) : (
                  <div style={{ marginTop: 4, color: "var(--text-3)", fontSize: 9 }}>
                    No queue ARN yet — provision in Skills &amp; Queues
                  </div>
                )}
              </div>
            )}
            {node.content?.transferType === "SIP" && (
              <>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-3)",
                    fontFamily: "'IBM Plex Mono', monospace",
                    lineHeight: 1.8,
                    background: "var(--bg-0)",
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                    padding: "8px 10px",
                  }}
                >
                  <div>X-UID: <span style={{ color: "var(--cyan)" }}>{"{{uid}}"}</span></div>
                  <div>X-QueueSkill: <span style={{ color: "var(--cyan)" }}>{"{{QueueSkill}}"}</span></div>
                  <div>X-SkillWhisper: <span style={{ color: "var(--cyan)" }}>{"{{SkillWhisper}}"}</span></div>
                  <div style={{ marginTop: 4, color: "var(--text-3)" }}>
                    After PolyAI returns → default_next step
                  </div>
                </div>
                {/* SIP Header overrides */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <label className="form-label" style={{ marginBottom: 0 }}>SIP Header Overrides</label>
                    <button
                      className="btn"
                      style={{ fontSize: 10, height: 20, padding: "2px 8px" }}
                      onClick={() => {
                        const headers = { ...(node.content?.sipHeaders ?? {}) };
                        headers[`X-Header-${Date.now().toString(36)}`] = "";
                        updateContent({ sipHeaders: headers });
                      }}
                    >
                      + Add
                    </button>
                  </div>
                  {Object.entries(node.content?.sipHeaders ?? {}).map(([k, v]) => (
                    <div key={k} className="branch-row">
                      <div className="branch-key-row">
                        <span className="branch-key-label">Header</span>
                        <input
                          className="branch-key-input"
                          defaultValue={k}
                          spellCheck={false}
                          onBlur={(e) => {
                            const nk = e.target.value.trim();
                            if (!nk || nk === k) return;
                            const headers = { ...(node.content?.sipHeaders ?? {}) };
                            const val = headers[k];
                            delete headers[k];
                            headers[nk] = val;
                            updateContent({ sipHeaders: headers });
                          }}
                        />
                        <button
                          className="btn btn-ghost btn-danger"
                          onClick={() => {
                            const headers = { ...(node.content?.sipHeaders ?? {}) };
                            delete headers[k];
                            updateContent({ sipHeaders: headers });
                          }}
                          style={{ padding: "1px 5px", height: 20, fontSize: 14, marginLeft: "auto" }}
                        >
                          ×
                        </button>
                      </div>
                      <div className="branch-target-row">
                        <span className="branch-target-label">=</span>
                        <input
                          className="input"
                          style={{ flex: 1, padding: "4px 8px" }}
                          value={v}
                          onChange={(e) =>
                            updateContent({
                              sipHeaders: { ...(node.content?.sipHeaders ?? {}), [k]: e.target.value },
                            })
                          }
                          placeholder="value or {{variable}}"
                          spellCheck={false}
                        />
                      </div>
                    </div>
                  ))}
                  {Object.keys(node.content?.sipHeaders ?? {}).length === 0 && (
                    <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace" }}>
                      No header overrides — using defaults above
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* SET assignments */}
        {node.action_type === "SET" && (
          <div className="form-section">
            <div className="form-section-title">
              Assignments
              <button
                className="btn"
                style={{ fontSize: 10, height: 20, padding: "2px 8px" }}
                onClick={() => {
                  const key = `Var_${Date.now().toString(36)}`;
                  updateContent({
                    assignments: {
                      ...(node.content?.assignments ?? {}),
                      [key]: "",
                    },
                  });
                }}
              >
                + Add
              </button>
            </div>
            {Object.keys(node.content?.assignments ?? {}).length === 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  fontFamily: "'IBM Plex Mono', monospace",
                  padding: "4px 0",
                }}
              >
                No assignments
              </div>
            )}
            {Object.entries(node.content?.assignments ?? {}).map(([k, v]) => (
              <div className="branch-row" key={k}>
                <div className="branch-key-row">
                  <span className="branch-key-label">Var</span>
                  <input
                    className="branch-key-input"
                    defaultValue={k}
                    spellCheck={false}
                    onBlur={(e) => {
                      const nk = e.target.value.trim();
                      if (!nk || nk === k) return;
                      const a = { ...(node.content?.assignments ?? {}) };
                      const val = a[k];
                      delete a[k];
                      a[nk] = val;
                      updateContent({ assignments: a });
                    }}
                  />
                  <button
                    className="btn btn-ghost btn-danger"
                    onClick={() => {
                      const a = { ...(node.content?.assignments ?? {}) };
                      delete a[k];
                      updateContent({ assignments: a });
                    }}
                    style={{
                      padding: "1px 5px",
                      height: 20,
                      fontSize: 14,
                      marginLeft: "auto",
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="branch-target-row">
                  <span className="branch-target-label">=</span>
                  <input
                    className="input"
                    style={{ flex: 1, padding: "4px 8px" }}
                    value={v}
                    onChange={(e) =>
                      updateContent({
                        assignments: {
                          ...(node.content?.assignments ?? {}),
                          [k]: e.target.value,
                        },
                      })
                    }
                    placeholder="value  or  var++  or  0"
                    spellCheck={false}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Branches */}
        <div className="form-section">
          <div className="form-section-title">
            Branches
            <button
              className="btn"
              style={{ fontSize: 10, height: 20, padding: "2px 8px" }}
              onClick={addBranch}
            >
              + Add
            </button>
          </div>
          {isCheck && node.content?.var && (
            <div
              style={{
                fontSize: 10,
                color: "var(--text-3)",
                fontFamily: "'IBM Plex Mono', monospace",
                marginBottom: 6,
              }}
            >
              Keys match values of{" "}
              <code style={{ color: "var(--cyan)" }}>{node.content.var}</code>.
              Use <code style={{ color: "var(--cyan)" }}>null</code> for
              no-input.
            </div>
          )}
          {isCheck && !node.content?.var && (
            <div
              style={{
                fontSize: 10,
                color: "var(--text-3)",
                fontFamily: "'IBM Plex Mono', monospace",
                marginBottom: 6,
              }}
            >
              Use keys <code style={{ color: "var(--cyan)" }}>True</code> and{" "}
              <code style={{ color: "var(--cyan)" }}>False</code>.
            </div>
          )}
          {Object.keys(branches).length === 0 && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                fontFamily: "'IBM Plex Mono', monospace",
                padding: "6px 0",
              }}
            >
              No branches — terminal step
            </div>
          )}
          {Object.entries(branches).map(([key, target]) => (
            <div className="branch-row" key={key}>
              <div className="branch-key-row">
                <span className="branch-key-label">Key</span>
                <input
                  className="branch-key-input"
                  defaultValue={key}
                  spellCheck={false}
                  onBlur={(e) => {
                    const nk = e.target.value.trim();
                    if (nk && nk !== key) renameBranchKey(key, nk);
                  }}
                />
                <button
                  className="btn btn-ghost btn-danger"
                  onClick={() => removeBranch(key)}
                  style={{
                    padding: "1px 5px",
                    height: 20,
                    fontSize: 14,
                    marginLeft: "auto",
                  }}
                >
                  ×
                </button>
              </div>
              <div className="branch-target-row">
                <span className="branch-target-label">→</span>
                <NodePicker
                  value={target}
                  onChange={(id) => setBranchTarget(key, id)}
                  nodes={ir.nodes}
                  selfId={selectedId}
                  pickingActive={pickingBranch === key}
                  onStartPick={() =>
                    onStartPick((id) => setBranchTarget(key, id))
                  }
                />
              </div>
            </div>
          ))}
        </div>

        {/* Default Next */}
        <div className="form-section">
          <div className="form-section-title">Default Next</div>
          <NodePicker
            value={node.default_next ?? ""}
            onChange={(id) => updateNode({ default_next: id || undefined })}
            nodes={ir.nodes}
            selfId={selectedId}
            pickingActive={pickingBranch === "__default_next__"}
            onStartPick={() =>
              onStartPick((id) =>
                updateNode({ default_next: id || undefined }),
              )
            }
          />
        </div>

        {/* Debug */}
        <div className="debug-panel">
          <div
            className="debug-header"
            onClick={() => setShowDebug((v) => !v)}
          >
            {showDebug ? "▾" : "▸"}&nbsp;&nbsp;RAW NODE DATA
          </div>
          {showDebug && (
            <div className="debug-body">{JSON.stringify(node, null, 2)}</div>
          )}
        </div>
      </div>
    </div>
  );
}