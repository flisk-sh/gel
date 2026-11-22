// gel queue-ready and the queue guards: the counting and matching rules the cases cannot show one by one, the
// scorecard's exit code, the ruleset snapshot, and a whole-tree run where a PR touches one file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { matrixOf, runsOnEvent, checkMatches, loadWorkflows, scorecard, rulesOf } from "../lib/queue.mjs";
import { collectQueue } from "../lib/queue-collect.mjs";
import { WHOLE_TREE } from "../lib/guards.mjs";

const gel = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gel.mjs");
const wf = (name, text) => ({ [`.github/workflows/${name}`]: text });
const run = (files, cfg = {}, queue) => scorecard({ files: Object.keys(files), read: (f) => files[f] ?? null, cfg, queue });

// the two safeguards a ready repo installs (items 8 and 9), as workflow files whose name says what they are
const SAFE = {
  ...wf("stalled-merge-queue.yml", "name: Unstall merge queue\non: [schedule, merge_group]\njobs:\n  unstall:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo ok\n"),
  ...wf("cancel-dead-queue-runs.yml", "name: Cancel dead queue runs\non: [schedule]\njobs:\n  cancel:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo ok\n"),
};
const CI = wf("ci.yml", "name: CI\non: [pull_request, merge_group]\nconcurrency:\n  group: ci-${{ github.ref }}\njobs:\n  test:\n    name: test\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: echo ok\n");

test("matrixOf counts axes, excludes, includes and run-time matrices", () => {
  assert.deepEqual(matrixOf({}), { legs: 1, dynamic: false });
  assert.equal(matrixOf({ strategy: { matrix: { os: ["a", "b"], node: [1, 2, 3] } } }).legs, 6);
  assert.equal(matrixOf({ strategy: { matrix: { os: ["a", "b"], node: [1, 2, 3], exclude: [{ os: "a", node: 1 }] } } }).legs, 5);
  // an include that only adds a variable joins existing legs; one with a new axis value is a new leg
  assert.equal(matrixOf({ strategy: { matrix: { os: ["a", "b"], include: [{ extra: "x" }] } } }).legs, 2);
  assert.equal(matrixOf({ strategy: { matrix: { os: ["a", "b"], include: [{ os: "c" }] } } }).legs, 3);
  assert.equal(matrixOf({ strategy: { matrix: { include: [{ a: 1 }, { a: 2 }] } } }).legs, 2);
  assert.deepEqual(matrixOf({ strategy: { matrix: "${{ fromJSON(needs.plan.outputs.matrix) }}" } }), { legs: null, dynamic: true });
  assert.equal(matrixOf({ strategy: { matrix: { os: "${{ fromJSON(x) }}" } } }).dynamic, true);
});

test("runsOnEvent understands a plain event condition and never hides a job it cannot read", () => {
  assert.equal(runsOnEvent({}, "merge_group"), true);
  assert.equal(runsOnEvent({ if: "github.event_name != 'merge_group'" }, "merge_group"), false);
  assert.equal(runsOnEvent({ if: "github.event_name == 'pull_request'" }, "merge_group"), false);
  assert.equal(runsOnEvent({ if: "github.event_name == 'merge_group'" }, "merge_group"), true);
  assert.equal(runsOnEvent({ if: "github.event_name == 'pull_request' || github.event_name == 'merge_group'" }, "merge_group"), true);
  assert.equal(runsOnEvent({ if: "needs.changes.outputs.docs != 'true'" }, "merge_group"), true);
  assert.equal(runsOnEvent({ if: false }, "merge_group"), false);
});

test("checkMatches finds the job behind a check name: plain, matrix, reusable and workflow-qualified", () => {
  const w = { doc: { name: "CI" } };
  assert.ok(checkMatches("test", w, { name: "test" }));
  assert.ok(checkMatches("test (ubuntu, 20)", w, { name: "test" }));
  assert.ok(checkMatches("gel / GEL guards", w, { name: "gel" }));
  assert.ok(checkMatches("CI / lint", w, { name: "lint" }));
  assert.ok(checkMatches("🧪 Test (1)", w, { name: "🧪 Test ${{ matrix.x }}" }));
  assert.ok(!checkMatches("testing", w, { name: "test" }));
});

test("a ready repo scores 100, and an unready one lists a fix per failed item", () => {
  const ready = run({ ...CI, ...SAFE }, { queue: { requiredChecks: ["test"] } });
  assert.equal(ready.score, 100);
  assert.equal(ready.items.find((i) => i.n === 12).status, "skipped");
  const bad = run({ ...wf("ci.yml", "on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n") }, { queue: { requiredChecks: ["test"] } });
  assert.equal(bad.items.find((i) => i.n === 1).status, "fail");
  assert.ok(bad.score < 100);
  for (const i of bad.items.filter((x) => x.status === "fail")) for (const f of i.findings) assert.ok(f.fix, `item ${i.n} names a fix`);
});

test("no requiredChecks anywhere fails item 1 instead of passing quietly", () => {
  const card = run({ ...CI, ...SAFE }, {});
  assert.equal(card.items.find((i) => i.n === 1).status, "fail");
});

test("the ruleset names the required checks when docs/gel.json does not, and sets the queue's check timeout", () => {
  const queue = { rulesets: [{ enforcement: "active", rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }, { type: "merge_queue", parameters: { check_response_timeout_minutes: 15 } }] }], reported: { checks: ["test"] } };
  assert.equal(rulesOf(queue).length, 2);
  const card = run({ ...wf("ci.yml", "on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo ok\n"), ...SAFE }, {}, queue);
  assert.equal(card.items.find((i) => i.n === 1).status, "fail");
  const timed = run({ ...wf("ci.yml", "on: merge_group\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: echo a\n  b:\n    needs: a\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: echo b\n"), ...SAFE }, {}, queue);
  assert.match(timed.items.find((i) => i.n === 3).findings[0].message, /20 minutes.*\(15\)/);
});

test("a flaky step declared in docs/gel.json needs a retry (item 11)", () => {
  const flaky = wf("ci.yml", "on: merge_group\njobs:\n  up:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - name: Bring up Traefik\n        run: make up\n");
  assert.equal(run({ ...flaky, ...SAFE }, { queue: { requiredChecks: ["up"], flaky_steps: ["traefik"] } }).items.find((i) => i.n === 11).status, "fail");
  const retried = { ".github/workflows/ci.yml":flaky[".github/workflows/ci.yml"].replace("run: make up", "run: for attempt in 1 2 3; do make up && break; done") };
  assert.equal(run({ ...retried, ...SAFE }, { queue: { requiredChecks: ["up"], flaky_steps: ["traefik"] } }).items.find((i) => i.n === 11).status, "pass");
});

test("an unreadable workflow is skipped, not turned into a finding", () => {
  const wfs = loadWorkflows([".github/workflows/odd.yml"], () => "a: &x 1\nb: *x\n");
  assert.equal(wfs.length, 0);
});

test("collectQueue reads rulesets, reported checks and scanning tools through the API, and survives a missing endpoint", () => {
  const calls = [];
  const api = (p) => {
    calls.push(p);
    if (p === "repos/o/r") return { default_branch: "main" };
    if (p.startsWith("repos/o/r/rulesets?")) return [{ id: 7 }, { id: 8 }];
    if (p === "repos/o/r/rulesets/7") return { target: "branch", enforcement: "active", rules: [{ type: "merge_queue" }] };
    if (p === "repos/o/r/rulesets/8") return { target: "tag", rules: [] };
    if (p === "repos/o/r/commits/main") return { sha: "abc" };
    if (p.startsWith("repos/o/r/commits/abc/check-runs")) return { check_runs: [{ name: "test" }] };
    if (p === "repos/o/r/commits/abc/status") return { statuses: [{ context: "ci/legacy" }] };
    if (p.startsWith("repos/o/r/actions/runs?")) return { workflow_runs: [{ id: 1 }] };
    if (p.startsWith("repos/o/r/actions/runs/1/jobs")) return { jobs: [{ name: "lint" }] };
    throw new Error("HTTP 404"); // code scanning is off
  };
  const q = collectQueue("o/r", api);
  assert.equal(q.rulesets.length, 1);
  assert.deepEqual(q.reported.checks.sort(), ["ci/legacy", "lint", "test"]);
  assert.deepEqual(q.reported.codeScanningTools, []);
  assert.ok(calls.every((c) => !/-X|POST|PUT|DELETE/.test(c)), "read-only");
});

test("the queue guards judge the whole tree, so a PR touching one file still sees every workflow", () => {
  for (const g of ["queue-merge-group-parity", "queue-cost-budget", "queue-main-duplicates", "queue-required-satisfiable"]) assert.ok(WHOLE_TREE.has(g), g);
});

test("gel queue-ready exits 0 at 100 and 1 below, prints JSON, and reads a ruleset snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "gel-queue-"));
  const put = (f, t) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); };
  try {
    for (const [f, t] of Object.entries({ ...CI, ...SAFE })) put(f, t);
    put("docs/gel.json", JSON.stringify({ queue: { requiredChecks: ["test"] } }));
    const ok = spawnSync("node", [gel, "queue-ready", "--root", root, "--json"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).score, 100);
    put("snapshot.json", JSON.stringify({ rulesets: [{ enforcement: "active", rules: [{ type: "code_coverage", parameters: {} }] }] }));
    const bad = spawnSync("node", [gel, "queue-ready", "--root", root, "--snapshot", join(root, "snapshot.json")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL\s+12\./);
    assert.match(bad.stdout, /branch_protection_failure/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
