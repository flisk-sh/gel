// Direct coverage for the tiny glob matcher every guard uses to choose files.
// Follow-up gaps noted in #24: lib/diff.mjs, lib/fs.mjs and lib/config.mjs still have no direct unit tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, matchAny } from "../lib/glob.mjs";

const cases = [
  ["* matches a name in one directory", "*.mjs", "index.mjs", true],
  ["* does not cross a path separator", "*.mjs", "lib/glob.mjs", false],
  ["* matches dotfiles", "*.mjs", ".env.mjs", true],
  ["* still needs the literal rest of the pattern", "*.test.mjs", "glob.test.mjs", true],
  ["? matches exactly one non-separator character", "file?.mjs", "file1.mjs", true],
  ["? does not match zero characters", "file?.mjs", "file.mjs", false],
  ["? does not match two characters", "file?.mjs", "file12.mjs", false],
  ["? does not cross a path separator", "src?glob.mjs", "src/glob.mjs", false],
  ["** crosses folders", "src/**/*.mjs", "src/lib/glob.mjs", true],
  ["**/ also matches zero folders", "src/**/*.mjs", "src/glob.mjs", true],
  ["a trailing ** matches any depth", "src/**", "src/a/b/c.mjs", true],
  ["** alone matches any path", "**", "a/b/c.txt", true],
  ["a dot in the glob is literal", "src/glob.mjs", "srcXglob.mjs", false],
  ["negation is not supported: ! is a literal prefix", "!secret.txt", "!secret.txt", true],
  ["negation does not exclude a file", "!secret.txt", "secret.txt", false],
  ["backslashes are literal characters, not separators", "lib\\glob.mjs", "lib\\glob.mjs", true],
];

for (const [name, glob, file, expected] of cases) {
  test(name, () => {
    assert.equal(globToRegExp(glob).test(file), expected, `${glob} vs ${file}`);
  });
}

test("matchAny accepts a file matching any one glob", () => {
  assert.equal(matchAny(["*.txt", "src/**/*.mjs"], "src/lib/glob.mjs"), true);
});

test("matchAny rejects a file matching none of the globs", () => {
  assert.equal(matchAny(["*.txt", "src/**/*.mjs"], "public/icon.png"), false);
});

test("matchAny with no globs matches nothing", () => {
  assert.equal(matchAny([], "index.mjs"), false);
});
