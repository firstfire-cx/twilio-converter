// src/components/Toolbar.tsx
import { useState } from "react";
import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { IR, FlowMeta, IVRNode } from "../types";
import { exportCSV, importCSV, expandAllMenus } from "../utils/csv";
import { convertCxJson } from "../converter/convertCXJson";
import { type AwsCredentials, type UseAwsCredentialsReturn } from "../hooks/useAwsCredentials";
import { downloadProject, parseProject, type IVRProject } from "../project";
import AwsAuthModal from "./AwsAuthModal";
import type { TabData } from "../App";
import { ACCOUNT_TAB_ID } from "../App";

// ── Constants ────────────────────────────────────────────────────────────────

const FLOW_TABLE = "TwilioIVRFlows";

const ATOMIC_TYPES = new Set([
  "START", "PLAY", "GATHER", "CHECK", "SET", "TRANSFER", "HANGUP", "HOURS", "WAIT",
]);

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  ir: IR;
  meta: Partial<FlowMeta>;
  setMeta: (m: Partial<FlowMeta>) => void;
  setIR: (ir: IR) => void;
  setIRWithCx?: (ir: IR, cx: any) => void;
  undo: () => void;
  redo: () => void;
  onAddNode: () => void;
  onShowSkills: () => void;
  onShowPostProcess: () => void;
  auth: UseAwsCredentialsReturn;
  currentProject: () => IVRProject;
  onProjectLoaded: (project: IVRProject) => void;
  disabled?: boolean;
  // Tab strip
  tabs: TabData[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
  onTabAdd: () => void;
  onTabClose: (id: string, e: React.MouseEvent) => void;
  showAccountTab: boolean;
  onShowAccount: () => void;
  isAccountTab: boolean;
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

function buildDocClient(creds: AwsCredentials): DynamoDBDocumentClient {
  const cfg: DynamoDBClientConfig = {
    region: creds.region || "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
    ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
  };
  return DynamoDBDocumentClient.from(new DynamoDBClient(cfg), {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });
}

async function writeMeta(client: DynamoDBDocumentClient, meta: FlowMeta): Promise<void> {
  const item: Record<string, any> = {
    flow_id: meta.dialed_number,
    step_id: "META",
    target_flow_id: meta.target_flow_id,
    start_step: meta.start_step,
  };
  if (meta.hoo_arn) item.hoo_arn = meta.hoo_arn;
  if (meta.instance_id) item.instance_id = meta.instance_id;
  if (meta.description) item.description = meta.description;
  await client.send(new PutCommand({ TableName: FLOW_TABLE, Item: item }));
}

async function writeSteps(
  client: DynamoDBDocumentClient,
  flowId: string,
  steps: IVRNode[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const n = steps[i];
    const item: Record<string, any> = {
      flow_id: flowId,
      step_id: n.step_id,
      action_type: n.action_type,
      label: n.label ?? "",
      content: n.content ?? {},
    };
    if (n.default_next) item.default_next = n.default_next;
    await client.send(new PutCommand({ TableName: FLOW_TABLE, Item: item }));
    onProgress?.(i + 1, steps.length);
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateBranches(nodes: Record<string, IVRNode>): string[] {
  const errors: string[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    const targets = [node.default_next, ...Object.values(node.content?.branches ?? {})]
      .filter(Boolean) as string[];
    for (const t of targets) {
      if (t !== "END" && !nodes[t])
        errors.push(`"${id}" (${node.action_type}) → dangling target "${t}"`);
    }
  }
  return errors;
}

function buildAtomicSteps(ir: IR): IVRNode[] {
  return Object.values(expandAllMenus(ir)).filter(n => {
    if (!ATOMIC_TYPES.has(n.action_type)) {
      console.warn(`[Export] Skipping non-atomic ${n.step_id} (${n.action_type})`);
      return false;
    }
    return true;
  });
}

// ── FlowMeta Modal ───────────────────────────────────────────────────────────

function FlowMetaModal({ ir, creds, initialMeta, onClose, onUpload }: {
  ir: IR;
  creds: AwsCredentials;
  initialMeta?: Partial<FlowMeta>;
  onClose: () => void;
  onUpload: (meta: FlowMeta) => Promise<void>;
}) {
  const [meta, setMeta] = useState<FlowMeta>({
    dialed_number: initialMeta?.dialed_number ?? "",
    target_flow_id: initialMeta?.target_flow_id ?? ir.flow_id,
    start_step: initialMeta?.start_step ?? ir.start_step ?? Object.keys(ir.nodes)[0] ?? "start",
    hoo_arn: initialMeta?.hoo_arn ?? "",
    instance_id: initialMeta?.instance_id ?? "",
    description: initialMeta?.description ?? "",
  });
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const [statusMsg, setStatusMsg] = useState("");

  const INPUT: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "var(--bg-0)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text-0)",
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    padding: "6px 10px", outline: "none",
  };
  const LABEL: React.CSSProperties = {
    fontSize: 10, color: "var(--text-2)", fontWeight: 500,
    marginBottom: 4, display: "block", fontFamily: "'IBM Plex Sans', sans-serif",
  };

  const handleUpload = async () => {
    if (!meta.dialed_number) { setStatus("err"); setStatusMsg("Dialed number is required"); return; }
    const steps = buildAtomicSteps(ir);
    const atomicMap = Object.fromEntries(steps.map(n => [n.step_id, n]));
    const errs = validateBranches(atomicMap);
    if (errs.length > 0) {
      setStatus("err");
      setStatusMsg(`${errs.length} dangling branch target(s):\n` + errs.slice(0, 3).join("\n") +
        (errs.length > 3 ? `\n…and ${errs.length - 3} more` : ""));
      return;
    }
    setUploading(true); setProgress(null); setStatus("idle");
    try {
      const client = buildDocClient(creds);
      await writeMeta(client, meta);
      await writeSteps(client, meta.target_flow_id, steps, (done, total) => setProgress({ done, total }));
      setStatus("ok");
      setStatusMsg(`Uploaded ${steps.length} steps + META for ${meta.dialed_number}`);
      setProgress(null);
    } catch (e: any) {
      setStatus("err"); setStatusMsg(e.message ?? "Upload failed"); setProgress(null);
    } finally { setUploading(false); }
  };

  const metaFields: { key: keyof FlowMeta; label: string; hint: string }[] = [
    { key: "dialed_number", label: "Dialed Number", hint: "E.164 — DDB partition key" },
    { key: "target_flow_id", label: "Target Flow ID", hint: "Matches IR flow_id" },
    { key: "start_step", label: "Start Step ID", hint: "First node callers reach" },
    { key: "hoo_arn", label: "HOO ARN (optional)", hint: "Connect Hours of Operation ARN" },
    { key: "instance_id", label: "Connect Instance ID (opt.)", hint: "Overrides INSTANCE_ID env var" },
    { key: "description", label: "Description (optional)", hint: "Human label" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-hi)", borderRadius: "var(--radius-lg)", width: 520, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 48px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-3)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ background: "rgba(61,142,240,0.15)", border: "1px solid rgba(61,142,240,0.3)", borderRadius: 3, padding: "2px 7px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, color: "var(--accent)", letterSpacing: "0.05em" }}>DYNAMODB</span>
            <span style={{ fontSize: 12, color: "var(--text-1)", fontWeight: 500 }}>Upload Flow</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--green)", fontFamily: "'IBM Plex Mono', monospace", background: "rgba(61,186,126,0.1)", border: "1px solid rgba(61,186,126,0.25)", borderRadius: "var(--radius)", padding: "2px 7px" }}>
              ● {creds.source === "sso" ? `SSO: ${creds.identity ?? "authenticated"}` : "manual keys"}
            </span>
            <button className="btn btn-ghost" onClick={onClose} style={{ padding: "2px 6px", height: 22, fontSize: 14 }}>×</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {metaFields.map(({ key, label, hint }) => (
            <div key={key}>
              <label style={LABEL}>{label}</label>
              <input style={INPUT} value={(meta[key] as string) ?? ""}
                onChange={e => setMeta(m => ({ ...m, [key]: e.target.value }))}
                placeholder={hint} spellCheck={false} />
            </div>
          ))}
        </div>
        {progress && (
          <div style={{ padding: "0 16px 8px" }}>
            <div style={{ height: 4, background: "var(--bg-0)", borderRadius: 2, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ height: "100%", width: `${Math.round((progress.done / progress.total) * 100)}%`, background: "var(--accent)", transition: "width 0.1s linear" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-2)", marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" }}>
              Writing step {progress.done} / {progress.total}…
            </div>
          </div>
        )}
        {status !== "idle" && (
          <div style={{ padding: "8px 16px", background: status === "ok" ? "rgba(61,186,126,0.08)" : "rgba(224,90,90,0.08)", borderTop: `1px solid ${status === "ok" ? "rgba(61,186,126,0.2)" : "rgba(224,90,90,0.2)"}`, fontSize: 11, color: status === "ok" ? "var(--green)" : "var(--red)", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "pre-wrap" }}>
            {status === "ok" ? "✓ " : "✕ "}{statusMsg}
          </div>
        )}
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "flex-end", background: "var(--bg-3)", gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleUpload} disabled={uploading}>
            {uploading ? "Uploading…" : "Upload Flow + Meta"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Metadata Editor Modal ────────────────────────────────────────────────────

function MetadataEditorModal({ ir, currentMeta, onClose, onSave }: {
  ir: IR;
  currentMeta?: Partial<FlowMeta>;
  onClose: () => void;
  onSave: (meta: Partial<FlowMeta>) => void;
}) {
  const [meta, setMeta] = useState<Partial<FlowMeta>>(currentMeta || {
    dialed_number: "",
    target_flow_id: ir.flow_id,
    start_step: ir.start_step ?? Object.keys(ir.nodes)[0] ?? "start",
    hoo_arn: ir.hoo_arn,
    instance_id: "",
    description: "",
  });

  const INPUT: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "var(--bg-0)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text-0)",
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    padding: "6px 10px", outline: "none",
  };
  const LABEL: React.CSSProperties = {
    fontSize: 10, color: "var(--text-2)", fontWeight: 500,
    marginBottom: 4, display: "block", fontFamily: "'IBM Plex Sans', sans-serif",
  };

  const fields: { key: keyof FlowMeta; label: string; hint: string }[] = [
    { key: "dialed_number", label: "Dialed Number", hint: "Phone number (DDB partition key)" },
    { key: "target_flow_id", label: "Target Flow ID", hint: "Flow name to load" },
    { key: "start_step", label: "Start Step", hint: "First step ID" },
    { key: "hoo_arn", label: "HOO ARN", hint: "Hours of Operation ARN or UUID" },
    { key: "instance_id", label: "Instance ID", hint: "Connect instance ID" },
    { key: "description", label: "Description", hint: "Human-readable label" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-hi)", borderRadius: "var(--radius-lg)", width: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 48px rgba(0,0,0,0.5)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-3)" }}>
          <span style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 600 }}>Flow Metadata</span>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: "2px 6px", height: 22, fontSize: 14 }}>×</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {fields.map(f => (
            <div key={f.key} style={{ marginBottom: 14 }}>
              <label style={LABEL}>{f.label} <span style={{ color: "var(--text-3)", marginLeft: 4 }}>— {f.hint}</span></label>
              <input style={INPUT} value={(meta[f.key] as string) ?? ""}
                onChange={e => setMeta({ ...meta, [f.key]: e.target.value })}
                placeholder={f.hint} />
            </div>
          ))}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "flex-end", background: "var(--bg-3)", gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onSave(meta); onClose(); }}>Save Metadata</button>
        </div>
      </div>
    </div>
  );
}

// ── Tab Strip ────────────────────────────────────────────────────────────────

function TabStrip({ tabs, activeTabId, onTabSelect, onTabAdd, onTabClose, showAccountTab, onShowAccount, isAccountTab }: {
  tabs: TabData[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
  onTabAdd: () => void;
  onTabClose: (id: string, e: React.MouseEvent) => void;
  showAccountTab: boolean;
  onShowAccount: () => void;
  isAccountTab: boolean;
}) {
  return (
    <div className="tab-strip">
      {/* Flow tabs */}
      {tabs.map(tab => {
        const isActive = tab.id === activeTabId && !isAccountTab;
        const nodeCount = tab.irHistory[tab.irIndex]?.nodes
          ? Object.keys(tab.irHistory[tab.irIndex].nodes).length
          : 0;
        return (
          <div
            key={tab.id}
            className={`tab-item ${isActive ? "tab-item-active" : ""}`}
            onClick={() => onTabSelect(tab.id)}
            title={tab.label}
          >
            <span className="tab-label">
              {tab.label}
            </span>
            {nodeCount > 0 && (
              <span className="tab-count">{nodeCount}</span>
            )}
            {tab.dirty && <span className="tab-dirty">●</span>}
            <button
              className="tab-close"
              onClick={e => onTabClose(tab.id, e)}
              title="Close tab"
            >×</button>
          </div>
        );
      })}

      {/* Add tab */}
      <button className="tab-add" onClick={onTabAdd} title="New flow tab">+</button>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Account tab */}
      {showAccountTab && (
        <div
          className={`tab-item tab-item-account ${isAccountTab ? "tab-item-active" : ""}`}
          onClick={onShowAccount}
          title="AWS account & batch operations"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M6.5 16.5C4 15.3 2 12.8 2 10c0-4.4 3.6-8 8-8 2.5 0 4.7 1.1 6.2 2.9"
              stroke="var(--orange)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M17.5 7.5C20 8.7 22 11.2 22 14c0 4.4-3.6 8-8 8-2.5 0-4.7-1.1-6.2-2.9"
              stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          AWS Account
        </div>
      )}
    </div>
  );
}

// ── Main Toolbar ─────────────────────────────────────────────────────────────

export default function Toolbar({
  ir, meta, setMeta, setIR, setIRWithCx, undo, redo,
  onAddNode, onShowSkills, onShowPostProcess, auth,
  currentProject, onProjectLoaded, disabled,
  tabs, activeTabId, onTabSelect, onTabAdd, onTabClose,
  showAccountTab, onShowAccount, isAccountTab,
}: Props) {
  const nodeCount = Object.keys(ir.nodes).length;
  const compositeCount = Object.values(ir.nodes).filter(n => !ATOMIC_TYPES.has(n.action_type)).length;

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showMetaEditor, setShowMetaEditor] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "ok" | "err">("idle");
  const [showExportMenu, setShowExportMenu] = useState(false);

  const credReady = auth.authStep === "ready";
  const dynColor = uploadStatus === "ok" ? "var(--green)" : uploadStatus === "err" ? "var(--red)" : "var(--text-2)";

  const handleUploadClick = () => {
    if (auth.authStep === "ready") setShowUploadModal(true);
    else auth.setAuthStep("sso-url");
  };

  const handleOpen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      try {
        if (file.name.endsWith(".csv")) {
          setIR(importCSV(text));
        } else {
          const parsed = JSON.parse(text);
          if (parsed.ir && parsed.version !== undefined) {
            onProjectLoaded(parseProject(text));
          } else if (Array.isArray(parsed) && parsed[0]?.step_id && parsed[0]?.action_type) {
            const nodes: Record<string, any> = {};
            let start: string | undefined;
            for (const row of parsed) {
              nodes[row.step_id] = row;
              if (row.action_type === "START" && !start) start = row.step_id;
            }
            setIR({ flow_id: parsed[0]?.flow_id ?? "imported", nodes, start_step: start ?? parsed[0]?.step_id });
          } else {
            const converted = convertCxJson(parsed);
            if (setIRWithCx) setIRWithCx(converted, parsed);
            else setIR(converted);
          }
        }
      } catch (err) {
        alert("Failed to open: " + (err as any).message);
      }
    };
    reader.readAsText(file);
  };

  const handleMetadataSave = (newMeta: Partial<FlowMeta>) => {
    setMeta(newMeta);
    setIR({
      ...ir,
      meta: newMeta,
      hoo_arn: newMeta.hoo_arn || ir.hoo_arn,
      flow_id: newMeta.target_flow_id || ir.flow_id,
      start_step: newMeta.start_step || ir.start_step,
    });
    if (newMeta.instance_id && newMeta.instance_id !== auth.credentials?.instance_id) {
      if (auth.credentials) auth.setManual({ ...auth.credentials, instance_id: newMeta.instance_id });
    }
  };

  const downloadCSV = () => {
    const blob = new Blob([exportCSV(ir)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ir.flow_id}.csv`;
    a.click();
  };

  const downloadJSON = () => {
    const steps = buildAtomicSteps(ir);
    const atomicMap = Object.fromEntries(steps.map(n => [n.step_id, n]));
    const errs = validateBranches(atomicMap);
    if (errs.length > 0) {
      const msg = [`⚠ ${errs.length} dangling branch target(s):`, ...errs.slice(0, 5).map(e => `  • ${e}`), ...(errs.length > 5 ? [`  …and ${errs.length - 5} more`] : []), "", "Export anyway?"].join("\n");
      if (!window.confirm(msg)) return;
    }
    const payload = steps.map(n => ({
      flow_id: ir.flow_id, step_id: n.step_id, action_type: n.action_type,
      label: n.label, content: n.content ?? {}, default_next: n.default_next ?? null,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ir.flow_id}.json`;
    a.click();
  };

  return (
    <>
      {/* ── Main toolbar bar ── */}
      <header className="toolbar">
        <div className="toolbar-brand">
          <div className="toolbar-logo">IVR</div>
          <span className="toolbar-title">Flow Editor</span>
          {!isAccountTab && ir.flow_id && (
            <span className="toolbar-flow-id">{ir.flow_id}</span>
          )}
          {!isAccountTab && ir.start_step && (
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "var(--green)", background: "rgba(61,186,126,0.1)", border: "1px solid rgba(61,186,126,0.25)", borderRadius: "var(--radius)", padding: "1px 6px" }}>
              ▶ {ir.start_step}
            </span>
          )}
        </div>

        <div className="toolbar-divider" />

        {/* AWS auth button — always visible */}
        {!credReady ? (
          <button
            className="btn"
            onClick={() => auth.setAuthStep("sso-url")}
            style={{ borderColor: "rgba(232,149,90,0.4)", color: "var(--orange)" }}
            title="Connect to AWS"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path d="M6.5 16.5C4 15.3 2 12.8 2 10c0-4.4 3.6-8 8-8" stroke="var(--orange)" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M17.5 7.5C20 8.7 22 11.2 22 14c0 4.4-3.6 8-8 8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Connect AWS
          </button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: "var(--green)", fontFamily: "'IBM Plex Mono', monospace", background: "rgba(61,186,126,0.08)", border: "1px solid rgba(61,186,126,0.2)", borderRadius: "var(--radius)", padding: "2px 8px" }}>
              ● {auth.credentials?.source === "sso"
                ? (auth.credentials.identity?.split("/")[1]?.trim() ?? "SSO")
                : "manual"}
            </span>
            <button className="btn btn-ghost" onClick={auth.logout}
              style={{ fontSize: 10, padding: "2px 6px", height: 22 }}
              title="Sign out of AWS">
              Sign out
            </button>
          </div>
        )}

        {!isAccountTab && !disabled && (
          <>
            <div className="toolbar-divider" />

            <button className="btn" onClick={undo} title="Undo">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 4h5a3 3 0 010 6H4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M4 2L2 4l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Undo
            </button>
            <button className="btn" onClick={redo} title="Redo">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M10 4H5a3 3 0 000 6h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M8 2l2 2-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Redo
            </button>

            <div className="toolbar-divider" />

            <button className="btn" onClick={onAddNode}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Add Node
            </button>

            {nodeCount > 0 && (
              <>
                <button className="btn" onClick={onShowSkills}
                  style={{ borderColor: "var(--purple)", color: "var(--purple)" }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6a4 4 0 108 0 4 4 0 00-8 0" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M6 4v2l1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  Skills &amp; Queues
                </button>
                <button className="btn" onClick={onShowPostProcess}
                  style={{ borderColor: "var(--cyan)", color: "var(--cyan)" }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M2 2h3v3H2zM7 2h3v3H7zM2 7h3v3H2zM7 7h3v3H7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                  Post-Process
                </button>
                <button className="btn" onClick={() => setShowMetaEditor(true)} title="Edit flow metadata">
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M2 5h8M5 2v8" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                  Metadata
                </button>
              </>
            )}
          </>
        )}

        <div className="toolbar-divider" />

        {/* Open */}
        <label className="btn" title="Open project, CXone JSON, or CSV">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M1 3a1 1 0 011-1h3l1 1.5H10a1 1 0 011 1V9a1 1 0 01-1 1H2a1 1 0 01-1-1V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          Open
          <input type="file" accept=".csv,.json,.ivrproj.json" onChange={handleOpen} style={{ display: "none" }} />
        </label>

        {/* Save */}
        {!isAccountTab && (
          <button className="btn" onClick={() => downloadProject(currentProject())}
            disabled={nodeCount === 0}
            title="Save as .ivrproj.json">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <rect x="2" y="1" width="8" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="4" y="1" width="4" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
              <rect x="3" y="6" width="6" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            Save
          </button>
        )}

        <div className="toolbar-spacer" />

        {!isAccountTab && (
          <span className="status-item">
            <span className="status-dot" style={{ background: nodeCount > 0 ? "var(--green)" : "var(--text-3)" }} />
            {nodeCount} node{nodeCount !== 1 ? "s" : ""}
            {compositeCount > 0 && (
              <span style={{ marginLeft: 4, color: "var(--orange)", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace" }}
                title={`${compositeCount} MENU node(s) expand on export`}>
                ({compositeCount} composite)
              </span>
            )}
          </span>
        )}

        <div className="toolbar-divider" />

        {/* Export */}
        {!isAccountTab && (
          <div style={{ position: "relative" }}>
            <button className="btn btn-primary" disabled={nodeCount === 0}
              onClick={() => setShowExportMenu(v => !v)}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v7M3 6l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export ▾
            </button>
            {showExportMenu && (
              <div onClick={() => setShowExportMenu(false)} style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 50, background: "var(--bg-2)", border: "1px solid var(--border-hi)", borderRadius: "var(--radius)", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 180, overflow: "hidden" }}>
                <button className="btn" onClick={downloadJSON} style={{ width: "100%", justifyContent: "flex-start", borderRadius: 0, border: "none", borderBottom: "1px solid var(--border)" }}>
                  Engine JSON
                </button>
                <button className="btn" onClick={downloadCSV} style={{ width: "100%", justifyContent: "flex-start", borderRadius: 0, border: "none", borderBottom: "1px solid var(--border)" }}>
                  CSV
                </button>
                <button className="btn" onClick={handleUploadClick} style={{ width: "100%", justifyContent: "flex-start", borderRadius: 0, border: "none", color: dynColor }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <ellipse cx="6" cy="3.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M1 3.5v5C1 9.6 3.24 10.5 6 10.5s5-.9 5-2V3.5" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                  {uploadStatus === "ok" ? "✓ Uploaded" : credReady ? "Upload to DynamoDB" : "Connect AWS →"}
                </button>
              </div>
            )}
          </div>
        )}

        {showExportMenu && (
          <div style={{ position: "fixed", inset: 0, zIndex: 49 }} onClick={() => setShowExportMenu(false)} />
        )}
      </header>

      {/* ── Tab strip ── */}
      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={onTabSelect}
        onTabAdd={onTabAdd}
        onTabClose={onTabClose}
        showAccountTab={showAccountTab}
        onShowAccount={onShowAccount}
        isAccountTab={isAccountTab}
      />

      {/* ── Modals ── */}
      {auth.authStep !== "idle" && auth.authStep !== "ready" && (
        <AwsAuthModal auth={auth} onClose={() => auth.setAuthStep("idle")} />
      )}

      {showMetaEditor && (
        <MetadataEditorModal
          ir={ir}
          currentMeta={meta}
          onClose={() => setShowMetaEditor(false)}
          onSave={handleMetadataSave}
        />
      )}

      {showUploadModal && auth.credentials && (
        <FlowMetaModal
          ir={ir}
          creds={auth.credentials}
          initialMeta={meta}
          onClose={() => setShowUploadModal(false)}
          onUpload={async () => { setShowUploadModal(false); }}
        />
      )}
    </>
  );
}
