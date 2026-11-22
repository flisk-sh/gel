// Reads what `queue-required-satisfiable` needs from GitHub, read-only: the repo's active rulesets, the checks that
// reported on the default branch head and on recent merge_group runs, and the code scanning tools that uploaded.
// The result is the `queue` snapshot of docs/queue.md. `gel queue-ready --snapshot f.json` takes the same shape.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// gh is looked up in fixed system directories, not through PATH (Sonar S4036)
const ghPath = () => ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find((f) => existsSync(f));

export function ghApi(path) {
  const gh = ghPath();
  if (!gh) throw new Error("gh not found in /opt/homebrew/bin, /usr/local/bin or /usr/bin: install the GitHub CLI, or pass --snapshot");
  return JSON.parse(execFileSync(gh, ["api", path], { encoding: "utf8", maxBuffer: 1 << 26 }));
}

export function collectQueue(repo, api = ghApi) {
  const attempt = (f, fallback) => { try { return f(); } catch { return fallback; } };
  const def = api(`repos/${repo}`).default_branch;
  const listed = api(`repos/${repo}/rulesets?includes_parents=true&per_page=100`);
  const rulesets = listed.map((r) => api(`repos/${repo}/rulesets/${r.id}`)).filter((r) => r.target === "branch");
  const head = api(`repos/${repo}/commits/${def}`).sha;
  const checks = new Set();
  for (const c of attempt(() => api(`repos/${repo}/commits/${head}/check-runs?per_page=100`).check_runs, [])) checks.add(c.name);
  for (const s of attempt(() => api(`repos/${repo}/commits/${head}/status`).statuses, [])) checks.add(s.context);
  for (const run of attempt(() => api(`repos/${repo}/actions/runs?event=merge_group&per_page=5`).workflow_runs, [])) {
    for (const j of attempt(() => api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs, [])) checks.add(j.name);
  }
  const tools = new Set(attempt(() => api(`repos/${repo}/code-scanning/analyses?per_page=100`), []).map((a) => a.tool?.name).filter(Boolean));
  return { rulesets, reported: { checks: [...checks], codeScanningTools: [...tools] } };
}
