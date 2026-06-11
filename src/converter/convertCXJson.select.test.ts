import { describe, it, expect } from "vitest";
import { convertCxJson } from "./convertCXJson";
import type { IVRNode } from "../types";

/**
 * CXone snippets use two case-dispatch forms:
 *   SWITCH var { CASE value { … } }            ← single variable, scalar values
 *   SELECT    { CASE <bool expression> { … } } ← arbitrary compound conditions
 *
 * The SELECT form (used by "Assign Skill" snippets to route on lang + skillRES)
 * must produce one CHECK node per CASE, gating that case's SET assignments.
 * Regression: the parser only understood SWITCH, so SELECT cases collapsed into
 * unconditional SET chains with no CHECK gating ("missing Check nodes").
 */
function makeSelectScript(data: string) {
  return {
    scriptContent: {
      header: { scriptName: "SelectTest" },
      actions: {
        "1": { actionId: 1, name: "BEGIN", label: "Begin" },
        "2": { actionId: 2, name: "SNIPPET", label: "Assign Skill" },
        "3": { actionId: 3, name: "HANGUP", label: "Hangup" },
      },
      properties: {
        "2": { "0": { name: "Data", value: data } },
      },
      branches: {
        "1": [{ to: 2, label: "", type: "default" }],
        "2": [{ to: 3, label: "", type: "default" }],
      },
    },
  };
}

const SELECT_DATA = [
  "SELECT",
  "{",
  '\tCASE lang = "EN" & skillRES = 1',
  "\t{",
  "\t\tASSIGN QueueSkill = 100",
  "\t}",
  '\tCASE lang = "SP" & skillRES = 2',
  "\t{",
  "\t\tASSIGN QueueSkill = 200",
  "\t}",
  "}",
].join("\r\n");

describe("SELECT / compound-CASE snippet expansion", () => {
  const ir = convertCxJson(makeSelectScript(SELECT_DATA));
  const snipNodes = Object.values(ir.nodes).filter((n: IVRNode) =>
    n.step_id.startsWith("sn2"),
  );
  const checks = snipNodes.filter((n) => n.action_type === "CHECK");

  it("emits one CHECK node per SELECT case", () => {
    expect(checks).toHaveLength(2);
  });

  it("normalises each compound CASE into a Python boolean expression with quoted scalars", () => {
    const exprs = checks.map((c) => c.content.expression).sort();
    expect(exprs).toEqual([
      "Lang == 'eng' and skillRES == '1'",
      "Lang == 'spa' and skillRES == '2'",
    ]);
  });

  it("maps the custom Mandarin code MD to ISO zho", () => {
    const mdIr = convertCxJson(
      makeSelectScript(
        [
          "SELECT",
          "{",
          '\tCASE lang = "MD" & skillRES = 1',
          "\t{",
          "\t\tASSIGN QueueSkill = 300",
          "\t}",
          "}",
        ].join("\r\n"),
      ),
    );
    const mdCheck = (Object.values(mdIr.nodes) as IVRNode[]).find(
      (n) => n.action_type === "CHECK" && n.step_id.startsWith("sn2"),
    );
    expect(mdCheck?.content.expression).toBe("Lang == 'zho' and skillRES == '1'");
  });

  it("routes each CHECK's True branch to that case's SET and False to the next case", () => {
    const engCheck = checks.find(
      (c) => c.content.expression === "Lang == 'eng' and skillRES == '1'",
    )!;
    const spaCheck = checks.find(
      (c) => c.content.expression === "Lang == 'spa' and skillRES == '2'",
    )!;

    // eng True → SET QueueSkill = 100
    const engTrue = ir.nodes[engCheck.content.branches!["True"]];
    expect(engTrue.action_type).toBe("SET");
    expect(engTrue.content.assignments).toMatchObject({ QueueSkill: "100" });

    // eng False → the next case's CHECK (chained, not a fallthrough to HANGUP)
    expect(engCheck.content.branches!["False"]).toBe(spaCheck.step_id);

    // last case False → snippet's continuation (HANGUP)
    expect(spaCheck.content.branches!["False"]).toBe("s3");
  });
});
