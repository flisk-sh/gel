// `gel click-map`: read a site's click numbers for one page on one kind of device and keep what the click-map guard
// judges: how many clicks, how many of them hit nothing, and the ten most pressed things. The site answers with
// {"page", "dev", "since", "clicks", "dead", "targets": [{"target", "kind": "ctl" | "dead", "n"}]} (Grow's /api/clicks,
// and Flisk Analytics' /api/clicks?site=... for every other Flisk site).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fin = (x) => typeof x === "number" && Number.isFinite(x);
// The names come from another server and end up in a terminal, a committed file and a pull request comment:
// one line, no control characters, a short length. Every character is copied from a fixed list of printable ones
// (ASCII, Latin, Greek, Cyrillic), so nothing the server sends reaches the output unchecked; anything else is a space.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i)).join("");
const PRINTABLE = range(0x20, 0x7e) + range(0xa0, 0x24f) + range(0x370, 0x3ff) + range(0x400, 0x4ff);
const text = (v, max) => {
  let out = "";
  for (const ch of String(v ?? "")) { const i = PRINTABLE.indexOf(ch); out += i >= 0 ? PRINTABLE[i] : " "; }
  return out.trim().slice(0, max);
};

// Pure: one answer of the site -> one entry of docs/click-map.json. Throws when the answer is not a click map.
export function toEntry(j, source, now = Date.now()) {
  if (j == null || typeof j !== "object" || !fin(j.clicks) || !Array.isArray(j.targets)) throw new Error(`${source} did not answer with a click map ({"clicks", "dead", "targets"})`);
  let days = null;
  try { const d = Number(new URL(source).searchParams.get("days")); if (d > 0) days = d; } catch {}
  const since = Date.parse(j.since);
  if (days == null && !Number.isNaN(since)) days = Math.floor((now - since) / 86400000) + 1;
  const targets = j.targets.filter((t) => t && fin(t.n)).map((t) => ({ target: text(t.target, 60), kind: t.kind === "dead" ? "dead" : "ctl", n: Number(t.n) })).sort((a, b) => b.n - a.n).slice(0, 10);
  return { page: text(j.page, 40) || "page", dev: text(j.dev, 20) || "all", days, clicks: Number(j.clicks), dead: fin(j.dead) ? Number(j.dead) : 0, targets, source };
}

// A site whose click map is private (Flisk Analytics: analytics.flisk.si/api/clicks?site=...) needs a key:
// GEL_CLICKS_TOKEN is sent as "Authorization: Bearer <key>". It comes from the environment only, never a flag,
// so it stays out of shell history and CI logs, and it is sent over https (or to this computer) only.
export function authHeaders(url, token) {
  if (!token) return {};
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !local) throw new Error(`${url} is not https: GEL_CLICKS_TOKEN is not sent over plain http`);
  return { authorization: `Bearer ${token}` };
}

export async function measure({ url, file, token = process.env.GEL_CLICKS_TOKEN, fetchImpl = fetch }) {
  if (url) {
    const res = await fetchImpl(url, { headers: { accept: "application/json", ...authHeaders(url, token) } });
    if (res.status === 401 || res.status === 403) throw new Error(`${url} answered ${res.status}: ${token ? "GEL_CLICKS_TOKEN was refused" : "set GEL_CLICKS_TOKEN to a key for this site"}`);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    let j; try { j = await res.json(); } catch { throw new Error(`${url} did not answer with JSON`); }
    return toEntry(j, url);
  }
  let j; try { j = JSON.parse(readFileSync(resolve(file), "utf8")); } catch { throw new Error(`${file} is not a JSON file`); }
  return toEntry(j, file);
}
