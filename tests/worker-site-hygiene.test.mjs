import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../guards/worker-site-hygiene/index.mjs";

test("worker-site-hygiene catches fonts, missing apple-touch-icon, and byte budget", () => {
  const html = [
    "<html><head>",
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A&family=B&family=C">',
    "</head><body>" + "x".repeat(200) + "</body></html>",
  ].join("");
  const res = run({
    cfg: { worker_site_hygiene: { max_fonts: 2, max_bytes: 150 } },
    files: ["index.html"],
    read: () => html,
  });
  assert.equal(res.pass, false);
  assert.equal(res.findings.length, 3);
});

test("worker-site-hygiene passes clean page and valid measurement", () => {
  const html = '<html><head><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head><body>ok</body></html>';
  const measurement = JSON.stringify({
    measuredAt: "2026-11-10T00:00:00Z",
    permissionsPolicy: "camera=()",
    httpsRedirect: true,
    robotsCacheControl: "public, max-age=3600",
    securityTxt: true,
    llmsTxt: true,
    notFoundBytes: 1024,
  });
  const res = run({
    cfg: {},
    files: ["index.html", "bench/site-hygiene.json"],
    read: (p) => (p === "index.html" ? html : measurement),
    ctx: { now: "2026-11-17T00:00:00Z" },
  });
  assert.equal(res.pass, true);
  assert.deepEqual(res.findings, []);
});
