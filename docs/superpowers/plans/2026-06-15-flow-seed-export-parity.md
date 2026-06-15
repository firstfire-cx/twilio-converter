# Flow Seed Export + Sandbox↔Prod Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let twilio-converter export selected flows as a seed pipeline can consume, and make `transform_flows.py` config-driven so new flows + renames reach prod via the existing Jenkins/CDK seeder while keeping sandbox↔prod parity on everything except remapped account values.

**Architecture:** A committed `seed/flow_registry.json` absorbs the three hardcoded `transform_flows.py` maps (the remap table). The converter gains a pure exporter (`flowSeedExport.ts`) that emits `seed.jsonl` (byte-compatible with `export_flows.py`), a `flow_registry.json` patch, and a `prod_deletes.jsonl` for identity renames. The CDK seeder gains a delete pass so identity re-keys do not leave stale prod rows.

**Tech Stack:** TypeScript/React/Vite + Vitest (twilio-converter); Python 3.12 + AWS CDK (TwilioIVREngine).

**Two repos, absolute paths:**
- Converter: `/home/carter/Documents/Git/twilio-converter`
- Engine: `/home/carter/Documents/Git/srh-aws-connect/TwilioIVREngine`

**Spec:** `docs/superpowers/specs/2026-06-15-flow-seed-export-parity-design.md`

---

## File Structure

**Engine repo (`TwilioIVREngine/`):**
- Create `seed/flow_registry.json` — the remap manifest (initial values = today's literals).
- Modify `seed/transform_flows.py` — read maps from `flow_registry.json`.
- Create `seed/test_transform_flows.py` — regression: prod.jsonl is byte-identical to the committed one.
- Modify `lambdas/_seeder/seed_handler.py` — add the delete pass.
- Modify `lib/twilio_ivr_engine-stack.ts` — wire the optional `prod_deletes.jsonl` asset.

**Converter repo (`twilio-converter/`):**
- Create `src/utils/flowSeedExport.ts` — pure serializer + builders (seed line, seed.jsonl, manifest patch, delete lines).
- Create `src/utils/flowSeedExport.test.ts` — unit tests incl. golden-line.
- Modify `src/utils/ddbScan.ts` — add `queryRawFlowRows` network helper.
- Modify `src/components/AccountPanel.tsx` — registry-row selection + download wiring.

---

## Task 1: Make `transform_flows.py` config-driven

**Files:**
- Create: `TwilioIVREngine/seed/flow_registry.json`
- Modify: `TwilioIVREngine/seed/transform_flows.py`
- Test: `TwilioIVREngine/seed/test_transform_flows.py`

- [ ] **Step 1: Snapshot the current prod output as the regression fixture**

The current committed `TwilioIVRFlows.prod.jsonl` is the golden output. Copy it so the test can diff against an untouched baseline:

Run (from `TwilioIVREngine/seed`):
```bash
cp TwilioIVRFlows.prod.jsonl /tmp/prod.golden.jsonl
```

- [ ] **Step 2: Write `flow_registry.json` from today's literals**

Create `TwilioIVREngine/seed/flow_registry.json` with the exact values currently hardcoded in `transform_flows.py` (`OLD_ACCOUNT`, `OLD_INSTANCE`, `PROD_ACCOUNT`, `PROD_INSTANCE`, `KP_FLOWS`, `PHONE_MAP`, `HOURS_OF_OPERATION_MAP`):

```json
{
  "accounts":  { "sandbox": "523773103726", "prod": "248632139351" },
  "instances": { "sandbox": "17d7794d-9d83-46fd-a6dc-07c38873db34",
                 "prod":    "f9c7a311-4dc8-4c8c-8e4b-208c8942887b" },
  "region": "us-west-2",
  "flows": ["landing_kp_colorado", "landing_kp_georgia", "landing_kpma"],
  "phones": {
    "+18303553553": { "target_flow_id": "landing_kp_colorado", "start_step": "start",
      "hoo": { "sandbox": "2c84f1e9-70f6-4c47-b4a5-f0c7b5851482", "prod": "783c5513-e8c6-47de-9c27-68bff8132b2b" } },
    "+19832109508": { "target_flow_id": "landing_kp_colorado", "start_step": "start",
      "hoo": { "sandbox": "2c84f1e9-70f6-4c47-b4a5-f0c7b5851482", "prod": "783c5513-e8c6-47de-9c27-68bff8132b2b" } },
    "+18305215435": { "target_flow_id": "landing_kp_georgia", "start_step": "start",
      "hoo": { "sandbox": "f1e738c9-b307-46f6-a6f0-5e442e02b7ee", "prod": "60de8ee9-9e6d-4ea0-8ec4-8a6b17067d21" } },
    "+14706644205": { "target_flow_id": "landing_kp_georgia", "start_step": "start",
      "hoo": { "sandbox": "f1e738c9-b307-46f6-a6f0-5e442e02b7ee", "prod": "60de8ee9-9e6d-4ea0-8ec4-8a6b17067d21" } },
    "+18304154683": { "target_flow_id": "landing_kpma", "start_step": "start",
      "hoo": { "sandbox": "dd654e63-06da-45d7-9d48-069a663bee8f", "prod": "d3f16e42-182f-4e63-be12-2c0bc633dc90" } },
    "+13014538779": { "target_flow_id": "landing_kpma", "start_step": "start",
      "hoo": { "sandbox": "dd654e63-06da-45d7-9d48-069a663bee8f", "prod": "d3f16e42-182f-4e63-be12-2c0bc633dc90" } }
  }
}
```

> Note: `landing_kp_colorado`'s sandbox HOO UUID is inferred from `HOURS_OF_OPERATION_MAP` ("KP Colorado" row). If the real sandbox export shows a different UUID on Colorado's HOURS step, correct `phones[+1830355…].hoo.sandbox` — the Step 6 byte-diff will catch a mismatch.

- [ ] **Step 3: Write the failing regression test**

Create `TwilioIVREngine/seed/test_transform_flows.py`:

```python
import json
import subprocess
import sys
from pathlib import Path

SEED_DIR = Path(__file__).parent


def test_prod_output_byte_identical_to_committed(tmp_path):
    """Refactored transform (reads flow_registry.json) must reproduce the
    committed prod.jsonl exactly — proves the manifest equals the old literals."""
    out = tmp_path / "out.jsonl"
    subprocess.run(
        [sys.executable, str(SEED_DIR / "transform_flows.py"),
         "--in", str(SEED_DIR / "TwilioIVRFlows.seed.jsonl"),
         "--out", str(out)],
        check=True, cwd=SEED_DIR,
    )
    golden = (SEED_DIR / "TwilioIVRFlows.prod.jsonl").read_text(encoding="utf-8")
    assert out.read_text(encoding="utf-8") == golden
```

- [ ] **Step 4: Run it to confirm it currently passes (baseline) BEFORE refactor**

Run (from `TwilioIVREngine/seed`):
```bash
python3 -m pytest test_transform_flows.py -v
```
Expected: PASS (the unrefactored script already produces the committed file). This locks the baseline; the refactor must keep it green.

- [ ] **Step 5: Refactor `transform_flows.py` to read the manifest**

Replace the module-level literal blocks (`OLD_ACCOUNT`…`COLORADO_HOO_FIX`) with a loader. Keep `PROD_BASE_ARN`, `COLORADO_HOO_FIX`, `_process_item`, `_remap_line`, `_generate_metas`, and `main` behaviour identical, but source the tables from the manifest:

```python
import json
from pathlib import Path

_MANIFEST = json.loads((Path(__file__).parent / "flow_registry.json").read_text(encoding="utf-8"))

OLD_ACCOUNT = _MANIFEST["accounts"]["sandbox"]
OLD_INSTANCE = _MANIFEST["instances"]["sandbox"]
PROD_ACCOUNT = _MANIFEST["accounts"]["prod"]
PROD_INSTANCE = _MANIFEST["instances"]["prod"]
_REGION = _MANIFEST["region"]
PROD_BASE_ARN = f"arn:aws:connect:{_REGION}:{PROD_ACCOUNT}:instance/{PROD_INSTANCE}"

KP_FLOWS = set(_MANIFEST["flows"])

# old hours-of-operation UUID -> prod UUID, derived from each phone's hoo pair.
HOURS_OF_OPERATION_MAP = {
    e["hoo"]["sandbox"]: e["hoo"]["prod"]
    for e in _MANIFEST["phones"].values()
}

# Phone -> (target_flow_id, prod_hoo_uuid).
PHONE_MAP = {
    phone: (e["target_flow_id"], e["hoo"]["prod"])
    for phone, e in _MANIFEST["phones"].items()
}

COLORADO_HOO_FIX = {
    "hoo_arn": f"{PROD_BASE_ARN}/operating-hours/{PHONE_MAP['+18303553553'][1]}",
}
```

Leave `_remap_line`'s `REPLACE`→`sys.exit(1)` abort guard, `_process_item`, `_generate_metas`, and `main` exactly as they are — they consume the names above.

> `_generate_metas` currently reads `start_step="start"` hardcoded. The manifest carries `start_step` per phone; keep the literal `"start"` for byte-parity unless a phone needs otherwise (none do today).

- [ ] **Step 6: Run the regression test to verify byte-identical output**

Run (from `TwilioIVREngine/seed`):
```bash
python3 -m pytest test_transform_flows.py -v
```
Expected: PASS. If it fails, `diff <(python3 transform_flows.py --out /dev/stdout) TwilioIVRFlows.prod.jsonl` and reconcile the manifest value that differs (most likely a `hoo.sandbox` UUID).

- [ ] **Step 7: Commit**

```bash
cd /home/carter/Documents/Git/srh-aws-connect/TwilioIVREngine
git add seed/flow_registry.json seed/transform_flows.py seed/test_transform_flows.py
git commit -m "refactor: transform_flows reads flow_registry.json (config-driven remap)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Seeder delete pass for renamed/orphaned rows

**Files:**
- Modify: `TwilioIVREngine/lambdas/_seeder/seed_handler.py`
- Modify: `TwilioIVREngine/lib/twilio_ivr_engine-stack.ts`

- [ ] **Step 1: Add the delete pass to the seeder handler**

In `TwilioIVREngine/lambdas/_seeder/seed_handler.py`, after the existing put loop (before `return`), add an optional delete pass driven by a second S3 object. Replace the `return` line of `handler` with:

```python
    # Optional prune pass: delete explicitly-listed orphaned rows (e.g. step rows
    # left behind by a flow-id rename). Upsert-only seeding never removes these.
    deletes_key = os.environ.get("DELETES_KEY")
    deleted = 0
    if deletes_key:
        try:
            dbody = s3.get_object(Bucket=bucket, Key=deletes_key)["Body"].read().decode("utf-8")
        except s3.exceptions.NoSuchKey:
            dbody = ""
        with table.batch_writer() as writer:
            for line in dbody.splitlines():
                line = line.strip()
                if not line:
                    continue
                key = json.loads(line)
                writer.delete_item(Key={"flow_id": key["flow_id"], "step_id": key["step_id"]})
                deleted += 1

    return {"PhysicalResourceId": physical_id,
            "Data": {"ItemsWritten": str(count), "ItemsDeleted": str(deleted)}}
```

Remove the old `return {"PhysicalResourceId": physical_id, "Data": {"ItemsWritten": str(count)}}` line.

- [ ] **Step 2: Wire the optional deletes asset in the stack**

In `TwilioIVREngine/lib/twilio_ivr_engine-stack.ts`, inside the `if (fs.existsSync(prodSeedPath)) {` block, after `const seedAsset = …` add:

```typescript
      const prodDeletesPath = path.join(__dirname, '..', 'seed', 'prod_deletes.jsonl');
      const deletesAsset = fs.existsSync(prodDeletesPath)
        ? new s3assets.Asset(this, 'FlowDeletesAsset', { path: prodDeletesPath })
        : undefined;
```

Then add to the `seeder` function's `environment` map (after `TABLE_NAME: flowsTable.tableName,`):

```typescript
          ...(deletesAsset ? { DELETES_KEY: deletesAsset.s3ObjectKey, SEED_BUCKET: seedAsset.s3BucketName } : {}),
```

> `SEED_BUCKET` is already set; the deletes object lives in the same asset bucket only if buckets match. To stay simple and correct, set the bucket explicitly: add `DELETES_KEY` AND grant read. After `seedAsset.grantRead(seeder);` add:

```typescript
      if (deletesAsset) deletesAsset.grantRead(seeder);
```

And ensure the handler reads the deletes object from the **deletes** asset's bucket. Since CDK assets can share a bucket but are not guaranteed to, pass a dedicated env var. Add to `environment` (replace the spread above with):

```typescript
          ...(deletesAsset ? { DELETES_KEY: deletesAsset.s3ObjectKey, DELETES_BUCKET: deletesAsset.s3BucketName } : {}),
```

- [ ] **Step 3: Update the handler to use the deletes bucket**

In `seed_handler.py`, change the delete pass to read its own bucket:

```python
    deletes_key = os.environ.get("DELETES_KEY")
    deletes_bucket = os.environ.get("DELETES_BUCKET", bucket)
    deleted = 0
    if deletes_key:
        try:
            dbody = s3.get_object(Bucket=deletes_bucket, Key=deletes_key)["Body"].read().decode("utf-8")
        except s3.exceptions.NoSuchKey:
            dbody = ""
        ...
```

(keep the rest of the loop from Step 1).

- [ ] **Step 4: Verify the stack still synths**

Run (from `TwilioIVREngine`):
```bash
npm run build && npx cdk synth >/dev/null && echo SYNTH_OK
```
Expected: `SYNTH_OK` (no `prod_deletes.jsonl` exists yet, so the deletes branch is dormant — proves the guard works).

- [ ] **Step 5: Commit**

```bash
cd /home/carter/Documents/Git/srh-aws-connect/TwilioIVREngine
git add lambdas/_seeder/seed_handler.py lib/twilio_ivr_engine-stack.ts
git commit -m "feat: seeder prune pass via optional prod_deletes.jsonl

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Python-compatible JSON serializer (converter)

**Files:**
- Create: `twilio-converter/src/utils/flowSeedExport.ts`
- Test: `twilio-converter/src/utils/flowSeedExport.test.ts`

- [ ] **Step 1: Write the failing golden-line test**

Create `twilio-converter/src/utils/flowSeedExport.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { pythonJsonDumps } from "./flowSeedExport";

describe("pythonJsonDumps", () => {
  it("matches export_flows.py json.dumps(sort_keys=True): sorted keys, ', '/': ' separators, ensure_ascii", () => {
    const row = {
      step_id: "m25_gather",
      flow_id: "landing_scan_connect",
      label: "Gather → MRES",
      action_type: "GATHER",
      default_next: "m25_check",
      content: { variable: "MRES", num_digits: "1", branches: {},
        text: { eng: "Press 1.", spa: "Para español, presione 2." } },
    };
    const line = pythonJsonDumps(row);
    expect(line).toBe(
      '{"action_type": "GATHER", "content": {"branches": {}, "num_digits": "1", ' +
      '"text": {"eng": "Press 1.", "spa": "Para espa\\u00f1ol, presione 2."}, "variable": "MRES"}, ' +
      '"default_next": "m25_check", "flow_id": "landing_scan_connect", ' +
      '"label": "Gather \\u2192 MRES", "step_id": "m25_gather"}',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts
```
Expected: FAIL — `flowSeedExport` / `pythonJsonDumps` not found.

- [ ] **Step 3: Implement `pythonJsonDumps`**

Create `twilio-converter/src/utils/flowSeedExport.ts`:

```typescript
// src/utils/flowSeedExport.ts
//
// Pure builders for exporting selected flows to the TwilioIVREngine seed
// pipeline. No DOM/network access (download + DDB reads live in the panel) so
// these stay unit-testable. The serializer mirrors export_flows.py's
// json.dumps(item, sort_keys=True): recursively sorted keys, ", "/": "
// separators, ensure_ascii (non-ASCII escaped). This keeps the converter's
// seed.jsonl byte-compatible with the Python exporter for clean git diffs.

/** A raw DynamoDB row as stored/exported (content is a nested object). */
export type SeedRow = Record<string, unknown>;

function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else if (code < 0x80) out += ch;
    else if (code > 0xffff) {
      const u = code - 0x10000;
      const hi = 0xd800 + (u >> 10);
      const lo = 0xdc00 + (u & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return "[" + value.map(pythonJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => encodeString(k) + ": " + pythonJsonDumps(obj[k])).join(", ") + "}";
  }
  throw new Error(`pythonJsonDumps: cannot serialize ${typeof value}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/carter/Documents/Git/twilio-converter
git add src/utils/flowSeedExport.ts src/utils/flowSeedExport.test.ts
git commit -m "feat: pythonJsonDumps — export_flows.py-compatible seed serializer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Build `seed.jsonl` text from selected flows

**Files:**
- Modify: `twilio-converter/src/utils/flowSeedExport.ts`
- Test: `twilio-converter/src/utils/flowSeedExport.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `flowSeedExport.test.ts`:

```typescript
import { buildSeedJsonl } from "./flowSeedExport";
import type { DdbFlowMeta } from "./ddbScan";

describe("buildSeedJsonl", () => {
  it("emits one sorted-key line per step row, then META rows, ending with a newline", () => {
    const stepRows: Record<string, unknown>[] = [
      { flow_id: "f1", step_id: "start", action_type: "PLAY",
        content: { text: { eng: "Hi" } }, default_next: "END", label: "Greet" },
    ];
    const metas: DdbFlowMeta[] = [
      { dialedNumber: "+18005551234", targetFlowId: "f1", startStep: "start", hooArn: "arn:hoo" },
    ];
    const out = buildSeedJsonl([{ stepRows, metas }]);
    expect(out).toBe(
      '{"action_type": "PLAY", "content": {"text": {"eng": "Hi"}}, ' +
      '"default_next": "END", "flow_id": "f1", "label": "Greet", "step_id": "start"}\n' +
      '{"flow_id": "+18005551234", "hoo_arn": "arn:hoo", "start_step": "start", ' +
      '"step_id": "META", "target_flow_id": "f1"}\n',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts -t buildSeedJsonl
```
Expected: FAIL — `buildSeedJsonl` not exported.

- [ ] **Step 3: Implement `buildSeedJsonl`**

Add to `flowSeedExport.ts` (import `metaToRow` + types at top):

```typescript
import { metaToRow, type DdbFlowMeta } from "./ddbScan";

export interface FlowSeedInput {
  /** Raw step rows for the flow (step_id !== "META"), as stored in DynamoDB. */
  stepRows: SeedRow[];
  /** META rows (phone → flow) routing to this flow. */
  metas: DdbFlowMeta[];
}

/** Build seed.jsonl text for the given flows: each flow's step rows followed by
 *  its META rows, every row serialized export_flows.py-style. Trailing newline. */
export function buildSeedJsonl(flows: FlowSeedInput[]): string {
  const lines: string[] = [];
  for (const { stepRows, metas } of flows) {
    for (const row of stepRows) lines.push(pythonJsonDumps(row));
    for (const m of metas) lines.push(pythonJsonDumps(metaToRow(m)));
  }
  return lines.map((l) => l + "\n").join("");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts -t buildSeedJsonl
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/carter/Documents/Git/twilio-converter
git add src/utils/flowSeedExport.ts src/utils/flowSeedExport.test.ts
git commit -m "feat: buildSeedJsonl — selected flows -> seed.jsonl text

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Merge selected flows into the `flow_registry.json` manifest

**Files:**
- Modify: `twilio-converter/src/utils/flowSeedExport.ts`
- Test: `twilio-converter/src/utils/flowSeedExport.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `flowSeedExport.test.ts`:

```typescript
import { mergeFlowIntoManifest, type FlowRegistryManifest } from "./flowSeedExport";
import type { DdbFlow } from "./ddbScan";

describe("mergeFlowIntoManifest", () => {
  const base: FlowRegistryManifest = {
    accounts: { sandbox: "111", prod: "222" },
    instances: { sandbox: "si", prod: "pi" },
    region: "us-west-2",
    flows: ["existing_flow"],
    phones: {},
  };
  const flow: DdbFlow = {
    targetFlowId: "landing_new",
    stepCount: 3,
    queues: [],
    metas: [{
      dialedNumber: "+18005550000", targetFlowId: "landing_new", startStep: "start",
      hooArn: "arn:aws:connect:us-west-2:111:instance/si/operating-hours/sandbox-hoo-uuid",
    }],
  };

  it("adds the flow + phone entry, sandbox HOO from the arn, prod HOO defaulted to REPLACE", () => {
    const out = mergeFlowIntoManifest(base, [flow]);
    expect(out.flows).toContain("landing_new");
    expect(out.phones["+18005550000"]).toEqual({
      target_flow_id: "landing_new",
      start_step: "start",
      hoo: { sandbox: "sandbox-hoo-uuid", prod: "REPLACE" },
    });
  });

  it("preserves an already-filled prod HOO instead of clobbering with REPLACE", () => {
    const withProd: FlowRegistryManifest = {
      ...base,
      phones: { "+18005550000": { target_flow_id: "landing_new", start_step: "start",
        hoo: { sandbox: "sandbox-hoo-uuid", prod: "already-prod" } } },
    };
    const out = mergeFlowIntoManifest(withProd, [flow]);
    expect(out.phones["+18005550000"].hoo.prod).toBe("already-prod");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts -t mergeFlowIntoManifest
```
Expected: FAIL — `mergeFlowIntoManifest` not exported.

- [ ] **Step 3: Implement the manifest types + merge**

Add to `flowSeedExport.ts` (import `hooIdFromArn` + `DdbFlow`):

```typescript
import { hooIdFromArn } from "./queueReconcile";
import type { DdbFlow } from "./ddbScan";

export interface ManifestPhone {
  target_flow_id: string;
  start_step: string;
  hoo: { sandbox: string; prod: string };
}

export interface FlowRegistryManifest {
  accounts: { sandbox: string; prod: string };
  instances: { sandbox: string; prod: string };
  region: string;
  flows: string[];
  phones: Record<string, ManifestPhone>;
}

/** Merge selected flows into a manifest: register each target_flow_id and each
 *  phone's META, deriving the sandbox HOO UUID from the meta's hooArn. A new
 *  prod HOO is defaulted to "REPLACE" (the transform's fail-fast guard); an
 *  existing filled prod HOO is preserved. Pure: returns a new manifest. */
export function mergeFlowIntoManifest(base: FlowRegistryManifest, flows: DdbFlow[]): FlowRegistryManifest {
  const out: FlowRegistryManifest = {
    ...base,
    flows: [...base.flows],
    phones: { ...base.phones },
  };
  for (const flow of flows) {
    if (!out.flows.includes(flow.targetFlowId)) out.flows.push(flow.targetFlowId);
    for (const m of flow.metas) {
      if (!m.dialedNumber) continue;
      const sandboxHoo = m.hooArn ? hooIdFromArn(m.hooArn) : "";
      const existing = out.phones[m.dialedNumber];
      out.phones[m.dialedNumber] = {
        target_flow_id: m.targetFlowId,
        start_step: m.startStep ?? "start",
        hoo: {
          sandbox: sandboxHoo,
          prod: existing?.hoo.prod && existing.hoo.prod !== "REPLACE" ? existing.hoo.prod : "REPLACE",
        },
      };
    }
  }
  out.flows.sort();
  return out;
}

/** Serialize a manifest for download (pretty, stable key order). */
export function manifestToJson(m: FlowRegistryManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts -t mergeFlowIntoManifest
```
Expected: PASS.

- [ ] **Step 5: Verify `hooIdFromArn` extracts the trailing UUID**

Confirm the helper exists and behaves as assumed:

Run (from `twilio-converter`):
```bash
grep -n "export function hooIdFromArn" src/utils/queueReconcile.ts
```
Expected: a match. If `hooIdFromArn` returns the full ARN tail differently, adjust the test's expected `sandbox` value to match its real output (it splits on `/` and takes the last segment).

- [ ] **Step 6: Commit**

```bash
cd /home/carter/Documents/Git/twilio-converter
git add src/utils/flowSeedExport.ts src/utils/flowSeedExport.test.ts
git commit -m "feat: mergeFlowIntoManifest — register selected flows in flow_registry.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Build `prod_deletes.jsonl` for identity renames

**Files:**
- Modify: `twilio-converter/src/utils/flowSeedExport.ts`
- Test: `twilio-converter/src/utils/flowSeedExport.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `flowSeedExport.test.ts`:

```typescript
import { buildProdDeletes } from "./flowSeedExport";

describe("buildProdDeletes", () => {
  it("emits one delete line per orphaned old step key, in input order, trailing newline", () => {
    const out = buildProdDeletes("old_flow", ["start", "s1"]);
    expect(out).toBe(
      '{"flow_id": "old_flow", "step_id": "start"}\n' +
      '{"flow_id": "old_flow", "step_id": "s1"}\n',
    );
  });

  it("returns empty string when there are no orphaned steps", () => {
    expect(buildProdDeletes("old_flow", [])).toBe("");
  });
});
```

> Lines preserve input order (the implementation does not sort line order); the per-line *keys* are still sorted by `pythonJsonDumps` (`flow_id` before `step_id`).

- [ ] **Step 2: Run it to verify it fails**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts -t buildProdDeletes
```
Expected: FAIL — `buildProdDeletes` not exported.

- [ ] **Step 3: Implement `buildProdDeletes`**

Add to `flowSeedExport.ts`:

```typescript
/** Build prod_deletes.jsonl text: one {flow_id, step_id} per old step row that a
 *  target_flow_id rename orphaned in prod (the seeder upserts, never deletes, so
 *  these must be pruned explicitly). Lines preserve input order. */
export function buildProdDeletes(oldFlowId: string, oldStepIds: string[]): string {
  return oldStepIds
    .map((stepId) => pythonJsonDumps({ flow_id: oldFlowId, step_id: stepId }) + "\n")
    .join("");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `twilio-converter`):
```bash
npx vitest run src/utils/flowSeedExport.test.ts -t buildProdDeletes
```
Expected: PASS.

- [ ] **Step 5: Run the whole suite (no regressions)**

Run (from `twilio-converter`):
```bash
npm test
```
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/carter/Documents/Git/twilio-converter
git add src/utils/flowSeedExport.ts src/utils/flowSeedExport.test.ts
git commit -m "feat: buildProdDeletes — orphaned-row prune list for identity renames

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Selection UI + download wiring in the Flows Registry

**Files:**
- Modify: `twilio-converter/src/utils/ddbScan.ts`
- Modify: `twilio-converter/src/components/AccountPanel.tsx`

- [ ] **Step 1: Add a raw-rows query helper to `ddbScan.ts`**

The exporter needs the *raw* DynamoDB step rows (not the reshaped IR). Add after `loadFlowFromDdb` in `src/utils/ddbScan.ts`:

```typescript
/**
 * Query a flow's raw step rows (everything under flow_id = target_flow_id except
 * the META placeholder), as stored — for faithful seed export. Unlike
 * loadFlowFromDdb this does NOT reshape into IR; it returns the rows verbatim.
 */
export async function queryRawFlowRows(
  creds: AwsCredentials,
  flowId: string,
): Promise<Record<string, any>[]> {
  const ddb = ddbDocClient(creds);
  const rows: Record<string, any>[] = [];
  let lastKey: any;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: FLOW_TABLE,
      KeyConditionExpression: "flow_id = :f",
      ExpressionAttributeValues: { ":f": flowId },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const it of resp.Items ?? []) if (it.step_id !== "META") rows.push(it);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return rows;
}
```

- [ ] **Step 2: Typecheck the helper**

Run (from `twilio-converter`):
```bash
npx tsc -b
```
Expected: no errors.

- [ ] **Step 3: Add selection state + imports to the registry panel**

In `src/components/AccountPanel.tsx`, locate the registry sub-component that renders `registry?.rows` (around line 1438–1762, where `exportMd/exportCsvFile/exportJsonFile` live). Add imports near the existing registry-export import (`line 40`):

```typescript
import { buildSeedJsonl, mergeFlowIntoManifest, manifestToJson, type FlowRegistryManifest } from "../utils/flowSeedExport";
import { queryRawFlowRows, type DdbFlow } from "../utils/ddbScan";
```

Inside that registry sub-component (the one owning `registry` + `downloadText`), add selection state:

```typescript
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const toggleFlow = (rawId: string) =>
    setSelectedFlows((prev) => {
      const n = new Set(prev);
      n.has(rawId) ? n.delete(rawId) : n.add(rawId);
      return n;
    });
```

- [ ] **Step 4: Add a checkbox column to each registry row**

In the row render (`registry?.rows ?? []).map(...)` near line 1673), add a leading cell. Use the row's sandbox `rawFlowId` as the selection key:

```tsx
                    <td style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        checked={selectedFlows.has(r.envs.sandbox?.rawFlowId ?? "")}
                        onChange={() => toggleFlow(r.envs.sandbox?.rawFlowId ?? "")}
                        disabled={!r.envs.sandbox?.rawFlowId}
                      />
                    </td>
```

Add a matching header cell (empty) in the table's header row so columns align.

- [ ] **Step 5: Add the seed-export handler + button**

Near `exportJsonFile` (line 1522) add the seed exporter. It re-queries raw rows for each selected flow, builds `seed.jsonl` + a `flow_registry.json` patch, and downloads both. The base manifest starts from the live env account/instance (read from the first selected flow's rows / known constants):

```typescript
  const exportSeed = async () => {
    if (!ddb) return;
    const chosen: DdbFlow[] = ddb.flowDefs.filter((f) => selectedFlows.has(f.targetFlowId));
    if (chosen.length === 0) return;

    const flows = [];
    for (const f of chosen) {
      const stepRows = await queryRawFlowRows(credentials!, f.targetFlowId);
      flows.push({ stepRows, metas: f.metas });
    }
    downloadText(`TwilioIVRFlows.seed.${stamp()}.jsonl`, buildSeedJsonl(flows), "application/x-ndjson");

    // Manifest patch: start from an empty-but-typed base; the engine repo holds
    // the canonical flow_registry.json — this patch is merged into it by hand/PR.
    const base: FlowRegistryManifest = {
      accounts: { sandbox: "", prod: "" },
      instances: { sandbox: "", prod: "" },
      region: "us-west-2",
      flows: [],
      phones: {},
    };
    const manifest = mergeFlowIntoManifest(base, chosen);
    downloadText(`flow_registry.patch.${stamp()}.json`, manifestToJson(manifest), "application/json");
  };
```

> The `base.accounts/instances` are left blank intentionally: the converter authors flows in sandbox and does not own the prod account constants — those already live in the engine's committed `flow_registry.json`. The downloaded patch contributes `flows[]` + `phones{}` (incl. `hoo.sandbox`, `prod:"REPLACE"`); a human merges it into the engine manifest. If you want the converter to also fill `accounts.sandbox`/`instances.sandbox`, read them from a selected flow's `instanceId`/account — out of scope for this task.

Add the button next to the MD/CSV/JSON buttons (line ~1632):

```tsx
        <button className="btn btn-ghost" style={{ fontSize: 10 }}
          disabled={!registry || selectedFlows.size === 0} onClick={exportSeed}>
          ⬇ Seed ({selectedFlows.size})
        </button>
```

- [ ] **Step 6: Typecheck + build**

Run (from `twilio-converter`):
```bash
npx tsc -b && npm run build
```
Expected: build succeeds, no type errors.

- [ ] **Step 7: Manual verification**

Run (from `twilio-converter`):
```bash
npm run dev
```
Then in the browser: authenticate → Flows Registry → tick one or two flows → click **⬇ Seed (n)**. Confirm two files download: a `.jsonl` whose lines are sorted-key native JSON (META + step rows), and a `flow_registry.patch.*.json` listing the chosen flows with `prod:"REPLACE"`. Spot-check one `.jsonl` line parses: `head -1 ~/Downloads/TwilioIVRFlows.seed.*.jsonl | python3 -m json.tool`.

- [ ] **Step 8: Commit**

```bash
cd /home/carter/Documents/Git/twilio-converter
git add src/utils/ddbScan.ts src/components/AccountPanel.tsx
git commit -m "feat: select flows in registry + export seed.jsonl/flow_registry patch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Update the frozen contract + docs

**Files:**
- Modify: `aws-sync-system/contracts/twilio-ivr-flow.contract.md`

- [ ] **Step 1: Record the changes in the contract**

In `/home/carter/Documents/Git/aws-sync-system/contracts/twilio-ivr-flow.contract.md`:
- Bump the "Last verified" / "Status FROZEN" date line to `2026-06-15`.
- In §4, note that `transform_flows.py` now reads `seed/flow_registry.json` (the remap table), and that the converter can emit `seed.jsonl` for selected flows (a second producer, byte-compatible via `pythonJsonDumps`, golden-tested).
- In §4/§5 invariant #9, add: identity renames now emit `seed/prod_deletes.jsonl`, processed by the seeder's delete pass (gated on `seedVersion`), so orphaned rows are pruned explicitly rather than lingering.

- [ ] **Step 2: Commit**

```bash
cd /home/carter/Documents/Git/aws-sync-system
git add contracts/twilio-ivr-flow.contract.md
git commit -m "docs: contract — config-driven transform + seeder prune pass (2026-06-15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §3 static/dynamic parity → Task 1 manifest + transform (dynamic remap), Task 4 seed rows (static copy). ✅
- §4 `flow_registry.json` → Task 1. ✅
- §5.1 selection UI → Task 7. ✅
- §5.2 `flowSeedExport.ts` (seed.jsonl + manifest patch) → Tasks 3–5, 7. ✅
- §5.3 queue names (SkillWhisper static in rows; queueArn dynamic) → carried by Task 4 verbatim rows; no separate code (correct — SkillWhisper is content, not a remap field). ✅
- §6 transform refactor + day-one bit-identical → Task 1. ✅
- §7 rename: cosmetic (in-place upsert via re-export, Task 7) + identity prune (`prod_deletes.jsonl`, Task 6 + seeder Task 2). ✅
- §8 Jenkins/git deploy path → unchanged; Tasks produce committed artifacts. ✅
- §9 testing (golden line, manifest merge, transform regression, seeder) → Tasks 1, 3–6. ✅
- §10 contract bump → Task 8. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. The Task 6 test note flags an ordering correction inline (use input order) — applied in the asserted call.

**Type consistency:** `SeedRow`, `FlowSeedInput`, `FlowRegistryManifest`, `ManifestPhone` defined in Task 3–5 and reused consistently in Task 7. `DdbFlow`/`DdbFlowMeta`/`metaToRow`/`hooIdFromArn` referenced from their real modules. `pythonJsonDumps` used by `buildSeedJsonl`/`buildProdDeletes`/`manifestToJson` consistently.

**Known follow-ups (not blocking, noted for the executor):**
- Cosmetic rename to prod is achieved by re-exporting the flow's META rows with the new `description` and re-running the pipeline; no dedicated UI task here since the registry already edits `description` inline (`setFlowMetaFields`) and the seed export picks it up.
- If the converter should auto-fill `accounts.sandbox`/`instances.sandbox` in the patch, extend Task 7 Step 5.
