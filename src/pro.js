'use strict';
// Zovo Pro for D2 Diagram Viewer & D2 Preview, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Two Pro tools, 1 free try each on this computer (owner decision 15 Nov:
// TRIAL_USES = 1, module 2026-11-15.tries1). The count is per tool, not per file: one export of any file uses the
// export try. A try counts only after the tool wrote its files; Escape, Cancel or an error never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');
const { currentSurface } = require('./reach');

const SKU = 'd2-viewer-pro';
const TRIAL_USES = 1;
const TRIAL_KEY = 'zovoD2.proTrial';

const FEATURES = {
  export: {
    title: 'Export PNG, PDF and SVG',
    detail: 'Exports the diagram as PNG (1x to 4x), PDF or SVG with your scale, padding and theme, either the board on screen or every board of a diagram with layers, scenarios and steps (separate files, one PDF page each, or one animated SVG).',
  },
  batch: {
    title: 'Batch export',
    detail: 'Renders every .d2 file of a folder to SVG in an output folder (docs/diagrams by default) in one run, keeping the folder structure, and can keep watching: a .d2 file re-renders when it changes on disk.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  const s = currentSurface();
  if (s) return s;
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'zovoD2', productName = 'D2 Diagram Viewer & D2 Preview' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  // Counts never go down in a session: globalState can hand back an older value for a moment after a write, so the
  // highest count seen here wins.
  const seen = {};
  const used = (f) => Math.max(Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0, seen[f] || 0);
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, toolId: f, triesUsed: used(f), tools: TOOLS, ...(surface ? { surface } : {}) }));
  }

  /** After the tool showed its result: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    for (const k of Object.keys(seen)) m[k] = Math.max(Number(m[k]) || 0, seen[k]);
    m[f] = used(f) + 1;
    seen[f] = m[f];
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try of "${FEATURES[f].title}" used on this computer${l ? `, ${l} left` : ''}.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left, used,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, surfaceOf };
