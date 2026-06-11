import { describe, it, expect } from "vitest";
import { unreachableStepIds } from "./flowPrune";
import type { IVRNode } from "../types";

function node(step_id: string, action_type: any, opts: Partial<IVRNode> = {}): IVRNode {
  return { step_id, action_type, label: step_id, content: { branches: {} }, ...opts };
}

describe("unreachableStepIds", () => {
  it("finds steps not reachable from the start", () => {
    const nodes: Record<string, IVRNode> = {
      start: node("start", "START", { default_next: "a" }),
      a: node("a", "PLAY", { content: { branches: { "1": "b" } } }),
      b: node("b", "HANGUP"),
      orphan1: node("orphan1", "PLAY", { default_next: "orphan2" }),
      orphan2: node("orphan2", "HANGUP"),
    };
    expect(unreachableStepIds(nodes, "start").sort()).toEqual(["orphan1", "orphan2"]);
  });

  it("returns nothing when all steps are reachable", () => {
    const nodes: Record<string, IVRNode> = {
      start: node("start", "START", { default_next: "a" }),
      a: node("a", "HANGUP"),
    };
    expect(unreachableStepIds(nodes, "start")).toEqual([]);
  });

  it("falls back to the START node when startStep is missing", () => {
    const nodes: Record<string, IVRNode> = {
      s: node("s", "START", { default_next: "a" }),
      a: node("a", "HANGUP"),
      dead: node("dead", "PLAY"),
    };
    expect(unreachableStepIds(nodes, undefined)).toEqual(["dead"]);
  });
});
