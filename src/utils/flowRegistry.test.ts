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
