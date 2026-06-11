# Flows Registry — Design

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan
**Branch context:** `account-cleanup-tooling`

## Problem

Operational reference data — which IVR flows are live, the phone numbers routing
to them, their Hours-of-Operation ARNs, sandbox vs. prod state — is currently
kept in a hand-maintained spreadsheet. It drifts constantly because it is a
*manually copied projection* of data that already lives, structured and
queryable, in DynamoDB (`TwilioIVRFlows` META rows) and Amazon Connect (HOO
objects). Blanks in the sheet (e.g. missing Prod HOO ARNs, plans with a flow but
no number yet) are artifacts of manual upkeep, not of missing data.

**Principle: generate, don't maintain.** The registry reads live AWS state and
renders the table, so it cannot silently drift. Where reconciliation requires a
human decision (naming-convention drift between accounts), the tool surfaces the
mismatch and lets the user fix it in place.

## Goals

- A **Flows** table view in the Account panel that consolidates, per flow:
  health-plan label, flow name, dialed number(s), HOO ARN + resolved name,
  instance id, and live/not-yet status — for **sandbox and prod side-by-side**.
- **Drift detection** between sandbox and prod as a first-class output (the tool
  answers "how far apart are sandbox and prod?").
- **Inline editing on the sandbox account**: META fields (dialed number, HOO
  ARN, description) and **flow rename** (`target_flow_id`), so naming
  conventions can be reconciled directly from the table.
- **Exports** — Markdown, CSV, and JSON — generated from the same live state, so
  shareable docs are always current.

## Non-goals

- Editing prod in any way. Prod is **structurally read-only** (see Invariant).
- Building a manual-annotation subsystem. The "Outbound" column from the legacy
  spreadsheet (a queue caller-ID, not in the META schema, not needed) is
  **deferred** — no browser-local annotation store.
- Reconciling the prod scan against the prod deploy source (`srh-aws-connect`).
  That is a possible **Phase 3** (see Phasing).

## Invariant: prod credentials never flow into a write

This codebase's dominant feature is destructive — `deleteFlowFromDdb`,
`deleteSteps`, `editFlowMeta`, the new `renameFlow`, plus Connect queue/HOO
deletes. Adding a second (prod) credential context next to those is the main
risk in this work.

Prod read-only-ness is enforced **structurally, not by convention**:

- Prod credentials are carried as a distinct type — `ReadOnlyAwsCredentials`.
  Enforcement lives on **mutation function signatures**, not the shared client
  builder (`ddbDocClient` serves both reads and writes): every write function
  (`editFlowMeta`, `renameFlow`, `deleteFlowFromDdb`, `deleteSteps`, the Connect
  queue/HOO deletes) accepts only the writable `AwsCredentials` type and refuses
  `ReadOnlyAwsCredentials` at compile time. Read functions (`scanDdb`,
  `ListHoursOfOperations`) accept either.
- The registry view renders prod columns with **no edit affordances**.
- All mutations only ever accept the sandbox (writable) credential context.

The spec treats "prod creds cannot reach a write path" as a hard invariant that
must hold by construction, verified by the type signatures of the write
functions.

## Background — existing infrastructure reused

The plumbing largely exists; this feature mostly *composes* it:

- `src/utils/ddbScan.ts` — `scanDdb()` returns `DdbState` with `flowDefs` (every
  flow, **including flows with no META row = no number yet = "not yet live"**)
  and `flows` (META rows carrying `hooArn`, `instanceId`, `description`).
  Also `editFlowMeta()` (handles a changed dialed-number PK via put-new +
  delete-old), `loadFlowFromDdb()`, `deleteFlowFromDdb()`.
- `src/stores/ddbStore.ts` — zustand cache of the scan, already keyed by
  `accessKeyId:instance_id`. Extends naturally to a per-account map.
- `src/components/AccountPanel.tsx` — hosts `QueueBrowser` + `HooBrowser`. The
  `HooBrowser` already lists Connect HOOs via `ListHoursOfOperationsCommand`
  (ARN → name → id), which is exactly the ARN→name resolution the registry needs.
- `src/hooks/useAwsCredentials.ts` — SSO + manual creds (currently single
  context). NOTE: its expiry path calls `localStorage.clear()` hourly — a reason
  no derived/annotation data is stored in localStorage.
- `src/utils/csv.ts` — existing CSV helper, reused by the exporter.
- `src/utils/queueReconcile.ts` — existing fuzzy normalization for the
  queue duplicate matcher; the registry join reuses the same normalization idea.

## Architecture

A single **pure reducer** is the core, decoupled from the panel UI so it is
unit-testable and reusable (e.g. by `awsync-tool` consuming the JSON export):

```
buildFlowRegistry(envs: EnvScan[]): FlowRegistry

EnvScan = {
  label: "sandbox" | "prod",
  ddb: DdbState,                 // from scanDdb()
  hooNames: Map<string, string>, // hoo ARN/id -> friendly name, from Connect
}
```

It accepts **one or more** environment scans, so the *same function* powers
Phase 1 (single env) and Phase 2 (two envs) with no rewrite.

### Data model

```
FlowRegistry = {
  rows: FlowRow[],
  drift: DriftSummary,
  generatedAt: Date,
}

FlowRow = {
  flowKey: string,            // normalized join key
  healthPlan?: string,        // from META description (sandbox preferred, prod fallback)
  envs: {
    sandbox?: EnvFlowState,
    prod?: EnvFlowState,
  },
  joinStatus: "in-sync"        // present + name-identical in all scanned envs
            | "number-drift"   // present in both, different numbers/HOO
            | "name-fuzzy"     // joined only via fuzzy match (names differ)
            | "sandbox-only"
            | "prod-only",
}

EnvFlowState = {
  rawFlowId: string,          // the actual target_flow_id in that account
  dialedNumbers: string[],    // META dialed_number(s); empty = "not yet live"
  hooArn?: string,
  hooName?: string,           // resolved via hooNames
  instanceId?: string,
  description?: string,
  liveStatus: "live" | "not-yet", // has >=1 META = live; flow exists, no number = not-yet
}

DriftSummary = {
  inSync: number, numberDrift: number, nameFuzzy: number,
  sandboxOnly: number, prodOnly: number,
}
```

### Fuzzy join + drift

- Rows are the **union** of flow ids across all scanned envs.
- Join key = a **normalized** `target_flow_id` (case/`-`/`_`/space-insensitive),
  reusing the normalization approach already used for queues.
- Exact match → `in-sync` (or `number-drift` if names match but numbers/HOO
  differ). Near-match via normalization → joined but flagged `name-fuzzy`, with
  both `rawFlowId`s preserved so the user sees `landing_carefirst` vs
  `landing_carefirst_v2`. No match in an env → `sandbox-only` / `prod-only`.
- Drift is **expected and structural**: prod flow names come from a deploy
  pipeline (`srh-aws-connect`) while sandbox is edited live in-app. The drift
  report is a primary output, not an edge case.

## UI — "Flows" tab in AccountPanel

A third browser alongside Queues / HOO. Columns mirror the legacy spreadsheet:

| Health Plan | Flow | Sandbox # | Prod # | Sandbox HOO | Prod HOO | Status |

- Filter tabs by join status (all / in-sync / drifted / sandbox-only /
  prod-only), mirroring the existing `QueueBrowser` filter-tab pattern.
- "not-yet-live" (flow exists, no number) rendered distinctly from a real number.
- **Editing affordances appear only on sandbox columns.** Prod columns are
  display-only.

### Inline editing (sandbox account only)

Two write paths, both confirmed and only ever passed the sandbox context:

1. **META field edit** — dialed number, HOO ARN, description. Reuses existing
   `editFlowMeta()` (already handles dialed-number PK change via put-new +
   delete-old).

2. **Flow rename** (`target_flow_id`) — NEW operation `renameFlow(creds,
   oldFlowId, newFlowId)`. `target_flow_id` is the partition key for every step
   row, so a rename is a cascade:
   - **Guard:** reject if `newFlowId` already exists (collision).
   - Plan (pure, testable): enumerate step rows under `flow_id = oldFlowId` and
     META rows with `target_flow_id = oldFlowId`.
   - **Execution order chosen for crash-safety:**
     1. Put all step rows under `flow_id = newFlowId` (copy).
     2. Update each affected META's `target_flow_id → newFlowId` (PK =
        dialed_number unchanged, so a plain Put).
     3. Delete the old step rows under `flow_id = oldFlowId`.
     A failure after step 2 leaves the flow fully loadable under `newFlowId`;
     worst case is orphan old step rows, which are recoverable/cleanable — never
     a flow that loads to nothing.
   - Confirm dialog + progress callback (matches existing bulk-op UX).

After any successful edit, the sandbox scan in the store is patched/re-scanned
and the registry recomputed.

## Exports — first-class in Phase 1

The in-app live view only helps people who open the app and complete dual-SSO
login. The **export is what actually addresses "docs drift"**, so it ships in
Phase 1, not later. From the Flows tab:

- **Download Markdown** — committable, diffable table.
- **Download CSV** — re-imports into the existing spreadsheet (reuses `csv.ts`).
- **Download JSON** (`manifest.json`) — canonical machine form; a stable
  interface for downstream consumers like `awsync-tool`.

All three are rendered from the same `FlowRegistry`, so they reflect live AWS
state at generation time.

## Dual-account (Phase 2)

- Add a **second credential context** for prod, typed `ReadOnlyAwsCredentials`
  (see Invariant). Acquired via the same SSO flow against the prod account/role.
- Extend `ddbStore` to cache **per-account** scans (already keyed by
  `accessKeyId:instance_id`; widen to a small keyed map).
- Both scans + each account's Connect HOO name map feed the same
  `buildFlowRegistry` → side-by-side columns + drift summary.

## Phasing

- **Phase 1 — single account (sandbox), editable.** `buildFlowRegistry` (1 env),
  Flows tab with META-edit + flow-rename, MD/CSV/JSON export, unit tests. Ships
  standalone value on the account already logged into.
- **Phase 2 — prod read-only side-by-side.** Second read-only credential
  context + per-account scan cache → two-env registry, drift report, prod
  columns view-only.
- **Phase 3 (noted, out of current scope) — reconcile against deploy source.**
  The authoritative prod definition is `srh-aws-connect`, not the live prod
  scan. A later phase could diff the prod scan against that repo's declared
  flows to distinguish "renamed in deploy config" from "genuinely orphaned."
  Requires that repo to be in an allowed working directory.

## Testing

Unit tests target the pure pieces (matching the repo's `groupDdbRows` /
`queueReconcile` test pattern), with synthetic `DdbState`s — no live AWS:

- `buildFlowRegistry`: exact join, `number-drift`, `name-fuzzy`, `sandbox-only`,
  `prod-only`, `not-yet-live` (flow with no META), HOO name resolution, multi-
  META flows, and `DriftSummary` counts.
- `renameFlow` planner: correct step-row + META enumeration, collision guard,
  and the crash-safe operation ordering.
- Exporters: Markdown / CSV / JSON snapshot tests from a fixed registry.

## Open questions / future

- "Outbound" column source (queue caller-ID?) — deferred; revisit only if needed.
- Phase 3 reconciliation against `srh-aws-connect` / handoff to `awsync-tool`.
