'use strict';
// A small PNG reader for the PNGs the preview's canvas makes (8-bit RGBA or RGB, not interlaced), and a writer used
// by the tests. The PDF export reads the canvas PNG, puts the pixels on the background colour and stores them as RGB.
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunks(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error('the PNG file is cut short');
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** -> { width, height, channels (3 or 4), data: Buffer of width*height*channels } */
function decodePng(buf) {
  const cs = chunks(buf);
  const ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('the PNG has no header');
  const width = ihdr.data.readUInt32BE(0), height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8], color = ihdr.data[9], interlace = ihdr.data[12];
  if (depth !== 8 || (color !== 6 && color !== 2) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, color type ${color}, interlace ${interlace})`);
  const ch = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * ch;
  if (raw.length < height * (stride + 1)) throw new Error('the PNG pixel data is cut short');
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= ch ? out[dst + x - ch] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= ch && y > 0 ? out[prev + x - ch] : 0;
      let r;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error('bad PNG filter ' + f);
      }
      out[dst + x] = r & 255;
    }
  }
  return { width, height, channels: ch, data: out };
}

/** RGBA or RGB pixels -> RGB on a background colour [r, g, b]. */
function toRgb(img, bg = [255, 255, 255]) {
  if (img.channels === 3) return img.data;
  const n = img.width * img.height, out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round(img.data[i * 4 + k] * a + bg[k] * (1 - a));
  }
  return out;
}

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

/** RGBA pixels -> PNG (filter 0). */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Width and height from the PNG header, or null. */
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = { decodePng, toRgb, encodePng, pngSize, crc32 };
