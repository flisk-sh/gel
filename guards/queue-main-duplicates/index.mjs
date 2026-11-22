// No node imports here: this file also runs in a browser. A workflow that runs on `merge_group` and again on `push` to
// the default branch tests the same commit twice: the queue already ran it on the exact merge result (docs/queue.md,
// item 7). A workflow that must run on both says why in docs/gel.json: "queue": {"main_duplicates": {"file.yml": "reason"}}.
import { loadWorkflows, queueApplies, duplicates } from "../../lib/queue.mjs";

export const name = "queue-main-duplicates";

export function run({ files, read, cfg }) {
  const wfs = loadWorkflows(files, read);
  if (!queueApplies(wfs, cfg)) return { pass: true, findings: [] };
  const findings = duplicates({ wfs, cfg }).map(({ file, line, message, fix }) => ({ file, line, message: `${message}. Fix: ${fix}` }));
  return { pass: findings.length === 0, findings };
}
