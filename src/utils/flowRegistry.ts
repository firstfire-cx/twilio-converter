// src/utils/flowRegistry.ts
//
// Pure reducer that consolidates one-or-more DynamoDB flow scans (+ per-env
// Connect HOO name maps) into a single registry table. Decoupled from the panel
// UI so it is unit-testable and reusable (e.g. by a downstream tool consuming
// the JSON export). Phase 1 feeds a single env; the reducer is already written
// N-env so Phase 2 (sandbox + prod side-by-side) reuses it unchanged.

import type { DdbState } from "./ddbScan";
import { normalizeName, hooIdFromArn } from "./queueReconcile";

export interface EnvScan {
  /** Display + join label, e.g. "sandbox" | "prod". */
  label: string;
  ddb: DdbState;
  /** HOO id → friendly name (from ListHoursOfOperations) for this env. */
  hooNames: Map<string, string>;
}

export type JoinStatus =
  | "single-env"   // only one env scanned — join taxonomy inert
  | "in-sync"      // present + name+numbers+HOO identical in all envs
  | "number-drift" // same flow name in all envs, but numbers/HOO differ
  | "name-fuzzy"   // joined via normalized key but raw names differ
  | "sandbox-only"
  | "prod-only";

export interface EnvFlowState {
  rawFlowId: string;
  dialedNumbers: string[]; // empty = "not yet live"
  hooArn?: string;
  hooName?: string;
  instanceId?: string;
  description?: string;
  liveStatus: "live" | "not-yet";
}

export interface FlowRow {
  flowKey: string; // normalized join key
  healthPlan?: string;
  envs: Record<string, EnvFlowState>;
  joinStatus: JoinStatus;
}

export interface DriftSummary {
  inSync: number;
  numberDrift: number;
  nameFuzzy: number;
  sandboxOnly: number;
  prodOnly: number;
}

export interface FlowRegistry {
  rows: FlowRow[];
  drift: DriftSummary;
  envLabels: string[];
  generatedAt: Date;
}

function numbersKey(nums: string[]): string {
  return [...nums].sort().join(",");
}

function computeJoinStatus(row: FlowRow, labels: string[]): JoinStatus {
  const present = labels.filter((l) => row.envs[l]);
  if (present.length < labels.length) {
    if (present.length === 1) {
      return present[0] === "prod" ? "prod-only" : "sandbox-only";
    }
    return "sandbox-only"; // partial across 3+ envs — Phase 1/2 are 1-2 envs
  }
  const states = present.map((l) => row.envs[l]);
  const rawIds = new Set(states.map((s) => s.rawFlowId));
  if (rawIds.size > 1) return "name-fuzzy"; // normalized-equal but raw differ
  const baseNums = numbersKey(states[0].dialedNumbers);
  const baseHoo = states[0].hooArn ?? "";
  const sameNums = states.every((s) => numbersKey(s.dialedNumbers) === baseNums);
  const sameHoo = states.every((s) => (s.hooArn ?? "") === baseHoo);
  return sameNums && sameHoo ? "in-sync" : "number-drift";
}

function summarize(rows: FlowRow[]): DriftSummary {
  const d: DriftSummary = { inSync: 0, numberDrift: 0, nameFuzzy: 0, sandboxOnly: 0, prodOnly: 0 };
  for (const r of rows) {
    if (r.joinStatus === "in-sync") d.inSync++;
    else if (r.joinStatus === "number-drift") d.numberDrift++;
    else if (r.joinStatus === "name-fuzzy") d.nameFuzzy++;
    else if (r.joinStatus === "sandbox-only") d.sandboxOnly++;
    else if (r.joinStatus === "prod-only") d.prodOnly++;
  }
  return d;
}

export function buildFlowRegistry(envs: EnvScan[]): FlowRegistry {
  const singleEnv = envs.length <= 1;
  const labels = envs.map((e) => e.label);
  const byKey = new Map<string, FlowRow>();

  for (const env of envs) {
    for (const def of env.ddb.flowDefs) {
      const baseKey = normalizeName(def.targetFlowId);
      if (!baseKey) continue;
      const dialedNumbers = def.metas.map((m) => m.dialedNumber).filter(Boolean);
      const m0 = def.metas[0];
      const hooArn = def.hooArn;
      const hooName = hooArn ? env.hooNames.get(hooIdFromArn(hooArn)) : undefined;

      const state: EnvFlowState = {
        rawFlowId: def.targetFlowId,
        dialedNumbers,
        hooArn,
        hooName,
        instanceId: def.instanceId,
        description: m0?.description,
        liveStatus: dialedNumbers.length > 0 ? "live" : "not-yet",
      };

      // Normally one row per normalized name (so the same flow joins across envs).
      // But two flows in the SAME env that normalize to the same key are distinct
      // near-duplicates the user must still see/act on — give the colliding one
      // its own row rather than overwriting.
      let key = baseKey;
      let row = byKey.get(key);
      if (row && row.envs[env.label]) {
        key = `${baseKey} (${def.targetFlowId})`;
        row = byKey.get(key);
      }
      if (!row) {
        row = { flowKey: key, envs: {}, joinStatus: "single-env" };
        byKey.set(key, row);
      }
      row.envs[env.label] = state;
    }
  }

  for (const row of byKey.values()) {
    row.healthPlan =
      row.envs["sandbox"]?.description ??
      labels.map((l) => row.envs[l]?.description).find(Boolean);
    row.joinStatus = singleEnv ? "single-env" : computeJoinStatus(row, labels);
  }

  const rows = [...byKey.values()].sort((a, b) => a.flowKey.localeCompare(b.flowKey));
  return { rows, drift: summarize(rows), envLabels: labels, generatedAt: new Date() };
}
