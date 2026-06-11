import { describe, it, expect } from "vitest";
import {
  findQueueByName,
  findHooByName,
  planQueueSync,
  findMissingQueues,
  reconcileFlowQueues,
  executeQueueSync,
  renameQueue,
  deleteQueue,
  createQueue,
  tagResource,
  untagResource,
  type QueuedWithTags,
  type HooWithTags,
  type SkillMappingRow,
  type SyncAction,
} from "./queueSync";
import type { ConnectClient } from "@aws-sdk/client-connect";
import type { QueueRecord } from "../project";

// QueueSummary (from ListQueues) uses Arn/Id (not QueueArn/QueueId — those are
// on the Describe/Create `Queue` shape). queueSync works off summaries.
const q = (
  Name: string,
  tags: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): QueuedWithTags => ({ Name, Arn: `arn:${Name}`, Id: `id:${Name}`, tags, ...extra });

const hoo = (Name: string): HooWithTags => ({ Name, Arn: `arn:${Name}`, Id: `id:${Name}` });

describe("findQueueByName", () => {
  const live = [q("Care First Reservations EN"), q("Support English")];

  it("matches case-insensitively (exact)", () => {
    expect(findQueueByName("care first reservations en", live)?.Name).toBe(
      "Care First Reservations EN",
    );
  });

  it("matches across separator/case differences (normalized)", () => {
    // dash-separated target vs space-separated live name
    expect(findQueueByName("Care-First-Reservations-EN", live)?.Name).toBe(
      "Care First Reservations EN",
    );
    expect(findQueueByName("CareFirstReservationsEN", live)?.Name).toBe(
      "Care First Reservations EN",
    );
  });

  it("does NOT do substring matching by default", () => {
    expect(findQueueByName("Support", live)).toBeUndefined();
  });

  it("does substring matching only when allowPartial is set", () => {
    expect(findQueueByName("Support", live, { allowPartial: true })?.Name).toBe(
      "Support English",
    );
  });
});

describe("findHooByName", () => {
  const live = [hoo("Care First Hours"), hoo("Closed Holidays")];

  it("matches across separator/case differences", () => {
    expect(findHooByName("care-first-hours", live)?.Name).toBe("Care First Hours");
  });

  it("substring only with allowPartial", () => {
    expect(findHooByName("Holidays", live)).toBeUndefined();
    expect(findHooByName("Holidays", live, { allowPartial: true })?.Name).toBe(
      "Closed Holidays",
    );
  });
});

describe("planQueueSync — normalized matching avoids spurious actions", () => {
  const mapping = new Map<string, SkillMappingRow>([
    ["111", { skill_id: "111", queue_name: "Care-First-Reservations-EN" }],
    ["222", { skill_id: "222", queue_name: "Support-English" }],
  ]);

  it("treats a separator-different but correctly-tagged queue as already correct (skip, not rename/create)", () => {
    const live = [q("Care First Reservations EN", { cxone_skill_id: "111" })];
    const actions = planQueueSync(live, new Map([["111", mapping.get("111")!]]));
    const a = actions.find((x) => x.skillId === "111");
    expect(a?.type).toBe("skip");
  });

  it("tags an existing separator-different untagged queue instead of creating a duplicate", () => {
    const live = [q("Support English")]; // no tag
    const actions = planQueueSync(live, new Map([["222", mapping.get("222")!]]));
    const a = actions.find((x) => x.skillId === "222");
    expect(a?.type).toBe("tag");
  });

  it("does NOT use substring matching for destructive planning (still creates)", () => {
    // "Support-English" target; only a broader "Support English West" queue exists.
    const live = [q("Support English West")];
    const actions = planQueueSync(live, new Map([["222", mapping.get("222")!]]));
    const a = actions.find((x) => x.skillId === "222");
    expect(a?.type).toBe("create");
  });
});

describe("findMissingQueues — normalized + partial matching", () => {
  it("does not report a queue missing when it exists under a separator-different name", () => {
    const flow: QueueRecord[] = [
      { skillWhisper: "Care-First-Reservations-EN", connectName: "Care-First-Reservations-EN" },
    ];
    const live = [q("Care First Reservations EN")];
    expect(findMissingQueues(flow, live)).toHaveLength(0);
  });

  it("reports genuinely absent queues", () => {
    const flow: QueueRecord[] = [
      { skillWhisper: "Nonexistent-Queue", connectName: "Nonexistent-Queue" },
    ];
    expect(findMissingQueues(flow, [q("Care First Reservations EN")])).toHaveLength(1);
  });
});

describe("executeQueueSync — tag action locates the live queue", () => {
  // Minimal fake ConnectClient: serves the queue list + per-queue tags, and
  // records TagResourceCommand calls.
  function fakeClient(queues: QueuedWithTags[]) {
    const tagged: { arn: string; tags: Record<string, string> }[] = [];
    const client = {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        if (name === "ListQueuesCommand") return { QueueSummaryList: queues };
        if (name === "ListTagsForResourceCommand") {
          const q = queues.find((x) => x.Arn === cmd.input.resourceArn);
          return { tags: q?.tags ?? {} };
        }
        if (name === "TagResourceCommand") {
          tagged.push({ arn: cmd.input.resourceArn, tags: cmd.input.tags });
          return {};
        }
        return {};
      },
    } as unknown as ConnectClient;
    return { client, tagged };
  }

  it("tags the existing queue even when the CSV target name differs by separators", async () => {
    const live = [q("Support English")]; // live name uses spaces
    const { client, tagged } = fakeClient(live);
    const action: SyncAction = {
      type: "tag",
      resourceType: "queue",
      currentName: "Support English", // captured from the live queue at plan time
      targetName: "Support-English", // CSV name (dash-separated)
      skillId: "222",
      reason: "Missing skill_id tag",
    };

    const result = await executeQueueSync(client, "inst", [action]);

    expect(result.errors).toHaveLength(0);
    expect(result.retagged).toBe(1);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].arn).toBe("arn:Support English");
    expect(tagged[0].tags).toMatchObject({ cxone_skill_id: "222" });
  });
});

describe("connect resource ops send the correct SDK field names", () => {
  // Locks in the field-name contract that was the root of the AccountPanel /
  // queueSync crashes (QueueId vs Id, lowercase resourceArn/tags).
  function recorder() {
    const calls: { name: string; input: any }[] = [];
    const client = {
      send: async (cmd: any) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        return {};
      },
    } as unknown as ConnectClient;
    return { client, calls };
  }

  it("renameQueue → UpdateQueueNameCommand { InstanceId, QueueId, Name }", async () => {
    const { client, calls } = recorder();
    await renameQueue(client, "inst", "q1", "New Name");
    expect(calls[0].name).toBe("UpdateQueueNameCommand");
    expect(calls[0].input).toMatchObject({ InstanceId: "inst", QueueId: "q1", Name: "New Name" });
  });

  it("deleteQueue → DeleteQueueCommand { InstanceId, QueueId }", async () => {
    const { client, calls } = recorder();
    await deleteQueue(client, "inst", "q1");
    expect(calls[0].name).toBe("DeleteQueueCommand");
    expect(calls[0].input).toMatchObject({ InstanceId: "inst", QueueId: "q1" });
  });

  it("tagResource → TagResourceCommand { resourceArn, tags } (lowercase)", async () => {
    const { client, calls } = recorder();
    await tagResource(client, "arn:q1", { source: "ivr-editor" });
    expect(calls[0].name).toBe("TagResourceCommand");
    expect(calls[0].input).toEqual({ resourceArn: "arn:q1", tags: { source: "ivr-editor" } });
  });

  it("untagResource → UntagResourceCommand { resourceArn, tagKeys }", async () => {
    const { client, calls } = recorder();
    await untagResource(client, "arn:q1", ["source"]);
    expect(calls[0].name).toBe("UntagResourceCommand");
    expect(calls[0].input).toEqual({ resourceArn: "arn:q1", tagKeys: ["source"] });
  });

  it("createQueue → CreateQueueCommand { InstanceId, Name, HoursOfOperationId, Tags }", async () => {
    const { client, calls } = recorder();
    await createQueue(client, "inst", {
      name: "New Q",
      hoursOfOperationId: "HOO-9",
      tags: { cxone_skill_id: "555" },
      description: "d",
    });
    expect(calls[0].name).toBe("CreateQueueCommand");
    expect(calls[0].input).toMatchObject({
      InstanceId: "inst",
      Name: "New Q",
      HoursOfOperationId: "HOO-9",
      Tags: { cxone_skill_id: "555" },
      Description: "d",
    });
  });
});

describe("reconcileFlowQueues — enrich ARNs via fuzzy match", () => {
  it("populates ARN/ID and adopts the live name for a separator-different match", () => {
    const flow: QueueRecord[] = [
      { skillWhisper: "Care-First-Reservations-EN", connectName: "Care-First-Reservations-EN" },
    ];
    const live = [q("Care First Reservations EN", { cxone_skill_id: "111" })];
    const out = reconcileFlowQueues(flow, live);
    expect(out[0].queueArn).toBe("arn:Care First Reservations EN");
    expect(out[0].connectName).toBe("Care First Reservations EN");
  });
});
