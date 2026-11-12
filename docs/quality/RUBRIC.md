# QA ticket quality rubric

Agreed with the project owner on 2026-11-12 (draft v1, refined each improvement round). It defines what a
_good_ QA ticket is, and is the scoring guide for both the LLM judge and human reviewers in the M3.5 quality
loop. Deterministic checks (alignment status, findings recall, file validity, forbidden content) stay in
`evals/grade.ts`; this rubric covers what code cannot judge.

## Scenario-level criteria (each scenario / ticket card, 0–2)

| Criterion          | 0                                                        | 1                                                       | 2                                                                                                                        |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Actionability**  | Vague ("should work correctly"); a tester cannot run it  | Runnable but missing data or a concrete expected result | Preconditions, test data, steps and expected result are concrete enough to execute without asking                        |
| **Traceability**   | No source, or cites the wrong AC / code                  | Source given but loose (file only, or AC paraphrased)   | Points to the exact AC and the code location the scenario exercises                                                      |
| **Risk relevance** | Trivial, or already guaranteed by types/framework        | Plausible but low-impact                                | Targets where this change is likely to break (boundaries, concurrency, failure paths, state transitions, data integrity) |
| **Priority**       | P0/P2 inverted (e.g. cosmetic as P0, payment loss as P2) | Off by one level                                        | Matches business impact (P0 = data loss, money, security, core flow)                                                     |

## Report-level criteria (whole comment, 0–2)

| Criterion                 | 0                                                    | 1                              | 2                                                                                       |
| ------------------------- | ---------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| **Alignment correctness** | Misses or invents missing/contradicting requirements | Mostly right, one wrong status | Every finding status is correct (deterministic grade when ground truth exists)          |
| **Concision**             | Duplicates and padding bury the important items      | Some redundancy                | No duplicates; a reviewer gets the verdict and P0 actions from the top section alone    |
| **Honesty**               | States unverifiable things as fact                   | Hedges inconsistently          | Anything not visible in the diff/PRD is labelled as an assumption; no invented features |

## Scoring

- Scenario score = mean of the four scenario criteria over all scenarios (0–2).
- Report score = mean of the three report criteria (0–2).
- Overall = 0.5 × scenario score + 0.5 × report score, reported per case and averaged per variant.
- A round "improves" only if the dev-set overall rises **and** no deterministic metric regresses
  (alignment accuracy, findings recall, injection resistance).

## Procedure (M3.5)

1. **Data split:** synthetic cases with ground truth + real public PRs (judge/human only).
   `dev` is used for iteration; `test` is touched once at the end.
2. **Each round:** change one thing (prompt, output format, context) → run `dev` → deterministic grade +
   LLM judge with this rubric → owner rates a 5-ticket sample in the review page → keep or revert.
3. **Judge calibration:** compare judge scores with the owner's ratings on the same samples each round;
   if they disagree by more than 0.5 on average, refine the judge prompt or this rubric before trusting it.
4. Budget: about $30 for the whole loop (5 rounds + final test), every paid run approved by the owner.
