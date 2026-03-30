// src/utils/skillsCSV.ts
//
// Parse a CXone Skills CSV export (columns: skill_no, skill_name, campaign_no, media_type)
// and provide lookup + reconciliation helpers for QueueRecord matching.

import type { QueueRecord } from "../project";

export interface SkillRow {
  skill_no: string;
  skill_name: string;
  campaign_no?: string;
  media_type?: string;
}

/**
 * Extract a bare numeric skill ID from any of these formats:
 *   "18556549"
 *   "18556549 //SCAN_Reserv EN"
 *   "CXone #18556549"
 *   "CXone#18556549 // some comment"
 *   " 18556549 "
 *
 * Returns the first run of 7-11 digits (a CXone skill ID),
 * or the whole trimmed string if no such run is found.
 */
function extractSkillId(raw: string): string {
  if (!raw) return "";
  // Strip everything from // onward (inline CXone snippet comments)
  const noComment = raw.replace(/\s*\/\/.*$/, "").trim();
  // Strip CXone # prefix if present
  const noPrefix = noComment.replace(/^CXone\s*#?\s*/i, "").trim();
  // Extract leading digit run (skill IDs are 7-11 digits)
  const m = noPrefix.match(/^(\d{7,11})/);
  return m ? m[1] : noPrefix;
}

/**
 * Parse a CXone skills CSV text into a map of skill_no → SkillRow.
 * Tolerates BOM, CRLF, and extra whitespace.
 */
export function parseSkillsCSV(csvText: string): Map<string, SkillRow> {
  const map = new Map<string, SkillRow>();
  const clean = csvText.replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  const lines = clean.split("\n");
  if (lines.length < 2) return map;

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const iNo = idx("skill_no");
  const iName = idx("skill_name");
  const iCampaign = idx("campaign_no");
  const iMedia = idx("media_type");

  if (iNo === -1 || iName === -1) return map;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const no = cols[iNo];
    const name = cols[iName];
    if (!no || !name) continue;
    map.set(no, {
      skill_no: no,
      skill_name: name,
      campaign_no: iCampaign >= 0 ? cols[iCampaign] : undefined,
      media_type: iMedia >= 0 ? cols[iMedia] : undefined,
    });
  }
  return map;
}

/**
 * Given a loaded skills map and an array of QueueRecords, return a new array
 * where every record whose queueSkill ID matches a CSV row has its connectName
 * updated to the canonical CSV skill_name.
 *
 * Handles queueSkill values that include inline comments
 * (e.g. "18556549 //SCAN_Reserv EN") by stripping everything after //.
 * Records whose queueSkill isn't in the CSV are left untouched.
 */
export function reconcileQueueNames(
  queues: QueueRecord[],
  skills: Map<string, SkillRow>,
): { queues: QueueRecord[]; changed: number; unmatched: string[] } {
  let changed = 0;
  const unmatched: string[] = [];

  const updated = queues.map((q) => {
    const skillId = extractSkillId(q.queueSkill ?? "");
    if (!skillId) return q;

    const row = skills.get(skillId);
    if (!row) {
      unmatched.push(skillId);
      return q;
    }
    if (row.skill_name !== q.connectName) {
      changed++;
      return { ...q, connectName: row.skill_name };
    }
    return q;
  });

  return { queues: updated, changed, unmatched: [...new Set(unmatched)] };
}
