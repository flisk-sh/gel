// click-map: what visitors really press. Too many clicks on things that do nothing, or too few on the button the page
// exists for, is a finding; a page with few clicks is not. The guard only speaks to a repo that declared click_map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../lib/config.mjs";
import { loadGuard } from "../lib/guards.mjs";
import { judge, limits } from "../guards/click-map/index.mjs";
import { authHeaders, measure, toEntry } from "../lib/click-map.mjs";

const gel = join(import.meta.dirname, "..", "bin", "gel.mjs");
// the shape Grow's /api/clicks answers with
const ANSWER = { page: "home", dev: "desktop", since: "2026-10-24", clicks: 28, dead: 20, targets: [{ target: "span", kind: "dead", n: 18 }, { target: "The Grow Gazette", kind: "ctl", n: 7 }, { target: "li", kind: "dead", n: 1 }], cells: [{ x: 5, y: 100, n: 3 }] };
const QUIET = { ...ANSWER, page: "plan", clicks: 100, dead: 5, targets: [{ target: "Make my plan", kind: "ctl", n: 60 }] };

function repo(cfg, entries) {
  const d = mkdtempSync(join(tmpdir(), "clicks-"));
  mkdirSync(join(d, "docs"));
  if (cfg) writeFileSync(join(d, "docs", "gel.json"), JSON.stringify(cfg));
  if (entries) writeFileSync(join(d, "docs", "click-map.json"), JSON.stringify({ measuredAt: new Date().toISOString(), entries }));
  return d;
}
const gelRun = (args, cwd) => spawnSync(process.execPath, [gel, ...args], { encoding: "utf8", cwd });

test("the guard file has no node import, so it can run in a browser", () => {
  const src = readFileSync(new URL("../guards/click-map/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
});

test("quiet without docs/gel.json and for a repo that did not declare click_map", async () => {
  const guard = await loadGuard("click-map");
  for (const d of [repo(null), repo({ status: "active" })]) {
    assert.equal((await guard.run({ root: d, files: [], ctx: {}, cfg: loadConfig(d) })).pass, true);
  }
});

test("toEntry keeps the numbers and the ten most pressed things, drops the cells, and reads the days from the link", () => {
  const e = toEntry({ ...ANSWER, targets: Array.from({ length: 14 }, (_, i) => ({ target: `t${i}`, kind: i % 2 ? "dead" : "ctl", n: i })) }, "https://grow.example/api/clicks?page=home&dev=desktop&days=30");
  assert.deepEqual([e.page, e.dev, e.days, e.clicks, e.dead, e.targets.length, e.targets[0].n, "cells" in e], ["home", "desktop", 30, 28, 20, 10, 13, false]);
  assert.equal(toEntry(ANSWER, "saved.json", Date.parse("2026-11-22T12:00:00Z")).days, 30);
  assert.throws(() => toEntry({ error: "nope" }, "saved.json"), /did not answer with a click map/);
  // names from the site are kept to one short line: they are printed and committed
  const odd = toEntry({ page: "home\n::error::fake", dev: "desk\u001b[31mtop", clicks: 1, dead: 0, targets: [{ target: `Buy\r\nnow ${"x".repeat(200)}`, kind: "ctl", n: 1 }] }, "saved.json");
  assert.equal(odd.page, "home ::error::fake");
  assert.equal(odd.dev, "desk [31mtop");
  assert.doesNotMatch(odd.targets[0].target, /[\r\n]/);
  assert.equal(odd.targets[0].target.length, 60);
  assert.equal(toEntry({ page: "Načrt плану", clicks: 1, dead: 0, targets: [] }, "saved.json").page, "Načrt плану");
});

test("judge: the share of clicks that hit nothing, and the share on the main button", () => {
  const lim = limits({ click_map: { main: { home: "the grow gazette" }, min_main_share: 0.5 } });
  const v = judge(toEntry(ANSWER, "saved.json"), lim);
  assert.equal(v.judged, true);
  assert.equal(Math.round(v.deadShare * 100), 71);
  assert.equal(v.mainShare, 0.25);
  assert.match(v.problems[0], /20 of 28 clicks \(71%\) hit something that does nothing \(limit 30%\), most of them on "span" \(18\)/);
  assert.match(v.problems[1], /"the grow gazette" got 7 of 28 clicks \(25%, at least 50% expected\)/);
  assert.deepEqual(judge({ page: "home", dev: "mobile", clicks: 3, dead: 3, targets: [] }, limits({})).problems, []);
});

test("gel click-map writes the measurement, --merge keeps the other pages, exit 1 when a page has a problem", () => {
  const d = repo({ click_map: {} });
  writeFileSync(join(d, "home.json"), JSON.stringify(ANSWER));
  writeFileSync(join(d, "plan.json"), JSON.stringify(QUIET));
  const out = join(d, "docs", "click-map.json");
  const ok = gelRun(["click-map", "--file", join(d, "plan.json"), "--write", out, "--root", d], d);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /plan on desktop: 100 clicks in \d+ days, 5 hit nothing \(5%\), most pressed: "Make my plan" \(60\)/);
  const bad = gelRun(["click-map", "--file", join(d, "home.json"), "--merge", "--write", out, "--root", d, "--json"], d);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).problems.length, 1);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(doc.entries.map((e) => e.page), ["plan", "home"]);
  assert.ok(!Number.isNaN(Date.parse(doc.measuredAt)));
  // measuring the same page again replaces its entry
  gelRun(["click-map", "--file", join(d, "home.json"), "--merge", "--write", out, "--root", d], d);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).entries.length, 2);

  writeFileSync(join(d, "junk.json"), JSON.stringify({ error: "GET or POST" }));
  const junk = gelRun(["click-map", "--file", join(d, "junk.json")], d);
  assert.equal(junk.status, 1);
  assert.match(junk.stderr, /did not answer with a click map/);
  assert.equal(gelRun(["click-map"], d).status, 2);
});

test("in block mode gel run fails on a page full of dead clicks and passes on a quiet one, also on an unrelated pull request", () => {
  const cfg = { mode: "block", guards: { "click-map": "block" }, status: "active", owner: "t", click_map: {} };
  const badRepo = repo(cfg, [toEntry(ANSWER, "saved.json")]);
  const bad = gelRun(["run", "--root", badRepo]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /docs\/click-map\.json click map: home on desktop: 20 of 28 clicks/);

  const d = repo(cfg, [toEntry(QUIET, "saved.json")]);
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  git("checkout", "-q", "-b", "change");
  writeFileSync(join(d, "notes.txt"), "hi\n"); git("add", "-A"); git("commit", "-qm", "c");
  const res = gelRun(["run", "--root", d, "--base", base]);
  assert.match(res.stdout, /\| click-map \| block \| pass \|/, res.stdout);
});

// Flisk Analytics serves a private click map: it needs GEL_CLICKS_TOKEN, sent as a bearer key over https only.
const fakeFetch = (status, body = ANSWER) => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, headers: init.headers }); return new Response(JSON.stringify(body), { status }); };
  f.calls = calls;
  return f;
};
const PRIVATE = "https://analytics.flisk.si/api/clicks?site=flisk.sh&page=/&dev=desktop&days=30";

test("measure sends GEL_CLICKS_TOKEN as a bearer key, and nothing when it is not set", async () => {
  const f = fakeFetch(200);
  const e = await measure({ url: PRIVATE, token: "fa_abc", fetchImpl: f });
  assert.equal(e.clicks, 28);
  assert.equal(f.calls[0].headers.authorization, "Bearer fa_abc");
  const g = fakeFetch(200);
  await measure({ url: "https://grow.flisk.si/api/clicks?page=home&dev=desktop&days=30", token: "", fetchImpl: g });
  assert.equal(g.calls[0].headers.authorization, undefined);
});

test("measure explains a 401: no key, or a refused key", async () => {
  await assert.rejects(measure({ url: PRIVATE, token: "", fetchImpl: fakeFetch(401, { error: "sign in" }) }), /answered 401: set GEL_CLICKS_TOKEN/);
  await assert.rejects(measure({ url: PRIVATE, token: "fa_bad", fetchImpl: fakeFetch(401, { error: "sign in" }) }), /answered 401: GEL_CLICKS_TOKEN was refused/);
  await assert.rejects(measure({ url: PRIVATE, token: "fa_abc", fetchImpl: fakeFetch(404, { error: "site not found" }) }), /answered 404$/);
});

test("the key is never sent over plain http, except to this computer", async () => {
  assert.throws(() => authHeaders("http://analytics.example/api/clicks", "fa_abc"), /not https/);
  const f = fakeFetch(200);
  await assert.rejects(measure({ url: "http://analytics.example/api/clicks", token: "fa_abc", fetchImpl: f }), /not https/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(authHeaders("http://localhost:8787/api/clicks", "k"), { authorization: "Bearer k" });
  assert.deepEqual(authHeaders("http://app.localhost/api/clicks", "k"), { authorization: "Bearer k" });
  assert.deepEqual(authHeaders("http://analytics.example/api/clicks", ""), {});
});

test("gel click-map reads GEL_CLICKS_TOKEN from the environment, never prints it", () => {
  const d = repo({ click_map: {} });
  // a local server that only answers with the right key
  const srv = spawnSync(process.execPath, ["-e", `
    const http = require("node:http");
    const s = http.createServer((q, r) => { const ok = q.headers.authorization === "Bearer fa_secret"; r.writeHead(ok ? 200 : 401, { "content-type": "application/json" }); r.end(JSON.stringify(ok ? ${JSON.stringify(ANSWER)} : { error: "sign in" })); });
    s.listen(0, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + s.address().port + "/api/clicks?site=x.example&page=/&dev=desktop&days=30";
      const { spawn } = require("node:child_process");
      const run = (env) => new Promise((res) => { let out = ""; const c = spawn(process.execPath, [${JSON.stringify(gel)}, "click-map", "--url", url], { cwd: ${JSON.stringify(d)}, env: { ...process.env, ...env } }); c.stdout.on("data", (b) => out += b); c.stderr.on("data", (b) => out += b); c.on("close", (code) => res({ code, out })); });
      Promise.all([run({ GEL_CLICKS_TOKEN: "fa_secret" }), run({ GEL_CLICKS_TOKEN: "" })]).then((r) => { console.log(JSON.stringify(r)); s.close(); });
    });`], { encoding: "utf8" });
  const [withKey, without] = JSON.parse(srv.stdout);
  assert.match(withKey.out, /28 clicks/);
  assert.doesNotMatch(withKey.out, /fa_secret/);
  assert.equal(without.code, 1);
  assert.match(without.out, /answered 401: set GEL_CLICKS_TOKEN/);
});
