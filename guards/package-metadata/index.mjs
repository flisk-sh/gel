// No node imports here: this file also runs in a browser. `read(file)` returns file text or null.
export const name = "package-metadata";

// Detect canonical SPDX license identifier from LICENSE / LICENCE file content.
function detectSpdx(text) {
  if (!text || typeof text !== "string") return null;
  const first = (text.split("\n")[0] || "").trim();
  if (/^MIT(\s+License)?$/i.test(first) || /\bMIT\s+License\b/i.test(text)) return "MIT";
  if (/^Apache\s+License\s*,?\s*Version\s+2\.0/im.test(text) || /\bApache-2\.0\b/i.test(text)) return "Apache-2.0";
  if (/^BSD\s+3-Clause/im.test(text) || /\bBSD-3-Clause\b/i.test(text)) return "BSD-3-Clause";
  if (/^BSD\s+2-Clause/im.test(text) || /\bBSD-2-Clause\b/i.test(text)) return "BSD-2-Clause";
  if (/^ISC\s+License/im.test(text) || /\bISC\b/i.test(first)) return "ISC";
  if (/^Mozilla\s+Public\s+License\s*,?\s*v(ersion)?\s*2\.0/im.test(text) || /\bMPL-2\.0\b/i.test(text)) return "MPL-2.0";
  if (/GNU\s+AFFERO\s+GENERAL\s+PUBLIC\s+LICENSE\s+Version\s+3/im.test(text) || /\bAGPL-3\.0/i.test(text)) return "AGPL-3.0-only";
  if (/GNU\s+GENERAL\s+PUBLIC\s+LICENSE\s+Version\s+3/im.test(text) || /\bGPL-3\.0/i.test(text)) return "GPL-3.0-only";
  if (/The\s+Unlicense/im.test(text) || /\bUnlicense\b/i.test(text)) return "Unlicense";
  return null;
}

export function run({ files, read }) {
  const findings = [];
  const at = (file, message) => findings.push({ file, line: 1, message });

  // Locate candidate LICENSE files in root or docs
  const licenseFile = files.find((f) => /^(?:docs\/)?(?:licen[cs]e|copying|unlicense)(?:[.-][\w.-]+)?$/i.test(f));
  const licenseText = licenseFile ? read(licenseFile) : null;
  const spdxId = licenseText ? detectSpdx(licenseText) : null;

  const pkgFiles = files.filter((f) => /(^|\/)package\.json$/.test(f) && !/(^|\/)node_modules\//.test(f));

  for (const f of pkgFiles) {
    const text = read(f);
    if (text === null) continue;
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      at(f, "is not valid JSON");
      continue;
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) continue;

    const isPrivate = pkg.private === true;

    // 1. Check license (required for both public and private packages)
    if (pkg.license === undefined || pkg.license === null) {
      at(f, 'missing required "license" field (e.g. "MIT", "Apache-2.0")');
    } else if (typeof pkg.license !== "string" || !pkg.license.trim()) {
      at(f, 'missing required "license" field (e.g. "MIT", "Apache-2.0")');
    } else if (spdxId && pkg.license.trim() !== spdxId) {
      at(f, `license "${pkg.license.trim()}" does not match LICENSE file SPDX id "${spdxId}"`);
    }

    // 2. Check engines (required for both public and private packages)
    if (!pkg.engines || typeof pkg.engines !== "object" || Array.isArray(pkg.engines)) {
      at(f, 'missing required "engines" field (e.g. "engines": { "node": ">=20" })');
    } else if (!pkg.engines.node && Object.keys(pkg.engines).length === 0) {
      at(f, '"engines" field specifies no engines (expected "engines.node")');
    }

    // If private: true, skip repository and description
    if (isPrivate) continue;

    // 3. Check description (required for public packages)
    if (pkg.description === undefined || pkg.description === null) {
      at(f, 'missing required "description" field');
    } else if (typeof pkg.description !== "string" || !pkg.description.trim()) {
      at(f, '"description" field is empty');
    }

    // 4. Check repository (required for public packages)
    if (pkg.repository === undefined || pkg.repository === null) {
      at(f, 'missing required "repository" field (e.g. "https://github.com/org/repo" or { "type": "git", "url": "..." })');
    } else if (typeof pkg.repository === "string") {
      if (!pkg.repository.trim()) at(f, '"repository" field is empty');
    } else if (typeof pkg.repository === "object" && !Array.isArray(pkg.repository)) {
      if (!pkg.repository.url || typeof pkg.repository.url !== "string" || !pkg.repository.url.trim()) {
        at(f, '"repository.url" field is empty');
      }
    } else {
      at(f, 'invalid "repository" field format');
    }
  }

  return { pass: findings.length === 0, findings };
}
