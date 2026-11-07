// Minimal PNG decoder for 8-bit RGB images, used by the benchmark to read AWS Terrarium
// elevation tiles (256x256, colour type 2, non-interlaced) and turn them into metres.
"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");

const BYTES_PER_PIXEL = 3;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TERRARIUM_OFFSET = 32768;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readChunks(file) {
  if (file.length < PNG_SIGNATURE.length || !file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  let offset = PNG_SIGNATURE.length;
  let header = null;
  const idat = [];
  while (offset < file.length) {
    if (offset + 8 > file.length) throw new Error("truncated PNG chunk header");
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8, dataEnd = dataStart + length;
    if (dataEnd + 4 > file.length) throw new Error("truncated PNG chunk " + type);
    if (type === "IHDR") header = file.subarray(dataStart, dataEnd);
    else if (type === "IDAT") idat.push(file.subarray(dataStart, dataEnd));
    else if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  return { header, idat };
}

function decodePngRgb(filePath) {
  const { header, idat } = readChunks(fs.readFileSync(filePath));
  if (!header || header.length !== 13) throw new Error("missing or malformed IHDR");
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  const bitDepth = header[8], colorType = header[9];
  const compression = header[10], filterMethod = header[11], interlace = header[12];
  if (colorType !== 2) throw new Error("unsupported colour type " + colorType + " (expected 2, RGB)");
  if (bitDepth !== 8) throw new Error("unsupported bit depth " + bitDepth + " (expected 8)");
  if (interlace !== 0) throw new Error("unsupported interlace " + interlace + " (expected 0)");
  if (compression !== 0 || filterMethod !== 0) {
    throw new Error("unsupported compression/filter method " + compression + "/" + filterMethod);
  }
  if (idat.length === 0) throw new Error("no IDAT chunks");

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * BYTES_PER_PIXEL;
  if (inflated.length !== (stride + 1) * height) {
    throw new Error("inflated size " + inflated.length + ", expected " + (stride + 1) * height);
  }

  const rgb = new Uint8Array(stride * height);
  const emptyRow = new Uint8Array(stride);
  let position = 0;
  for (let row = 0; row < height; row++) {
    const filterType = inflated[position++];
    const raw = inflated.subarray(position, position + stride);
    position += stride;
    const current = rgb.subarray(row * stride, (row + 1) * stride);
    const prior = row > 0 ? rgb.subarray((row - 1) * stride, row * stride) : emptyRow;
    switch (filterType) {
      case 0:
        current.set(raw);
        break;
      case 1:
        for (let i = 0; i < stride; i++) {
          current[i] = raw[i] + (i >= BYTES_PER_PIXEL ? current[i - BYTES_PER_PIXEL] : 0);
        }
        break;
      case 2:
        for (let i = 0; i < stride; i++) current[i] = raw[i] + prior[i];
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= BYTES_PER_PIXEL ? current[i - BYTES_PER_PIXEL] : 0;
          current[i] = raw[i] + ((left + prior[i]) >> 1);
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const left = i >= BYTES_PER_PIXEL ? current[i - BYTES_PER_PIXEL] : 0;
          const upLeft = i >= BYTES_PER_PIXEL ? prior[i - BYTES_PER_PIXEL] : 0;
          current[i] = raw[i] + paethPredictor(left, prior[i], upLeft);
        }
        break;
      default:
        throw new Error("unknown PNG filter " + filterType + " on scanline " + row);
    }
  }
  return { width, height, rgb };
}

// Terrarium packs metres as R*256 + G + B/256 - 32768; the worker's tiles are whole
// metres, so round. Int16 cannot hold the full range; clamp to its ends.
function terrariumToInt16(rgb) {
  if (rgb.length % BYTES_PER_PIXEL !== 0) {
    throw new Error("RGB byte count " + rgb.length + " is not a multiple of " + BYTES_PER_PIXEL);
  }
  const heights = new Int16Array(rgb.length / BYTES_PER_PIXEL);
  for (let pixel = 0; pixel < heights.length; pixel++) {
    const base = pixel * BYTES_PER_PIXEL;
    const metres = Math.round(rgb[base] * 256 + rgb[base + 1] + rgb[base + 2] / 256 - TERRARIUM_OFFSET);
    heights[pixel] = Math.min(INT16_MAX, Math.max(INT16_MIN, metres));
  }
  return heights;
}

module.exports = { decodePngRgb, terrariumToInt16 };
