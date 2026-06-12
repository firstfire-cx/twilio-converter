// src/stores/flowAnnotations.ts
//
// Browser-local, documentation-only annotations for flows that have no DynamoDB
// META row (not-yet-live flows). Keyed by flow name (target_flow_id). Lives in
// localStorage so it survives refreshes; the auth hook's expiry path is narrowed
// so it is NOT wiped on credential expiry.

export interface FlowAnnotation {
  healthPlan?: string;
  hooId?: string;
}

export type FlowAnnotations = Record<string, FlowAnnotation>;

const KEY = "ivr_flow_annotations";

export function getAnnotations(): FlowAnnotations {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FlowAnnotations) : {};
  } catch {
    return {};
  }
}

export function getAnnotation(flowName: string): FlowAnnotation | undefined {
  return getAnnotations()[flowName];
}

/** Merge `patch` into the flow's annotation; empties drop the field (and the
 *  entry, once empty), so cleared values don't linger. */
export function setAnnotation(flowName: string, patch: Partial<FlowAnnotation>): void {
  const all = getAnnotations();
  const next: FlowAnnotation = { ...all[flowName], ...patch };
  if (!next.healthPlan) delete next.healthPlan;
  if (!next.hooId) delete next.hooId;
  if (Object.keys(next).length === 0) delete all[flowName];
  else all[flowName] = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full / unavailable — annotations are best-effort */
  }
}

export function annotationsToMap(): Map<string, FlowAnnotation> {
  return new Map(Object.entries(getAnnotations()));
}
