// src/converter/convertCXJson.ts
/**
 * convertCXJson.ts — CXone Studio JSON → Engine IR (fully atomic)
 *
 * Fix log (v4):
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
 */

import type { IR, IVRNode, SayText } from "../types";

// ─── Expression normalizer ────────────────────────────────────────────────────
/**
 * Normalises a CXone expression for the Python engine:
 *
 * 1. Single = → ==  (CXone uses = for equality)
 *    Skips !=, <=, >=, already-doubled ==
 *
 * 2. Lang comparison values rewritten to match set_action.py normalization:
 *    set_action.py stores Lang as 'eng' or 'spa'.
 *    CXone source compares against 'EN', 'SP', 'ES' — rewrite those here.
 */
function normalizeExpr(expr: string): string {
  if (!expr) return expr;

  // 1. single = → ==  (negative lookbehind for ! < > =, negative lookahead for =)
  let out = expr.replace(/(?<![!<>=])=(?!=)/g, "==");

  // 2. Lang value normalization — both double and single quote variants
  out = out.replace(
    /\bLang\s*(==|!=)\s*["']EN["']/gi,
    (_, op) => `Lang ${op} 'eng'`,
  );
  out = out.replace(
    /\bLang\s*(==|!=)\s*["']SP["']/gi,
    (_, op) => `Lang ${op} 'spa'`,
  );
  out = out.replace(
    /\bLang\s*(==|!=)\s*["']ES["']/gi,
    (_, op) => `Lang ${op} 'spa'`,
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

// ─── Bilingual phrase parser ──────────────────────────────────────────────────
const EN_RE = /(?:^|\n)\s*EN[\s\-:]+(.+?)(?=\n\s*SP[\s\-:]|$)/is;
const SP_RE = /(?:^|\n)\s*SP[\s\-:]+(.+?)$/is;

export function parseBilingual(phrase: string): SayText {
  if (!phrase) return { eng: "", spa: "" };
  const enMatch = EN_RE.exec(phrase);
  const spMatch = SP_RE.exec(phrase);
  if (enMatch || spMatch) {
    return {
      eng: enMatch ? enMatch[1].trim() : phrase.trim(),
      spa: spMatch ? spMatch[1].trim() : "",
    };
  }
  return { eng: phrase.trim(), spa: "" };
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
  ops: AssignOp[];
}

function parseSnippet(data: string): SnipCase[] {
  const lines = data
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim());
  const cases: SnipCase[] = [];
  let switchVar: string | undefined;
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
      continue;
    }

    const cs = line.match(/^CASE\s+(\S+)/i);
    if (cs) {
      cases.push({ switchVar, switchVal: cs[1], ops: [] });
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
    if (c.switchVar && c.switchVal !== undefined) {
      caseIfId = `${prefix}_sw`;
      // [Fix #1/#2] normalizeExpr handles = → == and Lang value rewriting
      nodes[caseIfId] = {
        step_id: caseIfId,
        action_type: "CHECK",
        label: `${label}: Case ${c.switchVal}`,
        content: {
          expression: normalizeExpr(`${c.switchVar} == '${c.switchVal}'`),
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
      spa: "",
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
      nb[k] = resolveSnEntry(v);
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
      nb[k] = resolveSnEntry(v);
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

  // ── Post-pass: defer upfront language default ─────────────────────────────
  // Pattern to fix: flows that SET Lang=eng before the language-selection menu,
  // meaning English is the default even before the caller chooses.
  // We move the SET Lang node so it's only reached when the caller presses the
  // English option, and leave Lang unset for callers who press nothing —
  // the engine's PLAY fallback will then serve both-language prompts.
  deferLangDefault(nodes);

  return { flow_id: flowId, nodes, start_step: startStepId };
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
    const normLangVal = rawLangVal.toLowerCase();

    // Normalize the stored value to match set_action.py convention
    const normalizedVal =
      normLangVal === "en" || normLangVal === "eng"
        ? "eng"
        : normLangVal === "sp" || normLangVal === "spa" || normLangVal === "es"
          ? "spa"
          : normLangVal;

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

    // Point the upfront node's own default_next to the same downstream
    // as its in-menu sibling set — i.e. wherever s16 goes (hours, etc.)
    // Do NOT keep s17's original default_next, which pointed through the greeting
    // and would loop back into the lang menu.
    // Best proxy: the null-branch target of the lang-select CHECK (the "no choice" path).
    const continueTarget =
      nodes[langSelectCheckId]?.content?.branches?.["null"] ??
      [...inMenuLangSets].map((id) => nodes[id].default_next).find(Boolean) ??
      inMenuDownstream;
    nodes[upfrontId] = { ...nodes[upfrontId], default_next: continueTarget };

    // Add a branch on the lang-select CHECK for this language
    // Use the same numeric key pattern as the other branches, or "1" if eng
    const existingKeys = Object.keys(
      nodes[langSelectCheckId].content?.branches ?? {},
    )
      .filter((k) => /^\d+$/.test(k))
      .map(Number)
      .sort((a, b) => a - b);
    const nextKey = String((existingKeys[existingKeys.length - 1] ?? 1) + 1);
    // For English (the common case), prefer key "1" if not already taken
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
  for (const [id, node] of Object.entries(nodes)) {
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
    const node = nodes[qsStepId];
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
 * Ensures text objects use 'eng' and 'spa' consistently.
 */
export function validateAndNormalizeLanguages(ir: IR): IR {
  const nodes = { ...ir.nodes };
  let fixCount = 0;

  for (const [id, node] of Object.entries(nodes)) {
    // Check PLAY/GATHER text objects
    if (
      (node.action_type === "PLAY" || node.action_type === "GATHER") &&
      node.content?.text
    ) {
      const text = node.content.text;
      if (typeof text === "object") {
        const fixed: any = {};
        let changed = false;

        for (const [key, val] of Object.entries(text)) {
          const normKey = key.toLowerCase();
          if (normKey === "en" || normKey === "english") {
            fixed.eng = val;
            changed = true;
            fixCount++;
          } else if (
            normKey === "sp" ||
            normKey === "es" ||
            normKey === "spanish"
          ) {
            fixed.spa = val;
            changed = true;
            fixCount++;
          } else if (normKey === "eng" || normKey === "spa") {
            fixed[normKey] = val;
          } else {
            console.warn(`[Lang] Unknown language key "${key}" in ${id}`);
            fixed[normKey] = val;
          }
        }

        if (changed) {
          nodes[id] = {
            ...node,
            content: {
              ...node.content,
              text: fixed,
            },
          };
        }
      }
    }

    // Check SET Lang assignments
    if (node.action_type === "SET" && node.content?.assignments?.Lang) {
      const langVal = String(node.content.assignments.Lang);
      const normalized =
        langVal.toLowerCase() === "en" || langVal === "EN"
          ? "eng"
          : langVal.toLowerCase() === "sp" ||
              langVal === "SP" ||
              langVal === "ES"
            ? "spa"
            : langVal;

      if (normalized !== langVal) {
        nodes[id] = {
          ...node,
          content: {
            ...node.content,
            assignments: {
              ...node.content.assignments,
              Lang: normalized,
            },
          },
        };
        fixCount++;
      }
    }
  }

  if (fixCount > 0) {
    console.log(`[Lang] Normalized ${fixCount} language value(s) to eng/spa`);
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

  for (const [id, node] of Object.entries(nodes)) {
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
      const hasInbound = Object.values(nodes).some((n) => {
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

  for (const [id, node] of Object.entries(nodes)) {
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
      const hasInbound = Object.values(nodes).some((n) => {
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
