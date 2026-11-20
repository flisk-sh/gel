// Direct unit test coverage for lib/glob.mjs
// Follow-up gaps noted in #24: lib/diff.mjs, lib/fs.mjs, and lib/config.mjs still lack dedicated unit tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, matchAny } from "../lib/glob.mjs";

test("* matches files within a single directory segment", () => {
  const re = globToRegExp("*.js");
  assert.equal(re.test("index.js"), true);
  assert.equal(re.test("main.js"), true);
  assert.equal(re.test(".hidden.js"), true);
  assert.equal(re.test("index.ts"), false);
  assert.equal(re.test("src/index.js"), false);
});

test("* matches wildcard within segment prefixes and suffixes", () => {
  const re = globToRegExp("src/file-*.mjs");
  assert.equal(re.test("src/file-a.mjs"), true);
  assert.equal(re.test("src/file-test.mjs"), true);
  assert.equal(re.test("src/file-.mjs"), true);
  assert.equal(re.test("src/file-a.js"), false);
  assert.equal(re.test("src/sub/file-a.mjs"), false);
});

test("** matches recursive directories when followed by /", () => {
  const re = globToRegExp("**/*.md");
  assert.equal(re.test("README.md"), true);
  assert.equal(re.test("docs/guide.md"), true);
  assert.equal(re.test("docs/api/v1/spec.md"), true);
  assert.equal(re.test("docs/guide.txt"), false);
});

test("** matches recursively at end of pattern", () => {
  const re = globToRegExp("src/**");
  assert.equal(re.test("src/index.js"), true);
  assert.equal(re.test("src/a/b/c/app.ts"), true);
  assert.equal(re.test("src/"), true);
  assert.equal(re.test("other/src/index.js"), false);
});

test("** alone matches any path", () => {
  const re = globToRegExp("**");
  assert.equal(re.test(""), true);
  assert.equal(re.test("README.md"), true);
  assert.equal(re.test("a/b/c/d.js"), true);
});

test("? matches exactly one character within a path segment", () => {
  const re = globToRegExp("file?.mjs");
  assert.equal(re.test("file1.mjs"), true);
  assert.equal(re.test("fileA.mjs"), true);
  assert.equal(re.test("file_.mjs"), true);
  assert.equal(re.test("file.mjs"), false);
  assert.equal(re.test("file12.mjs"), false);
});

test("? does not cross path separator", () => {
  const re = globToRegExp("a?b");
  assert.equal(re.test("axb"), true);
  assert.equal(re.test("a-b"), true);
  assert.equal(re.test("a/b"), false);
});

test("dotfiles are matched by wildcards and explicit dot patterns", () => {
  assert.equal(globToRegExp("*.json").test(".eslintrc.json"), true);
  assert.equal(globToRegExp(".*").test(".gitignore"), true);
  assert.equal(globToRegExp(".*").test("file"), false);
  assert.equal(globToRegExp("**/.env").test(".env"), true);
  assert.equal(globToRegExp("**/.env").test("config/.env"), true);
  assert.equal(globToRegExp(".github/**").test(".github/workflows/ci.yml"), true);
});

test("negation is not supported and exclamation mark is matched literally", () => {
  const re = globToRegExp("!secret.txt");
  assert.equal(re.test("!secret.txt"), true);
  assert.equal(re.test("secret.txt"), false);
});

test("path separators (/ vs \\) and backslash escaping", () => {
  const slashRe = globToRegExp("foo/bar");
  assert.equal(slashRe.test("foo/bar"), true);
  assert.equal(slashRe.test("foo\\bar"), false);

  const backslashRe = globToRegExp("foo\\bar");
  assert.equal(backslashRe.test("foo\\bar"), true);
  assert.equal(backslashRe.test("foo/bar"), false);
});

test("exact matches and strict boundaries", () => {
  const re = globToRegExp("docs/gel.json");
  assert.equal(re.test("docs/gel.json"), true);
  assert.equal(re.test("docs/gel.jsonl"), false);
  assert.equal(re.test("a/docs/gel.json"), false);
  assert.equal(re.test("docs/gel.json/extra"), false);
});

test("regex special characters are escaped in glob patterns", () => {
  const re = globToRegExp("file.[a-z].{1}.(test)+$100.js");
  assert.equal(re.test("file.[a-z].{1}.(test)+$100.js"), true);
  assert.equal(re.test("file.a.1.test100.js"), false);
});

test("matchAny returns true when any glob pattern matches", () => {
  const globs = ["*.md", "src/**/*.ts", "config/*.json"];
  assert.equal(matchAny(globs, "README.md"), true);
  assert.equal(matchAny(globs, "src/components/button.ts"), true);
  assert.equal(matchAny(globs, "config/settings.json"), true);
});

test("matchAny returns false when no pattern matches or globs array is empty", () => {
  const globs = ["*.md", "src/**/*.ts"];
  assert.equal(matchAny(globs, "src/components/button.js"), false);
  assert.equal(matchAny(globs, "docs/architecture.png"), false);
  assert.equal(matchAny([], "README.md"), false);
});
