// src/components/AccountPanel.tsx
//
// Global account view — merged Skills & Queues + DynamoDB sync.
// Panels:
//   Queues     — Connect queue inventory with DDB cross-reference, tagging, orphan/missing detection, bulk cleanup
//   HOO        — Hours-of-Operation browser with tagging
//   DDB Flows  — Scan TwilioIVRFlows table; show flows, queue needs, and sync status

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  ConnectClient,
  ListQueuesCommand,
  ListHoursOfOperationsCommand,
  DescribeHoursOfOperationCommand,
  UpdateHoursOfOperationCommand,
  DeleteHoursOfOperationCommand,
  ListTagsForResourceCommand,
  type QueueSummary,
  type HoursOfOperationSummary,
} from "@aws-sdk/client-connect";
import type { UseAwsCredentialsReturn, AwsCredentials, ConnectInstance } from "../hooks/useAwsCredentials";
import { connectClient } from "../utils/awsClients";
import { renameQueue, deleteQueue as deleteQueueOp, tagResource, createQueue } from "../utils/queueSync";
import { FLOW_TABLE, loadFlowFromDdb, deleteFlowFromDdb, deleteSteps, editFlowMeta, renameFlow, setFlowMetaFields, type DdbState, type DdbFlow, type DdbFlowMeta, type DdbQueueUsage } from "../utils/ddbScan";
import { annotationsToMap, setAnnotation, type FlowAnnotation } from "../stores/flowAnnotations";
import { unreachableStepIds } from "../utils/flowPrune";
import {
  classifyQueue,
  planMissingQueueCreates,
  clusterDuplicateQueues,
  planDuplicateCleanup,
  type ClusterCleanup,
  type DuplicateCluster,
} from "../utils/queueReconcile";
import { scanQueueDependencies, findQueuesUsingHoo, reassignAndDeleteHoo, type QueueDependency } from "../utils/connectDeps";
import { executeDuplicateCleanup } from "../utils/duplicateCleanup";
import { useDdbStore } from "../stores/ddbStore";
import type { IR, FlowMeta } from "../types";
import { buildFlowRegistry, type FlowRegistry, type FlowRow } from "../utils/flowRegistry";
import { toMarkdown, toCsv, toJson } from "../utils/flowRegistryExport";

// ── Download helper ──────────────────────────────────────────────────────────

/** Trigger a client-side text download (used by the registry exporters). */
function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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
  return connectClient(creds);
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
    const isDuplicate = (nameCount.get((q.Name ?? "").toLowerCase()) ?? 0) > 1;
    const c = classifyQueue(q, ddb, isDuplicate);
    return {
      ...q,
      ddbStatus: c.status,
      ddbUsage: c.ddbUsage,
      fuzzyMatchedAs: c.fuzzyMatchedAs,
    };
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
  const [creatingMissing, setCreatingMissing] = useState(false);
  const [createMsg, setCreateMsg] = useState("");
  // Duplicate-queue cleanup
  const [dupPlans, setDupPlans] = useState<ClusterCleanup[] | null>(null);
  const [dupManual, setDupManual] = useState<DuplicateCluster[]>([]);
  const [dupScanning, setDupScanning] = useState(false);
  const [dupApplying, setDupApplying] = useState(false);
  const [dupMsg, setDupMsg] = useState("");

  const findDuplicates = async () => {
    if (!ddb) { setDupMsg("Scan DynamoDB first — it determines which queue your flows actually use."); return; }
    setDupScanning(true); setDupMsg(""); setDupPlans(null); setDupManual([]);
    try {
      const clusters = clusterDuplicateQueues(queues, ddb);
      if (clusters.length === 0) { setDupPlans([]); setDupMsg("No duplicate queues found."); return; }
      const deps = await scanQueueDependencies(buildConnectClient(creds), instanceId);
      setDupPlans(planDuplicateCleanup(clusters, deps));
      setDupManual(clusters.filter(c => c.needsManualPick));
    } catch (e: any) {
      setDupMsg(e?.message ?? "Duplicate scan failed");
    } finally {
      setDupScanning(false);
    }
  };

  const applyCleanup = async () => {
    if (!dupPlans?.length) return;
    const repoints = dupPlans.reduce((n, p) => n + p.repoints.length, 0);
    const deletes = dupPlans.reduce((n, p) => n + p.duplicates.length, 0);
    if (!window.confirm(
      `Repoint ${repoints} dependenc${repoints !== 1 ? "ies" : "y"} to the canonical queues and delete ${deletes} duplicate queue${deletes !== 1 ? "s" : ""}?\n\nThis cannot be undone.`,
    )) return;
    setDupApplying(true); setDupMsg("");
    try {
      const r = await executeDuplicateCleanup(buildConnectClient(creds), instanceId, dupPlans);
      setDupMsg(`Repointed ${r.repointed} · deleted ${r.deleted}${r.errors.length ? ` · ${r.errors.length} couldn't be removed (still referenced)` : ""}`);
      setDupPlans(null); setDupManual([]);
      await fetchQueues();
    } catch (e: any) {
      setDupMsg(e?.message ?? "Cleanup failed");
    } finally {
      setDupApplying(false);
    }
  };

  // Manual "reassign dependencies & delete" for a single queue — you pick the
  // redirect target rather than relying on the automatic canonical match.
  const [reassign, setReassign] = useState<{ queue: QueueRow; deps: QueueDependency[] } | null>(null);
  const [reassignTarget, setReassignTarget] = useState("");
  const [reassignBusy, setReassignBusy] = useState(false);
  const [reassignMsg, setReassignMsg] = useState("");

  const startReassignDelete = async (queue: QueueRow) => {
    setReassign({ queue, deps: [] }); setReassignTarget(""); setReassignBusy(true);
    setReassignMsg("Scanning routing profiles & quick connects…");
    try {
      const all = await scanQueueDependencies(buildConnectClient(creds), instanceId);
      const deps = (queue.Id && all.get(queue.Id)) || [];
      setReassign({ queue, deps });
      setReassignMsg(deps.length ? "" : "No routing-profile / quick-connect dependencies — safe to delete.");
    } catch (e: any) {
      setReassignMsg(e?.message ?? "Dependency scan failed");
    } finally {
      setReassignBusy(false);
    }
  };

  const confirmReassignDelete = async () => {
    if (!reassign) return;
    const { queue, deps } = reassign;
    const target = queues.find(x => x.Id === reassignTarget);
    if (deps.length > 0 && !target) { setReassignMsg("Choose a queue to repoint these dependencies to."); return; }
    setReassignBusy(true); setReassignMsg("");
    try {
      const plan: ClusterCleanup = {
        normalized: "manual",
        canonical: target ?? queue, // unused when there are no repoints
        duplicates: [queue],
        repoints: deps.map(d => ({ duplicate: queue, dependency: d })),
      };
      const r = await executeDuplicateCleanup(buildConnectClient(creds), instanceId, [plan]);
      setReassign(null); setReassignTarget("");
      if (r.errors.length) setError(`Could not fully delete: ${r.errors.map(e => e.error).join("; ")}`);
      await fetchQueues();
    } catch (e: any) {
      setReassignMsg(e?.message ?? "Failed");
    } finally {
      setReassignBusy(false);
    }
  };

  // Create the queues that DDB flows reference but Connect doesn't have, each
  // with its referencing flow's HOO. Queues with no resolvable HOO are skipped
  // and surfaced; the batch continues.
  const createMissingQueues = async () => {
    if (!ddb) return;
    const missingUsages = ddb.missingInConnect
      .map(sw => ddb.queueUsage.get(sw))
      .filter(Boolean) as DdbQueueUsage[];
    const plans = planMissingQueueCreates(missingUsages);
    setCreatingMissing(true); setCreateMsg("");
    const client = buildConnectClient(creds);
    const createdWhispers: string[] = []; const skipped: string[] = []; const failed: string[] = [];
    for (const p of plans) {
      if (!p.hooId) { skipped.push(p.skillWhisper); continue; }
      try {
        await createQueue(client, instanceId, {
          name: p.skillWhisper, hoursOfOperationId: p.hooId,
          tags: p.tags, description: `IVR queue for ${p.skillWhisper}`,
        });
        createdWhispers.push(p.skillWhisper);
      } catch (e: any) {
        failed.push(`${p.skillWhisper}: ${e.message}`);
      }
    }
    setCreatingMissing(false);
    setCreateMsg(
      `Created ${createdWhispers.length}` +
      (skipped.length ? ` · skipped ${skipped.length} (no HOO)` : "") +
      (failed.length ? ` · ${failed.length} failed` : ""),
    );
    // Drop the now-created queues from the missing banner so a re-click can't
    // attempt to create them again (which would DuplicateResource-fail).
    if (createdWhispers.length && onMissingQueues) {
      onMissingQueues(ddb.missingInConnect.filter(sw => !createdWhispers.includes(sw)));
    }
    await fetchQueues();
  };

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
      await renameQueue(buildConnectClient(creds), instanceId, q.Id!, newName);
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
      await deleteQueueOp(buildConnectClient(creds), instanceId, q.Id!);
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
      await tagResource(buildConnectClient(creds), q.Arn, toApply);
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
        await deleteQueueOp(buildConnectClient(creds), instanceId, qid);
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
        await tagResource(buildConnectClient(creds), q.Arn, toApply);
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
            {" · "}{ddb.queueUsage.size} queue refs in {ddb.flowDefs.length} flow{ddb.flowDefs.length !== 1 ? "s" : ""}
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              ✕ {ddb.missingInConnect.length} DDB queue ref{ddb.missingInConnect.length !== 1 ? "s" : ""} missing from Connect:
              {" "}{ddb.missingInConnect.slice(0, 5).join(", ")}{ddb.missingInConnect.length > 5 ? "…" : ""}
            </span>
            <button className="btn" style={{ fontSize: 9, padding: "1px 8px", height: 20, flexShrink: 0 }}
              disabled={creatingMissing}
              onClick={createMissingQueues}
              title="Create these queues in Connect, each with its referencing flow's HOO">
              {creatingMissing ? "Creating…" : "＋ Create in Connect"}
            </button>
          </div>
          {createMsg && <div style={{ marginTop: 4, color: "var(--text-2)" }}>{createMsg}</div>}
        </div>
      )}

      {/* Duplicate-queue cleanup */}
      <div style={{
        padding: "6px 10px", background: "var(--bg-0)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", fontSize: 10, ...MONO, flexShrink: 0,
        display: "flex", flexDirection: "column", gap: 6,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-2)", flex: 1 }}>
            Duplicate cleanup — find <code style={{ color: "var(--cyan)" }}>-</code>/<code style={{ color: "var(--cyan)" }}>_</code>/space variants, repoint routing profiles &amp; quick connects to the queue your flows use, then delete the extras.
          </span>
          <button className="btn" style={{ fontSize: 9, padding: "1px 8px", height: 20, flexShrink: 0 }}
            disabled={dupScanning || dupApplying}
            onClick={findDuplicates}>
            {dupScanning ? "Scanning deps…" : "⧉ Find duplicates"}
          </button>
        </div>

        {dupPlans && dupPlans.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {dupPlans.map(p => (
              <div key={p.canonical.Id} style={{
                padding: "4px 6px", background: "var(--bg-3)", border: "1px solid var(--border)",
                borderRadius: "var(--radius)", display: "flex", flexDirection: "column", gap: 2,
              }}>
                <div>
                  <span style={{ color: "var(--green)" }}>✓ keep</span>{" "}
                  <span style={{ color: "var(--text-0)" }}>{p.canonical.Name}</span>
                </div>
                {p.duplicates.map(d => (
                  <div key={d.Id} style={{ color: "var(--text-3)", paddingLeft: 12 }}>
                    <span style={{ color: "var(--red)" }}>✕ delete</span> {d.Name}
                  </div>
                ))}
                <div style={{ color: "var(--text-3)", paddingLeft: 12 }}>
                  {p.repoints.length} dependenc{p.repoints.length !== 1 ? "ies" : "y"} to repoint
                  {p.repoints.length > 0 && (
                    <> ({[...new Set(p.repoints.map(r => r.dependency.kind))].join(", ")})</>
                  )}
                </div>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-danger" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                disabled={dupApplying}
                onClick={applyCleanup}>
                {dupApplying ? "Applying…" : `Apply cleanup (${dupPlans.length} cluster${dupPlans.length !== 1 ? "s" : ""})`}
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 8px", height: 20 }}
                disabled={dupApplying} onClick={() => { setDupPlans(null); setDupManual([]); setDupMsg(""); }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {dupManual.length > 0 && (
          <div style={{ color: "var(--orange)" }}>
            ⚠ {dupManual.length} duplicate cluster{dupManual.length !== 1 ? "s" : ""} need a manual canonical pick (no queue matches a flow):{" "}
            {dupManual.map(c => c.queues.map(q => q.Name).join(" / ")).join("; ")}
          </div>
        )}

        {dupMsg && <div style={{ color: "var(--text-2)" }}>{dupMsg}</div>}
      </div>

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
                <button className="btn btn-ghost"
                  style={{ fontSize: 11, padding: "1px 5px", height: 20, flexShrink: 0 }}
                  onClick={() => startReassignDelete(q)} disabled={isDeleting}
                  title="Reassign dependencies to another queue, then delete">
                  ⤳
                </button>
                <button className="btn btn-ghost btn-danger"
                  style={{ fontSize: 12, padding: "1px 5px", height: 20, flexShrink: 0 }}
                  onClick={() => deleteQueue(q)} disabled={isDeleting} title="Delete queue (fails if still referenced)">
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

      {/* Reassign-dependencies-&-delete modal */}
      {reassign && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !reassignBusy && setReassign(null)}>
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-hi)", borderRadius: "var(--radius-lg)", width: 460, maxHeight: "80vh", overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}>
              Delete <span style={{ ...MONO }}>{reassign.queue.Name}</span>
            </div>

            {reassign.deps.length > 0 ? (
              <>
                <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                  {reassign.deps.length} dependenc{reassign.deps.length !== 1 ? "ies" : "y"} reference this queue. Repoint them to:
                </div>
                <select className="input" style={{ fontSize: 12 }} value={reassignTarget}
                  onChange={e => setReassignTarget(e.target.value)}>
                  <option value="">— Choose a queue —</option>
                  {queues.filter(x => x.Id !== reassign.queue.Id).map(x => (
                    <option key={x.Id} value={x.Id}>{x.Name}</option>
                  ))}
                </select>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflow: "auto" }}>
                  {reassign.deps.map((d, i) => (
                    <div key={i} style={{ fontSize: 10, ...MONO, color: "var(--text-3)", padding: "2px 6px", background: "var(--bg-0)", borderRadius: "var(--radius)" }}>
                      {d.kind === "routing-profile" ? "▣ routing profile" : "↪ quick connect"}: <span style={{ color: "var(--text-1)" }}>{d.name}</span>
                      {d.channel ? ` (${d.channel})` : ""}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-2)" }}>{reassignMsg || "Checking dependencies…"}</div>
            )}

            {reassignMsg && reassign.deps.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--red)", ...MONO }}>{reassignMsg}</div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" disabled={reassignBusy} onClick={() => setReassign(null)}>Cancel</button>
              <button className="btn btn-danger" disabled={reassignBusy}
                onClick={confirmReassignDelete}>
                {reassignBusy ? "Working…" : reassign.deps.length > 0 ? "Repoint & delete" : "Delete"}
              </button>
            </div>
          </div>
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

  // Manual "reassign queues & delete" for a HOO.
  const [reassign, setReassign] = useState<{ hoo: HoursOfOperationSummary; queues: { queueId: string; queueName: string }[] } | null>(null);
  const [reassignTarget, setReassignTarget] = useState("");
  const [reassignBusy, setReassignBusy] = useState(false);
  const [reassignMsg, setReassignMsg] = useState("");

  const startReassignHoo = async (h: HoursOfOperationSummary) => {
    if (!h.Id) return;
    setReassign({ hoo: h, queues: [] }); setReassignTarget(""); setReassignBusy(true);
    setReassignMsg("Finding queues that use this HOO…");
    try {
      const qs = await findQueuesUsingHoo(buildConnectClient(creds), instanceId, h.Id, m => setReassignMsg(m));
      setReassign({ hoo: h, queues: qs });
      setReassignMsg(qs.length ? "" : "No queues use this HOO — safe to delete.");
    } catch (e: any) {
      setReassignMsg(e?.message ?? "Scan failed");
    } finally {
      setReassignBusy(false);
    }
  };

  const confirmReassignHoo = async () => {
    if (!reassign?.hoo.Id) return;
    const { hoo, queues } = reassign;
    if (queues.length > 0 && !reassignTarget) { setReassignMsg("Choose a HOO to repoint these queues to."); return; }
    setReassignBusy(true); setReassignMsg("");
    try {
      const r = await reassignAndDeleteHoo(buildConnectClient(creds), instanceId, hoo.Id!, queues, reassignTarget || hoo.Id!, m => setReassignMsg(m));
      if (r.errors.length) {
        setReassignMsg(`${r.errors.length} repoint(s) failed — HOO not deleted: ${r.errors.map(e => e.error).join("; ")}`);
        setReassignBusy(false);
        return;
      }
      setHoos(prev => prev.filter(x => x.Id !== hoo.Id));
      setReassign(null); setReassignTarget("");
    } catch (e: any) {
      setReassignMsg(e?.message ?? "Failed");
    } finally {
      setReassignBusy(false);
    }
  };

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
    const hid = h.Id!;
    if (hooTags[hid] !== undefined || !h.Arn) return;
    buildConnectClient(creds).send(new ListTagsForResourceCommand({ resourceArn: h.Arn }))
      .then(r => setHooTags(prev => ({ ...prev, [hid]: r.tags ?? {} })))
      .catch(() => setHooTags(prev => ({ ...prev, [hid]: {} })));
  };

  const applySourceTag = async (h: HoursOfOperationSummary) => {
    const hid = h.Id!;
    if (!h.Arn) return;
    const current = hooTags[hid] ?? {};
    if (current["source"] === "ivr-editor") return;
    setTagging(hid);
    try {
      await tagResource(buildConnectClient(creds), h.Arn, { source: "ivr-editor" });
      setHooTags(prev => ({ ...prev, [hid]: { ...current, source: "ivr-editor" } }));
    } catch (e: any) {
      setOpError(prev => ({ ...prev, [hid]: e.message }));
    } finally { setTagging(null); }
  };

  const startRename = (h: HoursOfOperationSummary) => {
    setRenameDraft(prev => ({ ...prev, [h.Id!]: h.Name ?? "" }));
    setRenaming(h.Id!);
    fetchDetail(h.Id!);
  };

  const commitRename = async (h: HoursOfOperationSummary) => {
    const hid = h.Id!;
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
      setHoos(prev => prev.map(r => r.Id === hid ? { ...r, Name: newName } : r));
      setDetail(prev => ({ ...prev, [hid]: { ...prev[hid], Name: newName } }));
      setOpError(e => { const n = { ...e }; delete n[hid]; return n; });
    } catch (e: any) { setOpError(prev => ({ ...prev, [hid]: e.message })); }
  };

  const deleteHoo = async (h: HoursOfOperationSummary) => {
    const hid = h.Id!;
    if (!window.confirm(`Delete HOO "${h.Name}"?\n\nThis will break any queues referencing it.`)) return;
    setDeleting(hid);
    try {
      await buildConnectClient(creds).send(new DeleteHoursOfOperationCommand({
        InstanceId: instanceId, HoursOfOperationId: hid,
      }));
      setHoos(prev => prev.filter(r => r.Id !== hid));
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
          const hid = h.Id ?? h.Arn ?? `hoo-${_hi}`;
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
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "1px 5px", height: 20, flexShrink: 0 }}
                  onClick={() => startReassignHoo(h)} disabled={isDeleting}
                  title="Reassign queues to another HOO, then delete">⤳</button>
                <button className="btn btn-ghost btn-danger"
                  style={{ fontSize: 12, padding: "1px 5px", height: 20, flexShrink: 0 }}
                  onClick={() => deleteHoo(h)} disabled={isDeleting} title="Delete HOO (fails if queues use it)">
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

      {/* Reassign-queues-&-delete-HOO modal */}
      {reassign && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !reassignBusy && setReassign(null)}>
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-hi)", borderRadius: "var(--radius-lg)", width: 460, maxHeight: "80vh", overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}>
              Delete HOO <span style={{ ...MONO }}>{reassign.hoo.Name}</span>
            </div>

            {reassign.queues.length > 0 ? (
              <>
                <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                  {reassign.queues.length} queue{reassign.queues.length !== 1 ? "s" : ""} use this HOO. Repoint them to:
                </div>
                <select className="input" style={{ fontSize: 12 }} value={reassignTarget}
                  onChange={e => setReassignTarget(e.target.value)}>
                  <option value="">— Choose a HOO —</option>
                  {hoos.filter(x => x.Id !== reassign.hoo.Id).map(x => (
                    <option key={x.Id} value={x.Id}>{x.Name}</option>
                  ))}
                </select>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflow: "auto" }}>
                  {reassign.queues.map(q => (
                    <div key={q.queueId} style={{ fontSize: 10, ...MONO, color: "var(--text-1)", padding: "2px 6px", background: "var(--bg-0)", borderRadius: "var(--radius)" }}>
                      {q.queueName}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-2)" }}>{reassignMsg || "Checking…"}</div>
            )}

            {reassignMsg && reassign.queues.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--red)", ...MONO }}>{reassignMsg}</div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" disabled={reassignBusy} onClick={() => setReassign(null)}>Cancel</button>
              <button className="btn btn-danger" disabled={reassignBusy} onClick={confirmReassignHoo}>
                {reassignBusy ? "Working…" : reassign.queues.length > 0 ? "Repoint & delete" : "Delete"}
              </button>
            </div>
          </div>
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
  onLoadFlow,
  hooNames,
  hooArns,
}: {
  creds: AwsCredentials;
  ddb: DdbState | null;
  onScan: () => void;
  loading: boolean;
  progressMsg: string;
  onLoadFlow?: (ir: IR, meta?: Partial<FlowMeta>) => void;
  /** id → name for the instance's HOOs, to resolve flow.hooArn to a real name. */
  hooNames?: Map<string, string>;
  /** id → arn for the instance's HOOs, to write a selected HOO. */
  hooArns?: Map<string, string>;
}) {
  const [filter, setFilter] = useState("");
  const [loadingFlow, setLoadingFlow] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string>("");
  const [deletingFlow, setDeletingFlow] = useState<string | null>(null);
  const [pruningFlow, setPruningFlow] = useState<string | null>(null);

  const handlePruneSteps = async (flow: DdbFlow) => {
    setPruningFlow(flow.targetFlowId);
    setLoadErr("");
    try {
      const { ir } = await loadFlowFromDdb(creds, flow.targetFlowId);
      const dead = unreachableStepIds(ir.nodes, ir.start_step ?? flow.startStep);
      if (dead.length === 0) { window.alert("No unreachable steps in this flow."); return; }
      if (!window.confirm(
        `Delete ${dead.length} unreachable step${dead.length !== 1 ? "s" : ""} from "${flow.targetFlowId}"?\n\n${dead.slice(0, 12).join(", ")}${dead.length > 12 ? "…" : ""}\n\nThis cannot be undone.`,
      )) return;
      await deleteSteps(creds, flow.targetFlowId, dead);
      onScan();
    } catch (e: any) {
      setLoadErr(e?.message ?? "Prune failed");
    } finally {
      setPruningFlow(null);
    }
  };

  const handleDeleteFlow = async (flow: DdbFlow) => {
    const phones = flow.metas.map(m => m.dialedNumber).filter(Boolean);
    if (!window.confirm(
      `Delete flow "${flow.targetFlowId}" (${flow.stepCount} steps${phones.length ? ` + ${phones.length} phone META row(s)` : ""}) from DynamoDB?\n\nThis cannot be undone.`,
    )) return;
    setDeletingFlow(flow.targetFlowId);
    try {
      await deleteFlowFromDdb(creds, flow);
      onScan(); // re-scan so the list reflects the deletion
    } catch (e: any) {
      setLoadErr(e?.message ?? "Delete failed");
    } finally {
      setDeletingFlow(null);
    }
  };

  // Inline META editing (per phone row).
  const [editMeta, setEditMeta] = useState<{ original: DdbFlowMeta; draft: DdbFlowMeta } | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);
  const saveMeta = async () => {
    if (!editMeta) return;
    if (!editMeta.draft.dialedNumber.trim()) { setLoadErr("Dialed number is required."); return; }
    setSavingMeta(true);
    try {
      await editFlowMeta(creds, editMeta.original, editMeta.draft);
      setEditMeta(null);
      onScan();
    } catch (e: any) {
      setLoadErr(e?.message ?? "Save failed");
    } finally {
      setSavingMeta(false);
    }
  };

  const [annotations, setAnnotations] = useState<Map<string, FlowAnnotation>>(() => annotationsToMap());
  const refreshAnnotations = () => setAnnotations(annotationsToMap());

  const registry: FlowRegistry | null = useMemo(
    () => (ddb ? buildFlowRegistry([{ label: "sandbox", ddb, hooNames: hooNames ?? new Map(), annotations }]) : null),
    [ddb, hooNames, annotations],
  );

  // Inline plan-name + HOO editing (DDB for numbered flows, local for not-yet-live).
  const [editingPlanFor, setEditingPlanFor] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const [savingField, setSavingField] = useState<string | null>(null);
  const planCommitRef = useRef(true); // false = the pending blur should cancel, not save

  const savePlan = async (def: DdbFlow) => {
    const value = planDraft.trim();
    setEditingPlanFor(null);
    setSavingField(def.targetFlowId);
    setLoadErr("");
    try {
      if (def.metas.length > 0) {
        await setFlowMetaFields(creds, def, { description: value });
        onScan();
      } else {
        setAnnotation(def.targetFlowId, { healthPlan: value });
        refreshAnnotations();
      }
    } catch (e: any) {
      setLoadErr(e?.message ?? "Save failed");
    } finally {
      setSavingField(null);
    }
  };

  const changeHoo = async (def: DdbFlow, hooId: string) => {
    setSavingField(def.targetFlowId);
    setLoadErr("");
    try {
      if (def.metas.length > 0) {
        await setFlowMetaFields(creds, def, { hooArn: hooId ? (hooArns?.get(hooId) ?? "") : "" });
        onScan();
      } else {
        setAnnotation(def.targetFlowId, { hooId });
        refreshAnnotations();
      }
    } catch (e: any) {
      setLoadErr(e?.message ?? "HOO update failed");
    } finally {
      setSavingField(null);
    }
  };

  // Inline flow rename (sandbox only).
  const [renameTarget, setRenameTarget] = useState<DdbFlow | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);

  const startRename = (flow: DdbFlow) => {
    setRenameTarget(flow);
    setRenameDraft(flow.targetFlowId);
    setLoadErr("");
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    const next = renameDraft.trim();
    if (!next || next === renameTarget.targetFlowId) { setRenameTarget(null); return; }
    if (!window.confirm(
      `Rename flow "${renameTarget.targetFlowId}" → "${next}"?\n\n` +
      `This re-keys ${renameTarget.stepCount} step row(s) and repoints ` +
      `${renameTarget.metas.length} phone META row(s). This cannot be undone.`,
    )) return;
    setRenaming(true);
    try {
      await renameFlow(creds, renameTarget.targetFlowId, next, renameTarget.metas);
      setRenameTarget(null);
      onScan();
    } catch (e: any) {
      setLoadErr(e?.message ?? "Rename failed");
    } finally {
      setRenaming(false);
    }
  };

  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportMd = () => { if (registry) downloadText(`flows-registry-${stamp()}.md`, toMarkdown(registry), "text/markdown"); };
  const exportCsvFile = () => { if (registry) downloadText(`flows-registry-${stamp()}.csv`, toCsv(registry), "text/csv"); };
  const exportJsonFile = () => { if (registry) downloadText(`flows-registry-${stamp()}.json`, toJson(registry), "application/json"); };

  const handleLoadFlow = async (flow: DdbFlow) => {
    if (!onLoadFlow) return;
    setLoadingFlow(flow.targetFlowId);
    setLoadErr("");
    try {
      const { ir } = await loadFlowFromDdb(creds, flow.targetFlowId);
      const m0 = flow.metas[0];
      // META often lives only under the dialed number, so enrich from the scan.
      const meta: Partial<FlowMeta> = {
        dialed_number: m0?.dialedNumber ?? "",
        target_flow_id: flow.targetFlowId,
        start_step: ir.start_step ?? flow.startStep ?? "",
        hoo_arn: ir.hoo_arn ?? flow.hooArn,
        instance_id: flow.instanceId,
        description: m0?.description,
      };
      onLoadFlow(
        { ...ir, start_step: ir.start_step ?? flow.startStep, hoo_arn: ir.hoo_arn ?? flow.hooArn, meta },
        meta,
      );
    } catch (e: any) {
      setLoadErr(e?.message ?? "Load failed");
    } finally {
      setLoadingFlow(null);
    }
  };

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
            ["Flows", ddb?.flowDefs.length ?? 0, "var(--text-1)"],
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

      {/* Export bar */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, marginBottom: 6 }}>
        <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={!registry} onClick={exportMd}>⬇ MD</button>
        <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={!registry} onClick={exportCsvFile}>⬇ CSV</button>
        <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={!registry} onClick={exportJsonFile}>⬇ JSON</button>
        {loadErr && (
          <span style={{ fontSize: 9, ...MONO, color: "var(--red)", marginLeft: 8 }}>{loadErr}</span>
        )}
      </div>

      {renameTarget && (
        <div style={{
          display: "flex", gap: 6, alignItems: "center", flexShrink: 0,
          padding: "6px 8px", marginBottom: 6, background: "var(--bg-2)",
          border: "1px solid var(--border)", borderRadius: "var(--radius)",
        }}>
          <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>Rename:</span>
          <input
            autoFocus
            value={renameDraft}
            onChange={(ev) => setRenameDraft(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Enter") confirmRename(); if (ev.key === "Escape") setRenameTarget(null); }}
            style={{ flex: 1, fontSize: 11, padding: "3px 8px", ...MONO }}
          />
          <button className="btn btn-primary" style={{ fontSize: 10 }} disabled={renaming} onClick={confirmRename}>Save</button>
          <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={renaming} onClick={() => setRenameTarget(null)}>Cancel</button>
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-3)", ...MONO }}>
              <th style={{ padding: "4px 6px" }}>Health Plan</th>
              <th style={{ padding: "4px 6px" }}>Flow</th>
              <th style={{ padding: "4px 6px" }}>Number(s)</th>
              <th style={{ padding: "4px 6px" }}>HOO</th>
              <th style={{ padding: "4px 6px" }}>Queues</th>
              <th style={{ padding: "4px 6px" }}>Status</th>
              <th style={{ padding: "4px 6px" }} />
            </tr>
          </thead>
          <tbody>
            {(registry?.rows ?? [])
              .filter((r) => {
                const f = filter.trim().toLowerCase();
                if (!f) return true;
                const e = r.envs.sandbox;
                const def = ddb!.flowDefs.find((d) => d.targetFlowId === e?.rawFlowId);
                return (
                  (r.healthPlan ?? "").toLowerCase().includes(f) ||
                  (e?.rawFlowId ?? "").toLowerCase().includes(f) ||
                  (e?.dialedNumbers ?? []).some((n) => n.includes(f)) ||
                  (def?.queues ?? []).some((qu) => qu.skillWhisper.toLowerCase().includes(f))
                );
              })
              .map((row: FlowRow) => {
                const e = row.envs.sandbox;
                const def = ddb!.flowDefs.find((d) => d.targetFlowId === e?.rawFlowId);
                const busy = loadingFlow === e?.rawFlowId || deletingFlow === e?.rawFlowId
                  || pruningFlow === e?.rawFlowId || renaming || savingField === e?.rawFlowId;
                return (
                  <tr key={row.flowKey} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 6px" }}>
                      {def && editingPlanFor === e?.rawFlowId ? (
                        <input
                          autoFocus
                          value={planDraft}
                          onChange={(ev) => setPlanDraft(ev.target.value)}
                          onBlur={() => {
                            if (planCommitRef.current) {
                              savePlan(def);
                            } else {
                              planCommitRef.current = true;
                              setEditingPlanFor(null);
                            }
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") { ev.currentTarget.blur(); }
                            if (ev.key === "Escape") { planCommitRef.current = false; ev.currentTarget.blur(); }
                          }}
                          style={{ fontSize: 11, padding: "2px 6px", width: "100%", boxSizing: "border-box" }}
                        />
                      ) : (
                        <span
                          style={{ cursor: def ? "text" : "default" }}
                          title={def ? "Click to edit plan name" : undefined}
                          onClick={() => { if (def && e) { setEditingPlanFor(e.rawFlowId); setPlanDraft(row.healthPlan ?? ""); } }}
                        >
                          {row.healthPlan ?? <span style={{ color: "var(--text-3)" }}>＋ name</span>}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "4px 6px", ...MONO }}>{e?.rawFlowId}</td>
                    <td style={{ padding: "4px 6px", ...MONO }}>
                      {def && def.metas.length > 0 ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          {def.metas.map((m, i) => (
                            <span key={m.dialedNumber || i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {m.dialedNumber || <span style={{ color: "var(--text-3)" }}>(no number)</span>}
                              <button className="btn btn-ghost" style={{ fontSize: 9, padding: "0 5px", height: 18 }}
                                disabled={busy} title="Edit META"
                                onClick={() => setEditMeta({ original: m, draft: { ...m } })}>✎</button>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={{ color: "var(--text-3)" }}>—</span>
                          {def && (
                            <button className="btn btn-ghost" style={{ fontSize: 9, padding: "0 6px", height: 18 }}
                              disabled={busy} title="Add phone / META"
                              onClick={() => setEditMeta({
                                original: { dialedNumber: "", targetFlowId: def.targetFlowId },
                                draft: { dialedNumber: "", targetFlowId: def.targetFlowId, hooArn: def.hooArn, startStep: def.startStep },
                              })}>＋ add</button>
                          )}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      {def ? (
                        <select
                          value={e?.hooId ?? ""}
                          disabled={busy}
                          onChange={(ev) => changeHoo(def, ev.target.value)}
                          style={{ fontSize: 10, padding: "1px 4px", maxWidth: 160 }}
                        >
                          <option value="">— none —</option>
                          {[...(hooNames ?? new Map()).entries()].map(([id, name]) => (
                            <option key={id} value={id}>{name}</option>
                          ))}
                        </select>
                      ) : (e?.hooName ?? "—")}
                    </td>
                    <td style={{ padding: "4px 6px", ...MONO, fontSize: 10 }}>
                      {def && def.queues.length
                        ? def.queues.map((q) => q.skillWhisper).join(", ")
                        : <span style={{ color: "var(--text-3)" }}>—</span>}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <span style={{
                        fontSize: 9, ...MONO,
                        color: e?.liveStatus === "live" ? "var(--green, #4caf50)" : "var(--text-3)",
                      }}>
                        {e?.liveStatus === "live" ? "● live" : "○ not yet"}
                      </span>
                    </td>
                    <td style={{ padding: "4px 6px", whiteSpace: "nowrap", textAlign: "right" }}>
                      {def && (
                        <>
                          <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 6px", height: 20 }}
                            disabled={busy} onClick={() => startRename(def)}>rename</button>
                          {onLoadFlow && (
                            <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 6px", height: 20 }}
                              disabled={busy} onClick={() => handleLoadFlow(def)}>load</button>
                          )}
                          <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 6px", height: 20 }}
                            disabled={busy} onClick={() => handlePruneSteps(def)}>prune</button>
                          <button className="btn btn-ghost btn-danger" style={{ fontSize: 9, padding: "1px 6px", height: 20 }}
                            disabled={busy} onClick={() => handleDeleteFlow(def)}>delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* META edit modal */}
      {editMeta && (() => {
        const d = editMeta.draft;
        const set = (patch: Partial<DdbFlowMeta>) => setEditMeta(em => em ? { ...em, draft: { ...em.draft, ...patch } } : em);
        const field = (label: string, value: string, onChange: (v: string) => void, ph?: string) => (
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>{label}</span>
            <input className="input" style={{ fontSize: 12 }} value={value} placeholder={ph}
              onChange={e => onChange(e.target.value)} spellCheck={false} />
          </label>
        );
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => !savingMeta && setEditMeta(null)}>
            <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-hi)", borderRadius: "var(--radius-lg)", width: 460, maxHeight: "85vh", overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}>
                {editMeta.original.dialedNumber ? "Edit META" : "Add META"}
              </div>
              {field("Dialed number (phone) — partition key", d.dialedNumber, v => set({ dialedNumber: v }), "+18005551234")}
              {field("Target flow id", d.targetFlowId, v => set({ targetFlowId: v }))}
              {field("Start step", d.startStep ?? "", v => set({ startStep: v }), "start")}
              {field("HOO ARN / id", d.hooArn ?? "", v => set({ hooArn: v }))}
              {field("Instance id", d.instanceId ?? "", v => set({ instanceId: v }))}
              {field("Description", d.description ?? "", v => set({ description: v }))}
              {editMeta.original.dialedNumber && editMeta.original.dialedNumber !== d.dialedNumber && (
                <div style={{ fontSize: 9, color: "var(--orange)", ...MONO }}>
                  ⚠ Changing the phone number rewrites the key (delete old + write new).
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" disabled={savingMeta} onClick={() => setEditMeta(null)}>Cancel</button>
                <button className="btn btn-primary" disabled={savingMeta} onClick={saveMeta}>
                  {savingMeta ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Main AccountPanel ─────────────────────────────────────────────────────────

interface Props {
  auth: UseAwsCredentialsReturn;
  onLoadFlow?: (ir: IR, meta?: Partial<FlowMeta>) => void;
}

type PanelTab = "queues" | "hoo" | "ddb";

export default function AccountPanel({ auth, onLoadFlow }: Props) {
  const { credentials, instances, instancesLoading, fetchInstances } = auth;
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>(
    () => credentials?.instance_id ?? ""
  );
  const [activePanel, setActivePanel] = useState<PanelTab>("queues");

  // DDB scan is cached app-wide (scanned once per login) — read from the store.
  const ddb = useDdbStore(s => s.ddb);
  const ddbLoading = useDdbStore(s => s.status === "scanning");
  const ddbError = useDdbStore(s => s.error);
  const ddbProgress = useDdbStore(s => s.progress);
  const ddbScan = useDdbStore(s => s.scan);
  const ddbPatch = useDdbStore(s => s.patch);

  const handleMissingQueues = useCallback((missing: string[]) => {
    ddbPatch(prev => prev ? { ...prev, missingInConnect: missing } : prev);
  }, [ddbPatch]);

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

  // HOO id → name (and id → arn) so the Flows panel can resolve + change HOOs.
  const [hooNames, setHooNames] = useState<Map<string, string>>(new Map());
  const [hooArns, setHooArns] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!credentials || !selectedInstanceId) { setHooNames(new Map()); setHooArns(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const client = buildConnectClient(credentials);
        const m = new Map<string, string>();
        const arns = new Map<string, string>();
        let next: string | undefined;
        do {
          const resp = await client.send(new ListHoursOfOperationsCommand({
            InstanceId: selectedInstanceId, ...(next ? { NextToken: next } : {}),
          }));
          for (const h of resp.HoursOfOperationSummaryList ?? []) {
            if (h.Id) { m.set(h.Id, h.Name ?? h.Id); if (h.Arn) arns.set(h.Id, h.Arn); }
          }
          next = resp.NextToken;
        } while (next);
        if (!cancelled) { setHooNames(m); setHooArns(arns); }
      } catch { /* non-fatal — flow panel falls back to the raw id */ }
    })();
    return () => { cancelled = true; };
  }, [credentials, selectedInstanceId]);

  const handleDdbScan = useCallback(async () => {
    if (!credentials) return;
    await ddbScan(credentials, true); // manual refresh → force re-scan
  }, [credentials, ddbScan]);

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
            ⬡ {ddb.flowDefs.length} DDB flows · {ddb.queueUsage.size} queue refs
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
              ["ddb", "Flows Registry"],
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
                    {ddb.flowDefs.length}
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
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)", margin: 0 }}>Flows Registry</h2>
                  <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    {FLOW_TABLE} · consolidated flow table · export MD/CSV/JSON
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
                  onLoadFlow={onLoadFlow}
                  hooNames={hooNames}
                  hooArns={hooArns}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
