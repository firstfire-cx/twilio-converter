// src/utils/project.ts
//
// Unified project file format (.ivrproj.json) containing:
// - IR (flow structure)
// - Flow metadata (dialed_number, instance_id, etc.)
// - Queue/skill mappings
// - Hours of Operation schedule

import type { IR, FlowMeta } from "../types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QueueRecord {
  /** The SkillWhisper value from the flow (immutable key) */
  skillWhisper: string;
  /** Original skill number from CXone (e.g. "123") */
  queueSkill?: string;
  /** Connect queue name (may differ from skillWhisper after CSV import) */
  connectName: string;
  /** Connect queue ARN */
  queueArn?: string;
  /** Connect queue ID (UUID) */
  queueId?: string;
  /** Optional description */
  description?: string;
}

export interface HooSchedule {
  [day: string]: {
    enabled: boolean;
    start: string; // "HH:MM"
    end: string; // "HH:MM"
  };
}

export interface HoursOfOperation {
  name: string;
  timezone: string;
  description?: string;
  schedule: HooSchedule;
  /** Connect HOO ARN */
  hooArn?: string;
  /** Connect HOO ID (UUID) */
  hooId?: string;
}

export interface IVRProject {
  version: string;
  /** The IR (flow structure) */
  ir: IR;
  /** Flow metadata */
  meta: FlowMeta;
  /** Queue/skill mappings */
  queues: QueueRecord[];
  /** Hours of Operation */
  hoo?: HoursOfOperation;
  /** Timestamp of last save */
  savedAt?: string;
}

// ─── Serialization ───────────────────────────────────────────────────────────

export function serializeProject(project: IVRProject): string {
  const output: IVRProject = {
    ...project,
    version: "1.0",
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(output, null, 2);
}

export function parseProject(json: string): IVRProject {
  const parsed = JSON.parse(json);

  // Validate required fields
  if (!parsed.ir) {
    throw new Error("Invalid project file: missing 'ir' field");
  }

  // Provide defaults for optional fields
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

export function uploadProject(
  onLoad: (project: IVRProject) => void,
  onError?: (error: Error) => void,
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.ivrproj.json";

  input.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const project = parseProject(text);
        onLoad(project);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("Failed to parse project:", error);
        if (onError) onError(error);
        else alert("Failed to load project: " + error.message);
      }
    };
    reader.onerror = () => {
      const error = new Error("Failed to read file");
      if (onError) onError(error);
      else alert(error.message);
    };
    reader.readAsText(file);
  };

  input.click();
}

// ─── Default values ──────────────────────────────────────────────────────────

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const DEFAULT_HOO_SCHEDULE: HooSchedule = Object.fromEntries(
  DAYS.map((d) => [
    d,
    {
      enabled: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
      ].includes(d),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract queue records from an IR by finding SET nodes that assign
 * QueueSkill and SkillWhisper variables.
 */
export function extractQueuesFromIR(ir: IR): QueueRecord[] {
  const found = new Map<
    string,
    { queueSkill?: string; skillWhisper: string }
  >();
  let lastQS = "";

  for (const node of Object.values(ir.nodes)) {
    if (node.action_type !== "SET") continue;
    const assignments = node.content?.assignments ?? {};
    const qs = assignments["QueueSkill"];
    const sw = assignments["SkillWhisper"];

    if (qs) lastQS = qs;
    if (sw && lastQS) {
      found.set(sw, { queueSkill: lastQS, skillWhisper: sw });
      lastQS = "";
    } else if (sw) {
      found.set(sw, { skillWhisper: sw });
    }
  }

  return Array.from(found.values()).map(({ queueSkill, skillWhisper }) => ({
    skillWhisper,
    queueSkill,
    connectName: skillWhisper, // Default to skillWhisper
  }));
}

/**
 * Create a new project from just an IR, extracting queues and providing defaults.
 */
export function createProjectFromIR(
  ir: IR,
  meta?: Partial<FlowMeta>,
): IVRProject {
  return {
    version: "1.0",
    ir,
    meta: {
      dialed_number: meta?.dialed_number ?? "",
      target_flow_id: meta?.target_flow_id ?? ir.flow_id,
      start_step: meta?.start_step ?? ir.start_step ?? "",
      hoo_arn: meta?.hoo_arn,
      instance_id: meta?.instance_id,
      description: meta?.description,
    },
    queues: extractQueuesFromIR(ir),
    hoo: createDefaultHoo(),
  };
}
