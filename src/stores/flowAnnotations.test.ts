import { describe, it, expect, beforeEach } from "vitest";
import { getAnnotation, setAnnotation, annotationsToMap } from "./flowAnnotations";

beforeEach(() => {
  let store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    key: () => null,
    length: 0,
  } as any;
});

describe("flowAnnotations", () => {
  it("stores and retrieves a plan name by flow name", () => {
    setAnnotation("landing_kp_co", { healthPlan: "KP Colorado" });
    expect(getAnnotation("landing_kp_co")).toEqual({ healthPlan: "KP Colorado" });
  });

  it("merges patches and exposes a map", () => {
    setAnnotation("F", { healthPlan: "Plan" });
    setAnnotation("F", { hooId: "hoo-1" });
    expect(getAnnotation("F")).toEqual({ healthPlan: "Plan", hooId: "hoo-1" });
    expect(annotationsToMap().get("F")).toEqual({ healthPlan: "Plan", hooId: "hoo-1" });
  });

  it("drops a field (and an emptied entry) when set to empty", () => {
    setAnnotation("F", { healthPlan: "Plan" });
    setAnnotation("F", { healthPlan: "" });
    expect(getAnnotation("F")).toBeUndefined();
  });

  it("returns an empty object when storage is corrupt", () => {
    globalThis.localStorage.setItem("ivr_flow_annotations", "{not json");
    expect(annotationsToMap().size).toBe(0);
  });
});
