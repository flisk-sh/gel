# GEL: Guard, Eval, Loop

Fifteen checks that stop what AI coding agents and tired people ship by mistake: a leaked key, an unpinned action, a workflow with an open token, a link to a file that is gone, a pull request that says "all tests pass" while a check is red, an edit to a database migration that already ran, an API change that breaks existing clients, product code changed with no test, an architectural change with no decision record, a release that is not safe to ship, a landing page a stranger cannot read in five seconds, and the basics a public repo should carry (licence, security policy, owner, status, dependency updates, and one north star metric). Plain Node, no model, no network, about a second on a large repo. Works in any GitHub repo, any language.

**Bench on 30 public repos (11,350 files) and 231 real pull requests:**

| | With GEL | Their own CI today |
| --- | --- | --- |
| Leaked keys caught (5 formats, planted) | 150 / 150 | 1 of 30 repos scans for keys |
| Unpinned actions caught (planted) | 90 / 90 | 3 of 30 repos check pins |
| Open workflow token caught (planted: no `permissions`, `write-all`, fork head under `pull_request_target`) | 90 / 90 | 3 of 30 repos audit workflow permissions |
| Broken repo links caught (planted) | 90 / 90 | 1 of 30 repos checks links |
| PRs that said green while a check was red | 35 of 231 flagged | 0 of 30 repos check this |
| Findings on clean repos | secrets 0; workflow-permissions 45 in 18 of 30 repos, 5 of 5 read by hand real; dead links 16 of 21 not real | |

Method, limits and what GEL misses: [bench/README.md](bench/README.md). Raw numbers: [bench/results.json](bench/results.json).

## Install

Pick one. All three start in report mode: nothing blocks until you say so.

**1. As a step** in a workflow you already have:

```yaml
- uses: actions/checkout@v4   # pin it to a SHA; GEL will tell you
  with: { fetch-depth: 0 }
- uses: flisk-sh/gel@v1
```

**2. As a whole job**, `.github/workflows/gel.yml`:

```yaml
name: GEL
on: [pull_request, push]
permissions: { contents: read }
jobs:
  gel:
    permissions: { contents: read, checks: read, pull-requests: read }
    uses: flisk-sh/gel/.github/workflows/gel.yml@v1
```

**3. Across an org**, one pull request per repo:

```bash
node scripts/rollout.mjs --org your-org            # dry run
node scripts/rollout.mjs --org your-org --apply
```

Run it locally on any folder:

```bash
npx github:flisk-sh/gel run --root .
```

## Guards

| Guard | Fails when |
| --- | --- |
| `secret-scan` | an AWS, GitHub, Anthropic, OpenAI, Stripe live or Slack key, or a private key block, is in a file (test files, sample TLS keys and doc placeholders are skipped) |
| `pinned-actions` | a workflow uses another org's action by tag or branch instead of a commit SHA |
| `workflow-permissions` | a workflow job has no `permissions` (and no top-level one), uses `write-all`, or checks out the fork's code under `pull_request_target` |
| `dead-links` | a markdown or HTML link points to a file that is not in the repo |
| `done-without-green` | a pull request says "all checks pass" or "ready to merge" while a check on its last commit is red |
| `migrations-append-only` | a pull request edits, renames or deletes a migration that is already on the base branch (Rails, Django, Alembic, Prisma, Knex, Drizzle, Supabase, Flyway, golang-migrate and others). Adding a migration is fine |
| `api-contract` | a pull request changes an OpenAPI or Swagger spec (JSON or YAML) so that an existing client breaks: an endpoint or method removed, a new required parameter or request body, a path parameter or a 2xx response gone |
| `tests-with-change` | a pull request changes product code and no test file in the same pull request. It reads changed paths, never the PR title. Docs, generated files, config, fixtures and test-only changes pass. Tune with `tests_with_change` (`source`, `tests`, `exempt` globs) |
| `adr-required` | opt-in: a pull request touches a path listed in `adr_required.paths` and adds no ADR (a new `.md` under `adr_required.directory`, default `docs/adr`) with Context, Decision, Alternatives and Consequences sections. `min_lane` sets the lowest risk lane that triggers it. No `paths`, no rule |
| `repo-health` | a repo has no LICENSE, SECURITY.md, CONTRIBUTING.md or CODEOWNERS (root, `.github/` or `docs/`), or its README has no sentence saying what it is for. List files the org supplies from its `.github` repo in `docs/gel.json` as `"repo_health": {"inherit": ["security", "contributing"]}` |
| `status-declared` | opt-in: `docs/gel.json` exists and has no `status` (production, active, experimental, archived) or no `owner`, or an `active` repo has had no commit for `stale_after_days` (default 365, needs `ctx.lastCommitAt`) |
| `dependabot-config` | the repo uses an ecosystem (npm, pip, go, cargo, docker, github-actions and others) that `.github/dependabot.yml` (or a Renovate config) does not cover |
| `release-integrity` | a release whose tag is not SemVer, whose commit is gone or off the default branch, with no CHANGELOG entry, a red or missing check, an earlier failed release run, or assets without checksums (or an SBOM, if required). Feed it `gel release-ctx --repo o/n --tag v1.2.3 > ctx.json`, then `gel run --ctx ctx.json`; it complements the org `release-gate` rather than replacing it |
| `five-second-test` | the first screen of a landing page (`index.html`, `public/index.html`, `docs/index.html`; set `five_second.pages` to change) cannot be understood in five seconds on a phone: no `<h1>`, a headline over 12 words, a lead over 32 words, jargon such as endpoint, inference or MCP in either, or no link or button under the headline. Offline; tune `max_h1_words`, `max_lead_words` and `jargon` under `five_second`. A page drawn by script has no headline in its source: declare `five_second.rendered` (`result`, `max_age_days`) and commit a measurement from `gel five-second --url <page> --write bench/five-second.json --merge` (headless Chrome at 375x812); the first screen the browser drew is judged by the same rules, and a missing or stale measurement fails |
| `north-star` | opt-in (a repo with no `docs/gel.json` is skipped): the repo's one measured headline metric is missing, stale or not met. `docs/gel.json` declares `north_star` with a `metric`, a `baseline`, a `target` (`{"ratio": 8, "better": "lower"}`), an `evidence` (how it is measured: a repo file or https link) and a `result` file (`{"value": 2.5, "baseline": 26.1, "unit": "s", "measuredAt": "..."}`). The guard fails when the result is not in the repo, is older than `max_age_days` (default 30), or `baseline / value` (`value / baseline` for `"higher"`) is under the target ratio. A claim with no number gets no pass. `gel north-star --measure` runs your `measure` command, writes `result` and exits 1 when the target is not met, so a bench workflow can gate on it. Archived repos need none |
| `input-in-viewport` | a phone visitor cannot start: the page's first visible `<input>` or `<textarea>` ends below the first screen (a pitch, banner or animation pushed it down), so they must scroll before they can type. Layout cannot be read from source, so the guard reads a measurement: `gel input-viewport --url https://site --write bench/input-viewport.json` loads the page in headless Chrome at 375x667 and 320x568 (add `--cookie 'a=b'` for a theme or state) and records where the input ends. `docs/gel.json` may declare `input_in_viewport` (`result`, `max_age_days`, `pages`); the guard applies when it is declared or when `index.html`, `public/index.html`, `docs/index.html` or `site/index.html` contain a text input. Missing or stale measurement, no input found, or `bottom` over `height` fails. Archived repos need none |
| `stale-base` | a pull request branch was cut before the base branch changed its CI or scoring files (`.github/workflows/**`, `.github/actions/**`, `scripts/scores/**`, `Makefile`, `docs/gel.json`; tune with `stale_base.watch` and `stale_base.ignore`). Its checks then run old gates and can fail on something the base already fixed. It reads changed paths only, and a push scan passes. Fix: merge or rebase the base branch. |
| `public-env-secrets` | a variable that a bundler copies into the browser (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_`, `PUBLIC_`) is named like a secret: `SECRET`, `PRIVATE`, `PASSWORD`, `SERVICE_ROLE`, or an OpenAI, Anthropic, Stripe, Resend, AWS, GitHub and similar `KEY` or `TOKEN`. A git-ignored `.env` does not help: the value is in the JavaScript every visitor downloads. Publishable, anon, site and client-id names, `_URL` and `_LENGTH` settings, test files and markdown are skipped. Fix: call the vendor from a server or edge function, keep the key in a server-only variable, and rotate any key that was ever deployed |

`migrations-append-only`, `api-contract`, `tests-with-change` and `adr-required` compare a pull request with its base branch, so they run on pull requests only; a push scan passes them. `api-contract` reads a spec it understands and skips one it does not (YAML anchors, for example) rather than guess.

## docs/gel.json

Optional. GEL runs on any repo without it, with every guard in `report` mode. Without the file, `status-declared` and `north-star` have nothing declared to check and stay quiet; the other guards still run. Add the file to opt in, to tune a guard or to promote one to `block`.

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

## Lanes

GEL picks a risk lane from the changed files, never from a label: **A** docs and tests, **B** product code, **C** workflows, `docs/gel.json`, auth, payment, secrets, migrations, Dockerfiles and deploy config, where a person approves.

The lane also sets how much CI runs. `gel lane --base <sha>` prints the plan and writes it to the job outputs, and the shared Flisk CI (`flisk-sh/.github`) follows it:

| Lane | Package scripts | Python | CodeQL |
| --- | --- | --- | --- |
| A docs, tests, copy | lint, typecheck (and test when a test file changed) | pytest only when a test changed | skipped |
| B product code | lint, typecheck, test, build | pytest | yes |
| C sensitive paths | B plus test:integration, test:e2e, integration, e2e | pytest | yes |

A push to the default branch, the weekly run and a manual run have no diff to judge, so they always run lane C. `"minLane": "B"` (or `"C"`) in `docs/gel.json` sets a floor for a repo; a change can raise the lane, never lower it.

## Eval of the guards

Each guard has `guards/<name>/cases.json`, labelled good and bad. `node bin/gel.mjs selftest` must catch every bad case and pass every good one, or GEL's own CI fails. Every false alarm the bench found became a case first, then a fix.

## Run record

Each run appends one JSON line to `gel-record.jsonl`: repo, commit, lane, each guard's result, its first 10 findings and the time. That record is how you decide to promote a guard.

## Org view: Cilytics

[Cilytics](https://cilytics.flisk.si/) ([flisk-sh/cilytics](https://github.com/flisk-sh/cilytics)) shows GEL across a whole org or user account. It finds the newest completed run of each repo's workflow named `GEL` (or a file called `gel.yml`), reads `gel-record.jsonl` from its `gel-record` artifact, and shows which repos run GEL, the guard findings and what is blocked. Keep that workflow name and artifact name, or the repo shows as "GEL not installed". Cilytics also shows each guard's own quality score (recall, precision, false blocks) from `scores.json`, the published result of `gel selftest`; regenerate it with `node bin/gel.mjs selftest --json > scores.json` when a guard changes (a test fails if it is stale).

## Metrics and the flywheel

```bash
node bin/gel.mjs metrics records/*.jsonl --labels docs/gel-labels.json
```

Per guard: runs, fail rate, precision from your labels (`[{guard, file, line, verdict: "real" | "false"}]`), and advice:

- **promote** to block after 20 runs, 5 labelled findings and 95% precision;
- **demote** a blocking guard on a labelled false alarm;
- **hold** otherwise. It never promotes on an unknown precision.

Every false alarm is listed as a hard case to add to the guard's `cases.json`. Overall it reports first-pass share, blocked runs and p50/p95 time. GEL only advises: a person edits `docs/gel.json`, and that edit is lane C.

### Fix PRs

```bash
node bin/gel.mjs fix pinned-actions --root path/to/repo   # pins what the guard reports, then re-scores
node scripts/flywheel.mjs --max 5 [--dry-run]             # the nightly loop over the repos Cilytics lists
```

`gel fix` edits only the lines the guard reports, then runs every guard again over the whole tree. It exits 0 only when the target guard dropped, no other guard rose, and only workflow or action files changed. `.github/workflows/flywheel.yml` runs the loop each night and opens at most 5 PRs (branch `gel/fix-pinned-actions`). It needs the secret `GEL_FLYWHEEL_TOKEN` (contents and pull requests: write on the org's repos); without it the run is a dry run.

## Nightly meta-eval

`.github/workflows/meta-eval.yml` runs every night: the selftest (recall and precision per guard), then the bench, then `bench/check.mjs`, which fails if any guard catches fewer planted defects or raises more findings on clean repos than `bench/baseline.json`. Changing the baseline is lane C.

## Release gate and deploy health

The shared [flisk-sh/.github](https://github.com/flisk-sh/.github) workflows cover the stages after GEL: `release-gate.yml` waits for every check on the release commit and fails on a red or missing required one, and `deploy-health.yml` checks the deployed URL. The `flisk-release` starter wires both around a publish job.

## License

MIT. See [LICENSE](LICENSE).
