import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanePlan } from "../lib/lane.mjs";

test("lane A: docs only runs lint and typecheck, no tests, no build, no CodeQL", () => {
  const p = lanePlan(["README.md", "docs/guide.md"]);
  assert.deepEqual([p.lane, p.scripts, p.pythonTests, p.codeql], ["A", ["lint", "typecheck"], false, false]);
});
test("lane A: a changed test file also runs the tests", () => {
  const p = lanePlan(["src/app.test.ts"]);
  assert.deepEqual([p.lane, p.scripts, p.pythonTests], ["A", ["lint", "typecheck", "test"], true]);
});
test("lane B: product code runs lint, typecheck, test, build and CodeQL", () => {
  const p = lanePlan(["src/app.ts"]);
  assert.deepEqual([p.lane, p.scripts, p.codeql], ["B", ["lint", "typecheck", "test", "build"], true]);
});
test("lane C: auth code adds the integration and e2e scripts", () => {
  const p = lanePlan(["src/auth/session.ts"]);
  assert.equal(p.lane, "C");
  assert.deepEqual(p.scripts.slice(4), ["test:integration", "test:e2e", "integration", "e2e"]);
});
test("no diff (push to main, schedule) is a full lane C run", () => assert.equal(lanePlan(null).lane, "C"));
test("minLane raises the lane and never lowers it", () => {
  assert.equal(lanePlan(["README.md"], { minLane: "B" }).lane, "B");
  assert.equal(lanePlan(["src/auth/a.ts"], { minLane: "B" }).lane, "C");
  assert.equal(lanePlan(["README.md"], { minLane: "nonsense" }).lane, "A");
});
test("gel lane reads the git diff and writes the plan to GITHUB_OUTPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "gel-lane-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "a\n"); git("add", "."); git("commit", "-qm", "a");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "README.md"), "b\n"); git("commit", "-qam", "b");
  const out = join(dir, "out.txt");
  const bin = new URL("../bin/gel.mjs", import.meta.url).pathname;
  const run = () => JSON.parse(execFileSync(process.execPath, [bin, "lane", "--root", dir, "--base", base, "--json"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out } }));
  assert.equal(run().lane, "A");
  mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src/app.js"), "x\n"); git("add", "."); git("commit", "-qm", "c");
  assert.equal(run().lane, "B");
  writeFileSync(join(dir, "gel.json"), JSON.stringify({ minLane: "C" })); git("add", "."); git("commit", "-qm", "d");
  assert.equal(run().lane, "C");
});
