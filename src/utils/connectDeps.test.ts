import { describe, it, expect } from "vitest";
import {
  associateRoutingProfileQueues,
  disassociateRoutingProfileQueues,
  updateQuickConnectQueue,
  scanQueueDependencies,
  updateQueueHoursOfOperation,
  deleteHoursOfOperation,
  findQueuesUsingHoo,
  reassignAndDeleteHoo,
} from "./connectDeps";
import type { ConnectClient } from "@aws-sdk/client-connect";

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

describe("connectDeps ops send the correct SDK field names", () => {
  it("associateRoutingProfileQueues → { InstanceId, RoutingProfileId, QueueConfigs }", async () => {
    const { client, calls } = recorder();
    await associateRoutingProfileQueues(client, "inst", "rp1", [
      { QueueReference: { QueueId: "qC", Channel: "VOICE" }, Priority: 1, Delay: 0 },
    ]);
    expect(calls[0].name).toBe("AssociateRoutingProfileQueuesCommand");
    expect(calls[0].input).toMatchObject({
      InstanceId: "inst",
      RoutingProfileId: "rp1",
      QueueConfigs: [{ QueueReference: { QueueId: "qC", Channel: "VOICE" }, Priority: 1, Delay: 0 }],
    });
  });

  it("disassociateRoutingProfileQueues → { InstanceId, RoutingProfileId, QueueReferences }", async () => {
    const { client, calls } = recorder();
    await disassociateRoutingProfileQueues(client, "inst", "rp1", [
      { QueueId: "qDup", Channel: "VOICE" },
    ]);
    expect(calls[0].name).toBe("DisassociateRoutingProfileQueuesCommand");
    expect(calls[0].input).toMatchObject({
      InstanceId: "inst",
      RoutingProfileId: "rp1",
      QueueReferences: [{ QueueId: "qDup", Channel: "VOICE" }],
    });
  });

  it("updateQuickConnectQueue → UpdateQuickConnectConfigCommand QUEUE config", async () => {
    const { client, calls } = recorder();
    await updateQuickConnectQueue(client, "inst", "qc1", "qC", "cf1");
    expect(calls[0].name).toBe("UpdateQuickConnectConfigCommand");
    expect(calls[0].input).toMatchObject({
      InstanceId: "inst",
      QuickConnectId: "qc1",
      QuickConnectConfig: {
        QuickConnectType: "QUEUE",
        QueueConfig: { QueueId: "qC", ContactFlowId: "cf1" },
      },
    });
  });

  it("updateQueueHoursOfOperation → { InstanceId, QueueId, HoursOfOperationId }", async () => {
    const { client, calls } = recorder();
    await updateQueueHoursOfOperation(client, "inst", "q1", "hooNew");
    expect(calls[0].name).toBe("UpdateQueueHoursOfOperationCommand");
    expect(calls[0].input).toMatchObject({ InstanceId: "inst", QueueId: "q1", HoursOfOperationId: "hooNew" });
  });

  it("deleteHoursOfOperation → { InstanceId, HoursOfOperationId }", async () => {
    const { client, calls } = recorder();
    await deleteHoursOfOperation(client, "inst", "hooOld");
    expect(calls[0].name).toBe("DeleteHoursOfOperationCommand");
    expect(calls[0].input).toMatchObject({ InstanceId: "inst", HoursOfOperationId: "hooOld" });
  });
});

describe("findQueuesUsingHoo", () => {
  it("returns queues whose HoursOfOperationId matches", async () => {
    const client = {
      send: async (cmd: any) => {
        const n = cmd.constructor.name;
        if (n === "ListQueuesCommand") return { QueueSummaryList: [{ Id: "q1", Name: "Q1" }, { Id: "q2", Name: "Q2" }] };
        if (n === "DescribeQueueCommand") {
          return { Queue: { HoursOfOperationId: cmd.input.QueueId === "q1" ? "hooA" : "hooB" } };
        }
        return {};
      },
    } as unknown as ConnectClient;
    expect(await findQueuesUsingHoo(client, "inst", "hooA")).toEqual([{ queueId: "q1", queueName: "Q1" }]);
  });
});

describe("reassignAndDeleteHoo", () => {
  it("repoints queues then deletes the HOO", async () => {
    const { client, calls } = recorder();
    const r = await reassignAndDeleteHoo(client, "inst", "hooOld", [{ queueId: "q1", queueName: "Q1" }], "hooNew");
    expect(calls.map((c) => c.name)).toEqual(["UpdateQueueHoursOfOperationCommand", "DeleteHoursOfOperationCommand"]);
    expect(r.repointed).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  it("does NOT delete the HOO if a repoint failed", async () => {
    const seen: string[] = [];
    const client = {
      send: async (cmd: any) => {
        seen.push(cmd.constructor.name);
        if (cmd.constructor.name === "UpdateQueueHoursOfOperationCommand") throw new Error("boom");
        return {};
      },
    } as unknown as ConnectClient;
    const r = await reassignAndDeleteHoo(client, "inst", "hooOld", [{ queueId: "q1", queueName: "Q1" }], "hooNew");
    expect(seen).not.toContain("DeleteHoursOfOperationCommand");
    expect(r.errors).toHaveLength(1);
  });
});

describe("scanQueueDependencies", () => {
  function fakeClient() {
    const client = {
      send: async (cmd: any) => {
        const n = cmd.constructor.name;
        if (n === "ListRoutingProfilesCommand") {
          return { RoutingProfileSummaryList: [{ Id: "rp1", Name: "RP One" }] };
        }
        if (n === "ListRoutingProfileQueuesCommand") {
          return {
            RoutingProfileQueueConfigSummaryList: [
              { QueueId: "qDup", Channel: "VOICE", Priority: 2, Delay: 5 },
            ],
          };
        }
        if (n === "ListQuickConnectsCommand") {
          return { QuickConnectSummaryList: [{ Id: "qc1", Name: "QC One", QuickConnectType: "QUEUE" }] };
        }
        if (n === "DescribeQuickConnectCommand") {
          return {
            QuickConnect: {
              QuickConnectConfig: {
                QuickConnectType: "QUEUE",
                QueueConfig: { QueueId: "qDup", ContactFlowId: "cf1" },
              },
            },
          };
        }
        return {};
      },
    } as unknown as ConnectClient;
    return client;
  }

  it("indexes routing-profile and quick-connect refs by queue id", async () => {
    const deps = await scanQueueDependencies(fakeClient(), "inst");
    const list = deps.get("qDup")!;
    expect(list.map((d) => d.kind).sort()).toEqual(["quick-connect", "routing-profile"]);

    const rp = list.find((d) => d.kind === "routing-profile")!;
    expect(rp).toMatchObject({ id: "rp1", name: "RP One", channel: "VOICE", priority: 2, delay: 5 });

    const qc = list.find((d) => d.kind === "quick-connect")!;
    expect(qc).toMatchObject({ id: "qc1", name: "QC One", contactFlowId: "cf1" });
  });
});
