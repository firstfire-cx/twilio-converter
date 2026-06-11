// src/utils/sipHeaders.ts
//
// SIP headers on a TRANSFER node are stored as TOP-LEVEL content keys (e.g.
// "X-UID": "{{uid}}"), matching the converter output and the twilio-ivr-flow
// lambda, which appends every non-meta content key to the SIP URI as
// &<key>=<value>. (An older model nested them under content.sipHeaders, which
// the lambda would serialize as a single bogus &sipHeaders=... param.)
//
// These pure helpers are the single place that knows the header model, so the
// editor, migration, and export all agree.

import type { IVRContent } from "../types";

// Content keys that are structural or transfer-control — never SIP headers.
// Anything else (string-valued) on a SIP node is treated as a header, mirroring
// the lambda (which only special-cases branches/assignments/expression/text).
const NON_HEADER_KEYS = new Set<string>([
  "branches",
  "assignments",
  "expression",
  "var",
  "text",
  "transferType",
  "digits",
  "agentSkill",
  "queueArn",
  "num_digits",
  "timeout",
  "variable",
  "seconds",
  "hoo_arn",
  "max_retries",
  "retry_text",
  "invalid_exit",
  "sipHeaders",
]);

// Keys retained verbatim when rewriting a SIP node's content.
const STRUCTURAL_KEYS = new Set<string>(["branches"]);

/**
 * Read the SIP headers from a TRANSFER node's content for editing.
 * Returns top-level non-meta string keys, plus any legacy `sipHeaders` sub-dict
 * (top-level keys win on conflict, as they are the canonical form).
 */
export function readSipHeaders(
  content: IVRContent | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};

  const legacy = content?.sipHeaders;
  if (legacy && typeof legacy === "object") {
    for (const [k, v] of Object.entries(legacy)) out[k] = String(v);
  }

  for (const [k, v] of Object.entries(content ?? {})) {
    if (NON_HEADER_KEYS.has(k)) continue;
    if (typeof v === "string") out[k] = v;
  }

  return out;
}

/**
 * Rewrite a SIP TRANSFER node's content with the given headers as top-level
 * keys. Drops the legacy `sipHeaders` sub-dict, any stale top-level header keys,
 * and leak-prone transfer keys (digits/agentSkill/queueArn) so nothing
 * unintended ends up in the SIP URI. Retains structural keys (branches).
 */
export function writeSipHeaders(
  content: IVRContent,
  headers: Record<string, string>,
): IVRContent {
  const next: IVRContent = { transferType: "SIP" };
  for (const [k, v] of Object.entries(content ?? {})) {
    if (STRUCTURAL_KEYS.has(k)) next[k] = v;
  }
  for (const [k, v] of Object.entries(headers)) next[k] = v;
  return next;
}
