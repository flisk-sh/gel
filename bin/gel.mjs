#!/usr/bin/env node
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { pickLane, lanePlan } from "../lib/lane.mjs";
import { matchAny } from "../lib/glob.mjs";
import { walk } from "../lib/fs.mjs";
import { GUARD_NAMES, loadGuard } from "../lib/guards.mjs";
import { selftest } from "../lib/selftest.mjs";
import { readRecords, metrics, metricsMarkdown } from "../lib/metrics.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

function changedFiles(root, base) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return null; }
}

async function main() {
  if (cmd === "selftest") {
    const rows = await selftest();
    if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(rows.every((r) => r.ok) ? 0 : 1); }
    for (const r of rows) {
      console.log(`${r.ok ? "ok  " : "FAIL"} ${r.guard.padEnd(20)} cases ${r.cases} (good ${r.good}, bad ${r.bad})  recall ${(r.recall * 100).toFixed(0)}%  precision ${(r.precision * 100).toFixed(0)}%  false blocks ${r.falseBlocks}`);
      for (const w of r.wrong) console.log(`       ${w}`);
    }
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
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
  if (cmd === "lane") {
    const root = resolve(opt("root", "."));
    const cfg = loadConfig(root);
    const plan = lanePlan(changedFiles(root, opt("base")), { laneC: cfg.laneC ?? undefined, laneA: cfg.laneA ?? undefined, minLane: opt("min") ?? cfg.minLane });
    if (args.includes("--json")) console.log(JSON.stringify(plan));
    else console.log(`lane ${plan.lane}: ${plan.reason}\nruns: ${plan.scripts.join(" ")}${plan.pythonTests ? " pytest" : ""}${plan.codeql ? " codeql" : ""}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, [`lane=${plan.lane}`, `lane_reason=${plan.reason}`, `scripts=${plan.scripts.join(" ")}`, `python_tests=${plan.pythonTests}`, `codeql=${plan.codeql}`].join("\n") + "\n");
    process.exit(0);
  }
  if (cmd !== "run") { console.log("usage: gel lane [--root .] [--base <sha>] [--min A|B|C] [--json] | gel run [--root .] [--base <sha>] [--ctx ctx.json] [--record gel-record.jsonl] | gel selftest [--json] | gel metrics <gel-record.jsonl ...> [--labels gel-labels.json] [--json]"); process.exit(2); }

  const root = resolve(opt("root", "."));
  const cfg = loadConfig(root);
  const all = walk(root);
  const changed = changedFiles(root, opt("base"));
  const scope = (changed ?? all).filter((f) => existsSync(resolve(root, f)) && !matchAny(cfg.ignore, f));
  const { lane, reason } = pickLane(changed ?? all, { laneC: cfg.laneC ?? undefined, laneA: cfg.laneA ?? undefined });
  const ctx = opt("ctx") && existsSync(opt("ctx")) ? JSON.parse(readFileSync(opt("ctx"), "utf8")) : {};

  const started = Date.now();
  const results = [];
  for (const name of GUARD_NAMES) {
    const level = cfg.guards[name];
    if (level === "off") continue;
    const guard = await loadGuard(name);
    // links can break in files that did not change, so that guard looks at the whole tree
    const files = name === "dead-links" ? all : scope;
    const res = await guard.run({ root, files, ctx, cfg });
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
