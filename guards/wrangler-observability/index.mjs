export const name = "wrangler-observability";

// Fails when wrangler.toml, wrangler.json, or wrangler.jsonc exists and observability.enabled is not true.
// Offline, reads the config only. Skip repos with no wrangler file.

const WRANGLER_FILE = /(?:^|\/)wrangler\.(?:toml|jsonc?)$/;

function stripJsonComments(text) {
  // Remove multi-line /* ... */ comments and single-line // comments (not inside strings)
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\])\/\/.*$/gm, "$1");
}

function checkWranglerConfig(content, filename) {
  if (filename.endsWith(".toml")) {
    const lines = content.split("\n");
    let inObsBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/#.*$/, "").trim();
      if (!line) continue;
      if (/^\[([^\]]+)\]$/.test(line)) {
        inObsBlock = line === "[observability]";
        continue;
      }
      if (inObsBlock) {
        const m = line.match(/^enabled\s*=\s*(\w+)/);
        if (m) {
          return m[1] === "true";
        }
      }
    }
    // Also check dotted key: observability.enabled = true
    for (const l of lines) {
      const line = l.replace(/#.*$/, "").trim();
      const m = line.match(/^observability\.enabled\s*=\s*(\w+)/);
      if (m) {
        return m[1] === "true";
      }
    }
    return false;
  }

  // JSON or JSONC
  try {
    const cleaned = stripJsonComments(content);
    const parsed = JSON.parse(cleaned);
    return parsed?.observability?.enabled === true;
  } catch {
    return false;
  }
}

export function run({ files = [], read }) {
  const configs = files.filter((f) => WRANGLER_FILE.test(f));
  if (configs.length === 0) return { pass: true, findings: [] };

  const findings = [];
  for (const f of configs) {
    const text = read?.(f);
    if (text == null) continue;
    const ok = checkWranglerConfig(text, f);
    if (!ok) {
      findings.push({
        file: f,
        line: 0,
        message: `${f} has no observability.enabled = true: production Worker logs are not kept`,
      });
    }
  }

  return { pass: findings.length === 0, findings };
}
