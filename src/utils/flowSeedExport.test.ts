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
