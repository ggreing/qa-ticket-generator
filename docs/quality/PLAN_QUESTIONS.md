# Plan prompt: the seven questions

Status: **in the prompt again** since plan prompt `2026-11-16.3` (v3 round 3), in a changed form. This
memo keeps the section as round 2 ran it, what the re-measurement showed, and what was changed for
round 3. The text in use is in `src/llm/prompts/plan.ts`.

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

## What round 2 got wrong, and what round 3 changes

Round 2's sheets had 23 duplicate groups against 15 in round 1. Read one by one:

- **The same answer once per requirement** (about 8 groups). The section said "put each of them to every
  requirement", and it was: a double tap written for two requirements, an empty result for two, a
  refused request logged for two kinds of refusal. Round 3 puts each question to the requirements taken
  together, once per action, value and period.
- **Two ways of being empty** as two cases (a file with only a header and a file of zero bytes; no key and
  an unknown key). Round 3: one case, the variants in `testData`.
- **A late arrival written twice**, once as a boundary and once as a race, and a boundary repeated with a
  time of day. Round 3: the two sides of a limit belong to the boundary technique; the question adds only
  the period that spans the line and the late arrival, each once.
- **A refused request sent again.** Round 3 says outright that this is not a case.

"Who else?" was suspected and is not the cause: one group, and several of the gains.

Honesty fell on one sheet, where a case brought in a payment step and a "sold" state that the spec does not
have. Round 3 adds that the person, the value, the period and the later action have to be ones the spec
itself mentions.

The section now ends with four rules for whatever the questions turn up: a question is not a second route
to a second case; one case for several requirements; nothing the spec does not name; open answers as open
questions. The merge pass was changed with it: it runs for every sheet, also one written in a single call
(five of the seven single-call sheets had duplicate groups in round 2 and no pass to remove them); it is
told that the route by which a case was reached does not matter; and it sees every expected result, so it
can drop a case whose observations are all among another's and keep both when each checks something the
other does not.
