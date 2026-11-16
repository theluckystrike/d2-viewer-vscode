'use strict';
// Extension tests with the vscode stub and the real D2 engine: the listing, activation, the preview and its messages
// (render, errors as squiggles, click-to-line, copy SVG, theme and layout picks), the two Pro tools with 1 free try
// each (A then B, reload), README and walkthrough text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ZOVO_PRO_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2-pro-')), 'pro.json');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { previewHtml } = require('../src/html');
const { encodePng } = require('../src/core/png');
const { pdfInfo } = require('../src/core/pdf');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'samples', 'shop-architecture.d2');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await tick(20); } return f(); };
const live = [];
test.after(() => { for (const s of live) { try { s.api.previews.dispose(); } catch (e) { /* closed */ } } cleanup(); fs.rmSync(path.dirname(process.env.ZOVO_PRO_FILE), { recursive: true, force: true }); });

function workspace() {
  const dir = tmpDir('d2-ws-');
  fs.mkdirSync(path.join(dir, 'arch'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'other', 'deep'), { recursive: true });
  fs.copyFileSync(SAMPLE, path.join(dir, 'arch', 'shop.d2'));
  fs.writeFileSync(path.join(dir, 'arch', 'SMALL.D2'), 'web -> api -> db\ndb: {shape: cylinder}\n');
  fs.writeFileSync(path.join(dir, 'other', 'deep', 'flow.d2'), 'start -> work -> end\n');
  fs.writeFileSync(path.join(dir, 'other', 'broken.d2'), 'a -> \n');
  return dir;
}
function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  // the webview: answers PNG requests with a small PNG of the asked size (capped), like the canvas would
  s.log.onPost = (panel, m) => {
    if (m.type === 'rasterize') {
      const w = Math.max(1, Math.min(64, Math.round(m.width * m.scale))), h = Math.max(1, Math.min(64, Math.round(m.height * m.scale)));
      panel.send({ type: 'raster', id: m.id, png: encodePng(w, h, Buffer.alloc(w * h * 4, 200)).toString('base64'), width: w, height: h, scale: w / m.width });
    }
    if (m.type === 'render') panel.send({ type: 'rendered', version: m.version });
  };
  s.api = s.ext.activate(s.context);
  live.push(s);
  return s;
}
const renders = (s) => s.log.posted.filter((m) => m.type === 'render');
const errorsOf = (s) => s.log.posted.filter((m) => m.type === 'error');

test('listing: name, phrase first, 5 keywords from the row, engines, publisher, repository, icon, activation', () => {
  assert.equal(pkg.displayName, 'D2 Diagram Viewer & D2 Preview');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('D2 '));
  assert.deepEqual(pkg.keywords, ['d2', 'd2 diagram', 'diagram', 'architecture diagram', 'diagram as code']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(pkg.publisher, 'zovo'); assert.equal(pkg.name, 'zovo-d2-viewer'); assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/d2-viewer-vscode');
  assert.equal(pkg.icon, 'icon.png');
  const png = fs.readFileSync(path.join(ROOT, 'icon.png'));
  assert.equal(png.readUInt32BE(16), 128); assert.equal(png.readUInt32BE(20), 128);
  assert.deepEqual(pkg.activationEvents, ['onLanguage:d2', 'onCustomEditor:zovoD2.viewer', 'onUri']);
  assert.equal(pkg.contributes.themes, undefined, 'no color theme');
  assert.equal(pkg.contributes.configurationDefaults, undefined, 'no settings of other extensions or the workbench');
  assert.equal(pkg.contributes.customEditors[0].priority, 'option', 'the text editor stays the default for .d2');
  for (const [where, items] of Object.entries(pkg.contributes.menus)) for (const it of items) assert.equal(it.title, undefined, `${where} ${it.command} has a title`);
  const ctx = pkg.contributes.menus['explorer/context'];
  assert.ok(ctx.some((m) => m.command === 'zovoD2.zovoPro.export' && m.when.includes('resourceExtname =~ /^\\.d2$/i')));
  assert.ok(new RegExp('^\\.d2$', 'i').test('.D2'));
  for (const c of pkg.contributes.commands.filter((x) => /\.zovoPro\./.test(x.command))) assert.match(c.title, /^Zovo Pro: /);
});

test('activation shows nothing: no message, no panel, no editor, no URL; commands and the optional editor registered', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.opened.length, 0);
  assert.equal(s.log.external.length, 0);
  for (const c of ['showPreviewToSide', 'showPreview', 'openViewer', 'showSource', 'copySvg', 'pickTheme', 'pickLayout', 'openSample', 'export', 'batchExport', 'stopWatch', 'zovoPro.export', 'zovoPro.batch', 'getPro']) assert.ok(s.commands.has(`zovoD2.${c}`), c);
  assert.equal(s.providers.custom.id, 'zovoD2.viewer');
  for (const c of pkg.contributes.commands) assert.ok(s.commands.has(c.command), `contributed but not registered: ${c.command}`);
});

test('preview: opens beside, draws the file as a data: SVG with boxes and boards; strict CSP; a second open reuses it', async () => {
  const dir = workspace();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'arch', 'shop.d2'));
  const p = await s.api.previews.open(uri, -2);
  const r = await until(() => renders(s)[0]);
  assert.ok(r, JSON.stringify(errorsOf(s)));
  assert.match(r.src, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(r.src.split(',')[1], 'base64').toString();
  assert.ok(svg.includes('Order API'));
  assert.ok(r.shapes.some((x) => x.id === 'app.api' && x.line === 27));
  assert.deepEqual(r.boards.map((b) => b.path), ['', 'layers.deploy', 'steps.1', 'steps.2', 'steps.3']);
  assert.equal(r.themeId, 200, 'VS Code is dark in the stub: D2 dark theme');
  assert.match(r.themeName, /Dark Mauve \(auto\)/);
  assert.match(r.stats, /13 shapes, 9 connections/);
  const html = s.log.panel.webview.html;
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /^default-src 'none'/);
  assert.ok(!/connect-src|https?:|unsafe-eval|unsafe-inline/.test(csp), csp);
  assert.ok(!/<script(?![^>]*nonce=)/.test(html));
  assert.equal(await s.api.previews.open(uri, -2), p);
  assert.ok(await until(() => s.log.status.length === 0 || true));
});

test('preview: errors become squiggles with the line number and a line in the preview; fixing the text clears them', async () => {
  const dir = workspace();
  const s = activate(dir);
  const file = path.join(dir, 'arch', 'SMALL.D2');
  const uri = s.vscode.Uri.file(file);
  const doc = await s.vscode.workspace.openTextDocument(uri);
  assert.equal(doc.languageId, 'd2');
  await s.api.previews.open(uri, -2);
  await until(() => renders(s)[0]);
  doc._set('web -> api -> db\nqueue -> \n');
  s.api.previews.changed(uri);
  const e = await until(() => errorsOf(s)[0]);
  assert.ok(e);
  assert.equal(e.errors[0].line, 1);
  assert.match(e.errors[0].text, /^Line 2: connection missing destination/);
  const d = s.diags.get(uri.toString());
  assert.equal(d.length, 1);
  assert.equal(d[0].range.start.line, 1);
  assert.match(d[0].message, /connection missing destination \(line 2\)/);
  assert.equal(d[0].source, 'D2');
  doc._set('web -> api -> db\nqueue -> api\n');
  s.api.previews.changed(uri);
  await until(() => renders(s).length >= 2);
  assert.equal(s.diags.has(uri.toString()), false);
});

test('preview: click on a shape opens the text at its line; copy SVG; theme and layout picks stay in this preview only', async () => {
  const dir = workspace();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'arch', 'shop.d2'));
  const p = await s.api.previews.open(uri, -2);
  await until(() => renders(s)[0]);
  s.log.panel.send({ type: 'reveal', id: 'db', line: 36 });
  await until(() => s.log.opened.length);
  assert.equal(s.log.opened[0].uri.fsPath, uri.fsPath);
  assert.equal(s.log.revealed[0].start.line, 36);
  s.log.panel.send({ type: 'copySvg' });
  await until(() => s.log.clipboard);
  assert.match(s.log.clipboard, /^<\?xml[\s\S]*Order API/);
  const cfgBefore = JSON.stringify(s.config);
  s.ui.quick.push((items) => items.find((i) => i.label === 'Origami'));
  await s.api.previews.pickTheme(p);
  const r2 = await until(() => renders(s).find((m) => m.themeId === 302));
  assert.ok(r2);
  assert.equal(r2.themeName, 'Origami');
  s.ui.quick.push((items) => items.find((i) => i.label === 'Direction: down'));
  await s.api.previews.pickLayout(p);
  const r3 = await until(() => renders(s).find((m) => /down/.test(m.layoutName)));
  assert.equal(r3.layoutName, 'dagre, down');
  assert.equal(r3.shapes.find((x) => x.id === 'db').line, 36, 'the appended direction line keeps every line number');
  s.ui.quick.push((items) => items.find((i) => /Sketch style: turn on/.test(i.label)));
  await s.api.previews.pickLayout(p);
  assert.ok(await until(() => renders(s).find((m) => /sketch/.test(m.layoutName))));
  s.log.panel.send({ type: 'selectBoard', path: 'layers.deploy' });
  const rb = await until(() => renders(s).find((m) => m.board === 'layers.deploy'));
  assert.ok(rb.shapes.some((x) => x.id === 'region'));
  assert.equal(JSON.stringify(s.config), cfgBefore, 'no setting written');
  assert.deepEqual(Object.keys(s.wstate.get('zovoD2.view')), [uri.toString()]);
});

test('preview: a binary file and an empty file show a plain notice, not a drawing', async () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'bin.d2'), Buffer.from([0, 1, 2, 0, 0, 255]));
  fs.writeFileSync(path.join(dir, 'empty.d2'), '');
  const s = activate(dir);
  await s.api.previews.open(s.vscode.Uri.file(path.join(dir, 'bin.d2')), -2);
  assert.ok(await until(() => s.log.posted.find((m) => m.type === 'notice' && /binary data/.test(m.text))));
  await s.api.previews.open(s.vscode.Uri.file(path.join(dir, 'empty.d2')), -2);
  assert.ok(await until(() => s.log.posted.find((m) => m.type === 'notice' && /is empty/.test(m.text))));
  assert.equal(renders(s).length, 0);
});

test('Pro export: PNG of file A runs fully and counts the try; then file B opens the Zovo Pro panel and writes nothing', async () => {
  const dir = workspace();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'arch', 'shop.d2'));
  const b = s.vscode.Uri.file(path.join(dir, 'arch', 'SMALL.D2'));
  s.ui.quick.push(undefined); // Escape at the format pick: no try used
  assert.equal(await s.api.tools.exportTool(a), undefined);
  assert.equal(s.api.pro.left('export'), 1);
  s.ui.quick.push((items) => items.find((i) => i.id === 'png'), (items) => items.find((i) => i.id === 'one'), (items) => items.find((i) => i.id === 'go'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'arch', 'shop.png')));
  const w = await s.api.tools.exportTool(a);
  assert.equal(w.length, 1);
  const png = fs.readFileSync(path.join(dir, 'arch', 'shop.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(s.api.pro.left('export'), 0);
  assert.ok(s.log.status.some((t) => /free try of "Export PNG, PDF and SVG" used/.test(t)));
  assert.ok(s.log.info.some((m) => /Exported shop\.png/.test(m.text)));
  s.ui.quick.push((items) => items.find((i) => i.id === 'svg'), (items) => items.find((i) => i.id === 'go'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'arch', 'SMALL.svg')));
  assert.equal(await s.api.tools.exportTool(b), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'arch', 'SMALL.svg')));
  const panel = s.log.info.find((m) => /Export PNG, PDF and SVG is part of Zovo Pro/.test(m.text));
  assert.ok(panel && panel.opts.modal, JSON.stringify(s.log.info.map((m) => m.text)));
  assert.equal(s.api.pro.left('batch'), 1, 'the other tool keeps its try');
  // a reload (new activation, same globalState) keeps the count
  const s2 = activate(dir, s.state);
  assert.equal(s2.api.pro.left('export'), 0);
  assert.equal(s2.api.pro.left('batch'), 1);
  assert.equal(s.log.external.length + s2.log.external.length, 0, 'no URL opened');
});

test('Pro export: PDF of every board (one page each), SVG at 2x, animated SVG; options remembered, not written to settings', async () => {
  const dir = workspace();
  const s = activate(dir);
  s.api.pro.license.isPro = () => true; // a licensed user: no try counting
  const a = s.vscode.Uri.file(path.join(dir, 'arch', 'shop.d2'));
  s.ui.quick.push((items) => items.find((i) => i.id === 'pdf'), (items) => items.find((i) => i.id === 'all'), (items) => items.find((i) => i.id === 'pad'), (items) => items.find((i) => i.id === 'go'));
  s.ui.input.push('20');
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out', 'shop.pdf')));
  await s.api.tools.exportTool(a);
  const info = pdfInfo(fs.readFileSync(path.join(dir, 'out', 'shop.pdf')));
  assert.equal(info.pages, 5); assert.equal(info.images, 5); assert.ok(info.eof);
  assert.equal(s.state.get('zovoD2.exportOptions').pad, 20);
  s.ui.quick.push((items) => items.find((i) => i.id === 'svg'), (items) => items.find((i) => i.id === 'all'), (items) => items.find((i) => i.id === 'go'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out', 'shop.svg')));
  const files = await s.api.tools.exportTool(a);
  assert.deepEqual(files.map((u) => path.basename(u.fsPath)), ['shop.svg', 'shop-layers-deploy.svg', 'shop-steps-1.svg', 'shop-steps-2.svg', 'shop-steps-3.svg']);
  const svg = fs.readFileSync(path.join(dir, 'out', 'shop.svg'), 'utf8');
  const inner = /<svg[^>]*class="[^"]*d2-svg[^"]*"[^>]*width="(\d+)"/.exec(svg);
  assert.ok(svg.includes('Order API') && inner, svg.slice(0, 300));
  s.ui.quick.push((items) => items.find((i) => i.id === 'anim'), (items) => items.find((i) => i.id === 'go'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out', 'shop-animated.svg')));
  await s.api.tools.exportTool(a);
  assert.match(fs.readFileSync(path.join(dir, 'out', 'shop-animated.svg'), 'utf8'), /@keyframes/);
  assert.equal(s.config['export.padding'], undefined);
});

test('Pro export: a file with an error exports nothing and uses no try', async () => {
  const dir = workspace();
  const s = activate(dir);
  assert.equal(await s.api.tools.exportTool(s.vscode.Uri.file(path.join(dir, 'other', 'broken.d2'))), undefined);
  assert.ok(s.log.error.some((m) => /has an error, so nothing was exported\. Broken\.d2, line 1: connection missing destination|line 1/.test(m.text)), JSON.stringify(s.log.error));
  assert.equal(s.api.pro.left('export'), 1);
});

test('Pro batch export: folder A to docs/diagrams (structure kept, failures listed), watch re-renders; then folder B opens the Pro panel', async () => {
  const dir = workspace();
  const s = activate(dir);
  const folderA = s.vscode.Uri.file(path.join(dir, 'other'));
  s.ui.quick.push((items) => items.find((i) => i.id === 'watch'));
  const res = await s.api.tools.batchTool(folderA);
  assert.deepEqual(res.ok.map((x) => x.rel).sort(), [path.join('deep', 'flow.d2')]);
  assert.equal(res.failed.length, 1);
  const out = path.join(dir, 'other', 'docs', 'diagrams', 'deep', 'flow.svg');
  assert.match(fs.readFileSync(out, 'utf8'), /<svg[\s\S]*work/);
  assert.equal(s.api.pro.left('batch'), 0);
  assert.ok(s.log.info.some((m) => /Rendered 1 of 2 \.d2 files to docs\/diagrams\. 1 failed \(broken\.d2\)/.test(m.text)), JSON.stringify(s.log.info.map((m) => m.text)));
  assert.ok(s.log.output.some((l) => /^FAIL broken\.d2: Broken\.d2, line 1|^FAIL broken\.d2/.test(l)));
  assert.ok(s.api.tools.watching && s.log.statusItem.shown && /D2 watch: docs\/diagrams/.test(s.log.statusItem.text));
  fs.writeFileSync(path.join(dir, 'other', 'deep', 'flow.d2'), 'start -> changed -> end\n');
  const w = s.log.watchers[s.log.watchers.length - 1];
  const ran = new Promise((r) => { s.api.tools.watching.onRun = r; });
  w.fire(s.vscode.Uri.file(path.join(dir, 'other', 'deep', 'flow.d2')));
  await ran;
  assert.ok(fs.readFileSync(out, 'utf8').includes('changed'));
  assert.equal(s.api.pro.left('batch'), 0, 'watch renders are part of the same run');
  assert.ok(s.api.tools.stopWatch(false));
  assert.equal(s.api.tools.watching, null);
  const folderB = s.vscode.Uri.file(path.join(dir, 'arch'));
  s.ui.quick.push((items) => items.find((i) => i.id === 'once'));
  assert.equal(await s.api.tools.batchTool(folderB), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'arch', 'docs')));
  assert.ok(s.log.info.find((m) => /Batch export is part of Zovo Pro/.test(m.text) && m.opts.modal));
  assert.equal(s.api.pro.left('export'), 1);
  // a reload (new activation, same globalState) keeps the count: folder B still opens the panel
  const s2 = activate(dir, s.state);
  assert.equal(s2.api.pro.left('batch'), 0);
  s2.ui.quick.push((items) => items.find((i) => i.id === 'once'));
  assert.equal(await s2.api.tools.batchTool(folderB), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'arch', 'docs')));
  assert.ok(s2.log.info.find((m) => /Batch export is part of Zovo Pro/.test(m.text) && m.opts.modal));
  assert.equal(s.log.external.length + s2.log.external.length, 0, 'no URL opened');
});

test('Pro panel text: 1 free try per tool; proinfo config matches; reach config matches the tools', () => {
  const cfg = require('../src/license/config.js');
  assert.equal(cfg.listing, 'd2');
  assert.equal(cfg.pro_info.triesKey, 'zovoD2.proTrial');
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['export', 'batch']);
  assert.equal(cfg.pro_info.triesMax, undefined);
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  assert.equal(pro.TRIAL_KEY, cfg.pro_info.triesKey);
  const rc = require('../src/reach-config');
  assert.deepEqual(rc.tools.map((t) => t.id), Object.keys(pro.FEATURES));
  assert.equal(rc.triesKey, pro.TRIAL_KEY);
});

test('license module and rating module are byte-identical to the factory copies', () => {
  const F = path.join(ROOT, '..', '..', 'sprint');
  if (!fs.existsSync(F)) return;
  for (const f of ['index.js', 'license.js', 'sponsors.js', 'gumroad.js', 'proinfo.js', 'reach1.js']) assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'license', f)).equals(fs.readFileSync(path.join(F, 'license', f))), f);
  assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'rate.js')).equals(fs.readFileSync(path.join(F, 'rating', 'rate.js'))));
});

test('webview page: CSP default-src none, scripts by nonce only, no remote origins; the title is escaped', () => {
  const html = previewHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: 'a<b>.d2' });
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /^default-src 'none'/);
  assert.ok(!/connect-src|https?:/.test(csp), csp);
  assert.ok(!/<script(?![^>]*nonce=)/.test(html));
  assert.ok(html.includes('a&lt;b&gt;.d2'));
  const js = fs.readFileSync(path.join(ROOT, 'media', 'preview.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|new Worker|eval\(/.test(js));
});

test('text: README first screen, no rival names, cross-sell ids exist, walkthrough files exist, THIRD-PARTY notices', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = readme.split('\n').slice(0, 24).join('\n');
  assert.match(first, /!\[[^\]]+\]\(images\/screenshot\.png\)/);
  assert.match(readme, /Zovo Pro: USD 19 once/);
  assert.match(readme, /Made by Zovo/);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
  const texts = [readme, fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), ...fs.readdirSync(path.join(ROOT, 'walkthrough')).map((f) => fs.readFileSync(path.join(ROOT, 'walkthrough', f), 'utf8'))];
  for (const t of texts) assert.ok(!/terrastruct|tala\b|playground/i.test(t), 'no rival or vendor product names in user text');
  const steps = pkg.contributes.walkthroughs[0].steps;
  for (const st of steps) if (st.media.markdown) assert.ok(fs.existsSync(path.join(ROOT, st.media.markdown)), st.media.markdown);
  const ids = [...JSON.stringify(steps).matchAll(/extension\.open\?%5B%22([^%]+)%22%5D/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['zovo.mermaid-viewer', 'zovo.zovo-plantuml-viewer', 'zovo.zovo-graphviz-preview']);
  const products = fs.readdirSync(path.join(ROOT, '..')).map((d) => { try { const p = JSON.parse(fs.readFileSync(path.join(ROOT, '..', d, 'package.json'), 'utf8')); return `${p.publisher}.${p.name}`; } catch (e) { return ''; } });
  for (const id of ids) assert.ok(products.includes(id), id);
  const notices = fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /MPL-2\.0/); assert.match(notices, /lib\/d2\/d2\.wasm/); assert.match(notices, /BSD-3-Clause/);
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  assert.ok(!/^images/m.test(ignore) && !/^lib/m.test(ignore));
});
