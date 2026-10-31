/*
 * woff.js - WOFF 1.0 container decoder.
 *
 * WOFF keeps each sfnt table individually deflated. Decoding it back to a
 * plain TrueType/OpenType byte stream lets the font parser work on one format
 * only, while still using the exact webfont bytes a browser would download.
 */

const native = globalThis.__qnode_native;

function u16(b, o) { return b[o] << 8 | b[o + 1]; }
function u32(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}

function align4(n) { return (n + 3) & ~3; }

/**
 * Decode WOFF bytes to an sfnt (TrueType/OpenType) byte stream. Plain sfnt
 * input is returned unchanged.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function decodeWOFF(bytes) {
  if (bytes[0] === 0x00 && bytes[1] === 0x01 &&
      bytes[2] === 0x00 && bytes[3] === 0x00)
    return bytes;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "wOFF")
    return bytes;

  const flavor = u32(bytes, 4);
  const numTables = u16(bytes, 12);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = String.fromCharCode(bytes[o], bytes[o + 1],
                                    bytes[o + 2], bytes[o + 3]);
    const offset = u32(bytes, o + 4);
    const compLength = u32(bytes, o + 8);
    const origLength = u32(bytes, o + 12);
    let data;
    if (compLength < origLength) {
      data = native.zlibDecompress(
        bytes.subarray(offset, offset + compLength), 15);
      if (data.length !== origLength)
        throw new Error("woff: bad table length for " + tag);
    } else {
      data = bytes.subarray(offset, offset + origLength);
    }
    tables.push({ tag, data });
  }

  const headerSize = 12 + numTables * 16;
  let cursor = headerSize;
  for (const t of tables) {
    t.offset = cursor;
    cursor += align4(t.data.length);
  }

  const file = new Uint8Array(cursor);
  const dv = new DataView(file.buffer);
  dv.setUint32(0, flavor);
  dv.setUint16(4, numTables);
  let pow = 1, sel = 0;
  while (pow * 2 <= numTables) { pow *= 2; sel++; }
  dv.setUint16(6, pow * 16);
  dv.setUint16(8, sel);
  dv.setUint16(10, numTables * 16 - pow * 16);

  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++)
      file[o + k] = t.tag.charCodeAt(k);
    dv.setUint32(o + 4, 0);
    dv.setUint32(o + 8, t.offset);
    dv.setUint32(o + 12, t.data.length);
    file.set(t.data, t.offset);
  }
  return file;
}
