import { describe, it, expect } from "vitest";
import { pythonJsonDumps } from "./flowSeedExport";

describe("pythonJsonDumps", () => {
  it("matches export_flows.py json.dumps(sort_keys=True): sorted keys, ', '/': ' separators, ensure_ascii", () => {
    const row = {
      step_id: "m25_gather",
      flow_id: "landing_scan_connect",
      label: "Gather → MRES",
      action_type: "GATHER",
      default_next: "m25_check",
      content: { variable: "MRES", num_digits: "1", branches: {},
        text: { eng: "Press 1.", spa: "Para español, presione 2." } },
    };
    const line = pythonJsonDumps(row);
    expect(line).toBe(
      '{"action_type": "GATHER", "content": {"branches": {}, "num_digits": "1", ' +
      '"text": {"eng": "Press 1.", "spa": "Para espa\\u00f1ol, presione 2."}, "variable": "MRES"}, ' +
      '"default_next": "m25_check", "flow_id": "landing_scan_connect", ' +
      '"label": "Gather \\u2192 MRES", "step_id": "m25_gather"}',
    );
  });
});
