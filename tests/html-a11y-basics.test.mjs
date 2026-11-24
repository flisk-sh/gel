import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkHtmlA11y, run } from "../guards/html-a11y-basics/index.mjs";

test("html-a11y-basics imports nothing from node", () => {
  const src = readFileSync(new URL("../guards/html-a11y-basics/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bfrom\s+["']node:/);
  assert.doesNotMatch(src, /\brequire\(/);
});

test("checkHtmlA11y reports missing <main> and missing skip link", () => {
  const findings = [];
  checkHtmlA11y("<html><body><div><h1>Hi</h1></div></body></html>", (m) => findings.push(m));
  assert.equal(findings.length, 2);
  assert.match(findings[0], /no <main> landmark/);
  assert.match(findings[1], /no skip-to-content link/);
});

test("checkHtmlA11y passes valid HTML with main and #main skip link", () => {
  const findings = [];
  const html = `<!DOCTYPE html><html><body><a href="#main">Skip to content</a><main id="main"><h1>Hi</h1></main></body></html>`;
  checkHtmlA11y(html, (m) => findings.push(m));
  assert.equal(findings.length, 0);
});

test("checkHtmlA11y passes valid HTML with role=main and #content skip link", () => {
  const findings = [];
  const html = `<!DOCTYPE html><html><body><a href="#content">Skip</a><div role="main" id="content"><h1>Hi</h1></div></body></html>`;
  checkHtmlA11y(html, (m) => findings.push(m));
  assert.equal(findings.length, 0);
});

test("checkHtmlA11y fails when skip link is preceded by nav link", () => {
  const findings = [];
  const html = `<!DOCTYPE html><html><body><nav><a href="/">Home</a></nav><a href="#main">Skip</a><main id="main"><h1>Hi</h1></main></body></html>`;
  checkHtmlA11y(html, (m) => findings.push(m));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /no skip-to-content link/);
});

test("run checks configured pages in worker templates", () => {
  const files = ["src/worker.ts"];
  const res = run({
    files,
    cfg: { html_a11y: { pages: ["src/worker.ts"] } },
    read: (f) => f === "src/worker.ts" ? "export const t = `<body><a href=\"#main\">Skip</a><main>1</main></body>`;" : null
  });
  assert.equal(res.pass, true);
  assert.equal(res.findings.length, 0);
});
