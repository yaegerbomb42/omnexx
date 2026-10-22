import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, pixelAt, type RgbaImage } from '../../../src/browser/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC is not checked by the decoder, so tests can build chunks without computing it. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function png(
  width: number,
  height: number,
  colorType: number,
  rows: readonly Buffer[],
  over: { bitDepth?: number; interlace?: number } = {},
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = over.bitDepth ?? 8;
  header[9] = colorType;
  header[12] = over.interlace ?? 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const image = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data };
};

describe('PNG codec', () => {
  it('round-trips RGBA pixels', () => {
    const source = image(2, 2, (x, y) => [x * 10, y * 20, 200, 255]);
    const decoded = decodePng(encodePng(source));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(source.data));
  });

  it('decodes gray, gray+alpha, RGB and RGBA color types', () => {
    const gray = decodePng(png(2, 1, 0, [Buffer.from([0, 128, 200])]));
    expect(pixelAt(gray, 0, 0)).toEqual([128, 128, 128]);
    expect(pixelAt(gray, 1, 0)).toEqual([200, 200, 200]);

    const grayAlpha = decodePng(png(1, 1, 4, [Buffer.from([0, 90, 100])]));
    expect(grayAlpha.data[0]).toBe(90);
    expect(grayAlpha.data[3]).toBe(100);

    const rgb = decodePng(png(1, 1, 2, [Buffer.from([0, 1, 2, 3])]));
    expect(Array.from(rgb.data)).toEqual([1, 2, 3, 255]);

    const rgba = decodePng(png(1, 1, 6, [Buffer.from([0, 4, 5, 6, 7])]));
    expect(Array.from(rgba.data)).toEqual([4, 5, 6, 7]);
  });

  it('undoes every PNG row filter', () => {
    // One channel wide, so "left" is always 0 and the expected values are easy to state.
    const decoded = decodePng(
      png(1, 5, 0, [
        Buffer.from([0, 10]), // none
        Buffer.from([1, 5]), // sub
        Buffer.from([2, 3]), // up: 3 + 5
        Buffer.from([3, 4]), // average: 4 + floor((0 + 8) / 2)
        Buffer.from([4, 2]), // paeth: 2 + up (8)
      ]),
    );
    expect([0, 1, 2, 3, 4].map((y) => pixelAt(decoded, 0, y)[0])).toEqual([10, 5, 8, 8, 10]);
  });

  it('rejects images it cannot compare', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('not a PNG image');
    expect(() => decodePng(Buffer.alloc(4))).toThrow('not a PNG image');

    const badDepth = png(1, 1, 0, [Buffer.from([0, 1])], { bitDepth: 16 });
    expect(() => decodePng(badDepth)).toThrow('unsupported PNG bit depth 16');

    const interlaced = png(1, 1, 0, [Buffer.from([0, 1])], { interlace: 1 });
    expect(() => decodePng(interlaced)).toThrow('interlaced PNGs are not supported');

    expect(() => decodePng(png(1, 1, 3, [Buffer.from([0, 1])]))).toThrow(
      'unsupported PNG color type 3',
    );

    const unknownFilter = png(1, 1, 0, [Buffer.from([9, 1])]);
    expect(() => decodePng(unknownFilter)).toThrow('unknown PNG filter 9');

    const headerOnly = Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(5))]);
    expect(() => decodePng(headerOnly)).toThrow('invalid PNG header');

    const headerNoData = Buffer.alloc(13);
    headerNoData.writeUInt32BE(1, 0);
    headerNoData.writeUInt32BE(1, 4);
    headerNoData[8] = 8;
    headerNoData[9] = 0;
    const noData = Buffer.concat([
      SIGNATURE,
      chunk('IHDR', headerNoData),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => decodePng(noData)).toThrow('PNG has no image data');
    expect(() => decodePng(Buffer.concat([SIGNATURE, chunk('IEND', Buffer.alloc(0))]))).toThrow(
      'PNG has no IHDR',
    );

    const tooLarge = png(7_000, 7_000, 6, []);
    expect(() => decodePng(tooLarge)).toThrow('too large to compare');

    const truncated = encodePng(image(2, 2, () => [1, 2, 3, 255])).subarray(0, 40);
    expect(() => decodePng(truncated)).toThrow(/truncated PNG chunk|PNG has no image data/);
  });

  it('rejects malformed or undersized RGBA buffers on encode', () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(4) })).toThrow(
      'RGBA data does not match the size',
    );
  });

  it('composites transparent pixels over white and treats out-of-bounds as white', () => {
    const transparent = image(1, 1, () => [0, 0, 0, 0]);
    expect(pixelAt(transparent, 0, 0)).toEqual([255, 255, 255]);
    expect(pixelAt(transparent, -1, 0)).toEqual([255, 255, 255]);
    expect(pixelAt(transparent, 0, 1)).toEqual([255, 255, 255]);

    const halfBlack = image(1, 1, () => [0, 0, 0, 128]);
    expect(pixelAt(halfBlack, 0, 0)).toEqual([127, 127, 127]);

    expect(decodePng(encodePng(transparent)).data[3]).toBe(0);
  });
});
