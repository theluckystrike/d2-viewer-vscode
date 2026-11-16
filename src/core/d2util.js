'use strict';
// Pure helpers around the D2 engine's results (no vscode, no engine): error parsing, the board tree (layers, scenarios,
// steps), shape boxes with their source line for click-to-line, the theme list, imports, and small SVG edits.

/** D2 themes the bundled engine draws. Names are D2's own theme names. */
const THEMES = [
  { id: 0, name: 'Neutral Default' }, { id: 1, name: 'Neutral Grey' }, { id: 3, name: 'Flagship' },
  { id: 4, name: 'Cool Classics' }, { id: 5, name: 'Mixed Berry Blue' }, { id: 6, name: 'Grape Soda' },
  { id: 7, name: 'Aubergine' }, { id: 8, name: 'Colorblind Clear' }, { id: 100, name: 'Vanilla Nitro Cola' },
  { id: 101, name: 'Orange Creamsicle' }, { id: 102, name: 'Shirley Temple' }, { id: 103, name: 'Earth Tones' },
  { id: 104, name: 'Everglade Green' }, { id: 105, name: 'Buttered Toast' }, { id: 300, name: 'Terminal' },
  { id: 301, name: 'Terminal Grayscale' }, { id: 302, name: 'Origami' }, { id: 303, name: 'C4' },
  { id: 200, name: 'Dark Mauve', dark: true }, { id: 201, name: 'Dark Flagship', dark: true },
];
const THEME_IDS = new Set(THEMES.map((t) => t.id));
const themeName = (id) => { const t = THEMES.find((x) => x.id === Number(id)); return t ? t.name : `Theme ${id}`; };
const isThemeId = (id) => (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) && THEME_IDS.has(Number(id));

const DIRECTIONS = ['down', 'right', 'left', 'up'];
const KINDS = ['layers', 'scenarios', 'steps'];

/** "index,2:0:29-2:4:33" -> { file, line, col, endLine, endCol } (0-based). */
function parseRange(r) {
  const m = /^(.*),(\d+):(\d+):\d+-(\d+):(\d+):\d+$/.exec(String(r || ''));
  if (!m) return null;
  return { file: m[1], line: +m[2], col: +m[3], endLine: +m[4], endCol: +m[5] };
}

/**
 * The engine's error -> [{ file, line, col, endLine, endCol, message }] (lines 0-based, line -1 when unknown).
 * Compile errors come as a JSON list of { range, errmsg }; others as text, sometimes with "file:line:col: ".
 */
function parseErrors(err, inputPath) {
  const raw = String((err && err.message) || err || '').trim();
  let list = null;
  if (raw.startsWith('[')) { try { list = JSON.parse(raw); } catch (e) { list = null; } }
  const strip = (msg, file) => String(msg || '').replace(new RegExp('^' + esc(file || '') + ':\\d+:\\d+:\\s*'), '').replace(/^[^\s:]+\.d2:\d+:\d+:\s*/, '').trim();
  if (Array.isArray(list)) {
    return list.map((x) => {
      const r = parseRange(x && x.range) || { file: inputPath || '', line: -1, col: 0, endLine: -1, endCol: 0 };
      const loc = /^(.*?):(\d+):(\d+):/.exec(String(x && x.errmsg || ''));
      if (r.line < 0 && loc) { r.file = loc[1]; r.line = +loc[2] - 1; r.col = +loc[3] - 1; r.endLine = r.line; r.endCol = r.col + 1; }
      return { ...r, message: strip(x && x.errmsg, r.file) || 'D2 error' };
    });
  }
  const loc = /([^\s:]+):(\d+):(\d+):\s*(.*)$/s.exec(raw);
  if (loc && /\.d2$|^index$/.test(loc[1])) return [{ file: loc[1], line: +loc[2] - 1, col: +loc[3] - 1, endLine: +loc[2] - 1, endCol: +loc[3], message: loc[4].trim() }];
  return [{ file: inputPath || '', line: -1, col: 0, endLine: -1, endCol: 0, message: raw.replace(/\n\s*goroutine[\s\S]*$/, '').slice(0, 600) || 'D2 error' }];
}
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** "Line 3: connection missing destination" (1-based), or the message alone. */
function errorText(e, withFile) {
  const where = e.line >= 0 ? `${withFile && e.file ? e.file + ', ' : ''}line ${e.line + 1}` : (withFile && e.file ? e.file : '');
  return where ? `${where[0].toUpperCase()}${where.slice(1)}: ${e.message}` : e.message;
}

/** Every board of a diagram, root first: [{ path, name, kind, depth, chain, folder }]. path is the engine's target. */
function boardsOf(diagram) {
  const out = [{ path: '', name: 'Root board', kind: 'root', depth: 0, chain: [], folder: !!(diagram && diagram.isFolderOnly) }];
  const walk = (d, chain, depth) => {
    for (const kind of KINDS) {
      for (const child of (d && d[kind]) || []) {
        if (!child) continue;
        const c = chain.concat([[kind, String(child.name)]]);
        out.push({ path: c.map(([k, n]) => `${k}.${n}`).join('.'), name: String(child.name), kind, depth: depth + 1, chain: c, folder: !!child.isFolderOnly });
        walk(child, c, depth + 1);
      }
    }
  };
  walk(diagram, [], 0);
  return out;
}

/** The board node (diagram or graph tree) for a chain [[kind, name], ...]. */
function nodeAt(tree, chain) {
  let n = tree;
  for (const [kind, name] of chain || []) {
    const next = ((n && n[kind]) || []).find((x) => x && String(x.name) === name);
    if (!next) return null;
    n = next;
  }
  return n;
}

/** The board chain of a target path, using the board list (names may contain dots). */
function chainOf(boards, p) {
  const b = (boards || []).find((x) => x.path === (p || ''));
  return b ? b.chain : null;
}

/** First line (0-based) in `file` where a graph object is written: a declaration first, else any reference. */
function lineOf(obj, file) {
  const refs = (obj && obj.references) || [];
  let any = null;
  for (const ref of refs) {
    const r = parseRange(ref && ref.key && ref.key.range);
    if (!r || (file && r.file !== file)) continue;
    if (ref.map_key_edge_index === -1 || ref.map_key_edge_index === undefined) return r.line;
    if (any === null) any = r.line;
  }
  return any;
}

/**
 * Shapes of one board with their box and source line, and the board list.
 * Diagram shapes and graph objects come in the same order; the graph object's id is the last part of the shape id.
 */
function summarize(diagram, graph, board, inputPath) {
  const boards = boardsOf(diagram);
  const chain = chainOf(boards, board) || [];
  const d = nodeAt(diagram, chain) || diagram;
  const g = nodeAt(graph, chain) || graph;
  const objs = ((g && g.objects) || []).filter(Boolean);
  const shapes = [];
  const used = new Set();
  ((d && d.shapes) || []).forEach((s, i) => {
    let o = objs[i];
    const last = String(s.id).split('.').pop();
    if (!o || String(o.id) !== last) { const k = objs.findIndex((x, j) => !used.has(j) && String(x.id) === last); o = k >= 0 ? objs[k] : null; if (k >= 0) used.add(k); } else used.add(i);
    const line = o ? lineOf(o, inputPath) : null;
    shapes.push({ id: String(s.id), x: s.pos.x, y: s.pos.y, w: s.width, h: s.height, z: (s.zIndex || 0) * 1000 + (s.level || 0), line: line === null ? -1 : line, label: String(s.label || '').slice(0, 80) });
  });
  return { boards: boards.map(({ path: p, name, kind, depth, folder }) => ({ path: p, name, kind, depth, folder })), shapes, connections: ((d && d.connections) || []).length };
}

/** The inner viewBox of a D2 SVG (diagram coordinates) and the outer size: { x, y, w, h } or null. */
function svgBox(svg) {
  const m = /<svg[^>]*class="[^"]*d2-svg[^"]*"[^>]*viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg) || /<svg[^>]*viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

/** Remote pictures (http, https) in a D2 SVG: the viewer is offline, so they are taken out. Returns { svg, removed }. */
function stripRemoteImages(svg) {
  let removed = 0;
  const out = svg.replace(/<image\b([^>]*?)\s(?:xlink:)?href="(https?:\/\/[^"]*)"([^>]*)\/?>(?:<\/image>)?/g, () => { removed++; return ''; });
  return { svg: out, removed };
}

/** Local pictures (relative paths) -> data: URIs through read(path) -> { mime, base64 } | null. Returns { svg, inlined, missing }. */
function inlineLocalImages(svg, read) {
  let inlined = 0, missing = 0;
  const out = svg.replace(/(<image\b[^>]*?\s(?:xlink:)?href=")([^"]+)(")/g, (all, a, href, b) => {
    if (/^(data:|https?:|#)/i.test(href)) return all;
    let p = href.replace(/&amp;/g, '&');
    try { p = decodeURIComponent(p); } catch (e) { /* keep */ }
    const r = read(p);
    if (!r) { missing++; return all; }
    inlined++;
    return `${a}data:${r.mime};base64,${r.base64}${b}`;
  });
  return { svg: out, inlined, missing };
}

/** Import paths in D2 text: `x: @file`, `...@file`, `@"quoted file"`. Without the .d2 suffix as written. */
function importsOf(text) {
  const out = new Set();
  const src = String(text || '').replace(/(^|\s)#.*$/gm, '$1');
  const re = /(^|[\s:[;]|\.\.\.)@(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_.~/\\-][^\s;{}[\]#,]*))/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[2] || m[3] || m[4]);
  return [...out];
}

/** A layout engine the file asks for that the bundled engine does not have ('elk' or 'tala'), or ''. */
function wantedLayout(text) {
  const m = /layout-engine\s*:\s*["']?(elk|tala)\b/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Appends a `direction:` line at the end of the text so the source lines keep their numbers. */
function withDirection(text, dir) {
  if (!dir || !DIRECTIONS.includes(dir)) return text;
  return `${text}${/\n$/.test(text) || !text ? '' : '\n'}direction: ${dir}\n`;
}

/** A file name for a board: "layers.x.steps.1" -> "layers-x-steps-1". */
function boardFileName(base, boardPath) {
  if (!boardPath) return base;
  return `${base}-${boardPath.replace(/[^\w.-]+/g, '_').replace(/\./g, '-')}`;
}

/** Topmost shape at diagram point (x, y), or null. */
function hitTest(shapes, x, y) {
  let best = null;
  for (const s of shapes || []) {
    if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) continue;
    if (!best || s.z > best.z || (s.z === best.z && s.w * s.h < best.w * best.h)) best = s;
  }
  return best;
}

module.exports = { THEMES, themeName, isThemeId, DIRECTIONS, parseRange, parseErrors, errorText, boardsOf, nodeAt, chainOf, lineOf, summarize, svgBox, stripRemoteImages, inlineLocalImages, importsOf, wantedLayout, withDirection, boardFileName, hitTest };
