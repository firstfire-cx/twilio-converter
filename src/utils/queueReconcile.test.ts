import { describe, it, expect } from "vitest";
import {
  classifyQueue,
  findMissingInConnect,
  hooIdFromArn,
  planMissingQueueCreates,
  clusterDuplicateQueues,
  planDuplicateCleanup,
} from "./queueReconcile";
import type { QueueDependency } from "./connectDeps";
import type { DdbState, DdbQueueUsage } from "./ddbScan";

const usage = (skillWhisper: string, queueSkill?: string): DdbQueueUsage => ({
  skillWhisper,
  queueSkill,
  flows: [],
});
function ddbWith(usages: DdbQueueUsage[]): DdbState {
  return {
    flows: [],
    flowDefs: [],
    queueUsage: new Map(usages.map((u) => [u.skillWhisper, u])),
    missingInConnect: [],
    scannedAt: new Date(),
  };
}

describe("classifyQueue", () => {
  const ddb = ddbWith([
    usage("Care-First-Reservations-EN", "111"),
    usage("Aetna-WMR-Spanish", "222"),
  ]);

  it("matches exactly by name", () => {
    expect(classifyQueue({ Name: "Care-First-Reservations-EN" }, ddb, false).status).toBe(
      "matched",
    );
  });

  it("matches by cxone_skill_id tag even when the name differs", () => {
    const c = classifyQueue(
      { Name: "Totally Different", tags: { cxone_skill_id: "111" } },
      ddb,
      false,
    );
    expect(c.status).toBe("matched");
    expect(c.ddbUsage?.skillWhisper).toBe("Care-First-Reservations-EN");
  });

  it("fuzzy-matches separator/language variants and reports fuzzyMatchedAs", () => {
    const c = classifyQueue({ Name: "Aetna WMR SP" }, ddb, false);
    expect(c.status).toBe("matched");
    expect(c.fuzzyMatchedAs).toBe("Aetna-WMR-Spanish");
  });

  it("returns orphan when nothing matches", () => {
    expect(classifyQueue({ Name: "Unrelated Queue XYZ" }, ddb, false).status).toBe("orphan");
  });

  it("short-circuits to duplicate", () => {
    expect(
      classifyQueue({ Name: "Care-First-Reservations-EN" }, ddb, true).status,
    ).toBe("duplicate");
  });
});

describe("findMissingInConnect", () => {
  const ddb = ddbWith([usage("Care-First-Reservations-EN"), usage("Aetna-WMR-Spanish")]);

  it("returns DDB queues with no Connect match (separator-different counts as present)", () => {
    const missing = findMissingInConnect(["Care First Reservations EN"], ddb);
    expect(missing.map((m) => m.skillWhisper)).toEqual(["Aetna-WMR-Spanish"]);
  });

  it("returns empty when all DDB queues are present in Connect", () => {
    expect(
      findMissingInConnect(["Care-First-Reservations-EN", "Aetna-WMR-Spanish"], ddb),
    ).toHaveLength(0);
  });
});

describe("hooIdFromArn", () => {
  it("extracts the id from a HOO ARN", () => {
    expect(
      hooIdFromArn("arn:aws:connect:us-east-1:1:instance/abc/operating-hours/HOO-9"),
    ).toBe("HOO-9");
  });
  it("returns a bare id unchanged", () => {
    expect(hooIdFromArn("HOO-9")).toBe("HOO-9");
  });
});

describe("planMissingQueueCreates", () => {
  it("resolves the HOO from the referencing flow and builds tags", () => {
    const [p] = planMissingQueueCreates([
      {
        skillWhisper: "CHP-WMR-EN",
        queueSkill: "555",
        flows: [
          {
            dialedNumber: "+18005551234",
            targetFlowId: "F",
            hooArn: "arn:aws:connect:us-east-1:1:instance/abc/operating-hours/HOO-9",
          },
        ],
      },
    ]);
    expect(p.hooId).toBe("HOO-9");
    expect(p.tags).toMatchObject({
      cxone_skill_id: "555",
      skill_whisper: "CHP-WMR-EN",
      ivr_flows: "18005551234", // '+' stripped
    });
  });

  it("marks hooId null when no referencing flow has a HOO (caller skips + surfaces)", () => {
    const [p] = planMissingQueueCreates([
      { skillWhisper: "X", flows: [{ dialedNumber: "+1800", targetFlowId: "F" }] },
    ]);
    expect(p.hooId).toBeNull();
  });
});

describe("clusterDuplicateQueues", () => {
  const ddb = ddbWith([usage("Care-First-Reservations-EN", "111")]);

  it("groups separator/case variants and picks the flow-matching one as canonical", () => {
    const queues = [
      { Id: "q1", Name: "Care-First-Reservations-EN" }, // matches the flow → canonical
      { Id: "q2", Name: "Care_First_Reservations_EN" }, // duplicate
      { Id: "q3", Name: "care first reservations en" }, // duplicate
      { Id: "q4", Name: "Totally Unrelated" }, // not a duplicate
    ];
    const clusters = clusterDuplicateQueues(queues, ddb);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.canonical?.Id).toBe("q1");
    expect(c.duplicates.map((d) => d.Id).sort()).toEqual(["q2", "q3"]);
    expect(c.needsManualPick).toBe(false);
  });

  it("picks the canonical by cxone_skill_id tag when the name doesn't match", () => {
    const queues = [
      { Id: "q1", Name: "CHP Reservations English", tags: { cxone_skill_id: "111" } },
      { Id: "q2", Name: "CHP-Reservations-English" },
    ];
    const clusters = clusterDuplicateQueues(queues, ddb);
    expect(clusters[0].canonical?.Id).toBe("q1");
  });

  it("flags needsManualPick when no queue matches a flow", () => {
    const queues = [
      { Id: "q1", Name: "Some-Test-Queue" },
      { Id: "q2", Name: "Some Test Queue" },
    ];
    const c = clusterDuplicateQueues(queues, ddb)[0];
    expect(c.needsManualPick).toBe(true);
    expect(c.duplicates).toHaveLength(0); // nothing auto-selected to remove
  });
});

describe("planDuplicateCleanup", () => {
  const ddb = ddbWith([usage("Care-First-Reservations-EN", "111")]);

  it("plans repoints for each dependency on a duplicate, plus the deletes", () => {
    const queues = [
      { Id: "qC", Name: "Care-First-Reservations-EN" }, // canonical
      { Id: "qD", Name: "Care_First_Reservations_EN" }, // duplicate
    ];
    const clusters = clusterDuplicateQueues(queues, ddb);
    const deps = new Map<string, QueueDependency[]>([
      [
        "qD",
        [
          { kind: "routing-profile", id: "rp1", name: "RP", channel: "VOICE", priority: 1, delay: 0 },
          { kind: "quick-connect", id: "qc1", name: "QC", contactFlowId: "cf1" },
        ],
      ],
    ]);

    const [plan] = planDuplicateCleanup(clusters, deps);
    expect(plan.canonical.Id).toBe("qC");
    expect(plan.duplicates.map((d) => d.Id)).toEqual(["qD"]);
    expect(plan.repoints).toHaveLength(2);
    expect(plan.repoints.every((r) => r.duplicate.Id === "qD")).toBe(true);
    expect(plan.repoints.map((r) => r.dependency.kind).sort()).toEqual([
      "quick-connect",
      "routing-profile",
    ]);
  });

  it("skips clusters that need a manual canonical pick", () => {
    const clusters = clusterDuplicateQueues(
      [{ Id: "a", Name: "Test-Q" }, { Id: "b", Name: "Test Q" }],
      ddb,
    );
    expect(planDuplicateCleanup(clusters, new Map())).toHaveLength(0);
  });
});
