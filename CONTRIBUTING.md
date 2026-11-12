# Contributing to qa-ticket-generator

Thanks for your interest in improving qa-ticket-generator! This document explains how to propose a
change. The day-to-day developer reference — commands, module layout and the definition of done — lives
in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Please read it before your first pull request.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs:** search the existing issues first, then open one with the _Bug report_ form.
- **Features:** open a _Feature request_ issue before writing code, so we can agree on the approach.
  Design decisions are recorded in [`docs/SPEC.ko.md`](docs/SPEC.ko.md) and [`docs/adr/`](docs/adr/).
- **Security issues:** do **not** open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## Development flow

1. Fork the repository and create a branch from `main` (e.g. `fix/jira-adf-tables`).
2. Install exact dependencies with Node.js 24: `npm ci`.
3. Make your change with tests (see below).
4. Run `npm run check` (Biome lint, TypeScript typecheck, Vitest). It must pass.
   `npm run lint:fix` fixes most formatting issues.
5. Open a pull request against `main` and fill in the template. Keep pull requests focused: one
   topic per PR is much easier to review.

Contracts between modules live in `src/core/contracts.ts`. If your change needs a contract change,
call it out in the PR description so it can be reviewed on its own.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

feat(prd): read acceptance criteria from Notion toggles
fix(context): retry GitHub secondary rate limits
docs: clarify the fork opt-in workflow
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. The scope is usually
the module (`trigger`, `context`, `prd`, `preprocess`, `llm`, `delivery`, `core`).

## Tests

- **No network in tests.** Mock HTTP with an injected `fetch` or undici's `MockAgent`. Tests must never
  call real GitHub, Jira, Notion, Slack or Anthropic endpoints.
- **Synthetic fixtures only.** Never commit real customer data, real PRDs, real tokens or secrets.
  Write fixtures by hand (see `fixtures/`).
- Reference the spec requirement ID in the test name when there is one, e.g.
  `it('PRD-01 ignores refs inside code blocks', …)`.
- Keep coverage of the module you touch at or above 80% (`npm run coverage`).
- Exported functions need TSDoc comments.

## Logging and privacy

Logs must never contain code, PRD text or tokens — only sizes and counts. The action sends code and
PRD content to the Anthropic API and nowhere else; please keep it that way, and say so in the PR if
your change touches what is sent or published.

## License

This project is licensed under [Apache-2.0](LICENSE). Unless you state otherwise, any contribution you
submit is licensed under the same terms (Apache-2.0, section 5).
