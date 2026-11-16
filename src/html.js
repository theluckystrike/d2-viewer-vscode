'use strict';
// Webview HTML for the D2 preview (side panel and the D2 Diagram Viewer editor). No vscode import, so tests can check
// the CSP: default-src 'none', no remote origin, no connect-src, scripts only with the page nonce, pictures only from
// the extension (cspSource) or data: URIs (the diagram is a data: SVG drawn by the extension host).
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'zovoD2';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce), nonce? } */
function previewHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="D2 preview">
  <span class="file" id="file" title="${attr(p.title)}">${attr(p.title)}</span>
  <select id="board" class="hidden" title="Board: the root board, layers, scenarios and steps" aria-label="Board"></select>
  <span class="seg" role="group" aria-label="Zoom">
    <button id="zoomOut" title="Zoom out (-)">&#8722;</button><button id="zoomReset" title="Actual size (1)">100%</button><button id="zoomIn" title="Zoom in (+)">+</button><button id="fit" title="Fit the diagram in the view (0)">Fit</button>
  </span>
  <button id="theme" title="D2 theme of this preview (your VS Code theme stays as it is)">Theme</button>
  <button id="layout" title="Layout direction and sketch style for this preview">Layout</button>
  <button id="copySvg" title="Copy the diagram as SVG text">Copy SVG</button>
  <button id="showSource" title="Show the .d2 text next to the preview">Source</button>
  <span id="stats" class="stats" aria-live="polite"></span>
</div>
<div id="problem" class="hidden" role="alert"></div>
<main id="app"><div id="viewport" tabindex="0" aria-label="Diagram. Drag to pan, wheel to zoom, click a shape to go to its line."><div id="stage"><img id="diagram" alt="D2 diagram" draggable="false"><div id="hl" class="hidden"></div></div><p id="notice" class="notice">Drawing the diagram...</p></div></main>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { previewHtml, csp, PREFIX };
