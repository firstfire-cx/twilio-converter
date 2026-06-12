# Flows Registry — Edit Enhancements Design

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan
**Builds on:** `docs/superpowers/specs/2026-06-11-flows-registry-design.md` (Phase 1, merged)

## Problem

The Flows Registry table (the evolved "Flows Registry" tab) shows each flow's
health plan, flow name, number(s), HOO, and live/not-yet status, and exports to
MD/CSV/JSON. Three gaps remain for keeping the operational picture correct from
the table:

1. **HOO is display-only** — you can see the resolved HOO name but can't change
   which HOO a flow uses without leaving the table.
2. **Queues aren't shown** — a flow's SkillWhisper queues (already scanned into
   `def.queues`) don't appear, so you can't see what a flow routes to.
3. **Plan name can't be set** — the "Health Plan" column is derived from the META
   `description` and is read-only; there's no way to name a plan, and not-yet-live
   flows (no phone number, so no META row) have nowhere to store one.

## Goals

- **HOO dropdown** — change a flow's Hours of Operation inline, from the list of
  the instance's HOOs.
- **Queues column** — a read-only column listing each flow's SkillWhisper queue
  name(s).
- **Editable plan name** — set/edit the plan name inline, including for
  not-yet-live flows.

## Core principle: one uniform editing rule

Both editable fields (plan name, HOO) follow the same rule:

- **Flow has a META row (numbered)** → write to **DynamoDB** (the flow's META
  row(s)). Durable, shared across machines, authoritative.
- **Flow has no META row (not-yet-live)** → write to a **browser-local
  annotations store**, keyed by flow name. Documentation-only.

The reducer prefers the DynamoDB value and falls back to the local annotation,
so the table and exports show a value either way. In practice a flow's META rows
are one-per-number, so the DynamoDB write is usually a single row.

This keeps live routing config authoritative in AWS while letting the registry
double as a planning sheet for flows that don't exist in Connect yet.

## Architecture

### Data sources (mostly already present)

- `DdbFlow.queues` — `{ skillWhisper, queueSkill? }[]`, already produced by
  `groupDdbRows`. Feeds the Queues column (SkillWhisper names).
- `hooNames` — the `Map<hooId, name>` already built in `AccountPanel` from
  `ListHoursOfOperations`. Populates the HOO dropdown's labels.
- **New data need:** the dropdown must *write* a real `hoo_arn`, but `hooNames`
  only keeps id→name. Extend the existing `ListHoursOfOperations` fetch to also
  capture each HOO's `Arn` (the summary already includes it) into a parallel
  `Map<hooId, arn>` (or widen to `Map<hooId, { name, arn }>`).

### Local annotations store (new)

`src/stores/flowAnnotations.ts` — a thin wrapper over
`localStorage["ivr_flow_annotations"]`:

```
type FlowAnnotation = { healthPlan?: string; hooId?: string };
type FlowAnnotations = Record<string /* flowName */, FlowAnnotation>;

getAnnotations(): FlowAnnotations
getAnnotation(flowName): FlowAnnotation | undefined
setAnnotation(flowName, patch: Partial<FlowAnnotation>): void  // merge + persist
```

Keyed by the raw flow name (`targetFlowId`). Pure get/set with JSON
serialization; unit-tested with a mocked `localStorage`.

### Auth-hook fix (enables durable annotations)

`useAwsCredentials.ts` `loadFromStorage()` currently calls `localStorage.clear()`
on hourly credential expiry, which would wipe the annotations. Change it to clear
only the credential keys — reuse the existing `clearStorage()` (which removes
`STORAGE_KEY` + `EXPIRY_KEY`) instead of `localStorage.clear()`. This preserves
`ivr_flow_annotations` (and is arguably a latent-bug fix). No other auth behavior
changes.

### Reducer changes (`flowRegistry.ts`)

- `EnvFlowState` gains `queues: string[]` — the flow's SkillWhisper names (from
  `def.queues`), for the new column.
- `EnvFlowState` gains `hooId?: string` — the resolved HOO id used as the HOO
  dropdown's currently-selected value: `hooIdFromArn(hooArn)` for a numbered flow,
  or `annotation.hooId` for a not-yet-live flow. (`hooArn`/`hooName` stay as they
  are for display/export.)
- `EnvScan` gains an optional `annotations?: Map<string, FlowAnnotation>`.
- `buildFlowRegistry` merges annotations as a fallback:
  - `healthPlan` = META `description` (existing logic) **??** annotation.healthPlan.
  - HOO: when the flow has no `hooArn` from DDB, use `annotation.hooId` to set
    `hooId` and resolve `hooName` via the env's `hooNames`. When DDB has an
    `hooArn`, it wins and `hooId` comes from it.
- Annotations are sandbox/local only; the merge is per-env and leaves the
  cross-env join logic untouched.

### Write helper (`ddbScan.ts`)

`setFlowMetaFields(creds, flow, patch: { description?, hooArn? }, onProgress?)` —
updates the given field(s) on **every** META row of a flow (PK = dialed_number
unchanged, so a plain Put per META). Cleaner than looping `editFlowMeta` (which
also handles dialed-number PK changes we don't need here). Pure planner +
executor split mirrors `renameFlow`:

- `planSetFlowMetaFields(metas, patch)` (pure) → the list of updated META rows to
  Put. Unit-tested.
- `setFlowMetaFields(...)` (executor) → Puts them.

Not-yet-live edits never call this — they go to the local store.

### Exporter changes (`flowRegistryExport.ts`)

Add a `<Env> Queues` column (semicolon-joined SkillWhisper names) to the flat-row
projection used by MD/CSV. Plan name (Health Plan) and HOO already flow through.
Update the snapshot tests.

### UI changes (`AccountPanel.tsx`, the registry table)

- **Health Plan cell** → inline-editable: click to reveal an input; on save,
  route per the uniform rule (DDB `setFlowMetaFields({ description })` for
  numbered, `setAnnotation(flowName, { healthPlan })` for not-yet-live).
- **HOO cell** → a `<select>` of the instance's HOOs (from `hooNames`), current
  value preselected; on change, route per the uniform rule
  (`setFlowMetaFields({ hooArn })` using the id→arn map, or
  `setAnnotation(flowName, { hooId })`).
- **Queues** → new read-only column, comma-joined SkillWhisper names.
- After a **DDB** write: re-scan (existing `onScan()`); after a **local** write:
  update local annotations state so the memoized registry recomputes.
- The registry `useMemo` gains the annotations map (and id→arn map) as inputs.

## Testing

Unit tests (pure, repo convention):

- `flowRegistry`: `queues` populated on `EnvFlowState`; annotation fallback for
  `healthPlan` and for HOO on a not-yet-live flow; DDB value still wins when both
  present.
- `flowAnnotations`: get/set/merge round-trip against a mocked `localStorage`.
- `planSetFlowMetaFields`: updates description/hooArn across all META rows,
  leaves other fields intact.
- `flowRegistryExport`: Queues column appears in MD/CSV snapshots.

UI (editable cells, dropdown, column) verified via `npm run build` + `npm run
lint` + the user's live smoke test (AWS-connected) — consistent with the repo's
"pure functions are unit-tested; UI/network is not" convention.

## Non-goals / out of scope (YAGNI)

- **Auto-migrating** a local annotation into a META when a not-yet-live flow
  later gets a number. The reducer simply prefers the new META `description`; the
  stale local entry sits unused (harmless).
- Editing prod or any dual-account behavior — still Phase 2 of the base design.
- Storing not-yet-live metadata in DynamoDB (a flow-level record) — explicitly
  declined in favor of the local store for documentation-only data.
