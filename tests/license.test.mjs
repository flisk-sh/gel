import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const license = readFileSync(new URL("LICENSE", root), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const readme = readFileSync(new URL("README.md", root), "utf8");

test("LICENSE is the MIT license and package metadata agrees", () => {
  assert.match(license, /^MIT License\b/m);
  assert.equal(pkg.license, "MIT");
});

test("README ends with a License section that links the file", () => {
  const section = readme.match(/## License\s*\n([\s\S]*)$/);
  assert.ok(section, "README has no final License section");
  assert.match(section[1], /MIT/);
  assert.match(section[1], /\[LICENSE\]\(LICENSE\)/);
});
