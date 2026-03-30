// src/components/AccountPanel.tsx
//
// Global account view — merged Skills & Queues + DynamoDB sync.
// Panels:
//   Queues     — Connect queue inventory with DDB cross-reference, tagging, orphan/missing detection, bulk cleanup
//   HOO        — Hours-of-Operation browser with tagging
//   DDB Flows  — Scan TwilioIVRFlows table; show flows, queue needs, and sync status

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ConnectClient,
  ListQueuesCommand,
  UpdateQueueNameCommand,
  DeleteQueueCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListHoursOfOperationsCommand,
  DescribeHoursOfOperationCommand,
  UpdateHoursOfOperationCommand,
  DeleteHoursOfOperationCommand,
  ListTagsForResourceCommand,
  type QueueSummary,
  type HoursOfOperationSummary,
  type ConnectClientConfig,
} from "@aws-sdk/client-connect";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { UseAwsCredentialsReturn, AwsCredentials, ConnectInstance } from "../hooks/useAwsCredentials";

// ── Constants ────────────────────────────────────────────────────────────────

const FLOW_TABLE = "TwilioIVRFlows";

// ── Styles ───────────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace" };
const LABEL: React.CSSProperties = {
  fontSize: 10, color: "var(--text-2)", fontWeight: 500,
  marginBottom: 4, display: "block", fontFamily: "'IBM Plex Sans', sans-serif",
};
const INPUT: React.CSSProperties = {
  background: "var(--bg-0)", border: "1px solid var(--border)",
  borderRadius: "var(--radius)", color: "var(--text-0)",
  ...MONO, fontSize: 11, padding: "5px 9px", outline: "none",
  width: "100%", boxSizing: "border-box",
};

// ── Client builders ──────────────────────────────────────────────────────────

function buildConnectClient(creds: AwsCredentials): ConnectClient {
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

function buildDdbClient(creds: AwsCredentials): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region: creds.region || "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
    ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

/** A Connect queue row with live status and cross-reference info. */
interface QueueRow extends QueueSummary {
  arn?: string;
  id?: string;
  tags?: Record<string, string>;
  tagsLoaded?: boolean;
  // Cross-ref from DDB
  ddbUsage?: DdbQueueUsage;
  ddbStatus: "unknown" | "matched" | "orphan" | "duplicate";
  /** non-empty when fuzzy-matched (exact name differed) */
  fuzzyMatchedAs?: string;
}

/** Per-skillWhisper usage info collected from DDB. */
interface DdbQueueUsage {
  skillWhisper: string;
  queueSkill?: string;
  flows: DdbFlowMeta[];
}

/** A META row from TwilioIVRFlows. */
interface DdbFlowMeta {
  dialedNumber: string;
  targetFlowId: string;
  startStep?: string;
  hooArn?: string;
  instanceId?: string;
  description?: string;
}

/** Aggregate DDB state. */
interface DdbState {
  flows: DdbFlowMeta[];
  queueUsage: Map<string, DdbQueueUsage>;
  missingInConnect: string[];
  scannedAt: Date;
}

function Tag({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span style={{
      fontSize: 9, borderRadius: 3, padding: "1px 6px", fontWeight: 700,
      letterSpacing: "0.06em", ...MONO, color, background: bg, border: `1px solid ${border}`,
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

// ── DDB scanner ──────────────────────────────────────────────────────────────

async function scanDdb(
  creds: AwsCredentials,
  onProgress?: (msg: string) => void,
): Promise<DdbState> {
  const ddb = buildDdbClient(creds);

  onProgress?.("Scanning DynamoDB for flow metadata…");
  const metaItems: any[] = [];
  let lastKey: any;
  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: FLOW_TABLE,
      FilterExpression: "step_id = :m",
      ExpressionAttributeValues: { ":m": "META" },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    metaItems.push(...(resp.Items ?? []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  const flows: DdbFlowMeta[] = metaItems.map(r => ({
    dialedNumber: r.flow_id ?? "",
    targetFlowId: r.target_flow_id ?? "",
    startStep: r.start_step,
    hooArn: r.hoo_arn,
    instanceId: r.instance_id,
    description: r.description,
  }));

  onProgress?.(`Found ${flows.length} flow(s). Loading queue references…`);

  const queueUsage = new Map<string, DdbQueueUsage>();
  const seenFlowIds = new Set<string>();
  const flowsByTargetId = new Map<string, DdbFlowMeta[]>();
  for (const f of flows) {
    if (!f.targetFlowId) continue;
    if (!flowsByTargetId.has(f.targetFlowId)) flowsByTargetId.set(f.targetFlowId, []);
    flowsByTargetId.get(f.targetFlowId)!.push(f);
  }

  let done = 0;
  for (const [targetFlowId, relatedFlows] of flowsByTargetId.entries()) {
    if (seenFlowIds.has(targetFlowId)) continue;
    seenFlowIds.add(targetFlowId);
    onProgress?.(`Loading flow ${++done}/${flowsByTargetId.size}: ${targetFlowId}`);
    try {
      let stepLastKey: any;
      do {
        const resp = await ddb.send(new QueryCommand({
          TableName: FLOW_TABLE,
          KeyConditionExpression: "flow_id = :fid",
          FilterExpression: "action_type = :set",
          ExpressionAttributeValues: { ":fid": targetFlowId, ":set": "SET" },
          ...(stepLastKey ? { ExclusiveStartKey: stepLastKey } : {}),
        }));
        for (const item of (resp.Items ?? [])) {
          const asgn: Record<string, string> = item.content?.assignments ?? {};
          const sw = asgn["SkillWhisper"];
          const qs = asgn["QueueSkill"];
          if (sw) {
            if (!queueUsage.has(sw)) {
              queueUsage.set(sw, { skillWhisper: sw, queueSkill: qs, flows: [] });
            }
            const usage = queueUsage.get(sw)!;
            if (qs && !usage.queueSkill) usage.queueSkill = qs;
            for (const f of relatedFlows) {
              if (!usage.flows.find(x => x.dialedNumber === f.dialedNumber)) {
                usage.flows.push(f);
              }
            }
          }
        }
        stepLastKey = resp.LastEvaluatedKey;
      } while (stepLastKey);
    } catch (e) {
      console.warn(`[DDB] Failed to query flow ${targetFlowId}:`, e);
    }
  }

  return {
    flows,
    queueUsage,
    missingInConnect: [],
    scannedAt: new Date(),
  };
}

// ── Fuzzy name matching ──────────────────────────────────────────────────────

/**
 * Normalize a queue name for fuzzy comparison:
 * - lowercase
 * - collapse separators (space, dash, underscore) to single space
 * - expand common abbreviations
 * - strip trailing language suffixes to a canonical token
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, " ")          // dash/underscore → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract a canonical language token from a name, or "" if none. */
function langToken(name: string): string {
  const n = normalizeName(name);
  if (/ (en|eng|english)$/.test(n)) return "en";
  if (/ (sp|spa|spanish|español)$/.test(n)) return "sp";
  return "";
}

/** Strip trailing language token from normalized name. */
function stripLang(normalized: string): string {
  return normalized
    .replace(/ (en|eng|english|sp|spa|spanish|español)$/, "")
    .trim();
}

/**
 * Fuzzy score between a Connect queue name and a DDB skillWhisper.
 * Returns 0 (no match) to 3 (strong match).
 *
 * Scoring:
 *   3 — exact name match (case-insensitive)
 *   2 — same base after stripping language suffix + same language
 *   1 — same base after stripping language suffix (language token absent in one)
 *   0 — no match
 *
 * Examples that should score ≥ 2:
 *   "Aetna_WMR SP"  ↔  "Aetna-Health-W-M-R-Spanish"  → both have lang "sp",
 *     normalized base "aetna wmr" vs "aetna health w m r" — score 1 (partial)
 *   "SCAN_Reserv EN" ↔ "SCAN-Reservations-English"
 *     base "scan reserv" vs "scan reservations" — startsWith match → score 2
 */
function fuzzyScore(connectName: string, skillWhisper: string): number {
  const cn = normalizeName(connectName);
  const sw = normalizeName(skillWhisper);
  if (cn === sw) return 3;

  const cnLang = langToken(connectName);
  const swLang = langToken(skillWhisper);
  const cnBase = stripLang(cn);
  const swBase = stripLang(sw);

  if (cnBase === swBase) {
    return (cnLang === swLang || !cnLang || !swLang) ? 2 : 1;
  }

  // Prefix/abbreviation matching — one name's base starts with or contains the other
  const langsCompatible = !cnLang || !swLang || cnLang === swLang;
  if (!langsCompatible) return 0;

  if (cnBase.startsWith(swBase) || swBase.startsWith(cnBase)) return 2;

  // Token overlap: split into words, check if ≥ 60% of shorter set appears in longer
  const cnTokens = new Set(cnBase.split(" ").filter(Boolean));
  const swTokens = new Set(swBase.split(" ").filter(Boolean));
  const smaller = cnTokens.size <= swTokens.size ? cnTokens : swTokens;
  const larger = cnTokens.size <= swTokens.size ? swTokens : cnTokens;
  let overlap = 0;
  for (const t of smaller) {
    // exact token match or substring in longer side
    if (larger.has(t) || [...larger].some(lt => lt.startsWith(t) || t.startsWith(lt))) overlap++;
  }
  const ratio = smaller.size > 0 ? overlap / smaller.size : 0;
  if (ratio >= 0.6) return 1;

  return 0;
}

// ── Queue row cross-reference ────────────────────────────────────────────────

function crossReferenceQueues(
  queues: QueueRow[],
  ddb: DdbState | null,
): QueueRow[] {
  if (!ddb) return queues.map(q => ({ ...q, ddbStatus: "unknown" as const }));

  const nameCount = new Map<string, number>();
  for (const q of queues) {
    const n = (q.Name ?? "").toLowerCase();
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }

  return queues.map(q => {
    const nameLower = (q.Name ?? "").toLowerCase();

    if ((nameCount.get(nameLower) ?? 0) > 1) {
      return { ...q, ddbStatus: "duplicate" as const };
    }

    // 1. Exact match by skillWhisper name or cxone_skill_id tag
    const exactUsage = ddb.queueUsage.get(q.Name ?? "")
      ?? [...ddb.queueUsage.values()].find(u =>
        u.skillWhisper.toLowerCase() === nameLower ||
        (u.queueSkill && q.tags?.["cxone_skill_id"] === u.queueSkill)
      );
    if (exactUsage) {
      return { ...q, ddbUsage: exactUsage, ddbStatus: "matched" as const };
    }

    // 2. Fuzzy match — find the best-scoring DDB entry
    let bestScore = 0;
    let bestUsage: DdbQueueUsage | undefined;
    for (const usage of ddb.queueUsage.values()) {
      const score = fuzzyScore(q.Name ?? "", usage.skillWhisper);
      if (score > bestScore) {
        bestScore = score;
        bestUsage = usage;
      }
    }
    if (bestScore >= 1 && bestUsage) {
      return {
        ...q,
        ddbUsage: bestUsage,
        ddbStatus: "matched" as const,
        fuzzyMatchedAs: bestUsage.skillWhisper,
      };
    }

    return { ...q, ddbStatus: "orphan" as const };
  });
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

/**
 * Connect's TagResource API rejects values containing bare `+` signs
 * (common in E.164 phone numbers) and some other special chars.
 * Strip them and enforce the 256-char limit.
 */
function sanitizeTagValue(v: string): string {
  return v
    .replace(/\+/g, "")
    .replace(/[^\w\s_.:/=\-@,]/g, "_")
    .slice(0, 256);
}

function expectedTags(q: QueueRow): Record<string, string> {
  const tags: Record<string, string> = { source: "ivr-editor" };
  if (q.ddbUsage?.queueSkill) tags["cxone_skill_id"] = sanitizeTagValue(q.ddbUsage.queueSkill);
  if (q.ddbUsage?.skillWhisper) tags["skill_whisper"] = sanitizeTagValue(q.ddbUsage.skillWhisper);
  if (q.ddbUsage?.flows.length) {
    const raw = q.ddbUsage.flows
      .map(f => f.dialedNumber.replace(/^\+/, ""))
      .join(",");
    tags["ivr_flows"] = raw.slice(0, 256);
  }
  return tags;
}

function missingTags(q: QueueRow): Record<string, string> {
  const expected = expectedTags(q);
  const current = q.tags ?? {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(expected)) {
    if (current[k] !== v) result[k] = v;
  }
  return result;
}

// ── Queue Browser ─────────────────────────────────────────────────────────────

type QueueFilter = "all" | "matched" | "orphan" | "duplicate" | "missing-tags";

function QueueBrowser({
  creds,
  instanceId,
  ddb,
  onDdbScan,
  ddbLoading,
  onMissingQueues,
}: {
  creds: AwsCredentials;
  instanceId: string;
  ddb: DdbState | null;
  onDdbScan: () => void;
  ddbLoading: boolean;
  onMissingQueues?: (missing: string[]) => void;
}) {
  const [queues, setQueues] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<QueueFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [tagging, setTagging] = useState<Set<string>>(new Set());
  const [opError, setOpError] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOp, setBulkOp] = useState<"idle" | "deleting" | "tagging">("idle");

  const fetchQueues = async () => {
    setLoading(true); setError(""); setSelected(new Set());
    try {
      const client = buildConnectClient(creds);
      const all: QueueRow[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await client.send(new ListQueuesCommand({
          InstanceId: instanceId,
          QueueTypes: ["STANDARD"],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        all.push(...(resp.QueueSummaryList ?? []).map(q => ({
          ...q, arn: q.Arn, id: q.Id, ddbStatus: "unknown" as const,
        })));
        nextToken = resp.NextToken;
      } while (nextToken);
      const sorted = all.sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? ""));
      setQueues(crossReferenceQueues(sorted, ddb));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // FIX: use a ref to track the last ddb we cross-referenced against, so we
  // only re-run when ddb actually changes identity — not on every render.
  // This prevents the infinite setState loop.
  const lastDdbRef = useRef<DdbState | null>(null);
  useEffect(() => {
    if (ddb === lastDdbRef.current) return;
    lastDdbRef.current = ddb;
    if (queues.length === 0) return;
    setQueues(prev => {
      const updated = crossReferenceQueues(prev, ddb);
      if (ddb && onMissingQueues) {
        const queueNames = new Set(updated.map(q => (q.Name ?? "").toLowerCase()));
        // A skillWhisper is "missing" only if no queue matched it at all
        const missing = [...ddb.queueUsage.keys()].filter(sw => {
          const swLower = sw.toLowerCase();
          // Check both exact and fuzzy: if any queue matched this sw, it's not missing
          return !updated.some(q => q.ddbUsage?.skillWhisper === sw);
        });
        onMissingQueues(missing);
      }
      return updated;
    });
  }, [ddb]);

  useEffect(() => { fetchQueues(); }, [instanceId]);

  // Load tags lazily when a row expands
  const loadTags = async (q: QueueRow) => {
    if (q.tagsLoaded || !q.Arn) return;
    try {
      const resp = await buildConnectClient(creds).send(
        new ListTagsForResourceCommand({ resourceArn: q.Arn })
      );
      setQueues(prev => prev.map(r =>
        r.Id === q.Id ? { ...r, tags: resp.tags ?? {}, tagsLoaded: true } : r
      ));
    } catch { /* ignore */ }
  };

  const displayName = (q: QueueRow) => q.Name ?? "";

  const startRename = (q: QueueRow) => {
    setRenameDraft(d => ({ ...d, [q.Id!]: displayName(q) }));
    setRenaming(q.Id!);
    setExpanded(q.Id!);
  };

  const commitRename = async (q: QueueRow) => {
    const newName = renameDraft[q.Id!]?.trim();
    setRenaming(null);
    if (!newName || newName === displayName(q)) return;
    try {
      await buildConnectClient(creds).send(new UpdateQueueNameCommand({
        InstanceId: instanceId, Id: q.Id!, Name: newName,
      }));
      setQueues(prev => prev.map(r => r.Id === q.Id ? { ...r, Name: newName } : r));
      setOpError(e => { const n = { ...e }; delete n[q.Id!]; return n; });
    } catch (e: any) {
      setOpError(prev => ({ ...prev, [q.Id!]: e.message }));
    }
  };

  const deleteQueue = async (q: QueueRow) => {
    if (!window.confirm(`Delete queue "${displayName(q)}"?\n\nThis cannot be undone.`)) return;
    setDeleting(prev => new Set([...prev, q.Id!]));
    try {
      await buildConnectClient(creds).send(new DeleteQueueCommand({
        InstanceId: instanceId, Id: q.Id!,
      }));
      setQueues(prev => prev.filter(r => r.Id !== q.Id));
      setSelected(prev => { const n = new Set(prev); n.delete(q.Id!); return n; });
      if (expanded === q.Id) setExpanded(null);
    } catch (e: any) {
      setOpError(prev => ({ ...prev, [q.Id!]: e.message }));
    } finally {
      setDeleting(prev => { const n = new Set(prev); n.delete(q.Id!); return n; });
    }
  };

  const applyTags = async (q: QueueRow) => {
    if (!q.Arn) return;
    const toApply = missingTags(q);
    if (Object.keys(toApply).length === 0) return;
    setTagging(prev => new Set([...prev, q.Id!]));
    try {
      await buildConnectClient(creds).send(new TagResourceCommand({
        resourceArn: q.Arn, tags: toApply,
      }));
      const newTags = { ...(q.tags ?? {}), ...toApply };
      setQueues(prev => prev.map(r => r.Id === q.Id ? { ...r, tags: newTags, tagsLoaded: true } : r));
      setOpError(e => { const n = { ...e }; delete n[q.Id!]; return n; });
    } catch (e: any) {
      setOpError(prev => ({ ...prev, [q.Id!]: e.message }));
    } finally {
      setTagging(prev => { const n = new Set(prev); n.delete(q.Id!); return n; });
    }
  };

  // Bulk operations
  const bulkDelete = async () => {
    const confirmed = window.confirm(
      `Delete ${selected.size} selected queue(s)?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;
    setBulkOp("deleting");
    for (const qid of selected) {
      const q = queues.find(r => r.Id === qid);
      if (!q) continue;
      try {
        await buildConnectClient(creds).send(new DeleteQueueCommand({
          InstanceId: instanceId, Id: qid,
        }));
        setQueues(prev => prev.filter(r => r.Id !== qid));
      } catch (e: any) {
        setOpError(prev => ({ ...prev, [qid]: e.message }));
      }
    }
    setSelected(new Set());
    setBulkOp("idle");
  };

  const bulkTag = async () => {
    setBulkOp("tagging");
    for (const qid of selected) {
      const q = queues.find(r => r.Id === qid);
      if (!q?.Arn) continue;
      const toApply = missingTags(q);
      if (Object.keys(toApply).length === 0) continue;
      try {
        await buildConnectClient(creds).send(new TagResourceCommand({
          resourceArn: q.Arn, tags: toApply,
        }));
        const newTags = { ...(q.tags ?? {}), ...toApply };
        setQueues(prev => prev.map(r => r.Id === q.Id ? { ...r, tags: newTags, tagsLoaded: true } : r));
      } catch (e: any) {
        setOpError(prev => ({ ...prev, [qid]: e.message }));
      }
    }
    setSelected(new Set());
    setBulkOp("idle");
  };

  const selectAllOrphans = () => {
    const orphanIds = new Set(queues.filter(q => q.ddbStatus === "orphan").map(q => q.Id!));
    setSelected(orphanIds);
  };

  const filtered = queues.filter(q => {
    const nameMatch = !filter || displayName(q).toLowerCase().includes(filter.toLowerCase());
    if (!nameMatch) return false;
    switch (statusFilter) {
      case "matched": return q.ddbStatus === "matched";
      case "orphan": return q.ddbStatus === "orphan";
      case "duplicate": return q.ddbStatus === "duplicate";
      case "missing-tags":
        if (!q.ddbUsage) return false;
        return Object.keys(missingTags(q)).length > 0;
      default: return true;
    }
  });

  const counts = {
    all: queues.length,
    matched: queues.filter(q => q.ddbStatus === "matched").length,
    orphan: queues.filter(q => q.ddbStatus === "orphan").length,
    duplicate: queues.filter(q => q.ddbStatus === "duplicate").length,
    "missing-tags": queues.filter(q => q.ddbUsage && Object.keys(missingTags(q)).length > 0).length,
  };

  const statusColors: Record<QueueRow["ddbStatus"], string> = {
    unknown: "var(--text-3)",
    matched: "var(--green)",
    orphan: "var(--orange)",
    duplicate: "var(--red)",
  };
  const statusLabels: Record<QueueRow["ddbStatus"], string> = {
    unknown: "?",
    matched: "✓ in DDB",
    orphan: "⚠ orphan",
    duplicate: "⊗ dup",
  };

  const filterTabStyle = (f: QueueFilter): React.CSSProperties => ({
    padding: "4px 10px", fontSize: 10, background: "none", border: "none",
    cursor: "pointer", fontWeight: statusFilter === f ? 600 : 400,
    color: statusFilter === f ? "var(--accent)" : "var(--text-3)",
    borderBottom: statusFilter === f ? "2px solid var(--accent)" : "2px solid transparent",
    ...MONO,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
        <input style={{ ...INPUT, flex: 1, minWidth: 120 }} placeholder="Filter by name…"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <button className="btn btn-ghost" onClick={fetchQueues} disabled={loading}
          style={{ fontSize: 10, padding: "3px 10px", height: 28, flexShrink: 0 }}>
          {loading ? "⟳" : "↺ Refresh"}
        </button>
        <button className="btn" onClick={onDdbScan} disabled={ddbLoading}
          style={{
            fontSize: 10, padding: "3px 10px", height: 28, flexShrink: 0,
            borderColor: "var(--accent)", color: "var(--accent)"
          }}>
          {ddbLoading ? "⟳ Scanning…" : ddb ? "↺ Re-sync DDB" : "⚡ Sync from DDB"}
        </button>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {(["all", "matched", "orphan", "duplicate", "missing-tags"] as QueueFilter[]).map(f => (
          <button key={f} style={filterTabStyle(f)} onClick={() => setStatusFilter(f)}>
            {f === "all" ? `All (${counts.all})`
              : f === "matched" ? `✓ Matched (${counts.matched})`
                : f === "orphan" ? `⚠ Orphan (${counts.orphan})`
                  : f === "duplicate" ? `⊗ Dup (${counts.duplicate})`
                    : `⚐ Missing Tags (${counts["missing-tags"]})`}
          </button>
        ))}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
          background: "rgba(61,142,240,0.08)", border: "1px solid rgba(61,142,240,0.25)",
          borderRadius: "var(--radius)", flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, color: "var(--accent)", ...MONO, flex: 1 }}>
            {selected.size} selected
          </span>
          <button className="btn btn-ghost" onClick={() => setSelected(new Set())}
            style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>Clear</button>
          <button className="btn" onClick={bulkTag} disabled={bulkOp !== "idle"}
            style={{ fontSize: 10, padding: "2px 8px", height: 22, borderColor: "var(--cyan)", color: "var(--cyan)" }}>
            {bulkOp === "tagging" ? "Tagging…" : "⚐ Tag Selected"}
          </button>
          <button className="btn btn-ghost btn-danger" onClick={bulkDelete} disabled={bulkOp !== "idle"}
            style={{ fontSize: 10, padding: "2px 8px", height: 22 }}>
            {bulkOp === "deleting" ? "Deleting…" : "✕ Delete Selected"}
          </button>
        </div>
      )}

      {/* Quick-select helpers */}
      {ddb && counts.orphan > 0 && selected.size === 0 && (
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={selectAllOrphans}
            style={{ fontSize: 10, padding: "2px 8px", height: 22, borderColor: "var(--orange)", color: "var(--orange)" }}>
            Select all {counts.orphan} orphan{counts.orphan !== 1 ? "s" : ""}
          </button>
          <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO, alignSelf: "center" }}>
            DDB synced at {ddb.scannedAt.toLocaleTimeString()}
            {" · "}{ddb.queueUsage.size} queue refs in {ddb.flows.length} flow{ddb.flows.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Missing-in-Connect notice */}
      {ddb && ddb.missingInConnect.length > 0 && (
        <div style={{
          padding: "6px 10px", background: "rgba(224,90,90,0.08)",
          border: "1px solid rgba(224,90,90,0.25)", borderRadius: "var(--radius)",
          fontSize: 10, color: "var(--red)", ...MONO, flexShrink: 0,
        }}>
          ✕ {ddb.missingInConnect.length} DDB queue ref{ddb.missingInConnect.length !== 1 ? "s" : ""} missing from Connect:
          {" "}{ddb.missingInConnect.slice(0, 5).join(", ")}{ddb.missingInConnect.length > 5 ? "…" : ""}
        </div>
      )}

      {error && <div style={{ fontSize: 11, color: "var(--red)", ...MONO, flexShrink: 0 }}>{error}</div>}

      {!loading && queues.length === 0 && !error && (
        <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO, textAlign: "center", padding: 24 }}>
          No queues found in this instance
        </div>
      )}

      {/* Scrollable queue list */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column",
        gap: 4, paddingRight: 2,
      }}>
        {filtered.map((q, _qi) => {
          // FIX: safe key fallback — never let key be ""
          const qid = q.Id ?? q.Arn ?? `row-${_qi}`;
          const name = displayName(q);
          const isExpanded = expanded === qid;
          const isRenaming = renaming === qid;
          const isDeleting = deleting.has(qid);
          const isTagging = tagging.has(qid);
          const isSelected = selected.has(qid);
          const err = opError[qid];
          const tagsMissing = q.ddbUsage ? Object.keys(missingTags(q)).length : 0;

          return (
            <div key={qid} style={{
              background: isSelected ? "rgba(61,142,240,0.07)" : "var(--bg-3)",
              border: `1px solid ${err ? "rgba(224,90,90,0.35)" : isSelected ? "rgba(61,142,240,0.4)" : "var(--border)"}`,
              borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0,
            }}>
              {/* Row */}
              <div style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={isSelected}
                  onChange={e => setSelected(prev => {
                    const n = new Set(prev);
                    if (e.target.checked) n.add(qid); else n.delete(qid);
                    return n;
                  })}
                  style={{ cursor: "pointer", flexShrink: 0 }} />

                <span style={{
                  fontSize: 9, ...MONO, flexShrink: 0,
                  color: statusColors[q.ddbStatus], minWidth: 60,
                }} title={q.ddbStatus === "orphan" ? "Not referenced by any DDB flow" : undefined}>
                  {statusLabels[q.ddbStatus]}
                </span>

                <span style={{
                  fontSize: 11, ...MONO, color: "var(--text-0)", flex: 1, minWidth: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer",
                }}
                  onClick={() => { setExpanded(isExpanded ? null : qid); loadTags(q); }}
                  onDoubleClick={() => startRename(q)}
                  title={q.fuzzyMatchedAs
                    ? `Fuzzy-matched to DDB skillWhisper: "${q.fuzzyMatchedAs}"`
                    : "Click to expand · Double-click to rename"}>
                  {name}
                  {q.fuzzyMatchedAs && (
                    <span style={{ color: "var(--orange)", marginLeft: 5, fontSize: 9 }}>≈</span>
                  )}
                </span>

                {q.ddbUsage && (
                  <span style={{ fontSize: 9, ...MONO, color: "var(--cyan)", flexShrink: 0 }}
                    title={`Used in: ${q.ddbUsage.flows.map(f => f.dialedNumber).join(", ")}`}>
                    {q.ddbUsage.flows.length} flow{q.ddbUsage.flows.length !== 1 ? "s" : ""}
                  </span>
                )}

                {tagsMissing > 0 && (
                  <span style={{ fontSize: 9, ...MONO, color: "var(--orange)", flexShrink: 0 }}
                    title={`${tagsMissing} tag(s) missing`}>
                    ⚐ tags
                  </span>
                )}

                <Tag label={q.QueueType ?? "STD"} color="var(--cyan)" bg="rgba(76,201,201,0.1)" border="rgba(76,201,201,0.25)" />

                <button className="btn btn-ghost" style={{ fontSize: 10, padding: "1px 6px", height: 20, flexShrink: 0 }}
                  onClick={() => startRename(q)} title="Rename">✎</button>
                {q.ddbUsage && tagsMissing > 0 && (
                  <button className="btn btn-ghost" onClick={() => applyTags(q)} disabled={isTagging}
                    style={{
                      fontSize: 10, padding: "1px 6px", height: 20, flexShrink: 0,
                      borderColor: "var(--cyan)", color: "var(--cyan)"
                    }}
                    title="Apply missing tags">
                    {isTagging ? "…" : "⚐"}
                  </button>
                )}
                <button className="btn btn-ghost btn-danger"
                  style={{ fontSize: 12, padding: "1px 5px", height: 20, flexShrink: 0 }}
                  onClick={() => deleteQueue(q)} disabled={isDeleting} title="Delete queue">
                  {isDeleting ? "…" : "×"}
                </button>
                <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO, cursor: "pointer", flexShrink: 0 }}
                  onClick={() => { setExpanded(isExpanded ? null : qid); loadTags(q); }}>
                  {isExpanded ? "▲" : "▼"}
                </span>
              </div>

              {/* Expanded panel */}
              {isExpanded && (
                <div style={{
                  borderTop: "1px solid var(--border)", padding: "8px 10px",
                  background: "var(--bg-0)", display: "flex", flexDirection: "column", gap: 6
                }}>
                  {/* Rename */}
                  {isRenaming && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <input autoFocus style={{ ...INPUT, flex: 1, padding: "3px 7px", fontSize: 11 }}
                        value={renameDraft[qid] ?? name}
                        onChange={e => setRenameDraft(d => ({ ...d, [qid]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") commitRename(q); if (e.key === "Escape") setRenaming(null); }}
                        onBlur={() => commitRename(q)} />
                      <button className="btn btn-primary" style={{ fontSize: 10, padding: "2px 8px", height: 26 }}
                        onClick={() => commitRename(q)}>Save</button>
                      <button className="btn btn-ghost" style={{ fontSize: 10, padding: "2px 6px", height: 26 }}
                        onClick={() => setRenaming(null)}>Cancel</button>
                    </div>
                  )}

                  <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    <span style={{ color: "var(--text-2)" }}>ID:</span> {qid}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, wordBreak: "break-all" }}>
                    <span style={{ color: "var(--text-2)" }}>ARN:</span> {q.Arn}
                  </div>

                  {/* DDB usage */}
                  {q.ddbUsage && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <div style={{
                        fontSize: 9, fontWeight: 600, letterSpacing: "0.08em",
                        textTransform: "uppercase", color: "var(--text-3)", ...MONO
                      }}>DDB Usage</div>
                      <div style={{ fontSize: 10, ...MONO, color: "var(--text-2)" }}>
                        SkillWhisper: <span style={{ color: "var(--cyan)" }}>{q.ddbUsage.skillWhisper}</span>
                        {q.fuzzyMatchedAs && (
                          <span style={{ color: "var(--orange)", marginLeft: 6, fontSize: 9 }}>
                            ≈ fuzzy match (name differs)
                          </span>
                        )}
                        {q.ddbUsage.queueSkill && (
                          <> · Skill ID: <span style={{ color: "var(--orange)" }}>{q.ddbUsage.queueSkill}</span></>
                        )}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {q.ddbUsage.flows.map(f => (
                          <span key={f.dialedNumber} style={{
                            fontSize: 9, ...MONO, background: "rgba(61,142,240,0.1)",
                            border: "1px solid rgba(61,142,240,0.3)", borderRadius: 3,
                            padding: "1px 6px", color: "var(--accent)",
                          }} title={f.description ?? f.targetFlowId}>
                            {f.dialedNumber}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tags */}
                  {q.tagsLoaded ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{
                          fontSize: 9, fontWeight: 600, letterSpacing: "0.08em",
                          textTransform: "uppercase", color: "var(--text-3)", ...MONO
                        }}>Tags</div>
                        {q.ddbUsage && tagsMissing > 0 && (
                          <button className="btn" onClick={() => applyTags(q)} disabled={isTagging}
                            style={{
                              fontSize: 9, padding: "1px 8px", height: 18,
                              borderColor: "var(--cyan)", color: "var(--cyan)"
                            }}>
                            {isTagging ? "…" : `Apply ${tagsMissing} missing tag${tagsMissing !== 1 ? "s" : ""}`}
                          </button>
                        )}
                      </div>
                      {Object.keys(q.tags ?? {}).length === 0 ? (
                        <div style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>No tags</div>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {Object.entries(q.tags ?? {}).map(([k, v]) => {
                            const exp = expectedTags(q);
                            const isCorrect = !exp[k] || exp[k] === v;
                            return (
                              <span key={k} style={{
                                fontSize: 9, ...MONO, background: "var(--bg-3)",
                                border: `1px solid ${isCorrect ? "var(--border)" : "rgba(232,149,90,0.4)"}`,
                                borderRadius: 3, padding: "1px 6px",
                                color: isCorrect ? "var(--text-2)" : "var(--orange)",
                              }}>
                                <span style={{ color: "var(--text-3)" }}>{k}=</span>{v}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {q.ddbUsage && tagsMissing > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {Object.entries(missingTags(q)).map(([k, v]) => (
                            <span key={k} style={{
                              fontSize: 9, ...MONO, background: "rgba(232,149,90,0.06)",
                              border: "1px dashed rgba(232,149,90,0.5)",
                              borderRadius: 3, padding: "1px 6px", color: "var(--orange)",
                            }}>
                              missing: {k}={v}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>Loading tags…</div>
                  )}

                  {err && <div style={{ fontSize: 10, color: "var(--red)", ...MONO }}>{err}</div>}

                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                      onClick={() => navigator.clipboard.writeText(q.Arn ?? "")}>Copy ARN</button>
                    <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                      onClick={() => navigator.clipboard.writeText(qid)}>Copy ID</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, flexShrink: 0 }}>
          {filtered.length} of {queues.length} queues
          {selected.size > 0 && ` · ${selected.size} selected`}
        </div>
      )}
    </div>
  );
}

// ── HOO Browser ───────────────────────────────────────────────────────────────

function HooBrowser({ creds, instanceId }: { creds: AwsCredentials; instanceId: string }) {
  const [hoos, setHoos] = useState<HoursOfOperationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any>>({});
  const [hooTags, setHooTags] = useState<Record<string, Record<string, string>>>({});
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [opError, setOpError] = useState<Record<string, string>>({});
  const [tagging, setTagging] = useState<string | null>(null);

  const fetchHoos = async () => {
    setLoading(true); setError("");
    try {
      const client = buildConnectClient(creds);
      const all: HoursOfOperationSummary[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await client.send(new ListHoursOfOperationsCommand({
          InstanceId: instanceId, ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        all.push(...(resp.HoursOfOperationSummaryList ?? []));
        nextToken = resp.NextToken;
      } while (nextToken);
      setHoos(all.sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? "")));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const fetchDetail = async (hooId: string) => {
    if (detail[hooId]) { setExpanded(hooId); return; }
    try {
      const resp = await buildConnectClient(creds).send(new DescribeHoursOfOperationCommand({
        InstanceId: instanceId, HoursOfOperationId: hooId,
      }));
      setDetail(prev => ({ ...prev, [hooId]: resp.HoursOfOperation }));
      setExpanded(hooId);
    } catch { setExpanded(hooId); }
  };

  const loadHooTags = (h: HoursOfOperationSummary) => {
    const hid = h.HoursOfOperationId!;
    if (hooTags[hid] !== undefined || !h.Arn) return;
    buildConnectClient(creds).send(new ListTagsForResourceCommand({ resourceArn: h.Arn }))
      .then(r => setHooTags(prev => ({ ...prev, [hid]: r.tags ?? {} })))
      .catch(() => setHooTags(prev => ({ ...prev, [hid]: {} })));
  };

  const applySourceTag = async (h: HoursOfOperationSummary) => {
    const hid = h.HoursOfOperationId!;
    if (!h.Arn) return;
    const current = hooTags[hid] ?? {};
    if (current["source"] === "ivr-editor") return;
    setTagging(hid);
    try {
      await buildConnectClient(creds).send(new TagResourceCommand({
        resourceArn: h.Arn, tags: { source: "ivr-editor" },
      }));
      setHooTags(prev => ({ ...prev, [hid]: { ...current, source: "ivr-editor" } }));
    } catch (e: any) {
      setOpError(prev => ({ ...prev, [hid]: e.message }));
    } finally { setTagging(null); }
  };

  const startRename = (h: HoursOfOperationSummary) => {
    setRenameDraft(prev => ({ ...prev, [h.HoursOfOperationId!]: h.Name ?? "" }));
    setRenaming(h.HoursOfOperationId!);
    fetchDetail(h.HoursOfOperationId!);
  };

  const commitRename = async (h: HoursOfOperationSummary) => {
    const hid = h.HoursOfOperationId!;
    const newName = renameDraft[hid]?.trim();
    setRenaming(null);
    if (!newName || newName === h.Name) return;
    const det = detail[hid];
    if (!det) return;
    try {
      await buildConnectClient(creds).send(new UpdateHoursOfOperationCommand({
        InstanceId: instanceId, HoursOfOperationId: hid, Name: newName,
        TimeZone: det.TimeZone ?? "UTC", Config: det.Config ?? [],
      }));
      setHoos(prev => prev.map(r => r.HoursOfOperationId === hid ? { ...r, Name: newName } : r));
      setDetail(prev => ({ ...prev, [hid]: { ...prev[hid], Name: newName } }));
      setOpError(e => { const n = { ...e }; delete n[hid]; return n; });
    } catch (e: any) { setOpError(prev => ({ ...prev, [hid]: e.message })); }
  };

  const deleteHoo = async (h: HoursOfOperationSummary) => {
    const hid = h.HoursOfOperationId!;
    if (!window.confirm(`Delete HOO "${h.Name}"?\n\nThis will break any queues referencing it.`)) return;
    setDeleting(hid);
    try {
      await buildConnectClient(creds).send(new DeleteHoursOfOperationCommand({
        InstanceId: instanceId, HoursOfOperationId: hid,
      }));
      setHoos(prev => prev.filter(r => r.HoursOfOperationId !== hid));
      if (expanded === hid) setExpanded(null);
    } catch (e: any) { setOpError(prev => ({ ...prev, [hid]: e.message })); }
    finally { setDeleting(null); }
  };

  useEffect(() => { fetchHoos(); }, [instanceId]);

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const filtered = hoos.filter(h => !filter || (h.Name ?? "").toLowerCase().includes(filter.toLowerCase()));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <input style={{ ...INPUT, flex: 1 }} placeholder="Filter HOOs…"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <button className="btn btn-ghost" onClick={fetchHoos} disabled={loading}
          style={{ fontSize: 10, padding: "3px 10px", height: 28, flexShrink: 0 }}>
          {loading ? "⟳" : "↺ Refresh"}
        </button>
      </div>

      {error && <div style={{ fontSize: 11, color: "var(--red)", ...MONO, flexShrink: 0 }}>{error}</div>}
      {!loading && hoos.length === 0 && !error && (
        <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO, textAlign: "center", padding: 24 }}>
          No Hours of Operation found
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 2 }}>
        {/* FIX: added _hi index, replaced `d` with `detail[hid]` in JSX */}
        {filtered.map((h, _hi) => {
          const hid = h.HoursOfOperationId ?? h.Arn ?? `hoo-${_hi}`;
          const isOpen = expanded === hid;
          const isRenaming = renaming === hid;
          const isDeleting = deleting === hid;
          const isTagging_ = tagging === hid;
          const err = opError[hid];
          const tags = hooTags[hid];
          const hasSourceTag = tags?.["source"] === "ivr-editor";
          // FIX: look up detail in the map — was mistakenly using bare `d`
          const det = detail[hid];

          return (
            <div key={hid} style={{
              background: "var(--bg-3)",
              border: `1px solid ${err ? "rgba(224,90,90,0.35)" : "var(--border)"}`,
              borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0,
            }}>
              <div style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                <Tag label="HOO" color="var(--cyan)" bg="rgba(90,174,232,0.12)" border="rgba(90,174,232,0.3)" />
                <span style={{
                  fontSize: 11, ...MONO, color: "var(--text-0)", flex: 1, minWidth: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer",
                }}
                  onClick={() => { isOpen ? setExpanded(null) : fetchDetail(hid); loadHooTags(h); }}
                  onDoubleClick={() => startRename(h)}>
                  {h.Name}
                </span>
                {tags !== undefined && !hasSourceTag && (
                  <button className="btn btn-ghost" onClick={() => applySourceTag(h)} disabled={isTagging_}
                    style={{ fontSize: 9, padding: "1px 6px", height: 18, borderColor: "var(--orange)", color: "var(--orange)" }}
                    title="Apply source:ivr-editor tag">
                    {isTagging_ ? "…" : "⚐ tag"}
                  </button>
                )}
                {tags !== undefined && hasSourceTag && (
                  <span style={{ fontSize: 9, color: "var(--green)", ...MONO }}>✓ tagged</span>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 10, padding: "1px 6px", height: 20, flexShrink: 0 }}
                  onClick={() => startRename(h)} title="Rename">✎</button>
                <button className="btn btn-ghost btn-danger"
                  style={{ fontSize: 12, padding: "1px 5px", height: 20, flexShrink: 0 }}
                  onClick={() => deleteHoo(h)} disabled={isDeleting}>
                  {isDeleting ? "…" : "×"}
                </button>
                <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO, cursor: "pointer", flexShrink: 0 }}
                  onClick={() => { isOpen ? setExpanded(null) : fetchDetail(hid); loadHooTags(h); }}>
                  {isOpen ? "▲" : "▼"}
                </span>
              </div>

              {isOpen && (
                <div style={{
                  borderTop: "1px solid var(--border)", padding: "8px 10px",
                  background: "var(--bg-0)", display: "flex", flexDirection: "column", gap: 6
                }}>
                  {isRenaming && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <input autoFocus style={{ ...INPUT, flex: 1, padding: "3px 7px", fontSize: 11 }}
                        value={renameDraft[hid] ?? h.Name ?? ""}
                        onChange={e => setRenameDraft(prev => ({ ...prev, [hid]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") commitRename(h); if (e.key === "Escape") setRenaming(null); }}
                        onBlur={() => commitRename(h)} />
                      <button className="btn btn-primary" style={{ fontSize: 10, padding: "2px 8px", height: 26 }}
                        onClick={() => commitRename(h)}>Save</button>
                      <button className="btn btn-ghost" style={{ fontSize: 10, padding: "2px 6px", height: 26 }}
                        onClick={() => setRenaming(null)}>Cancel</button>
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    <span style={{ color: "var(--text-2)" }}>ID:</span> {hid}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, wordBreak: "break-all" }}>
                    <span style={{ color: "var(--text-2)" }}>ARN:</span> {h.Arn}
                  </div>
                  {!det ? (
                    <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>Loading details…</div>
                  ) : (
                    <>
                      {det.TimeZone && (
                        <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                          <span style={{ color: "var(--text-2)" }}>TZ:</span> {det.TimeZone}
                        </div>
                      )}
                      {det.Config && (
                        <div>
                          {DAYS.map(day => {
                            const cfg = (det.Config as any[]).find((c: any) =>
                              c.Day?.toLowerCase() === day.toLowerCase()
                            );
                            return (
                              <div key={day} style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, marginBottom: 2 }}>
                                <span style={{ fontSize: 9, color: cfg ? "var(--text-1)" : "var(--text-3)", ...MONO }}>
                                  {day.slice(0, 3)}
                                </span>
                                <span style={{ fontSize: 9, color: cfg ? "var(--green)" : "var(--text-3)", ...MONO }}>
                                  {cfg
                                    ? `${String(cfg.StartTime?.Hours ?? 0).padStart(2, "0")}:${String(cfg.StartTime?.Minutes ?? 0).padStart(2, "0")} – ${String(cfg.EndTime?.Hours ?? 0).padStart(2, "0")}:${String(cfg.EndTime?.Minutes ?? 0).padStart(2, "0")}`
                                    : "closed"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                  {tags !== undefined && Object.keys(tags).length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                      {Object.entries(tags).map(([k, v]) => (
                        <span key={k} style={{
                          fontSize: 9, ...MONO, background: "var(--bg-3)",
                          border: "1px solid var(--border)", borderRadius: 3,
                          padding: "1px 6px", color: "var(--text-2)"
                        }}>
                          <span style={{ color: "var(--text-3)" }}>{k}=</span>{v}
                        </span>
                      ))}
                    </div>
                  )}
                  {err && <div style={{ fontSize: 10, color: "var(--red)", ...MONO }}>{err}</div>}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                      onClick={() => navigator.clipboard.writeText(h.Arn ?? "")}>Copy ARN</button>
                    <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                      onClick={() => navigator.clipboard.writeText(hid)}>Copy ID</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {filtered.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, flexShrink: 0 }}>
          {filtered.length} of {hoos.length} HOOs
        </div>
      )}
    </div>
  );
}

// ── DDB Flows Panel ──────────────────────────────────────────────────────────

function DdbFlowsPanel({
  creds,
  ddb,
  onScan,
  loading,
  progressMsg,
}: {
  creds: AwsCredentials;
  ddb: DdbState | null;
  onScan: () => void;
  loading: boolean;
  progressMsg: string;
}) {
  const [filter, setFilter] = useState("");
  const [expandedFlow, setExpandedFlow] = useState<string | null>(null);

  if (!ddb && !loading) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 14, padding: 40, flex: 1, color: "var(--text-3)"
      }}>
        <div style={{ fontSize: 32, opacity: 0.2 }}>⬡</div>
        <div style={{ fontSize: 12, ...MONO }}>DynamoDB not yet scanned</div>
        <div style={{ fontSize: 10, color: "var(--text-3)", maxWidth: 340, textAlign: "center", lineHeight: 1.6 }}>
          Scan the <code style={{ color: "var(--cyan)" }}>TwilioIVRFlows</code> table to load all flows,
          see which queues they require, and cross-reference with your Connect instance.
        </div>
        <button className="btn btn-primary" onClick={onScan} style={{ marginTop: 8 }}>
          ⚡ Scan DynamoDB
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 12, padding: 40, flex: 1, color: "var(--text-2)"
      }}>
        <div style={{ fontSize: 11, ...MONO }}>⟳ Scanning…</div>
        <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, maxWidth: 400, textAlign: "center" }}>
          {progressMsg || "Connecting to DynamoDB…"}
        </div>
      </div>
    );
  }

  const filteredFlows = (ddb?.flows ?? []).filter(f =>
    !filter ||
    f.dialedNumber.includes(filter) ||
    f.targetFlowId.toLowerCase().includes(filter.toLowerCase()) ||
    (f.description ?? "").toLowerCase().includes(filter.toLowerCase())
  );

  const queuesByFlow = new Map<string, DdbQueueUsage[]>();
  for (const usage of (ddb?.queueUsage.values() ?? [])) {
    for (const flow of usage.flows) {
      if (!queuesByFlow.has(flow.dialedNumber)) queuesByFlow.set(flow.dialedNumber, []);
      queuesByFlow.get(flow.dialedNumber)!.push(usage);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <input style={{ ...INPUT, flex: 1 }} placeholder="Filter flows by number, ID, description…"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <button className="btn btn-ghost" onClick={onScan} disabled={loading}
          style={{ fontSize: 10, padding: "3px 10px", height: 28, flexShrink: 0 }}>
          ↺ Re-scan
        </button>
      </div>

      {/* Summary bar */}
      <div style={{
        display: "flex", gap: 16, padding: "6px 10px",
        background: "var(--bg-0)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", flexShrink: 0, flexWrap: "wrap",
      }}>
        {(
          [
            ["Flows", ddb?.flows.length ?? 0, "var(--text-1)"],
            ["Queue refs", ddb?.queueUsage.size ?? 0, "var(--cyan)"],
            ["Missing in Connect", ddb?.missingInConnect.length ?? 0,
              (ddb?.missingInConnect.length ?? 0) > 0 ? "var(--red)" : "var(--green)"],
          ] as [string, number, string][]
        ).map(([label, val, color]) => (
          <div key={label} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>{label}:</span>
            <span style={{ fontSize: 12, fontWeight: 600, color, ...MONO }}>{val}</span>
          </div>
        ))}
        <span style={{ fontSize: 9, color: "var(--text-3)", ...MONO, marginLeft: "auto" }}>
          Scanned {ddb?.scannedAt.toLocaleTimeString()}
        </span>
      </div>

      {(ddb?.missingInConnect.length ?? 0) > 0 && (
        <div style={{
          padding: "6px 10px", background: "rgba(224,90,90,0.08)",
          border: "1px solid rgba(224,90,90,0.25)", borderRadius: "var(--radius)",
          fontSize: 10, color: "var(--red)", ...MONO, flexShrink: 0
        }}>
          ✕ Queues referenced in DDB but not found in Connect:
          {" "}{ddb!.missingInConnect.join(", ")}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 2 }}>
        {filteredFlows.map((flow, _fi) => {
          const isOpen = expandedFlow === flow.dialedNumber;
          const flowQueues = queuesByFlow.get(flow.dialedNumber) ?? [];
          return (
            <div key={flow.dialedNumber || `flow-${_fi}`} style={{
              background: "var(--bg-3)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0,
            }}>
              <div style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                onClick={() => setExpandedFlow(isOpen ? null : flow.dialedNumber)}>
                <Tag label="FLOW" color="var(--purple)" bg="rgba(162,90,232,0.1)" border="rgba(162,90,232,0.3)" />
                <span style={{ fontSize: 11, ...MONO, color: "var(--text-0)", flex: 1 }}>
                  {flow.dialedNumber}
                </span>
                {flow.description && (
                  <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Sans', sans-serif", flex: 1 }}>
                    {flow.description}
                  </span>
                )}
                <span style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>
                  {flowQueues.length} queue{flowQueues.length !== 1 ? "s" : ""}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                  {isOpen ? "▲" : "▼"}
                </span>
              </div>

              {isOpen && (
                <div style={{
                  borderTop: "1px solid var(--border)", padding: "8px 10px",
                  background: "var(--bg-0)", display: "flex", flexDirection: "column", gap: 6
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                      <span style={{ color: "var(--text-2)" }}>Flow ID:</span> {flow.targetFlowId}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                      <span style={{ color: "var(--text-2)" }}>Start:</span> {flow.startStep ?? "—"}
                    </div>
                    {flow.instanceId && (
                      <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                        <span style={{ color: "var(--text-2)" }}>Instance:</span> {flow.instanceId}
                      </div>
                    )}
                    {flow.hooArn && (
                      <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, wordBreak: "break-all" }}>
                        <span style={{ color: "var(--text-2)" }}>HOO:</span> …{flow.hooArn.slice(-20)}
                      </div>
                    )}
                  </div>

                  {flowQueues.length > 0 && (
                    <div>
                      <div style={{
                        fontSize: 9, fontWeight: 600, letterSpacing: "0.08em",
                        textTransform: "uppercase", color: "var(--text-3)", ...MONO, marginBottom: 4
                      }}>
                        Queues ({flowQueues.length})
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {flowQueues.map(usage => (
                          <div key={usage.skillWhisper} style={{
                            display: "flex", alignItems: "center", gap: 8,
                            padding: "3px 6px", background: "var(--bg-3)",
                            borderRadius: "var(--radius)", border: "1px solid var(--border)",
                          }}>
                            <span style={{ fontSize: 10, ...MONO, color: "var(--text-1)", flex: 1 }}>
                              {usage.skillWhisper}
                            </span>
                            {usage.queueSkill && (
                              <span style={{ fontSize: 9, ...MONO, color: "var(--orange)" }}>
                                #{usage.queueSkill}
                              </span>
                            )}
                            {ddb?.missingInConnect.includes(usage.skillWhisper) ? (
                              <span style={{ fontSize: 9, ...MONO, color: "var(--red)" }}>✕ missing</span>
                            ) : (
                              <span style={{ fontSize: 9, ...MONO, color: "var(--green)" }}>✓</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                      onClick={() => navigator.clipboard.writeText(flow.dialedNumber)}>
                      Copy number
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                      onClick={() => navigator.clipboard.writeText(flow.targetFlowId)}>
                      Copy flow ID
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {filteredFlows.length === 0 && ddb && (
          <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO, textAlign: "center", padding: 24 }}>
            No flows match filter
          </div>
        )}
      </div>

      {filteredFlows.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, flexShrink: 0 }}>
          {filteredFlows.length} of {ddb?.flows.length ?? 0} flows
        </div>
      )}
    </div>
  );
}

// ── Main AccountPanel ─────────────────────────────────────────────────────────

interface Props {
  auth: UseAwsCredentialsReturn;
}

type PanelTab = "queues" | "hoo" | "ddb";

export default function AccountPanel({ auth }: Props) {
  const { credentials, instances, instancesLoading, fetchInstances } = auth;
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>(
    () => credentials?.instance_id ?? ""
  );
  const [activePanel, setActivePanel] = useState<PanelTab>("queues");

  const [ddb, setDdb] = useState<DdbState | null>(null);
  const [ddbLoading, setDdbLoading] = useState(false);
  const [ddbError, setDdbError] = useState("");
  const [ddbProgress, setDdbProgress] = useState("");

  const handleMissingQueues = useCallback((missing: string[]) => {
    setDdb(prev => prev ? { ...prev, missingInConnect: missing } : prev);
  }, []);

  useEffect(() => {
    if (!selectedInstanceId && instances.length > 0) {
      const preferred = credentials?.instance_id
        ? instances.find(i => i.id === credentials.instance_id)
        : null;
      setSelectedInstanceId(preferred?.id ?? instances[0]?.id ?? "");
    }
  }, [instances, credentials?.instance_id]);

  const handleSelectInstance = (id: string) => {
    setSelectedInstanceId(id);
    if (credentials) auth.setManual({ ...credentials, instance_id: id });
  };

  const selectedInstance = instances.find(i => i.id === selectedInstanceId);

  const handleDdbScan = useCallback(async () => {
    if (!credentials) return;
    setDdbLoading(true);
    setDdbError("");
    setDdbProgress("Starting scan…");
    try {
      const result = await scanDdb(credentials, setDdbProgress);
      setDdb(result);
      setDdbProgress("");
    } catch (e: any) {
      setDdbError(e.message ?? "DDB scan failed");
      setDdbProgress("");
    } finally {
      setDdbLoading(false);
    }
  }, [credentials]);

  if (!credentials) {
    return (
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: 16, background: "var(--bg-1)", color: "var(--text-3)"
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" opacity={0.3}>
          <path d="M6.5 16.5C4 15.3 2 12.8 2 10c0-4.4 3.6-8 8-8 2.5 0 4.7 1.1 6.2 2.9"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M17.5 7.5C20 8.7 22 11.2 22 14c0 4.4-3.6 8-8 8-2.5 0-4.7-1.1-6.2-2.9"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <div style={{ ...MONO, fontSize: 12 }}>Not connected to AWS</div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>Use "Connect AWS" in the toolbar to authenticate</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-1)", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        background: "var(--bg-2)", borderBottom: "1px solid var(--border)",
        padding: "14px 24px", display: "flex", alignItems: "center", gap: 16, flexShrink: 0, flexWrap: "wrap"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tag label="AWS CONNECT" color="var(--orange)" bg="rgba(232,149,90,0.1)" border="rgba(232,149,90,0.25)" />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)" }}>Account</span>
        </div>

        <div style={{
          fontSize: 11, color: "var(--green)", ...MONO,
          background: "rgba(61,186,126,0.08)", border: "1px solid rgba(61,186,126,0.2)",
          borderRadius: "var(--radius)", padding: "3px 10px"
        }}>
          ● {credentials.source === "sso" ? (credentials.identity ?? "SSO") : "manual keys"}
          {" · "}{credentials.region}
        </div>

        {ddb && (
          <div style={{
            fontSize: 10, ...MONO, color: "var(--accent)",
            background: "rgba(61,142,240,0.08)", border: "1px solid rgba(61,142,240,0.2)",
            borderRadius: "var(--radius)", padding: "3px 8px"
          }}>
            ⬡ {ddb.flows.length} DDB flows · {ddb.queueUsage.size} queue refs
          </div>
        )}

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ ...LABEL, marginBottom: 0, whiteSpace: "nowrap" }}>Instance</label>
          {instancesLoading ? (
            <span style={{ fontSize: 11, color: "var(--text-3)", ...MONO }}>Loading…</span>
          ) : instances.length === 0 ? (
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-3)", ...MONO }}>None found</span>
              <button className="btn btn-ghost" onClick={() => fetchInstances()}
                style={{ fontSize: 10, height: 24, padding: "0 8px" }}>Retry</button>
            </div>
          ) : (
            <select className="input" style={{ fontSize: 11, height: 28, padding: "0 28px 0 8px", minWidth: 240 }}
              value={selectedInstanceId} onChange={e => handleSelectInstance(e.target.value)}>
              <option value="">— Select instance —</option>
              {instances.map(inst => (
                <option key={inst.id} value={inst.id}>{inst.alias} ({inst.id.slice(0, 8)}…)</option>
              ))}
            </select>
          )}
          <button className="btn btn-ghost" onClick={() => fetchInstances()}
            style={{ fontSize: 11, height: 28, padding: "0 8px" }} title="Refresh instances">↺</button>
        </div>
      </div>

      {/* Body */}
      {!selectedInstanceId ? (
        <div style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 10, color: "var(--text-3)"
        }}>
          <div style={{ fontSize: 28, opacity: 0.2 }}>⬡</div>
          <div style={{ fontSize: 12, ...MONO }}>
            {instances.length === 0 ? "No Connect instances found in this account" : "Select a Connect instance above"}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Sidebar nav */}
          <div style={{
            width: 200, background: "var(--bg-2)", borderRight: "1px solid var(--border)",
            padding: "16px 0", display: "flex", flexDirection: "column", gap: 2, flexShrink: 0
          }}>
            <div style={{
              padding: "0 12px 8px", fontSize: 9, fontWeight: 600,
              letterSpacing: "0.12em", color: "var(--text-3)", textTransform: "uppercase", ...MONO
            }}>
              {selectedInstance?.alias ?? selectedInstanceId.slice(0, 16)}
            </div>

            {([
              ["queues", "Queues & Skills"],
              ["hoo", "Hours of Operation"],
              ["ddb", "DynamoDB Flows"],
            ] as [PanelTab, string][]).map(([tab, label]) => (
              <button key={tab} onClick={() => setActivePanel(tab)} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 16px", background: activePanel === tab ? "var(--bg-0)" : "transparent",
                border: "none", borderLeft: activePanel === tab ? "2px solid var(--accent)" : "2px solid transparent",
                color: activePanel === tab ? "var(--text-0)" : "var(--text-2)",
                cursor: "pointer", fontSize: 12, fontWeight: activePanel === tab ? 500 : 400,
                width: "100%", textAlign: "left",
              }}>
                {label}
                {tab === "ddb" && ddb && (
                  <span style={{ marginLeft: "auto", fontSize: 9, ...MONO, color: "var(--accent)" }}>
                    {ddb.flows.length}
                  </span>
                )}
                {tab === "ddb" && !ddb && !ddbLoading && (
                  <span style={{ marginLeft: "auto", fontSize: 9, ...MONO, color: "var(--text-3)" }}>
                    not synced
                  </span>
                )}
              </button>
            ))}

            <div style={{ flex: 1 }} />

            <div style={{
              padding: "8px 12px", fontSize: 9, color: "var(--text-3)", ...MONO,
              lineHeight: 1.6, borderTop: "1px solid var(--border)", marginTop: 8
            }}>
              ID: {selectedInstanceId.slice(0, 16)}…<br />
              Region: {credentials.region}
            </div>
          </div>

          {/* Content */}
          <div style={{
            flex: 1, overflow: "hidden", padding: 20, display: "flex",
            flexDirection: "column", minHeight: 0, maxWidth: 860
          }}>
            {activePanel === "queues" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexShrink: 0 }}>
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)", margin: 0 }}>Queues &amp; Skills</h2>
                  <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    Rename, tag, delete · sync DDB to see which queues are actually needed
                  </span>
                </div>
                {ddbError && (
                  <div style={{
                    fontSize: 10, color: "var(--red)", ...MONO, padding: "4px 8px",
                    background: "rgba(224,90,90,0.08)", borderRadius: "var(--radius)",
                    border: "1px solid rgba(224,90,90,0.25)", flexShrink: 0
                  }}>
                    DDB error: {ddbError}
                  </div>
                )}
                <QueueBrowser
                  creds={credentials}
                  instanceId={selectedInstanceId}
                  ddb={ddb}
                  onDdbScan={handleDdbScan}
                  ddbLoading={ddbLoading}
                  onMissingQueues={handleMissingQueues}
                />
              </div>
            )}

            {activePanel === "hoo" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexShrink: 0 }}>
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)", margin: 0 }}>Hours of Operation</h2>
                  <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    Rename, tag, delete · double-click name to rename
                  </span>
                </div>
                <HooBrowser creds={credentials} instanceId={selectedInstanceId} />
              </div>
            )}

            {activePanel === "ddb" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexShrink: 0 }}>
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)", margin: 0 }}>DynamoDB Flows</h2>
                  <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    {FLOW_TABLE} · all META rows + queue references
                  </span>
                </div>
                {ddbError && (
                  <div style={{
                    fontSize: 10, color: "var(--red)", ...MONO, padding: "4px 8px",
                    background: "rgba(224,90,90,0.08)", borderRadius: "var(--radius)",
                    border: "1px solid rgba(224,90,90,0.25)", flexShrink: 0
                  }}>
                    {ddbError}
                  </div>
                )}
                <DdbFlowsPanel
                  creds={credentials}
                  ddb={ddb}
                  onScan={handleDdbScan}
                  loading={ddbLoading}
                  progressMsg={ddbProgress}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
