#!/usr/bin/env node
import { measure as measureFirstScreen } from "../lib/five-second-render.mjs";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { pickLane, lanePlan } from "../lib/lane.mjs";
import { matchAny } from "../lib/glob.mjs";
import { walk, readText } from "../lib/fs.mjs";
import { NS_BRANCH, northStarArgs, publish as publishNorthStar } from "../lib/north-star-branch.mjs";
import { GUARD_NAMES, WHOLE_TREE, loadGuard } from "../lib/guards.mjs";
import { selftest } from "../lib/selftest.mjs";
import { diffChanges, movedOnBase, baseReader } from "../lib/diff.mjs";
import { readRecords, metrics, metricsMarkdown } from "../lib/metrics.mjs";
import { plan as promotePlan, apply as promoteApply, warnings as promoteWarnings, promoteMarkdown } from "../lib/promote.mjs";
import { factory, factoryMarkdown, fromGh } from "../lib/factory.mjs";
import { EVAL_NAMES, runEval, ratchet, evalSelftest, readJson } from "../lib/evals.mjs";
import { meta, metaMarkdown, metaSelftest } from "../lib/meta.mjs";
import { collectRuns } from "../evals/ci-reliability/collect.mjs";
import { fixPinned, lsRemoteResolver } from "../lib/fix-pinned.mjs";
import { collectRelease } from "../lib/release-ctx.mjs";
import { run as northStar, ratioOf } from "../guards/north-star/index.mjs";
import { measure as measureInput } from "../lib/input-viewport.mjs";
import { run as productBrief, briefRows } from "../guards/product-brief/index.mjs";
import { judge as judgeClicks, limits as clickLimits } from "../guards/click-map/index.mjs";
import { measure as measureClicks } from "../lib/click-map.mjs";
import { gradeRepo } from "../lib/grades.mjs";
import { scorecard, scorecardMarkdown } from "../lib/queue.mjs";
import { collectQueue } from "../lib/queue-collect.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

function changedFiles(root, base) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return null; }
}

// every guard over the whole tree: { guard: { count, findings } } (the flywheel's before/after score)
async function scanTree(root) {
  const cfg = loadConfig(root);
  const files = walk(root).filter((f) => !matchAny(cfg.ignore, f));
  const out = {};
  for (const name of GUARD_NAMES) {
    if (cfg.guards[name] === "off") continue;
    const res = await (await loadGuard(name)).run({ root, files, ctx: {}, cfg, changes: null, readBase: null });
    out[name] = { count: res.findings.length, findings: res.findings };
  }
  return out;
}

// gel fix <guard>: fix what the guard reports, then let the guards score the result
async function fix() {
  const what = args[1];
  if (what !== "pinned-actions") { console.log("usage: gel fix pinned-actions [--root .] [--repo owner/name] [--json]"); process.exit(2); }
  const root = resolve(opt("root", "."));
  // the repo's own owner is trusted (its actions may stay on a tag), as in CI, so the fixer needs to know the repo
  if (!process.env.GITHUB_REPOSITORY) {
    const repo = opt("repo") ?? (() => {
      try { return execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1]; } catch { return undefined; }
    })();
    if (!repo) { console.log("gel fix: pass --repo owner/name (no GitHub origin found)"); process.exit(2); }
    process.env.GITHUB_REPOSITORY = repo;
  }
  const before = await scanTree(root);
  const res = fixPinned(root, before[what]?.findings ?? [], lsRemoteResolver());
  const after = await scanTree(root);
  const counts = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.count]));
  const worse = Object.keys(after).filter((k) => after[k].count > (before[k]?.count ?? 0));
  // the target guard must drop, no guard may rise, and only workflow or action files may change (never policy or cases)
  const outside = res.files.filter((f) => !(/^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(f) || /(^|\/)action\.ya?ml$/.test(f)));
  const better = (after[what]?.count ?? 0) < (before[what]?.count ?? 0) && !worse.length && !outside.length;
  const report = { fixer: what, better, before: counts(before), after: counts(after), worse, outside, files: res.files, pinned: res.pinned, unresolved: res.unresolved };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else {
    console.log(`${what}: ${before[what]?.count ?? 0} -> ${after[what]?.count ?? 0} findings, ${res.pinned} pinned in ${res.files.length} files${better ? "" : " (not better: do not open a PR)"}`);
    if (worse.length) console.log(`worse: ${worse.join(", ")}`);
    for (const u of res.unresolved) console.log(`unresolved ${u.file}:${u.line} ${u.why}`);
  }
  process.exit(better ? 0 : 1);
}

async function main() {
  if (cmd === "fix") return fix();
  if (cmd === "selftest") {
    const rows = await selftest();
    if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(rows.every((r) => r.ok) ? 0 : 1); }
    for (const r of rows) {
      console.log(`${r.ok ? "ok  " : "FAIL"} ${r.guard.padEnd(20)} cases ${r.cases} (good ${r.good}, bad ${r.bad})  recall ${(r.recall * 100).toFixed(0)}%  precision ${(r.precision * 100).toFixed(0)}%  false blocks ${r.falseBlocks}`);
      for (const w of r.wrong) console.log(`       ${w}`);
    }
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
  }
  if (cmd === "factory") {
    // gel factory (<prs.json> | --repo owner/name [--limit 100]) [--json]: touch points and lead time per merged PR (north star of the factory)
    let prs;
    if (opt("repo")) {
      // gh's GraphQL node limit caps one query, so read 25 PRs at a time, walking back by creation date
      // gh is looked up in fixed system directories, not through PATH (Sonar S4036)
      const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find((f) => existsSync(f));
      if (!GH) { console.log("gh not found in /opt/homebrew/bin, /usr/local/bin or /usr/bin: install the GitHub CLI, or pass a prs.json"); process.exit(2); }
      const want = Number(opt("limit", 100)); prs = []; let before = "";
      while (prs.length < want) {
        const q = ["pr", "list", "-R", opt("repo"), "--state", "merged", "--limit", "25", "--json", "number,author,createdAt,mergedAt,mergedBy,autoMergeRequest,headRefName,reviews,comments,commits", ...(before ? ["--search", `created:<${before}`] : [])];
        const page = JSON.parse(execFileSync(GH, q, { encoding: "utf8", maxBuffer: 1 << 26 }));
        prs.push(...page.map(fromGh));
        if (page.length < 25) break;
        before = page.reduce((m, p) => (p.createdAt < m ? p.createdAt : m), page[0].createdAt);
      }
      prs = prs.slice(0, want);
    } else {
      const f = args.slice(1).find((a, i, xs) => !a.startsWith("--") && !(xs[i - 1] ?? "").startsWith("--"));
      if (!f) { console.log("usage: gel factory (<prs.json> | --repo owner/name [--limit 100]) [--json]"); process.exit(2); }
      prs = JSON.parse(readFileSync(f, "utf8"));
    }
    const report = factory(prs);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 1) : factoryMarkdown(report));
    process.exit(0);
  }
  if (cmd === "promote") {
    // gel promote <gel-record.jsonl ...> [--labels f] [--root .] [--write] [--json]: turn gel metrics advice into a change of docs/gel.json
    const root = resolve(opt("root", "."));
    const recs = readRecords(args.slice(1).filter((a, i, xs) => !a.startsWith("--") && !(xs[i - 1] ?? "").startsWith("--")));
    const labels = opt("labels") && existsSync(opt("labels")) ? JSON.parse(readFileSync(opt("labels"), "utf8")) : [];
    const file = join(root, "docs", "gel.json");
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const changes = promotePlan(metrics(recs, labels, loadConfig(root)), raw);
    const warns = promoteWarnings(raw, changes);
    if (args.includes("--write") && changes.length) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(promoteApply(raw, changes), null, 2) + "\n"); }
    console.log(args.includes("--json") ? JSON.stringify({ changes, warnings: warns, written: args.includes("--write") && changes.length > 0 }, null, 1) : promoteMarkdown(changes, warns));
    process.exit(0);
  }
  if (cmd === "metrics") {
    const recs = readRecords(args.slice(1).filter((a, i, xs) => !a.startsWith("--") && !(xs[i - 1] ?? "").startsWith("--")));
    const labels = opt("labels") && existsSync(opt("labels")) ? JSON.parse(readFileSync(opt("labels"), "utf8")) : [];
    const report = metrics(recs, labels, loadConfig(resolve(opt("root", "."))));
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 1));
    else console.log(metricsMarkdown(report));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, metricsMarkdown(report) + "\n");
    process.exit(0);
  }
  if (cmd === "eval") {
    const sub = args[1] && !args[1].startsWith("--") ? args[1] : "run";
    const json = args.includes("--json");
    if (sub === "selftest") {
      const rows = await evalSelftest();
      if (json) console.log(JSON.stringify(rows, null, 1));
      else for (const r of rows) { console.log(`${r.ok ? "ok  " : "FAIL"} ${r.eval.padEnd(16)} cases ${r.cases} (planted-low ${r.lows})`); for (const w of r.wrong) console.log(`       ${w}`); }
      process.exit(rows.every((r) => r.ok) ? 0 : 1);
    }
    if (sub === "collect") { console.log(JSON.stringify(collectRuns(opt("repo")))); process.exit(0); }
    const only = opt("only") ? opt("only").split(",") : EVAL_NAMES;
    const ctx = { runs: readJson(opt("runs"), undefined) };
    const root = resolve(opt("root", "."));
    const base = readJson(opt("baseline"), {});
    const rows = ratchet(await Promise.all(only.map((n) => runEval(n, { root, ctx }))), base);
    if (opt("record")) appendFileSync(opt("record"), rows.map((r) => JSON.stringify({ at: new Date().toISOString(), repo: process.env.GITHUB_REPOSITORY ?? root, eval: r.eval, score: r.score, status: r.status })).join("\n") + "\n");
    if (json) console.log(JSON.stringify(rows, null, 1));
    else for (const r of rows) {
      console.log(`${{ ok: "ok  ", below: "LOW ", skip: "skip" }[r.status]} ${r.eval.padEnd(16)} ${r.score === null ? "  - " : r.score.toFixed(2)}  (need ${r.threshold})${r.dropped ? `  DROPPED from ${r.baseline}` : ""}  ${r.detail}`);
      for (const it of r.items.slice(0, 5)) console.log(`       ${JSON.stringify(it)}`);
    }
    // report mode by default: it only fails with --strict
    process.exit(args.includes("--strict") && rows.some((r) => r.status === "below" || r.dropped) ? 1 : 0);
  }
  if (cmd === "meta") {
    if (args[1] === "selftest") {
      const res = metaSelftest(JSON.parse(readFileSync(new URL("../evals/meta/cases.json", import.meta.url), "utf8")));
      console.log(`${res.ok ? "ok  " : "FAIL"} meta  cases ${res.cases}`);
      for (const w of res.wrong) console.log(`       ${w}`);
      process.exit(res.ok ? 0 : 1);
    }
    const recs = readRecords(args.slice(1).filter((a, i, xs) => !a.startsWith("--") && !(xs[i - 1] ?? "").startsWith("--")));
    const evalRecords = opt("evals") && existsSync(opt("evals")) ? readFileSync(opt("evals"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const rows = meta({ records: recs, evalRecords, outcomes: readJson(opt("outcomes"), []) });
    if (args.includes("--json")) console.log(JSON.stringify(rows, null, 1));
    else console.log(metaMarkdown(rows));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, metaMarkdown(rows) + "\n");
    process.exit(0);
  }
  if (cmd === "release-ctx") {
    // read-only: gel release-ctx --repo o/n --tag v1.2.3 [--sha <sha>] [--phase pre|post] > ctx.json, then gel run --ctx ctx.json
    const repo = opt("repo") ?? process.env.GITHUB_REPOSITORY;
    const tag = opt("tag") ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
    if (!repo || !tag) { console.log("usage: gel release-ctx --repo owner/name --tag v1.2.3 [--sha <sha>] [--phase pre|post]"); process.exit(2); }
    console.log(JSON.stringify(collectRelease({ repo, tag, sha: opt("sha"), phase: opt("phase", "post") })));
    process.exit(0);
  }
  if (cmd === "north-star") {
    // gel north-star [--root .] [--measure [--publish]] [--json]: with --measure, run north_star.measure (it prints {"value":..,"baseline":..,"unit":..}),
    // stamp measuredAt and, in Actions, the run link, and write north_star.result; --publish also pushes it to the north-star
    // branch (lib/north-star-branch.mjs). Then judge the newest result against the target. Exit 1 when the target is not met,
    // or when the measure itself exited non-zero (its number is still published; its "problem" field is printed).
    const root = resolve(opt("root", "."));
    const cfg = loadConfig(root);
    const ns = cfg.north_star;
    if (!ns?.result) { console.log('docs/gel.json has no north_star.result: see the north-star guard in README.md'); process.exit(2); }
    let measureFailed = null;
    if (args.includes("--measure")) {
      if (!ns.measure) { console.log("north_star.measure is not set: nothing to run"); process.exit(2); }
      // a measure that exits non-zero still printed a real number: keep and publish it, but remember the exit, because the
      // measure may know something the ratio cannot see (the page scrolls sideways, the button is covered)
      let out, measureExit = 0;
      try { out = execSync(ns.measure, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }); }
      catch (err) { out = String(err.stdout ?? ""); measureExit = err.status ?? 1; if (!out.trim()) throw err; }
      let r;
      try { r = JSON.parse(out.trim().split("\n").filter(Boolean).pop()); } catch { r = null; }
      if (typeof r?.value !== "number") { console.error(`north star: the measure printed no {"value": ...} line last${r?.problem ? `: ${r.problem}` : ""}`); process.exit(2); }
      measureFailed = measureExit ? `the measure exited ${measureExit}${r.problem ? `: ${r.problem}` : ""}` : null;
      const e = process.env;
      const run = e.GITHUB_RUN_ID && e.GITHUB_REPOSITORY ? `${e.GITHUB_SERVER_URL ?? "https://github.com"}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}` : undefined;
      const text = JSON.stringify({ ...r, measuredAt: new Date().toISOString(), ...(run ? { run, commit: e.GITHUB_SHA } : {}) }, null, 1) + "\n";
      mkdirSync(dirname(resolve(root, ns.result)), { recursive: true });
      writeFileSync(resolve(root, ns.result), text);
      if (args.includes("--publish")) {
        const p = publishNorthStar(root, ns.result, text);
        console.error(`north star: published ${p.commit.slice(0, 12)} to the ${NS_BRANCH} branch (${p.runs} measurement${p.runs === 1 ? "" : "s"} in history.jsonl)`);
      }
    }
    const nsArgs = northStarArgs(root, cfg, { files: walk(root) }, readText);
    const verdict = northStar({ cfg, files: nsArgs.files, read: nsArgs.read ?? ((f) => readText(root, f)) });
    let r = null; try { r = JSON.parse((nsArgs.read ?? ((f) => readText(root, f)))(ns.result)); } catch {}
    const got = r ? ratioOf(r, ns.target?.better) : null;
    if (args.includes("--json")) console.log(JSON.stringify({ met: verdict.pass, ratio: got, target: ns.target?.ratio, findings: verdict.findings, ...(measureFailed ? { measure: measureFailed } : {}) }));
    else {
      console.log(`north star: ${ns.metric}\n  now ${r?.value ?? "?"}${r?.unit ? " " + r.unit : ""} vs ${ns.baseline} ${r?.baseline ?? "?"}${r?.unit ? " " + r.unit : ""} = ${got ? got.toFixed(2) : "?"}x, target ${ns.target?.ratio}x -> ${verdict.pass ? "MET" : "NOT MET"}`);
      for (const f of verdict.findings) console.log(`  ${f.message}`);
      if (measureFailed) console.log(`  ${measureFailed}: the number is published, the run is not green`);
    }
    process.exit(verdict.pass && !measureFailed ? 0 : 1);
  }
  if (cmd === "brief") {
    // gel brief [--root .] [--json]: the six answers in docs/gel.json "brief" (what, who, why, how, where, when) beside their measured numbers.
    // Exit 1 when the product-brief guard has a finding (an answer or a fresh number is missing). A target that is not met yet is printed, not failed.
    const root = resolve(opt("root", "."));
    const cfg = loadConfig(root);
    if (cfg.brief == null) { console.log('docs/gel.json has no "brief": see the product-brief guard in README.md'); process.exit(2); }
    const a = { cfg, files: walk(root), read: (f) => readText(root, f), ctx: {} };
    const verdict = productBrief(a);
    const { rows } = briefRows(a);
    const metCount = rows.filter((r) => r.met).length;
    if (args.includes("--json")) console.log(JSON.stringify({ pass: verdict.pass, met: metCount, of: rows.length, rows: rows.map(({ declared, measured, ...r }) => r), findings: verdict.findings }));
    else {
      console.log(`brief: ${metCount} of ${rows.length} targets met`);
      for (const r of rows) console.log(`  ${r.question.padEnd(5)} ${r.answer ?? "(no answer)"}\n        ${r.metric ?? "(no metric)"}: ${r.value ?? "?"}${r.unit ? " " + r.unit : ""}, target ${r.better === "lower" ? "at most" : "at least"} ${r.target ?? "?"} -> ${r.met == null ? "NOT MEASURED" : r.met ? "MET" : "NOT MET"}${r.ageDays != null ? ` (${r.ageDays} days old)` : ""}`);
      for (const f of verdict.findings) console.log(`  ${f.message}`);
    }
    process.exit(verdict.pass ? 0 : 1);
  }
  if (cmd === "grade") {
    // gel grade [--root .] [--now 2026-11-22] [--json]: the grade of each product check (click-map, ice-score, product-brief),
    // bad < passed < good < high < super high, or "no grade" when the repo has nothing for that check. Exit 1 when one is bad.
    const g = gradeRepo(resolve(opt("root", ".")), { now: opt("now") });
    if (args.includes("--json")) console.log(JSON.stringify(g));
    else for (const [check, r] of Object.entries(g)) console.log(`${check.padEnd(14)} ${r.grade ?? "no grade"}${r.why ? ` (${r.why})` : ""}`);
    process.exit(Object.values(g).some((r) => r.grade === "bad") ? 1 : 0);
  }
  if (cmd === "input-viewport") {
    // gel input-viewport (--url https://site | --file index.html) [--size 375x667,320x568] [--cookie 'a=b'] [--write bench/input-viewport.json] [--json]
    // Measures where the first visible input or textarea sits at phone sizes (headless Chrome). Exit 1 when it ends below the first screen.
    const target = opt("url") ? { url: opt("url") } : opt("file") ? { file: opt("file") } : null;
    if (!target) { console.log("usage: gel input-viewport (--url https://site | --file index.html) [--size 375x667,320x568] [--cookie 'a=b'] [--write bench/input-viewport.json] [--json]"); process.exit(2); }
    const entries = [];
    for (const sz of opt("size", "375x667,320x568").split(",")) {
      const [width, height] = sz.split("x").map(Number);
      entries.push(await measureInput({ ...target, width, height, cookie: opt("cookie") }));
    }
    const bad = entries.filter((e) => e.bottom == null || e.bottom > e.height);
    if (opt("write")) writeFileSync(resolve(opt("write")), JSON.stringify({ measuredAt: new Date().toISOString(), entries }, null, 1) + "\n");
    if (args.includes("--json")) console.log(JSON.stringify({ ok: bad.length === 0, entries }));
    else for (const e of entries) console.log(`${e.width}x${e.height}: input ${e.bottom == null ? "NOT FOUND" : `ends at ${Math.round(e.bottom)}px`} -> ${e.bottom != null && e.bottom <= e.height ? "IN VIEW" : "BELOW THE FIRST SCREEN"}`);
    process.exit(bad.length ? 1 : 0);
  }
  if (cmd === "click-map") {
    // gel click-map (--url https://site/api/clicks?page=home&dev=mobile&days=30 | --file answer.json) [--merge] [--write docs/click-map.json] [--root .] [--json]
    // Reads one page's click numbers from the site and keeps what the click-map guard judges. --merge keeps the other pages already in the file.
    // A click map that answers only its owner (Flisk Analytics) gets the key from GEL_CLICKS_TOKEN, sent as a Bearer header.
    if (!opt("url") && !opt("file")) { console.log("usage: gel click-map (--url https://site/api/clicks?page=home&dev=mobile&days=30 | --file answer.json) [--merge] [--write docs/click-map.json] [--root .] [--json]"); process.exit(2); }
    let e;
    try { e = await measureClicks({ url: opt("url"), file: opt("file"), token: process.env.GEL_CLICKS_TOKEN }); } catch (err) { console.error(`click-map: ${err.message}`); process.exit(1); }
    const out = opt("write");
    let entries = [e];
    if (out && args.includes("--merge") && existsSync(out)) { try { entries = [...JSON.parse(readFileSync(out, "utf8")).entries.filter((x) => x.page !== e.page || x.dev !== e.dev), e]; } catch {} }
    const doc = { measuredAt: new Date().toISOString(), entries };
    if (out) writeFileSync(resolve(out), JSON.stringify(doc, null, 1) + "\n");
    const lim = clickLimits(loadConfig(resolve(opt("root", "."))));
    const v = judgeClicks(e, lim);
    if (args.includes("--json")) console.log(JSON.stringify({ ok: v.problems.length === 0, judged: v.judged, deadShare: v.deadShare, mainShare: v.mainShare, problems: v.problems, entry: e }));
    else {
      const top = e.targets[0];
      console.log(`click-map: ${v.label}: ${e.clicks} clicks${e.days ? ` in ${e.days} days` : ""}, ${e.dead} hit nothing (${Math.round((v.deadShare ?? 0) * 100)}%)${top ? `, most pressed: "${top.target}" (${top.n}${top.kind === "dead" ? ", does nothing" : ""})` : ""}${v.judged ? "" : ` -> too few clicks to judge (under ${lim.minClicks})`}${out ? ` -> ${out}` : ""}`);
      for (const p of v.problems) console.log(`  ${p}`);
    }
    process.exit(v.problems.length ? 1 : 0);
  }
  if (cmd === "five-second") {
    // gel five-second (--url https://site | --file index.html) [--size 375x812] [--merge] [--write bench/five-second.json] [--json]
    const target = opt("url") ?? opt("file");
    if (!target) { console.log("usage: gel five-second (--url https://site | --file index.html) [--size 375x812] [--merge] [--write bench/five-second.json] [--json]"); process.exit(2); }
    const e = await measureFirstScreen({ url: opt("url"), file: opt("file"), size: opt("size", "375x812") });
    const out = opt("write");
    let entries = [e];
    if (out && args.includes("--merge") && existsSync(out)) { try { entries = [...JSON.parse(readFileSync(out, "utf8")).entries.filter((x) => x.page !== e.page), e]; } catch {} }
    const doc = { measuredAt: new Date().toISOString(), entries };
    if (out) writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
    if (args.includes("--json") || !out) console.log(JSON.stringify(doc, null, 2));
    else console.log(`five-second: ${e.html ? "first screen kept" : "NO visible <h1> drawn"}${e.covered ? `, the headline is covered by ${e.covered}` : ""} for ${e.page} -> ${out}`);
    process.exit(e.html && !e.covered ? 0 : 1);
  }
  if (cmd === "queue-ready") {
    // gel queue-ready [--root .] [--repo o/n | --snapshot queue.json] [--json]: one preflight score before a merge queue (or a
    // "GEL required" ruleset) is switched on. Offline unless --repo reads the ruleset; below 100 it exits 1.
    const root = resolve(opt("root", "."));
    const cfg = loadConfig(root);
    const files = walk(root).filter((f) => !matchAny(cfg.ignore, f));
    const queue = opt("snapshot") ? JSON.parse(readFileSync(opt("snapshot"), "utf8")) : opt("repo") ? collectQueue(opt("repo")) : undefined;
    const card = scorecard({ files, read: (f) => readText(root, f), cfg, queue });
    console.log(args.includes("--json") ? JSON.stringify(card, null, 1) : scorecardMarkdown(card));
    process.exit(card.score === 100 ? 0 : 1);
  }
  if (cmd === "lane") {
    const root = resolve(opt("root", "."));
    const cfg = loadConfig(root);
    const plan = lanePlan(changedFiles(root, opt("base")), { laneC: cfg.laneC ?? undefined, laneA: cfg.laneA ?? undefined, minLane: opt("min") ?? cfg.minLane });
    if (args.includes("--json")) console.log(JSON.stringify(plan));
    else console.log(`lane ${plan.lane}: ${plan.reason}\nruns: ${plan.scripts.join(" ")}${plan.pythonTests ? " pytest" : ""}${plan.codeql ? " codeql" : ""}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, [`lane=${plan.lane}`, `lane_reason=${plan.reason}`, `scripts=${plan.scripts.join(" ")}`, `python_tests=${plan.pythonTests}`, `codeql=${plan.codeql}`].join("\n") + "\n");
    process.exit(0);
  }
  if (cmd !== "run") { console.log("usage: gel queue-ready [--root .] [--repo o/n | --snapshot queue.json] [--json] | gel five-second (--url u | --file f) [--write f] | gel click-map (--url u | --file f) [--merge] [--write f] | gel input-viewport (--url u | --file f) [--size WxH,..] [--write f] | gel north-star [--root .] [--measure] [--json] | gel brief [--root .] [--json] | gel lane [--root .] [--base <sha>] [--min A|B|C] [--json] | gel run [--root .] [--base <sha>] [--ctx ctx.json] [--record gel-record.jsonl] | gel selftest [--json] | gel factory (<prs.json> | --repo o/n [--limit 100]) [--json] | gel promote <gel-record.jsonl ...> [--labels f] [--root .] [--write] [--json] | gel metrics <gel-record.jsonl ...> [--labels gel-labels.json] [--json] | gel eval [selftest|collect --repo o/n] [--only a,b] [--runs runs.json] [--baseline b.json] [--record f] [--strict] [--json] | gel meta <gel-record.jsonl ...> [--evals f] [--outcomes f] | gel meta selftest | gel fix pinned-actions [--root .] [--repo owner/name] [--json] | gel release-ctx --repo owner/name --tag v1.2.3 [--sha s] [--phase pre|post]"); process.exit(2); }

  const root = resolve(opt("root", "."));
  const cfg = loadConfig(root);
  const all = walk(root);
  const changed = changedFiles(root, opt("base"));
  const scope = (changed ?? all).filter((f) => existsSync(resolve(root, f)) && !matchAny(cfg.ignore, f));
  const { lane, reason } = pickLane(changed ?? all, { laneC: cfg.laneC ?? undefined, laneA: cfg.laneA ?? undefined });
  const ctx = opt("ctx") && existsSync(opt("ctx")) ? JSON.parse(readFileSync(opt("ctx"), "utf8")) : {};
  // before-and-after guards (migrations, API specs) see what this branch changed; a scan of the whole tree has no "before"
  const changes = changed ? diffChanges(root, opt("base"))?.filter((c) => !matchAny(cfg.ignore, c.from ?? c.file)) ?? null : null;
  const readBase = changes ? baseReader(root, opt("base")) : null;
  // stale-base: what the base branch changed since this branch forked (pull requests only; a push scan has no base)
  if (changed && ctx.baseMoved === undefined) { const moved = movedOnBase(root, opt("base")); if (moved) ctx.baseMoved = moved; }

  const started = Date.now();
  const results = [];
  for (const name of GUARD_NAMES) {
    const level = cfg.guards[name];
    if (level === "off") continue;
    const guard = await loadGuard(name);
    // links can break in files that did not change, and a licence or a Dependabot config is absent from a diff, so these guards look at the whole tree
    const files = WHOLE_TREE.has(name) ? all : scope;
    const base = { root, files, ctx, cfg, changes, readBase };
    // the north star is judged on the newest measurement: a scheduled run publishes it to the north-star branch
    const res = await guard.run(name === "north-star" ? northStarArgs(root, cfg, base, readText) : base);
    results.push({ guard: name, level, pass: res.pass, findings: res.findings });
  }
  const blocked = results.filter((r) => !r.pass && r.level === "block");
  const record = {
    ts: new Date().toISOString(),
    repo: process.env.GITHUB_REPOSITORY ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
    lane, laneReason: reason,
    needsPerson: lane === "C",
    files: (changed ?? all).length,
    // the first findings travel with the record, so a person can label them real or false later (gel metrics)
    results: results.map((r) => ({ guard: r.guard, level: r.level, pass: r.pass, findings: r.findings.length, top: r.findings.slice(0, 10).map((f) => ({ file: f.file, line: f.line, message: f.message })) })),
    blocked: blocked.map((b) => b.guard),
    ms: Date.now() - started,
  };
  if (opt("record")) appendFileSync(opt("record"), JSON.stringify(record) + "\n");

  const lines = [`## GEL  lane ${lane}`, `${reason}${lane === "C" ? ". A person approves this one." : ""}`, "", "| Guard | Level | Result |", "| --- | --- | --- |"];
  for (const r of results) lines.push(`| ${r.guard} | ${r.level} | ${r.pass ? "pass" : `${r.findings.length} finding(s)`} |`);
  for (const r of results.filter((x) => !x.pass)) {
    lines.push("", `### ${r.guard}`);
    for (const f of r.findings.slice(0, 30)) lines.push(`- ${f.file}${f.line ? `:${f.line}` : ""} ${f.message}`);
  }
  const md = lines.join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
  if (process.env.GITHUB_ACTIONS) for (const r of results.filter((x) => !x.pass)) for (const f of r.findings.slice(0, 20)) console.log(`::${r.level === "block" ? "error" : "warning"} file=${f.file},line=${f.line || 1}::${r.guard}: ${f.message}`);
  process.exit(blocked.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
