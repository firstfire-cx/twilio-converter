// src/utils/flowPrune.ts
//
// Reachability-based pruning: find the steps in a flow that can't be reached
// from the start (dead/unused steps), so they can be deleted.

import type { IVRNode } from "../types";

/**
 * Step ids that are NOT reachable from the start step (following default_next +
 * branch targets). Falls back to the START-type node, then the first node, when
 * `startStep` is missing/unknown (e.g. a flow with no META).
 */
export function unreachableStepIds(
  nodes: Record<string, IVRNode>,
  startStep?: string,
): string[] {
  const ids = Object.keys(nodes);
  if (ids.length === 0) return [];

  const start =
    startStep && nodes[startStep]
      ? startStep
      : Object.values(nodes).find((n) => n.action_type === "START")?.step_id ?? ids[0];

  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (!id || seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    const n = nodes[id];
    if (n.default_next) stack.push(n.default_next);
    for (const v of Object.values(n.content?.branches ?? {})) {
      if (v) stack.push(v as string);
    }
  }

  return ids.filter((id) => !seen.has(id));
}
