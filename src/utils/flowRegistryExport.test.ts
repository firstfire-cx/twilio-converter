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
          queues: ["Aetna-EN", "Aetna-SP"],
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
      "| Health Plan | Join Status | Sandbox Flow | Sandbox Numbers | Sandbox HOO | Sandbox Queues | Sandbox Status | Prod Flow | Prod Numbers | Prod HOO | Prod Queues | Prod Status |",
    );
    expect(md.split("\n")[2]).toBe(
      "| Aetna | number-drift | landing_aetna | +1SB |  |  | live | landing_aetna | +1PR |  |  | live |",
    );
  });
});
