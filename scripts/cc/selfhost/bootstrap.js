/**
 * Runtime bootstrap for the self-hosted C compiler.
 *
 * Defines the small Node.js surface the compiler relies on: `Buffer`,
 * `process` and a `console` fallback. Native file/process helpers are
 * installed by the C host as `globalThis.__cc_native`.
 *
 * @module cc/selfhost/bootstrap
 */

const native = globalThis.__cc_native;

function utf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i += 1) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i += 1;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Buffer(bytes);
}

function utf8Decode(buf, start, end) {
  let out = '';
  let i = start;
  while (i < end) {
    const b0 = buf[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      const b1 = buf[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if (b0 < 0xf0) {
      const b1 = buf[i++] & 0x3f;
      const b2 = buf[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = buf[i++] & 0x3f;
      const b2 = buf[i++] & 0x3f;
      const b3 = buf[i++] & 0x3f;
      out += String.fromCodePoint(((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3);
    }
  }
  return out;
}

class Buffer extends Uint8Array {
  static alloc(size, fill = 0) {
    const buf = new Buffer(size);
    if (fill !== 0) buf.fill(fill);
    return buf;
  }

  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') {
      return encodeString(value, encodingOrOffset || 'utf8');
    }
    if (value instanceof ArrayBuffer) {
      const offset = encodingOrOffset || 0;
      const size = length === undefined ? value.byteLength - offset : length;
      return new Buffer(value, offset, size);
    }
    if (value && ArrayBuffer.isView(value)) {
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const copy = new Buffer(view.length);
      copy.set(view);
      return copy;
    }
    if (Array.isArray(value)) return new Buffer(value);
    if (value && typeof value.length === 'number') return new Buffer(value);
    throw new TypeError('Buffer.from: unsupported input');
  }

  toString(encoding = 'utf8', start = 0, end = this.length) {
    const from = Math.max(0, start | 0);
    const to = Math.min(this.length, end | 0);
    switch (String(encoding).toLowerCase()) {
      case 'utf8':
      case 'utf-8':
        return utf8Decode(this, from, to);
      case 'latin1':
      case 'binary': {
        let out = '';
        for (let i = from; i < to; i += 1) out += String.fromCharCode(this[i]);
        return out;
      }
      case 'hex': {
        let out = '';
        for (let i = from; i < to; i += 1) out += this[i].toString(16).padStart(2, '0');
        return out;
      }
      default:
        throw new Error(`Buffer.toString: unsupported encoding '${encoding}'`);
    }
  }

  readUInt8(offset = 0) {
    return this[offset];
  }

  readUInt16LE(offset = 0) {
    return this[offset] | (this[offset + 1] << 8);
  }

  readUInt32LE(offset = 0) {
    return (
      (this[offset] |
        (this[offset + 1] << 8) |
        (this[offset + 2] << 16) |
        (this[offset + 3] << 24)) >>>
      0
    );
  }

  readUInt32BE(offset = 0) {
    return (
      ((this[offset] << 24) |
        (this[offset + 1] << 16) |
        (this[offset + 2] << 8) |
        this[offset + 3]) >>>
      0
    );
  }

  readBigUInt64LE(offset = 0) {
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }

  readBigInt64LE(offset = 0) {
    const value = this.readBigUInt64LE(offset);
    return value >= 9223372036854775808n ? value - 18446744073709551616n : value;
  }

  writeUInt8(value, offset = 0) {
    this[offset] = value & 0xff;
    return offset + 1;
  }

  writeUInt16LE(value, offset = 0) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    return offset + 2;
  }

  writeUInt32LE(value, offset = 0) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    this[offset + 2] = (value >> 16) & 0xff;
    this[offset + 3] = (value >> 24) & 0xff;
    return offset + 4;
  }

  writeBigUInt64LE(value, offset = 0) {
    let v = BigInt(value) & 0xffffffffffffffffn;
    for (let i = 0; i < 8; i += 1) {
      this[offset + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return offset + 8;
  }

  writeBigInt64LE(value, offset = 0) {
    return this.writeBigUInt64LE(BigInt(value), offset);
  }

  writeFloatLE(value, offset = 0) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat32(offset, value, true);
    return offset + 4;
  }

  writeDoubleLE(value, offset = 0) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat64(offset, value, true);
    return offset + 8;
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const chunk = this.subarray(sourceStart, sourceEnd);
    target.set(chunk, targetStart);
    return chunk.length;
  }
}

function encodeString(str, encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return utf8Encode(str);
    case 'latin1':
    case 'binary': {
      const buf = new Buffer(str.length);
      for (let i = 0; i < str.length; i += 1) buf[i] = str.charCodeAt(i) & 0xff;
      return buf;
    }
    case 'hex': {
      const buf = new Buffer(str.length >> 1);
      for (let i = 0; i < buf.length; i += 1) buf[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
      return buf;
    }
    default:
      throw new Error(`Buffer.from: unsupported encoding '${encoding}'`);
  }
}

globalThis.Buffer = Buffer;

const args = globalThis.__cc_argv || [];

globalThis.process = {
  argv: ['cc', 'cc.js', ...args],
  env: new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== 'string') return undefined;
        return native.getenv(name);
      },
      has(_target, name) {
        return typeof name === 'string' && native.getenv(name) !== undefined;
      },
    },
  ),
  platform: 'linux',
  cwd: () => native.cwd(),
  exit: (code = 0) => native.exit(code | 0),
  stdout: {
    write: (text) => native.write(1, String(text)),
    isTTY: false,
  },
  stderr: {
    write: (text) => native.write(2, String(text)),
    isTTY: false,
  },
};

if (typeof globalThis.console !== 'object' || globalThis.console === null) {
  globalThis.console = {};
}
if (typeof globalThis.console.error !== 'function') {
  globalThis.console.error = (...values) => {
    native.write(2, values.map(String).join(' ') + '\n');
  };
}
if (typeof globalThis.console.warn !== 'function') {
  globalThis.console.warn = globalThis.console.error;
}
if (typeof globalThis.console.log !== 'function') {
  globalThis.console.log = (...values) => {
    native.write(1, values.map(String).join(' ') + '\n');
  };
}
