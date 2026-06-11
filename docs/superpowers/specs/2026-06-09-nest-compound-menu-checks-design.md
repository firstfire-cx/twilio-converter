# P11 — Nest Compound Menu Checks

## Problem

CareFirst's skill-routing snippet is authored as a nested switch:

```
SWITCH CFHMenu_RES { CASE 1 { IF Lang … ELSE … } CASE 2 { IF Lang … ELSE … } }
```

which converts to a clean two-level tree: the menu CHECK branches per digit into a
per-digit `Lang` check.

BrightHealth's snippet is authored flat:

```
SELECT { CASE lang = "EN" & skillRES = 1 { … } … (6 compound cases) }
```

which converts to a flat 6-deep chain of compound CHECKs (`Lang == 'eng' and
skillRES == '1'`, …). Every node redundantly re-tests `skillRES`, which the
upstream menu CHECK already determined. The diagram is harder to read and does
not match the CareFirst shape.

## Goal

A post-processing pass that refactors the flat compound chain into the nested
two-level form, matching CareFirst:

```
CHECK var=skillRES
  "1" -> CHECK var=Lang { eng->queue, spa->queue, zho->queue }
  "2" -> CHECK var=Lang { eng->queue, spa->queue, zho->queue }
```

## Approach: post-processing pass (P11)

A pass has full graph context (it can see the `skillRES` menu CHECK feeding the
chain and reuse it as the outer check). Fits the existing toggleable P1–P10
architecture. The parser/expander is the wrong layer — it has no menu context and
CareFirst already nests at the source level.

### Detection (conservative)

- A **compound CHECK** = an expression CHECK whose expression parses as exactly
  two `VAR == 'value'` conjuncts joined by `and`.
- A **chain** = a maximal `False`-linked run of compound CHECKs sharing the same
  unordered variable pair `{outer, inner}`.
- **Outer var** = the conjunct variable that equals the `var` of some var-mode
  CHECK `M` in the graph (the menu). Inner var = the other. If neither or both
  qualify ambiguously, skip.
- **Connection:** `M` must reach the chain head (BFS over its branch targets,
  depth-limited, skipping inert intermediate nodes such as the dead `test == 1`
  debug IF). This requirement is also what makes the pass idempotent — after the
  rewrite `M` points at inner `Lang` checks, no longer at a compound chain.

### Transform

1. Group chain checks by outer-var value `d`.
2. For each `d` that is a branch key of `M`, build an inner `CHECK var=inner`
   with branches `{ value: trueTarget, … , null: fallthrough }` where fallthrough
   = the chain's terminal `False` target.
3. Repoint `M.branches[d]` → the inner check. Preserve M's other branches.
4. Do **not** delete the old chain; leave it orphaned for P9 to sweep (matches
   the convention of P7/P7b). Adding-only + repoint keeps referential integrity
   when the pass runs standalone.

### Safety

- Fire only when every group's `d` is a branch key of `M` (never silently drop a
  queue case).
- Single-conjunct chains (CareFirst's `IF Lang == 'SP'`) never match — they are
  not compound — so CareFirst is untouched.

### Placement

New toggleable pass in `PostProcessPanel` (badge **P11**) and added to
`applyAllPostProcessing`, ordered after P7b and before P8/P9: P8 promotes the
inner `null` → `default_next`; P9 sweeps the orphaned chain + dead debug IF.

## Testing (TDD)

- Synthetic IR matching BrightHealth's shape → asserts nested tree, idempotent.
- Negative: single-conjunct chain / no matching menu var → untouched.
- Real-file integration: full pipeline → `m7_check` branches to two distinct
  `var=Lang` inner checks; 0 dangling refs; idempotent.
