// A small YAML reader for API specs: block maps and lists, plain, quoted and block (| >) scalars, multi-line
// plain scalars and flow [..] {..} values. No anchors, aliases, tags or multi-document files: it throws on
// those, and the caller then skips the file, so an odd spec never turns into a false finding.
// No node imports: this also runs in a browser.
export function parseYaml(text) {
  const raw = text.replace(/\r/g, "").split("\n");
  if (raw.some((l) => /^%/.test(l))) throw new Error("yaml directives");
  let i = 0;
  const skip = () => { while (i < raw.length && (/^\s*(#.*)?$/.test(raw[i]) || /^(---|\.\.\.)\s*$/.test(raw[i]))) i++; };
  const ind = (l) => l.match(/^ */)[0].length;
  const body = (l) => stripComment(l.trim());
  const isItem = (t) => t === "-" || t.startsWith("- ");

  function node(minInd) {
    skip();
    if (i >= raw.length || ind(raw[i]) < minInd) return null;
    const n = ind(raw[i]);
    if (/^[\[{]/.test(raw[i].trim())) return value(body(raw[i++]), n - 1);
    return isItem(body(raw[i])) ? list(n) : map(n);
  }
  // the value after "key:" or "- " on a line at indent `n`
  function value(rest, n) {
    if (/^[|>][-+0-9]*$/.test(rest)) { // block scalar: its lines are text, whatever they hold
      const out = [];
      while (i < raw.length && (raw[i].trim() === "" || ind(raw[i]) > n)) out.push(raw[i++].trim());
      return out.join("\n").trim();
    }
    if (rest.startsWith("[") || rest.startsWith("{")) {
      let t = rest;
      while (!balanced(t) && i < raw.length) t += " " + body(raw[i++]);
      return flow(t);
    }
    if (rest !== "") { // a plain or quoted scalar may go on over more-indented lines
      let t = rest;
      if (/^["']/.test(t)) { // a quoted scalar ends at its closing quote, whatever its lines hold
        while (!closed(t) && i < raw.length) t += " " + raw[i++].trim();
        return scalar(t);
      }
      skip();
      // in YAML every more-indented line after "key: text" goes on with that text, even one that looks like a key
      while (i < raw.length && ind(raw[i]) > n) { t += " " + body(raw[i++]); skip(); }
      return scalar(t);
    }
    skip();
    if (i < raw.length && (ind(raw[i]) > n || (ind(raw[i]) === n && isItem(body(raw[i]))))) return node(ind(raw[i]));
    return null;
  }
  function map(n, first = null) {
    const out = {};
    let line = first;
    for (;;) {
      if (line === null) { skip(); if (i >= raw.length || ind(raw[i]) !== n || isItem(body(raw[i]))) break; line = body(raw[i++]); }
      const m = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^"'].*?|\?)\s*:(?:\s+(.*))?$/);
      if (!m || m[1] === "?") throw new Error(`cannot read line: ${line.slice(0, 60)}`);
      out[unquote(m[1])] = value((m[2] ?? "").trim(), n);
      line = null;
    }
    return out;
  }
  function list(n) {
    const out = [];
    for (;;) {
      skip();
      if (i >= raw.length || ind(raw[i]) !== n || !isItem(body(raw[i]))) break;
      const rest = body(raw[i++]).slice(1).trim();
      if (/^("(?:[^"\\]|\\.)*"|'[^']*'|[^"'\[{\s].*?)\s*:(\s|$)/.test(rest)) out.push(map(n + 2, rest)); // "- key: v" opens a map
      else out.push(value(rest, n));
    }
    return out;
  }
  const result = node(0);
  skip();
  if (i < raw.length) throw new Error(`unread line ${i + 1}`);
  return result;
}

function stripComment(s) {
  let q = null;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (q) { if (ch === "\\" && q === '"') k++; else if (ch === q) q = null; continue; }
    if ((ch === '"' || ch === "'") && (k === 0 || /[\s:\[{,-]/.test(s[k - 1]))) q = ch;
    else if (ch === "#" && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
  }
  return s;
}
function closed(t) {
  const q = t[0];
  for (let k = 1; k < t.length; k++) {
    if (q === '"' && t[k] === "\\") { k++; continue; }
    if (t[k] === q) { if (q === "'" && t[k + 1] === "'") { k++; continue; } return true; }
  }
  return false;
}
function balanced(t) {
  let d = 0, q = null;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (q) { if (ch === "\\" && q === '"') k++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === "[" || ch === "{") d++;
    else if (ch === "]" || ch === "}") d--;
  }
  return d <= 0;
}
function unquote(s) {
  s = s.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (/^'[^']*(?:''[^']*)*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
function scalar(s) {
  s = s.trim();
  if (/^[&*!]/.test(s)) throw new Error("anchors, aliases and tags are not read");
  if (s.startsWith("[") || s.startsWith("{")) return flow(s);
  const v = unquote(s);
  if (v !== s) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
// flow values, nested and quoted: [a, {b: c}], {a: [1, 2]}
function flow(s) {
  let k = 0;
  const ws = () => { while (k < s.length && /\s/.test(s[k])) k++; };
  function val() {
    ws();
    if (s[k] === "[") { k++; const out = []; ws(); if (s[k] === "]") { k++; return out; } for (;;) { out.push(val()); ws(); if (s[k] === ",") { k++; ws(); if (s[k] === "]") { k++; return out; } continue; } if (s[k] === "]") { k++; return out; } throw new Error("bad flow list"); } }
    if (s[k] === "{") { k++; const out = {}; ws(); if (s[k] === "}") { k++; return out; } for (;;) { const key = atom(true); ws(); if (s[k] !== ":") throw new Error("bad flow map"); k++; out[key] = val(); ws(); if (s[k] === ",") { k++; ws(); if (s[k] === "}") { k++; return out; } continue; } if (s[k] === "}") { k++; return out; } throw new Error("bad flow map"); } }
    return scalar(String(atom(false)));
  }
  function atom(isKey) {
    ws();
    if (s[k] === '"' || s[k] === "'") {
      const q = s[k];
      let j = k + 1;
      while (j < s.length) {
        if ((q === '"' && s[j] === "\\") || (q === "'" && s[j] === q && s[j + 1] === q)) {
          j += 2;
        } else if (s[j] === q) {
          break;
        } else {
          j++;
        }
      }
      if (j >= s.length) throw new Error("unclosed flow quote");
      const t = s.slice(k, j + 1);
      k = j + 1;
      return isKey ? unquote(t) : t;
    }
    let j = k;
    while (j < s.length && !(isKey ? /[:,}\]]/ : /[,}\]]/).test(s[j])) j++;
    const t = s.slice(k, j).trim(); k = j; return t;
  }
  const out = val();
  ws();
  if (k < s.length) throw new Error("trailing flow text");
  return out;
}
