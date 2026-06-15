# Flow seed export + sandbox↔prod parity — design

**Date:** 2026-06-15 · **Owner:** Carter · **Status:** Draft for review

## 1. Goal

Make twilio-converter able to drive **sandbox→prod parity** for the custom Twilio IVR
engine: every flow that exists in sandbox should exist in prod with the **same flow names,
step structure, content, and meta**, differing **only** in account-specific values that are
remapped per environment.

Scope is deliberately narrowed (Phase 1) to two concrete capabilities:

1. **Deploy a new flow to prod** — author/select a flow in the converter and produce the
   artifacts that make it reach prod through the existing seed pipeline.
2. **Update names of existing flows and queues** — propagate both *cosmetic* label changes
   (plan/display names) **and** *identity* re-keys (`target_flow_id` / `SkillWhisper`) to prod,
   including pruning the stale rows an identity rename leaves behind.

**Explicitly out of scope (not Phase 1):** a live prod-scan drift dashboard, and any path
that writes prod DynamoDB directly. Prod changes ship as **git-committed artifacts deployed
by Jenkins**, never by the converter writing prod.

### Relationship to awsync-tool

This is the domain-specific instance of awsync-tool's general model: classify each field as
**static** (same across environments) vs **dynamic** (varies per env, remapped), and sync via
a committed mapping table (awsync's `mapping.json` / `SyncTable`). Our `flow_registry.json`
(below) plays that exact role, scoped to the IVR row schema. Per
`twilio-converter/AGENTS.md` this is "a concrete case, not a direct integration today" — we
shape the manifest so it *could* feed awsync later, but build no live integration now.

## 2. Background — the current pipeline (unchanged interface)

Producer→consumer interface is the **frozen contract**
(`aws-sync-system/contracts/twilio-ivr-flow.contract.md`). The converter writes DynamoDB rows
into the **sandbox** `TwilioIVRFlows` table; prod is updated via a committed, diffable seed
pipeline under `TwilioIVREngine/seed/`:

```
sandbox DDB ──export_flows.py──▶ TwilioIVRFlows.seed.jsonl
                                          │ transform_flows.py (remap account vars, fail-fast)
                                          ▼
                                 TwilioIVRFlows.prod.jsonl ──Jenkins/CDK seeder──▶ prod DDB
```

This design does **not** change the frozen row schema. It changes (a) **where** seed rows can
come from (converter can emit them for *selected* flows, not only a full-table `export_flows.py`
scan) and (b) **where** `transform_flows.py` reads its remap tables from (a committed config
file instead of hardcoded literals). Invariant #7 ("prod seed produced **only** via
`transform_flows.py`") is preserved — the converter never emits `prod.jsonl`.

## 3. Parity defined: static vs dynamic fields

| Field | Class | Behaviour sandbox→prod |
|---|---|---|
| `target_flow_id` (flow name) | **static** | copied verbatim (this is what we keep in parity) |
| step structure, `step_id`, `action_type` | static | verbatim |
| `content.text` (`eng`/`spa`/`zho`), `branches`, `default_next`, `label` | static | verbatim |
| `SkillWhisper` token (queue identity in SET rows) | static | verbatim (PolyAI source of truth; never rewritten from a Connect queue name) |
| account id, instance id | **dynamic** | remapped via manifest `accounts`/`instances` |
| `hoo_arn` / HOO UUID | dynamic | remapped via manifest `phones[*].hoo` |
| `queueArn` (TRANSFER) | dynamic | remapped per env (placeholder until prod queues provisioned) |
| dialed phone numbers (META `flow_id`) | dynamic | per-env META rows generated from manifest `phones` |

"Parity except account vars" **is** this split. The static columns must match across
environments; the dynamic columns are the only legitimate differences.

## 4. The remap manifest — `TwilioIVREngine/seed/flow_registry.json`

Single committed, diffable source of truth that absorbs today's three hardcoded
`transform_flows.py` maps (`KP_FLOWS`, `PHONE_MAP`, `HOURS_OF_OPERATION_MAP`).

```jsonc
{
  "accounts":  { "sandbox": "523773103726", "prod": "248632139351" },
  "instances": { "sandbox": "17d7794d-9d83-46fd-a6dc-07c38873db34",
                 "prod":    "f9c7a311-4dc8-4c8c-8e4b-208c8942887b" },
  "region": "us-west-2",
  "flows": ["landing_kp_colorado", "landing_kp_georgia", "landing_kpma"],
  "phones": {
    "+18303553553": {
      "target_flow_id": "landing_kp_colorado",
      "start_step": "start",
      "hoo": { "sandbox": "2c84f1e9-70f6-4c47-b4a5-f0c7b5851482",
               "prod":    "783c5513-e8c6-47de-9c27-68bff8132b2b" }
    }
    // … one entry per dialed number, primary + secondary
  }
}
```

Rules:

- `flows` ⇒ replaces `KP_FLOWS` (the filter: only these reach prod).
- `phones` ⇒ replaces `PHONE_MAP` (META regeneration) **and** the per-HOO sandbox→prod map
  (replaces `HOURS_OF_OPERATION_MAP`, derived from each entry's `hoo.sandbox`/`hoo.prod`).
- **`hoo.prod` defaults to the literal `"REPLACE"`** for a new location whose prod HOO does
  not exist yet. `transform_flows.py` **aborts** on any `"REPLACE"` it would emit — preserving
  the existing fail-fast guard so a partially-remapped seed can never ship.

The converter fills everything it can observe from sandbox (`target_flow_id`, phones,
`hoo.sandbox`, accounts/instances). It **cannot** know `hoo.prod` for a brand-new prod HOO —
that stays `"REPLACE"` for a human to fill once Connect is provisioned. This is the one
irreducible manual step (a tool cannot invent a prod resource that does not exist).

## 5. Converter changes

### 5.1 Selection UI — `src/components/AccountPanel.tsx`
Add per-row checkboxes + "select all" to the **Flows Registry** table (today only the
*queues* view is selectable). Selection drives which flows the exporter emits.

### 5.2 Exporter — `src/utils/flowSeedExport.ts` (new, pure, unit-tested)
Given the selected flows + live credentials, produce two artifacts:

- **`TwilioIVRFlows.seed.jsonl`** — for each selected flow, its real **step rows** (re-queried
  live via the existing `loadFlowFromDdb`, because the cached scan discards raw rows) plus its
  **META rows** (`metaToRow`). Serialized **byte-compatible with `export_flows.py`**:
  `JSON.stringify` with **sorted keys** (`export_flows.py` uses `sort_keys=True`), nested
  `content` object (never a JSON string), `default_next` key, `eng/spa/zho`. A golden-file unit
  test diffs one emitted line against a real `seed.jsonl` line.
- **`flow_registry.json` patch** — adds/updates the selected flows' entries (`flows[]`,
  `phones{}`, `hoo.sandbox`). New prod HOOs are written as `"REPLACE"`. The exporter merges
  into an uploaded existing manifest rather than overwriting, so unrelated flows are preserved.

Pure builders live in `flowSeedExport.ts`; the DOM download wiring stays in the panel (mirrors
the existing `flowRegistryExport.ts` split). These exporters are a **second producer** of
`seed.jsonl` — kept a thin mirror of the ~40-line `export_flows.py` so they cannot drift; the
golden-file test is the guard.

### 5.3 Queue names
Two facets, kept distinct:
- **`SkillWhisper`** (queue identity inside SET rows) is **static** — it travels verbatim in
  the seed rows. Renaming it is an identity re-key (see §7).
- **`queueArn`** (TRANSFER) is **dynamic** — remapped per env; a fresh export is not deployable
  until prod queues are provisioned and ARNs resolved (existing Skills & Queues panel).
- The **Connect-side queue display name** is reconciled to match `SkillWhisper` by the existing
  `queueSync`/`queueReconcile` path (live, per-account) — **not** part of the seed pipeline;
  noted here only so "rename a queue" is not conflated with the row-level token.

## 6. `transform_flows.py` refactor (TwilioIVREngine repo)

- Load `KP_FLOWS`, `PHONE_MAP`, and the HOO sandbox→prod map from `seed/flow_registry.json`
  instead of module-level literals. Keep `_remap_line`'s `REPLACE`→abort guard verbatim.
- Seed the **initial** `flow_registry.json` from today's hardcoded values so that, on day one,
  `transform_flows.py` produces a **bit-identical** `prod.jsonl`. That equality is the
  regression test (§9).
- Keep account/instance string replacement, the Colorado `"1706"` HOURS fix, and META
  regeneration — all now sourced from the manifest.

## 7. Rename handling + the prune mechanism

Two rename kinds, per the "both" scope:

**(a) Cosmetic label rename** (META `description` / display name; engine-ignored). A pure value
update. The CDK seeder **upserts**, so the new value overwrites in place — **no stale rows**.
Covered by re-exporting the flow's META rows with the new `description`.

**(b) Identity re-key** (`target_flow_id` or `SkillWhisper`, i.e. a DynamoDB partition-key
change). Within sandbox the converter already handles this crash-safely
(`renameFlow`/`planRenameFlow`). The problem is **prod**: the seeder only `put_item`s and
**never deletes** (contract invariant #9), so the old-named rows **linger in prod as stale**.

**Prune design (the new piece):** the converter records, for each identity rename, the **old
keys** being abandoned and emits an explicit, committed **delete manifest**
`TwilioIVREngine/seed/prod_deletes.jsonl` — one `{ "flow_id", "step_id" }` per line. This is a
**targeted, explicit** list (exactly the rows the rename orphaned), not a full diff-sync, so
blast radius is bounded and the diff is reviewable in the PR. The CDK seeder Lambda
(`lambdas/_seeder/seed_handler.py`) gains a delete pass: after the put pass, it `delete_item`s
each key in `prod_deletes.jsonl` (guarded by `fs.existsSync`, no-op when absent). Like the seed,
it is gated on a `seedVersion` bump. Jenkins runs the same `cdk deploy`; no Jenkins change beyond
committing the new file.

This converts invariant #9's "stale rows linger" drift vector from *silent and manual* into
*explicit and committed* for the rename case.

## 8. Deploy path (unchanged, Jenkins-driven)

1. In the converter: select flows → download `seed.jsonl`, updated `flow_registry.json`, and
   (if any identity rename) `prod_deletes.jsonl`.
2. Commit all three into `TwilioIVREngine/seed/`. Fill any `"REPLACE"` prod HOO.
3. Run `transform_flows.py` → regenerates `prod.jsonl` (fails fast on unfilled `REPLACE`).
4. Bump `seedVersion`; open PR; **Jenkins** deploys; the CDK custom resource re-seeds
   (puts) and prunes (deletes `prod_deletes.jsonl`).

The converter's responsibility ends at **producing committed artifacts** — matching the
limited-prod-write / Jenkins-deploy reality.

## 9. Testing

- **Unit (TS):** `flowSeedExport` golden-file test — an emitted `seed.jsonl` line is
  byte-identical to a real `export_flows.py` line (sorted keys, nested `content`,
  `default_next`, `eng/spa/zho`). Manifest-merge test (new flow adds an entry, existing
  untouched, new prod HOO is `"REPLACE"`). Rename test: identity re-key yields the right
  `prod_deletes.jsonl` keys.
- **Regression (Python):** `transform_flows.py` reading the **seeded-from-literals**
  `flow_registry.json` reproduces the **current committed `prod.jsonl` exactly** (byte diff).
- **Fail-fast:** a `"REPLACE"` prod HOO aborts `transform_flows.py` (existing behaviour, now
  via the manifest).
- **Seeder:** `prod_deletes.jsonl` delete pass removes exactly the listed keys; absent file is
  a no-op.

## 10. Contract impact

The frozen **row schema is unchanged**. `transform_flows.py`'s internal source-of-maps changes
(literals → `flow_registry.json`), and the seeder gains an explicit delete pass. Both touch
§4 of the contract (the port mechanism) without altering what crosses the boundary. Update the
contract's "Last verified" line and §4/§5 (invariant #9 now has an explicit-prune escape hatch)
when implemented; keep both ends in sync.

## 11. Risks / open items

- **Two `seed.jsonl` producers** (`export_flows.py` and the TS exporter) can drift — mitigated
  by the golden-file test; revisit if they diverge.
- **`prod_deletes.jsonl` is fire-and-forget** — a wrong key deletes a prod row. Bounded by
  being explicit + PR-reviewed + `seedVersion`-gated, but it is the one genuinely destructive
  addition; worth a second reviewer on rename PRs.
- **`hoo.prod = "REPLACE"`** is an unavoidable manual step for new locations; the win is it is
  one labelled line in a committed JSON, not a hunt through Python literals.
```
