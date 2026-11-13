# Notion QA case database

The `notion` sink writes one row per QA case into a database you choose. The tool fills in the case and
its code status. Your testers fill in the result. The tool reads that column but never writes it.

## 1. Get the database

The quickest way is to duplicate our template page into your workspace and use the database inside it.
The template link is added to this page when the project is published.

You can also create the database yourself. Make a full-page database and give it the columns below. If a
column is missing and the integration is allowed to edit the database, the first run adds it for you. If it
is not allowed to, the run stops for Notion and its message names the missing columns.

## 2. Columns

Names have to match exactly, including spaces and capital letters. The title column can have any name.

| Column        | Type   | Written by | What goes in it                                                                   |
| ------------- | ------ | ---------- | --------------------------------------------------------------------------------- |
| (title)       | Title  | tool       | The case name. Obsolete cases get `[Obsolete]` (or `[해당 없음]` …) in front.     |
| `Case ID`     | Text   | tool       | e.g. `PROJ-123-C07`. This is how the tool finds the row again.                    |
| `Spec`        | Text   | tool       | The spec the case belongs to: `PROJ-123`, `owner/repo#12` or a Notion page id.    |
| `AC`          | Text   | tool       | Related acceptance criteria, e.g. `AC2, AC3`.                                     |
| `Technique`   | Select | tool       | Boundary, invalid input, permission and so on, in the output language.            |
| `Priority`    | Select | tool       | `P0`, `P1` or `P2`.                                                               |
| `Code status` | Select | tool       | Set when a PR is checked: implemented, possibly missing, contradicts, can't tell. |
| `Lifecycle`   | Select | tool       | Active or Obsolete, in the output language.                                       |
| `실행 결과`   | Select | people     | Not run, Pass, Fail, Blocked. Read by the tool, never written.                    |
| `담당자`      | Person | people     | Optional. Read by the tool, never written, never created.                         |
| `QTG data`    | Text   | tool       | What the tool last wrote, so it can tell when someone edited a row. Hide it.      |

Hide `QTG data` in your views and leave it alone. If it is changed or deleted, the tool treats the row as
edited by a person and only proposes changes from then on.

If you already have one of these columns with a different type, it usually still works: the tool writes
text, select and multi-select columns alike. Two exceptions. Keep `QTG data` as text, because a select
option holds only 100 characters and the record doesn't fit. Keep `Spec` as text or select, because the
tool filters on it. A column of any other type, such as a number, is left empty and the run log says so.

## 3. Connect the integration

1. Create an internal integration at <https://www.notion.so/profile/integrations>. It needs the Read,
   Update and Insert content capabilities, and Read and Insert comments for the proposed-change comments.
2. Store its secret as a repository secret, e.g. `NOTION_TOKEN`.
3. Open the database, then ••• → Connections, and add the integration.
4. Copy the database id from its URL. In
   `https://www.notion.so/acme/0123456789abcdef0123456789abcdef?v=…` it is the 32 characters before `?v=`.
5. Add these to the workflow and put `notion` in `sinks`:

```yaml
sinks: notion,file
notion-token: ${{ secrets.NOTION_TOKEN }}
notion-qa-database-id: 0123456789abcdef0123456789abcdef
```

## How rows are kept in sync

- The case text sits in one quote block at the top of the page, labelled with the case id. Write your own
  notes anywhere else on the page. They are kept on every update.
- If someone edits the case text or its title, the tool leaves the row alone and adds a comment with the
  version it would have written. There is one such comment per row, updated in place.
- When the spec no longer produces a case, the row gets the obsolete prefix and `Lifecycle` Obsolete. Rows
  are never deleted.
- Only rows created by your integration count. A row added by hand with a `Case ID` is ignored.
- One database can hold the cases of many specs; `Spec` keeps them apart. Because of that there is no
  per-spec case list in Notion. If the spec is a GitHub issue or a Jira story and that sink is on, the list
  goes there. The `qa-cases.md` file from the `file` sink always has it.
- Reading a row takes about two API calls, and Notion allows an average of three requests a second, so a
  run over 60 existing cases spends about 40 seconds just reading.
