// Writes the PNG app icons (iOS needs PNG for the Home Screen icon).
// Same design as app/icon.svg, rasterized without dependencies.
// Usage: node scripts/make-icons.mjs

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../app/', import.meta.url);
const SIZES = [180, 192, 512];

// Indigo square with a white ink drop and an amber dot (the Inkwell theme).
const TOP = [0x4a, 0x4e, 0xe6];
const BOTTOM = [0x2a, 0x2d, 0xb0];
const DROP = [0xff, 0xfd, 0xf8];
const AMBER = [0xe8, 0xa3, 0x3d];

// The drop: a circle with a cone rising from it to a point (512-unit space).
const TIP = { x: 256, y: 92 };
const BULB = { x: 256, y: 300, r: 112 };
const HALF_ANGLE = Math.asin(BULB.r / (BULB.y - TIP.y));

function insideDrop(x, y) {
  if ((x - BULB.x) ** 2 + (y - BULB.y) ** 2 <= BULB.r ** 2) return true;
  if (y < TIP.y || y > BULB.y) return false;
  return Math.atan2(Math.abs(x - TIP.x), y - TIP.y) <= HALF_ANGLE;
}

// Colour at a point in 512-unit icon space; full-bleed (iOS rounds corners itself).
function colorAt(x, y) {
  if ((x - 300) ** 2 + (y - 322) ** 2 <= 34 ** 2) return AMBER;
  if (insideDrop(x, y)) return DROP;
  const t = (x + y) / 1024;
  return TOP.map((c, i) => Math.round(c + (BOTTOM[i] - c) * t));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const samples = 4; // 4x4 supersampling for smooth edges
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 512;
          const y = ((py + (sy + 0.5) / samples) / size) * 512;
          const c = colorAt(x, y);
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
      }
      for (let i = 0; i < 3; i++) row[1 + px * 3 + i] = Math.round(sum[i] / (samples * samples));
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  writeFileSync(new URL(`icon-${size}.png`, OUT), png(size));
  console.log(`wrote app/icon-${size}.png`);
}
