# Flows Registry Edit Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Flows Registry table's Plan name and HOO editable inline (DynamoDB for numbered flows, browser-local for not-yet-live ones) and add a read-only Queues column.

**Architecture:** A new `flowAnnotations` localStorage store holds documentation-only plan name / HOO for flows that have no DynamoDB META row. The pure reducer merges these annotations as a fallback and surfaces `queues` + a resolved `hooId`. A new `setFlowMetaFields` write helper updates a numbered flow's META row(s). The registry table gets an inline-editable Health Plan cell, a HOO `<select>`, and a Queues column. The auth hook's hourly `localStorage.clear()` is narrowed so annotations survive.

**Tech Stack:** React 19 + TypeScript, Vitest, AWS SDK v3 (`@aws-sdk/lib-dynamodb`, `@aws-sdk/client-connect`), zustand, papaparse.

**Spec:** `docs/superpowers/specs/2026-06-12-flows-registry-edit-enhancements-design.md`. Builds on the merged Flows Registry Phase 1.

---

## File Structure

- **Create** `src/stores/flowAnnotations.ts` (+ `.test.ts`) — localStorage store for not-yet-live flow annotations (`{ healthPlan?, hooId? }` keyed by flow name).
- **Modify** `src/hooks/useAwsCredentials.ts` — narrow the expiry-path `localStorage.clear()` to only the credential keys so annotations survive.
- **Modify** `src/utils/flowRegistry.ts` (+ `.test.ts`) — `EnvFlowState` gains `queues?`/`hooId?`; `EnvScan` gains `annotations?`; reducer merges annotations + populates queues/hooId.
- **Modify** `src/utils/flowRegistryExport.ts` (+ `.test.ts`) — add a `<Env> Queues` column.
- **Modify** `src/utils/ddbScan.ts` (+ `.test.ts`) — `planSetFlowMetaFields` (pure) + `setFlowMetaFields` (executor).
- **Modify** `src/components/AccountPanel.tsx` — capture HOO ARNs; thread `hooArns`; editable Health Plan cell, HOO dropdown, Queues column, annotations state.

---

## Task 1: Local annotations store

**Files:**
- Create: `src/stores/flowAnnotations.ts`
- Test: `src/stores/flowAnnotations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/stores/flowAnnotations.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getAnnotation, setAnnotation, annotationsToMap } from "./flowAnnotations";

beforeEach(() => {
  let store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    key: () => null,
    length: 0,
  } as any;
});

describe("flowAnnotations", () => {
  it("stores and retrieves a plan name by flow name", () => {
    setAnnotation("landing_kp_co", { healthPlan: "KP Colorado" });
    expect(getAnnotation("landing_kp_co")).toEqual({ healthPlan: "KP Colorado" });
  });

  it("merges patches and exposes a map", () => {
    setAnnotation("F", { healthPlan: "Plan" });
    setAnnotation("F", { hooId: "hoo-1" });
    expect(getAnnotation("F")).toEqual({ healthPlan: "Plan", hooId: "hoo-1" });
    expect(annotationsToMap().get("F")).toEqual({ healthPlan: "Plan", hooId: "hoo-1" });
  });

  it("drops a field (and an emptied entry) when set to empty", () => {
    setAnnotation("F", { healthPlan: "Plan" });
    setAnnotation("F", { healthPlan: "" });
    expect(getAnnotation("F")).toBeUndefined();
  });

  it("returns an empty object when storage is corrupt", () => {
    globalThis.localStorage.setItem("ivr_flow_annotations", "{not json");
    expect(annotationsToMap().size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- flowAnnotations`
Expected: FAIL — `Cannot find module './flowAnnotations'`.

- [ ] **Step 3: Implement the store**

Create `src/stores/flowAnnotations.ts`:

```ts
// src/stores/flowAnnotations.ts
//
// Browser-local, documentation-only annotations for flows that have no DynamoDB
// META row (not-yet-live flows). Keyed by flow name (target_flow_id). Lives in
// localStorage so it survives refreshes; the auth hook's expiry path is narrowed
// so it is NOT wiped on credential expiry.

export interface FlowAnnotation {
  healthPlan?: string;
  hooId?: string;
}

export type FlowAnnotations = Record<string, FlowAnnotation>;

const KEY = "ivr_flow_annotations";

export function getAnnotations(): FlowAnnotations {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FlowAnnotations) : {};
  } catch {
    return {};
  }
}

export function getAnnotation(flowName: string): FlowAnnotation | undefined {
  return getAnnotations()[flowName];
}

/** Merge `patch` into the flow's annotation; empties drop the field (and the
 *  entry, once empty), so cleared values don't linger. */
export function setAnnotation(flowName: string, patch: Partial<FlowAnnotation>): void {
  const all = getAnnotations();
  const next: FlowAnnotation = { ...all[flowName], ...patch };
  if (!next.healthPlan) delete next.healthPlan;
  if (!next.hooId) delete next.hooId;
  if (Object.keys(next).length === 0) delete all[flowName];
  else all[flowName] = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full / unavailable — annotations are best-effort */
  }
}

export function annotationsToMap(): Map<string, FlowAnnotation> {
  return new Map(Object.entries(getAnnotations()));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- flowAnnotations`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/flowAnnotations.ts src/stores/flowAnnotations.test.ts
git commit -m "feat: browser-local flow annotations store"
```

---

## Task 2: Narrow the auth-hook storage clear

**Files:**
- Modify: `src/hooks/useAwsCredentials.ts`

The expiry path calls `localStorage.clear()`, which would wipe `ivr_flow_annotations`. Narrow it to the two credential keys (the existing `clearStorage()` already removes exactly those). No unit test — `loadFromStorage`/`clearStorage` aren't unit-tested in this repo; verified via build + the test suite.

- [ ] **Step 1: Make the change**

In `src/hooks/useAwsCredentials.ts`, in `loadFromStorage()`, replace:

```ts
    if (expiryStr && Date.now() > parseInt(expiryStr, 10)) {
      localStorage.clear();
      return null;
    }
```

with:

```ts
    if (expiryStr && Date.now() > parseInt(expiryStr, 10)) {
      // Only clear the credential keys — preserve local flow annotations etc.
      clearStorage();
      return null;
    }
```

(`clearStorage` is a hoisted function declaration later in the file, so it's callable here.)

- [ ] **Step 2: Verify the suite still passes + builds**

Run: `npm test`
Expected: all suites PASS (no behavior change to tested code).

Run: `npm run build`
Expected: 0 type errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAwsCredentials.ts
git commit -m "fix: don't wipe non-credential localStorage on session expiry"
```

---

## Task 3: Reducer — queues, hooId, annotation merge

**Files:**
- Modify: `src/utils/flowRegistry.ts`
- Test: `src/utils/flowRegistry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/utils/flowRegistry.test.ts` (the `flow`, `ddbState`, `sandbox`, `meta` helpers already exist at module scope):

```ts
describe("buildFlowRegistry — queues + annotations", () => {
  it("surfaces the flow's SkillWhisper queue names", () => {
    const reg = buildFlowRegistry([
      sandbox([
        flow({
          targetFlowId: "landing_aetna",
          queues: [{ skillWhisper: "Aetna-EN" }, { skillWhisper: "Aetna-SP", queueSkill: "9" }],
          metas: [meta({ dialedNumber: "+1A", targetFlowId: "landing_aetna" })],
        }),
      ]),
    ]);
    expect(reg.rows[0].envs.sandbox.queues).toEqual(["Aetna-EN", "Aetna-SP"]);
  });

  it("falls back to a local annotation for a not-yet-live flow's plan name + HOO", () => {
    const reg = buildFlowRegistry([
      {
        label: "sandbox",
        ddb: ddbState([flow({ targetFlowId: "landing_kp_co", metas: [] })]),
        hooNames: new Map([["hoo-1", "KP Hours"]]),
        annotations: new Map([["landing_kp_co", { healthPlan: "KP Colorado", hooId: "hoo-1" }]]),
      },
    ]);
    const r = reg.rows[0];
    expect(r.healthPlan).toBe("KP Colorado");
    expect(r.envs.sandbox.hooId).toBe("hoo-1");
    expect(r.envs.sandbox.hooName).toBe("KP Hours");
    expect(r.envs.sandbox.liveStatus).toBe("not-yet");
  });

  it("prefers the DynamoDB META description over a local annotation", () => {
    const reg = buildFlowRegistry([
      {
        label: "sandbox",
        ddb: ddbState([
          flow({
            targetFlowId: "landing_aetna",
            metas: [meta({ dialedNumber: "+1A", targetFlowId: "landing_aetna", description: "Aetna (DDB)" })],
          }),
        ]),
        hooNames: new Map(),
        annotations: new Map([["landing_aetna", { healthPlan: "Aetna (local)" }]]),
      },
    ]);
    expect(reg.rows[0].healthPlan).toBe("Aetna (DDB)");
  });

  it("resolves hooId from the ARN for a numbered flow", () => {
    const reg = buildFlowRegistry([
      sandbox(
        [
          flow({
            targetFlowId: "landing_aetna",
            hooArn: "arn:aws:connect:us-east-1:1:instance/x/operating-hours/hoo-9",
            metas: [meta({ dialedNumber: "+1A", targetFlowId: "landing_aetna" })],
          }),
        ],
        new Map([["hoo-9", "Aetna Hours"]]),
      ),
    ]);
    expect(reg.rows[0].envs.sandbox.hooId).toBe("hoo-9");
    expect(reg.rows[0].envs.sandbox.hooName).toBe("Aetna Hours");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- flowRegistry`
Expected: FAIL — `queues`/`hooId` undefined and `annotations` not honored.

- [ ] **Step 3: Update the types**

In `src/utils/flowRegistry.ts`, replace the `EnvScan` and `EnvFlowState` interfaces with:

```ts
export interface EnvScan {
  /** Display + join label, e.g. "sandbox" | "prod". */
  label: string;
  ddb: DdbState;
  /** HOO id → friendly name (from ListHoursOfOperations) for this env. */
  hooNames: Map<string, string>;
  /** Browser-local, documentation-only overrides for not-yet-live flows,
   *  keyed by flow name. */
  annotations?: Map<string, { healthPlan?: string; hooId?: string }>;
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
  hooId?: string;          // resolved HOO id (from arn or annotation) for the dropdown
  hooName?: string;
  instanceId?: string;
  description?: string;    // effective plan name: META description ?? local annotation
  queues?: string[];       // SkillWhisper names
  liveStatus: "live" | "not-yet";
}
```

- [ ] **Step 4: Update the per-def loop**

In `buildFlowRegistry`, replace the body of the inner `for (const def of env.ddb.flowDefs)` loop — specifically the lines from `const dialedNumbers = ...` through the `const state: EnvFlowState = { ... };` block — with:

```ts
      const annotation = env.annotations?.get(def.targetFlowId);
      const dialedNumbers = def.metas.map((m) => m.dialedNumber).filter(Boolean);
      const m0 = def.metas[0];
      const hooArn = def.hooArn;
      const hooId = hooArn ? hooIdFromArn(hooArn) : annotation?.hooId;
      const hooName = hooId ? env.hooNames.get(hooId) : undefined;

      const state: EnvFlowState = {
        rawFlowId: def.targetFlowId,
        dialedNumbers,
        hooArn,
        hooId,
        hooName,
        instanceId: def.instanceId,
        description: m0?.description ?? annotation?.healthPlan,
        queues: def.queues.map((q) => q.skillWhisper),
        liveStatus: dialedNumbers.length > 0 ? "live" : "not-yet",
      };
```

(The `healthPlan` row computation below is unchanged — it reads `envs.sandbox.description`, which now already includes the annotation fallback.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- flowRegistry`
Expected: PASS (the new block + all existing single-env/two-env/collision tests).

- [ ] **Step 6: Commit**

```bash
git add src/utils/flowRegistry.ts src/utils/flowRegistry.test.ts
git commit -m "feat: registry surfaces queues + hooId and merges local annotations"
```

---

## Task 4: Exporter — Queues column

**Files:**
- Modify: `src/utils/flowRegistryExport.ts`
- Test: `src/utils/flowRegistryExport.test.ts`

- [ ] **Step 1: Update the test for the new column**

In `src/utils/flowRegistryExport.test.ts`, the single-env fixture's `sandbox` EnvFlowState for "landing aetna" — add a `queues` field. Change that object to include `queues: ["Aetna-EN", "Aetna-SP"]` (add the line alongside `liveStatus: "live"`). Then update the three single-env expectations to include the Queues column **after HOO**:

```ts
  it("renders a Markdown table without a Join Status column", () => {
    const md = toMarkdown(reg);
    expect(md).toBe(
      [
        "| Health Plan | Sandbox Flow | Sandbox Numbers | Sandbox HOO | Sandbox Queues | Sandbox Status |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Aetna | landing_aetna | +18005551234 | Aetna Hours | Aetna-EN; Aetna-SP | live |",
        "|  | landing_kp_colorado |  |  |  | not-yet |",
      ].join("\n"),
    );
  });

  it("renders CSV with a header row + one row per flow", () => {
    const csv = toCsv(reg);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Health Plan,Sandbox Flow,Sandbox Numbers,Sandbox HOO,Sandbox Queues,Sandbox Status");
    expect(lines[1]).toBe("Aetna,landing_aetna,+18005551234,Aetna Hours,Aetna-EN; Aetna-SP,live");
    expect(lines).toHaveLength(3);
  });
```

And in the two-env test, update the expected header + row to include the per-env Queues column after each HOO:

```ts
    expect(md.split("\n")[0]).toBe(
      "| Health Plan | Join Status | Sandbox Flow | Sandbox Numbers | Sandbox HOO | Sandbox Queues | Sandbox Status | Prod Flow | Prod Numbers | Prod HOO | Prod Queues | Prod Status |",
    );
    expect(md.split("\n")[2]).toBe(
      "| Aetna | number-drift | landing_aetna | +1SB |  |  | live | landing_aetna | +1PR |  |  | live |",
    );
```

(The two-env fixture rows have no `queues`, so those cells are empty.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- flowRegistryExport`
Expected: FAIL — current output has no Queues column.

- [ ] **Step 3: Add the Queues column to the exporter**

In `src/utils/flowRegistryExport.ts`, in `flatRow`, add a Queues line after the HOO line:

```ts
    out[`${p} HOO`] = e?.hooName ?? e?.hooArn ?? "";
    out[`${p} Queues`] = e ? (e.queues ?? []).join("; ") : "";
    out[`${p} Status`] = e ? e.liveStatus : "—";
```

And in `columns`, add `${p} Queues` after `${p} HOO`:

```ts
    out.push(`${p} Flow`, `${p} Numbers`, `${p} HOO`, `${p} Queues`, `${p} Status`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- flowRegistryExport`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/flowRegistryExport.ts src/utils/flowRegistryExport.test.ts
git commit -m "feat: add Queues column to registry exports"
```

---

## Task 5: `setFlowMetaFields` write helper

**Files:**
- Modify: `src/utils/ddbScan.ts`
- Test: `src/utils/ddbScan.test.ts`

- [ ] **Step 1: Write the failing planner test**

Append to `src/utils/ddbScan.test.ts`:

```ts
import { planSetFlowMetaFields } from "./ddbScan";

describe("planSetFlowMetaFields", () => {
  it("updates the patched fields on every META row, preserving the rest", () => {
    const metas = [
      { dialedNumber: "+1A", targetFlowId: "F", hooArn: "old", description: "old-desc", startStep: "s" },
      { dialedNumber: "+1B", targetFlowId: "F", hooArn: "old" },
    ];
    const rows = planSetFlowMetaFields(metas, { description: "Aetna", hooArn: "new-arn" });
    expect(rows).toEqual([
      { flow_id: "+1A", step_id: "META", target_flow_id: "F", start_step: "s", hoo_arn: "new-arn", description: "Aetna" },
      { flow_id: "+1B", step_id: "META", target_flow_id: "F", hoo_arn: "new-arn", description: "Aetna" },
    ]);
  });

  it("only touches fields present in the patch", () => {
    const rows = planSetFlowMetaFields(
      [{ dialedNumber: "+1A", targetFlowId: "F", hooArn: "keep", description: "keep" }],
      { description: "New" },
    );
    expect(rows[0]).toEqual({ flow_id: "+1A", step_id: "META", target_flow_id: "F", hoo_arn: "keep", description: "New" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ddbScan`
Expected: FAIL — `planSetFlowMetaFields` not exported.

- [ ] **Step 3: Implement planner + executor**

In `src/utils/ddbScan.ts`, after the `renameFlow` function, add:

```ts
/**
 * Pure: build the META rows that set `patch`'s fields on every META of a flow.
 * Each row is a full META item (a Put replaces the whole item), so untouched
 * fields are preserved from the existing meta. Empty-string values clear a field
 * (metaToRow omits falsy optionals).
 */
export function planSetFlowMetaFields(
  metas: DdbFlowMeta[],
  patch: { description?: string; hooArn?: string },
): Record<string, any>[] {
  return metas.map((m) =>
    metaToRow({
      ...m,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.hooArn !== undefined ? { hooArn: patch.hooArn } : {}),
    }),
  );
}

/**
 * Set `patch`'s fields (description and/or hoo_arn) on every META row of a flow.
 * One plain Put per META (PK = dialed_number unchanged). Used by the registry's
 * inline plan-name / HOO edits for flows that have a phone number.
 */
export async function setFlowMetaFields(
  creds: AwsCredentials,
  flow: DdbFlow,
  patch: { description?: string; hooArn?: string },
  onProgress?: (msg: string) => void,
): Promise<void> {
  const ddb = ddbDocClient(creds);
  const rows = planSetFlowMetaFields(flow.metas, patch);
  let i = 0;
  for (const Item of rows) {
    onProgress?.(`Updating META ${++i}/${rows.length}…`);
    await ddb.send(new PutCommand({ TableName: FLOW_TABLE, Item }));
  }
}
```

(`PutCommand`, `metaToRow`, `FLOW_TABLE`, `DdbFlow`, `DdbFlowMeta`, `AwsCredentials`, `ddbDocClient` are already imported/defined in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ddbScan`
Expected: PASS (existing `groupDdbRows`/`metaToRow`/`planRenameFlow` tests + the new `planSetFlowMetaFields` tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/ddbScan.ts src/utils/ddbScan.test.ts
git commit -m "feat: setFlowMetaFields helper for inline registry edits"
```

---

## Task 6: UI — editable plan name, HOO dropdown, Queues column

**Files:**
- Modify: `src/components/AccountPanel.tsx`

No unit tests (React render). Verified via `npm run build` + `npm run lint` + the user's live smoke test.

- [ ] **Step 1: Add imports**

In `src/components/AccountPanel.tsx`:
- Merge `setFlowMetaFields` into the existing `../utils/ddbScan` import.
- Add: `import { annotationsToMap, setAnnotation, type FlowAnnotation } from "../stores/flowAnnotations";`

- [ ] **Step 2: Capture HOO ARNs in the AccountPanel effect**

Find the HOO effect (around line 1789-1808). Replace the `const [hooNames, ...]` declaration and the effect body so it builds an ARN map too. Replace:

```tsx
  // HOO id → name, so the Flows panel can resolve hoo_arn to a real HOO name.
  const [hooNames, setHooNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!credentials || !selectedInstanceId) { setHooNames(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const client = buildConnectClient(credentials);
        const m = new Map<string, string>();
        let next: string | undefined;
        do {
          const resp = await client.send(new ListHoursOfOperationsCommand({
            InstanceId: selectedInstanceId, ...(next ? { NextToken: next } : {}),
          }));
          for (const h of resp.HoursOfOperationSummaryList ?? []) if (h.Id) m.set(h.Id, h.Name ?? h.Id);
          next = resp.NextToken;
        } while (next);
        if (!cancelled) setHooNames(m);
      } catch { /* non-fatal — flow panel falls back to the raw id */ }
    })();
```

with:

```tsx
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
```

- [ ] **Step 3: Pass `hooArns` to the panel**

At the `<DdbFlowsPanel ... hooNames={hooNames} />` call site (around line 2012-2020), add the prop:

```tsx
                  hooNames={hooNames}
                  hooArns={hooArns}
```

- [ ] **Step 4: Add `hooArns` to the panel's props + type**

In the `DdbFlowsPanel` function signature/props (around line 1340-1357), add `hooArns` next to `hooNames`:

In the destructured params add `hooArns,` and in the props type add:

```tsx
  /** id → name for the instance's HOOs, to resolve hoo_arn to a real HOO name. */
  hooNames?: Map<string, string>;
  /** id → arn for the instance's HOOs, to write a selected HOO. */
  hooArns?: Map<string, string>;
```

- [ ] **Step 5: Add annotations state + edit handlers**

Inside `DdbFlowsPanel`, replace the existing `registry` useMemo (around line 1431-1434) with the annotations-aware version, and add the edit state/handlers right after it:

```tsx
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
```

- [ ] **Step 6: Add the Queues column header**

In the table `<thead>` (around line 1611-1618), add a Queues header between HOO and Status:

```tsx
              <th style={{ padding: "4px 6px" }}>HOO</th>
              <th style={{ padding: "4px 6px" }}>Queues</th>
              <th style={{ padding: "4px 6px" }}>Status</th>
```

- [ ] **Step 7: Make the Health Plan cell editable + include savingField in `busy`**

In the row `.map(...)`, update the `busy` line to include the saving state, and replace the Health Plan `<td>` (currently `<td style={{ padding: "4px 6px" }}>{row.healthPlan ?? "—"}</td>`).

Change `busy`:

```tsx
                const busy = loadingFlow === e?.rawFlowId || deletingFlow === e?.rawFlowId
                  || pruningFlow === e?.rawFlowId || renaming || savingField === e?.rawFlowId;
```

Replace the Health Plan `<td>`:

```tsx
                    <td style={{ padding: "4px 6px" }}>
                      {def && editingPlanFor === e?.rawFlowId ? (
                        <input
                          autoFocus
                          value={planDraft}
                          onChange={(ev) => setPlanDraft(ev.target.value)}
                          onBlur={() => savePlan(def)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") savePlan(def);
                            if (ev.key === "Escape") setEditingPlanFor(null);
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
```

- [ ] **Step 8: Replace the HOO cell with a dropdown + add the Queues cell**

Replace the HOO `<td>` (currently `<td style={{ padding: "4px 6px" }}>{e?.hooName ?? e?.hooArn ?? "—"}</td>`) with the dropdown, and add the Queues `<td>` immediately after it:

```tsx
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
```

- [ ] **Step 9: Build + lint + test**

Run: `npm run build`
Expected: `tsc -b` + `vite build` succeed, 0 type errors.

Run: `npm run lint`
Expected: no NEW error categories (pre-existing `no-explicit-any` pattern is acceptable; fix any new `no-unused-vars` your change introduces).

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 10: Manual smoke test**

Run `npm run dev`, open the Account panel → Flows Registry. With AWS connected and a scan done, confirm: the Queues column lists SkillWhisper names; the HOO cell is a dropdown that, when changed on a **numbered** flow, writes and the table refreshes; clicking the Health Plan cell edits it (numbered → persists to DDB after re-scan); for a **not-yet-live** flow, setting plan name + HOO persists locally and survives a page refresh; exports include the Queues column and the plan names. Per superpowers:verification-before-completion, observe each behavior before checking this off.

- [ ] **Step 11: Commit**

```bash
git add src/components/AccountPanel.tsx
git commit -m "feat: editable plan name + HOO dropdown + Queues column in registry"
```
