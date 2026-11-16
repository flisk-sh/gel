# GEL: Guard, Eval, Loop

Five checks that stop what AI coding agents and tired people ship by mistake: a leaked key, an unpinned action, a workflow with an open token, a link to a file that is gone, and a pull request that says "all tests pass" while a check is red. Plain Node, no model, no network, about a second on a large repo. Works in any GitHub repo, any language.

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

## gel.json

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

GEL picks a risk lane from the changed files, never from a label: **A** docs and tests, **B** product code, **C** workflows, `gel.json`, auth, payment, secrets, migrations, Dockerfiles and deploy config, where a person approves.

The lane also sets how much CI runs. `gel lane --base <sha>` prints the plan and writes it to the job outputs, and the shared Flisk CI (`flisk-sh/.github`) follows it:

| Lane | Package scripts | Python | CodeQL |
| --- | --- | --- | --- |
| A docs, tests, copy | lint, typecheck (and test when a test file changed) | pytest only when a test changed | skipped |
| B product code | lint, typecheck, test, build | pytest | yes |
| C sensitive paths | B plus test:integration, test:e2e, integration, e2e | pytest | yes |

A push to the default branch, the weekly run and a manual run have no diff to judge, so they always run lane C. `"minLane": "B"` (or `"C"`) in `gel.json` sets a floor for a repo; a change can raise the lane, never lower it.

## Eval of the guards

Each guard has `guards/<name>/cases.json`, labelled good and bad. `node bin/gel.mjs selftest` must catch every bad case and pass every good one, or GEL's own CI fails. Every false alarm the bench found became a case first, then a fix.

## Run record

Each run appends one JSON line to `gel-record.jsonl`: repo, commit, lane, each guard's result, its first 10 findings and the time. That record is how you decide to promote a guard.

## Org view: Cilytics

[Cilytics](https://cilytics.flisk.si/) ([flisk-sh/cilytics](https://github.com/flisk-sh/cilytics)) shows GEL across a whole org or user account. It finds the newest completed run of each repo's workflow named `GEL` (or a file called `gel.yml`), reads `gel-record.jsonl` from its `gel-record` artifact, and shows which repos run GEL, the guard findings and what is blocked. Keep that workflow name and artifact name, or the repo shows as "GEL not installed".

## Metrics and the flywheel

```bash
node bin/gel.mjs metrics records/*.jsonl --labels gel-labels.json
```

Per guard: runs, fail rate, precision from your labels (`[{guard, file, line, verdict: "real" | "false"}]`), and advice:

- **promote** to block after 20 runs, 5 labelled findings and 95% precision;
- **demote** a blocking guard on a labelled false alarm;
- **hold** otherwise. It never promotes on an unknown precision.

Every false alarm is listed as a hard case to add to the guard's `cases.json`. Overall it reports first-pass share, blocked runs and p50/p95 time. GEL only advises: a person edits `gel.json`, and that edit is lane C.

## Nightly meta-eval

`.github/workflows/meta-eval.yml` runs every night: the selftest (recall and precision per guard), then the bench, then `bench/check.mjs`, which fails if any guard catches fewer planted defects or raises more findings on clean repos than `bench/baseline.json`. Changing the baseline is lane C.

## Release gate and deploy health

The shared [flisk-sh/.github](https://github.com/flisk-sh/.github) workflows cover the stages after GEL: `release-gate.yml` waits for every check on the release commit and fails on a red or missing required one, and `deploy-health.yml` checks the deployed URL. The `flisk-release` starter wires both around a publish job.

MIT.
