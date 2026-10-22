import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal PNG codec for visual verification.
 *
 * The browser tool needs to compare screenshots without pulling in an image library: PNG is the
 * only format both Playwright and agent-browser return, and Node already ships zlib. This decodes
 * the 8-bit, non-interlaced PNGs those tools produce (gray, RGB, gray+alpha, RGBA) into RGBA and
 * writes RGBA PNGs for diff images.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A decoded screenshot larger than this is a mistake, not a UI. */
const MAX_PIXELS = 40_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Decode a PNG into RGBA pixels. Throws a readable error for unsupported encodings. */
export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG image');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + len;
    if (end + 4 > buf.length) throw new Error('truncated PNG chunk');
    const data = buf.subarray(start, end);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('invalid PNG header');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      interlace = data[12] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${String(bitDepth)} (need 8)`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (width * height > MAX_PIXELS) {
    throw new Error(`PNG is too large to compare (${String(width)}x${String(height)})`);
  }
  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${String(colorType)}`);
  if (!idat.length) throw new Error('PNG has no image data');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error('PNG image data is truncated');

  const pixels = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos] ?? 0;
    pos++;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++] ?? 0;
      const left = x >= channels ? (pixels[rowStart + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[prevStart + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[prevStart + x - channels] ?? 0) : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter ${String(filter)}`);
      }
      pixels[rowStart + x] = out & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  if (channels === 4) {
    rgba.set(pixels);
  } else {
    for (let i = 0, j = 0; i < pixels.length; i += channels, j += 4) {
      if (channels === 1) {
        const g = pixels[i] ?? 0;
        rgba[j] = g;
        rgba[j + 1] = g;
        rgba[j + 2] = g;
        rgba[j + 3] = 255;
      } else if (channels === 2) {
        const g = pixels[i] ?? 0;
        rgba[j] = g;
        rgba[j + 1] = g;
        rgba[j + 2] = g;
        rgba[j + 3] = pixels[i + 1] ?? 255;
      } else {
        rgba[j] = pixels[i] ?? 0;
        rgba[j + 1] = pixels[i + 1] ?? 0;
        rgba[j + 2] = pixels[i + 2] ?? 0;
        rgba[j + 3] = 255;
      }
    }
  }
  return { width, height, data: rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode RGBA pixels as a PNG (8-bit, non-interlaced, no filtering). */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) throw new Error('RGBA data does not match the size');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = data[y * stride + x] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The pixel at (x, y), composited over white so transparent screenshots compare sensibly. */
export function pixelAt(image: RgbaImage, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [255, 255, 255];
  const i = (y * image.width + x) * 4;
  const r = image.data[i] ?? 0;
  const g = image.data[i + 1] ?? 0;
  const b = image.data[i + 2] ?? 0;
  const a = image.data[i + 3] ?? 255;
  const blend = (c: number): number => Math.round((c * a + 255 * (255 - a)) / 255);
  return [blend(r), blend(g), blend(b)];
}
