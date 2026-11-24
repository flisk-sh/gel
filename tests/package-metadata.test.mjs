import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function judge(files, cfg = {}) {
  const m = await import("../guards/package-metadata/index.mjs");
  return m.run({ files: Object.keys(files), cfg, read: (f) => files[f] ?? null });
}
const msgs = (r) => r.findings.map((f) => f.message).join("\n");

test("package-metadata imports nothing from node", () => {
  const src = readFileSync(new URL("../guards/package-metadata/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bfrom\s+["']node:/);
  assert.doesNotMatch(src, /\brequire\(/);
});

test("passes when there is no package.json", async () => {
  const r = await judge({ "README.md": "# test" });
  assert.equal(r.pass, true);
  assert.equal(r.findings.length, 0);
});

test("passes a valid public package with all required fields matching LICENSE", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    version: "1.0.0",
    license: "MIT",
    repository: "https://github.com/foo/bar",
    engines: { node: ">=18" }
  };
  const r = await judge({
    "package.json": JSON.stringify(pkg),
    LICENSE: "MIT License\n\nCopyright (c) 2026"
  });
  assert.equal(r.pass, true);
  assert.equal(r.findings.length, 0);
});

test("passes a valid public package with repository as object", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    version: "1.0.0",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/foo/bar.git" },
    engines: { node: ">=18" }
  };
  const r = await judge({
    "package.json": JSON.stringify(pkg),
    LICENSE: "MIT License\n\nCopyright (c) 2026"
  });
  assert.equal(r.pass, true);
  assert.equal(r.findings.length, 0);
});

test("skips repository and description requirements when private: true, but still checks license and engines", async () => {
  const privateValid = {
    name: "private-app",
    private: true,
    license: "MIT",
    engines: { node: ">=20" }
  };
  const r1 = await judge({
    "package.json": JSON.stringify(privateValid),
    LICENSE: "MIT License\n\nCopyright (c) 2026"
  });
  assert.equal(r1.pass, true);
  assert.equal(r1.findings.length, 0);

  const privateMissingLicense = {
    name: "private-app",
    private: true,
    engines: { node: ">=20" }
  };
  const r2 = await judge({ "package.json": JSON.stringify(privateMissingLicense) });
  assert.equal(r2.pass, false);
  assert.match(msgs(r2), /missing required "license" field/);

  const privateMissingEngines = {
    name: "private-app",
    private: true,
    license: "MIT"
  };
  const r3 = await judge({ "package.json": JSON.stringify(privateMissingEngines) });
  assert.equal(r3.pass, false);
  assert.match(msgs(r3), /missing required "engines" field/);
});

test("fails when public package.json is missing license", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    repository: "https://github.com/foo/bar",
    engines: { node: ">=18" }
  };
  const r = await judge({ "package.json": JSON.stringify(pkg) });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /missing required "license" field/);
});

test("fails when public package.json is missing description", async () => {
  const pkg = {
    name: "my-pkg",
    license: "MIT",
    repository: "https://github.com/foo/bar",
    engines: { node: ">=18" }
  };
  const r = await judge({ "package.json": JSON.stringify(pkg) });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /missing required "description" field/);
});

test("fails when public package.json has empty description", async () => {
  const pkg = {
    name: "my-pkg",
    license: "MIT",
    description: "   ",
    repository: "https://github.com/foo/bar",
    engines: { node: ">=18" }
  };
  const r = await judge({ "package.json": JSON.stringify(pkg) });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /"description" field is empty/);
});

test("fails when public package.json is missing repository", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    license: "MIT",
    engines: { node: ">=18" }
  };
  const r = await judge({ "package.json": JSON.stringify(pkg) });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /missing required "repository" field/);
});

test("fails when public package.json has empty repository string or object", async () => {
  const pkg1 = {
    name: "my-pkg",
    description: "A cool tool",
    license: "MIT",
    repository: "",
    engines: { node: ">=18" }
  };
  const r1 = await judge({ "package.json": JSON.stringify(pkg1) });
  assert.equal(r1.pass, false);
  assert.match(msgs(r1), /"repository" field is empty/);

  const pkg2 = {
    name: "my-pkg",
    description: "A cool tool",
    license: "MIT",
    repository: { url: "" },
    engines: { node: ">=18" }
  };
  const r2 = await judge({ "package.json": JSON.stringify(pkg2) });
  assert.equal(r2.pass, false);
  assert.match(msgs(r2), /"repository\.url" field is empty/);
});

test("fails when public package.json is missing engines", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    license: "MIT",
    repository: "https://github.com/foo/bar"
  };
  const r = await judge({ "package.json": JSON.stringify(pkg) });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /missing required "engines" field/);
});

test("fails when engines is empty object or missing node version", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    license: "MIT",
    repository: "https://github.com/foo/bar",
    engines: {}
  };
  const r = await judge({ "package.json": JSON.stringify(pkg) });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /"engines" field specifies no engines \(expected "engines\.node"\)/);
});

test("fails when package.json license does not match LICENSE file SPDX id", async () => {
  const pkg = {
    name: "my-pkg",
    description: "A cool tool",
    version: "1.0.0",
    license: "Apache-2.0",
    repository: "https://github.com/foo/bar",
    engines: { node: ">=18" }
  };
  const r = await judge({
    "package.json": JSON.stringify(pkg),
    LICENSE: "MIT License\n\nCopyright (c) 2026"
  });
  assert.equal(r.pass, false);
  assert.match(msgs(r), /license "Apache-2.0" does not match LICENSE file SPDX id "MIT"/);
});

test("checks monorepo / workspace package.json files and skips node_modules", async () => {
  const rootPkg = {
    name: "root",
    private: true,
    license: "MIT",
    engines: { node: ">=20" }
  };
  const subPkgBad = {
    name: "sub-pkg",
    version: "1.0.0"
  };
  const r = await judge({
    "package.json": JSON.stringify(rootPkg),
    "packages/a/package.json": JSON.stringify(subPkgBad),
    "node_modules/dep/package.json": JSON.stringify({ name: "dep" })
  });
  assert.equal(r.pass, false);
  assert.equal(r.findings.some((f) => f.file === "packages/a/package.json"), true);
  assert.equal(r.findings.some((f) => f.file.includes("node_modules")), false);
});

test("the guard is registered in lib/guards.mjs, templates/gel.json, docs/guards.md, README.md and scores.json", () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  assert.match(read("lib/guards.mjs"), /"package-metadata"/);
  assert.match(read("templates/gel.json"), /"package-metadata"/);
  assert.match(read("docs/guards.md"), /`package-metadata`/);
  assert.match(read("README.md"), /`package-metadata`/);
  assert.match(read("scores.json"), /"guard":\s*"package-metadata"/);
});
