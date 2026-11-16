'use strict';
// The two Zovo Pro tools. Export: PNG, PDF or SVG of one board or of every board (layers, scenarios, steps), or one
// animated SVG, with scale, padding and theme. Batch export: every .d2 file of a folder to SVG in an output folder,
// optionally watching for changes. Each tool asks pro.allowed() first and calls pro.produced() only after its files
// are on disk; Escape, Cancel or an error uses no try. PNG and PDF pixels come from the preview's canvas (the webview
// draws the engine's SVG); nothing leaves the computer.
const vscode = require('vscode');
const path = require('path');
const U = require('./core/d2util');
const { decodePng, toRgb } = require('./core/png');
const { makePdf } = require('./core/pdf');
const { renderFile, prepareSvg, isD2, D2_EXT, STATE_KEY, settings } = require('./preview');

const SECTION = 'zovoD2';
const EXCLUDE = '{**/node_modules/**,**/.git/**}';
const OPTS_KEY = 'zovoD2.exportOptions';
const pickOpts = (title, placeHolder) => ({ title, placeHolder, ignoreFocusOut: true });
const conf = () => vscode.workspace.getConfiguration(SECTION);

async function isFolder(uri) { try { return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory; } catch (e) { return false; } }

async function d2FilesIn(folder, skip) {
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{d2,D2}'), EXCLUDE, 20000);
  const seen = new Set();
  return found.filter((u) => D2_EXT.test(u.path) && !(skip && (u.fsPath === skip || u.fsPath.startsWith(skip + path.sep))) && !seen.has(u.toString()) && seen.add(u.toString()))
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

function createTools({ context, pro, previews }) {
  const out = { channel: null, watch: null };
  const channel = () => { if (!out.channel) out.channel = vscode.window.createOutputChannel('D2 Diagram Viewer'); return out.channel; };
  const viewOf = (uri) => Object.assign({ themeId: null, direction: '', sketch: false, board: '' }, (context.workspaceState.get(STATE_KEY) || {})[uri.toString()] || {});

  function targetFile(arg) {
    if (arg && arg.scheme) return arg;
    const p = previews && previews.active();
    if (p && p.panel.active) return p.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && isD2(ed.document)) return ed.document.uri;
    if (p) return p.uri;
    return null;
  }

  // ---------------- export ----------------

  function savedOptions() {
    const s = context.globalState.get(OPTS_KEY) || {};
    const c = conf();
    const scale = [1, 2, 3, 4].includes(Number(s.scale)) ? Number(s.scale) : Math.max(1, Math.min(4, Math.round(Number(c.get('export.scale', 2)) || 2)));
    const pad = Number.isFinite(Number(s.pad)) ? Math.max(0, Math.min(400, Number(s.pad))) : Math.max(0, Math.min(400, Number(c.get('export.padding', 100)) || 0));
    return { scale, pad, themeId: U.isThemeId(s.themeId) ? Number(s.themeId) : null };
  }

  async function exportTool(arg) {
    const target = targetFile(arg);
    if (!target) { vscode.window.showInformationMessage('Open a .d2 file, or right-click one in the Explorer, to export it.'); return undefined; }
    if (await isFolder(target)) return batchTool(target);
    if (!(await pro.allowed('export', arg))) return undefined;
    const view = viewOf(target);
    const first = await renderFile(previews.engine, { uri: target, view, board: '' });
    if (first.error) {
      const e = U.parseErrors(first.error, first.inputPath)[0];
      vscode.window.showErrorMessage(`D2 export: ${path.basename(target.fsPath)} has an error, so nothing was exported. ${U.errorText(e, true)}`);
      return undefined;
    }
    const boards = (first.boards || []).filter((b) => !b.folder);
    const multi = boards.length > 1;
    const base = path.basename(target.fsPath).replace(D2_EXT, '');
    const formats = [
      { label: 'PNG', description: 'picture, 1x to 4x', id: 'png', ext: '.png' },
      { label: 'PDF', description: multi ? 'one page per board' : 'one page', id: 'pdf', ext: '.pdf' },
      { label: 'SVG', description: 'vector, fonts inside', id: 'svg', ext: '.svg' },
    ];
    if (multi) formats.push({ label: 'Animated SVG', description: `all ${boards.length} boards in one SVG that steps through them`, id: 'anim', ext: '.svg' });
    const fmt = await vscode.window.showQuickPick(formats, pickOpts(`Export ${path.basename(target.fsPath)}`, 'Export to which format?'));
    if (!fmt) return undefined;
    let list = [view.board && boards.some((b) => b.path === view.board) ? view.board : ''];
    if (multi && fmt.id !== 'anim') {
      const cur = boards.find((b) => b.path === list[0]);
      const which = await vscode.window.showQuickPick([
        { label: `Only the board in the preview: ${cur && cur.path ? cur.path : 'root board'}`, id: 'one' },
        { label: `Every board (${boards.length})`, description: fmt.id === 'pdf' ? 'one PDF page each' : `${boards.length} ${fmt.label} files`, id: 'all' },
      ], pickOpts(`Export ${path.basename(target.fsPath)} as ${fmt.label}`, 'This diagram has layers, scenarios or steps. Which boards?'));
      if (!which) return undefined;
      if (which.id === 'all') list = boards.map((b) => b.path);
    }
    // options: scale, padding, theme (remembered for the next export, never written to settings)
    const o = savedOptions();
    for (;;) {
      const themeLabel = o.themeId === null ? `as in the preview (${U.themeName(first.themeID)})` : U.themeName(o.themeId);
      const items = [
        { label: `$(check) Export with these options`, description: [fmt.id === 'svg' || fmt.id === 'anim' ? `size ${o.scale}x` : `scale ${o.scale}x`, `padding ${o.pad}`, `theme ${themeLabel}`].join(', '), id: 'go' },
        { label: 'Scale...', description: `${o.scale}x`, id: 'scale' },
        { label: 'Padding...', description: `${o.pad} px around the diagram`, id: 'pad' },
        { label: 'Theme...', description: themeLabel, id: 'theme' },
      ];
      const pick = await vscode.window.showQuickPick(items, pickOpts(`Export ${path.basename(target.fsPath)} as ${fmt.label}`, 'Press Enter to export, or change an option first.'));
      if (!pick) return undefined;
      if (pick.id === 'go') break;
      if (pick.id === 'scale') {
        const s = await vscode.window.showQuickPick([1, 2, 3, 4].map((n) => ({ label: `${n}x`, description: n === 2 ? 'sharp on most screens and in print' : n > 2 ? 'posters and slides' : 'actual size', n })), pickOpts('Scale', 'How large?'));
        if (s) o.scale = s.n;
      } else if (pick.id === 'pad') {
        const v = await vscode.window.showInputBox({ title: 'Padding', prompt: 'Pixels of empty space around the diagram (0 to 400)', value: String(o.pad), ignoreFocusOut: true, validateInput: (t) => (/^\d{1,3}$/.test(t.trim()) && Number(t) <= 400 ? null : 'A whole number from 0 to 400') });
        if (v !== undefined) o.pad = Number(v.trim());
      } else if (pick.id === 'theme') {
        const t = await vscode.window.showQuickPick([{ label: 'As in the preview', id: null }, ...U.THEMES.map((x) => ({ label: x.name, description: `D2 theme ${x.id}${x.dark ? ', dark' : ''}`, id: x.id }))], pickOpts('Theme of the export', 'Which D2 theme?'));
        if (t) o.themeId = t.id;
      }
    }
    await context.globalState.update(OPTS_KEY, { scale: o.scale, pad: o.pad, themeId: o.themeId });
    const one = fmt.id === 'pdf' || fmt.id === 'anim' || list.length === 1;
    const defName = base + (one && list[0] && fmt.id !== 'pdf' && fmt.id !== 'anim' ? U.boardFileName('', list[0]) : '') + (fmt.id === 'anim' ? '-animated' : '') + fmt.ext;
    const dest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(target.fsPath), defName)),
      filters: { [fmt.label]: [fmt.ext.slice(1)] },
      title: one ? `Save the ${fmt.label}` : `Save the ${list.length} ${fmt.label} files (one per board, named after this file)`,
    });
    if (!dest) return undefined;
    const ev = { ...view, ...(o.themeId !== null ? { themeId: o.themeId } : {}) };
    const render = { pad: o.pad };
    const written = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(target.fsPath)}` }, async (progress) => {
      const files = [];
      const stem = dest.fsPath.replace(/\.[^./\\]+$/, '');
      if (fmt.id === 'anim') {
        const ms = Math.max(200, Math.min(60000, Number(conf().get('export.animateIntervalMs', 1500)) || 1500));
        const r = await renderFile(previews.engine, { uri: target, view: ev, render: { ...render, ...(o.scale !== 1 ? { scale: o.scale } : {}) }, animate: ms });
        if (r.error) throw new Error(U.errorText(U.parseErrors(r.error, r.inputPath)[0], true));
        const svg = prepareLocal(r);
        await vscode.workspace.fs.writeFile(dest, Buffer.from(svg, 'utf8'));
        return [dest];
      }
      const r = await renderFile(previews.engine, { uri: target, view: ev, render: { ...render, ...(fmt.id === 'svg' && o.scale !== 1 ? { scale: o.scale } : {}) }, boards: list, board: list[0] });
      if (r.error) throw new Error(U.errorText(U.parseErrors(r.error, r.inputPath)[0], true));
      const nameOf = (b) => (list.length === 1 ? dest : vscode.Uri.file(U.boardFileName(stem, b) + fmt.ext));
      if (fmt.id === 'svg') {
        for (const x of r.svgs) { const u = nameOf(x.board); await vscode.workspace.fs.writeFile(u, Buffer.from(prepareLocal(r, x.svg), 'utf8')); files.push(u); }
        return files;
      }
      const rz = await previews.rasterizerFor(target);
      const pages = [];
      let k = 0;
      for (const x of r.svgs) {
        progress.report({ message: `${x.board || 'root board'} (${++k} of ${r.svgs.length})` });
        const shown = prepareSvg(x.svg, r.fsPath, r.root).svg;
        const png = await rz.rasterize(shown, o.scale);
        if (fmt.id === 'png') { const u = nameOf(x.board); await vscode.workspace.fs.writeFile(u, png.png); files.push(u); }
        else {
          const img = decodePng(png.png);
          pages.push({ widthPt: (img.width / png.scale) * 0.75, heightPt: (img.height / png.scale) * 0.75, image: { width: img.width, height: img.height, rgb: toRgb(img) } });
        }
      }
      if (fmt.id === 'pdf') { await vscode.workspace.fs.writeFile(dest, makePdf(pages, { title: base })); files.push(dest); }
      return files;
    }).then((x) => x, (e) => { vscode.window.showErrorMessage('D2 export failed: ' + ((e && e.message) || e)); return null; });
    if (!written || !written.length) return undefined;
    await pro.produced('export');
    const msg = written.length === 1 ? `Exported ${path.basename(written[0].fsPath)}.` : `Exported ${written.length} files: ${written.map((u) => path.basename(u.fsPath)).slice(0, 4).join(', ')}${written.length > 4 ? ', ...' : ''}.`;
    vscode.window.showInformationMessage(msg, 'Open').then((a) => { if (a === 'Open') vscode.commands.executeCommand('vscode.open', written[0]); }, () => {});
    return written;
  }

  /** Local pictures inside the exported SVG, so it works on its own. Web pictures stay as links. */
  function prepareLocal(r, svg) {
    const s = svg || r.svg;
    if (!r.root) return s;
    return U.inlineLocalImages(s, (rel) => require('./core/files').readImage(rel, r.fsPath, r.root)).svg;
  }

  // ---------------- batch export ----------------

  async function chooseFolder(arg) {
    if (arg && arg.scheme) {
      if (await isFolder(arg)) return arg;
      const wf = vscode.workspace.getWorkspaceFolder(arg);
      return wf ? wf.uri : vscode.Uri.file(path.dirname(arg.fsPath));
    }
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) return folders[0].uri;
    if (!folders.length) {
      const t = targetFile(null);
      return t && t.scheme === 'file' ? vscode.Uri.file(path.dirname(t.fsPath)) : null;
    }
    const pick = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), pickOpts('D2 batch export', 'Render the .d2 files of which folder?'));
    return pick ? pick.f.uri : null;
  }

  async function renderAll(folder, outDir, files, log) {
    const res = { ok: [], failed: [] };
    const themeId = U.isThemeId(conf().get('batch.theme', 0)) ? Number(conf().get('batch.theme', 0)) : 0;
    const pad = Math.max(0, Math.min(400, Number(conf().get('export.padding', 100)) || 0));
    for (const u of files) {
      const rel = path.relative(folder.fsPath, u.fsPath);
      const dest = vscode.Uri.file(path.join(outDir.fsPath, rel.replace(D2_EXT, '.svg')));
      const r = await renderFile(previews.engine, { uri: u, view: { themeId }, render: { pad }, dark: false });
      if (r.error) {
        const e = U.parseErrors(r.error, r.inputPath)[0];
        res.failed.push({ rel, error: U.errorText(e, true) });
        log(`FAIL ${rel}: ${U.errorText(e, true)}`);
        continue;
      }
      await vscode.workspace.fs.writeFile(dest, Buffer.from(prepareLocal(r), 'utf8'));
      res.ok.push({ rel, dest });
      log(`OK   ${rel} -> ${path.relative(folder.fsPath, dest.fsPath)} (${r.ms} ms)`);
    }
    return res;
  }

  async function batchTool(arg) {
    const folder = await chooseFolder(arg);
    if (!folder) { vscode.window.showInformationMessage('Open a folder with .d2 files first, then run the batch export.'); return undefined; }
    let outRel = String(conf().get('batch.outputFolder', 'docs/diagrams') || 'docs/diagrams').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'docs/diagrams';
    const files0 = await d2FilesIn(folder);
    if (!files0.length) { vscode.window.showInformationMessage(`No .d2 files in ${path.basename(folder.fsPath)}.`); return undefined; }
    if (!(await pro.allowed('batch', arg))) return undefined;
    let watch = false;
    for (;;) {
      const pick = await vscode.window.showQuickPick([
        { label: `Render ${files0.length} .d2 file${files0.length === 1 ? '' : 's'} to ${outRel} as SVG`, description: 'once', id: 'once' },
        { label: `Render to ${outRel} and keep watching`, description: 'a .d2 file renders again when it changes on disk', id: 'watch' },
        { label: 'Change the output folder...', description: outRel, id: 'folder' },
      ], pickOpts(`D2 batch export: ${path.basename(folder.fsPath)}`, 'The folder structure is kept; existing SVG files with the same name are replaced.'));
      if (!pick) return undefined;
      if (pick.id === 'folder') {
        const v = await vscode.window.showInputBox({ title: 'Output folder', prompt: `A folder inside ${path.basename(folder.fsPath)}, for example docs/diagrams`, value: outRel, ignoreFocusOut: true,
          validateInput: (t) => { const x = t.trim().replace(/\\/g, '/'); return !x || x.startsWith('/') || /^[a-z]:/i.test(x) || x.split('/').includes('..') ? 'A relative folder inside the workspace folder' : null; } });
        if (v !== undefined) outRel = v.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        continue;
      }
      watch = pick.id === 'watch';
      break;
    }
    const outDir = vscode.Uri.file(path.join(folder.fsPath, ...outRel.split('/')));
    const files = files0.filter((u) => !(u.fsPath.startsWith(outDir.fsPath + path.sep)));
    const ch = channel();
    ch.appendLine(`D2 batch export ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC: ${files.length} files from ${folder.fsPath} to ${outRel}`);
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Rendering ${files.length} .d2 files` }, () => renderAll(folder, outDir, files, (l) => ch.appendLine(l)))
      .then((x) => x, (e) => { vscode.window.showErrorMessage('D2 batch export failed: ' + ((e && e.message) || e)); return null; });
    if (!res) return undefined;
    if (!res.ok.length) {
      vscode.window.showErrorMessage(`D2 batch export: none of the ${files.length} files rendered. ${res.failed[0] ? res.failed[0].rel + ': ' + res.failed[0].error : ''}`, 'Show Details').then((a) => { if (a) ch.show(true); }, () => {});
      return res;
    }
    await pro.produced('batch');
    if (watch) startWatch(folder, outDir, outRel);
    const failed = res.failed.length ? ` ${res.failed.length} failed (${res.failed.slice(0, 2).map((f) => f.rel).join(', ')}${res.failed.length > 2 ? ', ...' : ''}): see Details.` : '';
    vscode.window.showInformationMessage(`Rendered ${res.ok.length} of ${files.length} .d2 files to ${outRel}.${failed}${watch ? ' Watching for changes.' : ''}`, 'Show Details').then((a) => { if (a) ch.show(true); }, () => {});
    return res;
  }

  function startWatch(folder, outDir, outRel) {
    stopWatch(true);
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{d2,D2}'));
    const timers = new Map();
    const ch = channel();
    const run = async (u) => {
      if (!D2_EXT.test(u.path) || u.fsPath.startsWith(outDir.fsPath + path.sep)) return;
      // the changed file and every file that imports it (by name)
      const all = await d2FilesIn(folder, outDir.fsPath);
      const stem = path.basename(u.fsPath).replace(D2_EXT, '');
      const targets = [];
      for (const f of all) {
        if (f.fsPath === u.fsPath) { targets.push(f); continue; }
        try { const t = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8'); if (t.includes('@') && t.includes(stem)) targets.push(f); } catch (e) { /* gone */ }
      }
      if (!targets.length) return;
      const res = await renderAll(folder, outDir, targets, (l) => ch.appendLine('watch ' + l));
      if (out.watch) { out.watch.runs++; out.watch.item.text = `$(eye) D2 watch: ${outRel}`; out.watch.item.tooltip = `Last render ${new Date().toLocaleTimeString()}: ${res.ok.length} ok, ${res.failed.length} failed. Click to stop watching.`; }
      if (out.watch && out.watch.onRun) out.watch.onRun(res);
    };
    const kick = (u) => { clearTimeout(timers.get(u.fsPath)); timers.set(u.fsPath, setTimeout(() => { timers.delete(u.fsPath); run(u).catch((e) => ch.appendLine('watch error: ' + ((e && e.message) || e))); }, 400)); };
    const subs = [w.onDidChange(kick), w.onDidCreate(kick), w];
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    item.text = `$(eye) D2 watch: ${outRel}`;
    item.tooltip = 'D2 batch export is watching .d2 files. Click to stop.';
    item.command = `${SECTION}.stopWatch`;
    item.show();
    out.watch = { folder, outDir, outRel, subs, item, timers, runs: 0, kick };
    vscode.commands.executeCommand('setContext', 'zovoD2.watching', true);
  }

  function stopWatch(quiet) {
    const w = out.watch;
    if (!w) { if (!quiet) vscode.window.setStatusBarMessage('D2: no batch watch is running.', 4000); return false; }
    out.watch = null;
    for (const t of w.timers.values()) clearTimeout(t);
    w.subs.forEach((s) => s.dispose());
    w.item.dispose();
    vscode.commands.executeCommand('setContext', 'zovoD2.watching', false);
    if (!quiet) vscode.window.setStatusBarMessage(`D2: stopped watching (${w.outRel}).`, 5000);
    return true;
  }

  function dispose() { stopWatch(true); if (out.channel) out.channel.dispose(); }

  return { exportTool, batchTool, stopWatch, dispose, get watching() { return out.watch; }, _test: { savedOptions, d2FilesIn } };
}

module.exports = { createTools, d2FilesIn };
