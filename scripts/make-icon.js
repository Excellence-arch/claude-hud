#!/usr/bin/env node
'use strict';
/**
 * Generates assets/tray.png and assets/tray-alert.png.
 *
 * Electron needs a real image file for the tray, and a hand-rolled encoder
 * keeps a binary blob out of the repo. Node ships zlib, so a minimal PNG
 * writer is only a few lines.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A filled circle with a soft edge, drawn by supersampling the coverage. */
function circle(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.42;
  const SS = 3; // samples per axis

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - 0.5;
          const py = y + (sy + 0.5) / SS - 0.5;
          if (Math.hypot(px - c, py - c) <= radius) hits++;
        }
      }
      const alpha = Math.round((hits / (SS * SS)) * 255);
      const i = (y * size + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

/**
 * A gauge-like ring, which is what the app icon wants to say: how full is it.
 * Supersampled for a clean edge at small sizes.
 */
function ring(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.26;
  const SS = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - 0.5;
          const py = y + (sy + 0.5) / SS - 0.5;
          const d = Math.hypot(px - c, py - c);
          if (d <= outer && d >= inner) hits++;
        }
      }
      const alpha = Math.round((hits / (SS * SS)) * 255);
      const i = (y * size + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

/**
 * An .ico is a small directory followed by image payloads, and each payload may
 * be a whole PNG file, so the encoder above is reused as-is. A 256px entry
 * records its size as 0, which is how the format expresses 256.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const payloads = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);   // colour planes
    e.writeUInt16LE(32, 6);  // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    payloads.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

function main() {
  const dir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(dir, { recursive: true });

  const BLUE = [122, 162, 247];
  const RED = [255, 138, 128];

  // Tray icons: a solid dot reads better than a ring at 16px.
  for (const [name, colour] of [['tray.png', BLUE], ['tray-alert.png', RED]]) {
    const png = encodePng(32, 32, circle(32, colour));
    fs.writeFileSync(path.join(dir, name), png);
    console.log(`wrote ${path.join('assets', name)} (${png.length} bytes)`);
  }

  // App icon: every size Windows asks for, from the taskbar to the Alt-Tab card.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => ({
    size,
    png: encodePng(size, size, size <= 20 ? circle(size, BLUE) : ring(size, BLUE)),
  }));
  const ico = encodeIco(images);
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
  console.log(`wrote ${path.join('assets', 'icon.ico')} (${ico.length} bytes, ${sizes.join('/')})`);

  // Kept alongside for any non-Windows packaging.
  const big = encodePng(256, 256, ring(256, BLUE));
  fs.writeFileSync(path.join(dir, 'icon.png'), big);
  console.log(`wrote ${path.join('assets', 'icon.png')} (${big.length} bytes)`);
}

main();
