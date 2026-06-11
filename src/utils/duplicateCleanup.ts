// src/utils/duplicateCleanup.ts
//
// Executes a duplicate-queue cleanup plan: repoint each dependency from the
// duplicate to the canonical queue, then delete the duplicates. Destructive —
// callers must preview + confirm first.

import { type ConnectClient } from "@aws-sdk/client-connect";
import { deleteQueue } from "./queueSync";
import {
  associateRoutingProfileQueues,
  disassociateRoutingProfileQueues,
  updateQuickConnectQueue,
} from "./connectDeps";
import type { ClusterCleanup } from "./queueReconcile";

export interface CleanupResult {
  repointed: number;
  deleted: number;
  errors: { resource: string; error: string }[];
}

export async function executeDuplicateCleanup(
  client: ConnectClient,
  instanceId: string,
  plans: ClusterCleanup[],
  onProgress?: (msg: string) => void,
): Promise<CleanupResult> {
  const result: CleanupResult = { repointed: 0, deleted: 0, errors: [] };

  for (const plan of plans) {
    const canonicalId = plan.canonical.Id;
    if (!canonicalId) continue;

    // 1. Repoint every dependency to the canonical.
    for (const { duplicate, dependency } of plan.repoints) {
      onProgress?.(`Repointing ${dependency.kind} "${dependency.name}" → ${plan.canonical.Name}`);
      try {
        if (dependency.kind === "routing-profile") {
          if (!dependency.channel) throw new Error("dependency missing channel");
          // Associate the canonical first (additive/safe). If it's already on
          // the profile, that's fine — we just want it present before removing
          // the duplicate.
          try {
            await associateRoutingProfileQueues(client, instanceId, dependency.id, [
              {
                QueueReference: { QueueId: canonicalId, Channel: dependency.channel },
                Priority: dependency.priority,
                Delay: dependency.delay,
              },
            ]);
          } catch (e: any) {
            if (!/already|exist/i.test(e?.message ?? "")) throw e;
          }
          await disassociateRoutingProfileQueues(client, instanceId, dependency.id, [
            { QueueId: duplicate.Id!, Channel: dependency.channel },
          ]);
        } else {
          await updateQuickConnectQueue(
            client,
            instanceId,
            dependency.id,
            canonicalId,
            dependency.contactFlowId ?? "",
          );
        }
        result.repointed++;
      } catch (e: any) {
        result.errors.push({
          resource: `${dependency.kind} "${dependency.name}"`,
          error: e?.message ?? String(e),
        });
      }
    }

    // 2. Delete the (now dependency-free) duplicates.
    for (const dup of plan.duplicates) {
      if (!dup.Id) continue;
      onProgress?.(`Deleting duplicate "${dup.Name}"`);
      try {
        await deleteQueue(client, instanceId, dup.Id);
        result.deleted++;
      } catch (e: any) {
        // Likely still referenced by something we couldn't repoint (flow/lambda).
        result.errors.push({ resource: `queue "${dup.Name}"`, error: e?.message ?? String(e) });
      }
    }
  }

  return result;
}
