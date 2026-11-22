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
import { toEntry } from "../lib/click-map.mjs";

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

test("measure sends GEL_CLICKS_TOKEN as a Bearer key to a click map that answers only its owner", async () => {
  const { createServer } = await import("node:http");
  const { measure } = await import("../lib/click-map.mjs");
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== "Bearer fa_test") { res.writeHead(401).end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(QUIET));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/api/clicks?site=flisk.sh&page=/&dev=desktop&days=30`;
  try {
    await assert.rejects(measure({ url }), /answered 401: this click map needs a key: set GEL_CLICKS_TOKEN/);
    await assert.rejects(measure({ url, token: "fa_wrong" }), /answered 401: the key in GEL_CLICKS_TOKEN was refused/);
    const e = await measure({ url, token: "fa_test" });
    assert.deepEqual([e.clicks, e.dead, e.days], [100, 5, 30]);
    assert.doesNotMatch(JSON.stringify(e), /fa_test/); // the key never lands in docs/click-map.json
    assert.deepEqual(seen, [null, "Bearer fa_wrong", "Bearer fa_test"]);
  } finally { server.close(); }
});

test("the key is never sent over plain http, except to this computer", async () => {
  const { authHeaders, measure } = await import("../lib/click-map.mjs");
  assert.throws(() => authHeaders("http://analytics.example/api/clicks", "fa_test"), /not https: GEL_CLICKS_TOKEN is not sent over plain http/);
  assert.throws(() => authHeaders("ftp://analytics.example/api/clicks", "fa_test"), /not https/);
  await assert.rejects(measure({ url: "http://analytics.example/api/clicks?site=x", token: "fa_test" }), /not https/);
  assert.deepEqual(authHeaders("https://analytics.flisk.si/api/clicks", "k"), { authorization: "Bearer k" });
  for (const u of ["http://localhost:8787/x", "http://127.0.0.1/x", "http://[::1]/x", "http://app.localhost/x"]) assert.deepEqual(authHeaders(u, "k"), { authorization: "Bearer k" });
  assert.deepEqual(authHeaders("http://analytics.example/x", ""), {}); // no key, nothing to protect
});
