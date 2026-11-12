# Preprocess golden fixtures (PRE-10)

Each `*.json` file is one behavioural test of the preprocessing engine (SPEC §5.4, ADR-0002):

```json
{ "name": "PRE-05 ...", "input": PreprocessInput, "expected": PreprocessOutput }
```

Any implementation (today TypeScript, later possibly Rust/WASM) must produce `expected` from
`input`, compared as JSON (`JSON.parse(JSON.stringify(output))` deep-equals `expected`). The
fixture name starts with the spec ID it pins down.

- Runner: `test/preprocess/golden.test.ts`
- Sources: `test/preprocess/golden/cases-*.ts` (readable builders; the JSON is generated from them)
- Regenerate after an intentional change, then review the diff:
  `UPDATE_GOLDEN=1 npx vitest run test/preprocess/golden.test.ts`

All data is synthetic. Secrets are FAKE and shaped only to hit a rule (AWS values are the official
documentation examples).

## Conventions an implementation must reproduce

| Topic           | Rule                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Characters      | "chars" are UTF-16 code units (`String.length`).                                                                                                                                                                                                                             |
| Tokens          | `ceil(chars / 3.2)` = `floor((5·chars + 15) / 16)`; usable budget = `floor(tokenBudget · 0.9)`; PRD ≤ `floor(tokenBudget · 0.3)` (≤ 20,000 per document, water-filling, smallest first); code budget = usable − reservedTokens − PRD tokens actually used.                   |
| File tokens     | 16 + tokens(path) + tokens(previousPath) + tokens(summary) + Σ(tokens(hunk.header) + tokens(hunk.text)) + Σ(8 + tokens(context.text) + tokens(context.name)); each term estimated separately.                                                                                 |
| Score           | `w1·min(5, pathHits + 0.5·contentHits) + w2·ln(1 + additions + deletions) + w3·boost − w4·penalty`, rounded to 3 decimals (`Math.round(x·1000)/1000`).                                                                                                                       |
| Ordering        | Files: score desc, then path in code-unit order (never locale order). `skipped`: path, then reason. `redactions`: type.                                                                                                                                                      |
| Chunks          | `c1`, `c2`, …; chunk ids in priority order, `c1` holds the top-scored file. Each chunk's `estimatedTokens` is code only.                                                                                                                                                     |
| Output tokens   | `estimatedTokens` = Σ over chunks (reservedTokens + PRD tokens + chunk tokens); 0 when there are no chunks.                                                                                                                                                                  |
| Redaction       | Replacements keep the newline count of the match (line numbers stay valid). Counts are per occurrence in the output only (dropped files/contexts are not counted).                                                                                                            |
| AST             | Grammars and versions in `src/preprocess/ast/grammars/manifest.json`; at most 2,000,000 head-content chars are parsed per run, in score order; the rest fall back to ±20 line windows.                                                                                       |
