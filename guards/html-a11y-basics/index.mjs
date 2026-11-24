export const name = "html-a11y-basics";
// Accessibility basics on HTML pages (landing pages, worker templates, static docs):
// Fails if a page has no <main> landmark (or role="main"), or no early skip-to-content
// link targeting #main or #content before other content links in <body>.
// Tune in docs/gel.json: "html_a11y": { "pages": [...] }
const PAGES = ["index.html", "public/index.html", "docs/index.html", "site/index.html"];

export function checkHtmlA11y(html, at) {
  // Strip comments, script, style
  const cleaned = html
    .replace(/<!--[\s\S]*?--!?>/gi, " ")
    .replace(/<script[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\b[^>]*>/gi, " ");

  // 1. Check <main> landmark or role="main"
  const hasMainTag = /<main\b[^>]*>/i.test(cleaned);
  const hasMainRole = /<[a-z0-9_-]+\b[^>]*\brole\s*=\s*["']?main\b["']?[^>]*>/i.test(cleaned);

  if (!hasMainTag && !hasMainRole) {
    at("no <main> landmark: wrap main page content in a <main> element or role=\"main\"");
  }

  // 2. Check skip-to-content link
  // Must be an early link in <body> targeting #main or #content
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned);
  const bodyContent = bodyMatch ? bodyMatch[1] : cleaned;

  // Extract all <a> tags with href
  const linkRegex = /<a\b([^>]*)>/gi;
  let hasSkipLink = false;
  let match;

  while ((match = linkRegex.exec(bodyContent)) !== null) {
    const attrs = match[1];
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (hrefMatch) {
      const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim();
      if (/^#(?:main|content)\b/i.test(href)) {
        hasSkipLink = true;
      }
      break;
    }
  }

  if (!hasSkipLink) {
    at("no skip-to-content link: add an early link in <body> targeting #main or #content");
  }
}

export function run({ root, files, cfg, read }) {
  const c = cfg?.html_a11y ?? {};
  const pages = (c.pages ?? PAGES).filter((p) => (files ?? []).includes(p));
  const findings = [];

  for (const f of pages) {
    const html = read ? read(f) : null;
    if (html == null) continue;
    checkHtmlA11y(html, (message) => {
      findings.push({ file: f, line: 1, message: `html-a11y-basics: ${message}` });
    });
  }

  return { pass: findings.length === 0, findings };
}
