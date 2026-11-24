import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../guards/wrangler-observability/index.mjs";

test("wrangler-observability has no node import", () => {
  const src = readFileSync(new URL("../guards/wrangler-observability/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bfrom\s+["']node:/);
  assert.doesNotMatch(src, /\brequire\(/);
});

const check = (files) => run({ files: Object.keys(files), read: (f) => files[f] ?? null });

test("no wrangler file passes", () => {
  const r = check({ "package.json": "{}", "src/index.ts": "export default {};" });
  assert.equal(r.pass, true);
  assert.equal(r.findings.length, 0);
});

test("wrangler.toml with observability.enabled = true passes", () => {
  const r = check({
    "wrangler.toml": 'name = "worker"\n[observability]\nenabled = true\n',
  });
  assert.equal(r.pass, true);
  assert.equal(r.findings.length, 0);
});

test("wrangler.toml with dotted observability.enabled = true passes", () => {
  const r = check({
    "wrangler.toml": 'name = "worker"\nobservability.enabled = true\n',
  });
  assert.equal(r.pass, true);
  assert.equal(r.findings.length, 0);
});

test("wrangler.toml with missing observability fails", () => {
  const r = check({
    "wrangler.toml": 'name = "worker"\nmain = "src/index.ts"\n',
  });
  assert.equal(r.pass, false);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /observability\.enabled = true/);
});

test("wrangler.toml with observability.enabled = false fails", () => {
  const r = check({
    "wrangler.toml": 'name = "worker"\n[observability]\nenabled = false\n',
  });
  assert.equal(r.pass, false);
  assert.equal(r.findings.length, 1);
});

test("wrangler.json with observability.enabled = true passes", () => {
  const r = check({
    "wrangler.json": JSON.stringify({ name: "worker", observability: { enabled: true } }),
  });
  assert.equal(r.pass, true);
});

test("wrangler.json with missing observability fails", () => {
  const r = check({
    "wrangler.json": JSON.stringify({ name: "worker" }),
  });
  assert.equal(r.pass, false);
  assert.equal(r.findings.length, 1);
});

test("wrangler.json with observability.enabled = false fails", () => {
  const r = check({
    "wrangler.json": JSON.stringify({ name: "worker", observability: { enabled: false } }),
  });
  assert.equal(r.pass, false);
  assert.equal(r.findings.length, 1);
});

test("wrangler.jsonc with comments and enabled = true passes", () => {
  const r = check({
    "wrangler.jsonc": '{\n  // Worker\n  "name": "worker",\n  "observability": {\n    "enabled": true\n  }\n}\n',
  });
  assert.equal(r.pass, true);
});

test("wrangler.jsonc with enabled = false fails", () => {
  const r = check({
    "wrangler.jsonc": '{\n  /* comment */\n  "name": "worker",\n  "observability": {\n    "enabled": false\n  }\n}\n',
  });
  assert.equal(r.pass, false);
});
