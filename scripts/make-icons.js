// Dependency-free PNG icon generator (power glyph on a dark rounded tile).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x + 0.5, y + 0.5); raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed-distance helpers (in unit coordinates 0..1), anti-aliased by coverage.
const cover = (d, px) => Math.max(0, Math.min(1, 0.5 - d / px));
function icon(size, { rounded, scale }) {
  const px = 1 / size;
  return png(size, (X, Y) => {
    const x = X / size, y = Y / size;
    // background: vertical gradient
    const t = y;
    const bg = [Math.round(18 + 22 * t), Math.round(24 + 30 * t), Math.round(40 + 60 * t)];
    // rounded-square mask (iOS applies its own mask to apple-touch-icon, so that one is full-bleed)
    let a = 1;
    if (rounded) {
      const r = 0.22, dx = Math.abs(x - 0.5) - (0.5 - r), dy = Math.abs(y - 0.5) - (0.5 - r);
      const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
      a = cover(d, px);
    }
    // power glyph: ring with a gap at the top + vertical bar
    const s = scale, cx = 0.5, cy = 0.53, R = 0.24 * s, w = 0.045 * s;
    const px_ = (x - cx), py_ = (y - cy);
    const rd = Math.hypot(px_, py_);
    let ring = cover(Math.abs(rd - R) - w, px);
    const ang = Math.atan2(px_, -py_); // 0 at top
    if (Math.abs(ang) < 0.62 && py_ < 0) ring = 0;
    // round caps at the gap edges
    for (const sgn of [-1, 1]) {
      const ex = cx + R * Math.sin(sgn * 0.62), ey = cy - R * Math.cos(sgn * 0.62);
      ring = Math.max(ring, cover(Math.hypot(x - ex, y - ey) - w, px));
    }
    const top = cy - R - 0.04 * s, bot = cy - 0.03 * s;
    const t2 = Math.max(0, Math.min(1, (y - top) / (bot - top)));
    const bar = cover(Math.hypot(x - cx, y - (top + t2 * (bot - top))) - w, px);
    const g = Math.max(ring, bar);
    const fg = [255, 255, 255];
    const col = bg.map((c, i) => Math.round(c * (1 - g) + fg[i] * g));
    return [...col, Math.round(a * 255)];
  });
}

const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192, { rounded: true, scale: 1 }));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512, { rounded: true, scale: 1 }));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), icon(512, { rounded: false, scale: 0.8 }));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), icon(180, { rounded: false, scale: 0.9 }));
console.log('icons written to', out);
