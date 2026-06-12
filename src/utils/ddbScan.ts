// src/utils/ddbScan.ts
//
// Scans the TwilioIVRFlows table for flow metadata + queue references.
// Extracted from AccountPanel so the result can be cached app-wide (scanned
// once per login via the ddb store) instead of re-fetched per panel mount.

import { ScanCommand, QueryCommand, DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { AwsCredentials } from "../hooks/useAwsCredentials";
import type { IR, IVRNode, FlowMeta } from "../types";
import { ddbDocClient } from "./awsClients";

export const FLOW_TABLE = "TwilioIVRFlows";

/** A META row from TwilioIVRFlows. */
export interface DdbFlowMeta {
  dialedNumber: string;
  targetFlowId: string;
  startStep?: string;
  hooArn?: string;
  instanceId?: string;
  description?: string;
}

/** Per-skillWhisper usage info collected from DDB. */
export interface DdbQueueUsage {
  skillWhisper: string;
  queueSkill?: string;
  flows: DdbFlowMeta[];
}

/**
 * A flow *definition*, grouped by its flow_id (target_flow_id) — the rows that
 * actually make up the flow. `metas` are the META rows (phone numbers) routing
 * to it; a flow with no META still appears here with an empty `metas`.
 */
export interface DdbFlow {
  targetFlowId: string;
  stepCount: number;
  metas: DdbFlowMeta[];
  queues: { skillWhisper: string; queueSkill?: string }[];
  // convenience, from the first META (if any):
  hooArn?: string;
  startStep?: string;
  instanceId?: string;
}

/** Aggregate DDB state. */
export interface DdbState {
  /** All META rows (phone → flow routing). */
  flows: DdbFlowMeta[];
  /** All flow definitions, keyed by flow name — includes flows with no META. */
  flowDefs: DdbFlow[];
  queueUsage: Map<string, DdbQueueUsage>;
  missingInConnect: string[];
  scannedAt: Date;
}

/**
 * Pure: turn raw DynamoDB rows into the flow model. META rows (step_id="META")
 * are phone→flow routing; everything else is a step row grouped by flow_id.
 * Builds the flow definitions (by name), the META list, and the per-skillWhisper
 * queue usage (from SET-node assignments). Separated from the network scan so it
 * can be unit-tested.
 */
export function groupDdbRows(items: any[]): {
  flows: DdbFlowMeta[];
  flowDefs: DdbFlow[];
  queueUsage: Map<string, DdbQueueUsage>;
} {
  const metas: DdbFlowMeta[] = [];
  const stepsByFlow = new Map<string, any[]>();

  for (const item of items) {
    if (item.step_id === "META") {
      metas.push({
        dialedNumber: item.flow_id ?? "",
        targetFlowId: item.target_flow_id ?? "",
        startStep: item.start_step,
        hooArn: item.hoo_arn,
        instanceId: item.instance_id,
        description: item.description,
      });
    } else {
      const fid = item.flow_id ?? "";
      if (!fid) continue;
      if (!stepsByFlow.has(fid)) stepsByFlow.set(fid, []);
      stepsByFlow.get(fid)!.push(item);
    }
  }

  const metasByTarget = new Map<string, DdbFlowMeta[]>();
  for (const m of metas) {
    if (!m.targetFlowId) continue;
    if (!metasByTarget.has(m.targetFlowId)) metasByTarget.set(m.targetFlowId, []);
    metasByTarget.get(m.targetFlowId)!.push(m);
  }

  const queueUsage = new Map<string, DdbQueueUsage>();
  const flowDefs: DdbFlow[] = [];

  for (const [targetFlowId, steps] of stepsByFlow) {
    const flowMetas = metasByTarget.get(targetFlowId) ?? [];
    const flowQueues = new Map<string, { skillWhisper: string; queueSkill?: string }>();

    for (const item of steps) {
      if (item.action_type !== "SET") continue;
      const asgn: Record<string, string> = item.content?.assignments ?? {};
      const sw = asgn["SkillWhisper"];
      const qs = asgn["QueueSkill"];
      if (!sw) continue;

      if (!flowQueues.has(sw)) flowQueues.set(sw, { skillWhisper: sw, queueSkill: qs });
      else if (qs && !flowQueues.get(sw)!.queueSkill) flowQueues.get(sw)!.queueSkill = qs;

      if (!queueUsage.has(sw)) queueUsage.set(sw, { skillWhisper: sw, queueSkill: qs, flows: [] });
      const u = queueUsage.get(sw)!;
      if (qs && !u.queueSkill) u.queueSkill = qs;
      for (const m of flowMetas) {
        if (!u.flows.find((x) => x.dialedNumber === m.dialedNumber)) u.flows.push(m);
      }
    }

    flowDefs.push({
      targetFlowId,
      stepCount: steps.length,
      metas: flowMetas,
      queues: [...flowQueues.values()],
      hooArn: flowMetas[0]?.hooArn,
      startStep: flowMetas[0]?.startStep,
      instanceId: flowMetas[0]?.instanceId,
    });
  }

  flowDefs.sort((a, b) => a.targetFlowId.localeCompare(b.targetFlowId));
  return { flows: metas, flowDefs, queueUsage };
}

export async function scanDdb(
  creds: AwsCredentials,
  onProgress?: (msg: string) => void,
): Promise<DdbState> {
  const ddb = ddbDocClient(creds);

  // Full table scan so we see every flow definition — including flows that have
  // no META row (no phone number yet). One cached scan per login.
  onProgress?.("Scanning DynamoDB flows…");
  const items: any[] = [];
  let lastKey: any;
  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: FLOW_TABLE,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    items.push(...(resp.Items ?? []));
    lastKey = resp.LastEvaluatedKey;
    onProgress?.(`Scanned ${items.length} rows…`);
  } while (lastKey);

  const { flows, flowDefs, queueUsage } = groupDdbRows(items);

  return {
    flows,
    flowDefs,
    queueUsage,
    missingInConnect: [],
    scannedAt: new Date(),
  };
}

/**
 * Load a single flow's rows from DynamoDB by flow_id (the step rows live under
 * target_flow_id) and rebuild the IR. The META row may be absent under the flow
 * id (it's keyed by phone), so callers should enrich start_step/meta from the
 * scan's DdbFlowMeta when needed.
 */
export async function loadFlowFromDdb(
  creds: AwsCredentials,
  flowId: string,
): Promise<{ ir: IR; meta?: FlowMeta }> {
  const ddb = ddbDocClient(creds);
  const result = await ddb.send(new QueryCommand({
    TableName: FLOW_TABLE,
    KeyConditionExpression: "flow_id = :flowId",
    ExpressionAttributeValues: { ":flowId": flowId },
  }));

  if (!result.Items || result.Items.length === 0) {
    throw new Error(`No flow found with ID: ${flowId}`);
  }

  const nodes: Record<string, IVRNode> = {};
  let meta: FlowMeta | undefined;
  let startStep: string | undefined;
  let hooArn: string | undefined;

  for (const item of result.Items) {
    if (item.step_id === "META") {
      meta = {
        dialed_number: item.dialed_number || item.flow_id,
        target_flow_id: item.target_flow_id,
        start_step: item.start_step,
        hoo_arn: item.hoo_arn,
        instance_id: item.instance_id,
        description: item.description,
      };
      startStep = item.start_step;
      hooArn = item.hoo_arn;
    } else {
      const node: IVRNode = {
        step_id: item.step_id,
        action_type: item.action_type,
        label: item.label || "",
        content: item.content || {},
        flow_id: item.flow_id,
      };
      if (item.default_next) node.default_next = item.default_next;
      nodes[item.step_id] = node;
    }
  }

  return { ir: { flow_id: flowId, nodes, start_step: startStep, hoo_arn: hooArn, meta }, meta };
}

/** Serialize a DdbFlowMeta to its DynamoDB META row shape. */
export function metaToRow(meta: DdbFlowMeta): Record<string, any> {
  const item: Record<string, any> = {
    flow_id: meta.dialedNumber,
    step_id: "META",
    target_flow_id: meta.targetFlowId,
  };
  if (meta.startStep) item.start_step = meta.startStep;
  if (meta.hooArn) item.hoo_arn = meta.hooArn;
  if (meta.instanceId) item.instance_id = meta.instanceId;
  if (meta.description) item.description = meta.description;
  return item;
}

/**
 * Edit a flow's META row. Writes the updated row; if the dialed number (the
 * partition key) changed, the old row is deleted afterwards (PK change =
 * put-new + delete-old).
 */
export async function editFlowMeta(
  creds: AwsCredentials,
  original: DdbFlowMeta,
  updated: DdbFlowMeta,
): Promise<void> {
  const ddb = ddbDocClient(creds);
  await ddb.send(new PutCommand({ TableName: FLOW_TABLE, Item: metaToRow(updated) }));
  if (original.dialedNumber && original.dialedNumber !== updated.dialedNumber) {
    await ddb.send(new DeleteCommand({
      TableName: FLOW_TABLE,
      Key: { flow_id: original.dialedNumber, step_id: "META" },
    }));
  }
}

/** The ordered DynamoDB operations a flow rename performs. */
export interface RenameFlowPlan {
  /** Step rows re-keyed under the new flow id (write first). */
  stepPuts: Record<string, any>[];
  /** META rows repointed to the new target (PK = dialed_number unchanged). */
  metaPuts: Record<string, any>[];
  /** Old step-row keys to delete last. */
  stepDeletes: { flow_id: string; step_id: string }[];
}

/**
 * Pure: build the rename cascade. `target_flow_id` is the partition key for
 * every step row, so a rename copies the step rows under the new id, repoints
 * each META that targets the old id, and deletes the old step rows. Returned as
 * three ordered groups so the executor can apply them crash-safely.
 */
export function planRenameFlow(
  oldFlowId: string,
  newFlowId: string,
  stepRows: any[],
  metas: DdbFlowMeta[],
): RenameFlowPlan {
  const stepPuts = stepRows.map((r) => ({ ...r, flow_id: newFlowId }));
  const stepDeletes = stepRows.map((r) => ({ flow_id: oldFlowId, step_id: r.step_id }));
  const metaPuts = metas
    .filter((m) => m.targetFlowId === oldFlowId)
    .map((m) => metaToRow({ ...m, targetFlowId: newFlowId }));
  return { stepPuts, metaPuts, stepDeletes };
}

/**
 * Rename a flow (its target_flow_id). Crash-safe order: 1) copy step rows under
 * the new id, 2) repoint METAs, 3) delete old step rows. A failure after step 2
 * leaves the flow fully loadable under the new id; the worst case is orphan old
 * step rows (recoverable), never a flow that loads to nothing. Rejects if the
 * target id already has rows (collision).
 */
export async function renameFlow(
  creds: AwsCredentials,
  oldFlowId: string,
  newFlowId: string,
  metas: DdbFlowMeta[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  const target = newFlowId.trim();
  if (!target) throw new Error("New flow id is required.");
  if (target === oldFlowId) return;
  const ddb = ddbDocClient(creds);

  // Collision guard — the target id must not already exist.
  const existing = await ddb.send(new QueryCommand({
    TableName: FLOW_TABLE,
    KeyConditionExpression: "flow_id = :f",
    ExpressionAttributeValues: { ":f": target },
    Limit: 1,
  }));
  if ((existing.Items?.length ?? 0) > 0) {
    throw new Error(`A flow named "${target}" already exists.`);
  }

  // Enumerate the old flow's step rows (skip any META under the flow id).
  const stepRows: any[] = [];
  let lastKey: any;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: FLOW_TABLE,
      KeyConditionExpression: "flow_id = :f",
      ExpressionAttributeValues: { ":f": oldFlowId },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const it of resp.Items ?? []) if (it.step_id !== "META") stepRows.push(it);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  const plan = planRenameFlow(oldFlowId, target, stepRows, metas);

  let i = 0;
  for (const item of plan.stepPuts) {
    onProgress?.(`Copying step ${++i}/${plan.stepPuts.length}…`);
    await ddb.send(new PutCommand({ TableName: FLOW_TABLE, Item: item }));
  }
  for (const item of plan.metaPuts) {
    onProgress?.(`Repointing ${item.flow_id}…`);
    await ddb.send(new PutCommand({ TableName: FLOW_TABLE, Item: item }));
  }
  for (const key of plan.stepDeletes) {
    onProgress?.(`Removing old ${key.step_id}…`);
    await ddb.send(new DeleteCommand({ TableName: FLOW_TABLE, Key: key }));
  }
}

/** Delete specific step rows from a flow (used to prune unreachable steps). */
export async function deleteSteps(
  creds: AwsCredentials,
  flowId: string,
  stepIds: string[],
  onProgress?: (msg: string) => void,
): Promise<number> {
  const ddb = ddbDocClient(creds);
  let deleted = 0;
  for (const stepId of stepIds) {
    onProgress?.(`Deleting ${stepId}…`);
    await ddb.send(new DeleteCommand({ TableName: FLOW_TABLE, Key: { flow_id: flowId, step_id: stepId } }));
    deleted++;
  }
  return deleted;
}

/**
 * Delete a whole flow from DynamoDB: every step row under its target_flow_id,
 * plus each META row (phone → flow) routing to it.
 */
export async function deleteFlowFromDdb(
  creds: AwsCredentials,
  flow: DdbFlow,
  onProgress?: (msg: string) => void,
): Promise<{ deletedRows: number }> {
  const ddb = ddbDocClient(creds);
  let deleted = 0;

  // Step rows live under flow_id = target_flow_id.
  let lastKey: any;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: FLOW_TABLE,
      KeyConditionExpression: "flow_id = :f",
      ExpressionAttributeValues: { ":f": flow.targetFlowId },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const item of resp.Items ?? []) {
      onProgress?.(`Deleting ${item.step_id}…`);
      await ddb.send(new DeleteCommand({
        TableName: FLOW_TABLE,
        Key: { flow_id: item.flow_id, step_id: item.step_id },
      }));
      deleted++;
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  // META rows (one per phone number routing to this flow).
  for (const m of flow.metas) {
    if (!m.dialedNumber) continue;
    await ddb.send(new DeleteCommand({
      TableName: FLOW_TABLE,
      Key: { flow_id: m.dialedNumber, step_id: "META" },
    }));
    deleted++;
  }

  return { deletedRows: deleted };
}
