'use strict';
// The bundled D2 engine (lib/d2/d2.wasm in a worker thread), for real: render, boards, animated SVG, errors, themes,
// imports, the timeout restart, and the vendored files themselves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Engine } = require('../src/engine');
const U = require('../src/core/d2util');
const { collectFiles } = require('../src/core/files');

const ROOT = path.join(__dirname, '..');
const SAMPLE = fs.readFileSync(path.join(ROOT, 'samples', 'shop-architecture.d2'), 'utf8');
const engine = new Engine({ timeoutMs: 60000 });
test.after(() => engine.dispose());
const run = (files, extra = {}) => engine.run({ files, inputPath: Object.keys(files)[0], ...extra });

test('vendored engine: the npm files unmodified (sha256), licenses next to them, no ELK file', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'lib', 'd2', f))).digest('hex');
  assert.equal(sha('d2.wasm'), '7b0d5db9e148d1eba9ab7494a468a79fd92aca93fd3a89cad5876e68097170af');
  assert.equal(sha('wasm_exec.js'), '42c92bf26a564050862e648642f9dc529673fb257d8d96139122da317ac46274');
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'd2', 'LICENSE.txt'), 'utf8'), /Mozilla Public License Version 2\.0/);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'd2', 'LICENSE-wasm_exec.txt'), 'utf8'), /Copyright 2009 The Go Authors/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'lib', 'd2')).sort(), ['LICENSE-wasm_exec.txt', 'LICENSE.txt', 'd2.wasm', 'wasm_exec.js']);
});

test('engine: version, and the sample renders with its boards and shape lines', async () => {
  const v = await engine.version();
  assert.equal(v.version, 'v0.7.0-HEAD');
  assert.equal(v.js, '0.1.33');
  const r = await run({ 'shop.d2': SAMPLE });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.match(r.svg, /^<\?xml[\s\S]*<svg[^>]*data-d2-version="v0\.7\.0-HEAD"/);
  assert.deepEqual(r.boards.map((b) => b.path), ['', 'layers.deploy', 'steps.1', 'steps.2', 'steps.3']);
  const byId = Object.fromEntries(r.shapes.map((s) => [s.id, s]));
  assert.equal(byId.customer.line, 18);
  assert.equal(byId['app.api'].line, 27);
  assert.equal(byId.db.line, 36);
  assert.ok(byId['app.api'].w > 0 && byId['app.api'].h > 0);
  const box = U.svgBox(r.svg);
  assert.ok(box.w > 500 && box.h > 200, JSON.stringify(box));
  assert.equal(r.connections, 9);
});

test('engine: one board, every board, and one animated SVG', async () => {
  const r = await run({ 'shop.d2': SAMPLE }, { board: 'layers.deploy' });
  assert.ok(r.svg.includes('Managed database'));
  assert.ok(!r.svg.includes('Payment service'));
  assert.deepEqual(r.shapes.map((s) => s.id).slice(0, 2), ['title', 'region']);
  const all = await run({ 'shop.d2': SAMPLE }, { boards: ['', 'layers.deploy', 'steps.1', 'steps.2', 'steps.3'] });
  assert.equal(all.svgs.length, 5);
  assert.ok(all.svgs[2].svg.includes('1. open the shop'));
  const anim = await run({ 'shop.d2': SAMPLE }, { animate: 1000 });
  assert.ok(!anim.error, JSON.stringify(anim.error));
  assert.match(anim.svg, /@keyframes/);
  assert.ok(anim.svg.includes('Managed database') && anim.svg.includes('Payment service'));
});

test('engine: syntax errors come back with their line; the engine keeps working after them', async () => {
  const r = await run({ 'bad.d2': 'a -> b\nc -> \nd: {shape: notashape}\n' });
  assert.ok(r.error);
  const errs = U.parseErrors(r.error, 'bad.d2');
  assert.ok(errs.some((e) => e.line === 1 && /connection missing destination/.test(e.message)), JSON.stringify(errs));
  const ok = await run({ 'ok.d2': 'a -> b' });
  assert.ok(!ok.error && ok.shapes.length === 2);
});

test('engine: theme choice - automatic light and dark, the file\'s own theme, the user\'s pick', async () => {
  const t = (files, theme) => run(files, { theme: { lightId: 0, darkId: 200, ...theme } });
  assert.equal((await t({ 'a.d2': 'a -> b' }, { dark: false })).themeID, 0);
  const dark = await t({ 'a.d2': 'a -> b' }, { dark: true });
  assert.equal(dark.themeID, 200);
  assert.ok(!/prefers-color-scheme/.test(dark.svg), 'one theme per picture');
  const file = 'vars: { d2-config: { theme-id: 4; dark-theme-id: 201 } }\na -> b';
  assert.equal((await t({ 'a.d2': file }, { dark: false, fileLight: true, fileDark: true })).themeID, 4);
  assert.equal((await t({ 'a.d2': file }, { dark: true, fileLight: true, fileDark: true })).themeID, 201);
  assert.equal((await t({ 'a.d2': 'vars: { d2-config: { theme-id: 4 } }\na' }, { dark: true, fileLight: true })).themeID, 4);
  assert.equal((await t({ 'a.d2': file }, { dark: true, user: 302, fileLight: true, fileDark: true })).themeID, 302);
});

test('engine: a file asking for ELK is drawn with dagre (the bundled layout) instead of failing', async () => {
  const text = 'vars: { d2-config: { layout-engine: elk } }\na -> b -> c';
  const r = await run({ 'a.d2': text }, { compile: { layout: 'dagre' } });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal(U.wantedLayout(text), 'elk');
});

test('engine: imports through collectFiles, and an error inside an imported file names that file', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-imp-'));
  try {
    fs.mkdirSync(path.join(d, 'lib'));
    fs.writeFileSync(path.join(d, 'lib', 'db.d2'), 'shape: cylinder\nlabel: Main DB\n');
    const main = path.join(d, 'main.d2');
    const col = collectFiles({ file: main, text: 'store: @lib/db\napi -> store', root: d });
    const r = await engine.run({ files: col.files, inputPath: col.inputPath });
    assert.ok(!r.error, JSON.stringify(r.error));
    assert.ok(r.svg.includes('Main DB'));
    fs.writeFileSync(path.join(d, 'lib', 'db.d2'), 'shape: cylinder\nx -> \n');
    const col2 = collectFiles({ file: main, text: 'store: @lib/db\napi -> store', root: d });
    const r2 = await engine.run({ files: col2.files, inputPath: col2.inputPath });
    const e = U.parseErrors(r2.error, col2.inputPath);
    assert.ok(e.some((x) => x.file === 'lib/db.d2' && x.line === 1), JSON.stringify(e));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('engine: a request over the time limit restarts the worker; the next one works', async () => {
  const e2 = new Engine({ timeoutMs: 1 });
  try {
    const r = await e2.run({ files: { 'a.d2': 'a -> b' }, inputPath: 'a.d2' });
    assert.ok(r.error && r.error.timeout, JSON.stringify(r.error));
    assert.equal(e2.restarts, 1);
    const ok = await e2.run({ files: { 'a.d2': 'a -> b' }, inputPath: 'a.d2' }, 60000);
    assert.ok(!ok.error && ok.svg, JSON.stringify(ok.error));
  } finally { e2.dispose(); }
});

test('engine: markdown, code, sql_table and sequence diagrams render', async () => {
  const r = await run({ 'm.d2': 'a: |md\n# Hello\n- one\n|\nb: |go\nfunc main() {}\n|\nt: {shape: sql_table; id: int {constraint: primary_key}}\ns: {shape: sequence_diagram; x -> y: hi}\n' });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.match(r.svg, /foreignObject/);
  assert.ok(r.svg.includes('primary_key') || r.svg.includes('PK'));
});
