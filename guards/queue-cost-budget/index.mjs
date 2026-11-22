// No node imports here: this file also runs in a browser. Every merge queue entry runs the repo's `merge_group`
// workflows from scratch. A workflow that expands to many legs, with no reuse of the pull request's passing run and no
// path filter, makes every entry pay the full matrix (docs/queue.md, items 4 and 5). Offline: legs are counted from
// the workflow YAML; a matrix built at run time (`fromJSON`) cannot be counted, so declare `queue.legs` for it.
// docs/gel.json: "queue": { "max_matrix_legs": 20, "reuse_from_legs": 10, "legs": {"e2e.yml": 80},
// "queue_full": {"nightly.yml": "reason this must run in full on every entry"} }
import { loadWorkflows, queueApplies, cost } from "../../lib/queue.mjs";

export const name = "queue-cost-budget";

export function run({ files, read, cfg }) {
  const wfs = loadWorkflows(files, read);
  if (!queueApplies(wfs, cfg)) return { pass: true, findings: [] };
  const findings = cost({ wfs, cfg }).map(({ file, line, message, fix }) => ({ file, line, message: `${message}. Fix: ${fix}` }));
  return { pass: findings.length === 0, findings };
}
