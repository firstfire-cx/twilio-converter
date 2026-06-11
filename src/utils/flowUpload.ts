// src/utils/flowUpload.ts
//
// Pure builders for the DynamoDB rows written during flow upload.
// Kept separate from the React upload component so they can be unit-tested.

import type { FlowMeta } from "../types";

/**
 * Build the META row(s) to write for a flow.
 *
 * The flow's step rows are stored under `flow_id = target_flow_id`. The META
 * row is keyed ONLY by `flow_id = dialed_number` (the phone number) — the
 * engine looks up metadata by the dialed number, reads `target_flow_id`, then
 * loads the step rows by that flow id.
 *
 * We deliberately do NOT write a second META row under `target_flow_id`: it
 * would share the partition key with the step rows, so the engine's by-flow
 * step query would pick up a stray "META" row and break the loader.
 */
export function buildMetaItems(meta: FlowMeta): Record<string, any>[] {
  const item: Record<string, any> = {
    flow_id: meta.dialed_number,
    step_id: "META",
    target_flow_id: meta.target_flow_id,
    start_step: meta.start_step,
  };
  if (meta.hoo_arn) item.hoo_arn = meta.hoo_arn;
  if (meta.instance_id) item.instance_id = meta.instance_id;
  if (meta.description) item.description = meta.description;
  return [item];
}
