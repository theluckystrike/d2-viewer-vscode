'use strict';
// A minimal PDF writer: one page per picture, the page the size of the picture (CSS pixels at 96 dpi -> points), the
// picture an RGB image stream (Flate). Enough for diagram exports; text in the PDF is part of the picture.
const zlib = require('zlib');

/**
 * pages: [{ widthPt, heightPt, image: { width, height, rgb: Buffer } , title? }]
 * meta: { title?, producer? } -> Buffer (PDF 1.4)
 */
function makePdf(pages, meta = {}) {
  if (!pages.length) throw new Error('no pages');
  const objs = []; // index = object number - 1
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const kids = [];
  for (const pg of pages) {
    const { width, height, rgb } = pg.image;
    if (rgb.length !== width * height * 3) throw new Error('image size does not match its pixels');
    const data = zlib.deflateSync(rgb);
    const img = add({ stream: data, dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>` });
    const w = num(pg.widthPt), h = num(pg.heightPt);
    const content = Buffer.from(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`, 'latin1');
    const cont = add({ stream: content, dict: `<< /Length ${content.length} >>` });
    const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${cont} 0 R >>`);
    kids.push(page);
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Producer ${pdfString(meta.producer || 'D2 Diagram Viewer for VS Code by Zovo')}${meta.title ? ` /Title ${pdfString(meta.title)}` : ''} >>`);
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const body = typeof o === 'string' ? Buffer.from(o + '\n', 'latin1') : Buffer.concat([Buffer.from(o.dict + '\nstream\n', 'latin1'), o.stream, Buffer.from('\nendstream\n', 'latin1')]);
    const tail = Buffer.from('endobj\n', 'latin1');
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n') + '\n';
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(parts);
}

const num = (n) => (Math.round(Number(n) * 100) / 100).toString();

/** A PDF text string: ASCII as (...), anything else as UTF-16BE hex. */
function pdfString(s) {
  const t = String(s);
  if (/^[\x20-\x7e]*$/.test(t)) return '(' + t.replace(/[\\()]/g, '\\$&') + ')';
  const b = Buffer.from('﻿' + t, 'utf16le');
  for (let i = 0; i < b.length; i += 2) { const x = b[i]; b[i] = b[i + 1]; b[i + 1] = x; }
  return '<' + b.toString('hex') + '>';
}

/** Page count and media boxes of a PDF made here (for tests and the gate). */
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const boxes = [...s.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [+m[1], +m[2]]);
  const count = /\/Count (\d+)/.exec(s);
  return { header: s.slice(0, 8), pages: count ? +count[1] : 0, boxes, images: (s.match(/\/Subtype \/Image/g) || []).length, eof: /%%EOF\n?$/.test(s) };
}

module.exports = { makePdf, pdfString, pdfInfo };
