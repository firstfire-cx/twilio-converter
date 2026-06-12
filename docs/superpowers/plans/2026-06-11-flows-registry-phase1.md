# Flows Registry (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-maintained IVR-flow spreadsheet with a generated, consolidated "Flows Registry" table in the Account panel that reads live DynamoDB + Connect state, supports inline flow rename, and exports to Markdown / CSV / JSON.

**Architecture:** A pure reducer `buildFlowRegistry(envs)` turns one-or-more `DdbState` scans (+ per-env HOO name maps) into a `FlowRegistry` of consolidated rows. Phase 1 feeds it a single (sandbox) env; the reducer is already written N-env so Phase 2 (prod side-by-side) reuses it unchanged. Three pure exporters render the registry to MD/CSV/JSON. A new crash-safe `renameFlow` cascade reconciles flow naming. The existing `DdbFlowsPanel` (the "DynamoDB Flows" tab) is evolved into the registry table; its existing load/prune/delete/META-edit handlers are kept.

**Tech Stack:** React 19 + TypeScript, Vitest, AWS SDK v3 (`@aws-sdk/lib-dynamodb`, `@aws-sdk/client-connect`), zustand, papaparse.

**Scope note:** This plan is Phase 1 only — single (sandbox) account, editable, with exports. Phase 2 (second read-only prod credential context, `ReadOnlyAwsCredentials` type, dual-account side-by-side columns, drift headline) is a separate follow-up plan. The reducer, exporters, and rename built here are the reusable core; Phase 2 adds a second `EnvScan` and the read-only credential plumbing. Design spec: `docs/superpowers/specs/2026-06-11-flows-registry-design.md`.

---

## File Structure

- **Create** `src/utils/flowRegistry.ts` — `EnvScan`, `FlowRow`, `EnvFlowState`, `JoinStatus`, `DriftSummary`, `FlowRegistry` types + the pure `buildFlowRegistry()` reducer. Reuses `normalizeName` and `hooIdFromArn` from `queueReconcile.ts`.
- **Create** `src/utils/flowRegistry.test.ts` — reducer unit tests (single-env, two-env exact/number-drift/name-fuzzy/sandbox-only/prod-only, not-yet-live, HOO name resolution, drift counts).
- **Create** `src/utils/flowRegistryExport.ts` — pure `toMarkdown()`, `toCsv()`, `toJson()` (no DOM).
- **Create** `src/utils/flowRegistryExport.test.ts` — exporter output tests from a fixed registry.
- **Modify** `src/utils/ddbScan.ts` — add pure `planRenameFlow()` + `RenameFlowPlan` type and the `renameFlow()` executor, next to `editFlowMeta`.
- **Modify** `src/utils/ddbScan.test.ts` — `planRenameFlow` unit tests.
- **Modify** `src/components/AccountPanel.tsx` — relabel the `ddb` tab "Flows Registry"; evolve `DdbFlowsPanel` body into the consolidated table; add flow-rename UI + MD/CSV/JSON export buttons.

---

## Task 1: Registry types + reducer (single-env)

**Files:**
- Create: `src/utils/flowRegistry.ts`
- Test: `src/utils/flowRegistry.test.ts`

- [ ] **Step 1: Write the failing test (single-env basics)**

Create `src/utils/flowRegistry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFlowRegistry, type EnvScan } from "./flowRegistry";
import type { DdbState, DdbFlow } from "./ddbScan";

function flow(partial: Partial<DdbFlow> & { targetFlowId: string }): DdbFlow {
  return {
    stepCount: 1,
    metas: [],
    queues: [],
    ...partial,
  };
}

function ddbState(flowDefs: DdbFlow[]): DdbState {
  return {
    flows: flowDefs.flatMap((f) => f.metas),
    flowDefs,
    queueUsage: new Map(),
    missingInConnect: [],
    scannedAt: new Date("2026-06-11T00:00:00Z"),
  };
}

function sandbox(flowDefs: DdbFlow[], hooNames = new Map<string, string>()): EnvScan {
  return { label: "sandbox", ddb: ddbState(flowDefs), hooNames };
}

describe("buildFlowRegistry — single env", () => {
  it("builds a row per flow, marks live vs not-yet, and resolves the HOO name", () => {
    const hooNames = new Map([["hoo-123", "Aetna Hours"]]);
    const reg = buildFlowRegistry([
      sandbox(
        [
          flow({
            targetFlowId: "landing_aetna",
            hooArn: "arn:aws:connect:us-east-1:1:instance/x/operating-hours/hoo-123",
            metas: [
              {
                dialedNumber: "+18005551234",
                targetFlowId: "landing_aetna",
                hooArn: "arn:aws:connect:us-east-1:1:instance/x/operating-hours/hoo-123",
                description: "Aetna",
              },
            ],
          }),
          flow({ targetFlowId: "landing_kp_colorado", metas: [] }), // no number → not-yet
        ],
        hooNames,
      ),
    ]);

    expect(reg.envLabels).toEqual(["sandbox"]);
    expect(reg.rows.map((r) => r.flowKey)).toEqual(["landing aetna", "landing kp colorado"]);

    const aetna = reg.rows[0];
    expect(aetna.joinStatus).toBe("single-env");
    expect(aetna.healthPlan).toBe("Aetna");
    expect(aetna.envs.sandbox.liveStatus).toBe("live");
    expect(aetna.envs.sandbox.dialedNumbers).toEqual(["+18005551234"]);
    expect(aetna.envs.sandbox.hooName).toBe("Aetna Hours");

    const kp = reg.rows[1];
    expect(kp.envs.sandbox.liveStatus).toBe("not-yet");
    expect(kp.envs.sandbox.dialedNumbers).toEqual([]);

    // Single-env: drift counts are all zero.
    expect(reg.drift).toEqual({
      inSync: 0, numberDrift: 0, nameFuzzy: 0, sandboxOnly: 0, prodOnly: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- flowRegistry`
Expected: FAIL — `Cannot find module './flowRegistry'`.

- [ ] **Step 3: Write the reducer**

Create `src/utils/flowRegistry.ts`:

```ts
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
      const key = normalizeName(def.targetFlowId);
      if (!key) continue;
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

      let row = byKey.get(key);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- flowRegistry`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/utils/flowRegistry.ts src/utils/flowRegistry.test.ts
git commit -m "feat: flow registry reducer (single-env)"
```

---

## Task 2: Two-env join + drift in the reducer

**Files:**
- Modify: `src/utils/flowRegistry.test.ts`
- (No production change expected — the reducer is already N-env. These tests pin the two-env behaviour and guard Phase 2.)

- [ ] **Step 1: Add the failing two-env tests**

Append to `src/utils/flowRegistry.test.ts`:

```ts
import type { DdbFlowMeta } from "./ddbScan";

function meta(partial: Partial<DdbFlowMeta> & { dialedNumber: string; targetFlowId: string }): DdbFlowMeta {
  return { ...partial };
}

function env(label: string, flowDefs: DdbFlow[], hooNames = new Map<string, string>()): EnvScan {
  return { label, ddb: ddbState(flowDefs), hooNames };
}

describe("buildFlowRegistry — two envs", () => {
  it("classifies in-sync, number-drift, name-fuzzy, sandbox-only, prod-only", () => {
    const sb = [
      // identical to prod → in-sync
      flow({ targetFlowId: "landing_aetna", hooArn: "arn/hoo-1",
             metas: [meta({ dialedNumber: "+1A", targetFlowId: "landing_aetna", hooArn: "arn/hoo-1", description: "Aetna" })] }),
      // same name, different number → number-drift
      flow({ targetFlowId: "landing_bcbs", hooArn: "arn/hoo-2",
             metas: [meta({ dialedNumber: "+1SB", targetFlowId: "landing_bcbs", hooArn: "arn/hoo-2" })] }),
      // normalized-equal but raw differs from prod → name-fuzzy
      flow({ targetFlowId: "landing_carefirst",
             metas: [meta({ dialedNumber: "+1C", targetFlowId: "landing_carefirst" })] }),
      // only in sandbox → sandbox-only
      flow({ targetFlowId: "landing_kp_co",
             metas: [meta({ dialedNumber: "+1K", targetFlowId: "landing_kp_co" })] }),
    ];
    const pr = [
      flow({ targetFlowId: "landing_aetna", hooArn: "arn/hoo-1",
             metas: [meta({ dialedNumber: "+1A", targetFlowId: "landing_aetna", hooArn: "arn/hoo-1", description: "Aetna" })] }),
      flow({ targetFlowId: "landing_bcbs", hooArn: "arn/hoo-2",
             metas: [meta({ dialedNumber: "+1PR", targetFlowId: "landing_bcbs", hooArn: "arn/hoo-2" })] }),
      flow({ targetFlowId: "Landing-CareFirst",
             metas: [meta({ dialedNumber: "+1C", targetFlowId: "Landing-CareFirst" })] }),
      // only in prod → prod-only
      flow({ targetFlowId: "landing_kp_ga",
             metas: [meta({ dialedNumber: "+1G", targetFlowId: "landing_kp_ga" })] }),
    ];

    const reg = buildFlowRegistry([env("sandbox", sb), env("prod", pr)]);
    const status = (key: string) => reg.rows.find((r) => r.flowKey === key)!.joinStatus;

    expect(status("landing aetna")).toBe("in-sync");
    expect(status("landing bcbs")).toBe("number-drift");
    expect(status("landing carefirst")).toBe("name-fuzzy");
    expect(status("landing kp co")).toBe("sandbox-only");
    expect(status("landing kp ga")).toBe("prod-only");

    // name-fuzzy row preserves both raw ids so the user sees the mismatch.
    const cf = reg.rows.find((r) => r.flowKey === "landing carefirst")!;
    expect(cf.envs.sandbox.rawFlowId).toBe("landing_carefirst");
    expect(cf.envs.prod.rawFlowId).toBe("Landing-CareFirst");

    expect(reg.drift).toEqual({
      inSync: 1, numberDrift: 1, nameFuzzy: 1, sandboxOnly: 1, prodOnly: 1,
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- flowRegistry`
Expected: PASS (both describe blocks). If any two-env case fails, fix `computeJoinStatus`/`summarize` in `src/utils/flowRegistry.ts` until green — do not change the test expectations.

- [ ] **Step 3: Commit**

```bash
git add src/utils/flowRegistry.test.ts src/utils/flowRegistry.ts
git commit -m "test: pin two-env drift classification in flow registry"
```

---

## Task 3: Exporters (Markdown / CSV / JSON)

**Files:**
- Create: `src/utils/flowRegistryExport.ts`
- Test: `src/utils/flowRegistryExport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/flowRegistryExport.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toMarkdown, toCsv, toJson } from "./flowRegistryExport";
import type { FlowRegistry } from "./flowRegistry";

const reg: FlowRegistry = {
  envLabels: ["sandbox"],
  generatedAt: new Date("2026-06-11T00:00:00Z"),
  drift: { inSync: 0, numberDrift: 0, nameFuzzy: 0, sandboxOnly: 0, prodOnly: 0 },
  rows: [
    {
      flowKey: "landing aetna",
      healthPlan: "Aetna",
      joinStatus: "single-env",
      envs: {
        sandbox: {
          rawFlowId: "landing_aetna",
          dialedNumbers: ["+18005551234"],
          hooArn: "arn/hoo-1",
          hooName: "Aetna Hours",
          liveStatus: "live",
          description: "Aetna",
        },
      },
    },
    {
      flowKey: "landing kp colorado",
      healthPlan: undefined,
      joinStatus: "single-env",
      envs: {
        sandbox: {
          rawFlowId: "landing_kp_colorado",
          dialedNumbers: [],
          liveStatus: "not-yet",
        },
      },
    },
  ],
};

describe("flow registry exporters (single env)", () => {
  it("renders a Markdown table without a Join Status column", () => {
    const md = toMarkdown(reg);
    expect(md).toBe(
      [
        "| Health Plan | Sandbox Flow | Sandbox Numbers | Sandbox HOO | Sandbox Status |",
        "| --- | --- | --- | --- | --- |",
        "| Aetna | landing_aetna | +18005551234 | Aetna Hours | live |",
        "|  | landing_kp_colorado |  |  | not-yet |",
      ].join("\n"),
    );
  });

  it("renders CSV with a header row + one row per flow", () => {
    const csv = toCsv(reg);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Health Plan,Sandbox Flow,Sandbox Numbers,Sandbox HOO,Sandbox Status");
    expect(lines[1]).toBe("Aetna,landing_aetna,+18005551234,Aetna Hours,live");
    expect(lines).toHaveLength(3);
  });

  it("renders stable JSON with generatedAt as ISO and the rows", () => {
    const obj = JSON.parse(toJson(reg));
    expect(obj.generatedAt).toBe("2026-06-11T00:00:00.000Z");
    expect(obj.envLabels).toEqual(["sandbox"]);
    expect(obj.rows[0].flowKey).toBe("landing aetna");
    expect(obj.rows[0].healthPlan).toBe("Aetna");
    expect(obj.rows[1].healthPlan).toBeNull();
  });
});

describe("flow registry exporters (two envs)", () => {
  it("adds a Join Status column + per-env columns", () => {
    const two: FlowRegistry = {
      ...reg,
      envLabels: ["sandbox", "prod"],
      rows: [
        {
          flowKey: "landing aetna",
          healthPlan: "Aetna",
          joinStatus: "number-drift",
          envs: {
            sandbox: { rawFlowId: "landing_aetna", dialedNumbers: ["+1SB"], liveStatus: "live" },
            prod: { rawFlowId: "landing_aetna", dialedNumbers: ["+1PR"], liveStatus: "live" },
          },
        },
      ],
    };
    const md = toMarkdown(two);
    expect(md.split("\n")[0]).toBe(
      "| Health Plan | Join Status | Sandbox Flow | Sandbox Numbers | Sandbox HOO | Sandbox Status | Prod Flow | Prod Numbers | Prod HOO | Prod Status |",
    );
    expect(md.split("\n")[2]).toBe(
      "| Aetna | number-drift | landing_aetna | +1SB |  | live | landing_aetna | +1PR |  | live |",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- flowRegistryExport`
Expected: FAIL — `Cannot find module './flowRegistryExport'`.

- [ ] **Step 3: Write the exporters**

Create `src/utils/flowRegistryExport.ts`:

```ts
// src/utils/flowRegistryExport.ts
//
// Pure exporters for a FlowRegistry → Markdown / CSV / JSON. No DOM access (the
// download wiring lives in the panel) so these stay unit-testable. All three
// render from the same registry, so they reflect live AWS state at build time.

import Papa from "papaparse";
import type { FlowRegistry, FlowRow } from "./flowRegistry";

function cap(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Flatten one row into an ordered column → value map for tabular exports. */
function flatRow(reg: FlowRegistry, row: FlowRow): Record<string, string> {
  const out: Record<string, string> = { "Health Plan": row.healthPlan ?? "" };
  if (reg.envLabels.length > 1) out["Join Status"] = row.joinStatus;
  for (const label of reg.envLabels) {
    const e = row.envs[label];
    const p = cap(label);
    out[`${p} Flow`] = e?.rawFlowId ?? "";
    out[`${p} Numbers`] = e ? e.dialedNumbers.join("; ") : "";
    out[`${p} HOO`] = e?.hooName ?? e?.hooArn ?? "";
    out[`${p} Status`] = e ? e.liveStatus : "—";
  }
  return out;
}

/** Stable column order, derived from a representative flat row. */
function columns(reg: FlowRegistry): string[] {
  const out: string[] = ["Health Plan"];
  if (reg.envLabels.length > 1) out.push("Join Status");
  for (const label of reg.envLabels) {
    const p = cap(label);
    out.push(`${p} Flow`, `${p} Numbers`, `${p} HOO`, `${p} Status`);
  }
  return out;
}

export function toMarkdown(reg: FlowRegistry): string {
  const cols = columns(reg);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  if (reg.rows.length === 0) return [header, sep].join("\n");
  const body = reg.rows.map((r) => {
    const fr = flatRow(reg, r);
    return `| ${cols.map((c) => fr[c] ?? "").join(" | ")} |`;
  });
  return [header, sep, ...body].join("\n");
}

export function toCsv(reg: FlowRegistry): string {
  const cols = columns(reg);
  return Papa.unparse({ fields: cols, data: reg.rows.map((r) => {
    const fr = flatRow(reg, r);
    return cols.map((c) => fr[c] ?? "");
  }) });
}

export function toJson(reg: FlowRegistry): string {
  return JSON.stringify(
    {
      generatedAt: reg.generatedAt.toISOString(),
      envLabels: reg.envLabels,
      drift: reg.drift,
      rows: reg.rows.map((r) => ({
        flowKey: r.flowKey,
        healthPlan: r.healthPlan ?? null,
        joinStatus: r.joinStatus,
        envs: r.envs,
      })),
    },
    null,
    2,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- flowRegistryExport`
Expected: PASS (4 tests). If the CSV/MD header strings differ, reconcile by adjusting the test's expected strings to the real output ONLY if the difference is cosmetic whitespace from papaparse; otherwise fix the exporter.

- [ ] **Step 5: Commit**

```bash
git add src/utils/flowRegistryExport.ts src/utils/flowRegistryExport.test.ts
git commit -m "feat: flow registry MD/CSV/JSON exporters"
```

---

## Task 4: `renameFlow` planner + executor

**Files:**
- Modify: `src/utils/ddbScan.ts`
- Test: `src/utils/ddbScan.test.ts`

- [ ] **Step 1: Write the failing planner test**

Append to `src/utils/ddbScan.test.ts`:

```ts
import { planRenameFlow } from "./ddbScan";

describe("planRenameFlow", () => {
  it("re-keys step rows to the new flow id, repoints METs, and deletes old steps in order", () => {
    const stepRows = [
      { flow_id: "Old_Flow", step_id: "start", action_type: "START" },
      { flow_id: "Old_Flow", step_id: "s1", action_type: "PLAY" },
    ];
    const metas = [
      { dialedNumber: "+1800AAA", targetFlowId: "Old_Flow", hooArn: "arn:hoo" },
      { dialedNumber: "+1800BBB", targetFlowId: "Old_Flow" },
      { dialedNumber: "+1800CCC", targetFlowId: "Other_Flow" }, // must be ignored
    ];

    const plan = planRenameFlow("Old_Flow", "New_Flow", stepRows, metas);

    // 1) step rows copied under the new flow id (other fields preserved)
    expect(plan.stepPuts).toEqual([
      { flow_id: "New_Flow", step_id: "start", action_type: "START" },
      { flow_id: "New_Flow", step_id: "s1", action_type: "PLAY" },
    ]);

    // 2) only METs pointing at the old flow are repointed (PK = dialed_number unchanged)
    expect(plan.metaPuts).toEqual([
      { flow_id: "+1800AAA", step_id: "META", target_flow_id: "New_Flow", hoo_arn: "arn:hoo" },
      { flow_id: "+1800BBB", step_id: "META", target_flow_id: "New_Flow" },
    ]);

    // 3) old step rows deleted (by the original key)
    expect(plan.stepDeletes).toEqual([
      { flow_id: "Old_Flow", step_id: "start" },
      { flow_id: "Old_Flow", step_id: "s1" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ddbScan`
Expected: FAIL — `planRenameFlow is not exported` / not defined.

- [ ] **Step 3: Implement planner + executor**

In `src/utils/ddbScan.ts`, after `editFlowMeta` (around line 256), add:

```ts
/** The ordered DynamoDB operations a flow rename performs. */
export interface RenameFlowPlan {
  /** Step rows re-keyed under the new flow id (write first). */
  stepPuts: Record<string, any>[];
  /** META rows repointed to the new target (PK = dialed_number unchanged). */
  metaPuts: Record<string, any>[];
  /** Old step-row keys to delete last. */
  stepDeletes: { flow_id: string; step_id: string }[];
}

/**
 * Pure: build the rename cascade. `target_flow_id` is the partition key for
 * every step row, so a rename copies the step rows under the new id, repoints
 * each META that targets the old id, and deletes the old step rows. Returned as
 * three ordered groups so the executor can apply them crash-safely.
 */
export function planRenameFlow(
  oldFlowId: string,
  newFlowId: string,
  stepRows: any[],
  metas: DdbFlowMeta[],
): RenameFlowPlan {
  const stepPuts = stepRows.map((r) => ({ ...r, flow_id: newFlowId }));
  const stepDeletes = stepRows.map((r) => ({ flow_id: oldFlowId, step_id: r.step_id }));
  const metaPuts = metas
    .filter((m) => m.targetFlowId === oldFlowId)
    .map((m) => metaToRow({ ...m, targetFlowId: newFlowId }));
  return { stepPuts, metaPuts, stepDeletes };
}

/**
 * Rename a flow (its target_flow_id). Crash-safe order: 1) copy step rows under
 * the new id, 2) repoint METs, 3) delete old step rows. A failure after step 2
 * leaves the flow fully loadable under the new id; the worst case is orphan old
 * step rows (recoverable), never a flow that loads to nothing. Rejects if the
 * target id already has rows (collision).
 */
export async function renameFlow(
  creds: AwsCredentials,
  oldFlowId: string,
  newFlowId: string,
  metas: DdbFlowMeta[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  const target = newFlowId.trim();
  if (!target) throw new Error("New flow id is required.");
  if (target === oldFlowId) return;
  const ddb = ddbDocClient(creds);

  // Collision guard — the target id must not already exist.
  const existing = await ddb.send(new QueryCommand({
    TableName: FLOW_TABLE,
    KeyConditionExpression: "flow_id = :f",
    ExpressionAttributeValues: { ":f": target },
    Limit: 1,
  }));
  if ((existing.Items?.length ?? 0) > 0) {
    throw new Error(`A flow named "${target}" already exists.`);
  }

  // Enumerate the old flow's step rows (skip any META under the flow id).
  const stepRows: any[] = [];
  let lastKey: any;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: FLOW_TABLE,
      KeyConditionExpression: "flow_id = :f",
      ExpressionAttributeValues: { ":f": oldFlowId },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const it of resp.Items ?? []) if (it.step_id !== "META") stepRows.push(it);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  const plan = planRenameFlow(oldFlowId, target, stepRows, metas);

  let i = 0;
  for (const item of plan.stepPuts) {
    onProgress?.(`Copying step ${++i}/${plan.stepPuts.length}…`);
    await ddb.send(new PutCommand({ TableName: FLOW_TABLE, Item: item }));
  }
  for (const item of plan.metaPuts) {
    onProgress?.(`Repointing ${item.flow_id}…`);
    await ddb.send(new PutCommand({ TableName: FLOW_TABLE, Item: item }));
  }
  for (const key of plan.stepDeletes) {
    onProgress?.(`Removing old ${key.step_id}…`);
    await ddb.send(new DeleteCommand({ TableName: FLOW_TABLE, Key: key }));
  }
}
```

Note: `QueryCommand`, `PutCommand`, `DeleteCommand` are already imported at the top of `ddbScan.ts` (line 7). No new imports needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ddbScan`
Expected: PASS (existing `groupDdbRows`/`metaToRow` tests + the new `planRenameFlow` test).

- [ ] **Step 5: Commit**

```bash
git add src/utils/ddbScan.ts src/utils/ddbScan.test.ts
git commit -m "feat: crash-safe renameFlow cascade + pure planner"
```

---

## Task 5: Relabel the tab + render the registry table

**Files:**
- Modify: `src/components/AccountPanel.tsx`

This task replaces the `DdbFlowsPanel` list render with the consolidated registry table while keeping the existing `handleLoadFlow` / `handlePruneSteps` / `handleDeleteFlow` / `editMeta` handlers reachable. No unit tests (React render); verified via `npm run build` + `npm run lint` + manual smoke.

- [ ] **Step 1: Add imports for the registry + exporters**

At the top of `src/components/AccountPanel.tsx`, add to the existing import block:

```ts
import { buildFlowRegistry, type FlowRegistry, type FlowRow } from "../utils/flowRegistry";
import { toMarkdown, toCsv, toJson } from "../utils/flowRegistryExport";
import { renameFlow } from "../utils/ddbScan";
```

(`renameFlow` joins the existing `ddbScan` imports — merge it into that import statement rather than duplicating the module specifier.)

Also add `useMemo` to the existing React import (line 9):

```ts
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
```

- [ ] **Step 2: Relabel the tab in the sidebar nav + content header**

In the sidebar nav array (around line 1912-1916), change:

```ts
              ["ddb", "DynamoDB Flows"],
```

to:

```ts
              ["ddb", "Flows Registry"],
```

In the content header (around line 1998), change:

```tsx
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)", margin: 0 }}>DynamoDB Flows</h2>
                  <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    {FLOW_TABLE} · all META rows + queue references
                  </span>
```

to:

```tsx
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-0)", margin: 0 }}>Flows Registry</h2>
                  <span style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                    {FLOW_TABLE} · consolidated flow table · export MD/CSV/JSON
                  </span>
```

- [ ] **Step 3: Add a module-scope download helper**

Near the top of `src/components/AccountPanel.tsx` (after the imports, before the first component), add:

```ts
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
```

- [ ] **Step 4: Build the registry inside `DdbFlowsPanel` and add export buttons**

Inside `DdbFlowsPanel` (starts line 1340), after the existing `editMeta`/`savingMeta` state (around line 1402) and before `handleLoadFlow`, add the registry memo + rename state + export handlers:

```ts
  const registry: FlowRegistry | null = useMemo(
    () => (ddb ? buildFlowRegistry([{ label: "sandbox", ddb, hooNames: hooNames ?? new Map() }]) : null),
    [ddb, hooNames],
  );

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
  const exportMd = () => registry && downloadText(`flows-registry-${stamp()}.md`, toMarkdown(registry), "text/markdown");
  const exportCsvFile = () => registry && downloadText(`flows-registry-${stamp()}.csv`, toCsv(registry), "text/csv");
  const exportJsonFile = () => registry && downloadText(`flows-registry-${stamp()}.json`, toJson(registry), "application/json");
```

- [ ] **Step 5: Render the consolidated table**

Replace the existing flow-list render in `DdbFlowsPanel` (the section after the `if (!ddb && !loading)` empty state, which currently maps `ddb.flowDefs` into expandable rows) with a consolidated table driven by `registry.rows`. Locate the existing `ddb.flowDefs.filter(...)` / `.map(...)` render block and replace it with:

```tsx
      {/* Export bar */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, marginBottom: 6 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter flows…"
          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
        />
        <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={!registry} onClick={exportMd}>⬇ MD</button>
        <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={!registry} onClick={exportCsvFile}>⬇ CSV</button>
        <button className="btn btn-ghost" style={{ fontSize: 10 }} disabled={!registry} onClick={exportJsonFile}>⬇ JSON</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-3)", ...MONO }}>
              <th style={{ padding: "4px 6px" }}>Health Plan</th>
              <th style={{ padding: "4px 6px" }}>Flow</th>
              <th style={{ padding: "4px 6px" }}>Number(s)</th>
              <th style={{ padding: "4px 6px" }}>HOO</th>
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
                return (
                  (r.healthPlan ?? "").toLowerCase().includes(f) ||
                  (e?.rawFlowId ?? "").toLowerCase().includes(f) ||
                  (e?.dialedNumbers ?? []).some((n) => n.includes(f))
                );
              })
              .map((row: FlowRow) => {
                const e = row.envs.sandbox;
                const def = ddb!.flowDefs.find((d) => d.targetFlowId === e?.rawFlowId);
                const busy = loadingFlow === e?.rawFlowId || deletingFlow === e?.rawFlowId
                  || pruningFlow === e?.rawFlowId || renaming;
                return (
                  <tr key={row.flowKey} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 6px" }}>{row.healthPlan ?? "—"}</td>
                    <td style={{ padding: "4px 6px", ...MONO }}>{e?.rawFlowId}</td>
                    <td style={{ padding: "4px 6px", ...MONO }}>
                      {e && e.dialedNumbers.length ? e.dialedNumbers.join(", ") : <span style={{ color: "var(--text-3)" }}>—</span>}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{e?.hooName ?? e?.hooArn ?? "—"}</td>
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
                          <button className="btn btn-ghost" style={{ fontSize: 9, padding: "1px 6px", height: 20 }}
                            disabled={busy || !def.metas.length}
                            onClick={() => def.metas[0] && setEditMeta({ original: def.metas[0], draft: { ...def.metas[0] } })}>edit META</button>
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
```

If the existing render contained a per-flow expansion panel (`expandedFlow`) you no longer reference, remove it and its `expandedFlow`/`setExpandedFlow` state to avoid unused-variable lint errors. Keep `editMeta`/`saveMeta` (still used by "edit META") and `loadErr` (still rendered).

- [ ] **Step 6: Add the rename inline editor**

Where the panel renders its other modals/inline editors (near the `editMeta` editor block), add a rename prompt. If the existing `editMeta` editor is a small inline `<div>`, mirror it. Minimal version — add just below the export bar:

```tsx
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
```

- [ ] **Step 7: Build + lint**

Run: `npm run build`
Expected: `tsc -b` passes (no type errors) and `vite build` succeeds.

Run: `npm run lint`
Expected: no errors (warnings about pre-existing issues are acceptable; fix any new unused-variable errors from removed list code).

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all suites PASS (registry, exporters, ddbScan, and the pre-existing suites).

- [ ] **Step 9: Manual smoke test**

Run: `npm run dev`, open the app, go to the Account panel → "Flows Registry" tab. With AWS connected and a DynamoDB scan complete, confirm: the table lists flows with health plan / flow / number / HOO name / live-vs-not-yet; "edit META", "load", "prune", "delete" still work; "rename" prompts, confirms, runs, and the table refreshes; "⬇ MD/CSV/JSON" each download a dated file whose contents match the table.

Per superpowers:verification-before-completion, do not check this step until you have observed each behaviour, not just built the code.

- [ ] **Step 10: Commit**

```bash
git add src/components/AccountPanel.tsx
git commit -m "feat: evolve DynamoDB Flows tab into the Flows Registry table"
```

---

## Phase 2 (separate plan — not in scope here)

When Phase 1 is merged, the next plan adds:
- `ReadOnlyAwsCredentials` type; every write fn (`editFlowMeta`, `renameFlow`, `deleteFlowFromDdb`, `deleteSteps`, Connect deletes) refuses it at compile time (the prod-write-safety invariant).
- A second (prod) SSO credential context + per-account scan cache in `ddbStore`.
- Feed `buildFlowRegistry([sandboxEnv, prodEnv])` → side-by-side columns + the drift headline (counts already computed and tested here).
- Prod columns render view-only (no edit affordances).

The reducer, exporters (already multi-env), and `renameFlow` need no rewrite.
```
