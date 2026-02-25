// src/components/SkillsPanel.tsx
import { useState, useEffect } from "react";
import {
  ConnectClient,
  CreateQueueCommand,
  DescribeQueueCommand,
  SearchQueuesCommand,
  CreateHoursOfOperationCommand,
  DescribeHoursOfOperationCommand,
  ListHoursOfOperationsCommand,
  type ConnectClientConfig,
  type HoursOfOperationConfig as AwsHooConfig,
} from "@aws-sdk/client-connect";
import type { IR, FlowMeta } from "../types";
import type { AwsCredentials } from "../hooks/useAwsCredentials";
import { extractSkillWhispers } from "../converter/convertCXJson";
import {
  extractQueuesFromIR,
  patchTransferArns,
  validateFlow,
  type QueueRecord,
  type HoursOfOperation,
  type FlowWarning,
} from "../project";

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  ir: IR;
  setIR: (ir: IR) => void;
  rawCx?: any;
  credentials: AwsCredentials | null;
  /** Read-only: used to seed HOO ARN from metadata if available */
  meta?: Partial<FlowMeta>;
  queues: QueueRecord[];
  setQueues: (q: QueueRecord[]) => void;
  hoo: HoursOfOperation;
  setHoo: (h: HoursOfOperation) => void;
  onClose: () => void;
  onHooCreated?: (arn: string) => void;
}

// ─── Connect client ──────────────────────────────────────────────────────────

function buildClient(creds: AwsCredentials): ConnectClient {
  const cfg: ConnectClientConfig = {
    region: creds.region || "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  };
  return new ConnectClient(cfg);
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
    unknown: ["○", "var(--text-3)", "not checked"],
    checking: ["⟳", "var(--accent)", "checking…"],
    exists: ["✓", "var(--green)", "exists"],
    missing: ["✕", "var(--text-3)", "not found"],
    creating: ["⟳", "var(--cyan)", "creating…"],
    err: ["✕", "var(--red)", errMsg ?? "error"],
  };
  const [icon, color, label] = map[status];
  return (
    <span style={{ fontSize: 11, color, ...MONO, whiteSpace: "nowrap" }} title={errMsg ?? label}>
      {icon} <span style={{ fontSize: 9 }}>{label}</span>
    </span>
  );
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w\s-]/g, "_").trim().replace(/\s+/g, "_");
}

function parseSkillCsv(text: string): Map<string, string> {
  const lines = text.trim().split(/\r?\n/);
  const map = new Map<string, string>();
  if (!lines.length) return map;
  const header = lines[0].toLowerCase().split(",");
  const noIdx = header.indexOf("skill_no");
  const nameIdx = header.indexOf("skill_name");
  if (noIdx === -1 || nameIdx === -1) return map;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const no = cols[noIdx]?.trim();
    const name = cols[nameIdx]?.trim();
    if (no && name) map.set(no, name);
  }
  return map;
}

// ─── Validation banner ────────────────────────────────────────────────────────

function ValidationBanner({ warnings, onSelectNode }: {
  warnings: FlowWarning[];
  onSelectNode?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!warnings.length) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
        background: "rgba(61,186,126,0.08)", border: "1px solid rgba(61,186,126,0.2)",
        borderRadius: "var(--radius)", fontSize: 11, color: "var(--green)",
      }}>
        ✓ No issues detected
      </div>
    );
  }

  const counts = {
    "missing-hoo": 0, "unmatched-queue": 0, "missing-queue-arn": 0,
    "dangling-branch": 0, "no-start": 0,
  };
  for (const w of warnings) counts[w.kind]++;

  const kindColor: Record<FlowWarning["kind"], string> = {
    "no-start": "var(--red)",
    "missing-hoo": "var(--orange)",
    "unmatched-queue": "var(--orange)",
    "missing-queue-arn": "var(--text-2)",
    "dangling-branch": "var(--red)",
  };

  return (
    <div style={{
      border: "1px solid rgba(232,149,90,0.35)",
      borderRadius: "var(--radius)", overflow: "hidden",
    }}>
      <button onClick={() => setExpanded(v => !v)} style={{
        width: "100%", background: "rgba(232,149,90,0.08)", border: "none",
        padding: "6px 12px", cursor: "pointer", display: "flex",
        alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: 11, color: "var(--orange)", ...MONO }}>
          ⚠ {warnings.length} issue{warnings.length !== 1 ? "s" : ""} detected
        </span>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{ padding: "6px 12px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{
              fontSize: 10, color: kindColor[w.kind], ...MONO,
              display: "flex", alignItems: "baseline", gap: 6,
            }}>
              <span style={{ flexShrink: 0 }}>•</span>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── HOO Section ─────────────────────────────────────────────────────────────

function HooSection({ hoo, setHoo, metaHooArn, credentials, onHooCreated }: {
  hoo: HooRowState;
  setHoo: (fn: (h: HooRowState) => HooRowState) => void;
  /** HOO ARN from flow metadata (may differ from hoo.hooArn if not yet reconciled) */
  metaHooArn?: string;
  credentials: AwsCredentials | null;
  onHooCreated?: (arn: string) => void;
}) {
  const [expanded, setExpanded] = useState(!hoo.hooArn && !metaHooArn);
  const [arnDraft, setArnDraft] = useState(hoo.hooArn ?? metaHooArn ?? "");
  const patch = (p: Partial<HooRowState>) => setHoo(h => ({ ...h, ...p }));

  const setDay = (day: Day, dp: Partial<{ enabled: boolean; start: string; end: string }>) =>
    setHoo(h => ({ ...h, schedule: { ...h.schedule, [day]: { ...h.schedule[day], ...dp } } }));

  const needsInstance = !credentials?.instance_id;

  // Extract the HOO ID from an ARN: arn:aws:connect:…:hours-of-operation/UUID → UUID
  const idFromArn = (arn: string): string => {
    const parts = arn.split("/");
    return parts[parts.length - 1] ?? "";
  };

  // Check an ARN (or ID) against Connect — works with both full ARNs and bare UUIDs
  const checkArn = async (arnOrId: string) => {
    if (!credentials?.instance_id || !arnOrId.trim()) return;
    patch({ liveStatus: "checking", errMsg: undefined });
    try {
      const resp = await buildClient(credentials).send(new DescribeHoursOfOperationCommand({
        InstanceId: credentials.instance_id,
        HoursOfOperationId: arnOrId.trim(),
      }));
      const resolvedArn = resp.HoursOfOperation?.HoursOfOperationArn ?? arnOrId;
      const resolvedId = resp.HoursOfOperation?.HoursOfOperationId ?? idFromArn(arnOrId);
      const resolvedName = resp.HoursOfOperation?.Name ?? hoo.name;
      patch({ liveStatus: "exists", hooArn: resolvedArn, hooId: resolvedId, name: resolvedName, errMsg: undefined });
      setArnDraft(resolvedArn);
      onHooCreated?.(resolvedArn);
    } catch (e: any) {
      patch({ liveStatus: "missing", errMsg: `Not found: ${e.message}` });
    }
  };

  // Search for a HOO by name — pages through ListHoursOfOperations until found
  const searchByName = async (name: string) => {
    if (!credentials?.instance_id || !name.trim()) return;
    patch({ liveStatus: "checking", errMsg: undefined });
    try {
      let nextToken: string | undefined;
      do {
        const resp = await buildClient(credentials).send(new ListHoursOfOperationsCommand({
          InstanceId: credentials.instance_id,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        const match = (resp.HoursOfOperationSummaryList ?? []).find(
          h => h.Name?.toLowerCase() === name.trim().toLowerCase()
        );
        if (match?.Arn) {
          // Found — do a full Describe to get schedule details
          const detail = await buildClient(credentials).send(new DescribeHoursOfOperationCommand({
            InstanceId: credentials.instance_id,
            HoursOfOperationId: match.Arn,
          }));
          const resolvedArn = detail.HoursOfOperation?.HoursOfOperationArn ?? match.Arn;
          const resolvedId = detail.HoursOfOperation?.HoursOfOperationId ?? match.Id ?? "";
          const resolvedName = detail.HoursOfOperation?.Name ?? name;
          patch({ liveStatus: "exists", hooArn: resolvedArn, hooId: resolvedId, name: resolvedName, errMsg: undefined });
          setArnDraft(resolvedArn);
          onHooCreated?.(resolvedArn);
          return;
        }
        nextToken = resp.NextToken;
      } while (nextToken);
      patch({ liveStatus: "missing", errMsg: `No HOO named "${name.trim()}" found in Connect` });
    } catch (e: any) {
      patch({ liveStatus: "err", errMsg: e.message });
    }
  };

  // Auto-check on mount: try ARN first, fall back to name search
  useEffect(() => {
    const existingArn = hoo.hooArn ?? metaHooArn;
    if (hoo.liveStatus !== "unknown" || !credentials?.instance_id) return;
    if (existingArn) {
      checkArn(existingArn);
    } else if (hoo.name && hoo.name !== "Business Hours") {
      // Only auto-search by name if it's been customised from the default
      searchByName(hoo.name);
    }
  }, []); // intentionally only on mount

  const create = async () => {
    if (!credentials?.instance_id || !hoo.name) return;
    patch({ liveStatus: "creating", errMsg: undefined });
    const config: AwsHooConfig[] = DAYS.flatMap(day => {
      const d = hoo.schedule[day];
      if (!d?.enabled) return [];
      const [sh, sm] = d.start.split(":").map(Number);
      const [eh, em] = d.end.split(":").map(Number);
      return [{
        Day: day.toUpperCase() as AwsHooConfig["Day"],
        StartTime: { Hours: sh, Minutes: sm },
        EndTime: { Hours: eh, Minutes: em },
      }];
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
      const id = resp.HoursOfOperationId ?? "";
      patch({ liveStatus: "exists", hooArn: arn, hooId: id, errMsg: undefined });
      setArnDraft(arn);
      onHooCreated?.(arn);
    } catch (e: any) {
      patch({ liveStatus: "err", errMsg: e.message });
    }
  };

  const arn = hoo.hooArn;
  const isConfirmed = hoo.liveStatus === "exists";
  // Show "use existing" UI if there's an ARN from metadata but it hasn't been confirmed yet
  const hasMetaArn = !!(metaHooArn && !arn);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
      <button onClick={() => setExpanded(v => !v)} style={{
        width: "100%", background: "var(--bg-3)", border: "none", padding: "8px 12px",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={tagStyle("var(--cyan)", "rgba(90,174,232,0.12)", "rgba(90,174,232,0.3)")}>HOO</span>
          <span style={{ fontSize: 11, color: "var(--text-1)", fontWeight: 500 }}>
            {hoo.name || "Hours of Operation"}
          </span>
          <StatusBadge status={hoo.liveStatus} errMsg={hoo.errMsg} />
        </div>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {needsInstance && (
            <div style={{ fontSize: 11, color: "var(--orange)", ...MONO }}>
              ⚠ Connect Instance ID required to look up or provision
            </div>
          )}

          {/* Existing ARN section — shown when we have an ARN (confirmed or from meta) */}
          <div style={{
            background: isConfirmed ? "rgba(61,186,126,0.06)" : "var(--bg-0)",
            border: `1px solid ${isConfirmed ? "rgba(61,186,126,0.25)" : "var(--border)"}`,
            borderRadius: "var(--radius)", padding: "10px 12px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ ...LABEL, marginBottom: 0 }}>
                {isConfirmed ? "✓ Confirmed HOO ARN" : "HOO ARN"}
                {hasMetaArn && !isConfirmed && (
                  <span style={{ color: "var(--orange)", marginLeft: 6, fontSize: 9 }}>
                    (from metadata — not yet verified)
                  </span>
                )}
              </label>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className="btn btn-ghost"
                  onClick={() => searchByName(hoo.name)}
                  disabled={!hoo.name || needsInstance || hoo.liveStatus === "checking"}
                  style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
                  title={`Search Connect for a HOO named "${hoo.name}"`}
                >
                  🔍 By name
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => checkArn(arnDraft)}
                  disabled={!arnDraft.trim() || needsInstance || hoo.liveStatus === "checking"}
                  style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
                  title="Look up this ARN/ID in Connect and confirm it exists"
                >
                  {hoo.liveStatus === "checking" ? "Checking…" : "Verify →"}
                </button>
              </div>
            </div>
            <input
              style={{
                ...INPUT,
                color: isConfirmed ? "var(--green)" : "var(--text-0)",
                borderColor: isConfirmed ? "rgba(61,186,126,0.3)" : undefined,
              }}
              value={arnDraft}
              onChange={e => setArnDraft(e.target.value)}
              onKeyDown={e => e.key === "Enter" && checkArn(arnDraft)}
              placeholder="arn:aws:connect:…:hours-of-operation/UUID  or bare UUID"
              spellCheck={false}
            />
            {isConfirmed && arn && (
              <div style={{ fontSize: 9, color: "var(--green)", ...MONO }}>
                Name: {hoo.name}{hoo.hooId ? ` · ID: ${hoo.hooId}` : ""}
              </div>
            )}
            {hoo.liveStatus === "missing" && hoo.errMsg && (
              <div style={{ fontSize: 10, color: "var(--orange)", ...MONO }}>{hoo.errMsg}</div>
            )}
          </div>

          {/* Divider */}
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
                  <div key={day} style={{
                    display: "grid", gridTemplateColumns: "20px 80px 1fr 1fr",
                    gap: 8, alignItems: "center",
                  }}>
                    <input type="checkbox" checked={d.enabled}
                      onChange={e => setDay(day as Day, { enabled: e.target.checked })}
                      style={{ cursor: "pointer" }} />
                    <span style={{ fontSize: 10, color: d.enabled ? "var(--text-1)" : "var(--text-3)", ...MONO }}>
                      {day.slice(0, 3)}
                    </span>
                    <input type="time" style={{ ...INPUT, opacity: d.enabled ? 1 : 0.4 }}
                      value={d.start} disabled={!d.enabled}
                      onChange={e => setDay(day as Day, { start: e.target.value })} />
                    <input type="time" style={{ ...INPUT, opacity: d.enabled ? 1 : 0.4 }}
                      value={d.end} disabled={!d.enabled}
                      onChange={e => setDay(day as Day, { end: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-primary" onClick={create}
              disabled={!hoo.name || needsInstance || hoo.liveStatus === "creating"}>
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

function QueueRow({ queue, credentials, hooId, onChange }: {
  queue: QueueRowState;
  credentials: AwsCredentials | null;
  hooId?: string;
  onChange: (patch: Partial<QueueRowState>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(queue.connectName);
  const [expanded, setExpanded] = useState(false);
  const [arnDraft, setArnDraft] = useState(queue.queueArn ?? "");

  const isConfirmed = queue.liveStatus === "exists" && !!queue.queueArn;

  // Extract queue ID from ARN: arn:aws:connect:…:queue/UUID → UUID
  const idFromArn = (arn: string): string => {
    const parts = arn.split("/");
    return parts[parts.length - 1] ?? "";
  };

  // Verify an existing ARN or queue ID against Connect
  const verifyArn = async (arnOrId: string) => {
    if (!credentials?.instance_id || !arnOrId.trim()) return;
    onChange({ liveStatus: "checking", errMsg: undefined });
    try {
      const resp = await buildClient(credentials).send(new DescribeQueueCommand({
        InstanceId: credentials.instance_id,
        QueueId: arnOrId.trim(),
      }));
      const resolvedArn = resp.Queue?.QueueArn ?? arnOrId;
      const resolvedId = resp.Queue?.QueueId ?? idFromArn(arnOrId);
      const resolvedName = resp.Queue?.Name ?? queue.connectName;
      setArnDraft(resolvedArn);
      onChange({
        liveStatus: "exists",
        queueArn: resolvedArn,
        queueId: resolvedId,
        connectName: resolvedName,
        errMsg: undefined,
      });
    } catch (e: any) {
      onChange({ liveStatus: "missing", errMsg: `Not found: ${e.message}` });
    }
  };

  // Search for a queue by name using SearchQueues
  const searchByName = async (name: string) => {
    if (!credentials?.instance_id || !name.trim()) return;
    onChange({ liveStatus: "checking", errMsg: undefined });
    try {
      const resp = await buildClient(credentials).send(new SearchQueuesCommand({
        InstanceId: credentials.instance_id,
        SearchCriteria: {
          StringCondition: {
            FieldName: "name",
            Value: name.trim(),
            ComparisonType: "EXACT",
          },
        },
      }));
      const match = (resp.Queues ?? []).find(
        q => q.Name?.toLowerCase() === name.trim().toLowerCase()
      );
      if (match?.QueueArn) {
        const resolvedArn = match.QueueArn;
        const resolvedId = match.QueueId ?? idFromArn(resolvedArn);
        const resolvedName = match.Name ?? name;
        setArnDraft(resolvedArn);
        onChange({
          liveStatus: "exists",
          queueArn: resolvedArn,
          queueId: resolvedId,
          connectName: resolvedName,
          errMsg: undefined,
        });
      } else {
        onChange({ liveStatus: "missing", errMsg: `No queue named "${name.trim()}" found in Connect` });
      }
    } catch (e: any) {
      onChange({ liveStatus: "err", errMsg: e.message });
    }
  };

  // Auto-check on mount: try ARN first, fall back to name search
  useEffect(() => {
    if (queue.liveStatus !== "unknown" || !credentials?.instance_id) return;
    if (queue.queueArn) {
      verifyArn(queue.queueArn);
    } else {
      // Try to find an existing queue with the same name
      searchByName(queue.connectName);
    }
  }, []); // intentionally only on mount

  const create = async () => {
    if (!credentials?.instance_id) {
      onChange({ liveStatus: "err", errMsg: "Instance ID required" });
      return;
    }
    if (!hooId) {
      onChange({ liveStatus: "err", errMsg: "Create HOO first" });
      return;
    }
    onChange({ liveStatus: "creating", errMsg: undefined });

    // First check if a queue with this name already exists — if so, adopt it
    try {
      const searchResp = await buildClient(credentials).send(new SearchQueuesCommand({
        InstanceId: credentials.instance_id,
        SearchCriteria: {
          StringCondition: {
            FieldName: "name",
            Value: sanitizeName(queue.connectName),
            ComparisonType: "EXACT",
          },
        },
      }));
      const existing = (searchResp.Queues ?? []).find(
        q => q.Name?.toLowerCase() === sanitizeName(queue.connectName).toLowerCase()
      );
      if (existing?.QueueArn) {
        const resolvedArn = existing.QueueArn;
        const resolvedId = existing.QueueId ?? idFromArn(resolvedArn);
        setArnDraft(resolvedArn);
        onChange({
          liveStatus: "exists",
          queueArn: resolvedArn,
          queueId: resolvedId,
          connectName: existing.Name ?? queue.connectName,
          errMsg: undefined,
        });
        return;
      }
    } catch {
      // Ignore search errors — fall through to create
    }

    try {
      const resp = await buildClient(credentials).send(new CreateQueueCommand({
        InstanceId: credentials.instance_id,
        Name: sanitizeName(queue.connectName),
        HoursOfOperationId: hooId,
        Description: `IVR queue for ${queue.connectName}`,
        Tags: {
          source: "ivr-editor",
          ...(queue.queueSkill ? { cxone_skill_id: queue.queueSkill } : {}),
          skill_whisper: queue.skillWhisper,
        },
      }));
      const newArn = resp.QueueArn ?? "";
      const newId = resp.QueueId ?? "";
      setArnDraft(newArn);
      onChange({ liveStatus: "exists", queueArn: newArn, queueId: newId, errMsg: undefined });
    } catch (e: any) {
      // If it already exists (race condition), try one more name search
      if (e.name === "ResourceInUseException" || e.message?.toLowerCase().includes("already exist")) {
        try {
          const fallback = await buildClient(credentials).send(new SearchQueuesCommand({
            InstanceId: credentials.instance_id,
            SearchCriteria: {
              StringCondition: {
                FieldName: "name",
                Value: sanitizeName(queue.connectName),
                ComparisonType: "EXACT",
              },
            },
          }));
          const match = (fallback.Queues ?? []).find(
            q => q.Name?.toLowerCase() === sanitizeName(queue.connectName).toLowerCase()
          );
          if (match?.QueueArn) {
            const resolvedArn = match.QueueArn;
            const resolvedId = match.QueueId ?? idFromArn(resolvedArn);
            setArnDraft(resolvedArn);
            onChange({
              liveStatus: "exists",
              queueArn: resolvedArn,
              queueId: resolvedId,
              connectName: match.Name ?? queue.connectName,
              errMsg: undefined,
            });
            return;
          }
        } catch {/* ignore */ }
      }
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
      {/* ── Compact row ── */}
      <div style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 8 }}>
        {/* Status */}
        <div style={{ minWidth: 82, flexShrink: 0 }}>
          <StatusBadge status={queue.liveStatus} errMsg={queue.errMsg} />
        </div>

        {/* Name */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input
              style={{ ...INPUT, fontSize: 11, padding: "2px 6px" }}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={applyRename}
              onKeyDown={e => {
                if (e.key === "Enter") applyRename();
                if (e.key === "Escape") { setDraft(queue.connectName); setEditing(false); }
              }}
              autoFocus
            />
          ) : (
            <span
              style={{ fontSize: 11, ...MONO, color: "var(--text-0)", cursor: "text" }}
              onClick={() => { setDraft(queue.connectName); setEditing(true); }}
              title="Click to rename"
            >
              {queue.connectName}
            </span>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 1 }}>
            {queue.queueSkill && (
              <span style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>CXone #{queue.queueSkill}</span>
            )}
            <span style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>whisper: {queue.skillWhisper}</span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
          <button
            className="btn btn-ghost"
            onClick={() => setExpanded(v => !v)}
            style={{ fontSize: 10, padding: "2px 6px", height: 22 }}
            title={expanded ? "Collapse" : "Enter existing ARN or verify"}
          >
            {expanded ? "▲" : isConfirmed ? "ARN ✓" : "ARN…"}
          </button>
          <button
            className={`btn ${isConfirmed ? "btn-ghost" : "btn-primary"}`}
            onClick={create}
            disabled={queue.liveStatus === "creating"}
            style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
            title={isConfirmed ? "Re-create queue in Connect" : "Create new queue in Connect"}
          >
            {queue.liveStatus === "creating" ? "…" : isConfirmed ? "Re-create" : "+ Create"}
          </button>
        </div>
      </div>

      {/* ── Expanded ARN section ── */}
      {expanded && (
        <div style={{
          borderTop: "1px solid var(--border)",
          padding: "8px 10px",
          display: "flex", flexDirection: "column", gap: 6,
          background: "var(--bg-0)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ ...LABEL, marginBottom: 0, flexShrink: 0 }}>
              {isConfirmed ? "✓ Queue ARN" : "Queue ARN / ID"}
            </label>
            <div style={{ flex: 1 }} />
            <button
              className="btn btn-ghost"
              onClick={() => searchByName(queue.connectName)}
              disabled={!queue.connectName || !credentials?.instance_id || queue.liveStatus === "checking"}
              style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
              title={`Search Connect for a queue named "${queue.connectName}"`}
            >
              🔍 By name
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => verifyArn(arnDraft)}
              disabled={!arnDraft.trim() || !credentials?.instance_id || queue.liveStatus === "checking"}
              style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
              title="Look up this ARN or queue ID in Connect"
            >
              {queue.liveStatus === "checking" ? "Checking…" : "Verify →"}
            </button>
          </div>
          <input
            style={{
              ...INPUT,
              fontSize: 10,
              color: isConfirmed ? "var(--green)" : "var(--text-0)",
              borderColor: isConfirmed ? "rgba(61,186,126,0.3)" : undefined,
            }}
            value={arnDraft}
            onChange={e => setArnDraft(e.target.value)}
            onKeyDown={e => e.key === "Enter" && verifyArn(arnDraft)}
            placeholder="arn:aws:connect:…:queue/UUID  or bare UUID"
            spellCheck={false}
          />
          {isConfirmed && queue.queueId && (
            <div style={{ fontSize: 9, color: "var(--green)", ...MONO }}>
              ID: {queue.queueId}
            </div>
          )}
          {(queue.liveStatus === "missing" || queue.liveStatus === "err") && queue.errMsg && (
            <div style={{ fontSize: 9, color: "var(--red)", ...MONO }}>{queue.errMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export default function SkillsPanel({
  ir, setIR, rawCx, credentials, meta,
  queues: propQueues, setQueues: setPropQueues,
  hoo: propHoo, setHoo: setPropHoo,
  onClose, onHooCreated,
}: Props) {
  const [activeTab, setActiveTab] = useState<"queues" | "hoo" | "validation">("queues");

  // ── Local queue rows (with live status, not persisted) ────────────────────
  const [queueRows, setQueueRows] = useState<QueueRowState[]>(() => {
    // Merge extracted + saved, preserving ARNs and renamed connectNames
    const extracted = rawCx ? extractSkillWhispers(rawCx).map(s => ({
      skillWhisper: s.skillWhisper,
      queueSkill: s.queueSkill,
      connectName: s.skillWhisper,
    })) : extractQueuesFromIR(ir, propQueues);
    return extracted.map(q => ({
      ...q,
      liveStatus: q.queueArn ? "exists" : "unknown" as ResourceStatus,
    }));
  });

  // ── Local HOO state (with live status) ────────────────────────────────────
  const [hooRow, setHooRow] = useState<HooRowState>({
    ...propHoo,
    liveStatus: propHoo.hooArn ? "exists" : "unknown",
  });

  // ── Sync prop changes back when rows change ───────────────────────────────
  const syncQueuesUp = (rows: QueueRowState[]) => {
    setQueueRows(rows);
    // Strip liveStatus/errMsg for storage
    setPropQueues(rows.map(({ liveStatus, errMsg, ...q }) => q));
  };

  const patchQueueRow = (idx: number, p: Partial<QueueRowState>) => {
    syncQueuesUp(queueRows.map((q, i) => i === idx ? { ...q, ...p } : q));
  };

  const syncHooUp = (fn: (h: HooRowState) => HooRowState) => {
    setHooRow(prev => {
      const next = fn(prev);
      setPropHoo({ name: next.name, timezone: next.timezone, description: next.description, schedule: next.schedule, hooArn: next.hooArn, hooId: next.hooId });
      return next;
    });
  };

  // ── Refresh queue rows if IR changes (re-extract) ─────────────────────────
  useEffect(() => {
    const extracted = rawCx
      ? extractSkillWhispers(rawCx).map(s => ({ skillWhisper: s.skillWhisper, queueSkill: s.queueSkill, connectName: s.skillWhisper }))
      : extractQueuesFromIR(ir, propQueues);

    // Merge with existing rows to preserve live status + ARNs
    const existingMap = new Map(queueRows.map(r => [r.skillWhisper, r]));
    const merged: QueueRowState[] = extracted.map(q => {
      const existing = existingMap.get(q.skillWhisper);
      return existing
        ? { ...existing, ...q, connectName: existing.connectName }
        : { ...q, liveStatus: q.queueArn ? "exists" : "unknown" as ResourceStatus };
    });
    setQueueRows(merged);
  }, [ir.nodes]);

  // ── CSV import ────────────────────────────────────────────────────────────
  const handleCsvImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = ev => {
      const skillMap = parseSkillCsv(ev.target?.result as string);
      if (!skillMap.size) { alert("CSV must have 'skill_no' and 'skill_name' columns"); return; }
      let matched = 0;
      syncQueuesUp(queueRows.map(q => {
        const nameFromCsv = q.queueSkill ? skillMap.get(q.queueSkill) : undefined;
        if (nameFromCsv) { matched++; return { ...q, connectName: nameFromCsv }; }
        return q;
      }));
      alert(`Matched ${matched} of ${queueRows.length} queues from CSV`);
    };
    reader.readAsText(file);
  };

  // ── Apply queue renames back to IR SET nodes ──────────────────────────────
  const applyRenamestoIR = () => {
    const skillToWhisper = new Map<string, string>();
    queueRows.forEach(q => {
      if (q.queueSkill && q.connectName !== q.skillWhisper) {
        skillToWhisper.set(q.queueSkill, q.connectName);
      }
    });
    if (!skillToWhisper.size) { alert("No renames to apply — edit queue names first"); return; }

    let changed = 0;
    const newNodes = { ...ir.nodes };
    for (const [id, node] of Object.entries(ir.nodes)) {
      if (node.action_type !== "SET") continue;
      const asgn = node.content?.assignments;
      if (!asgn) continue;
      const qs = asgn["QueueSkill"];
      if (!qs) continue;
      const newWhisper = skillToWhisper.get(qs);
      if (newWhisper && asgn["SkillWhisper"] !== newWhisper) {
        newNodes[id] = { ...node, content: { ...node.content, assignments: { ...asgn, SkillWhisper: newWhisper } } };
        changed++;
      }
    }
    if (changed) {
      setIR({ ...ir, nodes: newNodes });
      alert(`Updated SkillWhisper in ${changed} SET node(s)`);
    } else {
      alert("Nothing to update — SkillWhisper values already match");
    }
  };

  // ── Patch TRANSFER node ARNs after queue provisioning ────────────────────
  const applyArnPatch = () => {
    const updated = patchTransferArns(ir, propQueues);
    if (updated !== ir) {
      setIR(updated);
      alert("Injected queue ARNs into TRANSFER nodes");
    } else {
      alert("No TRANSFER nodes to patch, or all already up to date");
    }
  };

  // ── Create all unprov'd queues ────────────────────────────────────────────
  const createAll = async () => {
    if (!credentials?.instance_id) { alert("Instance ID required"); return; }
    if (!hooRow.hooId) { alert("Create Hours of Operation first"); setActiveTab("hoo"); return; }
    const pending = queueRows.filter(q => !q.queueArn && q.liveStatus !== "creating");
    if (!pending.length) { alert("All queues already provisioned"); return; }
    for (const q of pending) {
      const idx = queueRows.findIndex(r => r.skillWhisper === q.skillWhisper);
      if (idx < 0) continue;
      patchQueueRow(idx, { liveStatus: "creating" });

      const sanitized = sanitizeName(q.connectName);

      // Check if the queue already exists before trying to create
      let existingArn: string | undefined;
      let existingId: string | undefined;
      let existingName: string | undefined;
      try {
        const searchResp = await buildClient(credentials).send(new SearchQueuesCommand({
          InstanceId: credentials.instance_id,
          SearchCriteria: {
            StringCondition: { FieldName: "name", Value: sanitized, ComparisonType: "EXACT" },
          },
        }));
        const match = (searchResp.Queues ?? []).find(
          r => r.Name?.toLowerCase() === sanitized.toLowerCase()
        );
        if (match?.QueueArn) {
          existingArn = match.QueueArn;
          existingId = match.QueueId ?? match.QueueArn.split("/").pop();
          existingName = match.Name;
        }
      } catch {/* ignore — will try create anyway */ }

      if (existingArn) {
        patchQueueRow(idx, {
          liveStatus: "exists",
          queueArn: existingArn,
          queueId: existingId ?? "",
          connectName: existingName ?? q.connectName,
        });
        continue;
      }

      try {
        const resp = await buildClient(credentials).send(new CreateQueueCommand({
          InstanceId: credentials.instance_id,
          Name: sanitized,
          HoursOfOperationId: hooRow.hooId,
          Description: `IVR queue for ${q.connectName}`,
          Tags: {
            source: "ivr-editor",
            ...(q.queueSkill ? { cxone_skill_id: q.queueSkill } : {}),
            skill_whisper: q.skillWhisper,
          },
        }));
        patchQueueRow(idx, {
          liveStatus: "exists",
          queueArn: resp.QueueArn ?? "",
          queueId: resp.QueueId ?? "",
        });
      } catch (e: any) {
        // Last resort: if already exists, do one more search to pick up the ARN
        if (e.name === "ResourceInUseException" || e.message?.toLowerCase().includes("already exist")) {
          try {
            const fallback = await buildClient(credentials).send(new SearchQueuesCommand({
              InstanceId: credentials.instance_id,
              SearchCriteria: {
                StringCondition: { FieldName: "name", Value: sanitized, ComparisonType: "EXACT" },
              },
            }));
            const match = (fallback.Queues ?? []).find(
              r => r.Name?.toLowerCase() === sanitized.toLowerCase()
            );
            if (match?.QueueArn) {
              patchQueueRow(idx, {
                liveStatus: "exists",
                queueArn: match.QueueArn,
                queueId: match.QueueId ?? "",
                connectName: match.Name ?? q.connectName,
              });
              continue;
            }
          } catch {/* ignore */ }
        }
        patchQueueRow(idx, { liveStatus: "err", errMsg: e.message });
      }
    }
  };

  // ── Match all queues: verify by ARN if available, otherwise search by name ─
  const matchAll = async () => {
    if (!credentials?.instance_id) return;
    const toProcess = queueRows
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => q.liveStatus !== "exists");

    for (const { q, i } of toProcess) {
      patchQueueRow(i, { liveStatus: "checking", errMsg: undefined });

      if (q.queueArn) {
        // Verify existing ARN
        try {
          const resp = await buildClient(credentials).send(new DescribeQueueCommand({
            InstanceId: credentials.instance_id,
            QueueId: q.queueArn,
          }));
          patchQueueRow(i, {
            liveStatus: "exists",
            queueArn: resp.Queue?.QueueArn ?? q.queueArn,
            queueId: resp.Queue?.QueueId ?? q.queueId,
            connectName: resp.Queue?.Name ?? q.connectName,
            errMsg: undefined,
          });
        } catch {
          // ARN invalid — fall through to name search
          try {
            const nameResp = await buildClient(credentials).send(new SearchQueuesCommand({
              InstanceId: credentials.instance_id,
              SearchCriteria: {
                StringCondition: { FieldName: "name", Value: q.connectName, ComparisonType: "EXACT" },
              },
            }));
            const match = (nameResp.Queues ?? []).find(
              r => r.Name?.toLowerCase() === q.connectName.toLowerCase()
            );
            if (match?.QueueArn) {
              patchQueueRow(i, {
                liveStatus: "exists",
                queueArn: match.QueueArn,
                queueId: match.QueueId ?? "",
                connectName: match.Name ?? q.connectName,
                errMsg: undefined,
              });
            } else {
              patchQueueRow(i, { liveStatus: "missing", errMsg: "ARN invalid and no name match found" });
            }
          } catch (e: any) {
            patchQueueRow(i, { liveStatus: "missing", errMsg: e.message });
          }
        }
      } else {
        // No ARN — search by name only
        try {
          const resp = await buildClient(credentials).send(new SearchQueuesCommand({
            InstanceId: credentials.instance_id,
            SearchCriteria: {
              StringCondition: { FieldName: "name", Value: q.connectName, ComparisonType: "EXACT" },
            },
          }));
          const match = (resp.Queues ?? []).find(
            r => r.Name?.toLowerCase() === q.connectName.toLowerCase()
          );
          if (match?.QueueArn) {
            patchQueueRow(i, {
              liveStatus: "exists",
              queueArn: match.QueueArn,
              queueId: match.QueueId ?? "",
              connectName: match.Name ?? q.connectName,
              errMsg: undefined,
            });
          } else {
            patchQueueRow(i, { liveStatus: "missing", errMsg: `No queue named "${q.connectName}" found` });
          }
        } catch (e: any) {
          patchQueueRow(i, { liveStatus: "err", errMsg: e.message });
        }
      }
    }
  };

  // ── Validation ────────────────────────────────────────────────────────────
  const warnings = validateFlow(ir, propQueues, propHoo);
  const provisionedCount = queueRows.filter(q => q.queueArn).length;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--bg-2)", borderRadius: "var(--radius-lg)", width: 700,
        maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 32px 64px rgba(0,0,0,0.6)",
      }}>
        {/* Header */}
        <div style={{
          padding: "12px 16px", background: "var(--bg-3)",
          borderBottom: "1px solid var(--border)", display: "flex",
          alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={tagStyle("var(--purple)", "rgba(162,90,232,0.12)", "rgba(162,90,232,0.3)")}>
              AWS CONNECT
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}>
              Skills &amp; Queues
            </span>
            {!credentials && (
              <span style={{ fontSize: 10, color: "var(--orange)", ...MONO }}>⚠ Not authenticated</span>
            )}
          </div>
          <button className="btn btn-ghost" onClick={onClose}
            style={{ padding: "2px 8px", height: 24, fontSize: 16 }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-3)" }}>
          {([
            ["queues", `Queues (${provisionedCount}/${queueRows.length})`],
            ["hoo", `HOO${hooRow.hooArn ? " ✓" : ""}`],
            ["validation", `Validation${warnings.length ? ` ⚠ ${warnings.length}` : " ✓"}`],
          ] as const).map(([t, label]) => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              padding: "8px 16px", background: "none", border: "none", cursor: "pointer",
              fontSize: 11, fontWeight: 500,
              color: activeTab === t ? "var(--accent)" : "var(--text-3)",
              borderBottom: activeTab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}>{label}</button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* QUEUES TAB */}
          {activeTab === "queues" && (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label className="btn btn-ghost" style={{ fontSize: 10, cursor: "pointer" }}>
                  📂 Import skills CSV
                  <input type="file" accept=".csv" onChange={handleCsvImport} style={{ display: "none" }} />
                </label>
                <button className="btn btn-ghost" onClick={applyRenamestoIR}
                  style={{ fontSize: 10 }} title="Apply queue renames back into the flow's SET nodes">
                  ↩ Apply Names to Flow
                </button>
                <button className="btn btn-ghost" onClick={applyArnPatch}
                  style={{ fontSize: 10 }} title="Patch TRANSFER nodes with provisioned queue ARNs">
                  🔗 Inject ARNs to TRANSFER nodes
                </button>
                {queueRows.some(q => q.liveStatus !== "exists") && (
                  <button className="btn btn-ghost" onClick={matchAll}
                    style={{ fontSize: 10 }} title="Match all queues by ARN or name against Connect">
                    ↺ Match All
                  </button>
                )}
              </div>

              {queueRows.length === 0 ? (
                <div style={{
                  fontSize: 11, color: "var(--text-3)", ...MONO,
                  textAlign: "center", padding: 24,
                }}>
                  No QueueSkill/SkillWhisper pairs found in flow.
                  <br />
                  Import a CXone JSON or add SET nodes with QueueSkill + SkillWhisper.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {queueRows.map((q, i) => (
                    <QueueRow
                      key={q.skillWhisper}
                      queue={q}
                      credentials={credentials}
                      hooId={hooRow.hooId}
                      onChange={p => patchQueueRow(i, p)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* HOO TAB */}
          {activeTab === "hoo" && (
            <HooSection
              hoo={hooRow}
              setHoo={syncHooUp}
              metaHooArn={meta?.hoo_arn ?? ir.hoo_arn}
              credentials={credentials}
              onHooCreated={arn => {
                onHooCreated?.(arn);
              }}
            />
          )}

          {/* VALIDATION TAB */}
          {activeTab === "validation" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <ValidationBanner warnings={warnings} />
              {warnings.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, lineHeight: 1.7 }}>
                  Fix issues above to ensure the flow works correctly in production.
                  <br />
                  Missing HOO ARN → provision in the HOO tab.
                  <br />
                  Missing queue ARNs → create queues in the Queues tab, then "Inject ARNs to TRANSFER nodes".
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 16px", borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: "var(--bg-3)", gap: 8,
        }}>
          <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
            {provisionedCount}/{queueRows.length} queues provisioned
            {hooRow.hooArn ? " · HOO ✓" : " · HOO not yet created"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>Close</button>
            {activeTab === "queues" && queueRows.some(q => !q.queueArn) && (
              <button className="btn btn-primary" onClick={createAll}>
                Create All Remaining
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}