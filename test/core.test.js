'use strict';
// Pure parts: error parsing, boards, shape lines, SVG edits, imports, the file map, PNG reading, the PDF writer, and
// the TextMate grammar (tokenized with vscode-textmate when a sibling product has it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const U = require('../src/core/d2util');
const { collectFiles, readImage, fileThemes } = require('../src/core/files');
const { decodePng, toRgb, encodePng, pngSize, crc32 } = require('../src/core/png');
const { makePdf, pdfInfo, pdfString } = require('../src/core/pdf');

const ROOT = path.join(__dirname, '..');
const TMP = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-core-')); TMP.push(d); return d; };
test.after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); });

test('parseErrors: the engine JSON list becomes 0-based ranges with the message alone', () => {
  const e = U.parseErrors({ message: '[{"range":"a.d2,2:0:29-2:4:33","errmsg":"a.d2:3:1: connection missing destination"},{"range":"lib/x.d2,0:3:3-0:11:11","errmsg":"lib/x.d2:1:4: bad"}]' }, 'a.d2');
  assert.deepEqual(e[0], { file: 'a.d2', line: 2, col: 0, endLine: 2, endCol: 4, message: 'connection missing destination' });
  assert.equal(e[1].file, 'lib/x.d2');
  assert.equal(e[1].message, 'bad');
  assert.equal(U.errorText(e[0]), 'Line 3: connection missing destination');
  assert.equal(U.errorText(e[1], true), 'Lib/x.d2, line 1: bad');
});

test('parseErrors: plain text with file:line:col, plain text without, Go panics trimmed', () => {
  assert.deepEqual(U.parseErrors({ message: 'index:4:2: unexpected text' }, 'index')[0], { file: 'index', line: 3, col: 1, endLine: 3, endCol: 2, message: 'unexpected text' });
  const p = U.parseErrors({ message: 'render failed: Invalid color format\ngoroutine 8 [running]:\nstack...' }, 'a.d2')[0];
  assert.equal(p.line, -1);
  assert.equal(p.message, 'render failed: Invalid color format');
  assert.equal(U.parseErrors('', 'a.d2')[0].message, 'D2 error');
});

test('boardsOf: root first, then layers, scenarios and steps with their engine targets, folders marked', () => {
  const d = { name: '', shapes: [], layers: [{ name: 'deploy', steps: [{ name: '1' }, { name: '2' }] }], scenarios: [{ name: 'fail', isFolderOnly: true }], steps: [{ name: 'a.b' }] };
  const b = U.boardsOf(d);
  assert.deepEqual(b.map((x) => x.path), ['', 'layers.deploy', 'layers.deploy.steps.1', 'layers.deploy.steps.2', 'scenarios.fail', 'steps.a.b']);
  assert.equal(b[4].folder, true);
  assert.deepEqual(U.chainOf(b, 'steps.a.b'), [['steps', 'a.b']]);
  assert.equal(U.nodeAt(d, U.chainOf(b, 'layers.deploy.steps.2')).name, '2');
  assert.equal(U.nodeAt(d, [['layers', 'nope']]), null);
});

test('summarize: shapes get boxes and the first line where they are written; nested ids match graph objects', () => {
  const ref = (r, edge = -1) => ({ key: { range: r }, map_key_edge_index: edge });
  const diagram = { shapes: [{ id: 'a', pos: { x: 0, y: 0 }, width: 10, height: 10, label: 'A', zIndex: 0, level: 1 }, { id: 'c.d', pos: { x: 5, y: 5 }, width: 4, height: 4, label: 'd', level: 2 }], connections: [{}],
    layers: [{ name: 'x', shapes: [{ id: 'p', pos: { x: 1, y: 2 }, width: 3, height: 4, level: 1 }] }] };
  const graph = { objects: [{ id: 'a', references: [ref('f.d2,2:0:20-2:1:21', 0), ref('f.d2,0:0:0-0:1:1')] }, { id: 'd', references: [ref('other.d2,9:0:0-9:1:1'), ref('f.d2,3:2:30-3:3:31', 0)] }],
    layers: [{ name: 'x', objects: [{ id: 'p', references: [ref('f.d2,7:4:70-7:5:71', 0)] }] }] };
  const s = U.summarize(diagram, graph, '', 'f.d2');
  assert.deepEqual(s.shapes.map((x) => [x.id, x.line]), [['a', 0], ['c.d', 3]]);
  assert.equal(s.connections, 1);
  assert.equal(s.boards.length, 2);
  const l = U.summarize(diagram, graph, 'layers.x', 'f.d2');
  assert.deepEqual(l.shapes.map((x) => [x.id, x.line, x.x, x.h]), [['p', 7, 1, 4]]);
});

test('hitTest: the innermost shape under the point wins', () => {
  const shapes = [{ id: 'box', x: 0, y: 0, w: 100, h: 100, z: 1 }, { id: 'box.in', x: 10, y: 10, w: 20, h: 20, z: 2 }];
  assert.equal(U.hitTest(shapes, 15, 15).id, 'box.in');
  assert.equal(U.hitTest(shapes, 80, 80).id, 'box');
  assert.equal(U.hitTest(shapes, 120, 5), null);
});

test('svgBox, remote pictures removed, local pictures inlined', () => {
  const svg = '<?xml version="1.0"?><svg viewBox="0 0 316 752"><svg class="d2-1 d2-svg" width="316" height="752" viewBox="-91 -121 316 752"><image href="https://icons.example/x.svg" x="1" y="2" width="40" height="40" /><image href="./pic.png" x="0" y="0" /><image href="missing.png" x="0" /></svg></svg>';
  assert.deepEqual(U.svgBox(svg), { x: -91, y: -121, w: 316, h: 752 });
  const a = U.stripRemoteImages(svg);
  assert.equal(a.removed, 1);
  assert.ok(!a.svg.includes('icons.example'));
  const b = U.inlineLocalImages(a.svg, (p) => (p === './pic.png' ? { mime: 'image/png', base64: 'AAAA' } : null));
  assert.equal(b.inlined, 1); assert.equal(b.missing, 1);
  assert.ok(b.svg.includes('href="data:image/png;base64,AAAA"'));
});

test('importsOf, wantedLayout, withDirection, boardFileName, themes', () => {
  assert.deepEqual(U.importsOf('x: @lib/part\n...@base\ny: [@a; @"b c"]\n# z: @commented\nmail: me@example\n'), ['lib/part', 'base', 'a', 'b c']);
  assert.equal(U.wantedLayout('vars: { d2-config: { layout-engine: elk } }'), 'elk');
  assert.equal(U.wantedLayout('a -> b'), '');
  assert.equal(U.withDirection('a -> b', 'right'), 'a -> b\ndirection: right\n');
  assert.equal(U.withDirection('a -> b\n', 'sideways'), 'a -> b\n');
  assert.equal(U.boardFileName('/x/arch', 'layers.deploy.steps.1'), '/x/arch-layers-deploy-steps-1');
  assert.equal(U.boardFileName('/x/arch', ''), '/x/arch');
  assert.equal(U.themeName(200), 'Dark Mauve');
  assert.ok(U.isThemeId(303)); assert.ok(!U.isThemeId(2)); assert.ok(!U.isThemeId(null));
  assert.equal(U.THEMES.filter((t) => t.dark).length, 2);
  assert.deepEqual(fileThemes('vars: { d2-config: { theme-id: 4; dark-theme-id: 200 } }'), { light: true, dark: true });
  assert.deepEqual(fileThemes('vars: { d2-config: { dark-theme-id: 200 } }'), { light: false, dark: true });
});

test('collectFiles: imports from open editors and disk, nested folders, .d2 optional, outside the root left out', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sub', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'sub', 'lib', 'part.d2'), 'shape: cylinder\n...@../common\n');
  fs.writeFileSync(path.join(d, 'sub', 'common.d2'), 'label: Common');
  fs.writeFileSync(path.join(d, 'sub', 'open.d2'), 'on disk');
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'far.d2'), 'x');
  const main = path.join(d, 'sub', 'main.d2');
  const r = collectFiles({ file: main, text: `x: @lib/part\ny: @open.d2\nz: @${path.relative(path.join(d, 'sub'), path.join(outside, 'far'))}\nw: @missing`, root: d, read: (p) => (p.endsWith('open.d2') ? 'unsaved text' : null) });
  assert.equal(r.inputPath, 'sub/main.d2');
  assert.deepEqual(Object.keys(r.files).sort(), ['sub/common.d2', 'sub/lib/part.d2', 'sub/main.d2', 'sub/open.d2']);
  assert.equal(r.files['sub/open.d2'], 'unsaved text');
  assert.equal(r.keys['sub/lib/part.d2'], path.join(d, 'sub', 'lib', 'part.d2'));
});

test('readImage: inside the root only, known picture types only', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'p.png'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(d, 'p.txt'), 'x');
  assert.deepEqual(readImage('./p.png', path.join(d, 'a.d2'), d), { mime: 'image/png', base64: 'AQID' });
  assert.equal(readImage('./p.txt', path.join(d, 'a.d2'), d), null);
  assert.equal(readImage('../p.png', path.join(d, 'a.d2'), d), null);
  assert.equal(readImage('https://x/p.png', path.join(d, 'a.d2'), d), null);
});

function pngWithFilters(w, h, rgba) {
  // rows with filters 0..4 in turn, as a browser canvas may write them
  const bpp = 4, stride = w * bpp, raw = [];
  for (let y = 0; y < h; y++) {
    const f = y % 5; raw.push(f);
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x], a = x >= bpp ? rgba[y * stride + x - bpp] : 0, b = y ? rgba[(y - 1) * stride + x] : 0, c = x >= bpp && y ? rgba[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw.push((v - pred) & 255);
    }
  }
  const base = encodePng(w, h, rgba);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = base.subarray(8, 8 + 25);
  return Buffer.concat([base.subarray(0, 8), ihdr, chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG: decode every filter type, RGBA to RGB on white, size from the header, errors for other PNGs', () => {
  const w = 7, h = 6, px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = (i * 37) & 255; px[i * 4 + 1] = (i * 91) & 255; px[i * 4 + 2] = (i * 13) & 255; px[i * 4 + 3] = i % 3 ? 255 : 0; }
  const img = decodePng(pngWithFilters(w, h, px));
  assert.equal(img.width, 7); assert.equal(img.channels, 4);
  assert.ok(img.data.equals(px));
  const rgb = toRgb(img);
  assert.equal(rgb.length, w * h * 3);
  assert.deepEqual([...rgb.subarray(0, 3)], [255, 255, 255]);
  assert.deepEqual([...rgb.subarray(3, 6)], [37, 91, 13]);
  assert.deepEqual(pngSize(encodePng(w, h, px)), { width: 7, height: 6 });
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/);
});

test('PDF: one page per picture, page size in points, valid structure and offsets', () => {
  const page = (w, h) => ({ widthPt: w * 0.75, heightPt: h * 0.75, image: { width: w, height: h, rgb: Buffer.alloc(w * h * 3, 200) } });
  const pdf = makePdf([page(40, 20), page(10, 30)], { title: 'arch' });
  const info = pdfInfo(pdf);
  assert.equal(info.header, '%PDF-1.4');
  assert.equal(info.pages, 2); assert.equal(info.images, 2); assert.ok(info.eof);
  assert.deepEqual(info.boxes, [[30, 15], [7.5, 22.5]]);
  const s = pdf.toString('latin1');
  const xref = +/startxref\n(\d+)/.exec(s)[1];
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => +m[1]);
  offs.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.equal(pdfString('a(b)'), '(a\\(b\\))');
  assert.match(pdfString('Größe'), /^<feff/);
  assert.throws(() => makePdf([]), /no pages/);
});

const MODS = [process.env.D2_TM_MODULES, path.join(ROOT, '..', 'code-screenshot-vscode', 'node_modules')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'vscode-textmate')) && fs.existsSync(path.join(d, 'vscode-oniguruma')));
const grammarJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', 'd2.tmLanguage.json'), 'utf8'));

test('grammar file: scope and every include points to a rule', () => {
  assert.equal(grammarJson.scopeName, 'source.d2.zovo');
  const incs = JSON.stringify(grammarJson).match(/"include":\s*"#[^"]+"/g).map((s) => s.match(/#([^"]+)/)[1]);
  for (const i of new Set(incs)) assert.ok(grammarJson.repository[i], i);
});

test('grammar: comments, strings, block strings, arrows, keywords, shapes, imports (vscode-textmate)', { skip: !MODS && 'vscode-textmate not found' }, async () => {
  const tm = require(path.join(MODS, 'vscode-textmate'));
  const onig = require(path.join(MODS, 'vscode-oniguruma'));
  await onig.loadWASM(fs.readFileSync(path.join(MODS, 'vscode-oniguruma', 'release', 'onig.wasm')).buffer);
  const registry = new tm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) }),
    loadGrammar: async (scope) => (scope === 'source.d2.zovo' ? tm.parseRawGrammar(JSON.stringify(grammarJson), 'd2.json') : null),
  });
  const g = await registry.loadGrammar('source.d2.zovo');
  const text = fs.readFileSync(path.join(ROOT, 'samples', 'shop-architecture.d2'), 'utf8') + '\nx: @lib/part\n"""\nblock comment\n"""\na <-> b: "quoted"\n';
  let stack = tm.INITIAL;
  const toks = [];
  for (const line of text.split('\n')) {
    const r = g.tokenizeLine(line, stack);
    for (const t of r.tokens) toks.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes.join(' ') });
    stack = r.ruleStack;
  }
  const scopeOf = (s, i = 0) => (toks.filter((t) => t.text.trim() === s)[i] || {}).scopes || '';
  assert.match(toks[0].scopes, /comment\.line/);
  assert.match(scopeOf('->'), /keyword\.operator\.connection/);
  assert.match(scopeOf('<->'), /keyword\.operator\.connection/);
  assert.match(scopeOf('shape'), /keyword\.other\.reserved/);
  assert.match(scopeOf('cylinder'), /entity\.name\.type\.shape/);
  assert.match(scopeOf('Customer'), /string\.unquoted\.label/);
  assert.match(scopeOf('write order'), /string\.unquoted\.label/);
  assert.ok(!/label/.test(scopeOf('8')) && !/label/.test(scopeOf('true')) && !/label/.test(scopeOf('right')), 'numbers, booleans and directions are not labels');
  assert.ok(!/label/.test(scopeOf('md')), 'a block string is not a label');
  assert.match(scopeOf('border-radius'), /support\.type\.property-name/);
  assert.match(scopeOf('# Online shop: how an order flows'), /string\.unquoted\.block/);
  assert.match(scopeOf('md'), /entity\.name\.tag\.language/);
  assert.match(scopeOf('lib/part'), /string\.unquoted\.path/);
  assert.match(scopeOf('block comment'), /comment\.block/);
  assert.match(scopeOf('true'), /constant\.language/);
  assert.match(scopeOf('8'), /constant\.numeric/);
  // the line after a block string is normal code again
  const after = toks.find((t) => t.text.trim() === 'direction');
  assert.ok(after && !/string/.test(after.scopes), after && after.scopes);
});
