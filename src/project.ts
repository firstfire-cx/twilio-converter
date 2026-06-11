// src/project.ts
//
// Unified project file format (.ivrproj.json) containing:
//   - IR (flow structure)
//   - Flow metadata (dialed_number, instance_id, etc.)
//   - Queue/skill mappings
//   - Hours of Operation schedule

import type { IR, FlowMeta } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QueueRecord {
  /** The SkillWhisper value from the flow (stable display key) */
  skillWhisper: string;
  /** Original CXone skill number (e.g. "123") */
  queueSkill?: string;
  /** Connect queue name (may differ from skillWhisper after CSV import) */
  connectName: string;
  /** Connect queue ARN — populated after provisioning */
  queueArn?: string;
  /** Connect queue ID (UUID) — populated after provisioning */
  queueId?: string;
  /** Optional description */
  description?: string;
}

export interface HooSchedule {
  [day: string]: {
    enabled: boolean;
    start: string; // "HH:MM"
    end: string;   // "HH:MM"
  };
}

export interface HoursOfOperation {
  name: string;
  timezone: string;
  description?: string;
  schedule: HooSchedule;
  /** Connect HOO ARN — populated after provisioning */
  hooArn?: string;
  /** Connect HOO ID (UUID) — populated after provisioning */
  hooId?: string;
}

export interface IVRProject {
  version: string;
  /** The IR (flow structure) */
  ir: IR;
  /** Flow metadata for DynamoDB upload */
  meta: Partial<FlowMeta>;
  /** Queue/skill mappings — one per unique SkillWhisper in the flow */
  queues: QueueRecord[];
  /** Hours of Operation configuration */
  hoo?: HoursOfOperation;
  /** Timestamp of last save */
  savedAt?: string;
}

// ─── Serialization ───────────────────────────────────────────────────────────

/** Serialize a project to a JSON string. */
export function serializeProject(project: IVRProject): string {
  const output: IVRProject = {
    ...project,
    version: "1.1",
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(output, null, 2);
}

/** Parse a project JSON string, providing defaults for missing optional fields. */
export function parseProject(json: string): IVRProject {
  const parsed = JSON.parse(json);
  if (!parsed.ir) throw new Error("Invalid project file: missing 'ir' field");
  return {
    version: parsed.version || "1.0",
    ir: parsed.ir,
    meta: parsed.meta || {},
    queues: parsed.queues || [],
    hoo: parsed.hoo,
    savedAt: parsed.savedAt,
  };
}

// ─── File I/O ────────────────────────────────────────────────────────────────

export function downloadProject(project: IVRProject, filename?: string): void {
  const json = serializeProject(project);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `${project.ir.flow_id || "flow"}.ivrproj.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Default values ──────────────────────────────────────────────────────────

const DAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;

export const DEFAULT_HOO_SCHEDULE: HooSchedule = Object.fromEntries(
  DAYS.map((d) => [
    d,
    {
      enabled: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].includes(d),
      start: "08:00",
      end: "17:00",
    },
  ]),
);

export function createDefaultHoo(): HoursOfOperation {
  return {
    name: "Business Hours",
    timezone: "America/New_York",
    description: "",
    schedule: DEFAULT_HOO_SCHEDULE,
  };
}

// ─── Queue extraction ─────────────────────────────────────────────────────────

/**
 * Walk the IR's SET nodes and extract (QueueSkill, SkillWhisper) pairs.
 * Handles both same-node and sequential node assignments.
 * Merges with existingQueues to preserve ARNs and renamed connectNames.
 */
export function extractQueuesFromIR(
  ir: IR,
  existingQueues: QueueRecord[] = [],
): QueueRecord[] {
  const found = new Map<string, { queueSkill?: string; skillWhisper: string }>();

  // Pass 1: same-node assignments
  for (const node of Object.values(ir.nodes)) {
    if (node.action_type !== "SET") continue;
    const asgn = node.content?.assignments ?? {};
    const qs = asgn["QueueSkill"];
    const sw = asgn["SkillWhisper"];
    if (qs && sw) {
      found.set(sw, { queueSkill: qs, skillWhisper: sw });
    } else if (sw && !found.has(sw)) {
      found.set(sw, { skillWhisper: sw });
    }
  }

  // Pass 2: sequential nodes (QueueSkill in node N, SkillWhisper in node N+1)
  const nodeArr = Object.values(ir.nodes);
  for (let i = 0; i < nodeArr.length - 1; i++) {
    const curr = nodeArr[i];
    const next = nodeArr[i + 1];
    if (curr.action_type !== "SET" || next.action_type !== "SET") continue;
    const qs = (curr.content?.assignments ?? {})["QueueSkill"];
    const sw = (next.content?.assignments ?? {})["SkillWhisper"];
    if (qs && sw && !found.has(sw)) {
      found.set(sw, { queueSkill: qs, skillWhisper: sw });
    }
  }

  return mergePersistedQueues(Array.from(found.values()), existingQueues);
}

/**
 * Merge freshly-extracted (queueSkill, skillWhisper) pairs with the persisted
 * queue records, matching by skillWhisper. Preserves the user's edited
 * connectName plus the resolved ARN/ID/description; takes the fresh queueSkill
 * when present, else the persisted one.
 *
 * Used both by extractQueuesFromIR and by the Skills panel when (re)seeding rows
 * from a CXone source, so a renamed queue survives a panel close/reopen.
 */
export function mergePersistedQueues(
  extracted: Array<{ queueSkill?: string; skillWhisper: string }>,
  existingQueues: QueueRecord[] = [],
): QueueRecord[] {
  const existingMap = new Map(existingQueues.map((q) => [q.skillWhisper, q]));
  return extracted.map(({ queueSkill, skillWhisper }) => {
    const existing = existingMap.get(skillWhisper);
    return {
      skillWhisper,
      queueSkill: queueSkill ?? existing?.queueSkill,
      connectName: existing?.connectName ?? skillWhisper,
      queueArn: existing?.queueArn,
      queueId: existing?.queueId,
      description: existing?.description,
    };
  });
}

// ─── Flow validation ──────────────────────────────────────────────────────────

export interface FlowWarning {
  kind: "missing-hoo" | "unmatched-queue" | "missing-queue-arn" | "dangling-branch" | "no-start";
  message: string;
  nodeId?: string;
}

/**
 * Validate an IR against the current queues/HOO state.
 * Returns a list of warnings to surface to the user.
 */
export function validateFlow(
  ir: IR,
  queues: QueueRecord[],
  hoo?: HoursOfOperation,
): FlowWarning[] {
  const warnings: FlowWarning[] = [];
  const nodes = ir.nodes;

  if (!ir.start_step || !nodes[ir.start_step]) {
    warnings.push({ kind: "no-start", message: "No start step defined" });
  }

  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type === "HOURS") {
      const arn = node.content?.hoo_arn ?? ir.hoo_arn ?? hoo?.hooArn;
      if (!arn) {
        warnings.push({
          kind: "missing-hoo",
          message: `HOURS node "${id}" has no HOO ARN`,
          nodeId: id,
        });
      }
    }

    if (node.action_type === "TRANSFER" && node.content?.agentSkill) {
      const skill = node.content.agentSkill;
      const match = queues.find(
        (q) => q.queueSkill === skill || q.skillWhisper === skill,
      );
      if (!match) {
        warnings.push({
          kind: "unmatched-queue",
          message: `TRANSFER "${id}" skill "${skill}" not in queue mappings`,
          nodeId: id,
        });
      } else if (!match.queueArn) {
        warnings.push({
          kind: "missing-queue-arn",
          message: `TRANSFER "${id}" → "${match.connectName}" not yet provisioned`,
          nodeId: id,
        });
      }
    }

    const targets = [
      node.default_next,
      ...Object.values(node.content?.branches ?? {}),
    ].filter(Boolean) as string[];

    for (const t of targets) {
      if (t !== "END" && !nodes[t]) {
        warnings.push({
          kind: "dangling-branch",
          message: `"${id}" → dangling target "${t}"`,
          nodeId: id,
        });
      }
    }
  }

  return warnings;
}

/**
 * After provisioning queues, patch TRANSFER nodes in the IR whose agentSkill
 * matches a provisioned queue, injecting the queue ARN into content.queueArn.
 * Returns the same IR object if nothing changed.
 */
export function patchTransferArns(ir: IR, queues: QueueRecord[]): IR {
  const arnBySkill = new Map<string, string>();
  const arnByWhisper = new Map<string, string>();
  for (const q of queues) {
    if (!q.queueArn) continue;
    if (q.queueSkill) arnBySkill.set(q.queueSkill, q.queueArn);
    arnByWhisper.set(q.skillWhisper, q.queueArn);
  }

  if (arnBySkill.size === 0 && arnByWhisper.size === 0) return ir;

  let changed = false;
  const newNodes = { ...ir.nodes };

  for (const [id, node] of Object.entries(ir.nodes)) {
    if (node.action_type !== "TRANSFER") continue;
    const skill = node.content?.agentSkill;
    if (!skill) continue;
    const arn = arnBySkill.get(skill) ?? arnByWhisper.get(skill);
    if (arn && node.content?.queueArn !== arn) {
      newNodes[id] = { ...node, content: { ...node.content, queueArn: arn } };
      changed = true;
    }
  }

  return changed ? { ...ir, nodes: newNodes } : ir;
}
