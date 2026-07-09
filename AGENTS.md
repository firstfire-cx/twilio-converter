# twilio-converter — Agent Context

> Stub. This repo had no agent context file; this exists to anchor the cross-repo
> relationships below. Expand with build/test commands and architecture as needed.

React/Vite editor for authoring **sandbox IVR flows** for a custom DynamoDB-backed IVR
engine. Uses an atomic-action IR (START/PLAY/GATHER/CHECK/SET/TRANSFER/HANGUP/HOURS/WAIT;
`MENU`/`LOOP`/`SNIPPET` are editor-only and expand to atomics at export). Converts NICE
CXone `scriptContent` JSON (`flows/*_Connect.json` are **inputs**) → IR
(`src/converter/convertCXJson.ts`) → **DynamoDB rows written to the `TwilioIVRFlows`
table** (`src/components/Toolbar.tsx`, `src/utils/flowUpload.ts`). It does **not** emit
Amazon Connect contact-flow JSON.

## Related systems

Full map: [`../aws-sync-system/SYSTEM.md`](../aws-sync-system/SYSTEM.md).

**You are a feeder** — sandbox IVR authoring whose output is ported to prod.

- **`../srh-aws-connect`** ← you feed it. Your `TwilioIVRFlows` rows are consumed by its
  `TwilioIVREngine/` Lambda; ported to prod via that repo's `seed/` pipeline. Your writer
  (`Toolbar.tsx`/`flowUpload.ts`) must match the engine's `FlowStep` model + action registry.
  **Frozen spec:** [`../aws-sync-system/contracts/twilio-ivr-flow.contract.md`](../aws-sync-system/contracts/twilio-ivr-flow.contract.md).
  Remember: `queueArn`/skill refs are **placeholders** injected only after the target Connect
  resources are provisioned — resolved per-environment, not at author time.
- **`../awsync-tool`** — the company-wide platform that will eventually manage cross-account
  sync/drift (incl. Connect resources). Your sandbox-vs-prod drift is the problem it generalizes;
  you're a concrete case, not a direct integration today.
