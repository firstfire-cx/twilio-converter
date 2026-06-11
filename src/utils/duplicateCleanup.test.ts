import { describe, it, expect } from "vitest";
import { executeDuplicateCleanup } from "./duplicateCleanup";
import type { ClusterCleanup } from "./queueReconcile";
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

describe("executeDuplicateCleanup", () => {
  it("associates the canonical, disassociates the duplicate, repoints quick connects, then deletes", async () => {
    const { client, calls } = recorder();
    const plan: ClusterCleanup = {
      normalized: "carefirst",
      canonical: { Id: "qC", Name: "Care-First-Reservations-EN" },
      duplicates: [{ Id: "qD", Name: "Care_First_Reservations_EN" }],
      repoints: [
        {
          duplicate: { Id: "qD", Name: "Care_First_Reservations_EN" },
          dependency: { kind: "routing-profile", id: "rp1", name: "RP", channel: "VOICE", priority: 1, delay: 0 },
        },
        {
          duplicate: { Id: "qD", Name: "Care_First_Reservations_EN" },
          dependency: { kind: "quick-connect", id: "qc1", name: "QC", contactFlowId: "cf1" },
        },
      ],
    };

    const result = await executeDuplicateCleanup(client, "inst", [plan]);

    const seq = calls.map((c) => c.name);
    // associate canonical BEFORE disassociating the duplicate (safe ordering)
    expect(seq.indexOf("AssociateRoutingProfileQueuesCommand")).toBeLessThan(
      seq.indexOf("DisassociateRoutingProfileQueuesCommand"),
    );
    expect(seq).toContain("UpdateQuickConnectConfigCommand");
    // delete happens after the repoints
    expect(seq[seq.length - 1]).toBe("DeleteQueueCommand");

    // canonical associated, duplicate disassociated + deleted
    expect(calls.find((c) => c.name === "AssociateRoutingProfileQueuesCommand")!.input.QueueConfigs[0].QueueReference.QueueId).toBe("qC");
    expect(calls.find((c) => c.name === "DisassociateRoutingProfileQueuesCommand")!.input.QueueReferences[0].QueueId).toBe("qD");
    expect(calls.find((c) => c.name === "DeleteQueueCommand")!.input.QueueId).toBe("qD");

    expect(result).toMatchObject({ repointed: 2, deleted: 1, errors: [] });
  });

  it("tolerates an already-associated canonical and still removes the duplicate", async () => {
    const calls: string[] = [];
    const client = {
      send: async (cmd: any) => {
        calls.push(cmd.constructor.name);
        if (cmd.constructor.name === "AssociateRoutingProfileQueuesCommand") {
          throw new Error("Queue already exists in routing profile");
        }
        return {};
      },
    } as unknown as ConnectClient;

    const plan: ClusterCleanup = {
      normalized: "x",
      canonical: { Id: "qC", Name: "C" },
      duplicates: [{ Id: "qD", Name: "D" }],
      repoints: [
        { duplicate: { Id: "qD", Name: "D" }, dependency: { kind: "routing-profile", id: "rp1", name: "RP", channel: "VOICE", priority: 1, delay: 0 } },
      ],
    };

    const result = await executeDuplicateCleanup(client, "inst", [plan]);
    expect(calls).toContain("DisassociateRoutingProfileQueuesCommand"); // proceeded despite already-exists
    expect(calls).toContain("DeleteQueueCommand");
    expect(result.errors).toHaveLength(0);
    expect(result.repointed).toBe(1);
  });
});
