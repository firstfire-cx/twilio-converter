import { describe, it, expect } from "vitest";
import {
  convertCxJson,
  applyAllPostProcessing,
  applyP6NormalisePolyHandoff,
  applyP7bConvertExprChains,
  applyP11NestCompoundChecks,
} from "./convertCXJson";
import type { IR, IVRNode } from "../types";

function check(
  id: string,
  expression: string,
  branches: Record<string, string>,
): IVRNode {
  return { step_id: id, action_type: "CHECK", label: id, content: { expression, branches } };
}
function set(id: string, assignments: Record<string, string>): IVRNode {
  return { step_id: id, action_type: "SET", label: id, content: { assignments, branches: {} } };
}
function makeIR(nodes: IVRNode[], start: string): IR {
  return {
    flow_id: "t",
    start_step: start,
    nodes: Object.fromEntries(nodes.map((n) => [n.step_id, n])),
  };
}

describe("P7b — convert expression chains to var-mode CHECKs", () => {
  it("collapses a genuine single-variable equality chain (its intended job)", () => {
    const ir = makeIR(
      [
        check("a", "QueueSkill == '111'", { True: "setA", False: "b" }),
        check("b", "QueueSkill == '222'", { True: "setB", False: "END" }),
        set("setA", { x: "1" }),
        set("setB", { x: "2" }),
      ],
      "a",
    );
    const { ir: out } = applyP7bConvertExprChains(ir);
    expect(out.nodes.a.content.var).toBe("QueueSkill");
    expect(out.nodes.a.content.expression).toBeUndefined();
    expect(out.nodes.a.content.branches).toMatchObject({
      "111": "setA",
      "222": "setB",
      null: "END",
    });
  });

  it("does NOT collapse compound expressions — the second condition must be preserved", () => {
    // Two cases share Lang=='eng' but differ on skillRES. Collapsing on Lang
    // alone would make them collide and drop one queue (the routing bug).
    const ir = makeIR(
      [
        check("a", "Lang == 'eng' and skillRES == '1'", { True: "resEN", False: "b" }),
        check("b", "Lang == 'eng' and skillRES == '2'", { True: "wmrEN", False: "END" }),
        set("resEN", { QueueSkill: "18556816" }),
        set("wmrEN", { QueueSkill: "18556823" }),
      ],
      "a",
    );
    const { ir: out } = applyP7bConvertExprChains(ir);

    // Head must remain an expression CHECK, not a var-mode collapse.
    expect(out.nodes.a.content.expression).toBe("Lang == 'eng' and skillRES == '1'");
    expect(out.nodes.a.content.var).toBeUndefined();

    // Both distinct queue targets remain reachable and distinct.
    expect(out.nodes.resEN).toBeDefined();
    expect(out.nodes.wmrEN).toBeDefined();
    expect(out.nodes.b?.content.expression).toBe("Lang == 'eng' and skillRES == '2'");
  });
});

function varCheck(
  id: string,
  varName: string,
  branches: Record<string, string>,
): IVRNode {
  return {
    step_id: id,
    action_type: "CHECK",
    label: id,
    content: { var: varName, branches },
  };
}
function hangup(id: string): IVRNode {
  return { step_id: id, action_type: "HANGUP", label: id, content: { branches: {} } };
}

/**
 * BrightHealth-shaped fixture: a skillRES menu CHECK whose digit branches funnel
 * into a flat chain of `Lang == x and skillRES == d` compound CHECKs.
 */
function brightHealthShape(): IR {
  return makeIR(
    [
      varCheck("m", "skillRES", { "1": "c1", "2": "c1" }),
      check("c1", "Lang == 'eng' and skillRES == '1'", { True: "resEN", False: "c2" }),
      check("c2", "Lang == 'spa' and skillRES == '1'", { True: "resSP", False: "c3" }),
      check("c3", "Lang == 'eng' and skillRES == '2'", { True: "wmrEN", False: "c4" }),
      check("c4", "Lang == 'spa' and skillRES == '2'", { True: "wmrSP", False: "next" }),
      set("resEN", { QueueSkill: "1" }),
      set("resSP", { QueueSkill: "2" }),
      set("wmrEN", { QueueSkill: "3" }),
      set("wmrSP", { QueueSkill: "4" }),
      hangup("next"),
    ],
    "m",
  );
}

describe("P6 — PolyAI handoff uses bare variable references (no {{ }})", () => {
  // The lambda resolves SET values via eval_value: a bare name is a direct
  // vars_map lookup (works for hyphenated keys), but {{(\w+)}} can't match the
  // hyphen in DialSipHeader_X-Handoff — so braces store the literal string and
  // the CHECK is always false. SET/CHECK take bare refs; only TRANSFER uses {{ }}.
  function polyHandoffIR(): IR {
    return makeIR(
      [
        {
          step_id: "sip",
          action_type: "TRANSFER",
          label: "Forward to PolyAI",
          content: { transferType: "SIP", branches: {} },
          default_next: "play",
        },
        {
          step_id: "play",
          action_type: "PLAY",
          label: "",
          content: { text: { eng: "" }, branches: {} },
          default_next: "setReason",
        },
        set("setReason", { PolyReason: "{SP2}" }),
        set("setNote", { PolyNote: "{SP3}" }),
        {
          step_id: "req",
          action_type: "TRANSFER",
          label: "Reqagent",
          content: { transferType: "CONNECT", digits: "{{uid}}", branches: {} },
        },
      ],
      "sip",
    );
  }

  it("emits SET Handoff / HandoffReason as bare DialSipHeader refs", () => {
    // wire the SET chain: setReason -> setNote -> req
    const ir = polyHandoffIR();
    ir.nodes.setReason.default_next = "setNote";
    ir.nodes.setNote.default_next = "req";

    const { ir: out } = applyP6NormalisePolyHandoff(ir);
    const sets = (Object.values(out.nodes) as IVRNode[]).filter(
      (n) => n.action_type === "SET",
    );
    const handoff = sets.find((n) => "Handoff" in (n.content.assignments ?? {}));
    const reason = sets.find((n) => "HandoffReason" in (n.content.assignments ?? {}));

    expect(handoff?.content.assignments?.Handoff).toBe("DialSipHeader_X-Handoff");
    expect(reason?.content.assignments?.HandoffReason).toBe(
      "DialSipHeader_X-HandoffReason",
    );
    // No braces anywhere in these SET values.
    expect(JSON.stringify(handoff?.content.assignments)).not.toContain("{{");
    expect(JSON.stringify(reason?.content.assignments)).not.toContain("{{");
  });
});

describe("P11 — nest compound menu checks (CareFirst shape)", () => {
  it("repoints the menu CHECK per digit into a per-digit inner Lang CHECK", () => {
    const { ir: out } = applyP11NestCompoundChecks(brightHealthShape());

    // Outer check stays var-mode on skillRES.
    expect(out.nodes.m.content.var).toBe("skillRES");

    const inner1Id = out.nodes.m.content.branches!["1"];
    const inner2Id = out.nodes.m.content.branches!["2"];
    expect(inner1Id).toBeTruthy();
    expect(inner2Id).toBeTruthy();
    expect(inner1Id).not.toBe(inner2Id); // each digit gets its own inner check
    // No longer pointing at the old compound chain head.
    expect(inner1Id).not.toBe("c1");

    // skillRES == 1 → inner Lang check routing to the Reservations queues.
    const inner1 = out.nodes[inner1Id];
    expect(inner1.content.var).toBe("Lang");
    expect(inner1.content.branches).toMatchObject({ eng: "resEN", spa: "resSP" });

    // skillRES == 2 → inner Lang check routing to the WMR queues.
    const inner2 = out.nodes[inner2Id];
    expect(inner2.content.var).toBe("Lang");
    expect(inner2.content.branches).toMatchObject({ eng: "wmrEN", spa: "wmrSP" });

    // The inner checks fall through to the chain's terminal target.
    expect(inner1.content.branches!["null"] ?? inner1.default_next).toBe("next");
  });

  it("is idempotent", () => {
    const once = applyP11NestCompoundChecks(brightHealthShape()).ir;
    const twice = applyP11NestCompoundChecks(once).ir;
    expect(twice.nodes).toEqual(once.nodes);
  });

  it("leaves single-conjunct chains untouched (CareFirst-style IF Lang, not compound)", () => {
    const ir = makeIR(
      [
        varCheck("m", "CFHMenu_RES", { "1": "ifA", "2": "ifB" }),
        check("ifA", "Lang == 'spa'", { True: "resSP", False: "resEN" }),
        check("ifB", "Lang == 'spa'", { True: "wmrSP", False: "wmrEN" }),
        set("resEN", { QueueSkill: "1" }),
        set("resSP", { QueueSkill: "2" }),
        set("wmrEN", { QueueSkill: "3" }),
        set("wmrSP", { QueueSkill: "4" }),
      ],
      "m",
    );
    const before = JSON.stringify(ir.nodes);
    const { ir: out } = applyP11NestCompoundChecks(ir);
    expect(JSON.stringify(out.nodes)).toBe(before);
  });
});

/**
 * End-to-end guard over the convertCxJson → applyAllPostProcessing seam.
 * P11's correctness depends on its pipeline position (after P7b, before P8/P9).
 * The synthetic unit tests above would stay green if the pipeline were
 * reordered; this test pins the whole chain against a real CXone-shaped input.
 */
function makeMenuSelectScript() {
  // CXone formats each CASE / brace / ASSIGN on its own line (matches real files).
  const caseBlock = (lang: string, res: number, qs: number) =>
    [`\tCASE lang = "${lang}" & skillRES = ${res}`, "\t{", `\t\tASSIGN QueueSkill = ${qs}`, "\t}"];
  const SELECT = [
    "SELECT",
    "{",
    ...caseBlock("EN", 1, 111),
    ...caseBlock("SP", 1, 222),
    ...caseBlock("EN", 2, 333),
    ...caseBlock("SP", 2, 444),
    "}",
  ].join("\r\n");
  return {
    scriptContent: {
      header: { scriptName: "MenuSelect" },
      actions: {
        "1": { actionId: 1, name: "BEGIN", label: "Begin" },
        "2": { actionId: 2, name: "MENU", label: "Skill Menu" },
        "3": { actionId: 3, name: "SNIPPET", label: "Assign Skill" },
        "4": { actionId: 4, name: "HANGUP", label: "Hangup" },
        "5": { actionId: 5, name: "HANGUP", label: "Done" },
      },
      properties: {
        "2": {
          "0": { name: "Phrase", value: "Press 1 or 2" },
          "1": { name: "Variable", value: "skillRES" },
          "2": { name: "MaxDigits", value: "1" },
        },
        "3": { "0": { name: "Data", value: SELECT } },
      },
      branches: {
        "1": [{ to: 2, label: "" }],
        "2": [
          { to: 3, label: "1" },
          { to: 3, label: "2" },
          { to: 4, label: "" },
        ],
        "3": [{ to: 5, label: "" }],
      },
    },
  };
}

describe("integration: SELECT snippet → full post-processing → nested checks", () => {
  it("converts a flat compound SELECT into a nested skillRES → Lang tree", () => {
    const ir0 = convertCxJson(makeMenuSelectScript());
    const { ir } = applyAllPostProcessing(ir0);

    // The skill menu's var-mode CHECK on skillRES.
    const menu = (Object.values(ir.nodes) as IVRNode[]).find(
      (n) => n.action_type === "CHECK" && n.content.var === "skillRES",
    );
    expect(menu).toBeDefined();

    const t1 = menu!.content.branches!["1"];
    const t2 = menu!.content.branches!["2"];
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2); // distinct inner checks per digit

    // Each digit branch lands on an inner var-mode CHECK on Lang.
    expect(ir.nodes[t1].content.var).toBe("Lang");
    expect(ir.nodes[t2].content.var).toBe("Lang");

    // No compound (two-conjunct) CHECK survives anywhere.
    const compoundLeft = (Object.values(ir.nodes) as IVRNode[]).some((n) =>
      / and /.test(n.content?.expression ?? ""),
    );
    expect(compoundLeft).toBe(false);

    // Referential integrity: every branch/default target exists (or is END).
    const ids = new Set(Object.keys(ir.nodes));
    const ok = (t?: string) => !t || t === "END" || t === "" || ids.has(t);
    for (const n of Object.values(ir.nodes) as IVRNode[]) {
      expect(ok(n.default_next)).toBe(true);
      for (const v of Object.values(n.content?.branches ?? {}))
        expect(ok(v as string)).toBe(true);
    }
  });
});
