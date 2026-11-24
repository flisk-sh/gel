import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYaml } from "../lib/yaml-lite.mjs";

test("block maps, lists, quoted keys and scalars", () => {
  const y = `openapi: 3.0.3\npaths:\n  "/a/{id}":\n    get:\n      parameters:\n        - name: id\n          in: path\n          required: true\n        - $ref: '#/components/parameters/Limit'\n      responses:\n        "200": { description: ok }\n`;
  assert.deepEqual(parseYaml(y), { openapi: "3.0.3", paths: { "/a/{id}": { get: { parameters: [{ name: "id", in: "path", required: true }, { $ref: "#/components/parameters/Limit" }], responses: { 200: { description: "ok" } } } } } });
});

test("block scalars keep markdown, quoted scalars go over lines, plain text goes on", () => {
  const y = `a: |\n  * not an alias\n  key: not a key\nb: 'one: two\n  three'\nc: plain text\n  - still text\nd: [x, {y: "1, 2"}]\ne:\n  {\n    "k": [1, 2]\n  }\nf: /v2/x:clear # comment\n`;
  assert.deepEqual(parseYaml(y), { a: "* not an alias\nkey: not a key", b: "one: two three", c: "plain text - still text", d: ["x", { y: "1, 2" }], e: { k: [1, 2] }, f: "/v2/x:clear" });
});

test("keys with colons", () => {
  assert.deepEqual(parseYaml("/v2/actors/{id}/limits:clear:\n  post: {}\n"), { "/v2/actors/{id}/limits:clear": { post: {} } });
});

test("doubled apostrophes in flow mapping keys and sequence values", () => {
  const y = "labels: {'owner''s view': ['don''t know, yet', 'can''t say'], other: ['yes']}\n";
  assert.deepEqual(parseYaml(y), { labels: { "owner's view": ["don't know, yet", "can't say"], other: ["yes"] } });
});

test("anchors and aliases throw, so the guard skips the file", () => {
  assert.throws(() => parseYaml("a: &x\n  b: 1\nc: *x\n"));
});
