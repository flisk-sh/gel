// No node imports here: this file also runs in a browser.
// Checks static HTML pages for web-hygiene basics (font family count, apple-touch-icon, byte budget)
// and optionally validates a committed site-hygiene measurement JSON (Permissions-Policy, HTTPS redirect,
// robots.txt Cache-Control, 404 page size, /.well-known/security.txt, /llms.txt).
export const name = "worker-site-hygiene";

const PAGES = ["index.html", "public/index.html", "docs/index.html", "site/index.html"];
const DEFAULT_RESULT = "bench/site-hygiene.json";

const countGoogleFontFamilies = (html) => {
  let count = 0;
  for (const m of html.matchAll(/https?:\/\/fonts\.googleapis\.com\/css2?\?([^"'\s>)]+)/gi)) {
    const qs = m[1].replace(/&amp;/gi, "&");
    const families = qs.match(/(?:^|&)family=[^&]+/gi) ?? [];
    for (const f of families) {
      const val = f.replace(/^&?family=/i, "");
      count += val.split("|").filter(Boolean).length;
    }
  }
  return count;
};

const hasAppleTouchIcon = (html) =>
  /<link\b[^>]*\brel\s*=\s*["'][^"']*\bapple-touch-icon\b[^"']*["'][^>]*>/i.test(html);

const byteLength = (text) => new TextEncoder().encode(text).length;

export function run({ cfg, files, read, ctx }) {
  if (cfg?.status === "archived") return { pass: true, findings: [] };
  const c = cfg?.worker_site_hygiene;
  const declared = c != null && typeof c === "object";
  const fileList = files ?? [];
  const pages = (Array.isArray(c?.pages) ? c.pages : PAGES).filter((p) => fileList.includes(p));
  const resultFile = typeof c?.result === "string" && c.result.trim() ? c.result.trim() : DEFAULT_RESULT;
  const hasResultFile = fileList.includes(resultFile);

  if (!declared && pages.length === 0 && !hasResultFile) {
    return { pass: true, findings: [] };
  }

  const findings = [];
  const maxFonts = typeof c?.max_fonts === "number" ? c.max_fonts : 2;
  const maxBytes = typeof c?.max_bytes === "number" ? c.max_bytes : 102400;
  const max404Bytes = typeof c?.max_404_bytes === "number" ? c.max_404_bytes : 32768;
  const requireIcon = c?.require_apple_touch_icon !== false;

  for (const p of pages) {
    const html = read?.(p);
    if (html == null) continue;
    const fonts = countGoogleFontFamilies(html);
    if (fonts > maxFonts) {
      findings.push({
        file: p,
        line: 0,
        message: `worker site hygiene: ${fonts} Google Font families exceed limit ${maxFonts}`,
      });
    }
    if (requireIcon && !hasAppleTouchIcon(html)) {
      findings.push({
        file: p,
        line: 0,
        message: "worker site hygiene: missing <link rel=\"apple-touch-icon\">",
      });
    }
    const bytes = byteLength(html);
    if (bytes > maxBytes) {
      findings.push({
        file: p,
        line: 0,
        message: `worker site hygiene: page size ${bytes} bytes exceeds budget ${maxBytes} bytes`,
      });
    }
  }

  if (declared && c?.result || hasResultFile) {
    const raw = hasResultFile ? read?.(resultFile) : null;
    const at = (message) => findings.push({ file: resultFile, line: 0, message: `worker site hygiene: ${message}` });
    if (raw == null) {
      at(`"${resultFile}" is missing: run site-hygiene measurement and commit it`);
      return { pass: false, findings };
    }
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      at(`${resultFile} is not valid JSON`);
      return { pass: false, findings };
    }
    const now = ctx?.now ? Date.parse(ctx.now) : Date.now();
    const when = Date.parse(r?.measuredAt);
    const maxAgeDays = typeof c?.max_age_days === "number" ? c.max_age_days : 30;
    if (Number.isNaN(when)) {
      at(`${resultFile} has no "measuredAt" date`);
    } else if (now - when > maxAgeDays * 86400000) {
      at(`measured ${Math.floor((now - when) / 86400000)} days ago (limit ${maxAgeDays})`);
    }

    const checks = r?.checks && typeof r.checks === "object" ? r.checks : r;
    if (!checks?.permissionsPolicy && !checks?.permissions_policy) {
      at("missing Permissions-Policy header");
    }
    if (!checks?.httpsRedirect && !checks?.https_redirect) {
      at("http does not redirect to https");
    }
    if (!checks?.robotsCacheControl && !checks?.robots_cache_control) {
      at("missing Cache-Control on /robots.txt");
    }
    if (!checks?.securityTxt && !checks?.security_txt) {
      at("missing /.well-known/security.txt");
    }
    if (!checks?.llmsTxt && !checks?.llms_txt) {
      at("missing /llms.txt");
    }
    const notFoundBytes = checks?.notFoundBytes ?? checks?.not_found_bytes;
    if (typeof notFoundBytes === "number" && notFoundBytes > max404Bytes) {
      at(`404 page size ${notFoundBytes} bytes exceeds budget ${max404Bytes} bytes`);
    }
  }

  return { pass: findings.length === 0, findings };
}
