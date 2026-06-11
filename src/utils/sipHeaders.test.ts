import { describe, it, expect } from "vitest";
import { readSipHeaders, writeSipHeaders } from "./sipHeaders";
import { expandAllMenus } from "./csv";
import type { IVRContent, IR } from "../types";

describe("readSipHeaders", () => {
  it("reads top-level X- header keys (the lambda/converter convention)", () => {
    const content: IVRContent = {
      transferType: "SIP",
      "X-UID": "{{uid}}",
      "X-QueueSkill": "{{QueueSkill}}",
      branches: {},
    };
    expect(readSipHeaders(content)).toEqual({
      "X-UID": "{{uid}}",
      "X-QueueSkill": "{{QueueSkill}}",
    });
  });

  it("excludes structural / transfer-control keys", () => {
    const content: IVRContent = {
      transferType: "SIP",
      "X-UID": "{{uid}}",
      branches: { "": "next" },
      digits: "{{uid}}",
      queueArn: "arn:q",
      agentSkill: "123",
    } as IVRContent;
    expect(readSipHeaders(content)).toEqual({ "X-UID": "{{uid}}" });
  });

  it("migrates a legacy sipHeaders sub-dict, with top-level winning on conflict", () => {
    const content: IVRContent = {
      transferType: "SIP",
      sipHeaders: { "X-UID": "old", "X-Legacy": "keep" },
      "X-UID": "new",
      branches: {},
    } as IVRContent;
    expect(readSipHeaders(content)).toEqual({ "X-UID": "new", "X-Legacy": "keep" });
  });
});

describe("writeSipHeaders", () => {
  it("writes headers as top-level keys and drops the legacy sub-dict + leak-prone keys", () => {
    const content: IVRContent = {
      transferType: "SIP",
      sipHeaders: { "X-Old": "x" },
      digits: "{{uid}}",
      agentSkill: "123",
      queueArn: "arn:q",
      branches: { "": "next" },
    } as IVRContent;

    const out = writeSipHeaders(content, { "X-UID": "{{uid}}", "X-QueueSkill": "{{QueueSkill}}" });

    expect(out).toEqual({
      transferType: "SIP",
      branches: { "": "next" },
      "X-UID": "{{uid}}",
      "X-QueueSkill": "{{QueueSkill}}",
    });
    // leak rule: nothing that would serialize into the SIP URI as a bad param
    expect("sipHeaders" in out).toBe(false);
    expect("digits" in out).toBe(false);
    expect("agentSkill" in out).toBe(false);
    expect("queueArn" in out).toBe(false);
  });

  it("survives the export path: expandAllMenus keeps X- keys, upload migration preserves them", () => {
    // Guards the boundary between the editor model and the lambda: buildAtomicSteps
    // runs expandAllMenus, then writeSteps migrates. If either dropped the
    // top-level X- keys, SIP nodes would upload with no headers.
    const ir: IR = {
      flow_id: "t",
      start_step: "sip",
      nodes: {
        sip: {
          step_id: "sip",
          action_type: "TRANSFER",
          label: "Forward to PolyAI",
          content: {
            transferType: "SIP",
            "X-UID": "{{uid}}",
            "X-QueueSkill": "{{QueueSkill}}",
            branches: {},
          } as IVRContent,
        },
      },
    };

    const expanded = expandAllMenus(ir);
    expect(expanded.sip.content["X-UID"]).toBe("{{uid}}");

    // The upload-boundary migration (writeSteps) on the expanded content.
    const uploaded = writeSipHeaders(expanded.sip.content, readSipHeaders(expanded.sip.content));
    expect(uploaded).toMatchObject({
      transferType: "SIP",
      "X-UID": "{{uid}}",
      "X-QueueSkill": "{{QueueSkill}}",
    });
  });

  it("round-trips: write∘read migrates legacy content to clean top-level form", () => {
    const legacy: IVRContent = {
      transferType: "SIP",
      sipHeaders: { "X-UID": "{{uid}}", "X-SkillWhisper": "{{SkillWhisper}}" },
      branches: {},
    } as IVRContent;
    const migrated = writeSipHeaders(legacy, readSipHeaders(legacy));
    expect(migrated).toEqual({
      transferType: "SIP",
      branches: {},
      "X-UID": "{{uid}}",
      "X-SkillWhisper": "{{SkillWhisper}}",
    });
  });
});
