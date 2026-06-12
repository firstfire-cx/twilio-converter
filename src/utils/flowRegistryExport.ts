// src/utils/flowRegistryExport.ts
//
// Pure exporters for a FlowRegistry → Markdown / CSV / JSON. No DOM access (the
// download wiring lives in the panel) so these stay unit-testable. All three
// render from the same registry, so they reflect live AWS state at build time.

import Papa from "papaparse";
import type { FlowRegistry, FlowRow } from "./flowRegistry";

function cap(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Flatten one row into an ordered column → value map for tabular exports. */
function flatRow(reg: FlowRegistry, row: FlowRow): Record<string, string> {
  const out: Record<string, string> = { "Health Plan": row.healthPlan ?? "" };
  if (reg.envLabels.length > 1) out["Join Status"] = row.joinStatus;
  for (const label of reg.envLabels) {
    const e = row.envs[label];
    const p = cap(label);
    out[`${p} Flow`] = e?.rawFlowId ?? "";
    out[`${p} Numbers`] = e ? e.dialedNumbers.join("; ") : "";
    out[`${p} HOO`] = e?.hooName ?? e?.hooArn ?? "";
    out[`${p} Status`] = e ? e.liveStatus : "—";
  }
  return out;
}

/** Stable column order, derived from a representative flat row. */
function columns(reg: FlowRegistry): string[] {
  const out: string[] = ["Health Plan"];
  if (reg.envLabels.length > 1) out.push("Join Status");
  for (const label of reg.envLabels) {
    const p = cap(label);
    out.push(`${p} Flow`, `${p} Numbers`, `${p} HOO`, `${p} Status`);
  }
  return out;
}

export function toMarkdown(reg: FlowRegistry): string {
  const cols = columns(reg);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  if (reg.rows.length === 0) return [header, sep].join("\n");
  const body = reg.rows.map((r) => {
    const fr = flatRow(reg, r);
    return `| ${cols.map((c) => fr[c] ?? "").join(" | ")} |`;
  });
  return [header, sep, ...body].join("\n");
}

export function toCsv(reg: FlowRegistry): string {
  const cols = columns(reg);
  return Papa.unparse({ fields: cols, data: reg.rows.map((r) => {
    const fr = flatRow(reg, r);
    return cols.map((c) => fr[c] ?? "");
  }) });
}

export function toJson(reg: FlowRegistry): string {
  return JSON.stringify(
    {
      generatedAt: reg.generatedAt.toISOString(),
      envLabels: reg.envLabels,
      drift: reg.drift,
      rows: reg.rows.map((r) => ({
        flowKey: r.flowKey,
        healthPlan: r.healthPlan ?? null,
        joinStatus: r.joinStatus,
        envs: r.envs,
      })),
    },
    null,
    2,
  );
}
