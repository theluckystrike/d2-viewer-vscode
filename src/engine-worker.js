'use strict';
// Worker thread that runs the D2 engine: lib/d2/d2.wasm (the official D2 compiler and renderer built for WebAssembly,
// from the npm package @terrastruct/d2, MPL-2.0, unmodified) with lib/d2/wasm_exec.js (the Go WebAssembly runtime
// glue, BSD-3-Clause, unmodified). It runs inside the extension host process, so nothing is installed, no binary is
// started and no network is used. Only the dagre layout is available: the ELK layout of the npm package is a separate
// EPL-2.0 file that this extension does not ship.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { summarize } = require('./core/d2util');

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  try { Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true }); } catch (e) { /* Go falls back to its own error */ }
}

const libDir = (workerData && workerData.libDir) || path.join(__dirname, '..', 'lib', 'd2');
let api = null;

async function boot() {
  const glue = fs.readFileSync(path.join(libDir, 'wasm_exec.js'), 'utf8');
  vm.runInThisContext(glue, { filename: path.join(libDir, 'wasm_exec.js') });
  const go = new globalThis.Go();
  const bytes = fs.readFileSync(path.join(libDir, 'd2.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(instance).then(() => parentPort.postMessage({ type: 'exit' }), (e) => parentPort.postMessage({ type: 'exit', error: String(e && e.message || e) }));
  for (let i = 0; i < 200 && !globalThis.d2; i++) await new Promise((r) => setTimeout(r, 5));
  if (!globalThis.d2) throw new Error('the D2 engine did not start');
  api = globalThis.d2;
}

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return { error: { message: String(s).slice(0, 400) } }; } };
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');

async function compile(req) {
  const r = parse(await api.compile(JSON.stringify({ fs: req.files, inputPath: req.inputPath, options: req.compile || {} })));
  if (r.error) return { error: r.error };
  return { data: r.data };
}

async function renderSvg(diagram, options) {
  const r = parse(await api.render(JSON.stringify({ diagram, options })));
  if (r.error) return { error: r.error };
  return { svg: decode(r.data) };
}

/**
 * One request: compile the files, then render one board (or every board as one animated SVG, or a list of boards).
 * req: { files, inputPath, compile: { layout, sketch, target?, animateInterval? }, render: { themeID?, darkThemeID?, pad?,
 *        sketch?, scale?, center? }, board: '' | 'layers.x' ..., boards?: ['', 'layers.x'], animate?: ms, summary?: bool }
 */
async function run(req) {
  const t0 = Date.now();
  const anim = Number(req.animate) > 0;
  const compileOpts = { layout: 'dagre', ...(req.compile || {}) };
  if (anim) Object.assign(compileOpts, { target: '*', animateInterval: Number(req.animate) });
  const c = await compile({ files: req.files, inputPath: req.inputPath, compile: compileOpts });
  if (c.error) return { error: c.error, ms: Date.now() - t0 };
  const { diagram, renderOptions, graph } = c.data;
  const fileOpts = renderOptions || {};
  const base = {};
  for (const k of ['pad', 'sketch', 'center', 'themeID', 'darkThemeID', 'themeOverrides', 'darkThemeOverrides']) if (fileOpts[k] !== null && fileOpts[k] !== undefined) base[k] = fileOpts[k];
  const opts = { ...base };
  for (const [k, v] of Object.entries(req.render || {})) if (v !== null && v !== undefined) opts[k] = v;
  const out = { ms: 0, fileOptions: base };
  // theme: the user's pick for this preview, else the file's own theme (its dark theme when VS Code is dark), else
  // the light or dark default. One theme per picture: the SVG never switches on its own.
  const th = req.theme;
  if (th) {
    let id;
    if (th.user !== null && th.user !== undefined) id = Number(th.user);
    else if (th.dark && th.fileDark && base.darkThemeID !== undefined) { id = base.darkThemeID; if (base.darkThemeOverrides) opts.themeOverrides = base.darkThemeOverrides; else delete opts.themeOverrides; }
    else if (th.fileLight && base.themeID !== undefined) id = base.themeID;
    else id = th.dark ? Number(th.darkId) : Number(th.lightId);
    opts.themeID = id;
    delete opts.darkThemeID; delete opts.darkThemeOverrides;
  }
  out.themeID = opts.themeID === undefined ? 0 : opts.themeID;
  out.sketch = !!opts.sketch;
  if (anim) {
    const r = await renderSvg(diagram, { ...opts, target: '*', animateInterval: Number(req.animate) });
    if (r.error) return { error: r.error, ms: Date.now() - t0 };
    out.svg = r.svg;
  } else {
    const list = Array.isArray(req.boards) ? req.boards : [req.board || ''];
    out.svgs = [];
    for (const b of list) {
      const r = await renderSvg(diagram, { ...opts, target: b || '' });
      if (r.error) return { error: r.error, board: b, ms: Date.now() - t0 };
      out.svgs.push({ board: b || '', svg: r.svg });
    }
    out.svg = out.svgs[0] && out.svgs[0].svg;
  }
  if (req.summary !== false) Object.assign(out, summarize(diagram, graph, req.board || '', req.inputPath));
  out.ms = Date.now() - t0;
  return out;
}

parentPort.on('message', async (m) => {
  if (!m || typeof m.id !== 'number') return;
  try {
    if (!api) await boot();
    let result;
    if (m.type === 'run') result = await run(m.data);
    else if (m.type === 'version') result = { version: parse(api.version()).data || '', js: parse(api.jsVersion()).data || '' };
    else if (m.type === 'ping') result = { ok: true };
    else result = { error: { message: 'unknown request ' + m.type } };
    parentPort.postMessage({ id: m.id, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, result: { error: { message: String((e && e.message) || e).slice(0, 2000), crashed: true } } });
  }
});
parentPort.postMessage({ type: 'loaded' });
