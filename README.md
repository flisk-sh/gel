# GEL: Guard, Eval, Loop

GEL is a GitHub Action and a command line tool that runs 33 checks (guards) on every pull request, to catch what AI coding agents and tired people ship by mistake: a leaked key, an unpinned action, a workflow with an open token, a PR that says "all tests pass" while a check is red, an edited migration, a breaking API change.

It is plain Node with no dependencies, no model and no network. It starts in report mode, so nothing blocks until you promote a guard. This repo scans in about 0.1 s.

## Quick start

Add it as a step in a workflow you already have:

```yaml
- uses: actions/checkout@v4   # pin it to a SHA; GEL will tell you
  with: { fetch-depth: 0 }
- uses: flisk-sh/gel@v1.12.0
```

Or run it on a folder, with no GitHub involved:

```bash
git clone https://github.com/flisk-sh/gel && cd gel
node bin/gel.mjs run --root /path/to/your/repo
```

It prints a table with one row per guard (`pass` or findings, and its level), then the first findings of each guard that failed. Every guard is in `report` mode until you say otherwise, so the exit code stays 0.

Pin to a tag or a commit if you want a fixed version. `@v1` is a moving tag that follows `main`, so it picks up new guards without a change on your side.

### Other ways to run it

**As a whole job**, `.github/workflows/gel.yml`. Pass `gel_ref` as well, so the guards run from the same version as the workflow.

```yaml
name: GEL
on: [pull_request, push]
permissions: { contents: read }
jobs:
  gel:
    permissions: { contents: read, checks: read, pull-requests: read }
    uses: flisk-sh/gel/.github/workflows/gel.yml@v1.12.0
    with: { gel_ref: v1.12.0 }
```

**Across an org**, one pull request per repo (needs `gh` signed in):

```bash
node scripts/rollout.mjs --org your-org            # dry run
node scripts/rollout.mjs --org your-org --apply
```

## Results

Bench on 30 public repos (11,350 files) and 231 real pull requests:

| | With GEL | Their own CI today |
| --- | --- | --- |
| Leaked keys caught (5 formats, planted) | 150 / 150 | 1 of 30 repos scans for keys |
| Unpinned actions caught (planted) | 90 / 90 | 3 of 30 repos check pins |
| Open workflow token caught (planted: no `permissions`, `write-all`, fork head under `pull_request_target`) | 90 / 90 | 3 of 30 repos audit workflow permissions |
| Broken repo links caught (planted) | 90 / 90 | 1 of 30 repos checks links |
| PRs that said green while a check was red | 35 of 231 flagged | 0 of 30 repos check this |
| Findings on clean repos | secrets 0; workflow-permissions 45 in 18 of 30 repos, 5 of 5 read by hand real; dead links 16 of 21 not real | |

Planted defects are ones the bench inserted itself, so "caught" measures recall on known cases, not on the wild. Method, limits and what GEL misses: [bench/README.md](bench/README.md). Raw numbers: [bench/results.json](bench/results.json).

## What it catches

| Guard | Fails when |
| --- | --- |
| `secret-scan` | an AWS, GitHub, Anthropic, OpenAI, Stripe live or Slack key, or a private key block, is in a file |
| `pinned-actions` | a workflow uses another org's action by tag or branch instead of a commit SHA |
| `workflow-permissions` | a job has no `permissions`, uses `write-all`, or checks out a fork's code under `pull_request_target` |
| `workflow-timeouts` | a workflow job that runs steps has no `timeout-minutes`, so a hang runs for GitHub's 360-minute default |
| `frozen-install` | a workflow installs without a frozen form (`npm ci`, `--frozen-lockfile`), or `package.json` has no lockfile |
| `model-deprecation` | source code hardcodes an AI model id (`@cf/...`, `gpt-...`, `claude-...`, `gemini-...`) that a provider has retired or will retire within 30 days |
| `public-env-secrets` | a secret-named variable has a browser-bundled prefix (`VITE_`, `NEXT_PUBLIC_`, and others) |
| `dead-links` | a markdown or HTML link points to a file that is not in the repo |
| `done-without-green` | a PR says "all checks pass" while a check on its last commit is red |
| `migrations-append-only` | a PR edits, renames or deletes a migration already on the base branch |
| `api-contract` | a PR changes an OpenAPI spec so an existing client breaks |
| `tests-with-change` | a PR changes product code and no test file |
| `stale-base` | a PR branch was cut before the base changed its CI or scoring files |
| `release-integrity` | a release has a non-SemVer tag, no CHANGELOG entry, a red check or assets without checksums |
| `repo-health` | the repo has no LICENSE, SECURITY.md, CONTRIBUTING.md or CODEOWNERS |
| `package-metadata` | a `package.json` lacks `license` (matching the LICENSE file's SPDX id), `engines`, `description` or `repository` (`private: true` skips repository/description) |
| `dependabot-config` | an ecosystem in use is not covered by Dependabot or Renovate |
| `gitattributes-eol` | a `.gitattributes` line-ending rule has no `eol=lf` as its only eol setting (the Claude plugin directory refuses the repo) |
| `sonar-patterns` | a bash script tests with `[ ]` instead of `[[ ]]`, or a non-test `.ts` file has a backtracking-prone regex (the two SonarCloud findings that keep coming back). Existing hits are frozen in `docs/gel.json` under `sonar_patterns.baseline` (file to count); a file may only get cleaner |
| `checks-green`, `deploy-delivered` | another check on the commit is red or says it is misconfigured (a SonarCloud project that does not exist), or a deploy workflow ends green and deployed nothing because a secret is unset |
| `change-verified`, `perf-budget` | opt-in: the project's own build or tests fail on the PR, no test notices the change (the tests still pass with it reverted), or a named benchmark is slower than its committed baseline. `gel verify` and `gel perf` run the commands |
| `install-ignore-scripts`, `curl-https-only`, `log-injection`, `workflow-checkout-safety` | the SonarCloud security findings that keep coming back in CI config: an install without `--ignore-scripts` or an unpinned `npx` (S6505, S8543), `curl` without `--proto '=https'` (S6506), a log line carrying `error.message` or request data with its line breaks (S5145, heuristic), a `workflow_run` / `pull_request_target` checkout that keeps the token or takes the PR head (S7631). Each takes a frozen `baseline` in `docs/gel.json` |
| `adr-required`, `status-declared`, `north-star`, `product-brief` | opt-in: you declare a rule or a number in `docs/gel.json`, and GEL checks it |
| `cta-label` | the first button under a landing page's headline is a bare "Sign in" or "Learn more" (or over 6 words) instead of saying what the visitor gets and that it is free |
| `next-cta` | a landing page does not mark its one most likely next action: no element, or more than one, has `data-next-cta`, it lacks the `next-cta` class, it is not the first link, button or input under the `<h1>`, or the page has no spinning-border CSS with a reduced-motion fallback ([recipe](docs/next-cta.css)) |
| `five-second-test`, `input-in-viewport`, `agent-readiness`, `ice-score`, `click-map` | a landing page, a phone input, agent-discovery files, an ICE table or a measured click map does not hold up |
| `queue-merge-group-parity`, `queue-cost-budget`, `queue-main-duplicates`, `queue-required-satisfiable` | a merge queue would stall: a required check with no `merge_group` trigger, a shared concurrency group, a matrix over budget, a duplicate run on main, a ruleset rule nothing can satisfy. `gel queue-ready` scores all twelve items: [docs/queue.md](docs/queue.md) |

`gel grade` grades `click-map`, `ice-score` and `product-brief` as bad, passed, good, high or super high. [`e2e/README.md`](e2e/README.md) gives the thresholds and shows which grades have a real example.

The exact rules, options and edge cases for all 34 guards are in [docs/guards.md](docs/guards.md). `migrations-append-only`, `api-contract`, `tests-with-change`, `adr-required` and `stale-base` compare a PR with its base, so a push scan passes them.

## Configure

Optional. GEL runs on any repo without a config file, with every guard in `report` mode. To tune a guard or promote it to `block`, add `docs/gel.json`:

```json
{
  "mode": "report",
  "guards": { "secret-scan": "block", "dead-links": "report" },
  "trusted_owners": ["your-org"],
  "ignore": ["vendor/**"]
}
```

- `report` writes findings and never fails the job. `block` fails it. Promote a guard once its run records show it was right.
- `trusted_owners` may use their actions by tag. Your own org is always trusted.
- A top-level `"mode": "report"` keeps every guard advisory, whatever the per-guard level says.
- A top-level `"mode": "block"` is the level of every guard the file does not list, so a guard added in a later GEL version blocks too. List a guard as `report` or `off` to opt it out.

### The level does not make GEL find more

`report` or `block` only decides what happens to a finding: `block` fails the job, `report` does not. It never changes what GEL looks for. A guard finds only the thing it checks, so a green GEL means "none of the guards found their thing", not "this pull request is correct".

What GEL does not find, even with every guard on `block`:

- Whether the change is right. It does not run your code, so a logic bug or a slowdown passes. `tests-with-change` only asks that a test file changed, not that a test covers the change.
- Whether another check is red or misconfigured. A failing SonarCloud check, or a Sonar project that does not exist, is not a GEL finding. `sonar-patterns` only scans the code for risky regex shapes.
- Whether a deploy really deployed. A workflow that skips because a secret is unset still ends green.
- Whether the numbers in `docs/brief.json` or the north-star file are true. GEL checks that they exist and are recent.

Treat `block` as "a known hygiene or safety rule is enforced", and keep your tests, build and other required checks for correctness.

Each run appends one JSON line to `gel-record.jsonl`: repo, commit, lane, each guard's result, its first 10 findings and the time. That record is how you decide to promote a guard.

## Lanes

GEL picks a risk lane from the changed files, never from a label: **A** docs and tests, **B** product code, **C** workflows, `docs/gel.json`, auth, payment, secrets, migrations, Dockerfiles and deploy config, where a person approves.

The lane also sets how much CI runs. `gel lane --base <sha>` prints the plan and writes it to the job outputs, and the shared Flisk CI (`flisk-sh/.github`) follows it:

| Lane | Package scripts | Python | CodeQL |
| --- | --- | --- | --- |
| A docs, tests, copy | lint, typecheck (and test when a test file changed) | pytest only when a test changed | skipped |
| B product code | lint, typecheck, test, build | pytest | yes |
| C sensitive paths | B plus test:integration, test:e2e, integration, e2e | pytest | yes |

A push to the default branch, the weekly run and a manual run have no diff to judge, so they always run lane C. `"minLane": "B"` (or `"C"`) in `docs/gel.json` sets a floor for a repo; a change can raise the lane, never lower it.

## How the guards are tested

Each guard has `guards/<name>/cases.json`, labelled good and bad. `node bin/gel.mjs selftest` must catch every bad case and pass every good one, or GEL's own CI fails. Every false alarm the bench found became a case first, then a fix.

## What GEL does not do

- It does not replace a code scanner, dependency review or a test suite. It checks the repo and PR facts those tools do not look at.
- It reads files and PR metadata. The guards themselves never run your code, and GEL cannot judge whether a change is correct in general. The opt-in `gel verify` and `gel perf` steps do run the build, the tests and the benchmark you name in `docs/gel.json`, and `change-verified` then asks the one question a machine can answer: do the tests notice this change.
- It never promotes a guard to `block` on its own. A person edits `docs/gel.json`, and that edit is lane C.
- The five-second and phone-input guards read a committed browser measurement, because layout cannot be read from source.

## Go further

[docs/loops.md](docs/loops.md) covers the parts that run around the guards: a scheduled north star measurement, per-guard precision and promote/demote advice, nightly fix PRs, the factory metrics, the [Cilytics](https://cilytics.flisk.si/) org view, and the release gate and deploy health workflows in [flisk-sh/.github](https://github.com/flisk-sh/.github).

## Status

Version v1.12.0, built and run by [flisk-sh](https://github.com/flisk-sh) on its own repos. It is not published to npm (`package.json` has `"private": true`); use it as an Action or from a clone. Releases: [GitHub releases](https://github.com/flisk-sh/gel/releases).

## License

MIT. See [LICENSE](LICENSE).
