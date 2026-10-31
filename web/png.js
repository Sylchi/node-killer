/*
 * png.js - PNG decoding and encoding for the qnode renderer.
 *
 * The inflate/deflate work is delegated to the engine's zlib bindings
 * (native.zlibDecompress / native.zlibCompress), so this file only deals with
 * the container format, scanline filters and colour conversion.
 */

const native = globalThis.__qnode_native;

function u32(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}

function readChunks(bytes) {
  let p = 8;
  const out = [];
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5],
                                   bytes[p + 6], bytes[p + 7]);
    out.push({ type, data: bytes.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === "IEND")
      break;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc)
    return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      let a = 0, b = 0, c = 0;
      if (x >= channels) a = out[row + x - channels];
      if (y > 0) b = out[prev + x];
      if (y > 0 && x >= channels) c = out[prev + x - channels];
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error("png: bad filter " + filter);
      }
      out[row + x] = r & 0xff;
    }
    src += stride;
  }
  return out;
}

/**
 * Decode a PNG file into 8-bit RGBA pixels.
 * @param {Uint8Array} bytes
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
export function decodePNG(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50)
    throw new Error("png: bad signature");
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr)
    throw new Error("png: missing IHDR");
  const d = ihdr.data;
  const width = u32(d, 0), height = u32(d, 4);
  const depth = d[8], colorType = d[9], interlace = d[12];
  if (depth !== 8)
    throw new Error("png: unsupported bit depth " + depth);
  if (interlace !== 0)
    throw new Error("png: interlaced images are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels)
    throw new Error("png: unsupported colour type " + colorType);

  let palette = null, trns = null;
  const idat = [];
  for (const c of chunks) {
    if (c.type === "PLTE")
      palette = c.data;
    else if (c.type === "tRNS")
      trns = c.data;
    else if (c.type === "IDAT")
      idat.push(c.data);
  }
  let total = 0;
  for (const part of idat)
    total += part.length;
  const compressed = new Uint8Array(total);
  let p = 0;
  for (const part of idat) {
    compressed.set(part, p);
    p += part.length;
  }
  const raw = native.zlibDecompress(compressed, 15);
  const pixels = unfilter(raw, width, height, channels);

  const data = new Uint8Array(width * height * 4);
  const stride = width * channels;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const out = y * width * 4;
    for (let x = 0; x < width; x++) {
      const o = out + x * 4;
      if (colorType === 6) {
        data[o] = pixels[row + x * 4];
        data[o + 1] = pixels[row + x * 4 + 1];
        data[o + 2] = pixels[row + x * 4 + 2];
        data[o + 3] = pixels[row + x * 4 + 3];
      } else if (colorType === 2) {
        data[o] = pixels[row + x * 3];
        data[o + 1] = pixels[row + x * 3 + 1];
        data[o + 2] = pixels[row + x * 3 + 2];
        data[o + 3] = 255;
      } else if (colorType === 3) {
        const idx = pixels[row + x];
        data[o] = palette[idx * 3];
        data[o + 1] = palette[idx * 3 + 1];
        data[o + 2] = palette[idx * 3 + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const v = pixels[row + x];
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      } else {
        const v = pixels[row + x * 2];
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = pixels[row + x * 2 + 1];
      }
    }
  }
  return { width, height, data };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++)
    out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = native.crc32(out.subarray(4, 8 + data.length), 0);
  dv.setUint32(8 + data.length, crc >>> 0);
  return out;
}

/**
 * Encode 8-bit RGBA pixels as a PNG. Scanlines use filter 0; the image is
 * compressed with zlib's default strategy.
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride),
            y * (stride + 1) + 1);
  }
  const compressed = native.zlibCompress(raw, 15, 6, 8, 0);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ];
  let total = 0;
  for (const part of parts)
    total += part.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
