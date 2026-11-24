import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readText } from "./fs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const GUARD_NAMES = ["secret-scan", "pinned-actions", "workflow-permissions", "workflow-timeouts", "frozen-install", "dead-links", "done-without-green", "migrations-append-only", "api-contract", "tests-with-change", "adr-required", "repo-health", "package-metadata", "status-declared", "dependabot-config", "gitattributes-eol", "release-integrity", "five-second-test", "cta-label", "next-cta", "agent-readiness", "north-star", "product-brief", "ice-score", "click-map", "input-in-viewport", "stale-base", "public-env-secrets", "queue-merge-group-parity", "queue-cost-budget", "queue-main-duplicates", "queue-required-satisfiable", "sonar-patterns", "checks-green", "deploy-delivered", "change-verified", "perf-budget", "risk-history", "worker-request-budget", "install-ignore-scripts", "curl-https-only", "log-injection", "workflow-checkout-safety", "model-deprecation"];
export const guardDir = (n) => join(here, "..", "guards", n);
// Guards that read files get `read(file)` from here, so the same guard file runs on a checkout (node) and on
// files fetched in a browser. A caller may pass its own `read`.
export async function loadGuard(n) {
  const m = await import(pathToFileURL(join(guardDir(n), "index.mjs")).href);
  return { ...m, run: (a) => m.run({ read: (f) => readText(a.root, f), ...a }) };
}
// Guards that judge the repo as a whole, not the files a pull request touched: a link can break in an untouched
// file, and a LICENSE or a Dependabot config is never in a diff.
export const WHOLE_TREE = new Set(["dead-links", "repo-health", "dependabot-config", "gitattributes-eol", "north-star", "product-brief", "click-map", "agent-readiness", "queue-merge-group-parity", "queue-cost-budget", "queue-main-duplicates", "queue-required-satisfiable", "deploy-delivered"]);
