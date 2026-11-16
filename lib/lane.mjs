import { matchAny } from "./glob.mjs";

// Lane C: a person approves. Chosen from the changed files, never from a label.
export const DEFAULT_LANE_C = [
  ".github/workflows/**", ".github/actions/**", "gel.json", "gel-labels.json", "evals/**/baseline*", "evals/**/cases.json",
  "guards/*/cases.json", "bench/baseline.json",
  "**/auth/**", "**/login/**", "**/payment*/**", "**/billing/**", "**/secrets/**", "**/migrations/**",
  "**/Dockerfile*", "wrangler.toml", "wrangler.jsonc", "**/wrangler.toml", "render.yaml", "**/*.tf",
];
// Lane A: docs, tests, copy. Guards only.
export const DEFAULT_LANE_A = [
  "**/*.md", "docs/**", "**/*.txt", "tests/**", "test/**", "**/*.test.*", "**/*.spec.*", "**/__tests__/**",
  "**/*.png", "**/*.jpg", "**/*.svg", "LICENSE", ".gitignore",
];

export function pickLane(files, cfg = {}) {
  const laneC = cfg.laneC ?? DEFAULT_LANE_C;
  const laneA = cfg.laneA ?? DEFAULT_LANE_A;
  if (!files.length) return { lane: "A", reason: "no changed files" };
  const c = files.filter((f) => matchAny(laneC, f));
  if (c.length) return { lane: "C", reason: `sensitive path: ${c[0]}` };
  const nonA = files.filter((f) => !matchAny(laneA, f));
  if (nonA.length) return { lane: "B", reason: `product code: ${nonA[0]}` };
  return { lane: "A", reason: "docs, tests and copy only" };
}

const ORDER = ["A", "B", "C"];
const TEST_FILES = ["tests/**", "test/**", "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test_*.py", "**/*_test.py", "**/*_test.go"];
// Scripts a lane C change runs on top of lane B, when the repo has them.
export const LANE_C_EXTRA = ["test:integration", "test:e2e", "integration", "e2e"];

// What CI runs for a change. changed = null means there is no diff to judge (a push to the default branch, the
// weekly run, a manual run): that gets everything, so main always has a full run behind it.
// minLane comes from the repo's gel.json; a change can raise the lane, never lower it below that.
export function lanePlan(changed, cfg = {}) {
  let { lane, reason } = changed === null
    ? { lane: "C", reason: "no diff to judge (default branch push, schedule or manual run): full run" }
    : pickLane(changed, cfg);
  const min = ORDER.includes(cfg.minLane) ? cfg.minLane : "A";
  if (ORDER.indexOf(lane) < ORDER.indexOf(min)) { lane = min; reason = `gel.json minLane ${min} (${reason})`; }
  const testsChanged = (changed ?? []).some((f) => matchAny(TEST_FILES, f));
  const scripts = lane === "A"
    ? ["lint", "typecheck", ...(testsChanged ? ["test"] : [])]
    : ["lint", "typecheck", "test", "build", ...(lane === "C" ? LANE_C_EXTRA : [])];
  return { lane, reason, scripts, pythonTests: lane !== "A" || testsChanged, codeql: lane !== "A" };
}
