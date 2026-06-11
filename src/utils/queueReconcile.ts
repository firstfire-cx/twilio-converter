// src/utils/queueReconcile.ts
//
// Pure reconciliation between Connect queues and the DDB flow scan.
// Queue sync is one-directional by nature: DynamoDB flows are the source of
// truth for which queues should exist (via SkillWhisper / QueueSkill), and we
// reconcile Connect to match (create / rename / tag) or flag orphans. We never
// rewrite flow references from a Connect queue name — SkillWhisper is the PolyAI
// routing contract, not a display string.

import type { DdbState, DdbQueueUsage } from "./ddbScan";
import type { QueueDependency } from "./connectDeps";

// ── Fuzzy name matching (lang-aware scoring) ─────────────────────────────────

/** Normalize a queue name: lowercase, separators → single space. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, " ")
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

/** Strip trailing language token from a normalized name. */
function stripLang(normalized: string): string {
  return normalized
    .replace(/ (en|eng|english|sp|spa|spanish|español)$/, "")
    .trim();
}

/**
 * Fuzzy score between a Connect queue name and a DDB skillWhisper: 0 (no match)
 * to 3 (exact). 2 = same base + compatible language; 1 = partial/token overlap.
 */
export function fuzzyScore(connectName: string, skillWhisper: string): number {
  const cn = normalizeName(connectName);
  const sw = normalizeName(skillWhisper);
  if (cn === sw) return 3;

  const cnLang = langToken(connectName);
  const swLang = langToken(skillWhisper);
  const cnBase = stripLang(cn);
  const swBase = stripLang(sw);

  if (cnBase === swBase) {
    return cnLang === swLang || !cnLang || !swLang ? 2 : 1;
  }

  const langsCompatible = !cnLang || !swLang || cnLang === swLang;
  if (!langsCompatible) return 0;

  if (cnBase.startsWith(swBase) || swBase.startsWith(cnBase)) return 2;

  const cnTokens = new Set(cnBase.split(" ").filter(Boolean));
  const swTokens = new Set(swBase.split(" ").filter(Boolean));
  const smaller = cnTokens.size <= swTokens.size ? cnTokens : swTokens;
  const larger = cnTokens.size <= swTokens.size ? swTokens : cnTokens;
  let overlap = 0;
  for (const t of smaller) {
    if (larger.has(t) || [...larger].some(lt => lt.startsWith(t) || t.startsWith(lt))) overlap++;
  }
  const ratio = smaller.size > 0 ? overlap / smaller.size : 0;
  if (ratio >= 0.6) return 1;

  return 0;
}

// ── Classification ───────────────────────────────────────────────────────────

export type QueueSyncStatus = "matched" | "orphan" | "duplicate" | "unknown";

export interface QueueClassification {
  status: QueueSyncStatus;
  ddbUsage?: DdbQueueUsage;
  /** set when matched via fuzzy (not exact) — the DDB name it matched. */
  fuzzyMatchedAs?: string;
}

/**
 * Classify one Connect queue against the DDB scan. `isDuplicate` (computed by
 * the caller, which sees the whole list) short-circuits to "duplicate".
 * Match order: exact name / cxone_skill_id tag → best fuzzy (score ≥ 1) → orphan.
 */
export function classifyQueue(
  queue: { Name?: string; tags?: Record<string, string> },
  ddb: DdbState,
  isDuplicate: boolean,
): QueueClassification {
  if (isDuplicate) return { status: "duplicate" };

  const nameLower = (queue.Name ?? "").toLowerCase();

  const exactUsage =
    ddb.queueUsage.get(queue.Name ?? "") ??
    [...ddb.queueUsage.values()].find(
      (u) =>
        u.skillWhisper.toLowerCase() === nameLower ||
        (u.queueSkill && queue.tags?.["cxone_skill_id"] === u.queueSkill),
    );
  if (exactUsage) return { status: "matched", ddbUsage: exactUsage };

  let bestScore = 0;
  let bestUsage: DdbQueueUsage | undefined;
  for (const usage of ddb.queueUsage.values()) {
    const score = fuzzyScore(queue.Name ?? "", usage.skillWhisper);
    if (score > bestScore) {
      bestScore = score;
      bestUsage = usage;
    }
  }
  if (bestScore >= 1 && bestUsage) {
    return { status: "matched", ddbUsage: bestUsage, fuzzyMatchedAs: bestUsage.skillWhisper };
  }

  return { status: "orphan" };
}

/**
 * DDB skillWhispers that have no matching Connect queue ("missing in Connect").
 * The inverse of orphan detection — these are the queues a sync would create.
 */
export function findMissingInConnect(
  connectNames: string[],
  ddb: DdbState,
): DdbQueueUsage[] {
  return [...ddb.queueUsage.values()].filter((usage) => {
    return !connectNames.some(
      (name) =>
        name.toLowerCase() === usage.skillWhisper.toLowerCase() ||
        fuzzyScore(name, usage.skillWhisper) >= 1,
    );
  });
}

// ── Duplicate-queue clustering (for dependency-aware cleanup) ────────────────

export interface QueueLike {
  Id?: string;
  Arn?: string;
  Name?: string;
  tags?: Record<string, string>;
}

export interface DuplicateCluster {
  /** the shared normalized name (lowercase, separators stripped). */
  normalized: string;
  /** every queue in the cluster (canonical + duplicates). */
  queues: QueueLike[];
  /** the queue the flows route to — repoint dependents here. */
  canonical?: QueueLike;
  /** the non-canonical queues to repoint away from, then delete. */
  duplicates: QueueLike[];
  /** true when no queue clearly matches a flow — user must pick the canonical. */
  needsManualPick: boolean;
}

/** Does this queue match a DDB flow reference (exact name or cxone_skill_id tag)? */
function matchesFlow(q: QueueLike, ddb: DdbState): boolean {
  const nameLower = (q.Name ?? "").toLowerCase();
  return [...ddb.queueUsage.values()].some(
    (u) =>
      u.skillWhisper.toLowerCase() === nameLower ||
      (!!u.queueSkill && q.tags?.["cxone_skill_id"] === u.queueSkill),
  );
}

/**
 * Group queues whose names are the same once separators/case are stripped
 * ("Care-First" / "Care_First" / "Care First"). Clusters with >1 queue are
 * duplicates. The canonical is the one a DDB flow routes to; if none matches,
 * `needsManualPick` is set so the caller asks the user.
 */
export function clusterDuplicateQueues(
  queues: QueueLike[],
  ddb: DdbState,
): DuplicateCluster[] {
  const byNorm = new Map<string, QueueLike[]>();
  for (const q of queues) {
    const n = normalizeName(q.Name ?? "");
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n)!.push(q);
  }

  const clusters: DuplicateCluster[] = [];
  for (const [normalized, group] of byNorm) {
    if (group.length < 2) continue; // not a duplicate set
    const canonical = group.find((q) => matchesFlow(q, ddb));
    clusters.push({
      normalized,
      queues: group,
      canonical,
      duplicates: canonical ? group.filter((q) => q !== canonical) : [],
      needsManualPick: !canonical,
    });
  }
  return clusters;
}

/** A repoint of one dependency from a duplicate queue to the canonical. */
export interface RepointAction {
  duplicate: QueueLike;
  dependency: QueueDependency;
}

export interface ClusterCleanup {
  normalized: string;
  canonical: QueueLike;
  /** non-canonical queues to repoint away from, then delete. */
  duplicates: QueueLike[];
  /** every dependency that must be repointed before the duplicates can go. */
  repoints: RepointAction[];
}

/**
 * Build the cleanup plan from duplicate clusters + the dependency index: for
 * each cluster with a known canonical, list the dependencies on its duplicates
 * (to repoint to the canonical) and the duplicates to delete afterwards.
 * Clusters that need a manual canonical pick are skipped (the UI handles those).
 */
export function planDuplicateCleanup(
  clusters: DuplicateCluster[],
  depIndex: Map<string, QueueDependency[]>,
): ClusterCleanup[] {
  const out: ClusterCleanup[] = [];
  for (const c of clusters) {
    if (!c.canonical) continue;
    const repoints: RepointAction[] = [];
    for (const dup of c.duplicates) {
      const deps = (dup.Id && depIndex.get(dup.Id)) || [];
      for (const dependency of deps) repoints.push({ duplicate: dup, dependency });
    }
    out.push({
      normalized: c.normalized,
      canonical: c.canonical,
      duplicates: c.duplicates,
      repoints,
    });
  }
  return out;
}

// ── Create-missing planning (DDB → Connect) ──────────────────────────────────

/** Extract the bare HOO id from a Connect HOO ARN, or return as-is if it's
 *  already an id (no path separators). */
export function hooIdFromArn(arnOrId: string): string {
  const idx = arnOrId.lastIndexOf("/");
  return idx >= 0 ? arnOrId.slice(idx + 1) : arnOrId;
}

/** Connect tag values reject bare '+' and some specials; strip and cap at 256. */
function sanitizeTagValue(v: string): string {
  return v.replace(/\+/g, "").replace(/[^\w\s_.:/=\-@,]/g, "_").slice(0, 256);
}

export interface MissingQueuePlan {
  skillWhisper: string;
  queueSkill?: string;
  /** null = the referencing flow(s) had no resolvable HOO → cannot create. */
  hooId: string | null;
  tags: Record<string, string>;
  dialedNumbers: string[];
}

/**
 * Build create-plans for "missing in Connect" queues. Each queue's HOO is taken
 * from its first referencing flow that has one (hooId=null means none → caller
 * surfaces "can't create" and skips it). Tags mirror expectedTags.
 */
export function planMissingQueueCreates(
  missing: DdbQueueUsage[],
): MissingQueuePlan[] {
  return missing.map((u) => {
    const flowWithHoo = u.flows.find((f) => f.hooArn);
    const hooId = flowWithHoo?.hooArn ? hooIdFromArn(flowWithHoo.hooArn) : null;
    const dialedNumbers = u.flows.map((f) => f.dialedNumber).filter(Boolean);

    const tags: Record<string, string> = {
      source: "ivr-editor",
      skill_whisper: sanitizeTagValue(u.skillWhisper),
    };
    if (u.queueSkill) tags["cxone_skill_id"] = sanitizeTagValue(u.queueSkill);
    if (dialedNumbers.length) {
      tags["ivr_flows"] = sanitizeTagValue(
        dialedNumbers.map((d) => d.replace(/^\+/, "")).join(","),
      );
    }

    return { skillWhisper: u.skillWhisper, queueSkill: u.queueSkill, hooId, tags, dialedNumbers };
  });
}
