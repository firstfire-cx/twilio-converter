// src/components/Toolbar.tsx
import { useState } from "react";
import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { IR, FlowMeta, IVRNode } from "../types";
import { exportCSV, importCSV, expandAllMenus } from "../utils/csv";
import { convertCxJson } from "../converter/convertCXJson";
import { type AwsCredentials, type UseAwsCredentialsReturn } from "../hooks/useAwsCredentials";
import {
  downloadProject, parseProject,
  type IVRProject,
} from "../project";
import AwsAuthModal from "./AwsAuthModal";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOW_TABLE = "TwilioIVRFlows";

const ATOMIC_TYPES = new Set([
  "START", "PLAY", "GATHER", "CHECK", "SET",
  "TRANSFER", "HANGUP", "HOURS", "WAIT",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  auth: UseAwsCredentialsReturn;
  /** Returns the current full project (IR + meta + queues + hoo) for saving */
  currentProject: () => IVRProject;
  /** Called when a project file is loaded — restores all state */
  onProjectLoaded: (project: IVRProject) => void;
}

interface FlowMetaModalProps {
  ir: IR;
  creds: AwsCredentials;
  initialMeta?: Partial<FlowMeta>;
  onClose: () => void;
  onUpload: (meta: FlowMeta) => Promise<void>;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
  return Object.values(expandAllMenus(ir)).filter((n) => {
    if (!ATOMIC_TYPES.has(n.action_type)) {
      console.warn(`[Export] Skipping non-atomic ${n.step_id} (${n.action_type})`);
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// FlowMeta modal (no credential fields — creds come from the hook)
// ---------------------------------------------------------------------------

function FlowMetaModal({ ir, creds, initialMeta, onClose, onUpload }: FlowMetaModalProps) {
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

  const handleUpload = async () => {
    if (!meta.dialed_number) {
      setStatus("err"); setStatusMsg("Dialed number is required"); return;
    }
    // Validate
    const steps = buildAtomicSteps(ir);
    const atomicMap = Object.fromEntries(steps.map((n) => [n.step_id, n]));
    const branchErrors = validateBranches(atomicMap);
    if (branchErrors.length > 0) {
      setStatus("err");
      setStatusMsg(
        `${branchErrors.length} dangling branch target(s):\n` +
        branchErrors.slice(0, 3).join("\n") +
        (branchErrors.length > 3 ? `\n…and ${branchErrors.length - 3} more` : ""),
      );
      return;
    }

    setUploading(true); setProgress(null); setStatus("idle");
    try {
      const client = buildDocClient(creds);
      await writeMeta(client, meta);
      await writeSteps(client, meta.target_flow_id, steps, (done, total) =>
        setProgress({ done, total }),
      );
      setStatus("ok");
      setStatusMsg(`Uploaded ${steps.length} steps + META for ${meta.dialed_number}`);
      setProgress(null);
    } catch (e: any) {
      setStatus("err");
      setStatusMsg(e.message ?? "Upload failed");
      setProgress(null);
    } finally {
      setUploading(false);
    }
  };

  const downloadMeta = () => {
    const blob = new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ir.flow_id}_meta.json`;
    a.click();
  };

  const INPUT: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "var(--bg-0)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text-0)",
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    padding: "6px 10px", outline: "none",
  };
  const LABEL: React.CSSProperties = {
    fontSize: 10, color: "var(--text-2)", fontWeight: 500,
    marginBottom: 4, display: "block",
    fontFamily: "'IBM Plex Sans', sans-serif",
  };

  const metaFields: { key: keyof FlowMeta; label: string; hint: string }[] = [
    { key: "dialed_number", label: "Dialed Number", hint: "E.164 — e.g. +18005551234 (DDB partition key)" },
    { key: "target_flow_id", label: "Target Flow ID", hint: "Which flow rows to load — matches flow name / CSV" },
    { key: "start_step", label: "Start Step ID", hint: "First node callers reach (default: start)" },
    { key: "hoo_arn", label: "HOO ARN (optional)", hint: "Connect Hours of Operation ARN or UUID" },
    { key: "instance_id", label: "Connect Instance ID (opt.)", hint: "Overrides INSTANCE_ID env var on the Lambda" },
    { key: "description", label: "Description (optional)", hint: "Human label — not used by the engine" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center"
    }}>
      <div style={{
        background: "var(--bg-2)", border: "1px solid var(--border-hi)",
        borderRadius: "var(--radius-lg)", width: 520, maxHeight: "85vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 24px 48px rgba(0,0,0,0.6)"
      }}>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-3)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              background: "rgba(61,142,240,0.15)", border: "1px solid rgba(61,142,240,0.3)",
              borderRadius: 3, padding: "2px 7px", fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10, fontWeight: 600, color: "var(--accent)", letterSpacing: "0.05em"
            }}>
              DYNAMODB
            </span>
            <span style={{ fontSize: 12, color: "var(--text-1)", fontWeight: 500 }}>Upload Flow</span>
          </div>
          {/* Credential badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontSize: 10, color: "var(--green)", fontFamily: "'IBM Plex Mono', monospace",
              background: "rgba(61,186,126,0.1)", border: "1px solid rgba(61,186,126,0.25)",
              borderRadius: "var(--radius)", padding: "2px 7px"
            }}>
              ● {creds.source === "sso" ? `SSO: ${creds.identity ?? "authenticated"}` : "manual keys"}
            </span>
            <button className="btn btn-ghost" onClick={onClose}
              style={{ padding: "2px 6px", height: 22, fontSize: 14 }}>×</button>
          </div>
        </div>

        {/* Fields */}
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            fontSize: 11, color: "var(--text-2)", lineHeight: 1.6,
            background: "var(--bg-0)", borderRadius: "var(--radius)",
            padding: "8px 12px", border: "1px solid var(--border)"
          }}>
            Stored as a <code style={{ fontFamily: "'IBM Plex Mono', monospace", color: "var(--cyan)", fontSize: 10 }}>META</code> row
            keyed by <code style={{ fontFamily: "'IBM Plex Mono', monospace", color: "var(--cyan)", fontSize: 10 }}>dialed_number</code>.
            Maps inbound calls to the correct flow + hours of operation.
          </div>

          {metaFields.map(({ key, label, hint }) => (
            <div key={key}>
              <label style={LABEL}>{label}</label>
              <input style={INPUT} value={(meta[key] as string) ?? ""}
                onChange={(e) => setMeta((m) => ({ ...m, [key]: e.target.value }))}
                placeholder={hint} spellCheck={false} />
            </div>
          ))}
        </div>

        {/* Progress */}
        {progress && (
          <div style={{ padding: "0 16px 8px" }}>
            <div style={{
              height: 4, background: "var(--bg-0)", borderRadius: 2,
              overflow: "hidden", border: "1px solid var(--border)"
            }}>
              <div style={{
                height: "100%",
                width: `${Math.round((progress.done / progress.total) * 100)}%`,
                background: "var(--accent)", transition: "width 0.1s linear"
              }} />
            </div>
            <div style={{
              fontSize: 10, color: "var(--text-2)", marginTop: 4,
              fontFamily: "'IBM Plex Mono', monospace"
            }}>
              Writing step {progress.done} / {progress.total}…
            </div>
          </div>
        )}

        {/* Status */}
        {status !== "idle" && (
          <div style={{
            padding: "8px 16px",
            background: status === "ok" ? "rgba(61,186,126,0.08)" : "rgba(224,90,90,0.08)",
            borderTop: `1px solid ${status === "ok" ? "rgba(61,186,126,0.2)" : "rgba(224,90,90,0.2)"}`,
            fontSize: 11, color: status === "ok" ? "var(--green)" : "var(--red)",
            fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "pre-wrap", wordBreak: "break-word"
          }}>
            {status === "ok" ? "✓ " : "✕ "}{statusMsg}
          </div>
        )}

        {/* Footer */}
        <div style={{
          padding: "12px 16px", borderTop: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--bg-3)", gap: 8
        }}>
          <button className="btn" onClick={downloadMeta} title="Download metadata as JSON">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v7M3 6l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export Meta JSON
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleUpload} disabled={uploading}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <ellipse cx="6" cy="3.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M1 3.5v5C1 9.6 3.24 10.5 6 10.5s5-.9 5-2V3.5" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              {uploading ? "Uploading…" : "Upload Flow + Meta"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata Editor Modal
// ---------------------------------------------------------------------------

function MetadataEditorModal({ ir, currentMeta, onClose, onSave }: {
  ir: IR;
  currentMeta?: Partial<FlowMeta>;
  onClose: () => void;
  onSave: (meta: Partial<FlowMeta>) => void;
}) {
  const [meta, setMeta] = useState<Partial<FlowMeta>>(currentMeta || ir.meta || {
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
    marginBottom: 4, display: "block",
    fontFamily: "'IBM Plex Sans', sans-serif",
  };

  const metaFields: { key: keyof FlowMeta; label: string; hint: string }[] = [
    { key: "dialed_number", label: "Dialed Number", hint: "Phone number (DDB partition key)" },
    { key: "target_flow_id", label: "Target Flow ID", hint: "Flow name to load (matches IR.flow_id)" },
    { key: "start_step", label: "Start Step", hint: "First step ID (default: 'start')" },
    { key: "hoo_arn", label: "HOO ARN", hint: "Hours of Operation ARN or UUID" },
    { key: "instance_id", label: "Instance ID", hint: "Connect instance ID" },
    { key: "description", label: "Description", hint: "Human-readable label" },
  ];

  const handleSave = () => {
    onSave(meta);
    onClose();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--bg-2)", border: "1px solid var(--border-hi)",
        borderRadius: "var(--radius-lg)", width: 520, maxHeight: "80vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-3)",
        }}>
          <span style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 600 }}>Flow Metadata</span>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: "2px 6px", height: 22, fontSize: 14 }}>×</button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {metaFields.map(f => (
            <div key={f.key} style={{ marginBottom: 14 }}>
              <label style={LABEL}>
                {f.label}
                <span style={{ color: "var(--text-3)", marginLeft: 4 }}>— {f.hint}</span>
              </label>
              <input
                style={INPUT}
                value={(meta[f.key] as string) ?? ""}
                onChange={(e) => setMeta({ ...meta, [f.key]: e.target.value })}
                placeholder={f.hint}
              />
            </div>
          ))}
        </div>

        <div style={{
          padding: "10px 16px", borderTop: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          background: "var(--bg-3)", gap: 8,
        }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Metadata</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Toolbar
// ---------------------------------------------------------------------------

export default function Toolbar({
  ir, meta, setMeta, setIR, setIRWithCx, undo, redo, onAddNode, onShowSkills, auth,
  currentProject, onProjectLoaded,
}: Props) {
  const nodeCount = Object.keys(ir.nodes).length;
  const compositeCount = Object.values(ir.nodes).filter((n) => !ATOMIC_TYPES.has(n.action_type)).length;

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showMetaEditor, setShowMetaEditor] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "ok" | "err">("idle");

  const handleUploadClick = () => {
    if (auth.authStep === "ready") {
      setShowUploadModal(true);
    } else {
      auth.setAuthStep("sso-url");
    }
  };

  // Save full project (IR + meta + queues + hoo)
  const saveProject = () => {
    downloadProject(currentProject());
  };

  // Load project — fully restores IR, meta, queues, hoo
  const loadProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const project = parseProject(ev.target?.result as string);
        onProjectLoaded(project);
      } catch (err: any) {
        alert(`Failed to load project: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  // Save metadata — updates both meta state and IR-level fields
  const handleMetadataSave = (newMeta: Partial<FlowMeta>) => {
    setMeta(newMeta);
    setIR({
      ...ir,
      meta: newMeta,
      hoo_arn: newMeta.hoo_arn || ir.hoo_arn,
      flow_id: newMeta.target_flow_id || ir.flow_id,
      start_step: newMeta.start_step || ir.start_step,
    });
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
    const atomicMap = Object.fromEntries(steps.map((n) => [n.step_id, n]));
    const branchErrors = validateBranches(atomicMap);
    if (branchErrors.length > 0) {
      const msg = [
        `⚠ ${branchErrors.length} dangling branch target(s) found:`,
        ...branchErrors.slice(0, 5).map((e) => `  • ${e}`),
        ...(branchErrors.length > 5 ? [`  …and ${branchErrors.length - 5} more`] : []),
        "", "Export anyway?",
      ].join("\n");
      if (!window.confirm(msg)) return;
    }
    const payload = steps.map((n) => ({
      flow_id: ir.flow_id, step_id: n.step_id, action_type: n.action_type,
      label: n.label, content: n.content ?? {}, default_next: n.default_next ?? null,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ir.flow_id}.json`;
    a.click();
  };

  const handleUpload = async (uploadMeta: FlowMeta) => {
    if (!auth.credentials) return;
    try {
      const client = buildDocClient(auth.credentials);
      const steps = buildAtomicSteps(ir);
      await writeMeta(client, uploadMeta);
      await writeSteps(client, uploadMeta.target_flow_id, steps);
      setUploadStatus("ok");
      setTimeout(() => setUploadStatus("idle"), 3500);
      setShowUploadModal(false);
    } catch (e: any) {
      setUploadStatus("err");
      setTimeout(() => setUploadStatus("idle"), 5000);
      throw e;
    }
  };

  const upload = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      try {
        if (file.name.endsWith(".json")) {
          const parsed = JSON.parse(text);
          const converted = convertCxJson(parsed);
          if (setIRWithCx) setIRWithCx(converted, parsed);
          else setIR(converted);
        } else if (file.name.endsWith(".csv")) {
          setIR(importCSV(text));
        } else {
          alert("Unsupported file type. Use .json (CXone export) or .csv");
        }
      } catch (err) {
        console.error(err);
        alert("Failed to parse: " + (err as any).message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const dynColor = uploadStatus === "ok" ? "var(--green)" : uploadStatus === "err" ? "var(--red)" : "var(--text-2)";
  const credReady = auth.authStep === "ready";

  return (
    <>
      <header className="toolbar">
        <div className="toolbar-brand">
          <div className="toolbar-logo">IVR</div>
          <span className="toolbar-title">Flow Editor</span>
          <span className="toolbar-flow-id">{ir.flow_id}</span>
          {ir.start_step && (
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "var(--green)",
              background: "rgba(61,186,126,0.1)", border: "1px solid rgba(61,186,126,0.25)",
              borderRadius: "var(--radius)", padding: "1px 6px"
            }}>
              ▶ {ir.start_step}
            </span>
          )}
        </div>

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
            <button className="btn" onClick={() => setShowMetaEditor(true)}
              title="Edit flow metadata">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <path d="M2 5h8M5 2v8" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              Metadata
            </button>
          </>
        )}

        <div className="toolbar-divider" />

        <button className="btn" onClick={saveProject} disabled={nodeCount === 0}
          title="Save project with metadata and settings">
          💾 Save Project
        </button>
        <label className="btn" title="Load project file">
          📂 Load
          <input type="file" accept=".ivr.json,.json" onChange={loadProject} style={{ display: "none" }} />
        </label>

        <div className="toolbar-spacer" />

        <span className="status-item">
          <span className="status-dot" style={{ background: nodeCount > 0 ? "var(--green)" : "var(--text-3)" }} />
          {nodeCount} node{nodeCount !== 1 ? "s" : ""}
          {compositeCount > 0 && (
            <span style={{
              marginLeft: 4, color: "var(--orange)", fontSize: 9,
              fontFamily: "'IBM Plex Mono', monospace"
            }}
              title={`${compositeCount} MENU node(s) will be expanded to atomics on export`}>
              ({compositeCount} composite)
            </span>
          )}
        </span>

        <div className="toolbar-divider" />

        <button className="btn btn-primary" onClick={downloadJSON} disabled={nodeCount === 0}
          title="Export engine-compatible JSON (atomics only)">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v7M3 6l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Export JSON
        </button>

        <button className="btn" onClick={downloadCSV} disabled={nodeCount === 0} title="Export as CSV">
          CSV
        </button>

        {/* Upload / credential button cluster */}
        <div style={{ display: "flex", gap: 0 }}>
          <button className="btn" onClick={handleUploadClick} disabled={nodeCount === 0}
            style={{
              color: dynColor, borderColor: uploadStatus !== "idle" ? dynColor : undefined,
              borderTopRightRadius: credReady ? 0 : undefined,
              borderBottomRightRadius: credReady ? 0 : undefined
            }}
            title={credReady ? "Upload flow to DynamoDB" : "Connect to AWS first"}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <ellipse cx="6" cy="3.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M1 3.5v5C1 9.6 3.24 10.5 6 10.5s5-.9 5-2V3.5" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            {uploadStatus === "ok"
              ? "✓ Uploaded"
              : credReady
                ? "Upload to DynDB"
                : "Connect AWS →"}
          </button>

          {/* When authenticated: small account badge + logout */}
          {credReady && auth.credentials && (
            <button className="btn" onClick={auth.logout}
              title={`Signed in via ${auth.credentials.source.toUpperCase()}: ${auth.credentials.identity ?? auth.credentials.accessKeyId.slice(0, 8) + "…"}\nClick to sign out`}
              style={{
                borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                borderLeft: "1px solid var(--border)", paddingLeft: 7, paddingRight: 7,
                color: "var(--green)", fontSize: 10, fontFamily: "'IBM Plex Mono', monospace",
                maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
              }}>
              ● {auth.credentials.source === "sso"
                ? (auth.credentials.identity?.split("/")[1]?.trim() ?? "SSO")
                : "keys"}
            </button>
          )}
        </div>

        <label className="btn btn-import" title="Import CXone JSON or CSV">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M6 11V4M3 7L6 4l3 3M1 2h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Import
          <input type="file" accept=".csv,.json" onChange={upload} style={{ display: "none" }} />
        </label>
      </header>

      {/* AWS auth modal — shown when not yet authenticated */}
      {auth.authStep !== "idle" && auth.authStep !== "ready" && (
        <AwsAuthModal auth={auth} onClose={() => auth.setAuthStep("idle")} />
      )}

      {/* Metadata editor modal */}
      {showMetaEditor && (
        <MetadataEditorModal
          ir={ir}
          currentMeta={meta}
          onClose={() => setShowMetaEditor(false)}
          onSave={handleMetadataSave}
        />
      )}

      {/* Upload modal — shown only when authenticated */}
      {showUploadModal && auth.credentials && (
        <FlowMetaModal
          ir={ir}
          creds={auth.credentials}
          initialMeta={meta}
          onClose={() => setShowUploadModal(false)}
          onUpload={handleUpload}
        />
      )}
    </>
  );
}