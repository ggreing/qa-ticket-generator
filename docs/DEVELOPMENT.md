# Development guide

## Commands

| Command            | What it does                                                                       |
| ------------------ | ---------------------------------------------------------------------------------- |
| `npm ci`           | Install exact dependencies                                                         |
| `npm run check`    | Lint (Biome) + typecheck (tsc 7) + tests (Vitest) — must pass before every handoff |
| `npm run coverage` | Tests with coverage (thresholds: 80% lines/functions/statements, 75% branches)     |
| `npm run build`    | Bundle `dist/action.js` and `dist/cli.js` with esbuild                             |
| `npm run lint:fix` | Auto-format and fix lint issues                                                    |

## Layout and ownership (SPEC §6.3, §16)

| Path                                                                                                                      | Owner                    | Branch / worktree                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------- |
| `src/core/**`, `src/adapters/**`, `test/core/**`, `test/helpers/**`, `docs/**`, root config                               | qa-control-session       | `main`                                 |
| `src/trigger/**`, `src/context/**` (incl. `prd/`), `test/trigger/**`, `test/context/**`, `fixtures/context/**`            | qa-work-session-a        | `feat/context` → `../worktrees/a`      |
| `src/preprocess/**`, `test/preprocess/**`, `fixtures/preprocess/**`                                                       | qa-work-session-b        | `feat/preprocess` → `../worktrees/b`   |
| `src/llm/**`, `src/delivery/**`, `test/llm/**`, `test/delivery/**`, `fixtures/llm/**`, `fixtures/delivery/**`, `evals/**` | qa-work-session-c(fable) | `feat/llm-delivery` → `../worktrees/c` |

## Rules

1. **Contracts are frozen.** `src/core/*` changes only on `main` by the control session. Need a change? Send the control session a message with the proposed diff and why. After it lands, `git rebase main`.
2. **Stay in your paths.** Do not edit files owned by another session. Need a dependency? Ask the control session (it owns `package.json`); state the package, version and reason.
3. **Replace the stub, keep the signature.** Every exported function in your module's stub keeps its exported name and type from `src/core/contracts.ts`; add internal files freely.
4. **No network in tests.** Mock HTTP (`undici` MockAgent / injected clients). Never call real GitHub, Jira, Notion, Slack or Anthropic from tests. Never commit secrets or real customer data; fixtures are synthetic.
5. **Logs never contain content.** Do not log code, PRD text or tokens — sizes and counts only (OBS-01).
6. **Definition of done:** `npm run check` passes, coverage ≥ 80% for your module, TSDoc on exported functions, each spec ID you implemented is referenced in a test name (e.g. `PRE-05 redacts AWS keys`).
7. **Commits:** Conventional Commits (`feat(preprocess): ...`, `test(context): ...`). Commit on your branch only; the control session merges into `main`.
8. **Handoff report** to qa-control-session: branch + last commit SHA, implemented spec IDs, test/coverage numbers, deviations from the spec, open questions.
