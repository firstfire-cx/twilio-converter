import { describe, it, expect } from "vitest";
import { mergePersistedQueues } from "./project";
import type { QueueRecord } from "./project";

describe("mergePersistedQueues", () => {
  it("preserves an edited connectName / ARN for a matching skillWhisper", () => {
    // This is the panel-sync bug: a CXone-loaded flow's queue was renamed and
    // persisted; reseeding from the raw whispers must not clobber the rename.
    const extracted = [{ skillWhisper: "CHP-Reservations-EN", queueSkill: "111" }];
    const persisted: QueueRecord[] = [
      {
        skillWhisper: "CHP-Reservations-EN",
        connectName: "CHP Reservations English",
        queueArn: "arn:q1",
        queueId: "id1",
      },
    ];

    const [row] = mergePersistedQueues(extracted, persisted);
    expect(row.connectName).toBe("CHP Reservations English"); // edited name kept
    expect(row.queueArn).toBe("arn:q1");
    expect(row.queueId).toBe("id1");
    expect(row.queueSkill).toBe("111"); // fresh value from the flow
  });

  it("defaults connectName to skillWhisper for a whisper with no persisted record", () => {
    const [row] = mergePersistedQueues([{ skillWhisper: "New-Skill" }], []);
    expect(row.connectName).toBe("New-Skill");
    expect(row.queueArn).toBeUndefined();
  });

  it("keeps the fresh queueSkill but falls back to persisted when absent", () => {
    const persisted: QueueRecord[] = [
      { skillWhisper: "S", connectName: "S", queueSkill: "999" },
    ];
    expect(mergePersistedQueues([{ skillWhisper: "S" }], persisted)[0].queueSkill).toBe(
      "999",
    );
    expect(
      mergePersistedQueues([{ skillWhisper: "S", queueSkill: "111" }], persisted)[0]
        .queueSkill,
    ).toBe("111");
  });
});
