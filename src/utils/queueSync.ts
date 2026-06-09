// src/utils/queueSync.ts
//
// Queue and HOO synchronization utilities
// - Fetch queues/HOOs with tags from AWS Connect
// - Compare against CSV mapping (skill_id → queue_name)
// - Tag queues with correct skill IDs
// - Rename/recreate queues with wrong names
// - Sync queues with loaded flows

import {
  ConnectClient,
  ListQueuesCommand,
  DescribeQueueCommand,
  UpdateQueueNameCommand,
  DeleteQueueCommand,
  CreateQueueCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListHoursOfOperationsCommand,
  DescribeHoursOfOperationCommand,
  type ConnectClientConfig,
  type QueueSummary,
  type HoursOfOperationSummary,
} from "@aws-sdk/client-connect";
import type { AwsCredentials } from "../hooks/useAwsCredentials";
import type { QueueRecord } from "../project";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillMappingRow {
  skill_id: string;
  queue_name: string;
  description?: string;
}

export interface QueuedWithTags extends QueueSummary {
  tags?: Record<string, string>;
}

export interface HooWithTags extends HoursOfOperationSummary {
  tags?: Record<string, string>;
}

export interface SyncAction {
  type: "create" | "rename" | "recreate" | "tag" | "untag" | "delete" | "skip";
  resourceType: "queue" | "hoo";
  currentName?: string;
  targetName?: string;
  skillId?: string;
  reason: string;
}

export interface SyncResult {
  actions: SyncAction[];
  created: number;
  renamed: number;
  retagged: number;
  deleted: number;
  skipped: number;
  errors: Array<{ resource: string; error: string }>;
}

// ─── Name normalization ──────────────────────────────────────────────────────

/**
 * Normalize a queue/HOO name for fuzzy comparison:
 * - lowercase
 * - remove all common separators (hyphens, underscores, spaces, dots)
 *
 * This handles cases like:
 *   "K-P-M-A" → "kpma"
 *   "K_P_M_A" → "kpma"
 *   "K P M A" → "kpma"
 *   "KPMA"    → "kpma"
 *   "Support-English" → "supportenglish"
 *   "Support English" → "supportenglish"
 */
export function normalizeQueueName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_.\s]+/g, "");  // strip separators
}

/**
 * Normalize a HOO name — same logic as queue normalization.
 * Aliased for semantic clarity when used with HOO resources.
 */
export function normalizeHooName(name: string): string {
  return normalizeQueueName(name);
}

/**
 * Try to match a target name against a list of live queue names using
 * progressively more relaxed strategies:
 *   1. Exact case-insensitive match
 *   2. Normalized match (separators stripped)
 *   3. Partial/substring match (one contains the other)
 *
 * Returns the matched queue or undefined.
 */
export function findQueueByName(
  targetName: string,
  liveQueues: QueuedWithTags[],
): QueuedWithTags | undefined {
  const targetLower = targetName.toLowerCase();
  const targetNorm = normalizeQueueName(targetName);

  // Strategy 1: exact case-insensitive
  let match = liveQueues.find((q) => q.Name?.toLowerCase() === targetLower);
  if (match) return match;

  // Strategy 2: normalized (separators stripped)
  match = liveQueues.find((q) => normalizeQueueName(q.Name ?? "") === targetNorm);
  if (match) return match;

  // Strategy 3: one normalized name contains the other (e.g., "KPMA" inside "KPMA-Support")
  if (targetNorm.length >= 3) {
    match = liveQueues.find((q) => {
      const qNorm = normalizeQueueName(q.Name ?? "");
      return qNorm.includes(targetNorm) || targetNorm.includes(qNorm);
    });
    if (match) return match;
  }

  return undefined;
}

/**
 * Try to match a target HOO name against a list of live HOOs using
 * progressively more relaxed strategies:
 *   1. Exact case-insensitive match
 *   2. Normalized match (separators stripped)
 *   3. Partial/substring match (one contains the other)
 *
 * Returns the matched HOO or undefined.
 */
export function findHooByName(
  targetName: string,
  liveHoos: HooWithTags[],
): HooWithTags | undefined {
  const targetLower = targetName.toLowerCase();
  const targetNorm = normalizeHooName(targetName);

  // Strategy 1: exact case-insensitive
  let match = liveHoos.find((h) => h.Name?.toLowerCase() === targetLower);
  if (match) return match;

  // Strategy 2: normalized (separators stripped)
  match = liveHoos.find((h) => normalizeHooName(h.Name ?? "") === targetNorm);
  if (match) return match;

  // Strategy 3: one normalized name contains the other
  if (targetNorm.length >= 3) {
    match = liveHoos.find((h) => {
      const hNorm = normalizeHooName(h.Name ?? "");
      return hNorm.includes(targetNorm) || targetNorm.includes(hNorm);
    });
    if (match) return match;
  }

  return undefined;
}

// ─── Client builder ──────────────────────────────────────────────────────────

export function buildConnectClient(creds: AwsCredentials): ConnectClient {
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

// ─── CSV parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a CSV with columns: skill_id, queue_name, [description]
 * Returns a map of skill_id → mapping row
 */
export function parseSkillMappingCSV(
  csvText: string,
): Map<string, SkillMappingRow> {
  const map = new Map<string, SkillMappingRow>();
  const clean = csvText
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim();
  const lines = clean.split("\n");
  if (lines.length < 2) return map;

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const iSkillId = idx("skill_id") ?? idx("skill_no") ?? idx("skillid");
  const iQueueName = idx("queue_name") ?? idx("queue_name") ?? idx("name");
  const iDescription = idx("description") ?? idx("desc");

  if (iSkillId === -1 || iQueueName === -1) {
    console.warn(
      "[parseSkillMappingCSV] Missing required columns: skill_id, queue_name",
    );
    return map;
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const skillId = cols[iSkillId];
    const queueName = cols[iQueueName];
    if (!skillId || !queueName) continue;
    map.set(skillId, {
      skill_id: skillId,
      queue_name: queueName,
      description: iDescription >= 0 ? cols[iDescription] : undefined,
    });
  }
  return map;
}

// ─── Fetch queues and HOOs with tags ─────────────────────────────────────────

/**
 * Fetch all queues for an instance along with their tags
 */
export async function fetchQueuesWithTags(
  client: ConnectClient,
  instanceId: string,
): Promise<QueuedWithTags[]> {
  const queues: QueuedWithTags[] = [];
  let nextToken: string | undefined;

  // Fetch all queues
  do {
    const resp = await client.send(
      new ListQueuesCommand({
        InstanceId: instanceId,
        QueueTypes: ["STANDARD"],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    queues.push(...(resp.QueueSummaryList ?? []));
    nextToken = resp.NextToken;
  } while (nextToken);

  // Fetch tags for each queue (parallel)
  const queueArns = queues.map((q) => q.QueueArn).filter(Boolean) as string[];
  const tagPromises = queueArns.map(async (arn) => {
    try {
      const resp = await client.send(
        new ListTagsForResourceCommand({ ResourceArn: arn }),
      );
      return { arn, tags: resp.Tags ?? {} };
    } catch {
      return { arn, tags: {} };
    }
  });

  const tagResults = await Promise.all(tagPromises);
  const tagsByArn = new Map(tagResults.map((r) => [r.arn, r.tags]));

  return queues.map((q) => ({
    ...q,
    tags: tagsByArn.get(q.QueueArn ?? "") ?? {},
  }));
}

/**
 * Fetch all HOOs for an instance along with their tags
 */
export async function fetchHoosWithTags(
  client: ConnectClient,
  instanceId: string,
): Promise<HooWithTags[]> {
  const hoos: HooWithTags[] = [];
  let nextToken: string | undefined;

  // Fetch all HOOs
  do {
    const resp = await client.send(
      new ListHoursOfOperationsCommand({
        InstanceId: instanceId,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    hoos.push(...(resp.HoursOfOperationSummaryList ?? []));
    nextToken = resp.NextToken;
  } while (nextToken);

  // Fetch tags for each HOO (parallel)
  const hooArns = hoos.map((h) => h.Arn).filter(Boolean) as string[];
  const tagPromises = hooArns.map(async (arn) => {
    try {
      const resp = await client.send(
        new ListTagsForResourceCommand({ ResourceArn: arn }),
      );
      return { arn, tags: resp.Tags ?? {} };
    } catch {
      return { arn, tags: {} };
    }
  });

  const tagResults = await Promise.all(tagPromises);
  const tagsByArn = new Map(tagResults.map((r) => [r.arn, r.tags]));

  return hoos.map((h) => ({
    ...h,
    tags: tagsByArn.get(h.Arn ?? "") ?? {},
  }));
}

// ─── Sync planning ───────────────────────────────────────────────────────────

/**
 * Compare live queues against CSV mapping and plan sync actions
 */
export function planQueueSync(
  liveQueues: QueuedWithTags[],
  skillMapping: Map<string, SkillMappingRow>,
): SyncAction[] {
  const actions: SyncAction[] = [];
  const liveByName = new Map(liveQueues.map((q) => [q.Name?.toLowerCase(), q]));
  const liveBySkillTag = new Map(
    liveQueues
      .filter((q) => q.tags?.cxone_skill_id)
      .map((q) => [q.tags!.cxone_skill_id!, q]),
  );

  // Check each mapping row
  for (const [skillId, mapping] of skillMapping) {
    const targetName = mapping.queue_name.toLowerCase();
    const existingByName = liveByName.get(targetName);
    const existingByTag = liveBySkillTag.get(skillId);

    // Case 1: Queue exists with correct name and correct tag
    if (existingByName && existingByName.tags?.cxone_skill_id === skillId) {
      actions.push({
        type: "skip",
        resourceType: "queue",
        currentName: existingByName.Name,
        skillId,
        reason: "Already correct",
      });
      continue;
    }

    // Case 2: Queue exists with correct name but wrong/missing tag
    if (existingByName && !existingByName.tags?.cxone_skill_id) {
      actions.push({
        type: "tag",
        resourceType: "queue",
        currentName: existingByName.Name,
        targetName: mapping.queue_name,
        skillId,
        reason: "Missing skill_id tag",
      });
      continue;
    }

    // Case 3: Queue exists with correct tag but wrong name → rename
    if (existingByTag && existingByTag.Name?.toLowerCase() !== targetName) {
      actions.push({
        type: "rename",
        resourceType: "queue",
        currentName: existingByTag.Name,
        targetName: mapping.queue_name,
        skillId,
        reason: `Name mismatch: "${existingByTag.Name}" → "${mapping.queue_name}"`,
      });
      continue;
    }

    // Case 4: Queue exists with wrong name AND wrong tag → recreate
    if (
      existingByName &&
      existingByName.tags?.cxone_skill_id &&
      existingByName.tags!.cxone_skill_id !== skillId
    ) {
      actions.push({
        type: "recreate",
        resourceType: "queue",
        currentName: existingByName.Name,
        targetName: mapping.queue_name,
        skillId,
        reason: `Wrong skill tag: "${existingByName.tags!.cxone_skill_id}" → "${skillId}"`,
      });
      continue;
    }

    // Case 5: Queue doesn't exist → create
    actions.push({
      type: "create",
      resourceType: "queue",
      targetName: mapping.queue_name,
      skillId,
      reason: "Queue does not exist",
    });
  }

  // Check for orphaned queues (not in mapping but tagged)
  for (const q of liveQueues) {
    const skillTag = q.tags?.cxone_skill_id;
    if (skillTag && !skillMapping.has(skillTag)) {
      actions.push({
        type: "delete",
        resourceType: "queue",
        currentName: q.Name,
        skillId: skillTag,
        reason: "Skill ID not in mapping (orphaned)",
      });
    }
  }

  return actions;
}

// ─── Sync execution ──────────────────────────────────────────────────────────

/**
 * Execute queue sync actions
 */
export async function executeQueueSync(
  client: ConnectClient,
  instanceId: string,
  actions: SyncAction[],
  hooId?: string,
  onProgress?: (current: number, total: number, action: SyncAction) => void,
): Promise<SyncResult> {
  const result: SyncResult = {
    actions: [],
    created: 0,
    renamed: 0,
    retagged: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
  };

  const total = actions.length;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    onProgress?.(i, total, action);

    try {
      switch (action.type) {
        case "skip":
          result.skipped++;
          result.actions.push(action);
          break;

        case "create": {
          const resp = await client.send(
            new CreateQueueCommand({
              InstanceId: instanceId,
              Name: action.targetName!,
              HoursOfOperationId: hooId,
              Description: `Created from skill mapping: ${action.skillId}`,
              Tags: {
                source: "queue-sync",
                cxone_skill_id: action.skillId!,
              },
            }),
          );
          result.created++;
          result.actions.push({
            ...action,
            reason: `Created: ${resp.QueueArn}`,
          });
          break;
        }

        case "rename": {
          // Find queue by skill tag
          const queues = await fetchQueuesWithTags(client, instanceId);
          const queue = queues.find(
            (q) => q.tags?.cxone_skill_id === action.skillId,
          );
          if (!queue?.QueueId) {
            throw new Error(`Queue not found for skill ${action.skillId}`);
          }
          await client.send(
            new UpdateQueueNameCommand({
              InstanceId: instanceId,
              QueueId: queue.QueueId,
              Name: action.targetName!,
            }),
          );
          result.renamed++;
          result.actions.push({
            ...action,
            reason: `Renamed to "${action.targetName}"`,
          });
          break;
        }

        case "recreate": {
          // Find and delete old queue
          const oldQueues = await fetchQueuesWithTags(client, instanceId);
          const oldQueue = oldQueues.find(
            (q) => q.Name?.toLowerCase() === action.currentName?.toLowerCase(),
          );
          if (oldQueue?.QueueId) {
            await client.send(
              new DeleteQueueCommand({
                InstanceId: instanceId,
                QueueId: oldQueue.QueueId,
              }),
            );
          }
          // Create new queue
          const resp = await client.send(
            new CreateQueueCommand({
              InstanceId: instanceId,
              Name: action.targetName!,
              HoursOfOperationId: hooId,
              Description: `Recreated from skill mapping: ${action.skillId}`,
              Tags: {
                source: "queue-sync",
                cxone_skill_id: action.skillId!,
              },
            }),
          );
          result.created++;
          result.deleted++;
          result.actions.push({
            ...action,
            reason: `Recreated: ${resp.QueueArn}`,
          });
          break;
        }

        case "tag": {
          // Find queue by name
          const queues = await fetchQueuesWithTags(client, instanceId);
          const queue = queues.find(
            (q) => q.Name?.toLowerCase() === action.targetName?.toLowerCase(),
          );
          if (!queue?.QueueArn) {
            throw new Error(`Queue "${action.targetName}" not found`);
          }
          await client.send(
            new TagResourceCommand({
              ResourceArn: queue.QueueArn,
              Tags: { cxone_skill_id: action.skillId! },
            }),
          );
          result.retagged++;
          result.actions.push({
            ...action,
            reason: `Added tag cxone_skill_id=${action.skillId}`,
          });
          break;
        }

        case "untag": {
          const queues = await fetchQueuesWithTags(client, instanceId);
          const queue = queues.find(
            (q) => q.Name?.toLowerCase() === action.currentName?.toLowerCase(),
          );
          if (queue?.QueueArn) {
            await client.send(
              new UntagResourceCommand({
                ResourceArn: queue.QueueArn,
                TagKeys: ["cxone_skill_id"],
              }),
            );
            result.retagged++;
          }
          result.actions.push(action);
          break;
        }

        case "delete": {
          const queues = await fetchQueuesWithTags(client, instanceId);
          const queue = queues.find(
            (q) => q.Name?.toLowerCase() === action.currentName?.toLowerCase(),
          );
          if (queue?.QueueId) {
            await client.send(
              new DeleteQueueCommand({
                InstanceId: instanceId,
                QueueId: queue.QueueId,
              }),
            );
            result.deleted++;
          }
          result.actions.push({ ...action, reason: "Deleted (orphaned)" });
          break;
        }
      }
    } catch (e: any) {
      result.errors.push({
        resource: action.currentName ?? action.targetName ?? "",
        error: e.message,
      });
    }
  }

  return result;
}

// ─── Flow sync ───────────────────────────────────────────────────────────────

/**
 * Sync queues from loaded flows with live Connect queues
 * Updates QueueRecord ARNs based on live queue data
 */
export async function syncQueuesWithFlows(
  client: ConnectClient,
  instanceId: string,
  flowQueues: QueueRecord[],
): Promise<QueueRecord[]> {
  // Fetch live queues with tags
  const liveQueues = await fetchQueuesWithTags(client, instanceId);
  const liveByName = new Map(liveQueues.map((q) => [q.Name?.toLowerCase(), q]));
  const liveBySkillTag = new Map(
    liveQueues
      .filter((q) => q.tags?.cxone_skill_id)
      .map((q) => [q.tags!.cxone_skill_id!, q]),
  );

  return flowQueues.map((q) => {
    // Try to match by name first
    let live = liveByName.get(q.connectName.toLowerCase());

    // If not found by name, try by skill ID tag
    if (!live && q.queueSkill) {
      live = liveBySkillTag.get(q.queueSkill);
    }

    if (live) {
      return {
        ...q,
        queueArn: live.QueueArn ?? q.queueArn,
        queueId: live.QueueId ?? q.queueId,
        // Update name if it differs (live source of truth)
        connectName: live.Name ?? q.connectName,
      };
    }

    return q;
  });
}

/**
 * Check which queues from flows are missing in Connect
 */
export function findMissingQueues(
  flowQueues: QueueRecord[],
  liveQueues: QueuedWithTags[],
): QueueRecord[] {
  const liveNames = new Set(
    liveQueues.map((q) => q.Name?.toLowerCase()).filter(Boolean) as string[],
  );
  const liveSkillTags = new Set(
    liveQueues.map((q) => q.tags?.cxone_skill_id).filter(Boolean) as string[],
  );

  return flowQueues.filter((q) => {
    const byName = liveNames.has(q.connectName.toLowerCase());
    const bySkill = q.queueSkill ? liveSkillTags.has(q.queueSkill) : false;
    return !byName && !bySkill;
  });
}
