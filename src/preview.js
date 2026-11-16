'use strict';
// The live D2 preview: a webview per .d2 document, either a panel beside the text editor (like the Markdown preview)
// or the "D2 Diagram Viewer" editor (an optional editor: the text editor stays the default for .d2). The extension
// host compiles and renders with the bundled D2 engine (src/engine.js) and sends the SVG to the webview as a data: URI.
// Errors go to the Problems view as squiggles and to a line at the top of the preview; the last good drawing stays.
// Theme, direction, sketch and board are kept per file in workspaceState (never in settings). Nothing pops up.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { Engine } = require('./engine');
const U = require('./core/d2util');
const { collectFiles, readImage, fileThemes } = require('./core/files');
const { previewHtml } = require('./html');
const { commandUris, showLinks } = require('./support');

const SECTION = 'zovoD2';
const VIEW_TYPE = 'zovoD2.preview';
const EDITOR_TYPE = 'zovoD2.viewer';
const D2_EXT = /\.d2$/i;
const STATE_KEY = 'zovoD2.view';

function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const theme = (v, d) => (U.isThemeId(v) ? Number(v) : d);
  return {
    delay: num(c.get('preview.updateDelayMs', 300), 0, 5000, 300),
    lightTheme: theme(c.get('preview.lightTheme', 0), 0),
    darkTheme: theme(c.get('preview.darkTheme', 200), 200),
    timeoutMs: num(c.get('renderTimeoutSeconds', 20), 3, 600, 20) * 1000,
    maxFileKB: num(c.get('maxFileKB', 2048), 16, 1048576, 2048),
  };
}

function isD2(doc) { return !!doc && (doc.languageId === 'd2' || D2_EXT.test(doc.uri.path)); }
const isDark = () => { const k = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind; return k === 2 || k === 3; };

/** Root folder for imports and pictures: the workspace folder of the file, else its own folder. */
function rootOf(uri) {
  const wf = vscode.workspace.getWorkspaceFolder(uri);
  if (wf && wf.uri.scheme === 'file') return wf.uri.fsPath;
  return uri.scheme === 'file' ? path.dirname(uri.fsPath) : '';
}

/** Text of a document: the open editor's text when VS Code has it, else the file on disk. */
function openText(fsPath) {
  const d = vscode.workspace.textDocuments.find((x) => x.uri.scheme === 'file' && x.uri.fsPath === fsPath);
  return d ? d.getText() : null;
}

/**
 * Renders one .d2 file with the given view options. Used by the preview and the Pro tools.
 * o: { uri, text?, board?, boards?, animate?, view: { themeId, direction, sketch }, render?: { pad, scale, center }, dark? }
 * -> engine result plus { files, keys, inputPath, wanted (layout the file asks for) }
 */
async function renderFile(engine, o) {
  const uri = o.uri;
  let text = typeof o.text === 'string' ? o.text : null;
  if (text === null) {
    const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri.toString());
    text = d ? d.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  }
  const view = o.view || {};
  const s = settings();
  const fsPath = uri.scheme === 'file' ? uri.fsPath : path.join(path.sep, 'untitled', path.basename(uri.path || 'untitled') + (D2_EXT.test(uri.path) ? '' : '.d2'));
  const root = uri.scheme === 'file' ? rootOf(uri) : path.dirname(fsPath);
  const col = uri.scheme === 'file' ? collectFiles({ file: fsPath, text: U.withDirection(text, view.direction), root, read: openText }) : { files: { [path.basename(fsPath)]: U.withDirection(text, view.direction) }, inputPath: path.basename(fsPath), keys: {}, root };
  const ft = fileThemes(text);
  const req = {
    files: col.files, inputPath: col.inputPath,
    compile: { layout: 'dagre', ...(view.sketch ? { sketch: true } : {}) },
    render: { ...(view.sketch ? { sketch: true } : {}), ...(o.render || {}) },
    board: o.board || '', boards: o.boards, animate: o.animate,
    theme: { user: U.isThemeId(view.themeId) ? Number(view.themeId) : null, dark: o.dark === undefined ? isDark() : !!o.dark, lightId: s.lightTheme, darkId: s.darkTheme, fileLight: ft.light, fileDark: ft.dark },
  };
  const r = await engine.run(req, s.timeoutMs);
  return Object.assign(r || { error: { message: 'no answer from the D2 engine' } }, { files: col.files, keys: col.keys, inputPath: col.inputPath, root: col.root, fsPath, wanted: U.wantedLayout(text), text });
}

/** Pictures: relative files inline as data: URIs, remote ones taken out (offline). -> { svg, removed, missing } */
function prepareSvg(svg, fsPath, root) {
  const a = root ? U.inlineLocalImages(svg, (rel) => readImage(rel, fsPath, root)) : { svg, missing: 0 };
  const b = U.stripRemoteImages(a.svg);
  return { svg: b.svg, removed: b.removed, missing: a.missing };
}
/** A file size for messages: "103 KB" below 1 MB, else "2.4 MB". */
const sizeText = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const dataUri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

class Preview {
  constructor(manager, uri, panel, kind) {
    this.manager = manager; this.uri = uri; this.key = `${kind}:${uri.toString()}`; this.panel = panel; this.kind = kind;
    this.fileName = path.basename(uri.path);
    this.timer = null; this.ready = false; this.disposed = false; this.pending = false; this.counted = false;
    this.version = 0; this.busy = false; this.again = false; this.last = null; this.deps = new Set();
    this.rasters = new Map(); this.rasterSeq = 0;
    this.subs = [
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((err) => vscode.window.showErrorMessage('D2 preview: ' + ((err && err.message) || err)))),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible && this.pending) { this.pending = false; this.schedule(0); } }),
    ];
    const reach = manager.reach();
    if (reach) this.subs.push(reach.attach(panel.webview, panel));
    if (kind === 'panel') panel.iconPath = vscode.Uri.joinPath(manager.context.extensionUri, 'media', 'preview-icon.svg');
    this.load();
  }

  get view() { return Object.assign({ themeId: null, direction: '', sketch: false, board: '' }, (this.manager.context.workspaceState.get(STATE_KEY) || {})[this.uri.toString()] || {}); }
  async setView(patch) {
    const all = { ...(this.manager.context.workspaceState.get(STATE_KEY) || {}) };
    all[this.uri.toString()] = { ...this.view, ...patch };
    const keys = Object.keys(all);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
    await this.manager.context.workspaceState.update(STATE_KEY, all);
    for (const p of this.manager.previewsOf(this.uri)) p.schedule(0);
  }

  load() {
    const wv = this.panel.webview;
    const media = vscode.Uri.joinPath(this.manager.context.extensionUri, 'media');
    const reach = this.manager.reach();
    wv.options = { enableScripts: true, localResourceRoots: [media], enableCommandUris: [...commandUris(SECTION), ...(reach ? reach.commandIds() : [])] };
    this.ready = false;
    const asUri = (f) => wv.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    wv.html = previewHtml({ cspSource: wv.cspSource, scriptUri: asUri('preview.js'), styleUri: asUri('preview.css'), title: this.fileName,
      showSupportLinks: showLinks(vscode, SECTION), head: reach ? (n) => reach.headHtml(n) : undefined });
  }

  doc() { return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString()); }
  post(m) { if (!this.disposed) { try { const p = this.panel.webview.postMessage(m); if (p && p.then) p.then(undefined, () => false); } catch (e) { /* disposed */ } } }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.update().catch((err) => this.fail(err)); }, delay);
  }

  async update() {
    if (this.disposed || !this.ready) return;
    if (!this.panel.visible) { this.pending = true; return; }
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      let text;
      const d = this.doc();
      if (d) text = d.getText();
      else {
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(this.uri));
        text = bytes.toString('utf8');
      }
      const s = settings();
      if (Buffer.byteLength(text, 'utf8') > s.maxFileKB * 1024) {
        this.post({ type: 'notice', text: `${this.fileName} is ${sizeText(Buffer.byteLength(text, 'utf8'))}. The preview draws files up to ${s.maxFileKB} KB (setting zovoD2.maxFileKB).` });
        return;
      }
      if (text.slice(0, 8192).includes('\u0000')) {
        this.post({ type: 'notice', text: `${this.fileName} contains binary data, so it is not a D2 text file. The preview shows nothing for it.` });
        if (!this.counted) { this.counted = true; this.manager.onFailure(); }
        return;
      }
      if (!text.trim()) {
        this.version++;
        this.manager.clearDiagnostics(this);
        this.post({ type: 'notice', text: `${this.fileName} is empty. Type a line such as "web -> api -> db" and the diagram appears here.` });
        return;
      }
      const version = ++this.version;
      this.post({ type: 'busy', on: true });
      const view = this.view;
      let r = await renderFile(this.manager.engine, { uri: this.uri, text, view, board: view.board });
      if (!r.error && view.board && !(r.boards || []).some((b) => b.path === view.board)) r = await renderFile(this.manager.engine, { uri: this.uri, text, view, board: '' });
      if (this.disposed || version !== this.version) return;
      this.deps = new Set(Object.values(r.keys || {}));
      if (r.error) {
        const errs = U.parseErrors(r.error, r.inputPath);
        this.manager.setDiagnostics(this, errs, r.keys || {}, r.inputPath);
        const own = (e) => !e.file || e.file === r.inputPath;
        this.post({ type: 'error', version, errors: errs.map((e) => ({ text: U.errorText(e, !own(e)), line: own(e) ? e.line : -1, file: own(e) ? '' : e.file })), stats: r.ms ? `error after ${r.ms} ms` : '' });
        return;
      }
      this.manager.clearDiagnostics(this);
      const prep = prepareSvg(r.svg, r.fsPath, r.root);
      const box = U.svgBox(r.svg) || { x: 0, y: 0, w: 100, h: 100 };
      const notes = [];
      if (r.wanted) notes.push(`This file asks for the ${r.wanted.toUpperCase()} layout. The bundled engine has the dagre layout only, so the preview uses dagre.`);
      if (prep.removed) notes.push(`${prep.removed} web ${prep.removed === 1 ? 'picture is' : 'pictures are'} not shown: the preview never loads anything from the internet.`);
      if (prep.missing) notes.push(`${prep.missing} local ${prep.missing === 1 ? 'picture was' : 'pictures were'} not found next to the file.`);
      this.last = { svg: r.svg, shown: prep.svg, boards: r.boards, board: view.board && r.boards.some((b) => b.path === view.board) ? view.board : '', themeId: r.themeID, box, inputPath: r.inputPath };
      const n = (r.shapes || []).length;
      const layoutName = ['dagre', view.direction, view.sketch ? 'sketch' : ''].filter(Boolean).join(', ');
      this.post({ type: 'render', version, src: dataUri(prep.svg), box, shapes: r.shapes, boards: r.boards, board: this.last.board,
        themeId: r.themeID, themeName: U.themeName(r.themeID) + (U.isThemeId(view.themeId) ? '' : ' (auto)'), layoutName,
        stats: `${n} shape${n === 1 ? '' : 's'}, ${r.connections} connection${r.connections === 1 ? '' : 's'}, ${r.ms} ms`, note: notes.join(' ') });
    } finally {
      this.busy = false;
      if (this.again && !this.disposed) { this.again = false; this.schedule(0); }
    }
  }

  fail(err) {
    this.post({ type: 'error', version: this.version, errors: [{ text: String((err && err.message) || err).slice(0, 400), line: -1 }] });
    if (!this.counted) { this.counted = true; this.manager.onFailure(); }
  }

  /** Asks the webview to draw an SVG into a PNG. -> { png: Buffer, width, height, scale } or throws. */
  rasterize(svg, scale, background) {
    const id = ++this.rasterSeq;
    const box = U.svgBox(svg) || { w: 0, h: 0 };
    const outer = /<svg[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const width = outer ? +outer[1] : box.w, height = outer ? +outer[2] : box.h;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rasters.delete(id); reject(new Error('the preview did not answer (is it still open?)')); }, 60000);
      this.rasters.set(id, (m) => { clearTimeout(timer); if (m.error || !m.png) reject(new Error(m.error || 'no PNG')); else resolve({ png: Buffer.from(m.png, 'base64'), width: m.width, height: m.height, scale: m.scale }); });
      this.post({ type: 'rasterize', id, src: dataUri(svg), width, height, scale, background: background || '' });
    });
  }

  async whenReady(ms = 20000) {
    const t = Date.now();
    while (!this.ready && !this.disposed && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
    return this.ready && !this.disposed;
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const reach = this.manager.reach();
    if (reach && reach.onMessage(m)) return;
    switch (m.type) {
      case 'ready': this.ready = true; this.schedule(0); break;
      case 'rendered': if (!this.counted && m.version === this.version) { this.counted = true; this.manager.onSuccess(this.uri); } break;
      case 'reveal': if (Number.isInteger(m.line) && m.line >= 0) await this.showSource(m.line); else vscode.window.setStatusBarMessage(`D2: "${String(m.id || '').slice(0, 60)}" has no line in this file.`, 4000); break;
      case 'openLine': if (Number.isInteger(m.line) && m.line >= 0) await this.showSource(m.line); break;
      case 'showSource': await this.showSource(-1); break;
      case 'copySvg': await this.manager.copySvg(this); break;
      case 'pickTheme': await this.manager.pickTheme(this); break;
      case 'pickLayout': await this.manager.pickLayout(this); break;
      case 'selectBoard': if (typeof m.path === 'string') await this.setView({ board: m.path }); break;
      case 'raster': { const f = this.rasters.get(m.id); if (f) { this.rasters.delete(m.id); f(m); } break; }
    }
  }

  async showSource(line) {
    const doc = this.doc() || await vscode.workspace.openTextDocument(this.uri);
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri.toString());
    const col = ed ? ed.viewColumn : (this.kind === 'editor' ? vscode.ViewColumn.Beside : (this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One));
    const opts = { viewColumn: col, preserveFocus: false, preview: false };
    if (line >= 0) { const l = Math.min(line, doc.lineCount - 1); const pos = new vscode.Position(l, 0); opts.selection = new vscode.Range(pos, pos); }
    const shown = await vscode.window.showTextDocument(doc, opts);
    if (line >= 0 && shown && shown.revealRange) shown.revealRange(opts.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer);
    for (const [, f] of this.rasters) f({ error: 'the preview was closed' });
    this.rasters.clear();
    this.subs.forEach((s) => s.dispose());
    this.manager.previews.delete(this.key);
    this.manager.clearDiagnostics(this);
  }
}

class PreviewManager {
  constructor(context, hooks = {}) {
    this.context = context; this.previews = new Map();
    this.reach = hooks.reach || (() => null);
    this.onSuccess = hooks.onSuccess || (() => {});
    this.onFailure = hooks.onFailure || (() => {});
    this.engine = hooks.engine || new Engine({ libDir: path.join(context.extensionPath, 'lib', 'd2'), timeoutMs: settings().timeoutMs });
    this.diagnostics = vscode.languages.createDiagnosticCollection('d2');
    this.diagOwners = new Map(); // preview key -> [uri strings]
  }

  previewsOf(uri) { const k = uri.toString(); return [...this.previews.values()].filter((p) => p.uri.toString() === k); }

  panel(uri, column) {
    return vscode.window.createWebviewPanel(VIEW_TYPE, 'Preview ' + path.basename(uri.path), { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: false, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
  }

  async open(uri, column) {
    const existing = this.previews.get(`panel:${uri.toString()}`);
    if (existing) { existing.panel.reveal(column, true); return existing; }
    if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) {
      let size = -1;
      try { size = (await vscode.workspace.fs.stat(uri)).size; } catch (e) { /* unknown */ }
      const s = settings();
      if (size > s.maxFileKB * 1024) {
        const pick = await vscode.window.showWarningMessage(`${path.basename(uri.path)} is ${sizeText(size)}. The D2 preview draws files up to ${s.maxFileKB} KB (setting zovoD2.maxFileKB).`, 'Open Settings');
        if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'zovoD2.maxFileKB');
        return null;
      }
      try { await vscode.workspace.openTextDocument(uri); } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/binary/i.test(msg)) throw e;
        vscode.window.showWarningMessage(`${path.basename(uri.path)} contains binary data, so it is not a D2 text file. The preview cannot open it.`);
        return null;
      }
    }
    const p = new Preview(this, uri, this.panel(uri, column), 'panel');
    this.previews.set(p.key, p);
    return p;
  }

  /** The D2 Diagram Viewer editor (CustomTextEditorProvider). */
  resolveEditor(document, panel) {
    const p = new Preview(this, document.uri, panel, 'editor');
    this.previews.set(p.key, p);
    return p;
  }

  active() {
    for (const p of this.previews.values()) if (p.panel.active) return p;
    const ed = vscode.window.activeTextEditor;
    if (ed) { const list = this.previewsOf(ed.document.uri); if (list.length) return list[0]; }
    return [...this.previews.values()].find((p) => p.panel.visible) || null;
  }

  /** A preview of uri that can draw PNGs: an open one, else a new panel beside the editor. */
  async rasterizerFor(uri) {
    let p = this.previewsOf(uri)[0];
    if (!p) p = await this.open(uri, vscode.ViewColumn.Beside);
    if (!p || !(await p.whenReady())) throw new Error('the D2 preview could not open to draw the PNG');
    return p;
  }

  /** Re-renders previews of uri and of files that import it. */
  changed(uri) {
    const s = settings();
    for (const p of this.previews.values()) {
      if (p.uri.toString() === uri.toString() || (uri.scheme === 'file' && p.deps.has(uri.fsPath))) p.schedule(s.delay);
    }
  }
  redrawAll() { for (const p of this.previews.values()) p.schedule(0); }
  reloadAll() { for (const p of this.previews.values()) p.load(); }

  setDiagnostics(p, errs, keys, inputPath) {
    this.clearDiagnostics(p);
    const byUri = new Map();
    for (const e of errs) {
      const file = e.file && keys[e.file] ? vscode.Uri.file(keys[e.file]) : (!e.file || e.file === inputPath ? p.uri : null);
      if (!file) continue;
      const line = Math.max(0, e.line);
      const d = new vscode.Diagnostic(new vscode.Range(line, Math.max(0, e.col), Math.max(line, e.endLine), e.endLine > e.line || e.endCol > e.col ? e.endCol : e.col + 1), e.line >= 0 ? `${e.message} (line ${e.line + 1})` : e.message, vscode.DiagnosticSeverity.Error);
      d.source = 'D2';
      const k = file.toString();
      if (!byUri.has(k)) byUri.set(k, { uri: file, list: [] });
      byUri.get(k).list.push(d);
    }
    for (const { uri, list } of byUri.values()) this.diagnostics.set(uri, list);
    this.diagOwners.set(p.key, [...byUri.values()].map((x) => x.uri));
  }
  clearDiagnostics(p) {
    const owned = this.diagOwners.get(p.key);
    if (!owned) return;
    this.diagOwners.delete(p.key);
    const stillOwned = new Set([...this.diagOwners.values()].flat().map(String));
    for (const u of owned) if (!stillOwned.has(String(u))) this.diagnostics.delete(u);
  }

  async copySvg(p) {
    p = p || this.active();
    if (!p || !p.last) { vscode.window.setStatusBarMessage('D2: nothing drawn yet to copy.', 4000); return false; }
    await vscode.env.clipboard.writeText(p.last.svg);
    vscode.window.setStatusBarMessage(`D2: copied the diagram as SVG (${Math.round(p.last.svg.length / 1024)} KB).`, 5000);
    return true;
  }

  async pickTheme(p) {
    p = p || this.active();
    if (!p) return undefined;
    const s = settings();
    const cur = p.view.themeId;
    const items = [{ label: 'Automatic', description: `the file's own theme, else ${U.themeName(s.lightTheme)} or ${U.themeName(s.darkTheme)} to match VS Code`, id: null, picked: !U.isThemeId(cur) }];
    items.push({ label: 'Light themes', kind: vscode.QuickPickItemKind.Separator });
    for (const t of U.THEMES.filter((x) => !x.dark)) items.push({ label: t.name, description: `D2 theme ${t.id}${cur === t.id ? ' (current)' : ''}`, id: t.id });
    items.push({ label: 'Dark themes', kind: vscode.QuickPickItemKind.Separator });
    for (const t of U.THEMES.filter((x) => x.dark)) items.push({ label: t.name, description: `D2 theme ${t.id}${cur === t.id ? ' (current)' : ''}`, id: t.id });
    const pick = await vscode.window.showQuickPick(items, { title: `D2 theme for ${p.fileName}`, placeHolder: 'Only this preview changes. Your VS Code theme and settings stay as they are.', ignoreFocusOut: true });
    if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return undefined;
    await p.setView({ themeId: pick.id });
    return pick.id;
  }

  async pickLayout(p) {
    p = p || this.active();
    if (!p) return undefined;
    const v = p.view;
    const items = [
      { label: 'Direction: as the file says', description: v.direction ? '' : '(current)', patch: { direction: '' } },
      ...U.DIRECTIONS.map((d) => ({ label: `Direction: ${d}`, description: v.direction === d ? '(current)' : '', patch: { direction: d } })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: v.sketch ? 'Sketch style: turn off' : 'Sketch style: turn on', description: 'hand-drawn look', patch: { sketch: !v.sketch } },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Layout of ${p.fileName} (dagre engine)`, placeHolder: 'Only this preview changes; the .d2 file stays as it is.', ignoreFocusOut: true });
    if (!pick || !pick.patch) return undefined;
    await p.setView(pick.patch);
    return pick.patch;
  }

  dispose() {
    for (const p of [...this.previews.values()]) p.panel.dispose();
    this.diagnostics.dispose();
    this.engine.dispose();
  }
}

module.exports = { PreviewManager, Preview, sizeText, VIEW_TYPE, EDITOR_TYPE, isD2, settings, renderFile, prepareSvg, dataUri, rootOf, D2_EXT, STATE_KEY };
