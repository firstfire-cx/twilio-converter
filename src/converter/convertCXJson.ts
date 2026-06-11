// src/converter/convertCXJson.ts
/**
 * convertCXJson.ts — CXone Studio JSON → Engine IR (fully atomic)
 *
 * Fix log (v5):
 *   [1] Lang value mismatch: normalizeExpr() rewrites "EN"→"eng", "SP"/"ES"→"spa"
 *       in ALL CHECK expressions so they match set_action.py's normalized state.
 *   [2] Snippet-internal expressions now also run through normalizeExpr(), fixing
 *       both the = → == and Lang value problems in SNIPPET-generated CHECK nodes.
 *   [3] MENU with no LOOP (language-offer menus): null branch goes directly to
 *       the source's default target — no synthetic retry loop created.
 *   [4] Skill menus (default→IF, not LOOP): same fix as #3, no spurious retry.
 *   [5] Sendero MENU 61 (no '' branch at all): null routes to END cleanly.
 *   [6] Counter init value emitted as integer 0, not string "0".
 *   [7] Variable reset emits JSON null (not string "null") so state.get_var()
 *       returns None and CHECK var-mode correctly hits the null branch.
 *   [8] Deferred lang default (deferLangDefault): upfront SET Lang=eng nodes are
 *       bypassed so Lang is only set when the caller explicitly chooses a language.
 *       Lang stays unset for callers who time out → engine plays bilingual prompts.
 *
 * Post-processing passes (applyLandingTransforms):
 *   [P1] BlockCall bypass: "IF BlockCall = 1" is always false in live flows.
 *        Replace the CHECK node with a direct link to its False branch target,
 *        and delete the True-branch subtree (ineligible message + hangup).
 *   [P2] Lang value normalisation in SET assignments: "EN"→"eng", "SP"/"ES"→"spa".
 *   [P3] Language menu English-first: if the lang-select CHECK has a "2" branch
 *        for English and "1" for Spanish, swap them so 1=English, 2=Spanish.
 *   [P4] Remove null CHECK branches where default_next covers the same target.
 *   [P5] Merge sequential SET nodes that share no branches into one.
 *        Also strips inline CXone comments (// …) from assignment values.
 *   [P6] PolyAI handoff normalisation: the old PolyReason/PolyNote assign chain
 *        after SPAWN is replaced by the correct pattern:
 *          SET Handoff = DialSipHeader_X-Handoff
 *          CHECK Handoff == "Yes" → True: SET HandoffReason + REQAGENT, False: HANGUP
 */

import type { IR, IVRNode, SayText } from "../types";

// ─── Language code map ────────────────────────────────────────────────────────
/**
 * Maps CXone / common short codes (upper-cased) → ISO 639-2/B codes.
 * Used by parseBilingual, normalizeExpr, _p2_normaliseLangAssignments,
 * and validateAndNormalizeLanguages.
 */
export const LANG_CODE_MAP: Record<string, string> = {
  EN: "eng",  ENG: "eng",
  SP: "spa",  ES:  "spa",  SPA: "spa",
  FR: "fra",  FRA: "fra",
  DE: "deu",  DEU: "deu",
  IT: "ita",  ITA: "ita",
  PT: "por",  POR: "por",
  ZH: "zho",  ZHO: "zho",  MD: "zho",  // MD = Mandarin (CXone custom code)
  JA: "jpn",  JP:  "jpn",  JPN: "jpn",
  KO: "kor",  KOR: "kor",
  RU: "rus",  RUS: "rus",
  AR: "ara",  ARA: "ara",
  HI: "hin",  HIN: "hin",
  VI: "vie",  VIE: "vie",
  PL: "pol",  POL: "pol",
  NL: "nld",  NLD: "nld",
};

// ─── Expression normalizer ────────────────────────────────────────────────────
/**
 * Normalises a CXone expression for the Python engine:
 *
 * 1. Single = → ==  (CXone uses = for equality)
 *    Skips !=, <=, >=, already-doubled ==
 *
 * 2. Lang comparison values rewritten to match set_action.py normalization.
 *    Any short code found in LANG_CODE_MAP is replaced with its ISO 639-2 form:
 *    e.g.  Lang == 'EN' → Lang == 'eng'
 *          Lang != 'SP' → Lang != 'spa'
 *          Lang == 'FR' → Lang == 'fra'
 */
function normalizeExpr(expr: string): string {
  if (!expr) return expr;

  // 1. single = → ==  (negative lookbehind for ! < > =, negative lookahead for =)
  let out = expr.replace(/(?<![!<>=])=(?!=)/g, "==");

  // 2. Lang value normalization — map any known short code to ISO 639-2
  out = out.replace(
    /\bLang\s*(==|!=)\s*["']([A-Z]{2,4})["']/gi,
    (match, op, code) => {
      const iso = LANG_CODE_MAP[code.toUpperCase()];
      return iso ? `Lang ${op} '${iso}'` : match;
    },
  );

  return out;
}

// ─── Prop helper ──────────────────────────────────────────────────────────────
function getProps(raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  Object.values(raw || {}).forEach((p: any) => {
    if (p?.name != null) out[p.name] = p.value ?? "";
  });
  return out;
}

// ─── Multi-language phrase parser ─────────────────────────────────────────────
/**
 * Parse a CXone phrase string that may contain multiple language sections.
 *
 * Supported section header formats (case-insensitive code, separator required):
 *   EN - text     SP: text     FR-text     DE  -  text
 *
 * Language codes are mapped to ISO 639-2 via LANG_CODE_MAP.  Unknown codes are
 * kept as-is (lower-cased).  Unrecognised codes already in ISO 639-2 form pass
 * through unchanged.
 *
 * If no section headers are detected the whole phrase is returned as { eng }.
 */

// A line is a language header when it starts with 2–4 uppercase letters
// followed (with optional surrounding spaces) by a dash or colon separator.
const LANG_SECTION_RE = /^\s*([A-Z]{2,4})\s*[-:]\s*(.*)/;

export function parseBilingual(phrase: string): SayText {
  if (!phrase) return { eng: "" };

  const lines = phrase.replace(/\r/g, "").split("\n");

  // Fast path: no section headers → treat whole string as English
  if (!lines.some(l => LANG_SECTION_RE.test(l))) {
    return { eng: phrase.trim() };
  }

  const result: Record<string, string> = {};
  let currentCode: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentCode !== null) {
      const text = currentLines.join("\n").trim();
      if (text) result[currentCode] = text;
    }
  };

  for (const line of lines) {
    const m = line.match(LANG_SECTION_RE);
    if (m) {
      flush();
      const rawCode = m[1].toUpperCase();
      currentCode = LANG_CODE_MAP[rawCode] ?? rawCode.toLowerCase();
      currentLines = [m[2]]; // remainder of the header line is the first content line
    } else if (currentCode !== null) {
      currentLines.push(line);
    }
    // lines before the first header (typically empty) are discarded
  }
  flush();

  return Object.keys(result).length > 0 ? result : { eng: phrase.trim() };
}

// ─── Snippet parser ───────────────────────────────────────────────────────────
interface AssignOp {
  condition?: string;
  variable: string;
  value: string;
}
interface SnipCase {
  switchVar?: string;
  switchVal?: string;
  /** Full boolean expression for SELECT-style cases (CASE <expr> { … }). */
  caseExpr?: string;
  ops: AssignOp[];
}

// ─── CASE-expression normalizer (SELECT blocks) ───────────────────────────────
/**
 * Normalises a CXone SELECT-case boolean expression for the Python engine:
 *   1. normalizeExpr — single = → ==, Lang short codes → ISO 639-2.
 *   2. & / && → `and`, | / || → `or`  (Python logical ops with correct
 *      precedence; bare `&` binds tighter than `==` and would mis-parse).
 *   3. Bare numeric operands get quoted (skillRES == 1 → skillRES == '1') so
 *      they compare as strings, matching the SWITCH path (langRES == '3') and
 *      how digit/menu variables are stored.
 * Scoped to CASE expressions only — global normalizeExpr must stay number-safe
 * for checks like BlockCall == 1 and counter < 3.
 */
function normalizeCaseExpr(expr: string): string {
  let out = normalizeExpr(expr);
  out = out.replace(/&&?/g, " and ").replace(/\|\|?/g, " or ");
  out = out.replace(/(==|!=)\s*(\d+)\b/g, "$1 '$2'");
  return out.replace(/\s+/g, " ").trim();
}

function parseSnippet(data: string): SnipCase[] {
  const lines = data
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim());
  const cases: SnipCase[] = [];
  let switchVar: string | undefined;
  let selectMode = false;
  let currentCond: string | undefined;
  let inElse = false;

  const ensureCase = () => {
    if (cases.length === 0) cases.push({ switchVar, ops: [] });
  };

  for (const line of lines) {
    if (!line || line.startsWith("//")) continue;

    const sw = line.match(/^SWITCH\s+(\w+)/i);
    if (sw) {
      switchVar = sw[1];
      selectMode = false;
      continue;
    }

    // SELECT { CASE <bool expr> { … } } — switch-less, compound conditions.
    if (/^SELECT\b/i.test(line)) {
      selectMode = true;
      switchVar = undefined;
      continue;
    }

    const cs = line.match(/^CASE\s+(.+)/i);
    if (cs) {
      const rest = cs[1].trim();
      if (selectMode && !switchVar) {
        // Whole remainder is the case's boolean expression.
        cases.push({ caseExpr: rest, ops: [] });
      } else {
        // SWITCH mode: value is the first token (e.g. "1" from "1 DEFAULT").
        cases.push({ switchVar, switchVal: rest.split(/\s+/)[0], ops: [] });
      }
      currentCond = undefined;
      inElse = false;
      continue;
    }

    const ifm = line.match(/^IF\s+(.+)/i);
    if (ifm) {
      ensureCase();
      currentCond = ifm[1].trim();
      inElse = false;
      continue;
    }

    if (/^ELSE$/i.test(line)) {
      inElse = true;
      continue;
    }

    const am = line.match(/^ASSIGN\s+(\w+)\s*=\s*(.+)/i);
    if (am) {
      ensureCase();
      const cleanVal = am[2].trim().replace(/^"(.*)"$/, "$1");
      cases[cases.length - 1].ops.push({
        condition: inElse ? undefined : currentCond,
        variable: am[1],
        value: cleanVal,
      });
    }
  }
  return cases;
}

// ─── SkillWhisper extractor ───────────────────────────────────────────────────
export interface SkillInfo {
  queueSkill: string;
  skillWhisper: string;
}

export function extractSkillWhispers(raw: any): SkillInfo[] {
  const sc = raw.scriptContent ?? raw;
  const propsMap = sc.properties ?? {};
  const actionsMap = sc.actions ?? {};
  const found = new Map<string, string>();

  for (const [aid, action] of Object.entries(actionsMap) as [string, any][]) {
    if (action.name !== "SNIPPET") continue;
    let data = "";
    for (const pv of Object.values(propsMap[aid] ?? {}) as any[]) {
      if (pv?.name === "Data") data = pv.value ?? "";
    }
    const cases = parseSnippet(data);
    for (const c of cases) {
      let qs = "",
        sw = "";
      for (const op of c.ops) {
        if (op.variable.toLowerCase() === "queueskill") qs = op.value;
        if (op.variable.toLowerCase() === "skillwhisper") sw = op.value;
        if (qs && sw) {
          found.set(qs, sw);
          qs = "";
          sw = "";
        }
      }
    }
  }
  return Array.from(found.entries()).map(([queueSkill, skillWhisper]) => ({
    queueSkill,
    skillWhisper,
  }));
}

// ─── Snippet node expander ────────────────────────────────────────────────────
function expandSnippet(
  aid: string,
  label: string,
  data: string,
  snippetNextId: string,
  nodes: Record<string, IVRNode>,
): string {
  const cases = parseSnippet(data);
  if (cases.length === 0) {
    const id = `sn${aid}`;
    nodes[id] = {
      step_id: id,
      action_type: "SET",
      label,
      content: { branches: {} },
      default_next: snippetNextId,
    };
    return id;
  }

  let entryId = "";
  let prevIfIds: string[] = [];

  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    const prefix = `sn${aid}_c${ci}`;

    // Group consecutive ops that share the same condition
    const groups: Array<{
      cond?: string;
      vars: Array<{ v: string; val: string }>;
    }> = [];
    for (const op of c.ops) {
      const last = groups[groups.length - 1];
      if (last && last.cond === op.condition) {
        last.vars.push({ v: op.variable, val: op.value });
      } else {
        groups.push({
          cond: op.condition,
          vars: [{ v: op.variable, val: op.value }],
        });
      }
    }

    let caseIfId = "";
    let caseExpression = "";
    let caseLabel = "";
    if (c.caseExpr) {
      // SELECT case: full compound condition (lang == 'eng' and skillRES == '1')
      caseExpression = normalizeCaseExpr(c.caseExpr);
      caseLabel = `${label}: ${caseExpression}`;
    } else if (c.switchVar && c.switchVal !== undefined) {
      // SWITCH case: [Fix #1/#2] normalizeExpr handles = → == and Lang rewriting
      caseExpression = normalizeExpr(`${c.switchVar} == '${c.switchVal}'`);
      caseLabel = `${label}: Case ${c.switchVal}`;
    }
    if (caseExpression) {
      caseIfId = `${prefix}_sw`;
      nodes[caseIfId] = {
        step_id: caseIfId,
        action_type: "CHECK",
        label: caseLabel,
        content: {
          expression: caseExpression,
          branches: { True: "", False: snippetNextId },
        },
      };
    }

    let groupEntryId = "";
    let prevGroupNodeId = "";

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const gprefix = `${prefix}_g${gi}`;

      if (g.cond) {
        const ifId = `${gprefix}_if`;
        // [Fix #1/#2] normalizeExpr: = → == and Lang 'EN'→'eng' etc.
        const normCond = normalizeExpr(g.cond);
        nodes[ifId] = {
          step_id: ifId,
          action_type: "CHECK",
          label: `IF ${normCond}`,
          content: {
            expression: normCond,
            branches: { True: "", False: snippetNextId },
          },
        };

        let firstAssignId = "",
          prevAssignId = "";
        for (let ai = 0; ai < g.vars.length; ai++) {
          const { v, val } = g.vars[ai];
          const aId = `${gprefix}_a${ai}`;
          nodes[aId] = {
            step_id: aId,
            action_type: "SET",
            label: `${v} = ${val}`,
            content: { assignments: { [v]: val }, branches: {} },
            default_next: snippetNextId,
          };
          if (prevAssignId)
            nodes[prevAssignId] = { ...nodes[prevAssignId], default_next: aId };
          if (ai === 0) firstAssignId = aId;
          prevAssignId = aId;
        }

        nodes[ifId] = {
          ...nodes[ifId],
          content: {
            ...nodes[ifId].content,
            branches: {
              True: firstAssignId || snippetNextId,
              False: snippetNextId,
            },
          },
        };

        if (!groupEntryId) groupEntryId = ifId;
        if (prevGroupNodeId) {
          const prev = nodes[prevGroupNodeId];
          nodes[prevGroupNodeId] = {
            ...prev,
            content: {
              ...prev.content,
              branches: { ...prev.content.branches, False: ifId },
            },
          };
        }
        prevGroupNodeId = ifId;
      } else {
        let firstId = "",
          prevId = "";
        for (let ai = 0; ai < g.vars.length; ai++) {
          const { v, val } = g.vars[ai];
          const aId = `${gprefix}_a${ai}`;
          nodes[aId] = {
            step_id: aId,
            action_type: "SET",
            label: `${v} = ${val}`,
            content: { assignments: { [v]: val }, branches: {} },
            default_next: snippetNextId,
          };
          if (prevId) nodes[prevId] = { ...nodes[prevId], default_next: aId };
          if (ai === 0) firstId = aId;
          prevId = aId;
        }
        if (!groupEntryId) groupEntryId = firstId;
        if (prevGroupNodeId) {
          const prev = nodes[prevGroupNodeId];
          if (prev.content?.branches) {
            nodes[prevGroupNodeId] = {
              ...prev,
              content: {
                ...prev.content,
                branches: { ...prev.content.branches, False: firstId },
              },
            };
          } else {
            nodes[prevGroupNodeId] = { ...prev, default_next: firstId };
          }
        }
        prevGroupNodeId = prevId;
      }
    }

    if (!groupEntryId) groupEntryId = snippetNextId;

    if (caseIfId) {
      nodes[caseIfId] = {
        ...nodes[caseIfId],
        content: {
          ...nodes[caseIfId].content,
          branches: { True: groupEntryId, False: snippetNextId },
        },
      };
      for (const prevId of prevIfIds) {
        const prev = nodes[prevId];
        nodes[prevId] = {
          ...prev,
          content: {
            ...prev.content,
            branches: { ...prev.content.branches, False: caseIfId },
          },
        };
      }
      prevIfIds = [caseIfId];
      if (!entryId) entryId = caseIfId;
    } else {
      for (const prevId of prevIfIds) {
        const prev = nodes[prevId];
        nodes[prevId] = {
          ...prev,
          content: {
            ...prev.content,
            branches: { ...prev.content.branches, False: groupEntryId },
          },
        };
      }
      prevIfIds = prevGroupNodeId ? [prevGroupNodeId] : [];
      if (!entryId) entryId = groupEntryId;
    }
  }

  return entryId || snippetNextId;
}

// ─── MENU expander ────────────────────────────────────────────────────────────
/**
 * Two modes based on what the source's '' (timeout/invalid) branch points to:
 *
 * MODE A — '' branch → LOOP:  full retry cycle
 *   m{aid}_reset      SET    variable=null, counter=0
 *   m{aid}_gather     GATHER play prompt, collect digit
 *   m{aid}_check      CHECK  var mode: digit→out, null→incr
 *   m{aid}_incr       SET    counter++
 *   m{aid}_limit      CHECK  counter < max → retry_play, else exit
 *   m{aid}_retry_play PLAY   "invalid, try again" → back to gather
 *   m{aid}_exit_play  PLAY   "no option, goodbye" (if source had one)
 *
 * MODE B — '' branch → anything else (HOURS, IF, PLAY, missing):
 *   m{aid}_reset  SET    variable=null  (no counter)
 *   m{aid}_gather GATHER play prompt, collect digit
 *   m{aid}_check  CHECK  var mode: digit→out, null→direct exit target
 *
 * [Fix #3/#4/#5] Only MODE A when a real LOOP was found in the '' branch.
 * [Fix #6/#7]    Counter and variable reset use JSON 0 / null, not strings.
 */
function expandMenu(
  aid: string,
  label: string,
  p: Record<string, any>,
  blist: any[],
  actionsMap: Record<string, any>,
  propsMap: Record<string, any>,
  branchesMap: Record<string, any[]>,
  nodes: Record<string, IVRNode>,
  consumed: Set<string>,
  resolveTarget: (to: string | number, depth?: number) => string,
  menuReentryMap: Record<string, string>,
): string {
  const variable = p.Variable ?? "menu_var";
  const numDigits = p.MaxDigits ?? "1";
  const timeout = p.Timeout ?? "5";

  // Labeled digit branches
  const digitBranches: Record<string, string> = {};
  for (const b of blist) {
    if (b.label && b.label !== "") {
      digitBranches[String(b.label)] = resolveTarget(b.to);
    }
  }

  // The '' (no-input / timeout / invalid) branch
  const invalidBranch = blist.find(
    (b: any) => b.label === "" || b.label == null,
  );
  const invalidTargetId = invalidBranch ? String(invalidBranch.to) : null;
  const invalidTargetAction = invalidTargetId
    ? actionsMap[invalidTargetId]
    : null;

  const resetId = `m${aid}_reset`;
  const gatherId = `m${aid}_gather`;
  const checkId = `m${aid}_check`;

  menuReentryMap[aid] = gatherId;

  // ── MODE A: '' → LOOP ──────────────────────────────────────────────────────
  if (invalidTargetAction?.name === "LOOP") {
    consumed.add(invalidTargetId!);

    const lp = getProps(propsMap[invalidTargetId!] ?? {});
    const counterVar = lp.CounterName ?? `MenuLoop_${aid}`;
    const maxRetries = parseInt(lp.Repeat ?? "3", 10);
    const loopBranches = branchesMap[invalidTargetId!] ?? [];
    const repeatBranch = loopBranches.find((b: any) => b.label === "Repeat");
    const finishedBranch = loopBranches.find(
      (b: any) => b.label === "Finished",
    );

    // Extract retry PLAY text from the Repeat branch
    let retryText: SayText = {
      eng: "I'm sorry, that was not a valid option. Please try again.",
    };
    if (repeatBranch) {
      const retryPlayId = String(repeatBranch.to);
      const retryPlayAction = actionsMap[retryPlayId];
      if (retryPlayAction?.name === "PLAY") {
        consumed.add(retryPlayId);
        const pp = getProps(propsMap[retryPlayId] ?? {});
        retryText = parseBilingual(pp.Phrase ?? "");
        // Consume PLAY's outgoing branch if it just loops to the MENU
        const retryPlayBranches = branchesMap[retryPlayId] ?? [];
        const retryNext = retryPlayBranches.find(
          (b: any) => b.label === "" || b.label == null,
        );
        if (retryNext) {
          const rna = actionsMap[String(retryNext.to)];
          if (rna?.name === "MENU") consumed.add(String(retryNext.to));
        }
      }
    }

    // Exit path from Finished branch
    let exitNodeId = "END";
    if (finishedBranch) {
      const finishedId = String(finishedBranch.to);
      const finishedAction = actionsMap[finishedId];
      if (finishedAction?.name === "PLAY") {
        // Absorb the goodbye PLAY and wire its continuation
        consumed.add(finishedId);
        const fp = getProps(propsMap[finishedId] ?? {});
        const exitPlayId = `m${aid}_exit_play`;
        const finishedNextBranches = branchesMap[finishedId] ?? [];
        const afterExit = finishedNextBranches.find(
          (b: any) => b.label === "" || b.label == null,
        );
        nodes[exitPlayId] = {
          step_id: exitPlayId,
          action_type: "PLAY",
          label: `${label}: max retries`,
          content: { text: parseBilingual(fp.Phrase ?? ""), branches: {} },
          default_next: afterExit ? resolveTarget(afterExit.to) : "END",
        };
        exitNodeId = exitPlayId;
      } else {
        exitNodeId = resolveTarget(finishedBranch.to);
      }
    }

    const incrId = `m${aid}_incr`;
    const limitId = `m${aid}_limit`;
    const retryPlayNodeId = `m${aid}_retry_play`;

    nodes[retryPlayNodeId] = {
      step_id: retryPlayNodeId,
      action_type: "PLAY",
      label: `${label}: retry prompt`,
      content: { text: retryText, branches: {} },
      default_next: gatherId,
    };

    // [Fix #6/#7] counter=0 (integer), variable=null (JSON null)
    nodes[resetId] = {
      step_id: resetId,
      action_type: "SET",
      label: `${label}: reset`,
      content: {
        assignments: { [variable]: null, [counterVar]: 0 } as any,
        branches: {},
      },
      default_next: gatherId,
    };

    nodes[gatherId] = {
      step_id: gatherId,
      action_type: "GATHER",
      label: `${label}: gather`,
      content: {
        text: parseBilingual(p.Phrase ?? ""),
        variable,
        num_digits: numDigits,
        timeout,
        branches: {},
      },
      default_next: checkId,
    };

    nodes[checkId] = {
      step_id: checkId,
      action_type: "CHECK",
      label: `${label}: check digit`,
      content: { var: variable, branches: { ...digitBranches, null: incrId } },
    };

    nodes[incrId] = {
      step_id: incrId,
      action_type: "SET",
      label: `${label}: increment retry`,
      content: {
        assignments: { [counterVar]: `${counterVar}++` },
        branches: {},
      },
      default_next: limitId,
    };

    nodes[limitId] = {
      step_id: limitId,
      action_type: "CHECK",
      label: `${label}: retry limit`,
      content: {
        expression: `${counterVar} < ${maxRetries}`,
        branches: { True: retryPlayNodeId, False: exitNodeId },
      },
    };

    return resetId;
  }

  // ── MODE B: no LOOP — direct passthrough on null/timeout ──────────────────
  // [Fix #3/#4/#5] resolve directly to whatever the '' branch pointed at,
  // or END if there was no '' branch (e.g. Sendero MENU 61).
  const directExitId = invalidTargetId ? resolveTarget(invalidTargetId) : "END";

  // [Fix #7] variable=null (JSON null, no counter needed)
  nodes[resetId] = {
    step_id: resetId,
    action_type: "SET",
    label: `${label}: reset`,
    content: {
      assignments: { [variable]: null } as any,
      branches: {},
    },
    default_next: gatherId,
  };

  nodes[gatherId] = {
    step_id: gatherId,
    action_type: "GATHER",
    label: `${label}: gather`,
    content: {
      text: parseBilingual(p.Phrase ?? ""),
      variable,
      num_digits: numDigits,
      timeout,
      branches: {},
    },
    default_next: checkId,
  };

  nodes[checkId] = {
    step_id: checkId,
    action_type: "CHECK",
    label: `${label}: check digit`,
    content: {
      var: variable,
      branches: { ...digitBranches, null: directExitId },
    },
  };

  return resetId;
}

// ─── LOOP expander (standalone) ───────────────────────────────────────────────
function expandLoop(
  aid: string,
  label: string,
  p: Record<string, any>,
  allBranches: Record<string, string>,
  nodes: Record<string, IVRNode>,
): string {
  const counterVar = p.CounterName ?? "RetryCount";
  const maxVal = p.Repeat ?? "3";

  const initId = `l${aid}_init`;
  const incrId = `l${aid}_incr`;
  const checkId = `l${aid}_check`;

  const ALIASES: Record<string, string> = { Finished: "False", Repeat: "True" };
  const branches: Record<string, string> = {};
  for (const [k, v] of Object.entries(allBranches))
    branches[ALIASES[k] ?? k] = v;

  // [Fix #6] init counter as integer 0
  nodes[initId] = {
    step_id: initId,
    action_type: "SET",
    label: `${label}: init counter`,
    content: { assignments: { [counterVar]: 0 } as any, branches: {} },
    default_next: incrId,
  };

  nodes[incrId] = {
    step_id: incrId,
    action_type: "SET",
    label: `${label}: ${counterVar}++`,
    content: { assignments: { [counterVar]: `${counterVar}++` }, branches: {} },
    default_next: checkId,
  };

  nodes[checkId] = {
    step_id: checkId,
    action_type: "CHECK",
    label: `${label}: ${counterVar} < ${maxVal}`,
    content: { expression: `${counterVar} < ${maxVal}`, branches },
  };

  return initId;
}

// ─── Main converter ───────────────────────────────────────────────────────────
const SKIP_ACTIONS = new Set([
  "SIPXFERPUTHD",
  "BLINDXFER",
  "VOICEPARAMS",
  "ANNOTATION",
  "RUNSUB",
  "ONSIGNAL",
]);

export function convertCxJson(raw: any): IR {
  const sc = raw.scriptContent ?? raw;
  const actionsMap: Record<string, any> = sc.actions ?? {};
  const propsMap: Record<string, any> = sc.properties ?? {};
  const branchesMap: Record<string, any[]> = sc.branches ?? {};

  const nodes: Record<string, IVRNode> = {};
  const consumed = new Set<string>();
  const menuReentryMap: Record<string, string> = {};

  // Resolve a CXone action ID to its engine step ID.
  // Transparent nodes (SKIP_ACTIONS, BEGIN) are followed through to their target.
  const resolveTarget = (to: string | number, depth = 0): string => {
    if (depth > 12) return `s${to}`;
    const id = String(to);
    const action = actionsMap[id];
    if (!action) return `s${id}`;
    const name = action.name;
    if (SKIP_ACTIONS.has(name) || name === "BEGIN") {
      const blist = branchesMap[id] ?? [];
      const def = blist.find((b) => !b.label) ?? blist[0];
      return def ? resolveTarget(def.to, depth + 1) : "END";
    }
    if (name === "SNIPPET") return `SNENTRY_${id}`;
    if (name === "MENU") return `m${id}_reset`;
    if (name === "LOOP") return `l${id}_init`;
    return `s${id}`;
  };

  const buildBranches = (aid: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const b of branchesMap[aid] ?? []) {
      const lbl = String(b.label ?? "").trim();
      out[lbl || "default"] = resolveTarget(b.to);
    }
    return out;
  };

  // ── START node from BEGIN ─────────────────────────────────────────────────
  let startStepId: string | undefined;
  for (const [aid, action] of Object.entries(actionsMap)) {
    if (action.name !== "BEGIN") continue;
    const blist = branchesMap[aid] ?? [];
    const def = blist.find((b: any) => !b.label) ?? blist[0];
    nodes["start"] = {
      step_id: "start",
      action_type: "START",
      label: "Flow Start",
      content: { branches: {} },
      default_next: def ? resolveTarget(def.to) : undefined,
    };
    startStepId = "start";
    break;
  }

  // ── Pass 1: SNIPPETs ──────────────────────────────────────────────────────
  const snippetEntryMap: Record<string, string> = {};
  for (const [aid, action] of Object.entries(actionsMap)) {
    if (action.name !== "SNIPPET") continue;
    let data = "";
    for (const pv of Object.values(propsMap[aid] ?? {}) as any[]) {
      if ((pv as any)?.name === "Data") data = (pv as any).value ?? "";
    }
    const branches = buildBranches(aid);
    const snippetNext = branches.default ?? "END";
    snippetEntryMap[aid] = expandSnippet(
      aid,
      action.label || `Snippet_${aid}`,
      data,
      snippetNext,
      nodes,
    );
  }

  const resolveSnEntry = (id: string): string => {
    const m = id.match(/^SNENTRY_(\d+)$/);
    return m ? (snippetEntryMap[m[1]] ?? id) : id;
  };

  // Patch SNENTRY_ refs in already-emitted snippet nodes
  for (const nodeId of Object.keys(nodes)) {
    const n = nodes[nodeId];
    const nb: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.content?.branches ?? {}))
      nb[k] = resolveSnEntry(v as string);
    nodes[nodeId] = {
      ...n,
      content: { ...n.content, branches: nb },
      default_next: n.default_next
        ? resolveSnEntry(n.default_next)
        : n.default_next,
    };
  }

  // ── Pass 2: MENUs ─────────────────────────────────────────────────────────
  for (const [aid, action] of Object.entries(actionsMap)) {
    if (action.name !== "MENU") continue;
    const p = getProps(propsMap[aid] ?? {});
    const blist = branchesMap[aid] ?? [];
    expandMenu(
      aid,
      action.label || `Menu_${aid}`,
      p,
      blist,
      actionsMap,
      propsMap,
      branchesMap,
      nodes,
      consumed,
      resolveTarget,
      menuReentryMap,
    );
  }

  // ── Pass 3: everything else ───────────────────────────────────────────────
  for (const [aid, action] of Object.entries(actionsMap)) {
    const name = action.name as string;
    if (
      SKIP_ACTIONS.has(name) ||
      name === "SNIPPET" ||
      name === "BEGIN" ||
      name === "MENU" ||
      consumed.has(aid)
    )
      continue;

    const p = getProps(propsMap[aid] ?? {});
    const label = action.label || name;
    const nodeId = `s${aid}`;
    const allBranches = buildBranches(aid);
    const defNext = allBranches.default
      ? resolveSnEntry(allBranches.default)
      : undefined;
    const labelBranches = Object.fromEntries(
      Object.entries(allBranches)
        .filter(([k]) => k !== "default")
        .map(([k, v]) => [k, resolveSnEntry(v)]),
    );

    if (
      name === "RUNSCRIPT" &&
      String(p.ScriptName ?? "").includes("Queue_KPMA")
    ) {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "TRANSFER",
        label,
        content: { transferType: "CONNECT", digits: "{{uid}}", branches: {} },
      };
      continue;
    }

    if (name === "REQAGENT") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "TRANSFER",
        label: label || "Queue to Agent",
        content: {
          transferType: "CONNECT",
          digits: "{{uid}}",
          agentSkill: p.Skill ?? "",
          branches: {},
        },
      };
      continue;
    }

    if (name === "SPAWN") {
      let callbackEntry: string | undefined = defNext;
      for (const [oid, oa] of Object.entries(actionsMap)) {
        if ((oa as any).name === "ONSIGNAL") {
          const oblist = branchesMap[oid] ?? [];
          const fb = oblist.find((b: any) => !b.label) ?? oblist[0];
          if (fb) callbackEntry = resolveTarget(fb.to);
          break;
        }
      }
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "TRANSFER",
        label: label || "Forward to PolyAI",
        content: {
          transferType: "SIP",
          "X-UID": "{{uid}}",
          "X-QueueSkill": "{{QueueSkill}}",
          "X-SkillWhisper": "{{SkillWhisper}}",
          branches: {},
        },
        default_next: callbackEntry,
      };
      continue;
    }

    if (name === "PLAY") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "PLAY",
        label,
        content: {
          text: parseBilingual(p.Phrase ?? ""),
          branches: labelBranches,
        },
        default_next: defNext,
      };
      continue;
    }

    if (name === "GETINPUT") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "GATHER",
        label,
        content: {
          text: parseBilingual(p.Phrase ?? ""),
          variable: p.Variable ?? "input_var",
          num_digits: p.MaxDigits ?? p.NumDigits ?? "1",
          timeout: p.Timeout ?? "5",
          branches: labelBranches,
        },
        default_next: defNext,
      };
      continue;
    }

    if (name === "LOOP") {
      expandLoop(aid, label, p, allBranches, nodes);
      continue;
    }

    if (name === "IF") {
      // [Fix #1] normalizeExpr: = → == and Lang 'EN'/'SP'/'ES' → 'eng'/'spa'
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "CHECK",
        label,
        content: {
          expression: normalizeExpr(p.Expression ?? ""),
          branches: allBranches,
        },
      };
      continue;
    }

    if (name === "ASSIGN") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "SET",
        label,
        content: {
          assignments: { [p.Variable ?? "var"]: p.Value ?? "" },
          branches: labelBranches,
        },
        default_next: defNext,
      };
      continue;
    }

    if (name === "HOURS") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "HOURS",
        label,
        content: { hoo_arn: p.Profile, branches: allBranches },
      };
      continue;
    }

    if (name === "WAIT") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "WAIT",
        label,
        content: { seconds: String(p.Seconds ?? "1"), branches: labelBranches },
        default_next: defNext,
      };
      continue;
    }

    if (name === "HANGUP") {
      nodes[nodeId] = {
        step_id: nodeId,
        action_type: "HANGUP",
        label,
        content: { branches: {} },
      };
      continue;
    }

    console.warn(
      `[convertCxJson] Skipping unknown CXone action: ${name} (id=${aid}, label=${label})`,
    );
  }

  // ── Final pass: resolve any remaining SNENTRY_ refs ───────────────────────
  for (const nodeId of Object.keys(nodes)) {
    const n = nodes[nodeId];
    const nb: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.content?.branches ?? {}))
      nb[k] = resolveSnEntry(v as string);
    nodes[nodeId] = {
      ...n,
      content: { ...n.content, branches: nb },
      default_next: n.default_next
        ? resolveSnEntry(n.default_next)
        : n.default_next,
    };
  }

  const flowId =
    String(sc.header?.scriptName ?? "")
      .toLowerCase()
      .replace(/\W+/g, "_")
      .replace(/^_|_$/g, "") || "imported_flow";

  return { flow_id: flowId, nodes, start_step: startStepId };
}

// ── applyLandingTransforms ────────────────────────────────────────────────────
/**
 * Six normalisation passes applied after the main conversion and deferLangDefault.
 * All passes mutate `nodes` in place and are idempotent.
 */
function applyLandingTransforms(nodes: Record<string, IVRNode>): void {
  _p1_removeBlockCallCheck(nodes);
  _p2_normaliseLangAssignments(nodes);
  _p3_swapLangMenuToEnglishFirst(nodes);
  _p4_removeRedundantNullBranches(nodes);
  _p5_mergeSequentialSets(nodes);
  _p6_normalisePolyHandoff(nodes);
}

// ── Helper: rewire every inbound edge from one step to another ───────────────
function _rewireInbound(
  nodes: Record<string, IVRNode>,
  fromId: string,
  toId: string,
): void {
  for (const [nid, n] of Object.entries(nodes)) {
    if (n.default_next === fromId) {
      nodes[nid] = { ...n, default_next: toId || undefined };
    }
    const branches = n.content?.branches ?? {};
    const changed = Object.entries(branches).filter(([, v]) => v === fromId);
    if (changed.length > 0) {
      const nb = { ...branches };
      for (const [k] of changed) nb[k] = toId;
      nodes[nid] = { ...n, content: { ...n.content, branches: nb } };
    }
  }
}

// ── Helper: collect all step IDs reachable from a given node (DFS) ───────────
function _reachable(
  nodes: Record<string, IVRNode>,
  startId: string,
): Set<string> {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    if (!id || visited.has(id) || !nodes[id]) continue;
    visited.add(id);
    const n = nodes[id];
    if (n.default_next) stack.push(n.default_next);
    for (const v of Object.values(n.content?.branches ?? {})) {
      if (v) stack.push(v as string);
    }
  }
  return visited;
}

// ─── P1: Remove BlockCall check ───────────────────────────────────────────────
/**
 * Detects CHECK nodes whose expression is "BlockCall == 1" (always false in live
 * flows).  Rewires all inbound edges to the False branch target and deletes the
 * True-branch subtree (ineligible play + hangup) if it is not reachable from
 * anywhere else.
 */
function _p1_removeBlockCallCheck(nodes: Record<string, IVRNode>): void {
  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "CHECK") continue;
    const expr = (node.content?.expression ?? "").replace(/\s+/g, " ").trim();
    if (!/^BlockCall\s*==\s*1$/i.test(expr)) continue;

    const branches = node.content?.branches ?? {};
    const falseBranch = branches["False"] ?? node.default_next;
    const trueBranch = branches["True"];
    if (!falseBranch) continue;

    // Rewire everyone pointing at this CHECK to the False branch
    _rewireInbound(nodes, id, falseBranch);
    delete nodes[id];

    // Prune the True subtree if it is now unreachable
    if (trueBranch) {
      const reachable = _reachable({ ...nodes }, "start");
      const trueReachable = _reachable({ ...nodes }, trueBranch);
      for (const rid of trueReachable) {
        if (!reachable.has(rid)) {
          delete nodes[rid];
        }
      }
    }
    console.log(`[P1] Removed BlockCall check ${id}, wired to ${falseBranch}`);
    return; // typically only one BlockCall check per flow
  }
}

// ─── P2: Normalise Lang in SET assignments ────────────────────────────────────
/**
 * Rewrites SET node assignment values for the Lang variable:
 *   Any short code found in LANG_CODE_MAP → its ISO 639-2 form
 *   e.g. "EN"→"eng", "SP"/"ES"→"spa", "FR"→"fra", etc.
 * Also strips surrounding quotes that CXone sometimes emits.
 */
function _p2_normaliseLangAssignments(nodes: Record<string, IVRNode>): void {
  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "SET") continue;
    const asgn = node.content?.assignments;
    if (!asgn || !("Lang" in asgn)) continue;
    const raw = String(asgn["Lang"] ?? "")
      .replace(/^["']|["']$/g, "")
      .trim()
      .toUpperCase();
    const normalised = LANG_CODE_MAP[raw] ?? asgn["Lang"];
    if (normalised !== asgn["Lang"]) {
      nodes[id] = {
        ...node,
        content: {
          ...node.content,
          assignments: { ...asgn, Lang: normalised },
        },
      };
      console.log(
        `[P2] Normalised Lang "${asgn["Lang"]}" → "${normalised}" in ${id}`,
      );
    }
  }
}

// ─── P3: Swap lang-menu so English=1, Spanish=2 ───────────────────────────────
/**
 * Finds the lang-select CHECK (the one whose digit branches directly point to
 * SET Lang nodes) and ensures key "1" maps to English and "2" to Spanish.
 *
 * Note: In many flows key "1" goes straight to HOURS (English default path) and
 * key "2" goes to SET Lang=spa — that pattern is already correct and left alone.
 * We only swap when key "1" DIRECTLY points to a SET Lang=spa node.
 */
function _p3_swapLangMenuToEnglishFirst(nodes: Record<string, IVRNode>): void {
  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "CHECK") continue;
    const branches = { ...(node.content?.branches ?? {}) };

    // Search ALL branch keys for SET Lang nodes — not just "1"/"2".
    // After P0 the English SET may have been assigned to key "3" (or higher)
    // because key "1" was already taken by the implicit-English HOURS path.
    let engKey: string | undefined;
    let spaKey: string | undefined;

    for (const [key, target] of Object.entries(branches)) {
      if (!target || !nodes[target]) continue;
      const n = nodes[target];
      if (n.action_type !== "SET") continue;
      const lang = String(
        (n.content?.assignments ?? {})["Lang"] ?? "",
      ).toLowerCase();
      if ((lang === "eng" || lang === "en") && !engKey) engKey = key;
      if ((lang === "spa" || lang === "sp" || lang === "es") && !spaKey)
        spaKey = key;
    }

    if (!engKey || !spaKey) continue; // this CHECK doesn't look like a lang menu
    if (engKey === "1" && spaKey === "2") continue; // already correct

    const engTarget = branches[engKey];
    const spaTarget = branches[spaKey];

    // Remove the old lang-keyed branches
    delete branches[engKey];
    delete branches[spaKey];

    // Remove any "1" or "2" that weren't lang branches — these are the old
    // implicit-English paths (e.g. "1"→HOURS) that are now superseded by the
    // explicit SET Lang=eng node added by P0.
    if (
      "1" in branches &&
      branches["1"] !== engTarget &&
      branches["1"] !== spaTarget
    ) {
      console.log(
        `[P3] Dropping superseded branch "1"→${branches["1"]} in ${id}`,
      );
      delete branches["1"];
    }
    if (
      "2" in branches &&
      branches["2"] !== engTarget &&
      branches["2"] !== spaTarget
    ) {
      console.log(
        `[P3] Dropping superseded branch "2"→${branches["2"]} in ${id}`,
      );
      delete branches["2"];
    }

    // Assign canonical positions: 1=English, 2=Spanish
    branches["1"] = engTarget;
    branches["2"] = spaTarget;

    nodes[id] = { ...node, content: { ...node.content, branches } };
    console.log(
      `[P3] Remapped lang branches in ${id}: "1"→English(${engTarget}), "2"→Spanish(${spaTarget})`,
    );
  }
}

// ─── P4: Remove redundant null branches ──────────────────────────────────────
/**
 * For every CHECK node:
 *   - Removes any branch whose target is an empty string.
 *   - If the "null" branch target equals default_next AND default_next is set,
 *     deletes the redundant "null" branch (the engine already falls through).
 *
 * Intentional null branches (var-mode menus with no default_next, where null
 * means "no input / timeout") are left untouched.
 */
function _p4_removeRedundantNullBranches(nodes: Record<string, IVRNode>): void {
  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "CHECK") continue;
    const branches = { ...(node.content?.branches ?? {}) };
    let changed = false;

    // Drop branches with empty/null targets
    for (const [k, v] of Object.entries(branches)) {
      if (!v) {
        delete branches[k];
        changed = true;
      }
    }

    // Drop null branch when it duplicates default_next
    if (
      "null" in branches &&
      branches["null"] === node.default_next &&
      node.default_next
    ) {
      delete branches["null"];
      changed = true;
    }

    if (changed) {
      nodes[id] = { ...node, content: { ...node.content, branches } };
    }
  }
}

// ─── P5: Merge sequential SET nodes ──────────────────────────────────────────
/**
 * Collapses consecutive SET nodes with no branches into one combined SET.
 * Also strips CXone inline comments (// …) from numeric assignment values.
 */

function _stripComment(value: string): string {
  // Remove inline // comments that CXone snippets often include
  // e.g. "18556550 //SCAN Reservations  SP"
  return value.replace(/\s*\/\/.*$/, "").trim();
}

function _cleanAssignments(asgn: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(asgn)) {
    out[k] = typeof v === "string" ? _stripComment(v) : v;
  }
  return out;
}

function _p5_mergeSequentialSets(nodes: Record<string, IVRNode>): void {
  // First pass: strip comments from all existing SET assignment values
  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "SET") continue;
    const asgn = node.content?.assignments;
    if (!asgn) continue;
    const cleaned = _cleanAssignments(asgn);
    nodes[id] = { ...node, content: { ...node.content, assignments: cleaned } };
  }

  // Build inbound-edge count so we only merge nodes with exactly one predecessor
  const inboundCount: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    const targets = [
      node.default_next,
      ...Object.values(node.content?.branches ?? {}),
    ].filter(Boolean) as string[];
    for (const t of targets) {
      inboundCount[t] = (inboundCount[t] ?? 0) + 1;
    }
  }

  const merged = new Set<string>();

  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "SET" || merged.has(id)) continue;
    // Only merge if no labeled branches
    if (Object.keys(node.content?.branches ?? {}).length > 0) continue;

    let current = node;
    let currentId = id;
    const chain: Array<{ id: string; node: IVRNode }> = [{ id, node }];

    while (current.default_next) {
      const nextId = current.default_next;
      const next = nodes[nextId];
      if (!next) break;
      if (next.action_type !== "SET") break;
      if (Object.keys(next.content?.branches ?? {}).length > 0) break;
      if (merged.has(nextId)) break;
      // Only absorb if this next node has exactly one inbound edge (from current)
      if ((inboundCount[nextId] ?? 0) > 1) break;

      chain.push({ id: nextId, node: next });
      current = next;
      currentId = nextId;
    }

    if (chain.length < 2) continue;

    // Merge all assignments; later ones overwrite earlier (same key wins last)
    const mergedAsgn: Record<string, any> = {};
    for (const { node: n } of chain) {
      Object.assign(mergedAsgn, n.content?.assignments ?? {});
    }

    // Update the head node with the merged assignments and the tail's next
    nodes[id] = {
      ...node,
      content: { ...node.content, assignments: mergedAsgn },
      default_next: current.default_next,
    };

    // Remove the absorbed nodes
    for (const { id: mid } of chain.slice(1)) {
      merged.add(mid);
      delete nodes[mid];
    }

    console.log(
      `[P5] Merged ${chain.length} SETs into ${id}: keys=[${Object.keys(mergedAsgn).join(", ")}]`,
    );
  }
}

// ─── P6: Normalise PolyAI handoff pattern ────────────────────────────────────
/**
 * After a SIP TRANSFER (SPAWN), the old CXone flow emits:
 *   PLAY (empty) → SET PolyReason={SP2} → SET PolyNote={SP3} → REQAGENT
 *
 * Replace that chain with the correct engine pattern:
 *   SIP TRANSFER  → SET Handoff=DialSipHeader_X-Handoff
 *                 → CHECK Handoff == "Yes"
 *                      True  → SET HandoffReason=DialSipHeader_X-HandoffReason → REQAGENT
 *                      False → HANGUP
 *
 * The REQAGENT node already exists in the flow; we reuse it.
 * The empty PLAY after SPAWN (if any) is also bypassed.
 */
function _p6_normalisePolyHandoff(nodes: Record<string, IVRNode>): void {
  // Find the SIP TRANSFER node(s)
  for (const [sipId, sipNode] of Object.entries(nodes)) {
    if (sipNode.action_type !== "TRANSFER") continue;
    if (sipNode.content?.transferType !== "SIP") continue;

    const afterSip = sipNode.default_next;
    if (!afterSip || !nodes[afterSip]) continue;

    // Walk forward from afterSip, skipping empty PLAYs, to find PolyReason SET
    let cursor = afterSip;
    let emptyPlayId: string | undefined;

    // Skip empty PLAY nodes (no non-empty text in any language)
    while (
      nodes[cursor]?.action_type === "PLAY" &&
      !Object.values(nodes[cursor].content?.text ?? {}).some(v => v)
    ) {
      emptyPlayId = cursor;
      cursor = nodes[cursor].default_next ?? "";
      if (!cursor) break;
    }

    if (!cursor || !nodes[cursor]) continue;

    // Detect PolyReason / PolyNote chain
    const polyReasonNode = nodes[cursor];
    if (polyReasonNode.action_type !== "SET") continue;
    const asgn = polyReasonNode.content?.assignments ?? {};
    if (!("PolyReason" in asgn) && !("PolyNote" in asgn)) continue;

    // Walk the chain collecting SET nodes until we hit REQAGENT
    let reqagentId: string | undefined;
    let chainCursor = cursor;
    const chainIds: string[] = [];
    let steps = 0;
    while (steps++ < 10) {
      const cn = nodes[chainCursor];
      if (!cn) break;
      if (
        cn.action_type === "TRANSFER" &&
        cn.content?.transferType === "CONNECT"
      ) {
        reqagentId = chainCursor;
        break;
      }
      if (cn.action_type === "SET") chainIds.push(chainCursor);
      chainCursor = cn.default_next ?? "";
      if (!chainCursor) break;
    }

    if (!reqagentId) continue; // couldn't find REQAGENT

    // ── Build the replacement nodes ──────────────────────────────────────────

    const setHandoffId = `${sipId}_set_handoff`;
    const checkHandoffId = `${sipId}_check_handoff`;
    const setHandoffReasonId = `${sipId}_set_handoff_reason`;

    // Find an existing HANGUP node or synthesize one
    const hangupId =
      Object.entries(nodes).find(([, n]) => n.action_type === "HANGUP")?.[0] ??
      `${sipId}_hangup`;
    if (!nodes[hangupId]) {
      nodes[hangupId] = {
        step_id: hangupId,
        action_type: "HANGUP",
        label: "Hangup",
        content: { branches: {} },
      };
    }

    // SET Handoff = DialSipHeader_X-Handoff
    // Bare reference, NOT {{…}}: the engine's eval_value resolves a SET value by
    // direct vars_map lookup (handles the hyphen), whereas its {{(\w+)}} template
    // can't match the hyphen and would store the literal string.
    nodes[setHandoffId] = {
      step_id: setHandoffId,
      action_type: "SET",
      label: "Set Handoff",
      content: {
        assignments: { Handoff: "DialSipHeader_X-Handoff" },
        branches: {},
      },
      default_next: checkHandoffId,
    };

    // CHECK Handoff == "Yes"
    nodes[checkHandoffId] = {
      step_id: checkHandoffId,
      action_type: "CHECK",
      label: "Check Handoff",
      content: {
        expression: 'Handoff == "Yes"',
        branches: {
          True: setHandoffReasonId,
          False: hangupId,
        },
      },
    };

    // SET HandoffReason = DialSipHeader_X-HandoffReason  (bare ref — see above)
    nodes[setHandoffReasonId] = {
      step_id: setHandoffReasonId,
      action_type: "SET",
      label: "Set HandoffReason",
      content: {
        assignments: { HandoffReason: "DialSipHeader_X-HandoffReason" },
        branches: {},
      },
      default_next: reqagentId,
    };

    // Rewire SIP transfer's default_next to the new SET Handoff node
    // (skipping the empty PLAY and old PolyReason chain)
    nodes[sipId] = { ...sipNode, default_next: setHandoffId };

    // Delete the old PolyReason/PolyNote chain and empty PLAY
    for (const cid of chainIds) delete nodes[cid];
    if (emptyPlayId) delete nodes[emptyPlayId];

    console.log(
      `[P6] Replaced PolyReason chain after ${sipId} with Handoff check pattern`,
    );
  }
}

// ── deferLangDefault ──────────────────────────────────────────────────────────
/**
 * Detects the "upfront lang set" pattern and rewires the flow so Lang is only
 * set after the caller explicitly chooses a language.
 *
 * Pattern detected:
 *   [upstream] → [SET Lang=X] → [greeting?] → [lang-select GATHER] → [CHECK]
 *                                                                         ↓ (branch)
 *                                                               [SET Lang=Y] → [downstream]
 *
 * After fix:
 *   [upstream] → [greeting?] → [lang-select GATHER] → [CHECK]
 *                                                          ↓ branch[X key] → [SET Lang=X] → [downstream]
 *                                                          ↓ branch[Y key] → [SET Lang=Y] → [downstream]
 *                                                          ↓ null          → [downstream]  (no Lang set)
 *
 * Identification:
 *   1. Find SET{Lang} nodes reachable from a lang-select GATHER→CHECK pair
 *      ("in-menu" lang sets — already correct).
 *   2. Any SET{Lang} node NOT pointed to by that CHECK is "upfront".
 *   3. For each upfront node: bypass it by rewiring its inbound edges to its
 *      default_next, then add it as a new branch on the lang-select CHECK.
 */
function deferLangDefault(nodes: Record<string, IVRNode>): void {
  // ── Step 1: find all SET Lang nodes ──────────────────────────────────────
  const allLangSets = new Set(
    Object.keys(nodes).filter((id) => {
      const n = nodes[id];
      return (
        n.action_type === "SET" && "Lang" in (n.content?.assignments ?? {})
      );
    }),
  );
  if (allLangSets.size === 0) return;

  // ── Step 2: find the lang-select CHECK (GATHER → CHECK → SET Lang) ───────
  // Walk every GATHER's default_next; if that CHECK has any branch pointing to
  // a SET Lang node, it's our lang-select check.
  let langSelectCheckId: string | null = null;
  for (const [gid, gn] of Object.entries(nodes)) {
    if (gn.action_type !== "GATHER") continue;
    const dn = gn.default_next;
    if (!dn || !nodes[dn] || nodes[dn].action_type !== "CHECK") continue;
    const checkBranches = nodes[dn].content?.branches ?? {};
    const hasLangBranch = Object.values(checkBranches).some((v) =>
      allLangSets.has(v as string),
    );
    if (hasLangBranch) {
      langSelectCheckId = dn;
      break;
    }
  }
  if (!langSelectCheckId) return;

  // ── Step 3: "in-menu" sets = pointed to by the lang-select CHECK ─────────
  const checkBranches = nodes[langSelectCheckId].content?.branches ?? {};
  const inMenuLangSets = new Set(
    Object.values(checkBranches).filter((v) =>
      allLangSets.has(v as string),
    ) as string[],
  );

  // ── Step 4: upfront sets = SET Lang nodes NOT in the lang-select CHECK ───
  const upfrontLangSets = [...allLangSets].filter(
    (id) => !inMenuLangSets.has(id),
  );
  if (upfrontLangSets.length === 0) return;

  // ── Step 5: for each upfront node, rewire and add branch to lang-select ──
  // Figure out what branch key the lang-select check should use for each
  // upfront lang set by looking at what language value it assigns.
  // Normalize: eng→"1" if there's no existing "1" branch, otherwise use
  // the next unused numeric key — but primarily we match based on what the
  // in-menu sets DON'T cover.
  const inMenuLangVals = new Set(
    [...inMenuLangSets].map((id) =>
      (nodes[id].content?.assignments?.["Lang"] ?? "").toLowerCase(),
    ),
  );
  // Map normalised lang value → branch key used in the lang-select check
  const inMenuBranchKeys: Record<string, string> = {};
  for (const [bk, bv] of Object.entries(checkBranches)) {
    if (allLangSets.has(bv as string)) {
      const langVal = (
        nodes[bv as string].content?.assignments?.["Lang"] ?? ""
      ).toLowerCase();
      inMenuBranchKeys[langVal] = bk;
    }
  }

  for (const upfrontId of upfrontLangSets) {
    const upfrontNode = nodes[upfrontId];
    const rawLangVal = upfrontNode.content?.assignments?.["Lang"] ?? "";

    // Normalize the stored value to match set_action.py convention (ISO 639-2)
    const normalizedVal = LANG_CODE_MAP[rawLangVal.toUpperCase()] ?? rawLangVal.toLowerCase();

    // Update the upfront node's assignment to use the normalized value
    nodes[upfrontId] = {
      ...upfrontNode,
      content: {
        ...upfrontNode.content,
        assignments: {
          ...upfrontNode.content?.assignments,
          Lang: normalizedVal,
        },
      },
    };

    // The downstream target this upfront node was leading to
    const downstream = upfrontNode.default_next;

    // Bypass: rewrite every inbound edge that pointed to the upfront node
    //         to point instead to its default_next (skipping the lang set)
    for (const [nid, n] of Object.entries(nodes)) {
      let changed = false;
      const newBranches: Record<string, string> = {};
      for (const [bk, bv] of Object.entries(n.content?.branches ?? {})) {
        newBranches[bk] = bv === upfrontId ? (downstream ?? bv) : bv;
        if (bv === upfrontId) changed = true;
      }
      const newDn =
        n.default_next === upfrontId
          ? (downstream ?? n.default_next)
          : n.default_next;
      if (changed || newDn !== n.default_next) {
        nodes[nid] = {
          ...n,
          content: changed
            ? { ...n.content, branches: newBranches }
            : n.content,
          default_next: newDn,
        };
      }
    }

    // Point the upfront node's own default_next to the same downstream as its
    // in-menu sibling — wherever any other SET Lang node continues to (e.g. HOURS).
    // Priority: in-menu sibling's default_next > null-branch (timeout path).
    const continueTarget =
      [...inMenuLangSets].map((id) => nodes[id].default_next).find(Boolean) ??
      nodes[langSelectCheckId]?.content?.branches?.["null"] ??
      undefined;
    nodes[upfrontId] = { ...nodes[upfrontId], default_next: continueTarget };

    // Add a branch on the lang-select CHECK for this language.
    // Prefer key "1" for the first / only language being added if slot is free,
    // otherwise use the next available numeric key after existing ones.
    const existingKeys = Object.keys(
      nodes[langSelectCheckId].content?.branches ?? {},
    )
      .filter((k) => /^\d+$/.test(k))
      .map(Number)
      .sort((a, b) => a - b);
    const nextKey = String((existingKeys[existingKeys.length - 1] ?? 0) + 1);
    // Slot "1" is preferred for English (most common default); any other language
    // falls into the next sequential slot.
    const preferredKey =
      normalizedVal === "eng" && !checkBranches["1"] ? "1" : nextKey;

    nodes[langSelectCheckId] = {
      ...nodes[langSelectCheckId],
      content: {
        ...nodes[langSelectCheckId].content,
        branches: {
          ...nodes[langSelectCheckId].content?.branches,
          [preferredKey]: upfrontId,
        },
      },
    };
  }
}
// ─── Optimization & Validation Functions ──────────────────────────────────────

/**
 * Ensure every QueueSkill assignment has a paired SkillWhisper assignment.
 * If missing, create synthetic SkillWhisper based on queue name.
 */
export function ensureSkillWhisperPairing(ir: IR): IR {
  const nodes = { ...ir.nodes };
  const queueSkills = new Map<string, string>(); // step_id -> QueueSkill value
  const skillWhispers = new Set<string>(); // step_ids that have SkillWhisper

  // First pass: find all QueueSkill and SkillWhisper assignments
  for (const [id, node] of Object.entries(nodes) as [string, IVRNode][]) {
    if (node.action_type !== "SET") continue;
    const assignments = node.content?.assignments ?? {};

    if (assignments.QueueSkill) {
      queueSkills.set(id, String(assignments.QueueSkill));
    }
    if (assignments.SkillWhisper) {
      skillWhispers.add(id);
    }
  }

  // Second pass: ensure pairing
  for (const [qsStepId, qsValue] of queueSkills) {
    const node = nodes[qsStepId] as IVRNode;
    const assignments = { ...(node.content?.assignments ?? {}) };

    // If no SkillWhisper in this SET block, add it
    if (!assignments.SkillWhisper) {
      // Generate SkillWhisper from QueueSkill (e.g., "1234" -> "Queue_1234")
      assignments.SkillWhisper = `Queue_${qsValue}`;

      nodes[qsStepId] = {
        ...node,
        content: {
          ...node.content,
          assignments,
        },
      };

      console.log(
        `[Pairing] Added SkillWhisper="${assignments.SkillWhisper}" to step ${qsStepId} (QueueSkill="${qsValue}")`,
      );
    }
  }

  return { ...ir, nodes };
}

/**
 * Validate and normalize all language values in the IR.
 * Normalizes text object keys and SET Lang= values to ISO 639-2 codes
 * using LANG_CODE_MAP and full English language name aliases.
 */
export function validateAndNormalizeLanguages(ir: IR): IR {
  const nodes = { ...ir.nodes };
  let fixCount = 0;

  // Build a lookup that handles full English names and any LANG_CODE_MAP key.
  // Keys are lower-cased; values are ISO 639-2 codes.
  const FULL_NAME_MAP: Record<string, string> = {
    english: "eng", spanish: "spa", french: "fra", german: "deu",
    italian: "ita", portuguese: "por", chinese: "zho", japanese: "jpn",
    korean: "kor", russian: "rus", arabic: "ara", hindi: "hin",
    vietnamese: "vie", polish: "pol", dutch: "nld",
  };
  const normalizeKey = (key: string): string => {
    const lower = key.toLowerCase();
    return (
      LANG_CODE_MAP[key.toUpperCase()] ??
      FULL_NAME_MAP[lower] ??
      lower // keep as-is (already ISO 639-2 or unknown)
    );
  };

  for (const [id, node] of Object.entries(nodes) as [string, IVRNode][]) {
    // Normalize text object keys in PLAY / GATHER nodes
    if (
      (node.action_type === "PLAY" || node.action_type === "GATHER") &&
      node.content?.text
    ) {
      const text = node.content.text;
      if (typeof text === "object") {
        const fixed: Record<string, string> = {};
        let changed = false;

        for (const [key, val] of Object.entries(text)) {
          const norm = normalizeKey(key);
          if (norm !== key) {
            changed = true;
            fixCount++;
          }
          // Merge: if two keys normalise to the same code, keep the first non-empty value
          fixed[norm] = fixed[norm] || (val as string);
        }

        if (changed) {
          nodes[id] = { ...node, content: { ...node.content, text: fixed } };
        }
      }
    }

    // Normalize SET Lang= assignment values
    if (node.action_type === "SET" && node.content?.assignments?.Lang) {
      const langVal = String(node.content.assignments.Lang);
      const normalized = LANG_CODE_MAP[langVal.toUpperCase()] ?? langVal;

      if (normalized !== langVal) {
        nodes[id] = {
          ...node,
          content: {
            ...node.content,
            assignments: { ...node.content.assignments, Lang: normalized },
          },
        };
        fixCount++;
      }
    }
  }

  if (fixCount > 0) {
    console.log(`[Lang] Normalized ${fixCount} language value(s) to ISO 639-2`);
  }

  return { ...ir, nodes };
}

/**
 * Merge consecutive SET blocks that have no branching in between.
 * SET blocks can handle multiple assignments, so consolidate them.
 */
export function mergeSequentialSets(ir: IR): IR {
  const nodes = { ...ir.nodes };
  const merged = new Set<string>(); // IDs that have been merged away

  for (const [id, node] of Object.entries(nodes) as [string, IVRNode][]) {
    if (node.action_type !== "SET" || merged.has(id)) continue;

    const assignments = { ...(node.content?.assignments ?? {}) };
    let nextId = node.default_next;
    const chain: string[] = [id];

    // Follow chain of SET blocks
    while (
      nextId &&
      nodes[nextId]?.action_type === "SET" &&
      !merged.has(nextId)
    ) {
      const nextNode = nodes[nextId];
      const nextAssignments = nextNode.content?.assignments ?? {};

      // Check if there are any branches (if so, can't merge)
      const hasBranches =
        Object.keys(nextNode.content?.branches ?? {}).length > 0;
      if (hasBranches) break;

      // Check if any other node points to this next node (can't merge if so)
      const hasInbound = (Object.values(nodes) as IVRNode[]).some((n) => {
        if (n.step_id === id) return false; // Don't count ourselves
        if (n.default_next === nextId) return true;
        return Object.values(n.content?.branches ?? {}).includes(nextId);
      });
      if (hasInbound) break;

      // Merge assignments
      Object.assign(assignments, nextAssignments);

      // Mark for removal and continue chain
      merged.add(nextId);
      chain.push(nextId);
      nextId = nextNode.default_next;
    }

    // Update the base node if we merged anything
    if (chain.length > 1) {
      nodes[id] = {
        ...node,
        content: {
          ...node.content,
          assignments,
        },
        default_next: nextId,
      };
    }
  }

  // Remove merged nodes
  for (const id of merged) {
    delete nodes[id];
  }

  if (merged.size > 0) {
    console.log(`[Optimize] Merged ${merged.size} sequential SET block(s)`);
  }

  return { ...ir, nodes };
}

/**
 * Merge consecutive CHECK blocks that test the same variable.
 * CHECK can act as a switch statement with multiple branches.
 */
export function mergeSequentialChecks(ir: IR): IR {
  const nodes = { ...ir.nodes };
  const merged = new Set<string>(); // IDs that have been merged away

  for (const [id, node] of Object.entries(nodes) as [string, IVRNode][]) {
    if (node.action_type !== "CHECK" || merged.has(id)) continue;
    if (!node.content?.var) continue; // Only var-mode CHECKs can be merged

    const baseVar = node.content.var;
    const branches = { ...(node.content.branches ?? {}) };
    const chain: string[] = [id];

    // Look at the "null" / "default" / fallback branch
    let fallbackBranch = branches.null || branches.default || node.default_next;

    // Follow chain of CHECKs on the same variable
    while (
      fallbackBranch &&
      nodes[fallbackBranch]?.action_type === "CHECK" &&
      !merged.has(fallbackBranch)
    ) {
      const nextCheck = nodes[fallbackBranch];
      if (nextCheck.content?.var !== baseVar) break;

      // Check if any other node points to this next check (can't merge if so)
      const hasInbound = (Object.values(nodes) as IVRNode[]).some((n) => {
        if (chain.includes(n.step_id)) return false; // Don't count chain members
        if (n.default_next === fallbackBranch) return true;
        return Object.values(n.content?.branches ?? {}).some(
          (v) => v === fallbackBranch,
        );
      });
      if (hasInbound) break;

      // Merge branches from next check
      const nextBranches = nextCheck.content.branches ?? {};
      for (const [key, target] of Object.entries(nextBranches)) {
        // Don't overwrite existing branches (first match wins)
        if (key !== "null" && key !== "default" && !branches[key]) {
          branches[key] = target;
        }
      }

      // Mark for removal
      merged.add(fallbackBranch);
      chain.push(fallbackBranch);

      // Update fallback to next check's fallback
      fallbackBranch =
        nextBranches.null || nextBranches.default || nextCheck.default_next;
    }

    // Update the base node if we merged anything
    if (chain.length > 1) {
      // Update fallback branch
      if (fallbackBranch) {
        branches.null = fallbackBranch;
      }

      nodes[id] = {
        ...node,
        content: {
          ...node.content,
          branches,
        },
        default_next: fallbackBranch,
      };
    }
  }

  // Remove merged nodes
  for (const id of merged) {
    delete nodes[id];
  }

  if (merged.size > 0) {
    console.log(`[Optimize] Merged ${merged.size} sequential CHECK block(s)`);
  }

  return { ...ir, nodes };
}

// ─── P7: Collapse expression-check chains into var-mode CHECK branches ────────
/**
 * When a var-mode CHECK (branching on a digit variable) has branches that all
 * point into a sequential chain of expression CHECKs testing `variable == 'N'`,
 * we already know the variable's value at each branch — so we can resolve each
 * one deterministically and inline the correct True-branch target directly.
 *
 * Before:
 *   CHECK var=AHPMenu_RES { "1": chain, "2": chain, "3": chain, "4": chain }
 *   → CHECK expr="AHPMenu_RES == '1'" { True: setA, False: ... }
 *   → CHECK expr="AHPMenu_RES == '2'" { True: setB, False: ... }
 *   → ...
 *
 * After:
 *   CHECK var=AHPMenu_RES { "1": setA, "2": setB, "3": setC, "4": setD }
 *   (expression-check chain nodes removed if now unreachable)
 */
function _p7_collapseExprChains(nodes: Record<string, IVRNode>): void {
  // Parse expressions like: VARNAME == 'VALUE' or VARNAME == "VALUE"
  // Returns null if not this pattern.
  const parseEqExpr = (
    expr: string,
  ): { varName: string; value: string } | null => {
    const m = expr.trim().match(/^(\w+)\s*==\s*['"]([^'"]*)['"]\s*$/);
    if (!m) return null;
    return { varName: m[1], value: m[2] };
  };

  // Walk an expression-check chain for a known variable value.
  // Returns the target step ID this value should route to, plus the set of
  // expression-check node IDs visited along the way.
  const resolveChain = (
    startId: string,
    varName: string,
    knownValue: string,
    visited = new Set<string>(),
  ): { target: string; chainNodes: Set<string> } => {
    const chainNodes = new Set<string>();
    let currentId = startId;

    while (currentId) {
      if (visited.has(currentId)) break; // loop guard
      const node = nodes[currentId];
      if (!node || node.action_type !== "CHECK" || !node.content?.expression) {
        // Not an expression-check — this is our resolved target
        break;
      }
      const parsed = parseEqExpr(node.content.expression);
      if (!parsed || parsed.varName !== varName) {
        // Different variable or complex expression — stop here, don't inline
        break;
      }

      visited.add(currentId);
      chainNodes.add(currentId);

      if (parsed.value === knownValue) {
        // This expression matches our value — True branch is the target
        currentId = node.content.branches?.["True"] ?? "";
        break;
      } else {
        // No match — follow False branch and keep walking
        currentId = node.content.branches?.["False"] ?? "";
      }
    }

    return { target: currentId, chainNodes };
  };

  // Track all expression-check chain nodes that were inlined
  const allChainNodes = new Set<string>();

  for (const [id, node] of Object.entries(nodes)) {
    if (node.action_type !== "CHECK" || !node.content?.var) continue;
    const varName = node.content.var;
    const branches = node.content.branches ?? {};

    // Only act if at least one digit branch leads into an expression-check chain
    // for this same variable.
    const hasChainBranches = Object.entries(branches).some(([key, target]) => {
      if (!target || key === "null") return false;
      const n = nodes[target];
      if (!n || n.action_type !== "CHECK" || !n.content?.expression)
        return false;
      const parsed = parseEqExpr(n.content.expression);
      return parsed?.varName === varName;
    });
    if (!hasChainBranches) continue;

    const newBranches: Record<string, string> = {};
    const visitedGlobal = new Set<string>();
    let inlined = 0;

    for (const [key, target] of Object.entries(branches)) {
      if (!target || key === "null") {
        newBranches[key] = target;
        continue;
      }
      const targetNode = nodes[target];
      if (
        targetNode?.action_type === "CHECK" &&
        targetNode.content?.expression &&
        parseEqExpr(targetNode.content.expression)?.varName === varName
      ) {
        // Resolve: walk the chain knowing the variable equals `key`
        const { target: resolved, chainNodes } = resolveChain(
          target,
          varName,
          key,
          new Set(visitedGlobal),
        );
        newBranches[key] = resolved || target;
        chainNodes.forEach((n) => allChainNodes.add(n));
        if (resolved && resolved !== target) inlined++;
      } else {
        newBranches[key] = target;
      }
    }

    if (inlined > 0) {
      nodes[id] = {
        ...node,
        content: { ...node.content, branches: newBranches },
      };
      console.log(
        `[P7] Inlined ${inlined} expression-chain branch(es) into var-CHECK ${id} (${varName})`,
      );
    }
  }

  // Prune expression-check chain nodes that are now unreachable.
  // Build inbound-edge count after rewiring.
  if (allChainNodes.size === 0) return;

  const inbound: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    const targets = [
      node.default_next,
      ...Object.values(node.content?.branches ?? {}),
    ].filter(Boolean) as string[];
    for (const t of targets) inbound[t] = (inbound[t] ?? 0) + 1;
  }

  let pruned = 0;
  for (const chainId of allChainNodes) {
    if (!inbound[chainId]) {
      delete nodes[chainId];
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(
      `[P7] Pruned ${pruned} now-unreachable expression-check node(s)`,
    );
  }
}

// ─── P7b: Convert standalone expression-check chains to var-mode CHECKs ──────
/**
 * Finds chains of consecutive expression CHECKs all testing the same variable
 * with equality (VAR == 'val') and replaces the chain head with a single var-mode
 * CHECK, collapsing all cases into direct branches.
 *
 * Before: CHECK(QS=='A'){T→setA, F→} CHECK(QS=='B'){T→setB, F→fallback}
 * After:  CHECK var=QS { 'A': setA, 'B': setB, null: fallback }
 */
function _p7b_convertExprChainToVarCheck(nodes: Record<string, IVRNode>): void {
  const parseEqExpr = (
    expr: string,
  ): { varName: string; value: string } | null => {
    // Anchored at end: only PURE single-equality expressions collapse.
    // Compound conditions (e.g. "Lang == 'eng' and skillRES == '1'") must NOT
    // match — collapsing on the first variable alone drops the second condition
    // and makes distinct cases collide.
    const m = expr.trim().match(/^(\w+)\s*==\s*['"]([^'"]*)['"]\s*$/);
    if (!m) return null;
    return { varName: m[1], value: m[2] };
  };

  // Identify interior nodes: pointed to by another same-var expr CHECK's False branch
  const interiorIds = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.action_type !== "CHECK" || !node.content?.expression) continue;
    const parsed = parseEqExpr(node.content.expression);
    if (!parsed) continue;
    const falseTarget = node.content.branches?.["False"];
    if (!falseTarget || !nodes[falseTarget]) continue;
    const fn = nodes[falseTarget];
    if (fn.action_type !== "CHECK" || !fn.content?.expression) continue;
    const fp = parseEqExpr(fn.content.expression);
    if (fp?.varName === parsed.varName) interiorIds.add(falseTarget);
  }

  const toDelete = new Set<string>();

  for (const [headId, headNode] of Object.entries(nodes)) {
    if (headNode.action_type !== "CHECK" || !headNode.content?.expression)
      continue;
    if (interiorIds.has(headId)) continue;
    const headParsed = parseEqExpr(headNode.content.expression);
    if (!headParsed) continue;

    // Must have at least one False-chain successor on the same variable
    const firstFalse = headNode.content.branches?.["False"];
    if (!firstFalse || !nodes[firstFalse]) continue;
    const ffn = nodes[firstFalse];
    if (ffn.action_type !== "CHECK" || !ffn.content?.expression) continue;
    const ffp = parseEqExpr(ffn.content.expression);
    if (!ffp || ffp.varName !== headParsed.varName) continue;

    // Walk the full chain
    const varName = headParsed.varName;
    const cases: Array<{ value: string; target: string }> = [];
    const interiorChain: string[] = [];
    let fallthrough: string | undefined;
    let cur: string = headId;

    while (cur) {
      const cn = nodes[cur];
      if (!cn || cn.action_type !== "CHECK" || !cn.content?.expression) {
        fallthrough = cur;
        break;
      }
      const cp = parseEqExpr(cn.content.expression);
      if (!cp || cp.varName !== varName) {
        fallthrough = cur;
        break;
      }
      const trueTarget = cn.content.branches?.["True"];
      if (trueTarget) cases.push({ value: cp.value, target: trueTarget });
      if (cur !== headId) interiorChain.push(cur);
      cur = cn.content.branches?.["False"] ?? "";
      if (!cur) break;
    }

    if (cases.length < 2) continue;

    const newBranches: Record<string, string> = {};
    for (const { value, target } of cases) newBranches[value] = target;
    if (fallthrough) newBranches["null"] = fallthrough;

    const { expression: _removed, ...restContent } = headNode.content as any;
    nodes[headId] = {
      ...headNode,
      content: { ...restContent, var: varName, branches: newBranches },
    };
    interiorChain.forEach((id) => toDelete.add(id));
    console.log(
      `[P7b] Converted ${cases.length}-case expr chain on "${varName}" → var-mode CHECK at ${headId}`,
    );
  }

  // Recompute inbound and prune orphaned interiors
  const inbound: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    const targets = [
      node.default_next,
      ...Object.values(node.content?.branches ?? {}),
    ].filter(Boolean) as string[];
    for (const t of targets) inbound[t] = (inbound[t] ?? 0) + 1;
  }
  let pruned = 0;
  for (const id of toDelete) {
    if (!inbound[id]) {
      delete nodes[id];
      pruned++;
    }
  }
  if (pruned > 0)
    console.log(`[P7b] Pruned ${pruned} now-unreachable expression node(s)`);
}

// ─── P11: Nest compound menu-check chains into per-digit inner checks ─────────
/**
 * Refactors a flat chain of two-variable compound CHECKs
 * (e.g. "Lang == 'eng' and skillRES == '1'") fed by a var-mode menu CHECK into
 * the nested two-level form authored natively by flows like CareFirst:
 *
 *   CHECK var=skillRES { "1" -> CHECK var=Lang {…}, "2" -> CHECK var=Lang {…} }
 *
 * The outer var is the conjunct variable an existing var-mode CHECK already
 * branches on (the menu); the inner var is the other. The pass adds the inner
 * checks and repoints the menu's digit branches; the old compound chain is left
 * orphaned for P9 to sweep (matching the P7/P7b convention).
 */
function _p11_nestCompoundMenuChecks(nodes: Record<string, IVRNode>): void {
  // Parse "A == 'a' and B == 'b' [and …]" into its equality conjuncts.
  const parseConjunction = (
    expr: string,
  ): Array<{ varName: string; value: string }> | null => {
    const out: Array<{ varName: string; value: string }> = [];
    for (const part of expr.trim().split(/\s+and\s+/i)) {
      const m = part.trim().match(/^(\w+)\s*==\s*['"]([^'"]*)['"]$/);
      if (!m) return null;
      out.push({ varName: m[1], value: m[2] });
    }
    return out.length >= 2 ? out : null;
  };

  // A compound CHECK is an expression CHECK with exactly two equality conjuncts.
  const asCompound = (node: IVRNode | undefined) => {
    if (!node || node.action_type !== "CHECK" || !node.content?.expression)
      return null;
    const conj = parseConjunction(node.content.expression);
    return conj && conj.length === 2 ? { a: conj[0], b: conj[1] } : null;
  };
  const varPair = (c: { a: { varName: string }; b: { varName: string } }) =>
    [c.a.varName, c.b.varName].sort().join("|");

  // Interior chain nodes = the False target of another compound CHECK with the
  // same variable pair. These are never chain heads.
  const interior = new Set<string>();
  for (const node of Object.values(nodes)) {
    const c = asCompound(node);
    if (!c) continue;
    const f = node.content.branches?.["False"];
    const fc = asCompound(f ? nodes[f] : undefined);
    if (fc && varPair(c) === varPair(fc)) interior.add(f!);
  }

  for (const [headId, headNode] of Object.entries(nodes)) {
    const head = asCompound(headNode);
    if (!head || interior.has(headId)) continue;
    const pairKey = varPair(head);

    // Walk the False-chain collecting compound checks + the terminal fallthrough.
    const chain: string[] = [];
    let fallthrough: string | undefined;
    let cur: string | undefined = headId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const c = asCompound(nodes[cur]);
      if (!c || varPair(c) !== pairKey) {
        fallthrough = cur;
        break;
      }
      chain.push(cur);
      fallthrough = nodes[cur].content.branches?.["False"];
      cur = fallthrough;
    }
    if (chain.length < 2) continue;

    // Outer var = the conjunct variable an existing var-mode CHECK branches on.
    const [v1, v2] = pairKey.split("|");
    const menuFor = (v: string) =>
      Object.values(nodes).find(
        (n) => n.action_type === "CHECK" && n.content?.var === v,
      );
    const m1 = menuFor(v1);
    const m2 = menuFor(v2);
    let menu: IVRNode | undefined;
    let outerVar: string | undefined;
    if (m1 && !m2) {
      menu = m1;
      outerVar = v1;
    } else if (m2 && !m1) {
      menu = m2;
      outerVar = v2;
    } else continue; // ambiguous (both) or no menu → skip
    const innerVar = outerVar === v1 ? v2 : v1;

    // The menu must actually reach the chain head. This also guarantees
    // idempotency: after the rewrite the menu points at inner checks, not chain.
    const reaches = (start: string | undefined): boolean => {
      const stack = start ? [start] : [];
      const vis = new Set<string>();
      let hops = 0;
      while (stack.length && hops++ < 50) {
        const id = stack.pop()!;
        if (!id || vis.has(id) || !nodes[id]) continue;
        vis.add(id);
        if (id === headId) return true;
        const n = nodes[id];
        if (n.default_next) stack.push(n.default_next);
        for (const t of Object.values(n.content?.branches ?? {}))
          if (t) stack.push(t as string);
      }
      return false;
    };
    if (
      !Object.values(menu!.content?.branches ?? {}).some((t) =>
        reaches(t as string),
      )
    )
      continue;

    // Group chain checks by outer-var value.
    const groups: Record<string, Array<{ inner: string; target: string }>> = {};
    for (const cid of chain) {
      const c = asCompound(nodes[cid])!;
      const outerCon = c.a.varName === outerVar ? c.a : c.b;
      const innerCon = c.a.varName === outerVar ? c.b : c.a;
      const target = nodes[cid].content.branches?.["True"];
      if (!target) continue;
      (groups[outerCon.value] ??= []).push({ inner: innerCon.value, target });
    }

    // Safety: never silently drop a case — every group must map to a menu branch.
    const menuBranches = { ...(menu!.content?.branches ?? {}) };
    if (!Object.keys(groups).every((d) => d in menuBranches)) continue;

    // Build the inner checks and repoint the menu's digit branches.
    const menuId = menu!.step_id;
    for (const [d, cases] of Object.entries(groups)) {
      const innerId = `${menuId}__${innerVar}_${d}`;
      const branches: Record<string, string> = {};
      for (const { inner, target } of cases) branches[inner] = target;
      if (fallthrough) branches["null"] = fallthrough;
      nodes[innerId] = {
        step_id: innerId,
        action_type: "CHECK",
        label: `${innerVar} (${outerVar}=${d})`,
        content: { var: innerVar, branches },
      };
      menuBranches[d] = innerId;
    }
    nodes[menuId] = {
      ...menu!,
      content: { ...menu!.content, branches: menuBranches },
    };

    console.log(
      `[P11] Nested ${chain.length}-case compound chain at ${headId} under menu ${menuId} (outer=${outerVar}, inner=${innerVar})`,
    );
  }
}

// ─── P8: Promote null branches to default_next ────────────────────────────────
/**
 * For every node with a "null" branch key, promotes its target to default_next
 * (if default_next isn't already set) and removes the "null" key from branches.
 * "null" in var-mode CHECKs means "no input / timeout" and is equivalent to the
 * engine falling through to default_next.
 */
function _p8_nullBranchToDefaultNext(nodes: Record<string, IVRNode>): void {
  let moved = 0;
  for (const [id, node] of Object.entries(nodes)) {
    const branches = node.content?.branches;
    if (!branches || !("null" in branches)) continue;
    const nullTarget = branches["null"];
    const newBranches = { ...branches };
    delete newBranches["null"];
    nodes[id] = {
      ...node,
      content: { ...node.content, branches: newBranches },
      default_next: node.default_next ?? nullTarget ?? undefined,
    };
    moved++;
  }
  if (moved > 0)
    console.log(`[P8] Promoted ${moved} "null" branch(es) to default_next`);
  else console.log("[P8] No null branches found");
}

// ─── P9: Remove unreachable nodes ─────────────────────────────────────────────
/**
 * DFS from start_step. Any node not reachable is deleted.
 */
function _p9_removeUnreachableNodes(
  nodes: Record<string, IVRNode>,
  startId: string | undefined,
): void {
  if (!startId || !nodes[startId]) {
    console.log("[P9] No valid start node — skipping");
    return;
  }
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id) || !nodes[id]) continue;
    visited.add(id);
    const n = nodes[id];
    if (n.default_next) stack.push(n.default_next);
    for (const v of Object.values(n.content?.branches ?? {})) {
      if (v && typeof v === "string") stack.push(v);
    }
  }
  let removed = 0;
  for (const id of Object.keys(nodes)) {
    if (!visited.has(id)) {
      delete nodes[id];
      removed++;
    }
  }
  if (removed > 0) console.log(`[P9] Removed ${removed} unreachable node(s)`);
  else console.log("[P9] No unreachable nodes");
}

// ─── P10: Auto-rename nodes from content ─────────────────────────────────────
/**
 * Updates node labels to accurately reflect their current content.
 * Safe to re-apply — always derives from content, never from existing label.
 */
function _p10_autoRenameNodes(nodes: Record<string, IVRNode>): void {
  let renamed = 0;
  for (const [id, node] of Object.entries(nodes)) {
    let newLabel = node.label;
    const c = node.content ?? {};
    switch (node.action_type) {
      case "SET": {
        const keys = Object.keys(c.assignments ?? {});
        if (keys.length === 0) {
          newLabel = "Set (empty)";
          break;
        }
        if (keys.length === 1) {
          const val = (c.assignments as any)[keys[0]];
          newLabel = `${keys[0]} = ${val ?? "null"}`;
        } else if (keys.length <= 3) {
          newLabel = `Set ${keys.join(", ")}`;
        } else {
          newLabel = `Set ${keys.length} vars`;
        }
        break;
      }
      case "CHECK": {
        if (c.var) {
          newLabel = `Switch ${c.var}`;
        } else if (c.expression) {
          newLabel =
            c.expression.length > 45
              ? c.expression.slice(0, 42) + "…"
              : c.expression;
        }
        break;
      }
      case "GATHER":
        newLabel = c.variable ? `Gather → ${c.variable}` : "Gather";
        break;
      case "PLAY": {
        const textObj = c.text;
        const txt =
          typeof textObj === "string"
            ? textObj
            : Object.values(textObj ?? {}).find(v => v) ?? "";
        if (txt)
          newLabel = txt.length > 50 ? txt.slice(0, 47).trimEnd() + "…" : txt;
        break;
      }
      case "TRANSFER":
        newLabel =
          c.transferType === "SIP"
            ? "Transfer → SIP"
            : `Transfer → ${c.agentSkill ?? c.digits ?? "CONNECT"}`;
        break;
      case "HOURS":
        newLabel = c.hoo_arn
          ? `Hours (…${String(c.hoo_arn).slice(-6)})`
          : "Hours Check";
        break;
      case "WAIT":
        newLabel = `Wait ${c.seconds ?? "?"}s`;
        break;
      case "HANGUP":
        newLabel = "Hangup";
        break;
      case "START":
        newLabel = "Flow Start";
        break;
    }
    if (newLabel !== node.label) {
      nodes[id] = { ...node, label: newLabel };
      renamed++;
    }
  }
  if (renamed > 0) console.log(`[P10] Auto-renamed ${renamed} node(s)`);
  else console.log("[P10] Labels already accurate");
}

// ─── Public IR-level wrappers for each post-processing pass ──────────────────
// Each function takes an IR, applies the pass, and returns a new IR.
// They do NOT auto-run — the user triggers them manually via the UI.

export function applyDeferLangDefault(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    deferLangDefault(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP1RemoveBlockCall(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p1_removeBlockCallCheck(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP2NormaliseLang(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p2_normaliseLangAssignments(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP3SwapLangMenu(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p3_swapLangMenuToEnglishFirst(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP4RemoveRedundantNull(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p4_removeRedundantNullBranches(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP5MergeSequentialSets(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p5_mergeSequentialSets(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP6NormalisePolyHandoff(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p6_normalisePolyHandoff(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP7CollapseExprChains(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p7_collapseExprChains(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP7bConvertExprChains(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p7b_convertExprChainToVarCheck(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP8NullToDefaultNext(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p8_nullBranchToDefaultNext(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP9RemoveUnreachable(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p9_removeUnreachableNodes(nodes, ir.start_step);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP10AutoRename(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p10_autoRenameNodes(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyP11NestCompoundChecks(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    _p11_nestCompoundMenuChecks(nodes);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}

export function applyAllPostProcessing(ir: IR): { ir: IR; log: string[] } {
  const nodes = { ...ir.nodes };
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a) => {
    captured.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    deferLangDefault(nodes);
    applyLandingTransforms(nodes);
    _p7_collapseExprChains(nodes);
    _p7b_convertExprChainToVarCheck(nodes);
    _p11_nestCompoundMenuChecks(nodes);
    _p8_nullBranchToDefaultNext(nodes);
    _p9_removeUnreachableNodes(nodes, ir.start_step);
  } finally {
    console.log = orig;
  }
  return { ir: { ...ir, nodes }, log: captured };
}
