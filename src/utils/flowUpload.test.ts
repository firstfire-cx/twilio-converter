import { describe, it, expect } from "vitest";
import { buildMetaItems } from "./flowUpload";
import type { FlowMeta } from "../types";

const meta: FlowMeta = {
  dialed_number: "+18005551234",
  target_flow_id: "Landing_BrightHealth",
  start_step: "start",
  hoo_arn: "arn:hoo",
  instance_id: "inst-1",
  description: "BrightHealth landing",
};

describe("buildMetaItems", () => {
  it("writes the META only under the dialed number (phone), never under the flow id", () => {
    const items = buildMetaItems(meta);

    // Exactly one META row, keyed by the phone number.
    expect(items).toHaveLength(1);
    expect(items[0].flow_id).toBe("+18005551234");
    expect(items[0].step_id).toBe("META");

    // No META row uses the flow / target_flow_id as the partition key — that
    // would collide with the step rows written under target_flow_id and break
    // the engine's by-flow step load.
    expect(items.some((i) => i.flow_id === "Landing_BrightHealth")).toBe(false);
  });

  it("carries the fields the engine reads", () => {
    const item = buildMetaItems(meta)[0];
    expect(item).toMatchObject({
      target_flow_id: "Landing_BrightHealth",
      start_step: "start",
      hoo_arn: "arn:hoo",
      instance_id: "inst-1",
    });
  });

  it("omits optional fields when absent", () => {
    const item = buildMetaItems({
      dialed_number: "+18005550000",
      target_flow_id: "Flow_X",
      start_step: "start",
    })[0];
    expect("hoo_arn" in item).toBe(false);
    expect("instance_id" in item).toBe(false);
    expect("description" in item).toBe(false);
  });
});
