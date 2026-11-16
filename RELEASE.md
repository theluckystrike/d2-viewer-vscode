# D2 Diagram Viewer & D2 Preview 0.1.0 (zovo.zovo-d2-viewer)

New listing, staged only. NICHE6 row 1, built by lane NEWB13.

- vsix: out/NEWB13-dist/zovo.zovo-d2-viewer/zovo.zovo-d2-viewer-0.1.0.vsix
- sha256: 6cbc566a2b116646cfa00cf42f2bb39ccac72da31de0ae16ca6a1f779b8a6f0e (7,433,236 bytes, 43 files under extension/)
- Product repo: factory/products/d2-viewer-vscode, local commits only (no remote).
- Unit tests: 235 of 235 pass with `npm test` (scripts/test.js, Node test runner). They cover error parsing, boards, shape lines and hit tests, SVG picture handling, imports, the PNG reader and PDF writer, the TextMate grammar (tokenized with vscode-textmate), the bundled engine (boards, animated SVG, errors, themes, ELK fallback, imports, timeout restart), the extension and both Pro tools with a vscode stub (file A then file B for each tool, and a reload that keeps the count), and the license and rating tests copied by apply.sh.
- Real-app gate: VS Code 1.142.0 on port 9441 through buildslot, run r4 on this exact vsix: 79 PASS, 0 FAIL, 0 SKIP (out/NEWB13-data/d2/d2-gate-r4.json and .tsv, screenshots out/NEWB13-data/d2/shots/d2-r4-*.png). Earlier runs: r1 on dev1.vsix (51 PASS, 26 FAIL), r2 on dev2.vsix (77 PASS, 2 FAIL), r3 on dev2.vsix (79 PASS, 0 FAIL, the README screenshot).

## What it is

- Display name: D2 Diagram Viewer & D2 Preview (30 characters), the phrase "D2" first. Keywords: d2, d2 diagram, diagram, architecture diagram, diagram as code. Engines ^1.75.0.
- Free core: the d2 language with our own grammar, a live preview beside the editor that redraws as you type, pan, zoom, Fit and 100%, a D2 theme that follows the VS Code light or dark theme, a D2 theme pick and layout direction or sketch style for one preview (no setting written, no color theme contributed), errors as squiggles with the line number and a clickable line in the preview, click a shape to jump to its line, a board list for layers, scenarios and steps, Copy SVG, local pictures inlined, and an optional D2 Diagram Viewer editor (priority option). The diagram is drawn by the D2 engine v0.7.0 built for WebAssembly (npm @terrastruct/d2 0.1.33, MPL-2.0, files unmodified in lib/d2), in a worker thread. No D2 binary is started and nothing is fetched.
- Zovo Pro tools (1 free try each, module 2026-11-15.tries1, listing tag "d2", tries key zovoD2.proTrial, TRIAL_USES = 1 in src/pro.js):
  - Export PNG, PDF and SVG: PNG at 1x to 4x, PDF, SVG, with scale, padding and theme; the board on screen or every board (separate files, one PDF page per board) or one animated SVG.
  - Batch export: every .d2 file of a folder to SVG in docs/diagrams (or a chosen folder), structure kept, failures listed, with a watch mode stopped from the status bar.
- Nothing pops up on open or activation. The Pro panel shows only after a click on a Pro tool with no tries left.

## Samples used

- Shipped: samples/shop-architecture.d2 (ours: 13 shapes, 9 connections, 1 layer, 3 steps).
- Gate files made by the gate (ours): SAMPLE.D2 (upper-case extension), picture.d2 with a local PNG and a web icon, broken files (syntax error, binary data, a 103 KB file over a 64 KB limit set in the gate, a file asking for ELK), batch folders.
- Real files (local test data, not shipped, never executed):
  - D2 repository github.com/terrastruct/d2, MPL-2.0: docs/examples/twitter/in.d2, chess/dia.d2, wcc/wcc.d2, japan-grid/japan.d2, flipt/input.d2.
  - D2 documentation github.com/terrastruct/d2-docs, BSD-3-Clause: static/d2/sequence-diagrams-1.d2, tables-1.d2, classes.d2, markdown.d2, grid.d2, c4-models.d2, tooltip.d2, code.d2, latex.d2, imports-normal.d2, imports-normal-x.d2, and static/bespoke-d2/animated.d2.

## Gate coverage (r4)

Nothing opens or pops up on start. A .d2 file opens as language D2 with our grammar colors (comment, arrow, keyword, shape value and label each checked). The title button opens the preview beside the editor; the gate checks the drawn SVG (labels, dark theme background, D2 version), the board list, the theme, pan and zoom with the mouse, a mouse click on a shape that moves the editor cursor to its line, typing and Cmd+Z redrawing the preview, a change on disk, the theme pick (settings.json unchanged, VS Code stays dark), the layout pick (file unchanged), the "deploy" layer, and Copy SVG on the clipboard. A syntax error shows its line in the preview, as a squiggle and in the Problems count, and the error line click jumps to line 3. 16 real D2 files draw without an error. Web icons are left out with a note, local pictures are inlined, ELK files are drawn with dagre and say so, a too-big file and a binary file give a plain warning. The Explorer right-click on SAMPLE.D2 and on a folder offers the Zovo Pro entries. For each Pro tool, file or folder A runs fully and its output is checked (PNG at 2x read by PIL; three SVG files in docs/diagrams with their labels, the failure named, watch mode re-render and stop), and file or folder B then opens the Pro panel with nothing written. The info tab shows "1 free try left" before and "no free tries left" after. After a restart the counts stay used. A TEST key through the license link turns Pro on, and then the PDF of every board (5 pages, read by macOS sips) and the animated SVG are checked. No error toasts, CSP errors, webview network requests, extension-host sockets, webview console errors or opened URLs.

## Defects found and fixed in the gate runs

- Product: shape values such as "cylinder" had a scope that default themes do not color, and labels had no scope, so both looked like plain text. Shape values are now entity.name.type.shape.d2 and unquoted labels string.unquoted.label.d2 (unit test added).
- Product (small): the size message for a file over the limit said "0.1 MB" for a 103 KB file. It now gives KB below 1 MB, and the limit counts bytes.
- Gate: the Explorer stayed closed after the screenshot step (17 failures in r1 came from that); Enter sent over CDP adds no newline in the editor; the board check read the select value before the redraw; the theme list only renders visible rows; the imports file has 3 shapes, not 2; PIL is not visible to python3 -I (our own output files are now read without -I); an SVG image without width has a natural width of 300; the zoom baseline was read before the side bar came back; Cmd+Z undoes one typed word at a time.

## Known limits

- Layout is dagre only: the ELK file of the npm package (EPL-2.0) is left out and TALA is not part of it. A file asking for ELK is drawn with dagre, with a note.
- Pictures from the web are not loaded (no network). PNG and PDF exports are pictures; a PDF page has the size of the diagram.
- 2 of the 4 Pro tools in the row were built (export, batch export). Markdown fences and Diagram diff were not.
- The gate drove Save dialogs through VS Code's simple file dialog (files.simpleDialog.enable), not the native macOS dialog.
- The README screenshot shows the sash between the editor groups highlighted, because the gate had just dragged it.
