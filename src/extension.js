'use strict';
// D2 Diagram Viewer & D2 Preview by Zovo: the d2 language (our own TextMate grammar), a live preview beside the editor
// and an optional "D2 Diagram Viewer" editor, drawn by the official D2 engine built for WebAssembly and bundled in
// lib/d2 (no D2 install, no binary started, no network). Errors show as squiggles. No telemetry. Activation shows
// nothing: no message, no popup, no editor. The preview opens only from the editor title button, the Explorer menu
// or the Command Palette. No color theme is contributed and no setting is ever written.
const vscode = require('vscode');
const { PreviewManager, VIEW_TYPE, EDITOR_TYPE, isD2 } = require('./preview');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'zovoD2';
const EXT_ID = 'zovo.zovo-d2-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'D2 Diagram Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const previews = new PreviewManager(context, {
    reach: () => reach,
    onSuccess: (uri) => rating.success(uri),
    onFailure: () => rating.failure(),
  });
  sub({ dispose: () => previews.dispose() });
  const tools = createTools({ context, pro, previews });
  sub({ dispose: () => tools.dispose() });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const targetUri = (arg) => {
    if (arg && arg.scheme) return arg;
    const ed = vscode.window.activeTextEditor;
    if (ed && isD2(ed.document)) return ed.document.uri;
    const p = previews.active();
    return p ? p.uri : null;
  };
  const openCmd = (side) => async (arg) => {
    const uri = targetUri(arg);
    if (!uri) { vscode.window.showInformationMessage('Open a .d2 file first, then open its preview.'); return undefined; }
    const ed = vscode.window.activeTextEditor;
    const col = side ? vscode.ViewColumn.Beside : (ed ? ed.viewColumn : vscode.ViewColumn.Active);
    return previews.open(uri, col);
  };
  const target = (uri) => (uri && uri.scheme ? uri : undefined);

  sub(vscode.window.registerCustomEditorProvider(EDITOR_TYPE, {
    resolveCustomTextEditor: (document, panel) => { previews.resolveEditor(document, panel); },
  }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));

  reg(`${PREFIX}.showPreviewToSide`, openCmd(true));
  reg(`${PREFIX}.showPreview`, openCmd(false));
  reg(`${PREFIX}.openViewer`, async (arg) => { const uri = targetUri(arg); if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, EDITOR_TYPE); });
  reg(`${PREFIX}.showSource`, async () => { const p = previews.active(); if (p) await p.showSource(-1); });
  reg(`${PREFIX}.copySvg`, async () => previews.copySvg(previews.active()));
  reg(`${PREFIX}.pickTheme`, async () => previews.pickTheme(previews.active()));
  reg(`${PREFIX}.pickLayout`, async () => previews.pickLayout(previews.active()));
  reg(`${PREFIX}.openSample`, async () => {
    const uri = vscode.Uri.joinPath(context.extensionUri, 'samples', 'shop-architecture.d2');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    return previews.open(uri, vscode.ViewColumn.Beside);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.export`, reach.wrap((uri) => tools.exportTool(target(uri))));
  reg(`${PREFIX}.batchExport`, reach.wrap((uri) => tools.batchTool(target(uri))));
  reg(`${PREFIX}.stopWatch`, () => tools.stopWatch(false));

  sub(vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length && isD2(e.document)) previews.changed(e.document.uri); }));
  sub(vscode.workspace.onDidSaveTextDocument((d) => { if (isD2(d)) previews.changed(d.uri); }));
  if (vscode.window.onDidChangeActiveColorTheme) sub(vscode.window.onDidChangeActiveColorTheme(() => previews.redrawAll()));
  sub(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh();
    if (e.affectsConfiguration(`${PREFIX}.showSupportLinks`)) previews.reloadAll();
    else if (e.affectsConfiguration(`${PREFIX}.preview`)) previews.redrawAll();
    if (e.affectsConfiguration(`${PREFIX}.renderTimeoutSeconds`)) previews.engine.timeoutMs = Math.max(3, Math.min(600, Number(setting('renderTimeoutSeconds', 20)) || 20)) * 1000;
  }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { previews, tools, pro, reach, VIEW_TYPE };
}

function deactivate() {}

module.exports = { activate, deactivate };
