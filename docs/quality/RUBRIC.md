# QA case quality rubric (v3)

Rubric v3 follows the product redefinition in `docs/SPEC.v3.ko.md` (2026-11-13): the tool writes the full QA
case sheet of a spec, one ticket per case, and later checks each case against the pull request. A _good_
sheet has every case a tester must run, including the ones a person reading the spec would miss, written the
way a working QA engineer writes them. This document is the scoring guide for the LLM judge and for human
reviewers. The rubric used during M3.5 (PR-comment tickets, v1 and v2) is kept in
[`RUBRIC.v2.md`](RUBRIC.v2.md); scores from different rubric versions are never compared.

Deterministic checks stay in code (`evals/v3/grade.ts`): must-cover recall, requirements with a case, style
rule violations, repeated titles, and code-status accuracy. This rubric covers what code cannot judge.

## Case-level criteria (each case, 0–2)

| Criterion              | 0                                                                  | 1                                                                 | 2                                                                                                 |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Actionability**      | Vague ("should work correctly"); a tester cannot run it            | Runnable but missing data or a concrete expected result           | Preconditions, test data, steps and expected result are concrete enough to execute without asking |
| **Traceability**       | Cites no requirement, or one that does not say what the case tests | Cites a requirement the case only loosely follows from            | Cites the requirement it tests and follows from what that requirement says or leaves open         |
| **Priority**           | P0/P2 inverted (e.g. cosmetic as P0, payment loss as P2)           | Off by one level                                                  | Matches business impact (P0 = data loss, money, security, core flow)                              |
| **Easy-to-miss value** | Not a real case for this spec, or another case in different words  | A case the spec states outright; needed, but nobody would miss it | A case a person reading only the spec would likely miss, and whose failure would matter           |
| **QA-sheet style**     | Explanatory or persuasive voice, stock AI phrases                  | Partly explanatory                                                | Indistinguishable from a working QA sheet                                                         |

## Sheet-level criteria (all cases of one spec, 0–2)

| Criterion         | 0                                                                              | 1                                                                                | 2                                                                              |
| ----------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Spec coverage** | Three or more requirement-and-technique combinations that apply have no case   | One or two such combinations have no case                                        | Every technique that applies to every requirement has a case                   |
| **No duplicates** | Several cases repeat the same test intent                                      | One or two repeats                                                               | No two cases test the same thing; length alone is never a fault                |
| **Honesty**       | Tests features the spec does not mention, or states undefined behavior as fact | Stays inside the spec, but some outcomes the spec leaves open are stated as fact | Stays inside the spec, and names the open question wherever the spec is silent |

Notes for both the judge and human reviewers:

- **Spec coverage is the most important criterion.** For each requirement, go through the twelve techniques
  (happy path, boundary, equivalence, invalid input, state transition, permission, concurrency, failure,
  idempotency, compatibility, locale and time, data integrity) and decide which apply. A technique applies
  only when the requirement gives it something to test, and what the spec leaves open counts as something
  to test.
- **Length is not judged.** A sheet of 60 cases is as good as a sheet of 20 if both cover the spec without
  repeating themselves.
- **What counts as a duplicate** (v3.1). Two cases repeat each other only when a tester who ran one would
  learn nothing from the other: the same setup, the same action, the same thing observed. Cases that differ
  in the state they start from, the actor, the side of a limit they test, or what is observed are not
  duplicates, however alike their titles are. The last value that passes and the first that fails are two
  cases, and so is the limit itself when the spec does not say whether it is included. Several values of one
  kind with the same result, the same scenario filed under two techniques, and the same situation written
  once per requirement with nothing different to observe are duplicates.
- **Easy-to-miss value** is about the case, not about how its reason is worded. A plain happy path scores 1.
- **QA-sheet style** is judged in the language of the sheet, by that language's QA conventions (SPEC v3
  §3.1). The deterministic count of style-rule violations is reported next to it.
- **Traceability** of a case derived from code (origin `code`) is judged on the code location it names.

## PR-level criterion (verify phase)

| Criterion                | How it is scored                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code-status accuracy** | Deterministic where ground truth exists: share of requirements whose cases carry the right status. A requirement known to be missing needs a case marked `missing`, one known to be contradicted a case marked `contradicts`, and one known to be covered a case marked `implemented` and none marked `contradicts`. The share left `unknown` is shown. |

## Scoring

- Case score = mean of the five case criteria over the cases scored (0–2). The judge scores a fixed sample
  of 20 cases per sheet in full and sees the whole sheet as an index.
- Sheet score = (2 × spec coverage + no duplicates + honesty) / 4. Coverage counts double.
- Overall = 0.5 × case score + 0.5 × sheet score, reported per spec and averaged per run.
- A round "improves" only if the dev overall rises **and** no deterministic metric regresses (must-cover
  recall, requirements with a case, style violations per 100 cases, code-status accuracy).
- Scores are compared only between runs judged with the same rubric version and written in the same
  language.

## Procedure

1. **Data:** the 25 synthetic cases (spec, PR, ground truth) and the real public PRs, split into `dev` and
   `test` as before. The plan phase is evaluated from the spec alone; the verify phase uses the sheet of a
   plan run and the case's pull request.
2. **Each round:** change one thing, run `dev`, read the deterministic metrics and the judge's scores, keep
   or revert.
3. **Judge calibration and the user's own rating** are done on Korean output, as in M3.5: the judge's
   scores are trusted only where they agree with the owner's ratings within 0.5 on average.
4. Every paid run is approved by the owner, with the estimated cost shown first.
