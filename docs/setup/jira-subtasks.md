# Jira sub-tasks for QA cases

The `jira` sink adds one sub-task per QA case under the spec's story. It only does this when the spec is a
Jira issue. For a spec written as a GitHub issue or a Notion page, the Jira sink is skipped and the run log
says so.

## 1. What Jira needs

- Jira Cloud. Server and Data Center are not supported.
- A sub-task issue type in the story's project. Company-managed projects usually call it `Sub-task`,
  team-managed projects `Subtask`. Set `jira-subtask-type` to the exact name your project shows.
- An account for the tool, ideally a dedicated bot user, with an API token from
  <https://id.atlassian.com/manage-profile/security/api-tokens>. In the project it needs Browse projects,
  Create issues, Edit issues, Add comments and Edit own comments.
- Summary, Description and Labels on the sub-task create and edit screens. Priority is optional. If the
  screen has no Priority field, the tool adds a `qa-p0`, `qa-p1` or `qa-p2` label instead and logs one
  warning per run.

## 2. Workflow inputs

Store the email and token as repository secrets and add:

```yaml
sinks: jira,file
jira-base-url: https://acme.atlassian.net
jira-email: ${{ secrets.JIRA_EMAIL }}
jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
jira-subtask-type: Sub-task
```

To plan a Jira story, run the workflow by hand with `spec: PROJ-123`, or use the CLI:

```bash
npx qa-ticket-generator plan --repo owner/repo --spec PROJ-123                        # dry run: files only
npx qa-ticket-generator plan --repo owner/repo --spec PROJ-123 --sinks jira --publish  # create sub-tasks
```

## 3. What the sub-tasks look like

- Summary: `[P0][Boundary] Apply a coupon that expired one second ago`.
- Priority: P0 is Highest, P1 is High, P2 is Medium.
- Labels: `qtg-case` and `qtg-<case id>`, e.g. `qtg-PROJ-123-C07`. Obsolete cases also get `qtg-obsolete`.
- Description: the case, then a collapsed section called "qtg data (do not edit)". The tool keeps a record
  of what it wrote there, so it can tell when someone edited the sub-task. Add your own notes below that
  section; they are kept on every update. When only that record changes and the text stays the same, the
  tool keeps it in a hidden issue property (`qtg.case`) instead of editing the description, so watchers
  don't get an email for it. We haven't tried this property on a real Jira site yet.
- The story gets one comment that lists every case with a link. It is updated whenever the cases change.

To list the cases of a story in Jira:

```
parent = PROJ-123 AND labels = qtg-case ORDER BY created ASC
```

## 4. What stays yours

Status, assignee, comments and any labels you add belong to your team, and the tool never changes them. Use
the status or your own labels to record test results.

If someone edits a sub-task's summary or description, the tool does not overwrite it. It adds a
"Tool-proposed change" comment with the version it would have written, one per sub-task, updated in place.
When the spec no longer produces a case, its summary gets `[Obsolete]` (or `[해당 없음]` …) in front and the
`qtg-obsolete` label. Sub-tasks are never closed or deleted.

The tool only trusts sub-tasks created by its own account. A sub-task someone else labels `qtg-case` is
ignored.
