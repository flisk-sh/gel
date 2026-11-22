// No node imports here: this file also runs in a browser. A repo that runs a merge queue has workflows that behave
// differently on `merge_group`: a required check never starts, a concurrency group is shared by every entry, a job has
// no timeout, a diff base is empty, a bash script runs under PowerShell. Each one stalled flisk's queue (docs/queue.md,
// items 1, 2, 3, 6 and 10). Offline: it reads `.github/workflows/*` and `docs/gel.json` (`queue.requiredChecks`).
// It applies when a workflow has a `merge_group` trigger or docs/gel.json has `queue`; a repo with no queue is skipped.
import { loadWorkflows, queueApplies, parity } from "../../lib/queue.mjs";

export const name = "queue-merge-group-parity";

export function run({ files, read, cfg, ctx }) {
  const wfs = loadWorkflows(files, read);
  if (!queueApplies(wfs, cfg)) return { pass: true, findings: [] };
  const findings = parity({ wfs, cfg, queue: ctx?.queue }).map(({ file, line, message, fix }) => ({ file, line, message: `${message}. Fix: ${fix}` }));
  return { pass: findings.length === 0, findings };
}
