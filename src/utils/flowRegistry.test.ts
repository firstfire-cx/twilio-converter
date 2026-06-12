import { describe, it, expect } from "vitest";
import { buildFlowRegistry, type EnvScan } from "./flowRegistry";
import type { DdbState, DdbFlow, DdbFlowMeta } from "./ddbScan";

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

  it("keeps both flows when two names in one env normalize to the same key", () => {
    const reg = buildFlowRegistry([
      sandbox([
        flow({ targetFlowId: "Landing_Aetna", metas: [meta({ dialedNumber: "+1A", targetFlowId: "Landing_Aetna" })] }),
        flow({ targetFlowId: "landing-aetna", metas: [] }),
      ]),
    ]);
    // both near-duplicate flows survive (neither silently dropped)
    const raws = reg.rows.map((r) => r.envs.sandbox.rawFlowId).sort();
    expect(raws).toEqual(["Landing_Aetna", "landing-aetna"]);
    // each gets a distinct flowKey so it is independently actionable
    expect(new Set(reg.rows.map((r) => r.flowKey)).size).toBe(2);
  });
});

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
