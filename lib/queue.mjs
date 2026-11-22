// Merge-queue readiness, read from a repo's own workflow files and docs/gel.json. No node imports: this also runs
// in a browser. Every rule here is one of the twelve items of `gel queue-ready` (docs/queue.md), and each item is a
// defect class that flisk found in production, not in review. A finding is { file, line, message, item, fix }.
import { parseYaml } from "./yaml-lite.mjs";

export const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const base = (f) => f.split("/").pop();

export const ITEMS = [
  { n: 1, class: 1, name: "every required check also runs on merge_group" },
  { n: 2, class: 3, name: "merge_group concurrency groups are unique per queue entry" },
  { n: 3, class: 3, name: "merge_group jobs have timeouts and the critical path fits the queue's check timeout" },
  { n: 4, class: 4, name: "a costly merge_group workflow reuses the PR's run, path-filters, or declares queue_full" },
  { n: 5, class: 6, name: "no queue entry runs a matrix over the leg budget" },
  { n: 6, class: 5, name: "diff bases in merge_group workflows exist on merge_group" },
  { n: 7, class: 7, name: "no workflow repeats merge_group checks on push to the default branch" },
  { n: 8, class: 8, name: "a stalled-queue detector is installed" },
  { n: 9, class: 3, name: "a dead-batch run canceller is installed" },
  { n: 10, class: 5, name: "bash scripts that need bash set shell: bash where the default shell is not bash" },
  { n: 11, class: 10, name: "known-flaky bring-up steps are wrapped in a retry" },
  { n: 12, class: 2, name: "every ruleset rule can be satisfied (online)" },
];

// ---- reading workflows ---------------------------------------------------------------------------------------------

export function triggers(doc) {
  const on = doc.on;
  if (on == null) return {};
  if (typeof on === "string") return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), {}]));
  return Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v && typeof v === "object" ? v : {}]));
}

export function loadWorkflows(files, read) {
  const out = [];
  for (const file of files.filter((f) => WORKFLOW_RE.test(f))) {
    const text = read(file);
    if (text === null || text === undefined) continue;
    let doc;
    try { doc = parseYaml(text); } catch { continue; } // an odd file is skipped, never turned into a finding
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
    const jobs = Object.entries(doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {}).map(([id, job]) => {
      const j = job && typeof job === "object" ? job : {};
      return { id, job: j, name: typeof j.name === "string" ? j.name : id, calls: typeof j.uses === "string" };
    });
    out.push({ file, text, doc, on: triggers(doc), jobs });
  }
  return out;
}

export const hasMergeGroup = (w) => Object.hasOwn(w.on, "merge_group");
export const queueApplies = (wfs, cfg) => wfs.some(hasMergeGroup) || Boolean(cfg?.queue);

export function lineOf(text, re) {
  const i = text.split("\n").findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}
export const jobLine = (w, id) => lineOf(w.text, new RegExp(`^\\s+["']?${esc(id)}["']?\\s*:`));

// Does this job run on `event`? Only a plain `github.event_name ==/!=` condition is understood; anything else counts
// as "runs" so a finding is never hidden by a condition this reader cannot judge.
export function runsOnEvent(job, event) {
  if (job.if === false || String(job.if) === "false") return false;
  const c = typeof job.if === "string" ? job.if : "";
  if (!c || /\|\|/.test(c)) return true;
  const neq = [...c.matchAll(/github\.event_name\s*!=\s*['"]([\w]+)['"]/g)].map((m) => m[1]);
  if (neq.includes(event)) return false;
  const eq = [...c.matchAll(/github\.event_name\s*==\s*['"]([\w]+)['"]/g)].map((m) => m[1]);
  if (eq.length && !eq.includes(event) && !/!/.test(c)) return false;
  return true;
}

// Legs a job expands to. A matrix built at run time (fromJSON) cannot be counted from the YAML: `dynamic`.
export function matrixOf(job) {
  const s = job.strategy;
  if (typeof s === "string") return { legs: null, dynamic: true };
  const m = s?.matrix;
  if (m === undefined || m === null) return { legs: 1, dynamic: false };
  if (typeof m === "string") return { legs: null, dynamic: true };
  const axes = Object.entries(m).filter(([k]) => k !== "include" && k !== "exclude");
  let dynamic = typeof m.include === "string" || typeof m.exclude === "string";
  let n = axes.length ? 1 : 0;
  for (const [, v] of axes) { if (Array.isArray(v)) n *= v.length; else dynamic = true; }
  const incs = Array.isArray(m.include) ? m.include : [];
  const excs = Array.isArray(m.exclude) ? m.exclude : [];
  n = Math.max(axes.length ? 1 : 0, n - excs.length);
  for (const inc of incs) {
    const entries = Object.entries(inc ?? {});
    // an include only adds a leg when it cannot be merged into an existing combination
    if (!axes.length || entries.some(([k, v]) => axes.some(([a]) => a === k) && !(Array.isArray(m[k]) && m[k].includes(v)))) n++;
  }
  return { legs: dynamic ? null : Math.max(n, 1), dynamic };
}

const minutes = (job) => { const t = Number(job["timeout-minutes"]); return Number.isFinite(t) ? t : 0; };

// the checks a job reports under: its name, "name (matrix values)", or "caller / callee" for a reusable workflow
export function checkMatches(check, w, j) {
  const stripped = j.name.split("${{")[0].trim();
  const names = [stripped, ...(typeof w.doc.name === "string" ? [`${w.doc.name} / ${stripped}`] : [])];
  return names.some((d) => d && (check === d || check.startsWith(`${d} / `) || check.startsWith(`${d} (`)));
}

const stringsOf = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringsOf(x, out));
  return out;
};
const stepsOf = (j) => (Array.isArray(j.job.steps) ? j.job.steps.filter((s) => s && typeof s === "object") : []);

// ---- items 1, 2, 3, 6, 10: queue-merge-group-parity ----------------------------------------------------------------

const GROUP_OK = /github\.(?:ref|ref_name|sha|run_id)(?![\w.])|github\.event\.merge_group\.(?:head_sha|head_ref)/;
const BAD_BASE = /github\.base_ref|github\.event\.pull_request\.base(?:\.\w+)?/;
// bash-only syntax: breaks under PowerShell on Windows. `mapfile`, `readarray` and `declare -A` also break under the
// bash 3.2 that macOS runners start by default
const BASH_ANY = /\bmapfile\b|\breadarray\b|\[\[ |\bdeclare -[aAxr]\b|^\s*(?:if|while|until) \[|\bfi\s*$|\bdone\s*$|\besac\s*$|\bexport [A-Za-z_]\w*=|<<<|\$\{[A-Za-z_]\w*[#%:,^/[]/m;
const BASH_4 = /\bmapfile\b|\breadarray\b|\bdeclare -A\b|\$\{[A-Za-z_]\w*(?:,,|\^\^)\}/;

function osOf(w, j) {
  const set = new Set();
  const ro = stringsOf(j.job["runs-on"]);
  for (const r of ro) {
    const m = r.match(/matrix\.(\w+)/);
    if (!m) { set.add(r.toLowerCase()); continue; }
    const mx = j.job.strategy?.matrix;
    for (const v of Array.isArray(mx?.[m[1]]) ? mx[m[1]] : []) set.add(String(v).toLowerCase());
    for (const inc of Array.isArray(mx?.include) ? mx.include : []) if (inc?.[m[1]]) set.add(String(inc[m[1]]).toLowerCase());
  }
  return { windows: [...set].some((s) => s.includes("windows")), mac: [...set].some((s) => s.includes("macos")) };
}

export function parity({ wfs, cfg, queue }) {
  const q = cfg?.queue ?? {};
  const out = [];
  const add = (item, w, line, message, fix) => out.push({ item, file: w.file, line, message, fix });
  const mg = wfs.filter(hasMergeGroup);

  // 1. a required check that a workflow without merge_group produces waits for a status that never comes
  const required = q.requiredChecks ?? cfg?.requiredChecks ?? [];
  for (const check of required) {
    const hits = wfs.filter((w) => w.jobs.some((j) => checkMatches(check, w, j)));
    if (!hits.length || hits.some(hasMergeGroup)) continue;
    const w = hits[0];
    const j = w.jobs.find((x) => checkMatches(check, w, x));
    add(1, w, jobLine(w, j.id), `required check "${check}" comes from job "${j.id}", but ${base(w.file)} has no merge_group trigger, so a queued PR waits for a status that never comes`, "add `merge_group:` under `on:`");
  }

  const limit = q.check_response_timeout_minutes ?? rulesOf(queue).find((r) => r.type === "merge_queue")?.parameters?.check_response_timeout_minutes ?? 60;
  for (const w of mg) {
    // 2. a group that is constant, or built from github.head_ref (empty on merge_group), is shared by every queue entry
    const groups = [{ g: w.doc.concurrency, line: lineOf(w.text, /^concurrency\s*:/) }, ...w.jobs.map((j) => ({ g: j.job.concurrency, line: jobLine(w, j.id) }))];
    for (const { g: raw, line } of groups) {
      const g = typeof raw === "string" ? raw : raw?.group;
      if (typeof g !== "string" || GROUP_OK.test(g)) continue;
      add(2, w, line, /github\.head_ref/.test(g)
        ? `concurrency group uses github.head_ref, which is empty on merge_group, so every queue entry shares one group and a group keeps only its newest waiting run`
        : `concurrency group "${g.slice(0, 80)}" has no github.ref or github.sha, so every queue entry shares it and a group keeps only its newest waiting run`, "add `github.ref` (a queue branch name) or `github.sha` to the group on merge_group");
    }

    // 3. a job with no timeout holds a runner for 360 minutes; the chain of needs must fit the queue's check timeout
    const live = w.jobs.filter((j) => runsOnEvent(j.job, "merge_group"));
    for (const j of live) {
      if (j.calls || j.job["timeout-minutes"] !== undefined) continue;
      add(3, w, jobLine(w, j.id), `job "${j.id}" runs on merge_group with no timeout-minutes, so a hang holds a runner for GitHub's 360-minute default`, "set `timeout-minutes` on the job");
    }
    const byId = new Map(live.map((j) => [j.id, j]));
    const memo = new Map();
    const chain = (id, seen = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      const j = byId.get(id);
      if (!j || seen.has(id)) return 0;
      seen.add(id);
      const needs = typeof j.job.needs === "string" ? [j.job.needs] : Array.isArray(j.job.needs) ? j.job.needs : [];
      const t = minutes(j.job) + Math.max(0, ...needs.map((n) => chain(n, seen)));
      memo.set(id, t);
      return t;
    };
    const worst = live.map((j) => ({ j, t: chain(j.id) })).sort((a, b) => b.t - a.t)[0];
    if (worst && worst.t > limit) add(3, w, jobLine(w, worst.j.id), `the longest chain of needs ending at "${worst.j.id}" adds up to ${worst.t} minutes of timeout-minutes, over the queue's check_response_timeout_minutes (${limit}); a queue entry can time out while its checks are still allowed to run`, "split the chain, shorten the timeouts, or raise check_response_timeout_minutes in the ruleset");

    // 6. github.base_ref and github.event.pull_request.base.* do not exist on merge_group
    const scopes = [{ where: "workflow env", strings: stringsOf(w.doc.env), cond: "", line: 1 }];
    for (const j of live) {
      scopes.push({ where: `job "${j.id}" env`, strings: stringsOf(j.job.env), cond: String(j.job.if ?? ""), line: jobLine(w, j.id) });
      for (const s of stepsOf(j)) scopes.push({ where: `a step of "${j.id}"`, strings: stringsOf([s.env, s.with, s.run]), cond: `${j.job.if ?? ""} ${s.if ?? ""}`, line: lineOf(w.text, new RegExp(esc((typeof s.name === "string" ? s.name : typeof s.run === "string" ? s.run.split("\n")[0] : typeof s.uses === "string" ? s.uses : "").slice(0, 60)))) });
    }
    for (const sc of scopes) {
      if (/github\.event_name\s*==\s*['"]pull_request/.test(sc.cond)) continue;
      const bad = sc.strings.find((s) => BAD_BASE.test(s) && !/github\.event\.merge_group|github\.event_name/.test(s));
      if (bad) add(6, w, sc.line, `${sc.where} reads ${bad.match(BAD_BASE)[0]}, which is empty or missing on merge_group, so a queue-only diff base falls through to the wrong commit`, "diff against `github.event.merge_group.base_sha` or the entry's first parent (`HEAD^1`), or gate the step with `if: github.event_name == 'pull_request'`");
    }

    // 10. bash syntax with no `shell:` runs under PowerShell on Windows and bash 3.2 on macOS
    for (const j of live) {
      const os = osOf(w, j);
      if (!os.windows && !os.mac) continue;
      const jobShell = j.job.defaults?.run?.shell ?? w.doc.defaults?.run?.shell;
      for (const s of stepsOf(j)) {
        if (typeof s.run !== "string" || s.shell || jobShell) continue;
        const re = os.windows ? BASH_ANY : BASH_4;
        if (!re.test(s.run)) continue;
        out.push({ item: 10, file: w.file, line: lineOf(w.text, new RegExp(esc((typeof s.name === "string" ? s.name : s.run.split("\n")[0]).slice(0, 60)))), message: `step ${typeof s.name === "string" ? `"${s.name}" ` : ""}of "${j.id}" uses bash-only syntax and sets no shell, but the job runs on ${os.windows ? "Windows (PowerShell)" : "macOS (bash 3.2)"}`, fix: "add `shell: bash` to the step (or `defaults.run.shell`)" });
      }
    }
  }
  return out;
}

// ---- items 4, 5: queue-cost-budget ----------------------------------------------------------------------------------

// A merge_group workflow that can skip work leaves a trace of how: a path filter action, a lookup of the PR's run
const SAVES = /dorny\/paths-filter|changed-files|\breus(?:e|ed|able)\b|\bgh run (?:list|view|download)\b|\bgh api\b[^\n]*(?:check-runs|actions\/runs)/i;

export function costOf(w, q) {
  const declared = typeof q.legs?.[base(w.file)] === "number" ? q.legs[base(w.file)] : typeof q.legs?.[w.file] === "number" ? q.legs[w.file] : null;
  let total = 0, dynamic = false, widest = 0, mins = 0;
  for (const j of w.jobs.filter((x) => runsOnEvent(x.job, "merge_group"))) {
    const m = matrixOf(j.job);
    if (m.dynamic) { dynamic = true; continue; }
    total += m.legs;
    widest = Math.max(widest, m.legs);
    mins += m.legs * minutes(j.job);
  }
  if (dynamic && declared !== null) { total += declared; widest = Math.max(widest, declared); }
  return { total, widest, mins, dynamicUndeclared: dynamic && declared === null, declared };
}

export function cost({ wfs, cfg }) {
  const q = cfg?.queue ?? {};
  const maxLegs = q.max_matrix_legs ?? 20, reuseFrom = q.reuse_from_legs ?? 10;
  const out = [];
  for (const w of wfs.filter(hasMergeGroup)) {
    if (typeof (q.queue_full?.[base(w.file)] ?? q.queue_full?.[w.file]) === "string") continue; // a reason is on file
    const c = costOf(w, q);
    const saves = SAVES.test(w.text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")); // comments do not count
    const costly = c.dynamicUndeclared || c.total >= reuseFrom;
    if (costly && !saves) {
      out.push({ item: 4, file: w.file, line: lineOf(w.text, /^jobs\s*:/), message: `${base(w.file)} runs ${c.dynamicUndeclared ? "a matrix built at run time" : `${c.total} legs`} on every queue entry${c.mins && !c.dynamicUndeclared ? ` (up to ${c.mins} runner-minutes by timeout-minutes)` : ""} and neither reuses the pull request's passing run nor path-filters its legs`, fix: `reuse the PR's run, path-filter the legs, or write a reason under queue.queue_full["${base(w.file)}"] in docs/gel.json` });
    }
    if (c.widest > maxLegs) {
      out.push({ item: 5, file: w.file, line: lineOf(w.text, /^jobs\s*:/), message: `${base(w.file)} has a matrix of ${c.widest} legs on merge_group, over the budget of ${maxLegs}; every queue entry pays it and a flaky leg dequeues everything behind it`, fix: "cut the matrix on merge_group (a canary leg, path filter) or justify it under queue.queue_full" });
    }
  }
  return out;
}

// ---- item 7: queue-main-duplicates ----------------------------------------------------------------------------------

export function duplicates({ wfs, cfg }) {
  const q = cfg?.queue ?? {};
  const branches = new Set(["main", "master", ...(q.default_branch ? [q.default_branch] : [])]);
  const out = [];
  for (const w of wfs.filter(hasMergeGroup)) {
    const p = w.on.push;
    if (!p || typeof (q.main_duplicates?.[base(w.file)] ?? q.main_duplicates?.[w.file]) === "string") continue;
    const list = (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.map(String) : []);
    // `push:` with no filter runs on every branch; tags-only runs on no branch
    const onBranch = list(p.branches).length ? list(p.branches).some((b) => branches.has(b) || b === "**" || b === "*") : !list(p.tags).length;
    const ignored = list(p["branches-ignore"]).some((b) => branches.has(b));
    if (!onBranch || ignored || !w.jobs.some((j) => runsOnEvent(j.job, "push"))) continue;
    out.push({ item: 7, file: w.file, line: lineOf(w.text, /^\s+push\s*:/), message: `${base(w.file)} runs on merge_group and again on push to the default branch, so the commit the queue just tested is tested a second time`, fix: `drop the push trigger, or write a reason under queue.main_duplicates["${base(w.file)}"] in docs/gel.json` });
  }
  return out;
}

// ---- items 8, 9, 11: installed safeguards (scorecard only) ----------------------------------------------------------

const STALL = /stalled?[-_ ]?(?:merge[-_ ])?queue|unstall|queue[-_ ]stall/i;
const DEAD = /(?:cancel|kill)[-_ ]?(?:the )?dead[-_ ]?(?:queue|batch)|dead[-_ ](?:queue|batch)[-_ ]?(?:runs?)?[-_ ]?cancel|cancel[-_ ]dead/i;
const present = (wfs, re) => wfs.find((w) => re.test(w.file) || (typeof w.doc.name === "string" && re.test(w.doc.name)) || w.jobs.some((j) => typeof j.job.uses === "string" && re.test(j.job.uses)));

export function safeguards({ wfs, cfg }) {
  const out = [];
  if (!present(wfs, STALL)) out.push({ item: 8, file: ".github/workflows", line: 1, message: "no stalled-queue detector: nothing wakes a merge queue that holds entries with no batch building them", fix: "call the shared stalled-queue workflow from flisk-sh/.github (the pattern of flisk#5114) from a schedule, merge_group and pull_request: [dequeued] workflow" });
  if (!present(wfs, DEAD)) out.push({ item: 9, file: ".github/workflows", line: 1, message: "no dead-batch canceller: runs of merge-queue batches that GitHub already deleted keep their runners", fix: "add a workflow that cancels runs on gh-readonly-queue branches that no longer exist (the pattern of flisk#3014)" });
  const flaky = (cfg?.queue?.flaky_steps ?? []).map(String);
  const RETRY = /\bretry\b|\battempts?\b|nick-fields\/retry|wretry|--retries|--retry\b/i;
  for (const w of wfs.filter(hasMergeGroup)) {
    for (const j of w.jobs.filter((x) => runsOnEvent(x.job, "merge_group"))) {
      for (const s of stepsOf(j)) {
        const hay = `${s.name ?? ""}\n${s.run ?? ""}\n${s.uses ?? ""}`;
        const hit = flaky.find((f) => hay.toLowerCase().includes(f.toLowerCase()));
        if (hit && !RETRY.test(hay)) out.push({ item: 11, file: w.file, line: lineOf(w.text, new RegExp(esc((typeof s.name === "string" ? s.name : String(s.run ?? s.uses).split("\n")[0]).slice(0, 60)))), message: `step ${typeof s.name === "string" ? `"${s.name}" ` : ""}of "${j.id}" matches the known-flaky "${hit}" and has no retry; a red queue entry dequeues everything behind it`, fix: "wrap the step in a retry (nick-fields/retry, or a loop in the script)" });
      }
    }
  }
  return out;
}

// ---- item 12: queue-required-satisfiable (online: needs a snapshot of the ruleset) ----------------------------------

export const rulesOf = (queue) => {
  const sets = queue?.rulesets ?? (queue?.ruleset ? [queue.ruleset] : []);
  return sets.filter((r) => !r.enforcement || r.enforcement === "active").flatMap((r) => (Array.isArray(r.rules) ? r.rules : []));
};
// rule types that need an uploader outside the repo's checks: with none, every queued PR ends in branch_protection_failure
const UPLOADER_RULES = new Set(["code_coverage", "code_quality"]);
const UPLOADER = /codecov|coveralls|qlty|sonarcloud|sonarqube|upload[-_]?coverage|code[-_]?quality|code[-_]?coverage/i;

export function satisfiable({ wfs, queue }) {
  const rules = rulesOf(queue);
  const out = [];
  const reported = queue?.reported ?? {};
  for (const r of rules) {
    const add = (message, fix) => out.push({ item: 12, file: "ruleset", line: 1, message, fix });
    if (r.type === "required_status_checks" && Array.isArray(reported.checks)) {
      for (const c of r.parameters?.required_status_checks ?? []) {
        if (!reported.checks.includes(c.context)) add(`required check "${c.context}" never reported on a merge_group or default-branch commit, so a queued PR waits for it forever`, "remove the check from the ruleset, or make a workflow report it on merge_group");
      }
    } else if (r.type === "code_scanning" && Array.isArray(reported.codeScanningTools)) {
      for (const t of r.parameters?.code_scanning_tools ?? []) {
        if (!reported.codeScanningTools.includes(t.tool)) add(`code scanning tool "${t.tool}" has never uploaded results for a merge_group or default-branch commit`, "run the tool on merge_group and the default branch, or drop it from the rule");
      }
    } else if (UPLOADER_RULES.has(r.type)) {
      const uploader = (reported.uploaders ?? []).includes(r.type) || wfs.some((w) => UPLOADER.test(w.text));
      if (!uploader) add(`ruleset rule "${r.type}" needs an uploader, and no workflow uploads one and none has reported, so every queued PR ends with branch_protection_failure while all checks are green`, `add the uploader, or remove the "${r.type}" rule from the ruleset`);
    }
  }
  return out;
}

// ---- the scorecard ---------------------------------------------------------------------------------------------------

export function scorecard({ files, read, cfg, queue }) {
  const wfs = loadWorkflows(files, read);
  // the ruleset names its required checks, so a read ruleset stands in for a `requiredChecks` list in docs/gel.json
  const fromRuleset = rulesOf(queue).filter((r) => r.type === "required_status_checks").flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));
  const declared = cfg?.queue?.requiredChecks ?? cfg?.requiredChecks;
  const required = Array.isArray(declared) && declared.length ? declared : fromRuleset;
  cfg = { ...cfg, queue: { ...cfg?.queue, requiredChecks: required } };
  const args = { wfs, cfg, queue };
  const found = [...parity(args), ...cost(args), ...duplicates(args), ...safeguards(args)];
  if (!required.length) {
    found.push({ item: 1, file: "docs/gel.json", line: 1, message: "no requiredChecks declared, so GEL cannot tell which checks a queue entry must report", fix: 'list the ruleset\'s required check names in docs/gel.json as "requiredChecks": [...]' });
  }
  const online = Boolean(queue && rulesOf(queue).length) || Boolean(queue?.rulesets || queue?.ruleset);
  if (online) found.push(...satisfiable(args));
  const items = ITEMS.map((it) => {
    if (it.n === 12 && !online) return { ...it, status: "skipped", findings: [] };
    const findings = found.filter((f) => f.item === it.n);
    return { ...it, status: findings.length ? "fail" : "pass", findings };
  });
  const checked = items.filter((i) => i.status !== "skipped");
  const score = checked.length ? Math.round((100 * checked.filter((i) => i.status === "pass").length) / checked.length) : 0;
  return { score, checked: checked.length, items, workflows: wfs.length, mergeGroupWorkflows: wfs.filter(hasMergeGroup).length };
}

export function scorecardMarkdown(card) {
  const lines = [`## GEL queue-ready: ${card.score}/100`, `${card.workflows} workflows read, ${card.mergeGroupWorkflows} run on merge_group, ${card.checked} of 12 items checked.`, ""];
  for (const i of card.items) {
    lines.push(`${i.status === "pass" ? "PASS" : i.status === "fail" ? "FAIL" : "SKIP"}  ${String(i.n).padStart(2)}. ${i.name}`);
    if (i.status === "skipped") lines.push("      not checked: pass --repo owner/name (or --snapshot queue.json) to read the ruleset");
    for (const f of i.findings.slice(0, 8)) lines.push(`      ${f.file}:${f.line} ${f.message}`, `      fix: ${f.fix}`);
    if (i.findings.length > 8) lines.push(`      ... and ${i.findings.length - 8} more`);
  }
  return lines.join("\n");
}
