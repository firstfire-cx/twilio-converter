// src/utils/connectDeps.ts
//
// Connect resource *dependencies* on queues — what points at a queue and would
// block deleting it. Used by the duplicate-queue cleanup: find the routing
// profiles / quick connects referencing a duplicate, repoint them to the
// canonical queue, then the duplicate can be deleted.

import {
  type ConnectClient,
  ListRoutingProfilesCommand,
  ListRoutingProfileQueuesCommand,
  AssociateRoutingProfileQueuesCommand,
  DisassociateRoutingProfileQueuesCommand,
  ListQuickConnectsCommand,
  DescribeQuickConnectCommand,
  UpdateQuickConnectConfigCommand,
  ListQueuesCommand,
  DescribeQueueCommand,
  UpdateQueueHoursOfOperationCommand,
  DeleteHoursOfOperationCommand,
  type RoutingProfileSummary,
  type RoutingProfileQueueConfigSummary,
  type RoutingProfileQueueConfig,
  type RoutingProfileQueueReference,
  type QuickConnectSummary,
  type Channel,
} from "@aws-sdk/client-connect";

// ── Routing profile ops ──────────────────────────────────────────────────────

export async function listRoutingProfiles(
  client: ConnectClient,
  instanceId: string,
): Promise<RoutingProfileSummary[]> {
  const out: RoutingProfileSummary[] = [];
  let next: string | undefined;
  do {
    const resp = await client.send(
      new ListRoutingProfilesCommand({ InstanceId: instanceId, ...(next ? { NextToken: next } : {}) }),
    );
    out.push(...(resp.RoutingProfileSummaryList ?? []));
    next = resp.NextToken;
  } while (next);
  return out;
}

export async function listRoutingProfileQueues(
  client: ConnectClient,
  instanceId: string,
  routingProfileId: string,
): Promise<RoutingProfileQueueConfigSummary[]> {
  const out: RoutingProfileQueueConfigSummary[] = [];
  let next: string | undefined;
  do {
    const resp = await client.send(
      new ListRoutingProfileQueuesCommand({
        InstanceId: instanceId,
        RoutingProfileId: routingProfileId,
        ...(next ? { NextToken: next } : {}),
      }),
    );
    out.push(...(resp.RoutingProfileQueueConfigSummaryList ?? []));
    next = resp.NextToken;
  } while (next);
  return out;
}

export async function associateRoutingProfileQueues(
  client: ConnectClient,
  instanceId: string,
  routingProfileId: string,
  queueConfigs: RoutingProfileQueueConfig[],
): Promise<void> {
  await client.send(
    new AssociateRoutingProfileQueuesCommand({
      InstanceId: instanceId,
      RoutingProfileId: routingProfileId,
      QueueConfigs: queueConfigs,
    }),
  );
}

export async function disassociateRoutingProfileQueues(
  client: ConnectClient,
  instanceId: string,
  routingProfileId: string,
  queueReferences: RoutingProfileQueueReference[],
): Promise<void> {
  await client.send(
    new DisassociateRoutingProfileQueuesCommand({
      InstanceId: instanceId,
      RoutingProfileId: routingProfileId,
      QueueReferences: queueReferences,
    }),
  );
}

// ── Quick connect ops ────────────────────────────────────────────────────────

export async function listQuickConnects(
  client: ConnectClient,
  instanceId: string,
): Promise<QuickConnectSummary[]> {
  const out: QuickConnectSummary[] = [];
  let next: string | undefined;
  do {
    const resp = await client.send(
      new ListQuickConnectsCommand({ InstanceId: instanceId, ...(next ? { NextToken: next } : {}) }),
    );
    out.push(...(resp.QuickConnectSummaryList ?? []));
    next = resp.NextToken;
  } while (next);
  return out;
}

/** The queue a QUEUE-type quick connect targets (null for USER/PHONE types). */
export async function describeQuickConnectQueue(
  client: ConnectClient,
  instanceId: string,
  quickConnectId: string,
): Promise<{ queueId?: string; contactFlowId?: string } | null> {
  const resp = await client.send(
    new DescribeQuickConnectCommand({ InstanceId: instanceId, QuickConnectId: quickConnectId }),
  );
  const cfg = resp.QuickConnect?.QuickConnectConfig;
  if (cfg?.QuickConnectType !== "QUEUE") return null;
  return { queueId: cfg.QueueConfig?.QueueId, contactFlowId: cfg.QueueConfig?.ContactFlowId };
}

export async function updateQuickConnectQueue(
  client: ConnectClient,
  instanceId: string,
  quickConnectId: string,
  queueId: string,
  contactFlowId: string,
): Promise<void> {
  await client.send(
    new UpdateQuickConnectConfigCommand({
      InstanceId: instanceId,
      QuickConnectId: quickConnectId,
      QuickConnectConfig: {
        QuickConnectType: "QUEUE",
        QueueConfig: { QueueId: queueId, ContactFlowId: contactFlowId },
      },
    }),
  );
}

// ── HOO dependency ops (queues reference a HOO) ──────────────────────────────

/** Queues whose HoursOfOperationId is `hooId` — these block deleting the HOO. */
export async function findQueuesUsingHoo(
  client: ConnectClient,
  instanceId: string,
  hooId: string,
  onProgress?: (msg: string) => void,
): Promise<{ queueId: string; queueName: string }[]> {
  const out: { queueId: string; queueName: string }[] = [];
  let next: string | undefined;
  do {
    const resp = await client.send(
      new ListQueuesCommand({ InstanceId: instanceId, QueueTypes: ["STANDARD"], ...(next ? { NextToken: next } : {}) }),
    );
    for (const q of resp.QueueSummaryList ?? []) {
      if (!q.Id) continue;
      onProgress?.(`Checking ${q.Name ?? q.Id}…`);
      const d = await client.send(new DescribeQueueCommand({ InstanceId: instanceId, QueueId: q.Id }));
      if (d.Queue?.HoursOfOperationId === hooId) out.push({ queueId: q.Id, queueName: q.Name ?? q.Id });
    }
    next = resp.NextToken;
  } while (next);
  return out;
}

export async function updateQueueHoursOfOperation(
  client: ConnectClient,
  instanceId: string,
  queueId: string,
  hoursOfOperationId: string,
): Promise<void> {
  await client.send(
    new UpdateQueueHoursOfOperationCommand({ InstanceId: instanceId, QueueId: queueId, HoursOfOperationId: hoursOfOperationId }),
  );
}

export async function deleteHoursOfOperation(
  client: ConnectClient,
  instanceId: string,
  hoursOfOperationId: string,
): Promise<void> {
  await client.send(
    new DeleteHoursOfOperationCommand({ InstanceId: instanceId, HoursOfOperationId: hoursOfOperationId }),
  );
}

/** Repoint every queue using `fromHooId` to `toHooId`, then delete `fromHooId`. */
export async function reassignAndDeleteHoo(
  client: ConnectClient,
  instanceId: string,
  fromHooId: string,
  queues: { queueId: string; queueName: string }[],
  toHooId: string,
  onProgress?: (msg: string) => void,
): Promise<{ repointed: number; errors: { resource: string; error: string }[] }> {
  const result = { repointed: 0, errors: [] as { resource: string; error: string }[] };
  for (const q of queues) {
    onProgress?.(`Repointing ${q.queueName}…`);
    try {
      await updateQueueHoursOfOperation(client, instanceId, q.queueId, toHooId);
      result.repointed++;
    } catch (e: any) {
      result.errors.push({ resource: `queue "${q.queueName}"`, error: e?.message ?? String(e) });
    }
  }
  if (result.errors.length === 0) {
    await deleteHoursOfOperation(client, instanceId, fromHooId);
  }
  return result;
}

// ── Dependency scan ──────────────────────────────────────────────────────────

export interface QueueDependency {
  kind: "routing-profile" | "quick-connect";
  id: string;
  name: string;
  // routing-profile association details (needed to recreate on the canonical)
  channel?: Channel;
  priority?: number;
  delay?: number;
  // quick-connect details
  contactFlowId?: string;
}

/**
 * Index every routing-profile and quick-connect reference by the queue id it
 * points at, so the cleanup can find (and repoint) what blocks each duplicate.
 */
export async function scanQueueDependencies(
  client: ConnectClient,
  instanceId: string,
  onProgress?: (msg: string) => void,
): Promise<Map<string, QueueDependency[]>> {
  const deps = new Map<string, QueueDependency[]>();
  const add = (queueId: string | undefined, dep: QueueDependency) => {
    if (!queueId) return;
    if (!deps.has(queueId)) deps.set(queueId, []);
    deps.get(queueId)!.push(dep);
  };

  onProgress?.("Scanning routing profiles…");
  const profiles = await listRoutingProfiles(client, instanceId);
  for (const p of profiles) {
    if (!p.Id) continue;
    for (const qc of await listRoutingProfileQueues(client, instanceId, p.Id)) {
      add(qc.QueueId, {
        kind: "routing-profile",
        id: p.Id,
        name: p.Name ?? p.Id,
        channel: qc.Channel,
        priority: qc.Priority,
        delay: qc.Delay,
      });
    }
  }

  onProgress?.("Scanning quick connects…");
  for (const qc of await listQuickConnects(client, instanceId)) {
    if (!qc.Id || qc.QuickConnectType !== "QUEUE") continue;
    const cfg = await describeQuickConnectQueue(client, instanceId, qc.Id);
    if (cfg?.queueId) {
      add(cfg.queueId, {
        kind: "quick-connect",
        id: qc.Id,
        name: qc.Name ?? qc.Id,
        contactFlowId: cfg.contactFlowId,
      });
    }
  }

  return deps;
}
