'use strict';
// The file map the D2 engine compiles: the .d2 file and every .d2 file it imports (`x: @lib/part`, `...@base`),
// read from open editors first (unsaved text included) and from disk otherwise. Paths are relative to a root folder
// (the workspace folder, else the file's folder) with "/" separators; imports outside the root stay out, so the
// engine reports them as missing. No vscode import.
const path = require('path');
const fs = require('fs');
const { importsOf } = require('./d2util');

const MAX_FILES = 300;
const MAX_BYTES = 4 * 1048576;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };

const toKey = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const inside = (root, abs) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function readDisk(abs) {
  try { const st = fs.statSync(abs); if (!st.isFile() || st.size > MAX_BYTES) return null; return fs.readFileSync(abs, 'utf8'); } catch (e) { return null; }
}

/**
 * o: { file (absolute path), text, root, read?(abs) -> string | null (open editor text first) }
 * -> { files: { key: text }, inputPath, keys: { key: absolute path } }
 */
function collectFiles(o) {
  const root = path.resolve(o.root || path.dirname(o.file));
  const file = path.resolve(o.file);
  const inputPath = inside(root, file) ? toKey(root, file) : path.basename(file);
  const files = { [inputPath]: o.text };
  const keys = { [inputPath]: file };
  const read = (abs) => { const t = o.read ? o.read(abs) : null; return typeof t === 'string' ? t : readDisk(abs); };
  const queue = [[file, o.text]];
  while (queue.length && Object.keys(files).length < MAX_FILES) {
    const [abs, text] = queue.shift();
    for (const imp of importsOf(text)) {
      const p = imp.replace(/\\/g, '/');
      const base = path.resolve(path.dirname(abs), p);
      const cands = /\.d2$/i.test(base) ? [base] : [base + '.d2', base];
      for (const c of cands) {
        if (!inside(root, c)) continue;
        const k = toKey(root, c);
        if (files[k] !== undefined) break;
        const t = read(c);
        if (typeof t !== 'string') continue;
        files[k] = t; keys[k] = c;
        queue.push([c, t]);
        break;
      }
    }
  }
  return { files, inputPath, keys, root };
}

/** A picture next to the .d2 file -> { mime, base64 } (inside root, up to 5 MB), else null. */
function readImage(rel, fromFile, root) {
  if (/^[a-z]+:/i.test(rel)) return null;
  const abs = path.resolve(path.dirname(fromFile), rel);
  if (!inside(path.resolve(root), abs)) return null;
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!MIME[ext]) return null;
  try { const st = fs.statSync(abs); if (!st.isFile() || st.size > 5 * 1048576) return null; return { mime: MIME[ext], base64: fs.readFileSync(abs).toString('base64') }; } catch (e) { return null; }
}

/** Does the D2 text set its own theme? { light, dark } from the d2-config vars. */
function fileThemes(text) {
  const t = String(text || '');
  return { light: /(^|[\s{;])theme-id\s*:/m.test(t), dark: /dark-theme-id\s*:/.test(t) };
}

module.exports = { collectFiles, readImage, fileThemes, toKey, inside, MIME };
