// No node imports here: this file also runs in a browser. A ruleset rule that can never be satisfied leaves every
// queued PR with branch_protection_failure while all checks are green (flisk's `code_coverage` rule with no uploader:
// HTTP 403 "Code quality is not enabled"; docs/queue.md, item 12). It reads a snapshot of the ruleset and of what
// reported on merge_group and default-branch commits, from `gel queue-ready --repo owner/name` (online) or
// `--snapshot queue.json`, passed in as `ctx.queue`. With no snapshot it passes: nothing is guessed offline.
import { loadWorkflows, satisfiable } from "../../lib/queue.mjs";

export const name = "queue-required-satisfiable";

export function run({ files, read, ctx }) {
  if (!ctx?.queue) return { pass: true, findings: [] };
  const findings = satisfiable({ wfs: loadWorkflows(files, read), queue: ctx.queue }).map(({ file, line, message, fix }) => ({ file, line, message: `${message}. Fix: ${fix}` }));
  return { pass: findings.length === 0, findings };
}
