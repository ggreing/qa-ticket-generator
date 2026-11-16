# Plan prompt: the seven questions

Status: **not in the prompt.** Tried twice (v3 rounds 2 and 3) and reverted twice. The prompt in use is
the round 1 text again, as plan prompt `2026-11-16.4`. This memo keeps the section as round 2 ran it,
what each round showed, and why a result on the dev specs did not carry over to the test specs. Read
"What this taught" before trying the questions a third time.

## Why it was written

Spec coverage, as the rubric judge scores it, stayed at 1.43 over rounds 0 and 1. The combinations the
judge listed as missing (about 60 over both rounds) fall into a few kinds that none of the twelve
techniques asks for outright:

| Kind                                                    | About | Example of what was missing                              |
| ------------------------------------------------------- | ----- | -------------------------------------------------------- |
| What follows a failure or a refusal                     | 12    | the retry, whether a refused attempt counts toward a cap |
| A period across a boundary, both ends of a window       | 10    | a shift into a holiday, an action just after expiry      |
| Another person, per action                              | 9     | confirming or releasing someone else's reservation       |
| Zero, empty, negative, largest                          | 8     | a 0% rate, an empty cart, a missing actor id             |
| The exact form of what comes back, and what must not be | 7     | a header as a whole number, the fields of a log entry    |
| The state of something the requirement does not own     | 6     | a deleted contact, a revoked key                         |
| Per what a rule applies, several at once                | 5     | rounding per line or on the total, expiring together     |
| A change to the value already there                     | 3     | changing to a plan of the same price                     |

## The section as round 2 ran it (plan prompt 2026-11-16.1)

It sat after the technique list and before "One intent, one case". Each task also ended with "then put
the questions a requirement does not ask for to it." The examples are about a shared playlist on
purpose: no eval case is about one, so they cannot hand a case its answer. A test checks that this
stays true of the text below.

```text
# Questions a requirement does not ask for

Going through the techniques finds the cases a requirement points at. The cases that were missing from earlier sheets came from a few questions that no technique asks outright. Put each of them to every requirement before you move on. Where the answer is a situation you have no case for, write the case. Where the requirement gives the question nothing to act on, leave it.

- Who else? Permission belongs to the action, not to the feature. For each action the requirement names, think of the person it does not name: someone acting on another person's item, a role without the right, the same person in a second session. A playlist that only its owner may delete and only collaborators may add to needs a case for each of the two.
- Zero, empty, the same? For each value the requirement computes with or compares: zero, empty or absent, negative, and the largest it can take. For each change it describes: changing to the value that is already there, such as saving a title that was not edited.
- Per what? A limit, a timer, a count or a rounding rule holds per person, per session, per item or for the total, and the requirement often does not say which. Then several at once: three invitations that run out in the same minute.
- Across the line? A period that begins before a boundary and ends after it, both ends of a time window, and the action that arrives just after something ran out, such as accepting an invitation one second late.
- And then? After a failure or a refusal: the retry, whether the failed attempt counted toward a limit, and what the person can do next. After a success: taking it back, and whether what was used up is returned, such as a follower slot when a follower is removed.
- What state is the other thing in? The things the requirement touches but does not own: an item that was archived or removed, an account that was closed, a link that was already used.
- What exactly comes back? When the requirement names a response, a message or a stored record: its exact form, and that nothing is stored when the action is refused.

These questions add cases; they do not loosen what follows. An answer the spec does not give is an open question and is written as one. A second value of the same kind still belongs in `testData`, and a situation you already have is not written again because another question leads to it too.
```

## What the rounds showed

Round 2 was first recorded as a revert, on a coverage score that could not have shown an improvement:
the judge listed one to three missing combinations for almost any sheet, and the score read 1.43 with the
same distribution in rounds 0, 1 and 2. Coverage is since compared by the recall of a fixed list per spec
(`expected.secondOrder`, 96 combinations over the 14 dev specs), and the three rounds were scored again
under rubric v3.2:

| Round | Prompt       | Overall | 2nd-order recall | No duplicates | Honesty | Cases/spec |
| ----- | ------------ | ------- | ---------------- | ------------- | ------- | ---------- |
| 0     | 2026-11-13.1 | 1.70    | 86%              | 1.00          | 1.79    | 53.6       |
| 1     | 2026-11-13.2 | 1.82    | 82%              | 1.36          | 2.00    | 39.2       |
| 2     | 2026-11-16.1 | 1.75    | 91%              | 1.14          | 1.93    | 42.8       |

Two judgings of round 1's sheets differ by 0.03 in the overall, so the 0.07 between rounds 1 and 2 is
more than the judge's own movement. The questions found what they were written for (11 combinations
gained, 3 lost) and cost on duplicates.

## What round 2 got wrong, and what round 3 changed

Round 2's sheets had 23 duplicate groups against 15 in round 1. Read one by one:

- **The same answer once per requirement** (about 8 groups). The section said "put each of them to every
  requirement", and it was: a double tap written for two requirements, an empty result for two, a
  refused request logged for two kinds of refusal. Round 3 put each question to the requirements taken
  together, once per action, value and period.
- **Two ways of being empty** as two cases (a file with only a header and a file of zero bytes; no key and
  an unknown key). Round 3: one case, the variants in `testData`.
- **A late arrival written twice**, once as a boundary and once as a race, and a boundary repeated with a
  time of day. Round 3: the two sides of a limit belong to the boundary technique; the question adds only
  the period that spans the line and the late arrival, each once.
- **A refused request sent again.** Round 3 said outright that this is not a case.

"Who else?" was suspected and is not the cause: one group, and several of the gains.

Honesty fell on one sheet, where a case brought in a payment step and a "sold" state that the spec does not
have. Round 3 added that the person, the value, the period and the later action have to be ones the spec
itself mentions.

Round 3's section ended with four rules for whatever the questions turn up: a question is not a second
route to a second case; one case for several requirements; nothing the spec does not name; open answers
as open questions. The merge pass was changed with it: it ran for every sheet, also one written in a
single call; it was told that the route by which a case was reached does not matter; and it saw every
expected result instead of the first. The text is in the history: `git show f8996e5:src/llm/prompts/plan.ts`.

## What round 3 showed (plan prompt 2026-11-16.3)

On the 14 dev specs, against round 1:

| Metric           | Round 1 | Round 3 |
| ---------------- | ------- | ------- |
| Overall          | 1.82    | 1.81    |
| 2nd-order recall | 82%     | 93%     |
| No duplicates    | 1.36    | 1.36    |
| Honesty          | 2.00    | 1.93    |
| Must-cover       | 100%    | 98%     |
| Style viol./100  | 0.0     | 0.2     |
| Cases/spec       | 39.2    | 37.9    |

Eleven combinations of the fixed list gained and one lost, at the same duplicate score: on the dev specs
it looked like what round 3 was written to do.

On the 9 test specs, the same two prompts (A is the round 1 prompt at `06c3be6`, B is `2026-11-16.3`,
compared with `plan --compare` on the nine sheets both runs have):

| Metric           | A: round 1 prompt | B: 2026-11-16.3 |
| ---------------- | ----------------- | --------------- |
| Overall          | 1.84              | 1.78            |
| 2nd-order recall | 89%               | 90%             |
| No duplicates    | 1.56              | 1.33            |
| Must-cover       | 98%               | 98%             |
| Style viol./100  | 0.6               | 0.0             |
| Cases/spec       | 39.9              | 39.1            |

No gain in recall, a lower duplicate score on two of the nine sheets, and an overall lower by 0.06, which
is twice what the judge moves on its own (0.03). Round 3 is recorded as a revert.

(Run B held four more sheets, real cases that were on that machine only. Its duplicate score and cases per
spec were first read over all thirteen, as 1.31 and 35.6. The figures above are over the nine sheets both
runs hold, which is what `plan --compare` now does for every figure and not only for the overall.)

The merge changes had nothing to show either. On the seven dev sheets written in one call, the pass that
round 3 added removed one case of 237. On the seven dev sheets that had a merge pass in both rounds, it
removed 6 cases with every expected result in its index and 7 with the first one only, and the judge
found 11 duplicate groups against 10. On the nine test sheets the pass removed no case at all. Both
changes are reverted with the prompt.

## What this taught

**The dev lists and the questions have the same source.** The seven questions were written from what the
judge listed as missing on the dev sheets of rounds 0 and 1 (the table at the top). The dev specs'
`expected.secondOrder` lists were written afterwards, with those sheets and those gaps known. A prompt
that names the kinds of gap found on the dev sheets then scores well on a list of the gaps found on the
dev sheets: 82% to 93%. The test specs' lists were written without any generated sheet in view, and
there the same prompt moved recall from 89% to 90%. The 11 points on dev measured how well the prompt
fits the list, not how many more combinations it finds.

The round 1 prompt already reaches 89% on the test lists. That leaves about one combination per spec, and
little room for a section this size to pay for itself.

What follows for later rounds:

- **A plan-prompt change that was thought of while reading dev sheets, dev scores or dev lists is decided
  on the test split.** Generate the test specs under the prompt in use and under the new one, with the
  spec ids fixed by `--cases` so that both runs hold the same sheets, and compare with `plan --compare`
  (commands in `evals/README.md`). The dev round still runs: it shows regressions and gives sheets
  that may be read.
- **The test sheets are not read to write the next change.** Their numbers decide; their cases, the
  judge's missing lists and its duplicate groups stay unread by whoever writes prompts. Once a prompt is
  written from them, the test split is a second dev split.
- **A dev gain on a metric whose ground truth was written after looking at dev output is a hypothesis.**
  That holds for `secondOrder` on the dev specs today, and for any list added the same way.
- A third attempt at the questions needs a reason this memo does not already contain: a kind of gap seen
  in real use, not on these 23 specs.
