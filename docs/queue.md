# Before you turn on a merge queue

`gel queue-ready` is one preflight score for a repo that is about to run a merge queue (or already runs one). It reads the repo's workflows and `docs/gel.json`, and optionally the ruleset, and answers one question per item: is this a defect that has already stalled a real queue?

It exists because flisk ran a queue for five weeks and fixed it one symptom at a time: 29 merged PRs, ten defect classes, each found in production. A repo must pass all twelve items before a queue with `max_entries_to_build` above 1 is switched on. The order of the items follows the order flisk paid for them.

```bash
gel queue-ready                           # offline: items 1 to 11
gel queue-ready --repo owner/name         # also reads the ruleset (read-only gh calls): item 12
gel queue-ready --snapshot queue.json     # the same, from a saved snapshot
gel queue-ready --json                    # machine-readable
```

It prints a score out of 100 (checked items that pass), a pass or fail per item, and a fix for every finding. It exits 1 below 100. Without `--repo` or `--snapshot`, item 12 is listed as skipped and is not in the score: an offline 100 is "11 of 11", never a claim about the ruleset.

## The twelve items

| # | Item | Guard | Taught by (flisk) |
| --- | --- | --- | --- |
| 1 | Every required check also runs on `merge_group`: a queued PR otherwise waits for a status that never comes | `queue-merge-group-parity` | [#1465](https://github.com/flisk-sh/flisk/pull/1465), [#1626](https://github.com/flisk-sh/flisk/pull/1626), [#1622](https://github.com/flisk-sh/flisk/pull/1622), [#3156](https://github.com/flisk-sh/flisk/pull/3156) (CodeQL), [#4496](https://github.com/flisk-sh/flisk/pull/4496) (GEL itself) |
| 2 | A `merge_group` concurrency group holds `github.ref`, `github.sha` or `github.run_id`. A constant group, or one built from `github.head_ref` (empty on `merge_group`), is shared by every entry, and a group keeps only its newest waiting run | `queue-merge-group-parity` | [#3005](https://github.com/flisk-sh/flisk/pull/3005) |
| 3 | Every job that runs on `merge_group` has `timeout-minutes`, and the longest `needs` chain fits `check_response_timeout_minutes` (60, or the value in the ruleset snapshot, or `queue.check_response_timeout_minutes`) | `queue-merge-group-parity` | [#3014](https://github.com/flisk-sh/flisk/pull/3014), [#4093](https://github.com/flisk-sh/flisk/pull/4093) |
| 4 | A costly `merge_group` workflow (10 or more legs, or a matrix built at run time) reuses the PR's passing run, path-filters its legs, or says why not under `queue.queue_full` | `queue-cost-budget` | [#3157](https://github.com/flisk-sh/flisk/pull/3157), [#3039](https://github.com/flisk-sh/flisk/pull/3039), [#4888](https://github.com/flisk-sh/flisk/pull/4888), [#4892](https://github.com/flisk-sh/flisk/pull/4892), [#4900](https://github.com/flisk-sh/flisk/pull/4900), [#4898](https://github.com/flisk-sh/flisk/pull/4898), [#4943](https://github.com/flisk-sh/flisk/pull/4943) |
| 5 | No queue entry runs a matrix over `queue.max_matrix_legs` (20). A run-time matrix declares its size under `queue.legs` | `queue-cost-budget` | [#4885](https://github.com/flisk-sh/flisk/pull/4885), [#2989](https://github.com/flisk-sh/flisk/pull/2989), [#4707](https://github.com/flisk-sh/flisk/pull/4707), [#3930](https://github.com/flisk-sh/flisk/pull/3930) |
| 6 | A diff base in a `merge_group` workflow never reads `github.base_ref` or `github.event.pull_request.base.*`, which `merge_group` does not set. Use `github.event.merge_group.base_sha` or `HEAD^1`, or gate the step to `pull_request` | `queue-merge-group-parity` | [#3012](https://github.com/flisk-sh/flisk/pull/3012), [#4899](https://github.com/flisk-sh/flisk/pull/4899) |
| 7 | A workflow that runs on `merge_group` does not also run on `push` to the default branch, unless `queue.main_duplicates` says why | `queue-main-duplicates` | [#4727](https://github.com/flisk-sh/flisk/pull/4727), [#4728](https://github.com/flisk-sh/flisk/pull/4728) |
| 8 | A stalled-queue detector is installed (a workflow named for it, or a call to the shared one) | scorecard only | [#5105](https://github.com/flisk-sh/flisk/issues/5105), [#5114](https://github.com/flisk-sh/flisk/pull/5114) |
| 9 | A dead-batch run canceller is installed | scorecard only | [#3014](https://github.com/flisk-sh/flisk/pull/3014), [#4093](https://github.com/flisk-sh/flisk/pull/4093) |
| 10 | A `run` step with bash-only syntax sets `shell: bash` where the default shell is not bash: any bash syntax on a Windows job, `mapfile`, `readarray` and `declare -A` on a macOS job | `queue-merge-group-parity` | [#4906](https://github.com/flisk-sh/flisk/pull/4906), [#4913](https://github.com/flisk-sh/flisk/pull/4913) |
| 11 | Steps listed under `queue.flaky_steps` are wrapped in a retry: a red entry dequeues everything behind it | scorecard only | [#4691](https://github.com/flisk-sh/flisk/pull/4691), [#4688](https://github.com/flisk-sh/flisk/pull/4688), [#4879](https://github.com/flisk-sh/flisk/pull/4879) |
| 12 | Every active ruleset rule can be satisfied: each required check, code scanning tool or coverage uploader has reported at least once on a `merge_group` or default-branch commit | `queue-required-satisfiable` (online) | [#3184](https://github.com/flisk-sh/flisk/pull/3184), [#3185](https://github.com/flisk-sh/flisk/pull/3185), [#2988](https://github.com/flisk-sh/flisk/pull/2988) |

Items 1 to 7, 10 and 12 are guards that run in `gel run` like any other (in `report` mode until a person promotes them, see [guards](guards.md)). Items 8, 9 and 11 look at what is installed, so only the scorecard reports them.

## What it reads

Everything is in `docs/gel.json`. The scorecard and the guards apply when some workflow has a `merge_group` trigger or `queue` is present; a repo with no queue is not judged by the guards.

```json
{
  "queue": {
    "requiredChecks": ["test", "gel / GEL guards"],
    "max_matrix_legs": 20,
    "reuse_from_legs": 10,
    "check_response_timeout_minutes": 60,
    "legs": { "e2e-resource-types.yml": 5 },
    "queue_full": { "nightly-scale.yml": "boots 100 services; a canary would hide a broken template" },
    "main_duplicates": { "gel.yml": "whole-tree scan of main is the point" },
    "flaky_steps": ["traefik", "npm install"]
  }
}
```

- `requiredChecks`: the ruleset's required check names. Item 1 matches a name to a job by the job's `name` (or id), `name (matrix values)`, `caller / callee` for a reusable workflow, or `workflow name / job`. With `--repo` the ruleset supplies them and the list is optional.
- A reason in `queue_full` or `main_duplicates` is a string, never `true`: the exception is written down where the next agent reads it.
- A matrix built at run time (`fromJSON`) cannot be counted from YAML. Declare its size in `legs`, or give it a path filter or reuse step.
- Path filters and reuse are recognised by what the workflow runs: `dorny/paths-filter`, `changed-files` actions, `gh run list|view|download`, `gh api` on `check-runs` or `actions/runs`, or the word "reuse" in a step. A comment does not count.

## The ruleset snapshot (item 12)

`queue-required-satisfiable` reads `ctx.queue`: `{ "rulesets": [...], "reported": { "checks": [...], "codeScanningTools": [...] } }`. `gel queue-ready --repo owner/name` builds it with read-only `gh api` calls: the repo's branch rulesets, the check names on the default branch head and on the last five `merge_group` runs, and the code scanning tools that uploaded. It never edits a ruleset: changes stay with the repo admin.

A `code_coverage` or `code_quality` rule needs an uploader outside the repo's own checks. The guard fails when no workflow uploads one (Codecov, Coveralls, Qlty, Sonar or a coverage upload step) and the snapshot lists none: that is the rule that left every flisk queue entry with `branch_protection_failure` while all checks were green.

## Proven on flisk's history

`queue-merge-group-parity`, `queue-cost-budget` and `queue-main-duplicates` carry labelled cases cut from the flisk workflows before and after each fix (`gel selftest` shows recall and precision). Run on flisk's tree at the parent of each fix PR, the scorecard fails the class the PR fixed and passes it at the fix:

| Parent commit of | Fails item |
| --- | --- |
| [#1465](https://github.com/flisk-sh/flisk/pull/1465) | 1 (`example-e2e` and `windows-smoke` have no `merge_group`) |
| [#3005](https://github.com/flisk-sh/flisk/pull/3005) | 2 (constant Journeys group) |
| [#3157](https://github.com/flisk-sh/flisk/pull/3157) | 4 (run-time matrix, no reuse) |
| [#4727](https://github.com/flisk-sh/flisk/pull/4727) and [#4728](https://github.com/flisk-sh/flisk/pull/4728) | 7 (push to main and `merge_group`) |
| [#4906](https://github.com/flisk-sh/flisk/pull/4906) | 10 (`mapfile` on a macOS job, no `shell`) |

Not covered by a guard yet: class 5's `merge_group.base_sha` that a depth-1 checkout could not fetch ([#4899](https://github.com/flisk-sh/flisk/pull/4899)) needs a shell reader; the queue metrics and the bench ratchet; the shared stalled-queue workflow in `flisk-sh/.github`; and `stale-base` on `merge_group` events.
