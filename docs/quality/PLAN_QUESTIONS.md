# Plan prompt: the seven questions (tried in round 2, not in use)

Status: **removed from the prompt** after v3 round 2 (2026-11-16). Kept here so it can be tried again
once spec coverage can be measured. The plan prompt in use is `2026-11-16.2`, whose text is that of
`2026-11-13.2`.

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

## The section

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

## What round 2 showed

| Round | Prompt       | Overall | Spec coverage | No duplicates | Honesty | Cases/spec | Must-cover |
| ----- | ------------ | ------- | ------------- | ------------- | ------- | ---------- | ---------- |
| 1     | 2026-11-13.2 | 1.64    | 1.43          | 1.07          | 1.86    | 39.2       | 100%       |
| 2     | 2026-11-16.1 | 1.60    | 1.43          | 0.86          | 1.86    | 42.8       | 100%       |

Recorded as a revert: the overall fell and coverage did not move.

## Why that result does not settle it

The coverage score cannot show an improvement, whatever the prompt does (measured on the stored
results of rounds 0, 1 and 2, all judged with rubric v3.1):

- The distribution of sheet scores was 0/8/6 (scores 0/1/2) in all three rounds, and the judge listed
  exactly 25 missing combinations in each, for sheets of 54, 39 and 43 cases written by three prompts.
- The judge is asked to list what is missing and does: one to three items per sheet, 41 of 42 times.
  What it lists changes from round to round and gets finer. Round 1's items (a role without the
  right, a holiday across midnight, the fields of an audit entry) are mostly gone from round 2's
  list, replaced by ones like "rounding at exactly half a cent".
- It reads 20 cases of a sheet in full and the rest as titles, and several items say so ("only in
  index", "exists but unseen", "no gap").

So the questions may well have added the cases they were written for; this score would read 1.43
either way. The fall in the overall came from three sheets moving one step on "no duplicates", which
is within what the judge moves by between two readings of similar sheets.

Before this section is tried again, coverage needs a fixed target: a list per spec of the
second-order combinations a sheet should have, checked the way must-cover is (a model names the case
that tests each item, and only an existing case counts). That list does not move between rounds, and
the stored sheets of rounds 0 to 2 can be checked against it without generating anything.
