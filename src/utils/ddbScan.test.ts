import { describe, it, expect } from "vitest";
import { groupDdbRows, metaToRow } from "./ddbScan";

describe("metaToRow", () => {
  it("serializes a DdbFlowMeta to the snake_case META row, omitting empties", () => {
    expect(metaToRow({
      dialedNumber: "+18005551234",
      targetFlowId: "Flow_A",
      startStep: "start",
      hooArn: "arn:hoo",
    })).toEqual({
      flow_id: "+18005551234",
      step_id: "META",
      target_flow_id: "Flow_A",
      start_step: "start",
      hoo_arn: "arn:hoo",
    });
  });
});

describe("groupDdbRows", () => {
  it("lists flow definitions by flow name, including flows with no META (no phone)", () => {
    const items = [
      // Flow_A: has a META (phone) + step rows
      { flow_id: "+18005551234", step_id: "META", target_flow_id: "Flow_A", hoo_arn: "arn:hoo-1", start_step: "start" },
      { flow_id: "Flow_A", step_id: "start", action_type: "START" },
      { flow_id: "Flow_A", step_id: "s1", action_type: "SET", content: { assignments: { SkillWhisper: "QA-EN", QueueSkill: "111" } } },
      // Flow_B: NO META, just step rows
      { flow_id: "Flow_B", step_id: "start", action_type: "START" },
      { flow_id: "Flow_B", step_id: "s1", action_type: "SET", content: { assignments: { SkillWhisper: "QB-EN" } } },
    ];

    const { flowDefs, flows, queueUsage } = groupDdbRows(items);

    // Listed by flow name, sorted, both flows present (incl. the META-less one)
    expect(flowDefs.map((f) => f.targetFlowId)).toEqual(["Flow_A", "Flow_B"]);

    const a = flowDefs.find((f) => f.targetFlowId === "Flow_A")!;
    expect(a.metas.map((m) => m.dialedNumber)).toEqual(["+18005551234"]);
    expect(a.hooArn).toBe("arn:hoo-1");
    expect(a.queues).toEqual([{ skillWhisper: "QA-EN", queueSkill: "111" }]);

    const b = flowDefs.find((f) => f.targetFlowId === "Flow_B")!;
    expect(b.metas).toHaveLength(0); // no phone number
    expect(b.queues.map((q) => q.skillWhisper)).toEqual(["QB-EN"]);

    // queueUsage covers queues from BOTH flows (incl. the META-less one)
    expect(queueUsage.has("QA-EN")).toBe(true);
    expect(queueUsage.has("QB-EN")).toBe(true);

    // META list only contains actual phone→flow rows
    expect(flows.map((m) => m.targetFlowId)).toEqual(["Flow_A"]);
  });

  it("attaches multiple phone numbers to a single flow", () => {
    const items = [
      { flow_id: "+1800AAA", step_id: "META", target_flow_id: "Flow_X" },
      { flow_id: "+1800BBB", step_id: "META", target_flow_id: "Flow_X" },
      { flow_id: "Flow_X", step_id: "start", action_type: "START" },
    ];
    const { flowDefs } = groupDdbRows(items);
    const x = flowDefs.find((f) => f.targetFlowId === "Flow_X")!;
    expect(x.metas.map((m) => m.dialedNumber).sort()).toEqual(["+1800AAA", "+1800BBB"]);
    expect(x.stepCount).toBe(1);
  });
});
