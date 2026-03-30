// src/types.ts

/**
 * Atomic action types — the only types the engine runtime handles.
 * These are the only nodes that should appear in exported IR.
 */
export type AtomicActionType =
  | "START"
  | "PLAY"
  | "GATHER" // replaced MENU — collects DTMF, stores into variable
  | "CHECK" // expression mode (True/False) or var mode (digit branches)
  | "SET" // assigns variables to state
  | "TRANSFER"
  | "HANGUP"
  | "HOURS"
  | "WAIT";

/**
 * All action types valid in the editor IR.
 * MENU is editor-only — it expands to SET+GATHER+CHECK+SET+CHECK at export.
 * Nothing else beyond atomics should be created manually.
 */
export type ActionType = AtomicActionType | "MENU";

/**
 * Prompt text keyed by ISO 639-2/B language code (e.g. "eng", "spa", "fra").
 * At least one key is expected; "eng" is the conventional default.
 */
export type SayText = Record<string, string>;

export interface IVRContent {
  // Common
  branches?: Record<string, string>;

  // SET
  assignments?: Record<string, string | null>;

  // CHECK
  expression?: string;
  var?: string; // CHECK var-mode: branch on this variable's value

  // PLAY / GATHER
  text?: SayText | string;

  // GATHER
  num_digits?: string;
  timeout?: string;
  variable?: string; // variable to store gathered digit into

  // MENU (editor-only, expanded at export)
  max_retries?: number;
  retry_text?: SayText;
  invalid_exit?: string;

  // TRANSFER
  transferType?: "CONNECT" | "SIP";
  digits?: string;
  agentSkill?: string;
  /** Resolved queue ARN — injected by Skills & Queues after provisioning */
  queueArn?: string;
  /** SIP header overrides for SIP-type transfers */
  sipHeaders?: Record<string, string>;

  // WAIT
  seconds?: string;

  // HOURS
  hoo_arn?: string;

  [key: string]: any;
}

export interface IVRNode {
  step_id: string;
  action_type: ActionType;
  label: string;
  content: IVRContent;
  default_next?: string;
  flow_id?: string;
}

export interface IR {
  flow_id: string;
  nodes: Record<string, IVRNode>;
  start_step?: string;
  hoo_arn?: string;
  meta?: Partial<FlowMeta>; // Flow metadata stored with IR
}

/**
 * Flow metadata uploaded to DynamoDB alongside the flow steps.
 *
 * DynamoDB META item schema (partition key = dialed_number, sort key = "META"):
 *   flow_id (PK)      → dialed_number  (the phone number that routes here)
 *   step_id (SK)      → "META"
 *   target_flow_id    → which flow rows to load (matches IR.flow_id / the CSV name)
 *   start_step        → first step ID (default "start")
 *   hoo_arn           → Connect hours-of-operation ARN or bare UUID
 *   instance_id       → Connect instance ID (overrides INSTANCE_ID lambda env var)
 *   description       → human-readable label (unused by engine)
 *
 * handler.py reads: target_flow_id, start_step, hoo_arn, instance_id
 */
export interface FlowMeta {
  dialed_number: string; // becomes the DDB partition key (flow_id column)
  target_flow_id: string; // which flow to load — maps to IR.flow_id
  start_step: string; // first step ID
  hoo_arn?: string; // Connect HOO ARN or UUID
  instance_id?: string; // Connect instance ID
  description?: string; // human label, not used by engine
}

