# Releasing qa-ticket-generator

This document describes how a version is released and what has to happen once before the repository is
made public (milestone M4). The automation lives in [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## How releases are shaped

- `main` contains **source only**; `dist/` is git-ignored there (SPEC OI-3).
- Every version `vX.Y.Z` is a tag on a **release commit**: exactly one commit on top of a `main` commit that adds
  the built `dist/` and nothing else. GitHub Actions users run `dist/action.js` from that commit; npm users get
  the same files.
- The major tag (`v0`, later `v1` …) is moved to the newest stable release so `uses: ggreing/qa-ticket-generator@v0`
  follows it. Version tags themselves never move.
- Pre-releases (`v0.2.0-rc.1`) are published to npm under the `next` dist-tag, marked as pre-release on GitHub,
  and do not move the major tag.

### Why a release commit made by a maintainer

We compared four ways of getting `dist/` into a tagged commit without committing it to `main`:

| Option                                                                                                                                        | Pros                                                                                                                                                             | Cons                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Release commit + tag (chosen).** Maintainer commits `dist/` on top of a `main` commit and pushes a tag on it; CI verifies and publishes. | Version tags are immutable and can be signed. CI only needs to _verify_ (rebuild and compare), not to rewrite refs. Tag rulesets can forbid updates to `v*.*.*`. | A short manual step. The local build must be byte-identical to CI's (pinned lockfile and LF line endings make this the normal case; see Troubleshooting). |
| B. Tag `main`, CI builds and **re-points the tag** to a generated release commit                                                              | One command for the maintainer.                                                                                                                                  | The pushed (possibly signed) tag is rewritten; clones keep the stale tag; conflicts with tag protection and immutable releases.                           |
| C. Commit `dist/` to `main`                                                                                                                   | Simplest; `uses: …@main` works.                                                                                                                                  | Rejected by OI-3: noisy diffs, merge conflicts, and every PR could hide changes in generated code.                                                        |
| D. `workflow_dispatch` that creates the commit and tag in CI                                                                                  | No local build.                                                                                                                                                  | Not triggered by a tag push; tags created with `GITHUB_TOKEN` do not trigger other workflows, so the whole release must run in one dispatched job.        |

Option A keeps supply-chain properties simple: what users pin is exactly what a maintainer tagged, and CI proves
that the committed `dist/` is a clean build of the source next to it.

## What the workflow does

On a pushed tag matching `v*.*.*` (only in `ggreing/qa-ticket-generator`, never in forks):

1. **verify** (`contents: read`)
   - the tag is `vMAJOR.MINOR.PATCH[-pre]` and equals `package.json`'s `version`;
   - the tagged commit has one parent, that parent is on `main`, and the commit changes only `dist/`;
   - `npm ci`, `npm run check`, `npm run build`, then `dist/` must be identical to the committed one
     (on mismatch the CI build is uploaded as the `dist-from-ci` artifact).
2. **npm** (`contents: read`, `id-token: write`, environment `release`)
   - `npm publish --provenance --access public` using npm **trusted publishing** (OIDC); no npm token is stored.
3. **github-release** (`contents: write`)
   - `gh release create <tag> --generate-notes` (pre-release flag for `-rc` style versions);
   - moves the major tag (`v0`) to the release commit.

All actions are pinned to full commit SHAs with the version in a comment. Lines still marked `TODO(pin)` must be
pinned before the first release (see the checklist).

## Releasing a version

1. **Prepare `main`.** Open a PR that bumps `version` in `package.json` (e.g. `0.1.0`) and updates docs if needed.
   Merge it once CI is green.
2. **Create the release commit locally** from a clean checkout of that `main` commit, with Node.js 24:

   ```bash
   git fetch origin
   git switch --detach origin/main
   npm ci
   npm run build
   git add --force dist
   git commit -m "chore(release): v0.1.0"
   git tag -s v0.1.0 -m "v0.1.0"      # or -a if you do not sign tags
   git push origin v0.1.0             # push the tag only; no branch is needed
   ```

   The tag keeps the release commit reachable, so no release branch has to be maintained.
3. **Approve the `release` environment** if it has required reviewers, and watch the workflow run.
4. **Check the result**: the GitHub Release and its generated notes, the npm package page (provenance badge),
   `v0` pointing at the new commit, and the Marketplace listing.

### Troubleshooting

- **`dist/` differs from a clean build.** Make sure the release commit was built from exactly its parent commit
  with `npm ci` (not `npm install`) and Node.js 24. If a Windows build still differs, build in WSL or a Linux
  container, or download the `dist-from-ci` artifact from the failed run and commit that instead. Then delete
  the tag before recreating it: `git push origin :refs/tags/v0.1.0` and `git tag -d v0.1.0`. Only do this before
  anything was published.
- **npm publish failed after verify passed.** Fix the cause (e.g. trusted-publisher settings) and re-run the
  failed jobs; nothing has been released on GitHub yet.
- **A bad version was published.** Run `npm deprecate qa-ticket-generator@<version> "<reason>"` (do not unpublish),
  move the major tag back to the previous release commit, and release a fixed patch version:

  ```bash
  git tag --force v0 v0.1.0^{commit}
  git push --force origin refs/tags/v0
  ```

### Alternative: npm token instead of trusted publishing

Only if trusted publishing cannot be used: create a granular npm access token limited to this package, store it as
the `NPM_TOKEN` secret of the `release` environment, and add `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the
publish step. Keep `--provenance`. Rotate the token regularly and remove it once trusted publishing works.

## M4 publication checklist

Work through this list before the repository is made public. SPEC D-17: **get the owner's explicit confirmation
right before publishing.**

### Repository hygiene

- [ ] **Scan the full git history for secrets** before switching to public, for example with
      [gitleaks](https://github.com/gitleaks/gitleaks) run locally:
      `gitleaks git --redact --verbose .` (gitleaks ≥ 8.19; older versions: `gitleaks detect --source . --redact`).
      With Docker: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest git --redact /repo`.
      Fix findings by rotating the secret first, then rewriting history if needed.
- [ ] Confirm all fixtures and examples are synthetic (no real customer data, PRDs or tokens).
- [ ] Replace every `TODO(pin)` in `.github/workflows/*.yml` with the full commit SHA of the referenced release
      and keep the version comment (Dependabot keeps SHA pins up to date afterwards).

### GitHub settings

- [ ] Enable **Private vulnerability reporting** (Settings → Code security). The links in `SECURITY.md`,
      `CODE_OF_CONDUCT.md` and the issue chooser depend on it.
- [ ] **Branch protection / ruleset for `main`**: pull requests required, required status checks
      `check (ubuntu-latest)` and `check (windows-latest)`, no force pushes, no deletions.
- [ ] **Tag ruleset for `v*.*.*`**: block updates and deletions. Leave the major tags (`v0`) out of it so the
      release workflow can move them.
- [ ] Create the **`release` environment** (optionally with required reviewers) and restrict it to tags `v*.*.*`.
- [ ] Turn on Dependabot alerts and security updates.

### Marketplace

- [ ] `action.yml`: unique `name`, clear `description`, `branding` set (currently `icon: check-square`,
      `color: blue`) and `author` correct.
- [ ] The root `README.md` works as the Marketplace page (it is the English README).
- [ ] Accept the Marketplace developer agreement and tick "Publish this Action to the GitHub Marketplace" on
      the first release.

### npm

- [ ] Check that the package name is free: `npm view qa-ticket-generator` should return 404.
- [ ] Configure the **trusted publisher** on npmjs.com: repository `ggreing/qa-ticket-generator`, workflow
      `release.yml`, environment `release`. If npm requires the package to exist first, publish the first version
      with a short-lived granular token (see the alternative above), then add the trusted publisher and revoke
      the token.
- [ ] Verify the published tarball contents: `npm pack --dry-run` lists `package.json`, `dist/`, `action.yml`,
      `README.md`, `LICENSE` and `NOTICE` only.

### End-to-end scenarios in a sandbox repository

Run these against a release candidate (`v0.x.y-rc.n`) in a throw-away repository with synthetic PRDs:

- [ ] Adding the `needs-ai-qa` label creates the report comment (one comment, with the hidden state).
- [ ] A new push while labelled re-runs and **updates the same comment**.
- [ ] A push that only changes noise files (e.g. a lockfile) is skipped with `no_logic_change`; the comment and
      Slack message stay untouched and the job summary explains why.
- [ ] A fork PR is skipped with `fork_pr` under the default workflow; with the fork opt-in workflow it runs only
      when the label is added.
- [ ] Slack **bot mode**: parent summary card + threaded details; a re-run updates the parent and replaces the
      replies. **Webhook mode**: one new summary card per run.
- [ ] Slack buttons (`Open PR`, `View full report`): check whether Slack shows a warning icon or confirmation for
      the links, and that both open the right page.
- [ ] Jira and Notion **permission warnings**: wrong Jira token (401), a Jira project the account cannot browse
      (403), a Notion page not shared with the integration (404), an invalid Notion token (401) — each shows a
      `prd_permission` warning with the fix, and the run continues.
- [ ] **Cost cap**: with a very low `max-cost-usd`, low-priority files are dropped and listed; if even the top
      chunk exceeds the cap the run ends with the `cost_cap` message asking to raise `max-cost-usd`.
- [ ] Output in all four languages: `language: en`, `ko`, `ja`, `zh-CN` (and one alias such as `kr`).
- [ ] `workflow_dispatch` with `pr-number`, `dry-run: true`, `require-prd: true` without a PRD, and the CLI
      (`npx qa-ticket-generator run … ` dry run and `--publish`).

### Documentation

- [ ] Add README badges (CI, latest release, Marketplace, npm, license) in all four READMEs.
- [ ] Remove the README status note and the _(in progress)_ markers once preprocessing has shipped, and update
      the marker-count check in `test/docs/readme.test.ts`.
- [ ] `SECURITY.md` supported-versions table matches the first public release.
- [ ] Re-read `README.md` against the released behavior; nothing unimplemented is described as working.
