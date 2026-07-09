// src/components/SkillsPanel.tsx
import { useState, useEffect, useRef } from "react";
import {
  ConnectClient,
  CreateQueueCommand,
  DescribeQueueCommand,
  ListQueuesCommand,
  CreateHoursOfOperationCommand,
  DescribeHoursOfOperationCommand,
  ListHoursOfOperationsCommand,
  type HoursOfOperationConfig as AwsHooConfig,
} from "@aws-sdk/client-connect";
import type { IR, FlowMeta } from "../types";
import type { AwsCredentials, ConnectInstance } from "../hooks/useAwsCredentials";
import { extractSkillWhispers } from "../converter/convertCXJson";
import {
  extractQueuesFromIR,
  mergePersistedQueues,
  patchTransferArns,
  validateFlow,
  type QueueRecord,
  type HoursOfOperation,
  type FlowWarning,
} from "../project";
import { parseSkillsCSV, reconcileQueueNames } from "../utils/skillsCSV";
import { findHooByName } from "../utils/queueSync";
import { connectClient } from "../utils/awsClients";

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  ir: IR;
  setIR: (ir: IR) => void;
  rawCx?: any;
  credentials: AwsCredentials | null;
  meta?: Partial<FlowMeta>;
  setMeta?: (meta: Partial<FlowMeta>) => void;
  queues: QueueRecord[];
  setQueues: (q: QueueRecord[]) => void;
  hoo: HoursOfOperation;
  setHoo: (h: HoursOfOperation) => void;
  onClose: () => void;
  onHooCreated?: (arn: string) => void;
  instances?: ConnectInstance[];
  onSelectInstance?: (instanceId: string) => void;
  /** All open tabs — for "used in" tags */
  allTabs?: Array<{ id: string; label: string; queues: QueueRecord[] }>;
}

// ─── Connect client ──────────────────────────────────────────────────────────

function buildClient(creds: AwsCredentials): ConnectClient {
  return connectClient(creds);
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ResourceStatus = "unknown" | "checking" | "exists" | "missing" | "creating" | "err";

interface QueueRowState extends QueueRecord {
  liveStatus: ResourceStatus;
  errMsg?: string;
}

interface HooRowState extends HoursOfOperation {
  liveStatus: ResourceStatus;
  errMsg?: string;
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
type Day = (typeof DAYS)[number];

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace" };

const INPUT: React.CSSProperties = {
  background: "var(--bg-0)", border: "1px solid var(--border)",
  borderRadius: "var(--radius)", color: "var(--text-0)",
  ...MONO, fontSize: 11, padding: "4px 8px", outline: "none",
  width: "100%", boxSizing: "border-box",
};

const LABEL: React.CSSProperties = {
  fontSize: 10, color: "var(--text-2)", fontWeight: 500,
  marginBottom: 3, display: "block",
  fontFamily: "'IBM Plex Sans', sans-serif",
};

function tagStyle(color: string, bg: string, border: string): React.CSSProperties {
  return {
    fontSize: 9, borderRadius: 3, padding: "1px 6px", fontWeight: 700,
    letterSpacing: "0.05em", ...MONO, color, background: bg, border: `1px solid ${border}`,
    flexShrink: 0,
  };
}

function StatusBadge({ status, errMsg }: { status: ResourceStatus; errMsg?: string }) {
  const map: Record<ResourceStatus, [string, string, string]> = {
    unknown:  ["○", "var(--text-3)", "not checked"],
    checking: ["⟳", "var(--accent)", "checking…"],
    exists:   ["✓", "var(--green)", "exists"],
    missing:  ["✕", "var(--text-3)", "not found"],
    creating: ["⟳", "var(--cyan)", "creating…"],
    err:      ["✕", "var(--red)", errMsg ?? "error"],
  };
  const [icon, color, label] = map[status];
  return (
    <span style={{ fontSize: 11, color, ...MONO, whiteSpace: "nowrap" }} title={errMsg ?? label}>
      {icon} <span style={{ fontSize: 9 }}>{label}</span>
    </span>
  );
}

function cleanSkillId(id: string): string {
  const match = id.match(/^(?:CXone\s*#)?(\d+)/);
  return match ? match[1] : id;
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w\s-]/g, "_").trim().replace(/\s+/g, "_");
}

// ─── Validation banner ────────────────────────────────────────────────────────

function ValidationBanner({ warnings }: { warnings: FlowWarning[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!warnings.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "rgba(61,186,126,0.08)", border: "1px solid rgba(61,186,126,0.2)", borderRadius: "var(--radius)", fontSize: 11, color: "var(--green)" }}>
        ✓ No issues detected
      </div>
    );
  }
  const kindColor: Record<FlowWarning["kind"], string> = {
    "no-start": "var(--red)", "missing-hoo": "var(--orange)",
    "unmatched-queue": "var(--orange)", "missing-queue-arn": "var(--text-2)",
    "dangling-branch": "var(--red)",
  };
  return (
    <div style={{ border: "1px solid rgba(232,149,90,0.35)", borderRadius: "var(--radius)", overflow: "hidden" }}>
      <button onClick={() => setExpanded(v => !v)} style={{ width: "100%", background: "rgba(232,149,90,0.08)", border: "none", padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "var(--orange)", ...MONO }}>⚠ {warnings.length} issue{warnings.length !== 1 ? "s" : ""} detected</span>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{ padding: "6px 12px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 10, color: kindColor[w.kind], ...MONO, display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ flexShrink: 0 }}>•</span>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Instance Selector ───────────────────────────────────────────────────────

function InstanceSelector({ credentials, instances, onSelectInstance }: {
  credentials: AwsCredentials | null;
  instances?: ConnectInstance[];
  onSelectInstance?: (id: string) => void;
}) {
  if (!credentials) return null;
  const currentInstanceId = credentials.instance_id ?? "";
  if (!instances || instances.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)" }}>
        <label style={{ ...LABEL, marginBottom: 0, flexShrink: 0 }}>Connect Instance</label>
        <input style={{ ...INPUT, flex: 1, fontSize: 11 }} value={currentInstanceId}
          onChange={e => onSelectInstance?.(e.target.value)} placeholder="Instance ID or ARN" spellCheck={false} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)" }}>
      <label style={{ ...LABEL, marginBottom: 0, flexShrink: 0 }}>Connect Instance</label>
      <select style={{ ...INPUT, flex: 1, cursor: "pointer" }} value={currentInstanceId} onChange={e => onSelectInstance?.(e.target.value)}>
        <option value="">— Select instance —</option>
        {instances.map(inst => (
          <option key={inst.id} value={inst.id}>{inst.alias} ({inst.id.slice(0, 8)}…)</option>
        ))}
      </select>
      {!currentInstanceId && <span style={{ fontSize: 10, color: "var(--orange)", ...MONO, flexShrink: 0 }}>⚠ Required</span>}
    </div>
  );
}

// ─── HOO Section ─────────────────────────────────────────────────────────────

function HooSection({ hoo, setHoo, metaHooArn, credentials, onHooCreated }: {
  hoo: HooRowState;
  setHoo: (fn: (h: HooRowState) => HooRowState) => void;
  metaHooArn?: string;
  credentials: AwsCredentials | null;
  onHooCreated?: (arn: string) => void;
}) {
  const [expanded, setExpanded] = useState(!hoo.hooArn && !metaHooArn);
  const [arnDraft, setArnDraft] = useState(hoo.hooArn ?? metaHooArn ?? "");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(hoo.name);
  const patch = (p: Partial<HooRowState>) => setHoo(h => ({ ...h, ...p }));

  const setDay = (day: Day, dp: Partial<{ enabled: boolean; start: string; end: string }>) =>
    setHoo(h => ({ ...h, schedule: { ...h.schedule, [day]: { ...h.schedule[day], ...dp } } }));

  const needsInstance = !credentials?.instance_id;

  const idFromArn = (arn: string) => arn.split("/").pop() ?? "";

  const checkArn = async (arnOrId: string) => {
    if (!credentials?.instance_id || !arnOrId.trim()) return;
    patch({ liveStatus: "checking", errMsg: undefined });
    try {
      const resp = await buildClient(credentials).send(new DescribeHoursOfOperationCommand({
        InstanceId: credentials.instance_id,
        HoursOfOperationId: arnOrId.trim(),
      }));
      const resolvedArn = resp.HoursOfOperation?.HoursOfOperationArn ?? arnOrId;
      patch({ liveStatus: "exists", hooArn: resolvedArn, hooId: resp.HoursOfOperation?.HoursOfOperationId ?? idFromArn(arnOrId), name: resp.HoursOfOperation?.Name ?? hoo.name, errMsg: undefined });
      setArnDraft(resolvedArn);
      onHooCreated?.(resolvedArn);
    } catch (e: any) {
      patch({ liveStatus: "missing", errMsg: `Not found: ${e.message}` });
    }
  };

  const searchByName = async (name: string) => {
    if (!credentials?.instance_id || !name.trim()) return;
    patch({ liveStatus: "checking", errMsg: undefined });
    try {
      // Collect every HOO across pages, then fuzzy-match (exact → normalized →
      // substring) so separator/case differences (e.g. "Care-First Hours" vs
      // "Care First Hours") still resolve.
      const all: { Name?: string; Arn?: string; Id?: string }[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await buildClient(credentials).send(new ListHoursOfOperationsCommand({
          InstanceId: credentials.instance_id,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        all.push(...(resp.HoursOfOperationSummaryList ?? []));
        nextToken = resp.NextToken;
      } while (nextToken);

      const match = findHooByName(name.trim(), all, { allowPartial: true });
      if (match?.Arn) {
        const detail = await buildClient(credentials).send(new DescribeHoursOfOperationCommand({
          InstanceId: credentials.instance_id,
          HoursOfOperationId: match.Arn,
        }));
        const resolvedArn = detail.HoursOfOperation?.HoursOfOperationArn ?? match.Arn;
        patch({ liveStatus: "exists", hooArn: resolvedArn, hooId: detail.HoursOfOperation?.HoursOfOperationId ?? match.Id ?? "", name: detail.HoursOfOperation?.Name ?? name, errMsg: undefined });
        setArnDraft(resolvedArn);
        onHooCreated?.(resolvedArn);
        return;
      }
      patch({ liveStatus: "missing", errMsg: `No HOO named "${name.trim()}" found in Connect` });
    } catch (e: any) {
      patch({ liveStatus: "err", errMsg: e.message });
    }
  };

  useEffect(() => {
    const existingArn = hoo.hooArn ?? metaHooArn;
    if (hoo.liveStatus !== "unknown" || !credentials?.instance_id) return;
    if (existingArn) checkArn(existingArn);
    else if (hoo.name && hoo.name !== "Business Hours") searchByName(hoo.name);
  }, []);

  const create = async () => {
    if (!credentials?.instance_id || !hoo.name) return;
    patch({ liveStatus: "creating", errMsg: undefined });
    const config: AwsHooConfig[] = DAYS.flatMap(day => {
      const d = hoo.schedule[day];
      if (!d?.enabled) return [];
      const [sh, sm] = d.start.split(":").map(Number);
      const [eh, em] = d.end.split(":").map(Number);
      return [{ Day: day.toUpperCase() as AwsHooConfig["Day"], StartTime: { Hours: sh, Minutes: sm }, EndTime: { Hours: eh, Minutes: em } }];
    });
    try {
      const resp = await buildClient(credentials).send(new CreateHoursOfOperationCommand({
        InstanceId: credentials.instance_id,
        Name: sanitizeName(hoo.name),
        Description: hoo.description || undefined,
        TimeZone: hoo.timezone,
        Config: config,
        Tags: { source: "ivr-editor" },
      }));
      const arn = resp.HoursOfOperationArn ?? "";
      patch({ liveStatus: "exists", hooArn: arn, hooId: resp.HoursOfOperationId ?? "", errMsg: undefined });
      setArnDraft(arn);
      onHooCreated?.(arn);
    } catch (e: any) {
      patch({ liveStatus: "err", errMsg: e.message });
    }
  };

  const commitNameEdit = () => {
    const trimmed = nameDraft.trim();
    if (trimmed) patch({ name: trimmed });
    setEditingName(false);
  };

  const isConfirmed = hoo.liveStatus === "exists";

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
      <button onClick={() => setExpanded(v => !v)} style={{ width: "100%", background: "var(--bg-3)", border: "none", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={tagStyle("var(--cyan)", "rgba(90,174,232,0.12)", "rgba(90,174,232,0.3)")}>HOO</span>

          {/* Inline rename */}
          {editingName ? (
            <input
              style={{ ...INPUT, width: 180, padding: "1px 6px", fontSize: 11 }}
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={commitNameEdit}
              onKeyDown={e => { if (e.key === "Enter") commitNameEdit(); if (e.key === "Escape") { setNameDraft(hoo.name); setEditingName(false); } }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span
              style={{ fontSize: 11, color: "var(--text-1)", fontWeight: 500, cursor: "text" }}
              onClick={e => { e.stopPropagation(); setNameDraft(hoo.name); setEditingName(true); }}
              title="Click to rename"
            >
              {hoo.name || "Hours of Operation"}
            </span>
          )}

          <StatusBadge status={hoo.liveStatus} errMsg={hoo.errMsg} />
        </div>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {needsInstance && (
            <div style={{ fontSize: 11, color: "var(--orange)", ...MONO }}>
              ⚠ Select a Connect instance above to look up or provision
            </div>
          )}

          {/* ARN entry */}
          <div style={{ background: isConfirmed ? "rgba(61,186,126,0.06)" : "var(--bg-0)", border: `1px solid ${isConfirmed ? "rgba(61,186,126,0.25)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ ...LABEL, marginBottom: 0 }}>{isConfirmed ? "✓ Confirmed HOO ARN" : "HOO ARN"}</label>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="btn btn-ghost" onClick={() => searchByName(hoo.name)} disabled={!hoo.name || needsInstance || hoo.liveStatus === "checking"} style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>🔍 By name</button>
                <button className="btn btn-ghost" onClick={() => checkArn(arnDraft)} disabled={!arnDraft.trim() || needsInstance || hoo.liveStatus === "checking"} style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>
                  {hoo.liveStatus === "checking" ? "Checking…" : "Verify →"}
                </button>
              </div>
            </div>
            <input style={{ ...INPUT, color: isConfirmed ? "var(--green)" : "var(--text-0)", borderColor: isConfirmed ? "rgba(61,186,126,0.3)" : undefined }}
              value={arnDraft} onChange={e => setArnDraft(e.target.value)}
              onKeyDown={e => e.key === "Enter" && checkArn(arnDraft)}
              placeholder="arn:aws:connect:…:hours-of-operation/UUID  or bare UUID"
              spellCheck={false} />
            {isConfirmed && hoo.hooArn && (
              <div style={{ fontSize: 9, color: "var(--green)", ...MONO }}>
                Name: {hoo.name}{hoo.hooId ? ` · ID: ${hoo.hooId}` : ""}
              </div>
            )}
            {hoo.liveStatus === "missing" && hoo.errMsg && (
              <div style={{ fontSize: 10, color: "var(--orange)", ...MONO }}>{hoo.errMsg}</div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>or create new</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={LABEL}>HOO Name *</label>
              <input style={INPUT} value={hoo.name} onChange={e => patch({ name: e.target.value })} />
            </div>
            <div>
              <label style={LABEL}>Timezone</label>
              <input style={INPUT} value={hoo.timezone} onChange={e => patch({ timezone: e.target.value })} placeholder="America/New_York" />
            </div>
          </div>

          <div>
            <label style={{ ...LABEL, marginBottom: 6 }}>Schedule</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {DAYS.map(day => {
                const d = hoo.schedule[day] ?? { enabled: false, start: "08:00", end: "17:00" };
                return (
                  <div key={day} style={{ display: "grid", gridTemplateColumns: "20px 80px 1fr 1fr", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={d.enabled} onChange={e => setDay(day as Day, { enabled: e.target.checked })} style={{ cursor: "pointer" }} />
                    <span style={{ fontSize: 10, color: d.enabled ? "var(--text-1)" : "var(--text-3)", ...MONO }}>{day.slice(0, 3)}</span>
                    <input type="time" style={{ ...INPUT, opacity: d.enabled ? 1 : 0.4 }} value={d.start} disabled={!d.enabled} onChange={e => setDay(day as Day, { start: e.target.value })} />
                    <input type="time" style={{ ...INPUT, opacity: d.enabled ? 1 : 0.4 }} value={d.end} disabled={!d.enabled} onChange={e => setDay(day as Day, { end: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-primary" onClick={create} disabled={!hoo.name || needsInstance || hoo.liveStatus === "creating"}>
              {hoo.liveStatus === "creating" ? "Creating…" : isConfirmed ? "Re-create HOO" : "Create New HOO"}
            </button>
          </div>

          {hoo.liveStatus === "err" && hoo.errMsg && (
            <div style={{ fontSize: 10, color: "var(--red)", ...MONO }}>{hoo.errMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Queue Row ───────────────────────────────────────────────────────────────

function QueueRow({ queue, credentials, hooId, onChange, onDelete, usedInTabs }: {
  queue: QueueRowState;
  credentials: AwsCredentials | null;
  hooId?: string;
  onChange: (patch: Partial<QueueRowState>) => void;
  onDelete: () => void;
  usedInTabs: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(queue.connectName);
  const [expanded, setExpanded] = useState(false);
  const [arnDraft, setArnDraft] = useState(queue.queueArn ?? "");

  const isConfirmed = queue.liveStatus === "exists" && !!queue.queueArn;
  const idFromArn = (arn: string) => arn.split("/").pop() ?? "";

  const verifyArn = async (arnOrId: string) => {
    if (!credentials?.instance_id || !arnOrId.trim()) return;
    onChange({ liveStatus: "checking", errMsg: undefined });
    try {
      const resp = await buildClient(credentials).send(new DescribeQueueCommand({
        InstanceId: credentials.instance_id, QueueId: arnOrId.trim(),
      }));
      const resolvedArn = resp.Queue?.QueueArn ?? arnOrId;
      setArnDraft(resolvedArn);
      onChange({ liveStatus: "exists", queueArn: resolvedArn, queueId: resp.Queue?.QueueId ?? idFromArn(arnOrId), connectName: resp.Queue?.Name ?? queue.connectName, errMsg: undefined });
    } catch (e: any) {
      onChange({ liveStatus: "missing", errMsg: `Not found: ${e.message}` });
    }
  };

  const searchByName = async (name: string) => {
    if (!credentials?.instance_id || !name.trim()) return;
    onChange({ liveStatus: "checking", errMsg: undefined });
    try {
      const client = buildClient(credentials);
      const target = name.trim().toLowerCase();
      let nextToken: string | undefined;
      let match: any = null;
      do {
        const resp = await client.send(new ListQueuesCommand({
          InstanceId: credentials.instance_id,
          QueueTypes: ["STANDARD"],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        match = (resp.QueueSummaryList ?? []).find(q => q.Name?.toLowerCase() === target);
        nextToken = match ? undefined : resp.NextToken;
      } while (!match && nextToken);

      if (match?.QueueArn) {
        setArnDraft(match.QueueArn);
        onChange({ liveStatus: "exists", queueArn: match.QueueArn, queueId: match.QueueId ?? idFromArn(match.QueueArn), connectName: match.Name ?? name, errMsg: undefined });
      } else {
        onChange({ liveStatus: "missing", errMsg: `No queue named "${name.trim()}" found` });
      }
    } catch (e: any) {
      onChange({ liveStatus: "err", errMsg: e.message });
    }
  };

  useEffect(() => {
    if (queue.liveStatus !== "unknown" || !credentials?.instance_id) return;
    if (queue.queueArn) verifyArn(queue.queueArn);
    else searchByName(queue.connectName);
  }, []);

  const create = async () => {
    if (!credentials?.instance_id) { onChange({ liveStatus: "err", errMsg: "Instance ID required" }); return; }
    if (!hooId) { onChange({ liveStatus: "err", errMsg: "Create HOO first" }); return; }
    onChange({ liveStatus: "creating", errMsg: undefined });
    const sanitized = sanitizeName(queue.connectName);
    try {
      // Check for existing queue with same name before creating
      const client = buildClient(credentials);
      const target = sanitized.toLowerCase();
      let nextToken: string | undefined;
      let existing: any = null;
      do {
        const resp = await client.send(new ListQueuesCommand({
          InstanceId: credentials.instance_id,
          QueueTypes: ["STANDARD"],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        existing = (resp.QueueSummaryList ?? []).find(q => q.Name?.toLowerCase() === target);
        nextToken = existing ? undefined : resp.NextToken;
      } while (!existing && nextToken);

      if (existing?.QueueArn) {
        setArnDraft(existing.QueueArn);
        onChange({ liveStatus: "exists", queueArn: existing.QueueArn, queueId: existing.QueueId ?? idFromArn(existing.QueueArn), connectName: existing.Name ?? queue.connectName, errMsg: undefined });
        return;
      }
    } catch { /* fall through to create */ }
    try {
      const resp = await buildClient(credentials).send(new CreateQueueCommand({
        InstanceId: credentials.instance_id,
        Name: sanitized,
        HoursOfOperationId: hooId,
        Description: `IVR queue for ${queue.connectName}`,
        Tags: { source: "ivr-editor", ...(queue.queueSkill ? { cxone_skill_id: queue.queueSkill } : {}), skill_whisper: queue.skillWhisper },
      }));
      const newArn = resp.QueueArn ?? "";
      setArnDraft(newArn);
      onChange({ liveStatus: "exists", queueArn: newArn, queueId: resp.QueueId ?? "", errMsg: undefined });
    } catch (e: any) {
      onChange({ liveStatus: "err", errMsg: e.message });
    }
  };

  const applyRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== queue.connectName) onChange({ connectName: trimmed });
    setEditing(false);
  };

  return (
    <div style={{
      background: "var(--bg-3)",
      border: `1px solid ${isConfirmed ? "rgba(61,186,126,0.25)" : queue.liveStatus === "err" || queue.liveStatus === "missing" ? "rgba(224,90,90,0.25)" : "var(--border)"}`,
      borderRadius: "var(--radius)",
    }}>
      {/* Main row */}
      <div style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ minWidth: 82, flexShrink: 0 }}>
          <StatusBadge status={queue.liveStatus} errMsg={queue.errMsg} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input style={{ ...INPUT, fontSize: 11, padding: "2px 6px" }} value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={applyRename}
              onKeyDown={e => { if (e.key === "Enter") applyRename(); if (e.key === "Escape") { setDraft(queue.connectName); setEditing(false); } }}
              autoFocus />
          ) : (
            <span style={{ fontSize: 11, ...MONO, color: "var(--text-0)", cursor: "text" }}
              onClick={() => { setDraft(queue.connectName); setEditing(true); }}
              title="Click to rename">
              {queue.connectName}
            </span>
          )}

          {/* Tags row */}
          <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
            {queue.queueSkill && (
              <span style={{ fontSize: 9, ...MONO, color: "var(--text-3)", background: "var(--bg-4)", border: "1px solid var(--border)", borderRadius: 3, padding: "0 5px" }}>
                #{queue.queueSkill}
              </span>
            )}
            {queue.skillWhisper !== queue.connectName && (
              <span style={{ fontSize: 9, ...MONO, color: "var(--text-3)", background: "var(--bg-4)", border: "1px solid var(--border)", borderRadius: 3, padding: "0 5px" }}
                title="SkillWhisper value in the flow">
                ⟨{queue.skillWhisper}⟩
              </span>
            )}
            {usedInTabs.map(label => (
              <span key={label} style={{ fontSize: 9, ...MONO, color: "var(--accent)", background: "var(--accent-glow)", border: "1px solid var(--accent-dim)", borderRadius: 3, padding: "0 5px" }}
                title="Used in this flow tab">
                {label}
              </span>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={() => setExpanded(v => !v)} style={{ fontSize: 10, padding: "2px 6px", height: 22 }}>
            {expanded ? "▲" : isConfirmed ? "ARN ✓" : "ARN…"}
          </button>
          <button className={`btn ${isConfirmed ? "btn-ghost" : "btn-primary"}`} onClick={create}
            disabled={queue.liveStatus === "creating"} style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>
            {queue.liveStatus === "creating" ? "…" : isConfirmed ? "Re-create" : "+ Create"}
          </button>
          <button className="btn btn-ghost btn-danger" onClick={onDelete}
            style={{ fontSize: 10, padding: "2px 5px", height: 22 }} title="Remove this queue">×</button>
        </div>
      </div>

      {/* ARN expanded */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, background: "var(--bg-0)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ ...LABEL, marginBottom: 0, flexShrink: 0 }}>{isConfirmed ? "✓ Queue ARN" : "Queue ARN / ID"}</label>
            <div style={{ flex: 1 }} />
            <button className="btn btn-ghost" onClick={() => searchByName(queue.connectName)}
              disabled={!queue.connectName || !credentials?.instance_id || queue.liveStatus === "checking"}
              style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>🔍 By name</button>
            <button className="btn btn-ghost" onClick={() => verifyArn(arnDraft)}
              disabled={!arnDraft.trim() || !credentials?.instance_id || queue.liveStatus === "checking"}
              style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>
              {queue.liveStatus === "checking" ? "Checking…" : "Verify →"}
            </button>
          </div>
          <input style={{ ...INPUT, fontSize: 10, color: isConfirmed ? "var(--green)" : "var(--text-0)", borderColor: isConfirmed ? "rgba(61,186,126,0.3)" : undefined }}
            value={arnDraft} onChange={e => setArnDraft(e.target.value)}
            onKeyDown={e => e.key === "Enter" && verifyArn(arnDraft)}
            placeholder="arn:aws:connect:…:queue/UUID  or bare UUID" spellCheck={false} />
          {isConfirmed && queue.queueId && (
            <div style={{ fontSize: 9, color: "var(--green)", ...MONO }}>ID: {queue.queueId}</div>
          )}
          {(queue.liveStatus === "missing" || queue.liveStatus === "err") && queue.errMsg && (
            <div style={{ fontSize: 9, color: "var(--red)", ...MONO }}>{queue.errMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Metadata auto-populate panel ────────────────────────────────────────────

function MetaAutoFill({ ir, meta, setMeta, hooArn }: {
  ir: IR;
  meta: Partial<FlowMeta>;
  setMeta: (m: Partial<FlowMeta>) => void;
  hooArn?: string;
}) {
  const [localMeta, setLocalMeta] = useState<Partial<FlowMeta>>(meta);

  useEffect(() => {
    // Auto-populate from IR when opened
    const autoMeta: Partial<FlowMeta> = {
      target_flow_id: meta.target_flow_id || ir.flow_id,
      start_step: meta.start_step || ir.start_step || "",
      hoo_arn: meta.hoo_arn || (hooArn ? [hooArn] : []) || ir.hoo_arn || [],
      dialed_number: meta.dialed_number || "",
      instance_id: meta.instance_id || "",
      description: meta.description || "",
    };
    setLocalMeta(autoMeta);
  }, [ir.flow_id, ir.start_step, hooArn]);

  const fields: { key: keyof FlowMeta; label: string; hint: string; auto?: string }[] = [
    { key: "dialed_number", label: "Dialed Number", hint: "E.164 — DDB partition key" },
    { key: "target_flow_id", label: "Target Flow ID", hint: "Matches IR flow_id", auto: ir.flow_id },
    { key: "start_step", label: "Start Step ID", hint: "First node callers reach", auto: ir.start_step },
    { key: "hoo_arn", label: "HOO ARN", hint: "Connect Hours of Operation ARN", auto: (hooArn || ir.hoo_arn || "").toString() },
    { key: "instance_id", label: "Connect Instance ID", hint: "Overrides INSTANCE_ID env var" },
    { key: "description", label: "Description", hint: "Human label" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {fields.map(({ key, label, hint, auto }) => (
        <div key={key}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
            <label style={{ ...LABEL, marginBottom: 0 }}>{label}</label>
            {auto && !localMeta[key] && (
              <button className="btn btn-ghost" style={{ fontSize: 9, height: 18, padding: "0 6px" }}
                onClick={() => {
                  const updated = { ...localMeta, [key]: auto };
                  setLocalMeta(updated);
                  setMeta(updated);
                }}>
                ↓ auto-fill
              </button>
            )}
            {auto && localMeta[key] && localMeta[key] !== auto && (
              <span style={{ fontSize: 9, color: "var(--orange)", ...MONO }}>
                IR: {String(auto).slice(0, 20)}
              </span>
            )}
            {auto && localMeta[key] === auto && (
              <span style={{ fontSize: 9, color: "var(--green)", ...MONO }}>✓ matches IR</span>
            )}
          </div>
          <input
            style={{ ...INPUT, borderColor: auto && localMeta[key] && localMeta[key] !== auto ? "rgba(232,149,90,0.4)" : undefined }}
            value={(localMeta[key] as string) ?? ""}
            onChange={e => {
              const updated = { ...localMeta, [key]: e.target.value };
              setLocalMeta(updated);
              setMeta(updated);
            }}
            placeholder={hint}
            spellCheck={false}
          />
        </div>
      ))}

      <button className="btn btn-primary" style={{ alignSelf: "flex-end", fontSize: 11 }}
        onClick={() => {
          const autoFilled: Partial<FlowMeta> = {
            ...localMeta,
            target_flow_id: localMeta.target_flow_id || ir.flow_id,
            start_step: localMeta.start_step || ir.start_step || "",
            hoo_arn: localMeta.hoo_arn || (hooArn ? [hooArn] : []) || ir.hoo_arn || [],
          };
          setLocalMeta(autoFilled);
          setMeta(autoFilled);
        }}>
        ⚡ Auto-fill from IR
      </button>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export default function SkillsPanel({
  ir, setIR, rawCx, credentials, meta, setMeta,
  queues: propQueues, setQueues: setPropQueues,
  hoo: propHoo, setHoo: setPropHoo,
  onClose, onHooCreated,
  instances, onSelectInstance,
  allTabs,
}: Props) {
  const [activeTab, setActiveTab] = useState<"queues" | "hoo" | "meta" | "validation">("queues");
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvStatus, setCsvStatus] = useState<string>("");

  const [queueRows, setQueueRows] = useState<QueueRowState[]>(() => {
    const extracted = rawCx
      ? mergePersistedQueues(
          extractSkillWhispers(rawCx).map(s => ({ skillWhisper: s.skillWhisper, queueSkill: s.queueSkill })),
          propQueues,
        )
      : extractQueuesFromIR(ir, propQueues);
    return extracted.map(q => ({
      ...q,
      queueSkill: cleanSkillId(q.queueSkill ?? ""),
      liveStatus: (q.queueArn ? "exists" : "unknown") as ResourceStatus,
    }));
  });

  const [hooRow, setHooRow] = useState<HooRowState>({
    ...propHoo,
    liveStatus: propHoo.hooArn ? "exists" : "unknown",
  });

  const syncQueuesUp = (rows: QueueRowState[]) => {
    setQueueRows(rows);
    setPropQueues(rows.map(({ liveStatus, errMsg, ...q }) => q));
  };

  const patchQueueRow = (idx: number, p: Partial<QueueRowState>) => {
    setQueueRows(prev => {
      const next = prev.map((q, i) => i === idx ? { ...q, ...p } : q);
      setPropQueues(next.map(({ liveStatus, errMsg, ...q }) => q));
      return next;
    });
  };

  const deleteQueueRow = (idx: number) => {
    setQueueRows(prev => {
      const next = prev.filter((_, i) => i !== idx);
      setPropQueues(next.map(({ liveStatus, errMsg, ...q }) => q));
      return next;
    });
  };

  const syncHooUp = (fn: (h: HooRowState) => HooRowState) => {
    setHooRow(prev => {
      const next = fn(prev);
      setPropHoo({ name: next.name, timezone: next.timezone, description: next.description, schedule: next.schedule, hooArn: next.hooArn, hooId: next.hooId });
      return next;
    });
  };

  useEffect(() => {
    const extracted = rawCx
      ? mergePersistedQueues(
          extractSkillWhispers(rawCx).map(s => ({ skillWhisper: s.skillWhisper, queueSkill: s.queueSkill })),
          propQueues,
        )
      : extractQueuesFromIR(ir, propQueues);
    setQueueRows(prev => {
      const existingMap = new Map(prev.map(r => [r.skillWhisper, r]));
      const merged = extracted.map(q => {
        const existing = existingMap.get(q.skillWhisper);
        return existing
          ? { ...existing, ...q, connectName: existing.connectName }
          : { ...q, queueSkill: cleanSkillId(q.queueSkill ?? ""), liveStatus: (q.queueArn ? "exists" : "unknown") as ResourceStatus };
      });
      setPropQueues(merged.map(({ liveStatus, errMsg, ...q }) => q));
      return merged;
    });
  }, [ir.nodes]);

  // ── Skills CSV import ─────────────────────────────────────────────────────

  const handleSkillsCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const skillsMap = parseSkillsCSV(text);
      if (skillsMap.size === 0) {
        setCsvStatus("⚠ Could not parse CSV — expected columns: skill_no, skill_name");
        return;
      }
      const { queues: updated, changed, unmatched } = reconcileQueueNames(
        queueRows.map(({ liveStatus, errMsg, ...q }) => q),
        skillsMap,
      );
      const updatedWithStatus: QueueRowState[] = updated.map((q, i) => ({
        ...q,
        liveStatus: queueRows[i]?.liveStatus ?? "unknown",
        errMsg: queueRows[i]?.errMsg,
      }));
      syncQueuesUp(updatedWithStatus);
      const unmatchedMsg = unmatched.length > 0 ? ` · ${unmatched.length} unmatched: ${unmatched.slice(0, 3).join(", ")}${unmatched.length > 3 ? "…" : ""}` : "";
      setCsvStatus(`✓ Updated ${changed} queue name${changed !== 1 ? "s" : ""} from ${skillsMap.size} skills${unmatchedMsg}`);
    };
    reader.readAsText(file);
  };

  // ── Bulk actions ──────────────────────────────────────────────────────────

  const applyRenamestoIR = () => {
    setQueueRows(currentRows => {
      const skillToWhisper = new Map<string, string>();
      currentRows.forEach(q => {
        const cleanedQueueSkill = cleanSkillId(q.queueSkill ?? "");
        if (cleanedQueueSkill && q.connectName !== q.skillWhisper) skillToWhisper.set(cleanedQueueSkill, q.connectName);
      });
      if (!skillToWhisper.size) { alert("No renames to apply — edit queue names first"); return currentRows; }
      let changed = 0;
      const newNodes = { ...ir.nodes };
      for (const [id, node] of Object.entries(ir.nodes)) {
        if (node.action_type !== "SET") continue;
        const asgn = node.content?.assignments;
        if (!asgn) continue;
        const qs = asgn["QueueSkill"];
        if (!qs) continue;
        const newWhisper = skillToWhisper.get(cleanSkillId(qs));
        if (newWhisper && asgn["SkillWhisper"] !== newWhisper) {
          newNodes[id] = { ...node, content: { ...node.content, assignments: { ...asgn, SkillWhisper: newWhisper } } };
          changed++;
        }
      }
      if (changed) { setIR({ ...ir, nodes: newNodes }); alert(`Updated SkillWhisper in ${changed} SET node(s)`); }
      else alert("Nothing to update — SkillWhisper values already match");
      return currentRows;
    });
  };

  const applyArnPatch = () => {
    const updated = patchTransferArns(ir, propQueues);
    if (updated !== ir) { setIR(updated); alert("Injected queue ARNs into TRANSFER nodes"); }
    else alert("No TRANSFER nodes to patch, or all already up to date");
  };

  const matchAll = async () => {
    if (!credentials?.instance_id) return;
    const toProcess = queueRows.filter(q => q.liveStatus !== "exists");

    // Fetch full queue list once, then match client-side
    let allQueues: any[] = [];
    try {
      const client = buildClient(credentials);
      let nextToken: string | undefined;
      do {
        const resp = await client.send(new ListQueuesCommand({
          InstanceId: credentials.instance_id,
          QueueTypes: ["STANDARD"],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        allQueues.push(...(resp.QueueSummaryList ?? []));
        nextToken = resp.NextToken;
      } while (nextToken);
    } catch (e: any) {
      console.warn("[matchAll] ListQueues failed:", e.message);
    }

    const patchByKey = (skillWhisper: string, p: Partial<QueueRowState>) => {
      setQueueRows(prev => {
        const next = prev.map(q => q.skillWhisper === skillWhisper ? { ...q, ...p } : q);
        setPropQueues(next.map(({ liveStatus, errMsg, ...q }) => q));
        return next;
      });
    };

    for (const q of toProcess) {
      patchByKey(q.skillWhisper, { liveStatus: "checking", errMsg: undefined });
      try {
        if (q.queueArn) {
          const resp = await buildClient(credentials).send(new DescribeQueueCommand({
            InstanceId: credentials.instance_id, QueueId: q.queueArn,
          }));
          patchByKey(q.skillWhisper, {
            liveStatus: "exists",
            queueArn: resp.Queue?.QueueArn ?? q.queueArn,
            queueId: resp.Queue?.QueueId ?? q.queueId,
            connectName: resp.Queue?.Name ?? q.connectName,
            errMsg: undefined,
          });
        } else {
          const target = q.connectName.toLowerCase();
          const match = allQueues.find(r => r.Name?.toLowerCase() === target);
          if (match?.QueueArn) {
            patchByKey(q.skillWhisper, {
              liveStatus: "exists",
              queueArn: match.QueueArn,
              queueId: match.QueueId ?? "",
              connectName: match.Name ?? q.connectName,
              errMsg: undefined,
            });
          } else {
            patchByKey(q.skillWhisper, { liveStatus: "missing", errMsg: `No queue named "${q.connectName}" found` });
          }
        }
      } catch (e: any) {
        patchByKey(q.skillWhisper, { liveStatus: "err", errMsg: e.message });
      }
    }
  };

  const createAll = async () => {
    if (!credentials?.instance_id) { alert("Instance ID required"); return; }
    if (!hooRow.hooId) { alert("Create Hours of Operation first"); setActiveTab("hoo"); return; }
    const pending = queueRows.filter(q => !q.queueArn && q.liveStatus !== "creating");
    if (!pending.length) { alert("All queues already provisioned"); return; }

    // Fetch existing queues once to avoid duplicates
    let existingQueues: any[] = [];
    try {
      const client = buildClient(credentials);
      let nextToken: string | undefined;
      do {
        const resp = await client.send(new ListQueuesCommand({
          InstanceId: credentials.instance_id,
          QueueTypes: ["STANDARD"],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        existingQueues.push(...(resp.QueueSummaryList ?? []));
        nextToken = resp.NextToken;
      } while (nextToken);
    } catch { /* proceed anyway */ }

    const patchByKey = (skillWhisper: string, p: Partial<QueueRowState>) => {
      setQueueRows(prev => {
        const next = prev.map(q => q.skillWhisper === skillWhisper ? { ...q, ...p } : q);
        setPropQueues(next.map(({ liveStatus, errMsg, ...q }) => q));
        return next;
      });
    };

    for (const q of pending) {
      patchByKey(q.skillWhisper, { liveStatus: "creating" });
      const sanitized = sanitizeName(q.connectName);

      // Check if already exists in the prefetched list
      const existing = existingQueues.find(r => r.Name?.toLowerCase() === sanitized.toLowerCase());
      if (existing?.QueueArn) {
        patchByKey(q.skillWhisper, { liveStatus: "exists", queueArn: existing.QueueArn, queueId: existing.QueueId ?? "" });
        continue;
      }

      try {
        const resp = await buildClient(credentials).send(new CreateQueueCommand({
          InstanceId: credentials.instance_id, Name: sanitized,
          HoursOfOperationId: hooRow.hooId,
          Description: `IVR queue for ${q.connectName}`,
          Tags: { source: "ivr-editor", ...(q.queueSkill ? { cxone_skill_id: q.queueSkill } : {}), skill_whisper: q.skillWhisper },
        }));
        patchByKey(q.skillWhisper, { liveStatus: "exists", queueArn: resp.QueueArn ?? "", queueId: resp.QueueId ?? "" });
      } catch (e: any) {
        patchByKey(q.skillWhisper, { liveStatus: "err", errMsg: e.message });
      }
    }
  };

  // "Used in" tags: cross-reference allTabs to see which tabs use each queue
  const buildUsedIn = (skillWhisper: string): string[] => {
    if (!allTabs) return [];
    return allTabs
      .filter(t => t.queues.some(q => q.skillWhisper === skillWhisper))
      .map(t => t.label);
  };

  const warnings = validateFlow(ir, propQueues, propHoo);
  const provisionedCount = queueRows.filter(q => q.queueArn).length;
  const tabLabels = (["queues", "hoo", "meta", "validation"] as const);
  const tabLabel = (t: typeof tabLabels[number]) => {
    if (t === "queues") return `Queues (${provisionedCount}/${queueRows.length})`;
    if (t === "hoo") return `HOO${hooRow.hooArn ? " ✓" : ""}`;
    if (t === "meta") return "Metadata";
    return `Validation${warnings.length ? ` ⚠ ${warnings.length}` : " ✓"}`;
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--bg-2)", borderRadius: "var(--radius-lg)", width: 720, maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 32px 64px rgba(0,0,0,0.6)" }}>

        {/* Header */}
        <div style={{ padding: "12px 16px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={tagStyle("var(--purple)", "rgba(162,90,232,0.12)", "rgba(162,90,232,0.3)")}>AWS CONNECT</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}>Skills &amp; Queues</span>
            {!credentials && <span style={{ fontSize: 10, color: "var(--orange)", ...MONO }}>⚠ Not authenticated</span>}
            {credentials && !credentials.instance_id && <span style={{ fontSize: 10, color: "var(--orange)", ...MONO }}>⚠ No Instance selected</span>}
            {credentials?.instance_id && <span style={{ fontSize: 10, color: "var(--green)", ...MONO }}>● {credentials.source === "sso" ? (credentials.identity?.split("/")[1]?.trim() ?? "SSO") : "manual"}</span>}
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: "2px 8px", height: 24, fontSize: 16 }}>×</button>
        </div>

        {/* Instance selector */}
        <InstanceSelector credentials={credentials} instances={instances} onSelectInstance={onSelectInstance} />

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-3)", flexShrink: 0 }}>
          {tabLabels.map(t => (
            <button key={t} onClick={() => setActiveTab(t)} style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 500, color: activeTab === t ? "var(--accent)" : "var(--text-3)", borderBottom: activeTab === t ? "2px solid var(--accent)" : "2px solid transparent" }}>
              {tabLabel(t)}
            </button>
          ))}
        </div>

        {/* Content — scrollable */}
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* ── Queues tab ── */}
          {activeTab === "queues" && (
            <>
              {/* Action bar */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* Skills CSV import */}
                <label className="btn" style={{ fontSize: 10, cursor: "pointer", borderStyle: "dashed" }} title="Import CXone skills CSV to auto-match queue names by skill ID">
                  📋 Load Skills CSV
                  <input ref={csvInputRef} type="file" accept=".csv" onChange={handleSkillsCSV} style={{ display: "none" }} />
                </label>

                <button className="btn btn-ghost" onClick={applyRenamestoIR} style={{ fontSize: 10 }} title="Apply queue renames back into the flow's SET nodes">
                  ↩ Apply Names to Flow
                </button>
                <button className="btn btn-ghost" onClick={applyArnPatch} style={{ fontSize: 10 }} title="Patch TRANSFER nodes with provisioned queue ARNs">
                  🔗 Inject ARNs
                </button>
                {queueRows.some(q => q.liveStatus !== "exists") && (
                  <button className="btn btn-ghost" onClick={matchAll} style={{ fontSize: 10 }}>
                    ↺ Match All
                  </button>
                )}
              </div>

              {/* CSV status */}
              {csvStatus && (
                <div style={{ fontSize: 10, color: csvStatus.startsWith("✓") ? "var(--green)" : "var(--orange)", ...MONO, padding: "4px 8px", background: csvStatus.startsWith("✓") ? "rgba(61,186,126,0.08)" : "rgba(232,149,90,0.08)", borderRadius: "var(--radius)", border: `1px solid ${csvStatus.startsWith("✓") ? "rgba(61,186,126,0.2)" : "rgba(232,149,90,0.2)"}` }}>
                  {csvStatus}
                </div>
              )}

              {queueRows.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO, textAlign: "center", padding: 24 }}>
                  No QueueSkill/SkillWhisper pairs found in flow.<br />
                  Import a CXone JSON or add SET nodes with QueueSkill + SkillWhisper.
                </div>
              ) : (
                /* Scrollable queue list with fixed height */
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto", paddingRight: 2 }}>
                  {queueRows.map((q, i) => (
                    <QueueRow
                      key={q.skillWhisper}
                      queue={q}
                      credentials={credentials}
                      hooId={hooRow.hooId}
                      onChange={p => patchQueueRow(i, p)}
                      onDelete={() => deleteQueueRow(i)}
                      usedInTabs={buildUsedIn(q.skillWhisper)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── HOO tab ── */}
          {activeTab === "hoo" && (
            <div style={{ maxHeight: "100%", overflowY: "auto" }}>
              <HooSection
                hoo={hooRow}
                setHoo={syncHooUp}
                metaHooArn={meta?.hoo_arn || ir.hoo_arn || ""}
                credentials={credentials}
                onHooCreated={arn => onHooCreated?.(arn)}
              />
            </div>
          )}

          {/* ── Metadata tab ── */}
          {activeTab === "meta" && (
            <MetaAutoFill
              ir={ir}
              meta={meta ?? {}}
              setMeta={m => setMeta?.(m)}
              hooArn={hooRow.hooArn}
            />
          )}

          {/* ── Validation tab ── */}
          {activeTab === "validation" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <ValidationBanner warnings={warnings} />
              {warnings.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, lineHeight: 1.7 }}>
                  Fix issues above to ensure the flow works correctly in production.<br />
                  Missing HOO ARN → provision in the HOO tab.<br />
                  Missing queue ARNs → create queues in the Queues tab, then "Inject ARNs".
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-3)", gap: 8, flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
            {provisionedCount}/{queueRows.length} queues provisioned
            {hooRow.hooArn ? " · HOO ✓" : " · HOO not yet created"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>Close</button>
            {activeTab === "queues" && queueRows.some(q => !q.queueArn) && (
              <button className="btn btn-primary" onClick={createAll}>Create All Remaining</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
