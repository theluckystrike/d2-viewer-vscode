// D2 Diagram Viewer preview (webview side). The extension host compiles and renders the diagram with the bundled D2
// engine and sends it here as a data: SVG. This page only shows it: pan, zoom, fit, the board pick, click-to-line
// (hit test on the shape boxes the host sends) and turning an SVG into a PNG for exports (canvas, on request).
// No network: the page CSP has default-src 'none'.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport'), stage = $('stage'), img = $('diagram'), hl = $('hl'), notice = $('notice');
  const problem = $('problem'), stats = $('stats'), boardSel = $('board');
  const tpl = $('zovo-footer');
  if (tpl && tpl.innerHTML.trim()) $('footer').innerHTML = tpl.innerHTML;

  let box = null; // diagram coordinates of the SVG: { x, y, w, h }
  let shapes = [];
  let view = { s: 1, tx: 0, ty: 0 };
  let fitted = false;
  let lastVersion = 0;
  let boardKey = '';
  let hlTimer = null;

  function apply() {
    if (!box) return;
    img.style.width = Math.max(1, box.w * view.s) + 'px';
    img.style.height = Math.max(1, box.h * view.s) + 'px';
    stage.style.transform = `translate(${Math.round(view.tx)}px, ${Math.round(view.ty)}px)`;
    $('zoomReset').textContent = Math.round(view.s * 100) + '%';
    vscode.setState({ view, boardKey });
  }
  function fit() {
    if (!box) return;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const s = Math.max(0.02, Math.min((vw - 24) / box.w, (vh - 24) / box.h, 2));
    view = { s, tx: (vw - box.w * s) / 2, ty: Math.max(8, (vh - box.h * s) / 2) };
    apply();
  }
  function zoomAt(f, cx, cy) {
    const s = Math.max(0.02, Math.min(view.s * f, 16));
    const k = s / view.s;
    view = { s, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k };
    apply();
  }
  const center = () => [viewport.clientWidth / 2, viewport.clientHeight / 2];
  $('zoomIn').addEventListener('click', () => zoomAt(1.25, ...center()));
  $('zoomOut').addEventListener('click', () => zoomAt(0.8, ...center()));
  $('zoomReset').addEventListener('click', () => { const [cx, cy] = center(); zoomAt(1 / view.s, cx, cy); });
  $('fit').addEventListener('click', fit);
  $('theme').addEventListener('click', () => vscode.postMessage({ type: 'pickTheme' }));
  $('layout').addEventListener('click', () => vscode.postMessage({ type: 'pickLayout' }));
  $('copySvg').addEventListener('click', () => vscode.postMessage({ type: 'copySvg' }));
  $('showSource').addEventListener('click', () => vscode.postMessage({ type: 'showSource' }));
  boardSel.addEventListener('change', () => vscode.postMessage({ type: 'selectBoard', path: boardSel.value }));
  problem.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-line]');
    if (a) vscode.postMessage({ type: 'openLine', line: Number(a.dataset.line), file: a.dataset.file || '' });
  });

  viewport.addEventListener('wheel', (e) => {
    if (!box) return;
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    else { view.tx -= e.deltaX; apply(); }
  }, { passive: false });

  function toDiagram(clientX, clientY) {
    const r = img.getBoundingClientRect();
    if (!box || !r.width || !r.height) return null;
    return { x: box.x + ((clientX - r.left) / r.width) * box.w, y: box.y + ((clientY - r.top) / r.height) * box.h };
  }
  function hit(p) {
    if (!p) return null;
    let best = null;
    for (const s of shapes) {
      if (p.x < s.x || p.y < s.y || p.x > s.x + s.w || p.y > s.y + s.h) continue;
      if (!best || s.z > best.z || (s.z === best.z && s.w * s.h < best.w * best.h)) best = s;
    }
    return best;
  }
  function flash(s) {
    if (!box) return;
    hl.style.left = ((s.x - box.x) * view.s - 3) + 'px';
    hl.style.top = ((s.y - box.y) * view.s - 3) + 'px';
    hl.style.width = (s.w * view.s + 2) + 'px';
    hl.style.height = (s.h * view.s + 2) + 'px';
    hl.dataset.id = s.id;
    hl.classList.remove('hidden');
    clearTimeout(hlTimer);
    hlTimer = setTimeout(() => hl.classList.add('hidden'), 1500);
  }

  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !box) return;
    drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false, id: e.pointerId };
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; viewport.classList.add('dragging'); }
      if (drag.moved) { view.tx = drag.tx + dx; view.ty = drag.ty + dy; apply(); }
      return;
    }
    const s = hit(toDiagram(e.clientX, e.clientY));
    viewport.classList.toggle('over-shape', !!(s && s.line >= 0));
    viewport.title = s ? `${s.id}${s.line >= 0 ? ` (line ${s.line + 1}): click to go to its line` : ''}` : '';
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    viewport.classList.remove('dragging');
    try { viewport.releasePointerCapture(d.id); } catch (err) { /* released */ }
    if (!d.moved && e.type === 'pointerup') {
      const s = hit(toDiagram(e.clientX, e.clientY));
      if (s) { flash(s); vscode.postMessage({ type: 'reveal', id: s.id, line: s.line }); }
    }
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') { zoomAt(1.25, ...center()); e.preventDefault(); }
    else if (e.key === '-') { zoomAt(0.8, ...center()); e.preventDefault(); }
    else if (e.key === '0') { fit(); e.preventDefault(); }
    else if (e.key === '1') { const [cx, cy] = center(); zoomAt(1 / view.s, cx, cy); e.preventDefault(); }
  });
  window.addEventListener('resize', () => { if (box && !fitted) fit(); });

  function setBoards(list, current) {
    const usable = (list || []).filter((b) => !b.folder || b.path === '');
    boardSel.classList.toggle('hidden', usable.length < 2);
    const key = usable.map((b) => b.path).join('\u0001');
    if (boardSel.dataset.key !== key) {
      boardSel.textContent = '';
      for (const b of usable) {
        const o = document.createElement('option');
        o.value = b.path;
        o.textContent = b.path ? `${' '.repeat(Math.max(0, b.depth - 1))}${b.kind.replace(/s$/, '')}: ${b.name}` : 'Root board';
        boardSel.appendChild(o);
      }
      boardSel.dataset.key = key;
    }
    boardSel.value = current || '';
  }

  function showProblem(html, isNote) {
    problem.innerHTML = html;
    problem.classList.toggle('note', !!isNote);
    problem.classList.toggle('hidden', !html);
  }
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'render') {
      const firstOfBoard = !box || m.board !== boardKey;
      box = m.box; shapes = m.shapes || []; lastVersion = m.version;
      boardKey = m.board || '';
      setBoards(m.boards, m.board);
      document.body.classList.remove('has-error');
      document.body.dataset.theme = String(m.themeId);
      $('theme').textContent = 'Theme: ' + m.themeName;
      $('layout').textContent = 'Layout: ' + m.layoutName;
      stats.textContent = m.stats || '';
      showProblem(m.note ? escHtml(m.note) : '', true);
      notice.classList.add('hidden');
      await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = m.src; });
      if (firstOfBoard || !fitted) { fit(); fitted = true; } else apply();
      img.dataset.version = String(m.version);
      vscode.postMessage({ type: 'rendered', version: m.version, w: img.naturalWidth, h: img.naturalHeight });
    } else if (m.type === 'error') {
      document.body.classList.toggle('has-error', !!img.getAttribute('src'));
      const items = (m.errors || []).map((e) => e.line >= 0 ? `<a data-line="${e.line}" data-file="${escHtml(e.file || '')}">${escHtml(e.text)}</a>` : escHtml(e.text));
      showProblem(items.join('\n') + (img.getAttribute('src') ? '\n<span class="keep">The last good drawing stays below until the text is fixed.</span>' : ''), false);
      if (!img.getAttribute('src')) { notice.textContent = 'Nothing to draw yet: fix the error above.'; notice.classList.remove('hidden'); }
      stats.textContent = m.stats || '';
      vscode.postMessage({ type: 'errorShown', version: m.version });
    } else if (m.type === 'notice') {
      box = null; shapes = [];
      img.removeAttribute('src');
      showProblem('', false);
      notice.textContent = m.text;
      notice.classList.remove('hidden');
      stats.textContent = '';
    } else if (m.type === 'busy') {
      if (m.on) stats.textContent = 'Drawing...';
    } else if (m.type === 'rasterize') {
      vscode.postMessage(await rasterize(m));
    }
  });

  /** SVG (data: URL) -> PNG at m.scale. Very large pictures are drawn at a smaller scale that a canvas can hold. */
  async function rasterize(m) {
    try {
      const im = new Image();
      await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = () => reject(new Error('the SVG could not be drawn')); im.src = m.src; });
      if (im.decode) { try { await im.decode(); } catch (e) { /* drawn anyway */ } }
      let scale = Number(m.scale) || 1;
      const w0 = Number(m.width) || im.naturalWidth || 1, h0 = Number(m.height) || im.naturalHeight || 1;
      const maxSide = 16384, maxArea = 120e6;
      scale = Math.min(scale, maxSide / w0, maxSide / h0, Math.sqrt(maxArea / (w0 * h0)));
      const cw = Math.max(1, Math.round(w0 * scale)), ch = Math.max(1, Math.round(h0 * scale));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const g = c.getContext('2d');
      if (m.background) { g.fillStyle = m.background; g.fillRect(0, 0, cw, ch); }
      g.drawImage(im, 0, 0, cw, ch);
      const url = c.toDataURL('image/png');
      return { type: 'raster', id: m.id, png: url.slice(url.indexOf(',') + 1), width: cw, height: ch, scale };
    } catch (e) {
      return { type: 'raster', id: m.id, error: String((e && e.message) || e) };
    }
  }

  const st = vscode.getState();
  if (st && st.view) { view = st.view; boardKey = st.boardKey || ''; }
  vscode.postMessage({ type: 'ready', board: boardKey });
})();
