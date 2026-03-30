// src/components/editor/NodeEditor.tsx
import { useState, useEffect } from "react";
import type { IR, IVRNode, ActionType, IVRContent } from "../../types";
import ExpressionEditor from "./ExpressionEditor";
import NodePicker from "./NodePicker";
import SipHeaderRow from "./SipHeaderRow";

const ACTION_TYPES: ActionType[] = [
  "PLAY", "GATHER", "CHECK", "SET", "TRANSFER", "HANGUP", "WAIT", "HOURS", "START",
];

// ── Language registry ─────────────────────────────────────────────────────────

export const COMMON_LANGS: { code: string; label: string }[] = [
  { code: "eng", label: "English" },
  { code: "spa", label: "Spanish" },
  { code: "fra", label: "French" },
  { code: "por", label: "Portuguese" },
  { code: "deu", label: "German" },
  { code: "ita", label: "Italian" },
  { code: "zho", label: "Chinese (Mandarin)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "rus", label: "Russian" },
  { code: "ara", label: "Arabic" },
  { code: "hin", label: "Hindi" },
  { code: "vie", label: "Vietnamese" },
  { code: "pol", label: "Polish" },
  { code: "nld", label: "Dutch" },
];

export function langLabel(code: string): string {
  return COMMON_LANGS.find(l => l.code === code)?.label ?? code;
}

// ── LangTextRow ───────────────────────────────────────────────────────────────

interface LangTextRowProps {
  langCode: string;
  value: string;
  onChange: (value: string) => void;
  onRename: (newCode: string) => void;
  onRemove?: () => void;
}

function LangTextRow({ langCode, value, onChange, onRename, onRemove }: LangTextRowProps) {
  const [localCode, setLocalCode] = useState(langCode);
  useEffect(() => setLocalCode(langCode), [langCode]);

  const commitRename = () => {
    const trimmed = localCode.trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 8);
    if (!trimmed) { setLocalCode(langCode); return; }
    if (trimmed !== langCode) onRename(trimmed);
    else setLocalCode(langCode);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* Language code header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: "0.08em",
          color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace",
          textTransform: "uppercase", flex: "0 0 auto",
        }}>LANG</span>
        <input
          className="branch-key-input"
          value={localCode}
          onChange={e => setLocalCode(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => e.key === "Enter" && commitRename()}
          spellCheck={false}
          title="Language code (ISO 639-2, e.g. eng, spa, fra)"
          style={{ width: 64, flexShrink: 0 }}
        />
        <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          {langLabel(langCode)}
        </span>
        {onRemove && (
          <button
            className="btn btn-ghost btn-danger"
            onClick={onRemove}
            style={{ padding: "1px 5px", height: 20, fontSize: 14, marginLeft: "auto" }}
            title="Remove this language"
          >×</button>
        )}
      </div>
      {/* Text area */}
      <textarea
        className="input"
        style={{ minHeight: 72, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12, resize: "vertical" }}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={`${langLabel(langCode)} prompt text…`}
        spellCheck={false}
      />
    </div>
  );
}

// ── AddLangButton ─────────────────────────────────────────────────────────────

interface AddLangButtonProps {
  existing: string[];
  onAdd: (code: string) => void;
}

function AddLangButton({ existing, onAdd }: AddLangButtonProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");

  const available = COMMON_LANGS.filter(l => !existing.includes(l.code));
  const [selected, setSelected] = useState(available[0]?.code ?? "");

  // Keep selected valid when existing changes
  useEffect(() => {
    const avail = COMMON_LANGS.filter(l => !existing.includes(l.code));
    if (!avail.find(l => l.code === selected)) setSelected(avail[0]?.code ?? "");
  }, [existing.join(",")]);

  const handleAdd = () => {
    const code = custom.trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 8) || selected;
    if (!code || existing.includes(code)) return;
    onAdd(code);
    setCustom("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="btn" style={{ fontSize: 10, height: 20, padding: "2px 8px" }}
        onClick={() => setOpen(true)}>+ Add Language</button>
    );
  }

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <select
        className="input"
        style={{ fontSize: 10, height: 22, padding: "0 4px", flex: "0 0 auto" }}
        value={selected}
        onChange={e => { setSelected(e.target.value); setCustom(""); }}
      >
        {available.map(l => (
          <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
        ))}
        <option value="">— custom —</option>
      </select>
      {selected === "" && (
        <input
          className="input"
          style={{ fontSize: 10, height: 22, padding: "0 6px", width: 72 }}
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
          placeholder="e.g. fra"
          spellCheck={false}
          autoFocus
        />
      )}
      <button className="btn btn-primary" style={{ fontSize: 10, height: 22, padding: "2px 8px" }}
        onClick={handleAdd}>Add</button>
      <button className="btn btn-ghost" style={{ fontSize: 10, height: 22, padding: "2px 6px" }}
        onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
const COMPOSITE_TYPES = new Set<ActionType>(["MENU"]);

// Seeded once when a node first switches to SIP. After that, plain rows — no special treatment.
const INITIAL_SIP_HEADERS: Record<string, string> = {
  "X-SkillId": "{{QueueSkill}}",
  "X-UID": "{{uid}}",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBranches(node: IVRNode): Record<string, string> {
  return node.content?.branches ?? {};
}

function collectFlowVars(ir: IR): string[] {
  const vars = new Set<string>([
    "uid", "Lang", "QueueSkill", "SkillWhisper", "IsSystemOpen",
    "caller", "dialed", "CallSid", "step_id", "flow_id", "ACHP", "BlockCall",
  ]);
  for (const node of Object.values(ir.nodes)) {
    for (const k of Object.keys(node.content?.assignments ?? {})) vars.add(k);
    if (node.content?.variable) vars.add(node.content.variable);
    if (node.content?.var) vars.add(node.content.var);
  }
  return Array.from(vars).sort();
}

// ── ActionBadge ───────────────────────────────────────────────────────────────

function ActionBadge({ action }: { action: ActionType }) {
  const isComposite = COMPOSITE_TYPES.has(action);
  return (
    <span
      className={`action-badge badge-${action}`}
      style={isComposite ? { opacity: 0.7, border: "1px dashed currentColor" } : undefined}
      title={isComposite ? "Editor-only composite — will expand to atomics on export" : undefined}
    >
      {action}{isComposite ? " ◈" : ""}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  ir: IR;
  selectedId: string | null;
  setIR: (ir: IR) => void;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onStartPick: (callback: (id: string) => void) => void;
  pickingBranch: string | null;
}

// ── NodeEditor ────────────────────────────────────────────────────────────────

export default function NodeEditor({
  ir, selectedId, setIR, onSelect, onDelete, onStartPick, pickingBranch,
}: Props) {
  const [localId, setLocalId] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const node: IVRNode | null = selectedId ? ir.nodes[selectedId] : null;
  const knownVars = collectFlowVars(ir);

  useEffect(() => { if (selectedId) setLocalId(selectedId); }, [selectedId]);

  if (!node || !selectedId) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-icon">◈</div>
        <div className="editor-empty-title">No node selected</div>
        <div className="editor-empty-sub">Click a node on the canvas<br />to inspect and edit it</div>
      </div>
    );
  }

  // ── IR mutation helpers ──────────────────────────────────────────────────

  const updateNode = (updates: Partial<IVRNode>) =>
    setIR({ ...ir, nodes: { ...ir.nodes, [selectedId]: { ...node, ...updates } } });

  const updateContent = (patch: Partial<IVRContent>) =>
    updateNode({ content: { ...node.content, ...patch } });

  // ── Rename ───────────────────────────────────────────────────────────────

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
    setIR({ ...ir, nodes: newNodes, start_step: ir.start_step === selectedId ? trimmed : ir.start_step });
    onSelect(trimmed);
  };

  // ── Branch helpers ────────────────────────────────────────────────────────

  const branches = getBranches(node);

  const addBranch = () =>
    updateContent({ branches: { ...branches, [`branch_${Date.now().toString(36)}`]: "" } });

  const removeBranch = (key: string) => {
    const nb = { ...branches }; delete nb[key]; updateContent({ branches: nb });
  };

  const renameBranchKey = (oldKey: string, newKey: string) => {
    const nb: Record<string, string> = {};
    Object.entries(branches).forEach(([k, v]) => { nb[k === oldKey ? newKey : k] = v; });
    updateContent({ branches: nb });
  };

  const setBranchTarget = (key: string, target: string) =>
    updateContent({ branches: { ...branches, [key]: target } });

  // ── SIP header helpers ────────────────────────────────────────────────────
  // sipHeaders is a plain Record — every entry behaves identically.

  const sipHeaders = node.content?.sipHeaders ?? {};

  const setSipHeaders = (headers: Record<string, string>) =>
    updateContent({ sipHeaders: headers });

  const addSipHeader = () =>
    setSipHeaders({ ...sipHeaders, [`X-Header-${Date.now().toString(36)}`]: "" });

  const renameSipKey = (oldKey: string, newKey: string) => {
    // Rebuild preserving insertion order with key renamed in-place.
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(sipHeaders)) next[k === oldKey ? newKey : k] = v;
    setSipHeaders(next);
  };

  const setSipValue = (key: string, value: string) =>
    setSipHeaders({ ...sipHeaders, [key]: value });

  const removeSipHeader = (key: string) => {
    const next = { ...sipHeaders }; delete next[key]; setSipHeaders(next);
  };

  // When first switching to SIP, seed with standard headers so the user has
  // something to start from. They can rename, edit, or delete any of them.
  const handleTransferTypeChange = (type: "CONNECT" | "SIP") => {
    if (type === "SIP" && node.content?.sipHeaders === undefined) {
      updateContent({ transferType: type, sipHeaders: { ...INITIAL_SIP_HEADERS } });
    } else {
      updateContent({ transferType: type });
    }
  };

  // ── Predecessor / bypass ──────────────────────────────────────────────────

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
    for (const { nodeId, via } of predecessors) {
      const pred = { ...newNodes[nodeId] };
      if (via === "default_next") {
        pred.default_next = myNext;
      } else {
        pred.content = { ...pred.content, branches: { ...getBranches(pred), [via]: myNext } };
      }
      newNodes[nodeId] = pred;
    }
    setIR({ ...ir, nodes: newNodes });
  };

  // ── Text helpers ──────────────────────────────────────────────────────────

  /** Return the current text object, normalising string/undefined/object variants. */
  const getTextObj = (): Record<string, string> => {
    const t = node.content?.text;
    if (!t) return { eng: "" };
    if (typeof t === "string") return { eng: t };
    return t as Record<string, string>;
  };

  const setLangValue = (lang: string, value: string) =>
    updateContent({ text: { ...getTextObj(), [lang]: value } });

  const removeLang = (lang: string) => {
    const next = { ...getTextObj() };
    delete next[lang];
    updateContent({ text: next });
  };

  const addLang = (code: string) => {
    if (getTextObj()[code] !== undefined) return;
    updateContent({ text: { ...getTextObj(), [code]: "" } });
  };

  const renameLang = (oldCode: string, newCode: string) => {
    const current = getTextObj();
    if (!newCode || newCode === oldCode || current[newCode] !== undefined) return;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(current)) next[k === oldCode ? newCode : k] = v;
    updateContent({ text: next });
  };

  // ── Derived flags ─────────────────────────────────────────────────────────

  const isTextAction = node.action_type === "PLAY" || node.action_type === "GATHER";
  const isCheck = node.action_type === "CHECK";
  const isGather = node.action_type === "GATHER";
  const isStart = node.action_type === "START";
  const isComposite = COMPOSITE_TYPES.has(node.action_type);
  const isCurrentStart = ir.start_step === selectedId;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

      {/* Header */}
      <div className="editor-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="editor-header-label">Inspector</span>
          <ActionBadge action={node.action_type} />
          {isCurrentStart && (
            <span style={{
              fontSize: 9, fontFamily: "'IBM Plex Mono', monospace",
              background: "rgba(61,186,126,0.15)", border: "1px solid rgba(61,186,126,0.3)",
              color: "var(--green)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.05em",
            }}>START</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="editor-header-id">{selectedId}</span>
          {canSwap && (
            <button className="btn btn-ghost" onClick={swapWithPredecessor}
              style={{ padding: "2px 6px", height: 22, fontSize: 11 }}
              title={`Bypass — rewire ${predecessors.length} predecessor(s) directly to "${node.default_next}"`}
            >↑ Bypass</button>
          )}
          <button className="btn btn-ghost btn-danger" onClick={() => onDelete(selectedId)}
            style={{ padding: "2px 6px", height: 22, fontSize: 11 }}>Del</button>
          <button className="btn btn-ghost" onClick={() => onSelect(null)}
            style={{ padding: "2px 6px", height: 22, fontSize: 14 }}>×</button>
        </div>
      </div>

      {/* Composite warning */}
      {isComposite && (
        <div style={{
          margin: "0 12px", marginTop: 8, background: "rgba(61,142,240,0.06)",
          border: "1px solid rgba(61,142,240,0.25)", borderRadius: "var(--radius)",
          padding: "8px 12px", fontSize: 11, color: "var(--accent)", lineHeight: 1.6,
        }}>
          <b>Editor-only node.</b> MENU expands to GATHER + CHECK + retry logic at export time.
          To edit the generated atomics directly, export and re-import.
        </div>
      )}

      {/* Scrollable body */}
      <div className="editor-scroll">

        {/* ── Identity ── */}
        <div className="form-section">
          <div className="form-section-title">Identity</div>

          <div>
            <label className="form-label">Step ID</label>
            <div className="rename-row">
              <input className="input" value={localId}
                onChange={(e) => setLocalId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
                spellCheck={false} />
              <button className="btn btn-primary" onClick={handleRename} style={{ flex: "0 0 auto" }}>
                Rename
              </button>
            </div>
            {localId !== selectedId && localId && !ir.nodes[localId] && (
              <div style={{ fontSize: 10, color: "var(--green)", marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" }}>
                ↵ Enter or Rename to apply
              </div>
            )}
            {localId !== selectedId && ir.nodes[localId] && (
              <div style={{ fontSize: 10, color: "var(--red)", marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" }}>
                ✕ ID already exists
              </div>
            )}
          </div>

          <div>
            <label className="form-label">Label</label>
            <input className="input" value={node.label}
              onChange={(e) => updateNode({ label: e.target.value })} spellCheck={false} />
          </div>

          <div>
            <label className="form-label">Inbound edges</label>
            {predecessors.length === 0 ? (
              <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", padding: "3px 0" }}>
                None — {ir.start_step === selectedId ? "this is the start node" : "unreachable"}
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {predecessors.map(({ nodeId, via }) => (
                  <button key={`${nodeId}:${via}`} className="btn btn-ghost"
                    style={{ fontSize: 10, height: 20, padding: "0 6px", fontFamily: "'IBM Plex Mono', monospace" }}
                    onClick={() => onSelect(nodeId)} title={`Go to ${nodeId} (via ${via})`}>
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
            <select className="input" value={node.action_type}
              onChange={(e) => updateNode({ action_type: e.target.value as ActionType })}>
              {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              {COMPOSITE_TYPES.has(node.action_type) && (
                <option value={node.action_type}>{node.action_type} (editor composite)</option>
              )}
            </select>
          </div>

          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: isCurrentStart ? "rgba(61,186,126,0.08)" : "var(--bg-0)",
            border: `1px solid ${isCurrentStart ? "rgba(61,186,126,0.3)" : "var(--border)"}`,
            borderRadius: "var(--radius)", padding: "8px 12px",
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: isCurrentStart ? "var(--green)" : "var(--text-2)" }}>
                {isCurrentStart ? "✓ Entry Point" : "Entry Point"}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>
                {isCurrentStart ? "Flow begins here" : "First step callers reach"}
              </div>
            </div>
            {!isCurrentStart && (
              <button className="btn" style={{ fontSize: 10, height: 24, padding: "2px 10px" }}
                onClick={() => setIR({ ...ir, start_step: selectedId })}>Set as Start</button>
            )}
          </div>
        </div>

        {/* ── START info ── */}
        {isStart && (
          <div className="form-section">
            <div className="form-section-title">Start Node</div>
            <div style={{
              fontSize: 11, color: "var(--text-2)", lineHeight: 1.7,
              background: "var(--bg-0)", borderRadius: "var(--radius)",
              padding: "10px 12px", border: "1px solid var(--border)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}>
              Synthetic entry node generated from BEGIN.<br />
              <span style={{ color: "var(--text-3)", fontSize: 10 }}>
                Set <b>Default Next</b> below to the first real step.
              </span>
            </div>
          </div>
        )}

        {/* ── Prompt text (PLAY / GATHER) ── */}
        {isTextAction && (
          <div className="form-section">
            <div className="form-section-title" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <span>Prompt Text</span>
                <AddLangButton existing={Object.keys(getTextObj())} onAdd={addLang} />
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(getTextObj()).map(([code, val]) => (
                <LangTextRow
                  key={code}
                  langCode={code}
                  value={val}
                  onChange={v => setLangValue(code, v)}
                  onRename={newCode => renameLang(code, newCode)}
                  onRemove={Object.keys(getTextObj()).length > 1 ? () => removeLang(code) : undefined}
                />
              ))}
              {Object.keys(getTextObj()).length === 0 && (
                <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace" }}>
                  No languages — click + Add Language
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── GATHER config ── */}
        {isGather && (
          <div className="form-section">
            <div className="form-section-title">Gather Config</div>
            <div>
              <label className="form-label">Store result in variable</label>
              <input className="input" value={node.content?.variable ?? ""}
                onChange={(e) => updateContent({ variable: e.target.value })}
                placeholder="e.g. KPMAMenu_RES" spellCheck={false} />
              <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" }}>
                CHECK node reads this variable to route the call
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="form-label">Max Digits</label>
                <input className="input" type="number" min="1" max="20"
                  value={node.content?.num_digits ?? "1"}
                  onChange={(e) => updateContent({ num_digits: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="form-label">Timeout (sec)</label>
                <input className="input" type="number" min="1" max="30"
                  value={node.content?.timeout ?? "5"}
                  onChange={(e) => updateContent({ timeout: e.target.value })} />
              </div>
            </div>
          </div>
        )}

        {/* ── CHECK config ── */}
        {isCheck && (
          <div className="form-section">
            <div className="form-section-title">
              Check Mode
              <span style={{ fontSize: 9, color: "var(--text-3)", letterSpacing: "0.08em", marginLeft: 8 }}>
                {node.content?.var ? "VAR MODE" : "EXPRESSION MODE"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              <button className={`btn ${!node.content?.var ? "btn-primary" : ""}`}
                style={{ fontSize: 10, height: 24, padding: "2px 10px" }}
                onClick={() => updateContent({ var: undefined })}>Expression</button>
              <button className={`btn ${node.content?.var ? "btn-primary" : ""}`}
                style={{ fontSize: 10, height: 24, padding: "2px 10px" }}
                onClick={() => updateContent({ var: node.content?.var ?? "menu_var" })}>Variable</button>
            </div>
            {node.content?.var ? (
              <div>
                <label className="form-label">Branch on variable</label>
                <input className="input" value={node.content.var}
                  onChange={(e) => updateContent({ var: e.target.value })}
                  placeholder="e.g. KPMAMenu_RES" spellCheck={false} />
                <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" }}>
                  Branch keys below are matched against this variable's value.
                  Use <code style={{ color: "var(--cyan)" }}>null</code> for no-input / timeout.
                </div>
              </div>
            ) : (
              <div>
                <label className="form-label">
                  Expression{" "}
                  <span style={{ fontSize: 9, color: "var(--text-3)", fontWeight: 400 }}>— branches: True / False</span>
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

        {/* ── WAIT config ── */}
        {node.action_type === "WAIT" && (
          <div className="form-section">
            <div className="form-section-title">Wait Config</div>
            <div>
              <label className="form-label">Pause Duration (seconds)</label>
              <input className="input" type="number" min="1" max="120"
                value={node.content?.seconds ?? "1"}
                onChange={(e) => updateContent({ seconds: e.target.value })} />
              <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" }}>
                Emits <code style={{ color: "var(--cyan)" }}>&lt;Pause length="{node.content?.seconds ?? "1"}"&gt;</code>
              </div>
            </div>
          </div>
        )}

        {/* ── TRANSFER config ── */}
        {node.action_type === "TRANSFER" && (
          <div className="form-section">
            <div className="form-section-title">Transfer Config</div>

            <div>
              <label className="form-label">Type</label>
              <select className="input" value={node.content?.transferType ?? "CONNECT"}
                onChange={(e) => handleTransferTypeChange(e.target.value as "CONNECT" | "SIP")}>
                <option value="CONNECT">CONNECT (AWS Connect + DTMF)</option>
                <option value="SIP">SIP (PolyAI)</option>
              </select>
            </div>

            {node.content?.transferType === "CONNECT" && (
              <div>
                <label className="form-label">DTMF Digits</label>
                <input className="input" value={node.content?.digits ?? "{{uid}}"}
                  onChange={(e) => updateContent({ digits: e.target.value })}
                  placeholder="{{uid}}" spellCheck={false} />
              </div>
            )}

            {node.content?.transferType === "CONNECT" && node.content?.agentSkill && (
              <div style={{
                fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace",
                padding: "6px 10px", background: "var(--bg-0)",
                borderRadius: "var(--radius)", border: "1px solid var(--border)",
              }}>
                <div style={{ color: "var(--text-2)", marginBottom: 2 }}>CXone Agent Skill</div>
                <span style={{ color: "var(--orange)" }}>{node.content.agentSkill}</span>
                {node.content?.queueArn ? (
                  <div style={{ marginTop: 4, color: "var(--green)", fontSize: 9 }}>✓ Queue ARN: {node.content.queueArn}</div>
                ) : (
                  <div style={{ marginTop: 4, color: "var(--text-3)", fontSize: 9 }}>No queue ARN yet — provision in Skills &amp; Queues</div>
                )}
              </div>
            )}

            {/* SIP Headers — plain list, every row identical */}
            {node.content?.transferType === "SIP" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <label className="form-label" style={{ marginBottom: 0 }}>SIP Headers</label>
                  <button className="btn" style={{ fontSize: 10, height: 22, padding: "2px 10px", flexShrink: 0 }}
                    onClick={addSipHeader}>+ Add</button>
                </div>

                {Object.keys(sipHeaders).length === 0 && (
                  <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace" }}>
                    No headers — click + Add to define some
                  </div>
                )}

                {Object.entries(sipHeaders).map(([k, v]) => (
                  <SipHeaderRow
                    key={k}
                    headerKey={k}
                    value={v}
                    onRenameKey={renameSipKey}
                    onChangeValue={setSipValue}
                    onRemove={removeSipHeader}
                  />
                ))}

                <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.7 }}>
                  After PolyAI returns → <code style={{ color: "var(--cyan)" }}>default_next</code> step
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SET assignments ── */}
        {node.action_type === "SET" && (
          <div className="form-section">
            <div className="form-section-title">
              Assignments
              <button className="btn" style={{ fontSize: 10, height: 20, padding: "2px 8px" }}
                onClick={() => {
                  const key = `Var_${Date.now().toString(36)}`;
                  updateContent({ assignments: { ...(node.content?.assignments ?? {}), [key]: "" } });
                }}>+ Add</button>
            </div>
            {Object.keys(node.content?.assignments ?? {}).length === 0 && (
              <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", padding: "4px 0" }}>
                No assignments
              </div>
            )}
            {Object.entries(node.content?.assignments ?? {}).map(([k, v]) => (
              <div className="branch-row" key={k}>
                <div className="branch-key-row">
                  <span className="branch-key-label">Var</span>
                  <input className="branch-key-input" defaultValue={k} spellCheck={false}
                    onBlur={(e) => {
                      const nk = e.target.value.trim();
                      if (!nk || nk === k) return;
                      const a = { ...(node.content?.assignments ?? {}) };
                      const val = a[k]; delete a[k]; a[nk] = val;
                      updateContent({ assignments: a });
                    }} />
                  <button className="btn btn-ghost btn-danger"
                    style={{ padding: "1px 5px", height: 20, fontSize: 14, marginLeft: "auto" }}
                    onClick={() => {
                      const a = { ...(node.content?.assignments ?? {}) }; delete a[k];
                      updateContent({ assignments: a });
                    }}>×</button>
                </div>
                <div className="branch-target-row">
                  <span className="branch-target-label">=</span>
                  <input className="input" style={{ flex: 1, padding: "4px 8px" }} value={v}
                    onChange={(e) => updateContent({ assignments: { ...(node.content?.assignments ?? {}), [k]: e.target.value } })}
                    placeholder="value  or  var++  or  0" spellCheck={false} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Branches ── */}
        <div className="form-section">
          <div className="form-section-title">
            Branches
            <button className="btn" style={{ fontSize: 10, height: 20, padding: "2px 8px" }}
              onClick={addBranch}>+ Add</button>
          </div>
          {isCheck && node.content?.var && (
            <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>
              Keys match values of <code style={{ color: "var(--cyan)" }}>{node.content.var}</code>.
              Use <code style={{ color: "var(--cyan)" }}>null</code> for no-input.
            </div>
          )}
          {isCheck && !node.content?.var && (
            <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>
              Use keys <code style={{ color: "var(--cyan)" }}>True</code> and <code style={{ color: "var(--cyan)" }}>False</code>.
            </div>
          )}
          {Object.keys(branches).length === 0 && (
            <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace", padding: "6px 0" }}>
              No branches — terminal step
            </div>
          )}
          {Object.entries(branches).map(([key, target]) => (
            <div className="branch-row" key={key}>
              <div className="branch-key-row">
                <span className="branch-key-label">Key</span>
                <input className="branch-key-input" defaultValue={key} spellCheck={false}
                  onBlur={(e) => { const nk = e.target.value.trim(); if (nk && nk !== key) renameBranchKey(key, nk); }} />
                <button className="btn btn-ghost btn-danger"
                  style={{ padding: "1px 5px", height: 20, fontSize: 14, marginLeft: "auto" }}
                  onClick={() => removeBranch(key)}>×</button>
              </div>
              <div className="branch-target-row">
                <span className="branch-target-label">→</span>
                <NodePicker value={target} onChange={(id) => setBranchTarget(key, id)}
                  nodes={ir.nodes} selfId={selectedId} pickingActive={pickingBranch === key}
                  onStartPick={() => onStartPick((id) => setBranchTarget(key, id))} />
              </div>
            </div>
          ))}
        </div>

        {/* ── Default Next ── */}
        <div className="form-section">
          <div className="form-section-title">Default Next</div>
          <NodePicker
            value={node.default_next ?? ""}
            onChange={(id) => updateNode({ default_next: id || undefined })}
            nodes={ir.nodes} selfId={selectedId}
            pickingActive={pickingBranch === "__default_next__"}
            onStartPick={() => onStartPick((id) => updateNode({ default_next: id || undefined }))}
          />
        </div>

        {/* ── Debug ── */}
        <div className="debug-panel">
          <div className="debug-header" onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? "▾" : "▸"}&nbsp;&nbsp;RAW NODE DATA
          </div>
          {showDebug && <div className="debug-body">{JSON.stringify(node, null, 2)}</div>}
        </div>

      </div>
    </div>
  );
}