// GEL autofix: each night, pick the repos Cilytics shows with pinned-actions findings, run `gel fix pinned-actions`,
// and open a PR only where the guards score the result better. No model judges anything; the guards decide.
// Loops may not touch policy: the fixer edits only workflow and action files (bin/gel.mjs refuses anything else).
//
//   node scripts/autofix.mjs [--fixer pinned-actions|sonar-patterns] [--max 5] [--wip 3] [--repo owner/name] [--dry-run]
// sonar-patterns rewrites `[ ]` to `[[ ]]` and bare `.sort()` calls (at most 15 files per PR) and lowers the frozen baseline in
// docs/gel.json. It runs on every repo that has the guard, even when the baseline hides the hits from Cilytics.
// Brakes: GEL_PAUSE=1 stops the run (kill switch); --wip caps how many loop PRs may be open at once across the org.
// GH_TOKEN must be able to push branches and open PRs in the target repos. Without it the run is a dry run.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isPaused, budget } from "../lib/brakes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MAX = Number(opt("max", 5));
const WIP = Number(opt("wip", 3));
const FIXER = opt("fixer", "pinned-actions");
if (!["pinned-actions", "sonar-patterns"].includes(FIXER)) { console.error(`unknown fixer ${FIXER}`); process.exit(2); }
const BRANCH = `gel/fix-${FIXER}`;
// gel-e2e keeps planted defects on purpose: Cilytics checks they stay visible (scripts/e2e-gel.mjs there)
const SKIP = new Set(["gel-e2e"]);
const DATA = opt("data", "https://cilytics.flisk.si/data.json");
const dry = args.includes("--dry-run") || !process.env.GH_TOKEN;
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });
const log = (s) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + "\n"); };

async function candidates() {
  if (opt("repo")) return [opt("repo")];
  const d = await (await fetch(DATA)).json();
  return d.repos
    .filter((r) => !SKIP.has(r.name) && !r.archived && !r.fork && r.gel?.guards?.some((g) => g.guard === FIXER && (FIXER === "sonar-patterns" || g.findings > 0)))
    .sort((a, b) => b.gel.guards.find((g) => g.guard === FIXER).findings - a.gel.guards.find((g) => g.guard === FIXER).findings)
    .map((r) => `${d.org}/${r.name}`);
}

const openPr = (repo) => {
  try { return sh("gh", ["pr", "list", "-R", repo, "--head", BRANCH, "--state", "open", "--json", "url", "-q", ".[0].url"]).trim(); } catch { return ""; }
};

let opened = 0;
log(`## GEL autofix: ${FIXER}${dry ? " (dry run: no GH_TOKEN or --dry-run)" : ""}`);
if (isPaused(process.env.GEL_PAUSE)) { log("Paused: GEL_PAUSE is set, nothing was done."); process.exit(0); }
const repos = await candidates();
const waiting = new Map(repos.map((r) => [r, openPr(r)]));
const open = [...waiting.values()].filter(Boolean).length;
const { allow, why } = budget({ max: MAX, wip: WIP, open });
log(`${open} loop PRs open (cap ${WIP}), may open ${allow} more`);
if (!allow) { log(`Stopped by the brake: ${why}.`); process.exit(0); }
for (const repo of repos) {
  if (opened >= allow) break;
  const existing = waiting.get(repo);
  if (existing) { log(`- ${repo}: already open ${existing}`); continue; }
  const dir = mkdtempSync(join(tmpdir(), "gel-fly-"));
  try {
    sh("gh", ["repo", "clone", repo, dir, "--", "-q", "--depth", "1"]);
    let report;
    try { report = JSON.parse(sh("node", [join(here, "../bin/gel.mjs"), "fix", FIXER, "--root", dir, "--repo", repo, "--json"], { env: { ...process.env, GITHUB_REPOSITORY: "" } })); }
    catch (e) { report = JSON.parse(e.stdout || "{}"); }
    const b = report.before?.[FIXER], a = report.after?.[FIXER];
    if (!report.better) { log(`- ${repo}: not better (${b} -> ${a}${report.worse?.length ? `, worse: ${report.worse.join(",")}` : ""}), no PR`); continue; }
    if (dry) { log(`- ${repo}: would open a PR, ${b} -> ${a} findings in ${report.files.join(", ")}`); opened++; continue; }
    const g = (...a) => sh("git", ["-C", dir, ...a]);
    g("checkout", "-q", "-b", BRANCH);
    const title = FIXER === "sonar-patterns" ? `fix(sonar): ${report.fixed} mechanical fixes in ${report.files.length} files (GEL)` : `ci: pin ${report.pinned} actions to commit SHAs`;
    g("add", "--", ...report.files);
    g("-c", "user.name=GEL autofix", "-c", "user.email=noreply@flisk.sh", "commit", "-q", "-s", "-m",
      `${title}\n\nOpened by the GEL autofix (flisk-sh/gel scripts/autofix.mjs). The ${FIXER}\nguard went from ${b} to ${a} findings and no other guard rose.`);
    try { g("push", "-q", "origin", BRANCH); } catch (e) { log(`- ${repo}: push of ${BRANCH} failed, skipped: ${String(e.stderr || e.message).trim().split("\n").slice(0, 3).join(" | ")}`); continue; }
    const unresolved = report.unresolved.length ? `\n\nLeft for a person (${FIXER === "sonar-patterns" ? "not safe to rewrite mechanically" : "no tag or branch found"}):\n${report.unresolved.map((u) => `- \`${u.file}:${u.line}\` ${u.why}`).join("\n")}` : "";
    const what = FIXER === "sonar-patterns"
      ? `Rewrites ${report.fixed} SonarCloud findings the sonar-patterns guard reports: \`[ ]\` becomes \`[[ ]]\` in bash scripts (bash:S7688) and a bare \`.sort()\` gets a compare function (typescript:S2871). Only lines the guard named were edited; a test that could mean something else in \`[[ ]]\` (\`-a\`, \`-o\`, globs, two tests on a line) was left alone. The frozen baseline in docs/gel.json was lowered for ${report.lowered} files.`
      : `Pins ${report.pinned}`;
    const body = FIXER === "sonar-patterns" ? `${what}\n\n| guard | before | after |\n|---|---|---|\n${Object.keys(report.before).map((k) => `| ${k} | ${report.before[k]} | ${report.after[k]} |`).join("\n")}\n\nThe guards decided this is better; nothing here was judged by a model. Check the sort calls: a compare function keeps string order, but an array of numbers now sorts as numbers.${unresolved}\n\nOpened by the [GEL autofix](https://github.com/flisk-sh/gel/blob/main/scripts/autofix.mjs).` : `Pins ${report.pinned} GitHub Actions to the commit their tag points at today, with the tag kept as a comment, so a moved tag cannot change what runs.\n\n| guard | before | after |\n|---|---|---|\n${Object.keys(report.before).map((k) => `| ${k} | ${report.before[k]} | ${report.after[k]} |`).join("\n")}\n\nOnly the lines the pinned-actions guard reported were edited. The guards decided this is better; nothing here was judged by a model.${unresolved}\n\nOpened by the [GEL autofix](https://github.com/flisk-sh/gel/blob/main/scripts/autofix.mjs).`;
    const url = sh("gh", ["pr", "create", "-R", repo, "--head", BRANCH, "--title", title, "--body", body]).trim();
    log(`- ${repo}: opened ${url} (${b} -> ${a})`);
    opened++;
  } catch (e) {
    log(`- ${repo}: failed: ${String(e.stderr || e.message).split("\n")[0]}`);
  }
}
log(`${opened} ${dry ? "would be opened" : "opened"} (max ${MAX}, cap ${WIP} open)`);
