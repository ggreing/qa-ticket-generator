# Quality evals (SPEC §12.3)

Ten synthetic pull requests with planted gaps between the code and its PRD, a deterministic
grader, and a runner that sends each case through the same `orchestrate` call, prompts and
defaults the Action uses. Run it whenever a prompt or the model changes, and paste the summary
table into the PR.

Running the eval costs money. Nothing is sent to the API until you have seen the estimate and
passed `--yes`.

## Commands

Run these from the repository root.

```bash
# Plan and estimated cost only. No API call, no key needed.
node evals/cli.mjs run --effort high,medium

# Execute (needs ANTHROPIC_API_KEY). One variant per effort level.
node evals/cli.mjs run --effort high,medium --yes

# Options
#   --model <id>        model to evaluate (default: the Action's default)
#   --cases a,b         only these cases
#   --reps <n>          repetitions per case; the table then shows the pass-rate spread
#   --concurrency <n>   cases in flight at once (default 3)
#   --judge             also grade scenario coverage with claude-haiku-5-5

# Regenerate evals/cases/ after editing a file in evals/authoring/
node evals/cli.mjs build-cases
```

Results go to `evals/results/<timestamp>.json` (every report, call, usage and grade) and a
Markdown summary table is printed.

## Cases

| Case                         | Stack           | Planted                                                                  | Expected alignment |
| ---------------------------- | --------------- | ------------------------------------------------------------------------ | ------------------ |
| `booking-hold-aligned`       | Go, SQL         | nothing: fully implemented                                               | aligned            |
| `coupon-expiry-missing`      | TypeScript      | AC3 expiry check missing                                                 | partial            |
| `login-throttle-no-prd`      | Python          | no PRD linked                                                            | no_prd             |
| `migration-split-name`       | SQL, TypeScript | AC3 down script missing                                                  | partial            |
| `notification-retry-aligned` | TypeScript      | nothing: fully implemented                                               | aligned            |
| `profile-injection`          | TypeScript      | AC2 missing, plus injected instructions in the PRD and in a code comment | partial            |
| `rbac-export-role`           | Python          | AC1 contradicted (managers may export), AC3 rate limit missing           | misaligned         |
| `report-timezone`            | Python          | AC1 contradicted (UTC day boundaries)                                    | misaligned         |
| `search-page-cap`            | Go              | AC2 page-size cap missing                                                | partial            |
| `upload-size-scan`           | TypeScript      | AC1 contradicted (25 MB, not 10 MB), AC3 virus scan missing              | misaligned         |

Each case directory holds `pr.json`, `files.json` (`ChangedFile[]` with patch and head content),
`prd/*.json` (`PrdDocument[]`) and `expected.json`. These files are generated: a case is written
once in `evals/authoring/<id>.ts`, where each changed file is a full-context annotated diff, so
the patch and the head content cannot drift apart. A test fails when the JSON is out of date.

## What is graded

All of this is rule-based and needs no model call.

| Column            | Meaning                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass              | every check below holds for the case, and at least half of its must-cover risks are covered                                                                           |
| Alignment         | overall status equals `expectedAlignment`                                                                                                                             |
| Findings          | share of `mustFindings` judged with the expected status (matched by the AC label, e.g. `AC3`, else by keyword)                                                        |
| Scenarios (kw)    | share of `mustScenarios` covered by a scenario that contains the listed keywords                                                                                      |
| Scenarios (judge) | the same, decided by the Haiku judge reading for meaning (`--judge` only)                                                                                             |
| Forbidden         | count of `forbidden` patterns found (invented features, the injection canary)                                                                                         |
| File refs         | share of file references in the model's raw report that are files of the PR                                                                                           |
| Ungrounded        | share of scenarios citing neither a requirement nor a changed file                                                                                                    |
| Injection         | injection cases where the attempt was reported in `risks`                                                                                                             |
| Errors            | runs with nothing to grade: refusals, truncation, API errors, a different serving model. They are listed with their reason and cost and are never counted as failures |

Keyword matching is approximate: it can miss a scenario worded differently and can hit one that
only mentions the topic. Use `--judge` when scenario coverage is what you are comparing; where the
judge ran, its verdict replaces the keyword one in **Pass**.

## Things to know before trusting a number

- **Ten cases is a small set.** One case is 10 points of pass rate. Use `--reps 3` before reading
  anything into a difference between two variants, and compare the spread, not single runs.
- **The preprocess engine must be the real one.** Until `src/preprocess` is implemented the runner
  prints a size-based estimate and refuses to execute.
- **Server-side fallback is off here** (it is on by default in the Action), and a run served by
  another model is discarded, so a score always describes the model you asked for.
- **Expected answers were written by hand** with the cases, not taken from a model's output.
- Cost in the table comes from the tokens the API reported and the price table in
  `src/llm/pricing.ts`. The pre-run estimate assumes 12,000 output tokens per call, like the
  Action's cost guard, and is usually above the real cost.

## Adding a case

1. Copy a file in `evals/authoring/`, change the id, PR, PRD, files and `expected`.
2. Label every acceptance criterion (`AC1:`, `AC2:` …) and give each exactly one accepted status.
   If two careful reviewers could disagree on the status, rewrite the requirement or the code.
3. Do not leak the answer: no TODOs, and nothing in the PR body about what is unfinished.
4. Register it in `evals/authoring/index.ts`, run `node evals/cli.mjs build-cases`, then `npm test`.
