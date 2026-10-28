/*
 * qnode bootstrap: Node.js-compatible runtime on quickjs-ng.
 *
 * Evaluated once at startup. It installs the Node globals (process, Buffer,
 * console, timers), the CommonJS loader, the node_modules resolver and the
 * builtin modules shared by `require()` and ESM `import`.
 *
 * Native primitives come from `__qnode_native` (node.c). The event loop is
 * libev, driven through the qjs:os read/write/timer handlers.
 */
import * as qjsos from "qjs:os";
import * as qjsstd from "qjs:std";

const native = globalThis.__qnode_native;
const C = globalThis.__qnode_consts;

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

const ERRNO_NAME = {
  1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 6: "ENXIO",
  7: "E2BIG", 8: "ENOEXEC", 9: "EBADF", 10: "ECHILD", 11: "EAGAIN",
  12: "ENOMEM", 13: "EACCES", 14: "EFAULT", 15: "ENOTBLK", 16: "EBUSY",
  17: "EEXIST", 18: "EXDEV", 19: "ENODEV", 20: "ENOTDIR", 21: "EISDIR",
  22: "EINVAL", 23: "ENFILE", 24: "EMFILE", 25: "ENOTTY", 26: "ETXTBSY",
  27: "EFBIG", 28: "ENOSPC", 29: "ESPIPE", 30: "EROFS", 31: "EMLINK",
  32: "EPIPE", 33: "EDOM", 34: "ERANGE", 36: "ENAMETOOLONG", 38: "ENOSYS",
  39: "ENOTEMPTY", 40: "ELOOP", 75: "EOVERFLOW", 88: "ENOTSOCK",
  89: "EDESTADDRREQ", 91: "EPROTOTYPE", 92: "ENOPROTOOPT",
  95: "EOPNOTSUPP", 97: "EAFNOSUPPORT", 98: "EADDRINUSE",
  99: "EADDRNOTAVAIL", 100: "ENETDOWN", 101: "ENETUNREACH",
  102: "ENETRESET", 103: "ECONNABORTED", 104: "ECONNRESET",
  105: "ENOBUFS", 106: "EISCONN", 107: "ENOTCONN", 108: "ESHUTDOWN",
  110: "ETIMEDOUT", 111: "ECONNREFUSED", 112: "EHOSTDOWN",
  113: "EHOSTUNREACH", 114: "EALREADY", 115: "EINPROGRESS",
};

const ERRNO_MESSAGE = {
  EPERM: "operation not permitted",
  ENOENT: "no such file or directory",
  EIO: "i/o error",
  EBADF: "bad file descriptor",
  EAGAIN: "resource temporarily unavailable",
  ENOMEM: "cannot allocate memory",
  EACCES: "permission denied",
  EFAULT: "bad address",
  EBUSY: "device or resource busy",
  EEXIST: "file already exists",
  EXDEV: "invalid cross-device link",
  ENODEV: "no such device",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EINVAL: "invalid argument",
  ENFILE: "too many open files in system",
  EMFILE: "too many open files",
  ENOTTY: "inappropriate ioctl for device",
  EFBIG: "file too large",
  ENOSPC: "no space left on device",
  ESPIPE: "invalid seek",
  EROFS: "read-only file system",
  EMLINK: "too many links",
  EPIPE: "broken pipe",
  ENAMETOOLONG: "name too long",
  ENOSYS: "function not implemented",
  ENOTEMPTY: "directory not empty",
  ELOOP: "too many symbolic links encountered",
  ENOTSOCK: "socket operation on non-socket",
  EADDRINUSE: "address already in use",
  EADDRNOTAVAIL: "address not available",
  ENETDOWN: "network is down",
  ENETUNREACH: "network is unreachable",
  ECONNABORTED: "software caused connection abort",
  ECONNRESET: "connection reset by peer",
  ENOBUFS: "no buffer space available",
  EISCONN: "transport endpoint is already connected",
  ENOTCONN: "transport endpoint is not connected",
  ESHUTDOWN: "cannot send after transport endpoint shutdown",
  ETIMEDOUT: "connection timed out",
  ECONNREFUSED: "connection refused",
  EHOSTUNREACH: "no route to host",
  EINPROGRESS: "operation now in progress",
  EOVERFLOW: "value too large for defined data type",
};

function errnoName(err) {
  return ERRNO_NAME[err] || "E" + err;
}

function errnoMessage(code) {
  return ERRNO_MESSAGE[code] || "unknown error";
}

function sysError(err, syscall, path) {
  const code = errnoName(err);
  const msg = code + ": " + errnoMessage(code) +
    (syscall ? ", " + syscall : "") +
    (path === undefined || path === null ? "" : " '" + path + "'");
  const e = new Error(msg);
  e.errno = -err;
  e.code = code;
  e.syscall = syscall;
  if (path !== undefined && path !== null)
    e.path = String(path);
  return e;
}

function check(res, syscall, path) {
  const v = res[0], err = res[1];
  if (err)
    throw sysError(err, syscall, path);
  return v;
}

/* ------------------------------------------------------------------ */
/* encodings                                                          */
/* ------------------------------------------------------------------ */

/* Encode a JS string to UTF-8 bytes, replacing lone surrogates. */
function utf8Encode(str) {
  const out = [];
  const n = str.length;
  for (let i = 0; i < n; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
        continue;
      }
      out.push(0xef, 0xbf, 0xbd);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f),
               0x80 | (c & 0x3f));
    }
  }
  return out;
}

/* Decode UTF-8 bytes, replacing malformed sequences with U+FFFD. */
function utf8Decode(buf, start, end) {
  let out = "", chunk = [];
  const push = (s) => {
    chunk.push(s);
    if (chunk.length >= 4096) {
      out += chunk.join("");
      chunk = [];
    }
  };
  let i = start;
  while (i < end) {
    const b0 = buf[i++];
    if (b0 < 0x80) {
      push(b0 === 10 || b0 === 13 || (b0 >= 32 && b0 < 127) ||
           b0 === 9 ? String.fromCharCode(b0) : String.fromCharCode(b0));
      continue;
    }
    let need, cp;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1; cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2; cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3; cp = b0 & 0x07;
    } else {
      push("\ufffd");
      continue;
    }
    let ok = true;
    for (let k = 0; k < need; k++) {
      if (i >= end) { ok = false; break; }
      const b = buf[i];
      if ((b & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (b & 0x3f);
      i++;
    }
    if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      push("\ufffd");
      continue;
    }
    if (cp < 0x10000) {
      push(String.fromCharCode(cp));
    } else {
      const v = cp - 0x10000;
      push(String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)));
    }
  }
  if (chunk.length)
    out += chunk.join("");
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) {
    t[B64.charCodeAt(i)] = i;
    t[B64URL.charCodeAt(i)] = i;
  }
  return t;
})();

function base64Encode(buf, start, end, url) {
  const table = url ? B64URL : B64;
  let out = "";
  let i = start;
  for (; i + 2 < end; i += 3) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] +
           table[(n >> 6) & 63] + table[n & 63];
  }
  const rem = end - i;
  if (rem === 1) {
    const n = buf[i] << 16;
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] +
           (url ? "" : "==");
  } else if (rem === 2) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8);
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] +
           table[(n >> 6) & 63] + (url ? "" : "=");
  }
  return out;
}

function base64Decode(str) {
  const out = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 61 /* = */)
      break;
    const v = B64_LOOKUP[c & 255];
    if (v < 0)
      continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return out;
}

function hexEncode(buf, start, end) {
  const H = "0123456789abcdef";
  let out = "";
  for (let i = start; i < end; i++)
    out += H[buf[i] >> 4] + H[buf[i] & 15];
  return out;
}

function hexDecode(str) {
  const out = [];
  let i = 0;
  if (str.length % 2) {
    const v = parseInt(str[0], 16);
    out.push(isNaN(v) ? 0 : v);
    i = 1;
  }
  for (; i + 1 < str.length; i += 2) {
    const v = parseInt(str.substr(i, 2), 16);
    out.push(isNaN(v) ? 0 : v);
  }
  return out;
}

function latin1Encode(str) {
  const out = new Array(str.length);
  for (let i = 0; i < str.length; i++)
    out[i] = str.charCodeAt(i) & 255;
  return out;
}

function latin1Decode(buf, start, end) {
  let out = "";
  for (let i = start; i < end; i += 4096) {
    const stop = Math.min(i + 4096, end);
    const codes = [];
    for (let j = i; j < stop; j++)
      codes.push(buf[j]);
    out += String.fromCharCode.apply(null, codes);
  }
  return out;
}

function utf16leEncode(str) {
  const out = new Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i * 2] = c & 255;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

function utf16leDecode(buf, start, end) {
  let out = "";
  for (let i = start; i + 1 < end; i += 2)
    out += String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  return out;
}

function normalizeEncoding(enc) {
  if (enc === undefined || enc === null)
    return "utf8";
  const e = String(enc).toLowerCase();
  switch (e) {
  case "utf8": case "utf-8": return "utf8";
  case "utf16le": case "utf-16le": case "ucs2": case "ucs-2": return "utf16le";
  case "latin1": case "binary": return "latin1";
  case "base64": return "base64";
  case "base64url": return "base64url";
  case "hex": return "hex";
  case "ascii": return "ascii";
  default: return null;
  }
}

function encodeString(str, enc) {
  switch (normalizeEncoding(enc)) {
  case "utf8": return utf8Encode(str);
  case "utf16le": return utf16leEncode(str);
  case "latin1": return latin1Encode(str);
  case "ascii": return latin1Encode(str);
  case "base64": return base64Decode(str);
  case "base64url": return base64Decode(str);
  case "hex": return hexDecode(str);
  default: throw new TypeError("Unknown encoding: " + enc);
  }
}

/* ------------------------------------------------------------------ */
/* Buffer                                                             */
/* ------------------------------------------------------------------ */

class Buffer extends Uint8Array {
  constructor(ab, byteOffset, length) {
    if (typeof ab !== "object" || ab === null ||
        (ab.constructor !== ArrayBuffer && !(ab instanceof ArrayBuffer))) {
      throw new TypeError("Buffer constructor requires an ArrayBuffer");
    }
    super(ab, byteOffset || 0, length);
  }

  static alloc(size, fill, encoding) {
    size = size >>> 0;
    const b = Buffer.allocUnsafe(size);
    if (fill !== undefined && fill !== 0 && size > 0) {
      if (typeof fill === "string")
        return b.fill(fill, 0, size, encoding);
      return b.fill(fill);
    }
    return b;
  }

  static allocUnsafe(size) {
    size = size >>> 0;
    const ab = new ArrayBuffer(size);
    return new Buffer(ab, 0, size);
  }

  static allocUnsafeSlow(size) {
    return Buffer.allocUnsafe(size);
  }

  static from(value, offsetOrEncoding, length) {
    if (typeof value === "string")
      return Buffer.fromString(value, offsetOrEncoding);
    if (value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== "undefined" &&
         value instanceof SharedArrayBuffer)) {
      const off = offsetOrEncoding === undefined ? 0 : (offsetOrEncoding >>> 0);
      const len = length === undefined
        ? Math.max(0, value.byteLength - off) : (length >>> 0);
      return new Buffer(value, off, len);
    }
    if (ArrayBuffer.isView(value)) {
      const b = Buffer.allocUnsafe(value.byteLength);
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        .forEach((v, i) => { b[i] = v; });
      return b;
    }
    if (Array.isArray(value) || typeof value === "object") {
      if (value && typeof value.length === "number") {
        const n = value.length >>> 0;
        const b = Buffer.allocUnsafe(n);
        for (let i = 0; i < n; i++)
          b[i] = value[i] & 255;
        return b;
      }
      if (value && value.type === "Buffer" && Array.isArray(value.data))
        return Buffer.from(value.data);
      throw new TypeError(
        "The first argument must be of type string or an instance of " +
        "Buffer, ArrayBuffer, or Array or an Array-like Object");
    }
    throw new TypeError("Unsupported Buffer.from argument");
  }

  static fromString(str, encoding) {
    const bytes = encodeString(str, encoding);
    const b = Buffer.allocUnsafe(bytes.length);
    b.set(bytes);
    return b;
  }

  static isBuffer(obj) {
    return obj instanceof Buffer;
  }

  static isEncoding(enc) {
    return normalizeEncoding(enc) !== null;
  }

  static byteLength(value, encoding) {
    if (typeof value === "string")
      return encodeString(value, encoding).length;
    if (ArrayBuffer.isView(value))
      return value.byteLength;
    if (value instanceof ArrayBuffer)
      return value.byteLength;
    throw new TypeError("The value must be a string, Buffer or ArrayBuffer");
  }

  static concat(list, totalLength) {
    if (!Array.isArray(list))
      throw new TypeError("list must be an Array of Buffers");
    if (totalLength === undefined) {
      totalLength = 0;
      for (const b of list)
        totalLength += b.length;
    }
    const out = Buffer.allocUnsafe(totalLength);
    let off = 0;
    for (const b of list) {
      if (off >= totalLength)
        break;
      const n = Math.min(b.length, totalLength - off);
      out.set(n === b.length ? b : b.subarray(0, n), off);
      off += n;
    }
    return out;
  }

  static compare(a, b) {
    return Buffer.from(a).compare(Buffer.from(b));
  }

  toString(encoding, start, end) {
    if (typeof encoding === "object" && encoding !== null) {
      start = encoding.start;
      end = encoding.end;
      encoding = encoding.encoding;
    }
    const enc = normalizeEncoding(encoding);
    if (enc === null)
      throw new TypeError("Unknown encoding: " + encoding);
    start = start === undefined ? 0 : Math.max(0, start | 0);
    end = end === undefined ? this.length : Math.min(this.length, end | 0);
    if (end <= start)
      return "";
    switch (enc) {
    case "utf8": return utf8Decode(this, start, end);
    case "utf16le": return utf16leDecode(this, start, end);
    case "latin1": case "ascii": return latin1Decode(this, start, end);
    case "base64": return base64Encode(this, start, end, false);
    case "base64url": return base64Encode(this, start, end, true);
    case "hex": return hexEncode(this, start, end);
    }
    return "";
  }

  toLocaleString() {
    return this.toString();
  }

  toJSON() {
    return { type: "Buffer", data: Array.from(this) };
  }

  equals(other) {
    if (!ArrayBuffer.isView(other) && !(other instanceof ArrayBuffer))
      return false;
    const o = other instanceof ArrayBuffer ? new Uint8Array(other) : other;
    if (o.length !== this.length)
      return false;
    for (let i = 0; i < this.length; i++)
      if (this[i] !== o[i])
        return false;
    return true;
  }

  compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
    const t = target instanceof ArrayBuffer
      ? new Uint8Array(target) : target;
    const a = this.subarray(sourceStart || 0,
                           sourceEnd === undefined ? this.length : sourceEnd);
    const b = t.subarray(targetStart || 0,
                        targetEnd === undefined ? t.length : targetEnd);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i])
        return a[i] < b[i] ? -1 : 1;
    }
    if (a.length === b.length)
      return 0;
    return a.length < b.length ? -1 : 1;
  }

  copy(target, targetStart, sourceStart, sourceEnd) {
    targetStart = targetStart === undefined ? 0 : targetStart | 0;
    sourceStart = sourceStart === undefined ? 0 : sourceStart | 0;
    sourceEnd = sourceEnd === undefined ? this.length : sourceEnd | 0;
    const n = Math.max(0, Math.min(sourceEnd - sourceStart,
                                   target.length - targetStart));
    for (let i = 0; i < n; i++)
      target[targetStart + i] = this[sourceStart + i];
    return n;
  }

  fill(value, start, end, encoding) {
    start = start === undefined ? 0 : start | 0;
    end = end === undefined ? this.length : end | 0;
    if (end <= start)
      return this;
    let bytes;
    if (typeof value === "string") {
      if (value.length === 0)
        return this;
      bytes = encodeString(value, encoding);
    } else if (typeof value === "number") {
      bytes = [value & 255];
    } else if (value instanceof Uint8Array) {
      if (value.length === 0)
        return this;
      bytes = value;
    } else {
      bytes = [0];
    }
    if (bytes.length === 1) {
      for (let i = start; i < end; i++)
        this[i] = bytes[0];
      return this;
    }
    for (let i = start, k = 0; i < end; i++, k = (k + 1) % bytes.length)
      this[i] = bytes[k];
    return this;
  }

  write(string, offset, length, encoding) {
    if (typeof offset === "string") {
      encoding = offset;
      offset = 0;
      length = this.length;
    } else {
      offset = offset === undefined ? 0 : offset | 0;
      if (typeof length === "string") {
        encoding = length;
        length = this.length - offset;
      } else {
        length = length === undefined ? this.length - offset : length | 0;
      }
    }
    const bytes = encodeString(String(string), encoding);
    const n = Math.min(bytes.length, Math.max(0, length),
                       this.length - offset);
    for (let i = 0; i < n; i++)
      this[offset + i] = bytes[i];
    return n;
  }

  slice(start, end) {
    return this.subarray(start, end);
  }

  subarray(start, end) {
    start = start === undefined ? 0 : start | 0;
    end = end === undefined ? this.length : end | 0;
    if (start < 0) start = Math.max(0, this.length + start);
    if (end < 0) end = Math.max(0, this.length + end);
    start = Math.min(start, this.length);
    end = Math.min(Math.max(end, start), this.length);
    return new Buffer(this.buffer, this.byteOffset + start, end - start);
  }

  indexOf(value, byteOffset, encoding) {
    if (typeof byteOffset === "string") {
      encoding = byteOffset;
      byteOffset = 0;
    }
    let needle;
    if (typeof value === "number")
      needle = [value & 255];
    else if (typeof value === "string")
      needle = encodeString(value, encoding);
    else if (value instanceof Uint8Array)
      needle = value;
    else
      throw new TypeError("value must be a string, number or Buffer");
    let i = byteOffset === undefined ? 0 : Math.max(0, byteOffset | 0);
    if (needle.length === 0)
      return Math.min(i, this.length);
    for (; i + needle.length <= this.length; i++) {
      let j = 0;
      while (j < needle.length && this[i + j] === needle[j])
        j++;
      if (j === needle.length)
        return i;
    }
    return -1;
  }

  lastIndexOf(value, byteOffset, encoding) {
    if (typeof byteOffset === "string") {
      encoding = byteOffset;
      byteOffset = undefined;
    }
    let needle;
    if (typeof value === "number")
      needle = [value & 255];
    else if (typeof value === "string")
      needle = encodeString(value, encoding);
    else
      needle = value;
    let i = byteOffset === undefined ? this.length - needle.length
                                     : Math.min(byteOffset | 0,
                                                this.length - needle.length);
    for (; i >= 0; i--) {
      let j = 0;
      while (j < needle.length && this[i + j] === needle[j])
        j++;
      if (j === needle.length)
        return i;
    }
    return -1;
  }

  includes(value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }

  readUInt8(o) { return this[o]; }
  readInt8(o) { const v = this[o]; return v & 0x80 ? v - 256 : v; }
  readUInt16LE(o) { return this[o] | (this[o + 1] << 8); }
  readUInt16BE(o) { return (this[o] << 8) | this[o + 1]; }
  readInt16LE(o) { const v = this.readUInt16LE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readInt16BE(o) { const v = this.readUInt16BE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readUInt32LE(o) {
    return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) +
      this[o + 3] * 0x1000000;
  }
  readUInt32BE(o) {
    return this[o] * 0x1000000 + ((this[o + 1] << 16) |
      (this[o + 2] << 8) | this[o + 3]);
  }
  readInt32LE(o) { return this.readUInt32LE(o) | 0; }
  readInt32BE(o) { return this.readUInt32BE(o) | 0; }
  readUIntLE(o, byteLength) {
    let v = 0, m = 1;
    for (let i = 0; i < byteLength; i++) { v += this[o + i] * m; m *= 256; }
    return v;
  }
  readUIntBE(o, byteLength) {
    let v = 0;
    for (let i = 0; i < byteLength; i++) v = v * 256 + this[o + i];
    return v;
  }
  readIntLE(o, n) { return this.readUIntLE(o, n); }
  readIntBE(o, n) { return this.readUIntBE(o, n); }
  readFloatLE(o) { return new DataView(this.buffer).getFloat32(this.byteOffset + o, true); }
  readFloatBE(o) { return new DataView(this.buffer).getFloat32(this.byteOffset + o, false); }
  readDoubleLE(o) { return new DataView(this.buffer).getFloat64(this.byteOffset + o, true); }
  readDoubleBE(o) { return new DataView(this.buffer).getFloat64(this.byteOffset + o, false); }
  readBigInt64LE(o) {
    const lo = this.readUInt32LE(o), hi = this.readInt32LE(o + 4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  readBigInt64BE(o) {
    const hi = this.readInt32BE(o), lo = this.readUInt32BE(o + 4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  readBigUInt64LE(o) {
    const lo = this.readUInt32LE(o), hi = this.readUInt32LE(o + 4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  readBigUInt64BE(o) {
    const hi = this.readUInt32BE(o), lo = this.readUInt32BE(o + 4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  writeUInt8(v, o) { this[o] = v & 255; return o + 1; }
  writeInt8(v, o) { this[o] = v & 255; return o + 1; }
  writeUInt16LE(v, o) { this[o] = v & 255; this[o + 1] = (v >> 8) & 255; return o + 2; }
  writeUInt16BE(v, o) { this[o] = (v >> 8) & 255; this[o + 1] = v & 255; return o + 2; }
  writeInt16LE(v, o) { return this.writeUInt16LE(v, o); }
  writeInt16BE(v, o) { return this.writeUInt16BE(v, o); }
  writeUInt32LE(v, o) {
    this[o] = v & 255; this[o + 1] = (v >> 8) & 255;
    this[o + 2] = (v >> 16) & 255; this[o + 3] = (v >>> 24) & 255;
    return o + 4;
  }
  writeUInt32BE(v, o) {
    this[o] = (v >>> 24) & 255; this[o + 1] = (v >> 16) & 255;
    this[o + 2] = (v >> 8) & 255; this[o + 3] = v & 255;
    return o + 4;
  }
  writeInt32LE(v, o) { return this.writeUInt32LE(v, o); }
  writeInt32BE(v, o) { return this.writeUInt32BE(v, o); }
  writeUIntLE(v, o, n) {
    for (let i = 0; i < n; i++) { this[o + i] = v & 255; v = Math.floor(v / 256); }
    return o + n;
  }
  writeUIntBE(v, o, n) {
    for (let i = n - 1; i >= 0; i--) { this[o + i] = v & 255; v = Math.floor(v / 256); }
    return o + n;
  }
  writeIntLE(v, o, n) { return this.writeUIntLE(v, o, n); }
  writeIntBE(v, o, n) { return this.writeUIntBE(v, o, n); }
  writeFloatLE(v, o) { new DataView(this.buffer).setFloat32(this.byteOffset + o, v, true); return o + 4; }
  writeFloatBE(v, o) { new DataView(this.buffer).setFloat32(this.byteOffset + o, v, false); return o + 4; }
  writeDoubleLE(v, o) { new DataView(this.buffer).setFloat64(this.byteOffset + o, v, true); return o + 8; }
  writeDoubleBE(v, o) { new DataView(this.buffer).setFloat64(this.byteOffset + o, v, false); return o + 8; }
  writeBigInt64LE(v, o) {
    this.writeUInt32LE(Number(v & 0xffffffffn), o);
    this.writeInt32LE(Number(v >> 32n), o + 4);
    return o + 8;
  }
  writeBigInt64BE(v, o) {
    this.writeInt32BE(Number(v >> 32n), o);
    this.writeUInt32BE(Number(v & 0xffffffffn), o + 4);
    return o + 8;
  }
  writeBigUInt64LE(v, o) {
    this.writeUInt32LE(Number(v & 0xffffffffn), o);
    this.writeUInt32LE(Number(v >> 32n), o + 4);
    return o + 8;
  }
  writeBigUInt64BE(v, o) {
    this.writeUInt32BE(Number(v >> 32n), o);
    this.writeUInt32BE(Number(v & 0xffffffffn), o + 4);
    return o + 8;
  }

  swap16() {
    for (let i = 0; i + 1 < this.length; i += 2) {
      const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t;
    }
    return this;
  }
  swap32() {
    for (let i = 0; i + 3 < this.length; i += 4) {
      let t = this[i]; this[i] = this[i + 3]; this[i + 3] = t;
      t = this[i + 1]; this[i + 1] = this[i + 2]; this[i + 2] = t;
    }
    return this;
  }
  swap64() {
    for (let i = 0; i + 7 < this.length; i += 8)
      for (let j = 0; j < 4; j++) {
        const t = this[i + j];
        this[i + j] = this[i + 7 - j];
        this[i + 7 - j] = t;
      }
    return this;
  }
}

Object.defineProperty(Buffer.prototype, Symbol.toStringTag, {
  value: "Uint8Array", configurable: true,
});

/* ------------------------------------------------------------------ */
/* path                                                               */
/* ------------------------------------------------------------------ */

function pathNormalize(p) {
  if (p.length === 0)
    return ".";
  const absolute = p.charCodeAt(0) === 47;
  const trailing = p.charCodeAt(p.length - 1) === 47;
  const parts = p.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".")
      continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..")
        out.pop();
      else if (!absolute)
        out.push("..");
    } else {
      out.push(part);
    }
  }
  let s = out.join("/");
  if (!s && !absolute)
    s = ".";
  else if (s && trailing)
    s += "/";
  return (absolute ? "/" : "") + s;
}

function pathJoin(...args) {
  const parts = args.filter((a) => a !== undefined && a !== null && a !== "");
  if (!parts.length)
    return ".";
  return pathNormalize(parts.join("/"));
}

function pathResolve(...args) {
  let resolved = "";
  let absolute = false;
  for (let i = args.length - 1; i >= -1 && !absolute; i--) {
    const p = i >= 0 ? args[i]
      : (typeof process !== "undefined" && process.cwd ? process.cwd() : "/");
    if (typeof p !== "string")
      throw new TypeError("The path argument must be of type string");
    if (!p)
      continue;
    resolved = resolved ? p + "/" + resolved : p;
    absolute = p.charCodeAt(0) === 47;
  }
  resolved = pathNormalize(resolved);
  return resolved;
}

function pathRelative(from, to) {
  from = pathResolve(from);
  to = pathResolve(to);
  if (from === to)
    return "";
  const f = from.split("/").filter(Boolean);
  const t = to.split("/").filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i])
    i++;
  const up = [];
  for (let j = i; j < f.length; j++)
    up.push("..");
  return up.concat(t.slice(i)).join("/");
}

function pathDirname(p) {
  if (p.length === 0)
    return ".";
  const absolute = p.charCodeAt(0) === 47;
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) === 47)
    end--;
  let idx = p.lastIndexOf("/", end - 1);
  if (idx < 0)
    return absolute ? "/" : ".";
  if (idx === 0)
    return "/";
  return p.slice(0, idx);
}

function pathBasename(p, ext) {
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) === 47)
    end--;
  const idx = p.lastIndexOf("/", end - 1);
  let base = p.slice(idx + 1, end);
  if (ext && base.endsWith(ext) && base !== ext)
    base = base.slice(0, base.length - ext.length);
  return base;
}

function pathExtname(p) {
  const base = pathBasename(p);
  const idx = base.lastIndexOf(".");
  if (idx <= 0)
    return "";
  return base.slice(idx);
}

const path = {
  sep: "/",
  delimiter: ":",
  posix: null,
  win32: null,
  normalize: pathNormalize,
  isAbsolute: (p) => p.charCodeAt(0) === 47,
  join: pathJoin,
  resolve: pathResolve,
  relative: pathRelative,
  dirname: pathDirname,
  basename: pathBasename,
  extname: pathExtname,
  parse(p) {
    const root = p.charCodeAt(0) === 47 ? "/" : "";
    const dir = pathDirname(p);
    const base = pathBasename(p);
    const ext = pathExtname(p);
    return {
      root,
      dir: dir === "." && !root ? "" : dir,
      base,
      ext,
      name: ext ? base.slice(0, base.length - ext.length) : base,
    };
  },
  format(o) {
    const dir = o.dir || o.root || "";
    const base = o.base || ((o.name || "") + (o.ext || ""));
    if (!dir)
      return base;
    return dir === o.root ? dir + base : dir + "/" + base;
  },
  toNamespacedPath: (p) => p,
};
path.posix = path;

const win32Path = Object.assign({}, path, {
  sep: "\\",
  delimiter: ";",
  isAbsolute: (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p),
  join: (...args) => pathJoin(...args).replace(/\//g, "\\"),
  normalize: (p) => pathNormalize(p.replace(/\\/g, "/")).replace(/\//g, "\\"),
  dirname: (p) => pathDirname(p.replace(/\\/g, "/")).replace(/\//g, "\\"),
  basename: (p, ext) => pathBasename(p.replace(/\\/g, "/"), ext),
  extname: (p) => pathExtname(p.replace(/\\/g, "/")),
  resolve: (...args) => pathResolve(...args).replace(/\//g, "\\"),
  relative: (a, b) => pathRelative(a, b).replace(/\//g, "\\"),
  toNamespacedPath: (p) => p,
});
path.win32 = win32Path;

/* ------------------------------------------------------------------ */
/* util                                                               */
/* ------------------------------------------------------------------ */

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

function quoteString(s) {
  s = JSON.stringify(s);
  return s;
}

function formatValue(value, depth, seen) {
  if (value === null)
    return "null";
  const t = typeof value;
  if (t === "string")
    return depth > 0 ? quoteString(value) : value;
  if (t === "number")
    return Object.is(value, -0) ? "-0" : String(value);
  if (t === "bigint")
    return String(value) + "n";
  if (t === "boolean" || t === "undefined")
    return String(value);
  if (t === "symbol")
    return value.toString();
  if (t === "function") {
    const name = value.name ? ": " + value.name : " (anonymous)";
    return "[Function" + name + "]";
  }
  if (seen.includes(value))
    return "[Circular *" + (seen.indexOf(value) + 1) + "]";
  if (depth < 0)
    return Array.isArray(value) ? "[Array]" : "[Object]";

  if (typeof value[inspectCustom] === "function") {
    try {
      return String(value[inspectCustom](depth, { depth: depth - 1 }));
    } catch (e) { /* fall through */ }
  }
  if (value instanceof Error)
    return value.stack || (value.name + ": " + value.message);
  if (value instanceof Date)
    return isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof RegExp)
    return String(value);
  if (value instanceof Buffer)
    return "<Buffer " + hexEncode(value, 0, value.length) + ">";

  seen = seen.concat([value]);
  if (Array.isArray(value)) {
    const parts = value.map((v) => formatValue(v, depth - 1, seen));
    return parts.length ? "[ " + parts.join(", ") + " ]" : "[]";
  }
  if (value instanceof Map) {
    const parts = [];
    for (const [k, v] of value)
      parts.push(formatValue(k, depth - 1, seen) + " => " +
                 formatValue(v, depth - 1, seen));
    return "Map(" + value.size + ") {" +
      (parts.length ? " " + parts.join(", ") + " " : "") + "}";
  }
  if (value instanceof Set) {
    const parts = [];
    for (const v of value)
      parts.push(formatValue(v, depth - 1, seen));
    return "Set(" + value.size + ") {" +
      (parts.length ? " " + parts.join(", ") + " " : "") + "}";
  }
  if (ArrayBuffer.isView(value))
    return value.constructor.name + "(" + value.length + ") [ " +
      Array.from(value).join(", ") + " ]";
  if (value instanceof ArrayBuffer)
    return "ArrayBuffer { byteLength: " + value.byteLength + " }";

  let name = "Object";
  const proto = Object.getPrototypeOf(value);
  if (proto && proto.constructor && proto.constructor.name)
    name = proto.constructor.name;
  const keys = Object.keys(value);
  const parts = keys.map((k) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : quoteString(k);
    return key + ": " + formatValue(value[k], depth - 1, seen);
  });
  if (!parts.length)
    return name === "Object" ? "{}" : name + " {}";
  return name + " { " + parts.join(", ") + " }";
}

function inspect(value, options) {
  const depth = options && typeof options.depth === "number"
    ? options.depth : 2;
  return formatValue(value, depth, []);
}

function format(...args) {
  if (!args.length)
    return "";
  const first = args[0];
  if (typeof first !== "string")
    return args.map((a) => inspect(a)).join(" ");
  let i = 1;
  let out = first.replace(/%[sdifjoOc%]/g, (m) => {
    if (m === "%%")
      return "%";
    if (i >= args.length)
      return m;
    const a = args[i++];
    switch (m) {
    case "%s": return typeof a === "string" ? a : inspect(a);
    case "%d": return typeof a === "bigint" ? String(a) + "n" : String(Number(a));
    case "%i": return String(parseInt(a, 10));
    case "%f": return String(parseFloat(a));
    case "%j": try { return JSON.stringify(a); } catch (e) { return "[Circular]"; }
    case "%o": case "%O": return inspect(a);
    case "%c": return "";
    default: return m;
    }
  });
  for (; i < args.length; i++)
    out += " " + (typeof args[i] === "string" ? args[i] : inspect(args[i]));
  return out;
}

function promisify(fn) {
  if (typeof fn !== "function")
    throw new TypeError("The original argument must be of type function");
  if (fn[promisify.custom])
    return fn[promisify.custom];
  return function(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, value) => {
        if (err)
          reject(err);
        else
          resolve(value);
      });
    });
  };
}
promisify.custom = Symbol.for("nodejs.util.promisify.custom");

function callbackify(fn) {
  return function(...args) {
    const cb = args.pop();
    const p = fn.apply(this, args);
    p.then((v) => queueMicrotask(() => cb(null, v)),
           (e) => queueMicrotask(() => cb(e)));
  };
}

function inherits(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  Object.setPrototypeOf(ctor, superCtor);
}

function deprecate(fn, msg) {
  let warned = false;
  return function(...args) {
    if (!warned) {
      warned = true;
      process.emitWarning(msg, "DeprecationWarning");
    }
    return fn.apply(this, args);
  };
}

function isDeepStrictEqual(a, b) {
  if (Object.is(a, b))
    return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b)
    return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return false;
  if (a instanceof Date)
    return a.getTime() === b.getTime();
  if (a instanceof RegExp)
    return String(a) === String(b);
  if (ArrayBuffer.isView(a)) {
    if (a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i])
        return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length)
    return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k))
      return false;
    if (!isDeepStrictEqual(a[k], b[k]))
      return false;
  }
  return true;
}

function defineDebug(name) {
  const fn = (...args) => {
    if (fn.enabled)
      console.error(name + " " + format(...args));
  };
  fn.enabled = !!(process.env.DEBUG &&
    (process.env.DEBUG === "*" || process.env.DEBUG.split(",").some(
      (p) => name.startsWith(p.replace(/\*$/, "")))));
  fn.namespace = name;
  return fn;
}

class TextEncoder {
  constructor() { this.encoding = "utf-8"; }
  encode(input) {
    const str = input === undefined ? "" : String(input);
    if (str.length === 0)
      return new Uint8Array(0);
    const bytes = utf8Encode(str);
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
  }
  encodeInto(source, dest) {
    const bytes = utf8Encode(String(source));
    const n = Math.min(bytes.length, dest.length);
    for (let i = 0; i < n; i++)
      dest[i] = bytes[i];
    return { read: n === bytes.length ? source.length : 0, written: n };
  }
}

class TextDecoder {
  constructor(label, options) {
    const enc = normalizeEncoding(label || "utf-8");
    if (enc !== "utf8" && enc !== "utf16le" && enc !== "latin1")
      throw new RangeError("The encoding label provided is invalid: " + label);
    this.encoding = enc === "utf8" ? "utf-8"
      : enc === "utf16le" ? "utf-16le" : "windows-1252";
    this.fatal = !!(options && options.fatal);
    this.ignoreBOM = !!(options && options.ignoreBOM);
  }
  decode(input) {
    if (input === undefined)
      return "";
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (this.encoding === "utf-16le")
      return utf16leDecode(b, 0, b.length);
    if (this.encoding === "windows-1252")
      return latin1Decode(b, 0, b.length);
    let start = 0;
    if (!this.ignoreBOM && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb &&
        b[2] === 0xbf)
      start = 3;
    return utf8Decode(b, start, b.length);
  }
}

const util = {
  format,
  formatWithOptions: (opts, ...args) => format(...args),
  inspect,
  promisify,
  callbackify,
  inherits,
  deprecate,
  debuglog: defineDebug,
  isDeepStrictEqual,
  inspectCustom,
  TextEncoder,
  TextDecoder,
  types: {
    isPromise: (v) => v instanceof Promise,
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isNativeError: (v) => v instanceof Error,
    isTypedArray: (v) => ArrayBuffer.isView(v) &&
      !(v instanceof DataView),
    isUint8Array: (v) => v instanceof Uint8Array,
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAsyncFunction: (v) => typeof v === "function" &&
      v.constructor && v.constructor.name === "AsyncFunction",
    isGeneratorFunction: (v) => typeof v === "function" &&
      v.constructor && v.constructor.name === "GeneratorFunction",
    isBoxedPrimitive: () => false,
  },
};
util.inspect.custom = inspectCustom;
util.promisify.custom = promisify.custom;

/* ------------------------------------------------------------------ */
/* events                                                             */
/* ------------------------------------------------------------------ */

const kMaxListeners = Symbol("kMaxListeners");

class EventEmitter {
  constructor(options) {
    this._events = Object.create(null);
    this._maxListeners = (options && options.maxListeners) || 10;
    this[kMaxListeners] = this._maxListeners;
    this.captureRejections = false;
  }

  _eventsRef() {
    let events = this._events;
    if (!events)
      events = this._events = Object.create(null);
    return events;
  }

  _eventList(name) {
    const events = this._events;
    return events ? events[name] : undefined;
  }

  static get defaultMaxListeners() { return 10; }
  static set defaultMaxListeners(n) { /* accepted, unused */ }

  static once(emitter, name, options) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        emitter.removeListener(name, handler);
        reject(err);
      };
      const handler = (...args) => {
        emitter.removeListener("error", onError);
        resolve(args);
      };
      emitter.once("error", onError);
      emitter.once(name, handler);
    });
  }

  static on(emitter, name, options) {
    return (async function*() {
      const queue = [];
      let done = false, error = null, wake = null;
      const handler = (...args) => {
        queue.push(args);
        if (wake) { const w = wake; wake = null; w(); }
      };
      const onEnd = () => { done = true; if (wake) { const w = wake; wake = null; w(); } };
      const onError = (e) => { error = e; if (wake) { const w = wake; wake = null; w(); } };
      emitter.on(name, handler);
      emitter.once("end", onEnd);
      emitter.once("close", onEnd);
      emitter.once("error", onError);
      try {
        for (;;) {
          while (queue.length)
            yield queue.shift();
          if (error)
            throw error;
          if (done)
            return;
          await new Promise((r) => { wake = r; });
        }
      } finally {
        emitter.removeListener(name, handler);
        emitter.removeListener("end", onEnd);
        emitter.removeListener("close", onEnd);
        emitter.removeListener("error", onError);
      }
    })();
  }

  static getEventListeners(emitter, name) {
    return emitter.listeners(name);
  }

  static listenerCount(emitter, name) {
    return emitter.listenerCount(name);
  }

  addListener(name, fn) { return this.on(name, fn); }

  on(name, fn) {
    if (typeof fn !== "function")
      throw new TypeError("The listener must be a function");
    const events = this._eventsRef();
    let list = events[name];
    if (!list)
      list = events[name] = [];
    else if (!Array.isArray(list))
      list = events[name] = [list];
    list.push(fn);
    if (name !== "newListener")
      this.emit("newListener", name, fn.listener || fn);
    return this;
  }

  prependListener(name, fn) {
    if (typeof fn !== "function")
      throw new TypeError("The listener must be a function");
    const events = this._eventsRef();
    let list = events[name];
    if (!list)
      list = events[name] = [];
    else if (!Array.isArray(list))
      list = events[name] = [list];
    list.unshift(fn);
    return this;
  }

  once(name, fn) {
    if (typeof fn !== "function")
      throw new TypeError("The listener must be a function");
    const self = this;
    function wrapper(...args) {
      self.removeListener(name, wrapper);
      return fn.apply(this, args);
    }
    wrapper.listener = fn;
    return this.on(name, wrapper);
  }

  prependOnceListener(name, fn) {
    const self = this;
    function wrapper(...args) {
      self.removeListener(name, wrapper);
      return fn.apply(this, args);
    }
    wrapper.listener = fn;
    return this.prependListener(name, wrapper);
  }

  removeListener(name, fn) {
    const events = this._eventsRef();
    const list = events[name];
    if (!list)
      return this;
    if (!Array.isArray(list)) {
      if (list === fn || list.listener === fn)
        delete events[name];
      return this;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i].listener === fn) {
        list.splice(i, 1);
        if (list.length === 1)
          events[name] = list[0];
        else if (list.length === 0)
          delete events[name];
        break;
      }
    }
    return this;
  }

  off(name, fn) { return this.removeListener(name, fn); }

  removeAllListeners(name) {
    if (name === undefined) {
      this._events = Object.create(null);
    } else {
      delete this._events[name];
    }
    return this;
  }

  emit(name, ...args) {
    const list = this._eventList(name);
    if (!list) {
      if (name === "error") {
        const err = args[0];
        if (err instanceof Error)
          throw err;
        const e = new Error("Unhandled error." +
                            (err === undefined ? "" : ". " + err));
        e.code = "ERR_UNHANDLED_ERROR";
        e.context = err;
        throw e;
      }
      return false;
    }
    if (!Array.isArray(list)) {
      list.call(this, ...args);
      return true;
    }
    const copy = list.slice();
    for (const fn of copy)
      fn.call(this, ...args);
    return true;
  }

  listeners(name) {
    const list = this._eventList(name);
    if (!list)
      return [];
    if (!Array.isArray(list))
      return [list.listener || list];
    return list.map((f) => f.listener || f);
  }

  rawListeners(name) {
    const list = this._eventList(name);
    if (!list)
      return [];
    return Array.isArray(list) ? list.slice() : [list];
  }

  listenerCount(name) {
    const list = this._eventList(name);
    return !list ? 0 : (Array.isArray(list) ? list.length : 1);
  }

  eventNames() {
    return this._events ? Object.keys(this._events) : [];
  }

  setMaxListeners(n) { this._maxListeners = n; return this; }
  getMaxListeners() { return this._maxListeners; }
}

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;

function once(emitter, name) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { cleanup(); reject(err); };
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const cleanup = () => {
      emitter.removeListener(name, onEvent);
      emitter.removeListener("error", onError);
    };
    emitter.once(name, onEvent);
    emitter.once("error", onError);
  });
}

/* ------------------------------------------------------------------ */
/* stream                                                             */
/* ------------------------------------------------------------------ */

function toChunk(chunk, encoding) {
  if (typeof chunk === "string")
    return Buffer.from(chunk, encoding || "utf8");
  if (ArrayBuffer.isView(chunk))
    return chunk;
  if (chunk instanceof ArrayBuffer)
    return Buffer.from(chunk);
  return chunk;
}

class Stream extends EventEmitter {
  pipe(dest, options) {
    const ondata = (chunk) => {
      const ok = dest.write(chunk);
      if (ok === false && typeof this.pause === "function")
        this.pause();
    };
    const ondrain = () => { if (typeof this.resume === "function") this.resume(); };
    const onend = () => { dest.end(); };
    const onerror = (err) => { dest.destroy(err); };
    this.on("data", ondata);
    dest.on("drain", ondrain);
    this.once("end", onend);
    this.once("error", onerror);
    dest.emit("pipe", this);
    return dest;
  }
}

class Readable extends Stream {
  constructor(options) {
    super();
    options = options || {};
    this._readableState = {
      objectMode: !!options.objectMode,
      highWaterMark: options.highWaterMark || 16384,
      buffer: [],
      length: 0,
      flowing: null,
      ended: false,
      reading: false,
      destroyed: false,
      endEmitted: false,
      encoding: null,
    };
    this.readable = true;
    this.readableEnded = false;
    this.destroyed = false;
    if (options.read)
      this._read = options.read.bind(this);
    if (options.destroy)
      this._destroy = options.destroy.bind(this);
  }

  _read() {}

  _destroy(err, cb) { cb(err); }

  push(chunk, encoding) {
    const st = this._readableState;
    if (chunk === null) {
      st.ended = true;
      st.reading = false;
      this._maybeEnd();
      return false;
    }
    if (typeof chunk === "string") {
      if (st.encoding && st.encoding !== "buffer")
        chunk = Buffer.from(chunk, st.encoding);
      else
        chunk = Buffer.from(chunk, encoding || "utf8");
    }
    if (st.destroyed)
      return false;
    st.buffer.push(chunk);
    st.length += st.objectMode ? 1 : chunk.length;
    if (st.flowing)
      scheduleFlow(this);
    return st.length < st.highWaterMark;
  }

  unshift(chunk) {
    const st = this._readableState;
    if (chunk === null)
      return;
    if (typeof chunk === "string")
      chunk = Buffer.from(chunk, "utf8");
    st.buffer.unshift(chunk);
    st.length += st.objectMode ? 1 : chunk.length;
  }

  read(size) {
    const st = this._readableState;
    if (st.buffer.length === 0) {
      if (!st.ended && !st.reading) {
        st.reading = true;
        this._read(st.highWaterMark);
      }
      if (st.buffer.length === 0) {
        this._maybeEnd();
        return null;
      }
    }
    if (size === undefined || size === null || size === 0) {
      if (st.objectMode || st.buffer.length === 1) {
        const chunk = st.buffer.shift();
        st.length -= st.objectMode ? 1 : chunk.length;
        if (st.buffer.length === 0 && !st.ended && !st.reading) {
          st.reading = true;
          this._read(st.highWaterMark);
        }
        this._maybeEnd();
        return chunk;
      }
      size = st.length;
    }
    if (st.objectMode) {
      const chunk = st.buffer.shift();
      if (chunk !== undefined)
        st.length -= 1;
      this._maybeEnd();
      return chunk === undefined ? null : chunk;
    }
    if (size >= st.length) {
      const all = Buffer.concat(st.buffer.map((c) =>
        typeof c === "string" ? Buffer.from(c) : c), st.length);
      st.buffer = [];
      st.length = 0;
      if (!st.ended && !st.reading) {
        st.reading = true;
        this._read(st.highWaterMark);
      }
      this._maybeEnd();
      return all.length ? all : null;
    }
    const out = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size && st.buffer.length) {
      const chunk = st.buffer[0];
      const n = Math.min(chunk.length, size - off);
      out.set(chunk.subarray(0, n), off);
      off += n;
      if (n === chunk.length)
        st.buffer.shift();
      else
        st.buffer[0] = chunk.subarray(n);
    }
    st.length -= off;
    return out;
  }

  _maybeEnd() {
    const st = this._readableState;
    if (st.ended && st.buffer.length === 0 && !st.endEmitted) {
      st.endEmitted = true;
      this.readable = false;
      this.readableEnded = true;
      this.emit("end");
      this.emit("close");
    }
  }

  resume() {
    const st = this._readableState;
    if (st.flowing === true)
      return this;
    st.flowing = true;
    scheduleFlow(this);
    return this;
  }

  pause() {
    this._readableState.flowing = false;
    return this;
  }

  isPaused() {
    return this._readableState.flowing === false;
  }

  setEncoding(enc) {
    this._readableState.encoding = normalizeEncoding(enc) || enc;
    return this;
  }

  on(name, fn) {
    super.on(name, fn);
    if (name === "data" && this._readableState.flowing !== false)
      this.resume();
    if (name === "readable")
      scheduleFlow(this);
    return this;
  }

  destroy(err) {
    const st = this._readableState;
    if (st.destroyed)
      return this;
    st.destroyed = true;
    this.destroyed = true;
    this._destroy(err || null, (e) => {
      this.emit("close");
      if (e)
        this.emit("error", e);
    });
    return this;
  }

  [Symbol.asyncIterator]() {
    const self = this;
    const queue = [];
    let done = false, error = null;
    const ondata = (c) => queue.push(c);
    const onend = () => { done = true; };
    const onerr = (e) => { error = e; };
    this.on("data", ondata);
    this.once("end", onend);
    this.once("error", onerr);
    return {
      async next() {
        for (;;) {
          if (queue.length)
            return { value: queue.shift(), done: false };
          if (error) { const e = error; error = null; throw e; }
          if (done)
            return { value: undefined, done: true };
          await new Promise((r) => queueMicrotask(r));
        }
      },
      async return() {
        self.removeListener("data", ondata);
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  map(fn, options) {
    const self = this;
    const out = new Readable({
      objectMode: options ? options.objectMode : false,
      read() {
        const chunk = self.read();
        if (chunk === null)
          out.push(null);
        else
          out.push(fn(chunk));
      },
    });
    return out;
  }

  static from(iterable, options) {
    const r = new Readable({
      objectMode: true,
      read() {},
      ...(options || {}),
    });
    if (iterable && typeof iterable[Symbol.asyncIterator] === "function") {
      (async () => {
        for await (const v of iterable) {
          if (!r.push(v)) {
            await new Promise((res) => r.once("drain", res));
          }
        }
        r.push(null);
      })().catch((e) => r.destroy(e));
    } else if (iterable && typeof iterable[Symbol.iterator] === "function") {
      queueMicrotask(() => {
        for (const v of iterable) {
          if (!r.push(v))
            break;
        }
        r.push(null);
      });
    }
    return r;
  }
}

function scheduleFlow(r) {
  if (r._flowScheduled)
    return;
  r._flowScheduled = true;
  queueMicrotask(() => {
    r._flowScheduled = false;
    const st = r._readableState;
    if (!st.flowing || st.destroyed)
      return;
    if (st.buffer.length === 0 && !st.ended && !st.reading) {
      st.reading = true;
      r._read(st.highWaterMark);
    }
    while (st.flowing && st.buffer.length) {
      const chunk = st.buffer.shift();
      st.length -= st.objectMode ? 1 : chunk.length;
      r.emit("data", chunk);
    }
    if (st.buffer.length === 0 && !st.ended && !st.reading) {
      st.reading = true;
      r._read(st.highWaterMark);
    }
    r._maybeEnd();
  });
}

class Writable extends Stream {
  constructor(options) {
    super();
    options = options || {};
    this._writableState = {
      objectMode: !!options.objectMode,
      highWaterMark: options.highWaterMark || 16384,
      ending: false,
      ended: false,
      finished: false,
      destroying: false,
      destroyed: false,
      needDrain: false,
      length: 0,
    };
    this.writable = true;
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
    if (options.write)
      this._write = options.write.bind(this);
    if (options.destroy)
      this._destroy = options.destroy.bind(this);
    if (options.final)
      this._final = options.final.bind(this);
  }

  _write(chunk, encoding, cb) { cb(); }

  _final(cb) { cb(); }

  _destroy(err, cb) { cb(err); }

  write(chunk, encoding, cb) {
    const st = this._writableState;
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (st.ending)
      throw new Error("write after end");
    chunk = toChunk(chunk, encoding);
    st.length += st.objectMode ? 1 : chunk.length;
    const done = (err) => {
      st.length -= st.objectMode ? 1 : chunk.length;
      if (err) {
        if (cb) cb(err);
        this.emit("error", err);
        return;
      }
      if (cb) cb();
      if (st.needDrain && st.length < st.highWaterMark) {
        st.needDrain = false;
        this.emit("drain");
      }
      if (st.ending && st.length === 0 && !st.finished)
        this._finish();
    };
    if (this._write.length >= 3)
      this._write(chunk, encoding || "buffer", done);
    else {
      try {
        this._write(chunk, encoding || "buffer", () => {});
        done();
      } catch (e) {
        done(e);
      }
    }
    if (st.length >= st.highWaterMark) {
      st.needDrain = true;
      return false;
    }
    return true;
  }

  end(chunk, encoding, cb) {
    const st = this._writableState;
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (st.ending)
      return this;
    if (chunk !== undefined && chunk !== null)
      this.write(chunk, encoding);
    st.ending = true;
    this.writableEnded = true;
    if (cb)
      this.once("finish", cb);
    if (st.length === 0 && !st.finished)
      this._finish();
    return this;
  }

  _finish() {
    const st = this._writableState;
    if (st.finished)
      return;
    this._final((err) => {
      if (err) {
        this.emit("error", err);
        return;
      }
      st.finished = true;
      st.ended = true;
      this.writable = false;
      this.writableFinished = true;
      this.emit("finish");
      this.emit("close");
    });
  }

  cork() {}
  uncork() {}

  destroy(err) {
    const st = this._writableState;
    if (st.destroyed)
      return this;
    st.destroyed = true;
    this.destroyed = true;
    this._destroy(err || null, (e) => {
      this.emit("close");
      if (e)
        this.emit("error", e);
    });
    return this;
  }
}

class Duplex extends Readable {
  constructor(options) {
    super(options);
    options = options || {};
    this._writableState = {
      objectMode: !!options.objectMode,
      highWaterMark: options.highWaterMark || 16384,
      ending: false,
      ended: false,
      finished: false,
      destroying: false,
      destroyed: false,
      needDrain: false,
      length: 0,
    };
    this.writable = true;
    this.writableEnded = false;
    this.writableFinished = false;
    if (options.write)
      this._write = options.write.bind(this);
    if (options.final)
      this._final = options.final.bind(this);
  }
}
for (const name of Object.getOwnPropertyNames(Writable.prototype)) {
  if (name === "constructor")
    continue;
  Duplex.prototype[name] = Writable.prototype[name];
}
Duplex.prototype._write = Writable.prototype._write;
Duplex.prototype._final = Writable.prototype._final;

class Transform extends Duplex {
  constructor(options) {
    super(options);
    this._transform = (options && options.transform)
      ? options.transform.bind(this) : this._transform;
    this._flush = (options && options.flush)
      ? options.flush.bind(this) : this._flush;
  }
  _transform(chunk, encoding, cb) { cb(null, chunk); }
  _flush(cb) { cb(); }
  _write(chunk, encoding, cb) {
    this._transform(chunk, encoding, (err, data) => {
      if (err) { cb(err); return; }
      if (data !== undefined && data !== null)
        this.push(data);
      cb();
    });
  }
  _final(cb) {
    this._flush((err, data) => {
      if (err) { cb(err); return; }
      if (data !== undefined && data !== null)
        this.push(data);
      this.push(null);
      cb();
    });
  }
}

class PassThrough extends Transform {}

function pipeline(...args) {
  const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
  const streams = args.flat();
  if (streams.length === 0) {
    if (cb) queueMicrotask(() => cb(new TypeError("no streams")));
    return null;
  }
  let errored = false;
  const onerr = (err) => {
    if (errored)
      return;
    errored = true;
    for (const s of streams)
      if (s && typeof s.destroy === "function")
        s.destroy(err);
    if (cb) cb(err);
    else if (streams[0])
      streams[0].emit("error", err);
  };
  for (let i = 0; i < streams.length - 1; i++)
    streams[i].on("error", onerr);
  for (let i = 0; i < streams.length - 1; i++)
    streams[i].pipe(streams[i + 1]);
  const last = streams[streams.length - 1];
  const done = () => { if (cb && !errored) cb(null); };
  last.once("finish", done);
  last.once("end", done);
  return last;
}

function finished(stream, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  let called = false;
  const done = (err) => {
    if (called)
      return;
    called = true;
    cb(err || null);
  };
  stream.once("finish", () => done());
  stream.once("end", () => done());
  stream.once("close", () => done());
  stream.once("error", (err) => done(err));
}

/* `require('stream')` is the Stream constructor in Node, with the other
   classes hanging off it. Some packages (send, for one) inherit from it. */
Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.addAbortSignal = (signal, s) => s;
Stream.isReadable = (s) => s instanceof Readable;
Stream.isWritable = (s) => s instanceof Writable;
const stream = Stream;
Readable.from = Readable.from;

/* ------------------------------------------------------------------ */
/* fs                                                                 */
/* ------------------------------------------------------------------ */

const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000, S_IFLNK = 0o120000, S_IFREG = 0o100000;
const S_IFBLK = 0o060000, S_IFDIR = 0o040000, S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;

class Stats {
  constructor(raw) { Object.assign(this, raw); }
  isFile() { return (this.mode & S_IFMT) === S_IFREG; }
  isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
  isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
  isFIFO() { return (this.mode & S_IFMT) === S_IFIFO; }
  isSocket() { return (this.mode & S_IFMT) === S_IFSOCK; }
  isBlockDevice() { return (this.mode & S_IFMT) === S_IFBLK; }
  isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
}

function makeStats(raw) {
  const s = new Stats(raw);
  s.atime = new Date(raw.atimeMs);
  s.mtime = new Date(raw.mtimeMs);
  s.ctime = new Date(raw.ctimeMs);
  s.birthtime = new Date(raw.birthtimeMs);
  return s;
}

function fsError(res, syscall, path) {
  const err = res[1];
  if (err)
    throw sysError(err, syscall, path);
  return res[0];
}

function fsCallback(fn, syscall, pathOf) {
  return function(...args) {
    const cb = args.pop();
    if (typeof cb !== "function")
      throw new TypeError("The callback argument must be of type function");
    let path = pathOf ? pathOf(args) : args[0];
    queueMicrotask(() => {
      try {
        const v = fn.apply(this, args);
        cb(null, v);
      } catch (e) {
        if (!e.syscall && syscall) {
          e.syscall = syscall;
          if (path !== undefined)
            e.path = String(path);
        }
        cb(e);
      }
    });
  };
}

function readFileSync(path, options) {
  const buf = fsError(native.readFile(String(path)), "open", path);
  const enc = typeof options === "string" ? options
    : options && options.encoding;
  const b = Buffer.from(buf);
  return enc ? b.toString(enc) : b;
}

function writeFileSync(path, data, options) {
  const flag = typeof options === "string" ? undefined
    : options && options.flag;
  const mode = (options && typeof options === "object")
    ? options.mode : undefined;
  const b = typeof data === "string" ? Buffer.from(data)
    : Buffer.from(data);
  return fsError(native.writeFile(String(path), b, flag, mode),
                 "open", path);
}

function appendFileSync(path, data, options) {
  const flag = typeof options === "string" ? options : "a";
  const mode = (options && typeof options === "object")
    ? options.mode : undefined;
  const b = Buffer.from(data);
  return fsError(native.writeFile(String(path), b, flag || "a", mode),
                 "open", path);
}

function statSync(path, options) {
  const follow = !(options && options.throwIfNoEntry === false) &&
    !(options === false);
  return makeStats(fsError(native.stat(String(path), follow !== false),
                           "stat", path));
}

function lstatSync(path) {
  return makeStats(fsError(native.stat(String(path), false), "lstat", path));
}

function readdirSync(path, options) {
  const list = fsError(native.readdir(String(path)), "opendir", path);
  if (options && typeof options === "object" &&
      (options.withFileTypes || options.encoding === "buffer")) {
    return list.map((name) => {
      const full = pathJoin(String(path), name);
      let st;
      try { st = lstatSync(full); } catch (e) { st = null; }
      return {
        name,
        parentPath: String(path),
        path: String(path),
        isFile: () => st ? st.isFile() : false,
        isDirectory: () => st ? st.isDirectory() : false,
        isSymbolicLink: () => st ? st.isSymbolicLink() : false,
        isFIFO: () => st ? st.isFIFO() : false,
        isSocket: () => st ? st.isSocket() : false,
        isBlockDevice: () => st ? st.isBlockDevice() : false,
        isCharacterDevice: () => st ? st.isCharacterDevice() : false,
      };
    });
  }
  return list;
}

function mkdirSync(path, options) {
  if (typeof options === "number")
    options = { mode: options };
  const recursive = options && options.recursive;
  const mode = (options && options.mode) || 0o777;
  const p = String(path);
  if (!recursive) {
    const err = native.mkdir(p, mode);
    if (err)
      throw sysError(err, "mkdir", p);
    return undefined;
  }
  let created;
  const abs = pathResolve(p);
  const parts = abs.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    try {
      const st = new Stats(fsError(native.stat(cur, true), "stat", cur));
      if (!st.isDirectory()) {
        const e = sysError(20, "mkdir", cur);
        throw e;
      }
    } catch (e) {
      if (e.code !== "ENOENT")
        throw e;
      const err = native.mkdir(cur, mode);
      if (err && err !== 17)
        throw sysError(err, "mkdir", cur);
      if (created === undefined)
        created = cur;
    }
  }
  return created;
}

function rmSync(path, options) {
  options = options || {};
  const p = String(path);
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (options.force && e.code === "ENOENT")
      return;
    throw e;
  }
  if (st.isDirectory()) {
    if (!options.recursive)
      throw sysError(21, "rm", p);
    for (const name of readdirSync(p)) {
      if (name === "." || name === "..")
        continue;
      rmSync(pathJoin(p, name), { recursive: true, force: true });
    }
    const err = native.rmdir(p);
    if (err && !(options.force && err === 2))
      throw sysError(err, "rmdir", p);
    return;
  }
  const err = native.unlink(p);
  if (err && !(options.force && err === 2))
    throw sysError(err, "unlink", p);
}

function rmdirSync(path, options) {
  if (options && options.recursive)
    return rmSync(path, { recursive: true });
  const err = native.rmdir(String(path));
  if (err)
    throw sysError(err, "rmdir", path);
}

const fsConstants = {
  F_OK: C.F_OK, R_OK: C.R_OK, W_OK: C.W_OK, X_OK: C.X_OK,
  O_RDONLY: C.O_RDONLY, O_WRONLY: C.O_WRONLY, O_RDWR: C.O_RDWR,
  O_CREAT: C.O_CREAT, O_TRUNC: C.O_TRUNC, O_APPEND: C.O_APPEND,
  O_EXCL: C.O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFSOCK, S_IFBLK, S_IFCHR,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};

function copyFileSync(src, dst, mode) {
  const err = native.copyFile(String(src), String(dst));
  if (err)
    throw sysError(err, "copyfile", src);
}

function realpathSync(path, options) {
  return fsError(native.realpath(String(path)), "realpath", path);
}

const fsSync = {
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  copyFileSync,
  realpathSync,
  readlinkSync: (p) => fsError(native.readlink(String(p)), "readlink", p),
  symlinkSync: (t, p) => {
    const err = native.symlink(String(t), String(p));
    if (err) throw sysError(err, "symlink", p);
  },
  unlinkSync: (p) => {
    const err = native.unlink(String(p));
    if (err) throw sysError(err, "unlink", p);
  },
  renameSync: (a, b) => {
    const err = native.rename(String(a), String(b));
    if (err) throw sysError(err, "rename", a);
  },
  chmodSync: (p, mode) => {
    const err = native.chmod(String(p), mode);
    if (err) throw sysError(err, "chmod", p);
  },
  chownSync: (p, uid, gid) => {
    const err = native.chown(String(p), uid, gid);
    if (err) throw sysError(err, "chown", p);
  },
  utimesSync: (p, atime, mtime) => {
    const a = atime instanceof Date ? atime.getTime() : atime * 1000;
    const m = mtime instanceof Date ? mtime.getTime() : mtime * 1000;
    const err = native.utimes(String(p), a, m);
    if (err) throw sysError(err, "utime", p);
  },
  truncateSync: (p, len) => {
    const err = native.truncate(String(p), len || 0);
    if (err) throw sysError(err, "truncate", p);
  },
  accessSync: (p, mode) => {
    const err = native.access(String(p), mode === undefined ? C.F_OK : mode);
    if (err) throw sysError(err, "access", p);
  },
  existsSync: (p) => native.access(String(p), C.F_OK) === 0,
  opendirSync: (p) => {
    const list = readdirSync(String(p));
    let i = 0;
    return {
      path: String(p),
      readSync() {
        return i < list.length ? { name: list[i++], parentPath: String(p) } : null;
      },
      closeSync() {},
      [Symbol.iterator]() { return this; },
      next() {
        if (i < list.length)
          return { value: { name: list[i++], parentPath: String(p) }, done: false };
        return { value: undefined, done: true };
      },
    };
  },
  openSync: (p, flags, mode) => {
    const fd = fsError(native.open(String(p), String(flags), mode),
                       "open", p);
    if (fd < 0)
      throw sysError(-fd, "open", p);
    return fd;
  },
  closeSync: (fd) => { native.close(fd); },
  readSync: (fd, buffer, offset, length, position) => {
    const tmp = fsError(native.read(fd, length, position), "read", undefined);
    const b = Buffer.from(tmp);
    b.copy(buffer, offset, 0, b.length);
    return b.length;
  },
  writeSync: (fd, buffer, offset, length, position) => {
    if (typeof buffer === "string") {
      const b = Buffer.from(buffer, offset);
      let off = 0;
      while (off < b.length) {
        const n = fsError(native.write(fd, b.subarray(off)), "write");
        if (!n) break;
        off += n;
      }
      return b.length;
    }
    offset = offset || 0;
    length = length === undefined ? buffer.length - offset : length;
    let off = 0;
    while (off < length) {
      const n = fsError(
        native.write(fd, buffer.subarray(offset + off, offset + length)),
        "write");
      if (!n) break;
      off += n;
    }
    return off;
  },
  fstatSync: (fd) => makeStats(fsError(native.fstat(fd), "fstat")),
  fsyncSync: (fd) => { native.fsync(fd); },
  ftruncateSync: (fd, len) => { native.ftruncate(fd, len); },
};

/* Async fs wrappers (callbacks run on the microtask queue). */

const fsAsync = {
  readFile: fsCallback(readFileSync, "open"),
  writeFile: fsCallback(writeFileSync, "open"),
  appendFile: fsCallback(appendFileSync, "open"),
  stat: fsCallback(statSync, "stat"),
  lstat: fsCallback(lstatSync, "lstat"),
  readdir: fsCallback(readdirSync, "opendir"),
  mkdir: fsCallback(mkdirSync, "mkdir"),
  rmdir: fsCallback(rmdirSync, "rmdir"),
  rm: fsCallback(rmSync, "rm"),
  unlink: fsCallback((p) => fsSync.unlinkSync(p), "unlink"),
  rename: fsCallback((a, b) => fsSync.renameSync(a, b), "rename"),
  realpath: fsCallback(realpathSync, "realpath"),
  readlink: fsCallback((p) => fsSync.readlinkSync(p), "readlink"),
  symlink: fsCallback((t, p) => fsSync.symlinkSync(t, p), "symlink"),
  chmod: fsCallback((p, m) => fsSync.chmodSync(p, m), "chmod"),
  chown: fsCallback((p, u, g) => fsSync.chownSync(p, u, g), "chown"),
  utimes: fsCallback((p, a, m) => fsSync.utimesSync(p, a, m), "utime"),
  truncate: fsCallback((p, l) => fsSync.truncateSync(p, l), "truncate"),
  copyFile: fsCallback((s, d, m) => copyFileSync(s, d, m), "copyfile"),
  access: fsCallback((p, m) => fsSync.accessSync(p, m), "access"),
  exists: (p, cb) => queueMicrotask(() => cb(fsSync.existsSync(p))),
  open: (path, flags, mode, cb) => {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    queueMicrotask(() => {
      try { cb(null, fsSync.openSync(path, flags, mode)); }
      catch (e) { cb(e); }
    });
  },
  close: (fd, cb) => queueMicrotask(() => {
    try { fsSync.closeSync(fd); cb(null); } catch (e) { cb(e); }
  }),
  read: (fd, buffer, offset, length, position, cb) => {
    if (typeof position === "function") { cb = position; position = null; }
    queueMicrotask(() => {
      try {
        const n = fsSync.readSync(fd, buffer, offset, length, position);
        cb(null, n, buffer);
      } catch (e) { cb(e); }
    });
  },
  write: (fd, buffer, offset, length, position, cb) => {
    if (typeof buffer === "string") {
      if (typeof offset === "function") { cb = offset; offset = 0; }
      else if (typeof position === "function") { cb = position; position = null; }
      queueMicrotask(() => {
        try {
          const n = fsSync.writeSync(fd, buffer, offset || 0);
          cb(null, n, buffer);
        } catch (e) { cb(e); }
      });
      return;
    }
    if (typeof offset === "function") { cb = offset; offset = 0; length = buffer.length; }
    else if (typeof length === "function") { cb = length; length = buffer.length - (offset || 0); }
    else if (typeof position === "function") { cb = position; position = null; }
    queueMicrotask(() => {
      try {
        const n = fsSync.writeSync(fd, buffer, offset || 0, length, position);
        cb(null, n, buffer);
      } catch (e) { cb(e); }
    });
  },
  fsync: (fd, cb) => queueMicrotask(() => {
    try { fsSync.fsyncSync(fd); cb(null); } catch (e) { cb(e); }
  }),
  ftruncate: (fd, len, cb) => queueMicrotask(() => {
    try { fsSync.ftruncateSync(fd, len); cb(null); } catch (e) { cb(e); }
  }),
  fstat: fsCallback((fd) => fsSync.fstatSync(fd), "fstat", (a) => undefined),
};

function fsPromise(fn, pathOf) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try { resolve(fn.apply(this, args)); }
        catch (e) { reject(e); }
      });
    });
  };
}

function promisifyMulti(fn) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, ...rest) => {
        if (err) reject(err);
        else resolve(rest.length > 1 ? rest : rest[0]);
      });
    });
  };
}

class FileHandle {
  constructor(fd) { this.fd = fd; }
  readFile(options) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          let data = Buffer.allocUnsafe(65536);
          let out = [];
          for (;;) {
            const n = fsSync.readSync(this.fd, data, 0, data.length);
            if (!n) break;
            out.push(data.subarray(0, n));
            if (n < data.length) break;
          }
          const buf = Buffer.concat(out);
          const enc = typeof options === "string" ? options
            : options && options.encoding;
          resolve(enc ? buf.toString(enc) : buf);
        } catch (e) { reject(e); }
      });
    });
  }
  writeFile(data, options) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          const b = Buffer.from(data);
          let off = 0;
          while (off < b.length) {
            const n = fsError(native.write(this.fd, b.subarray(off)), "write");
            if (!n) break;
            off += n;
          }
          resolve();
        } catch (e) { reject(e); }
      });
    });
  }
  read(buffer, offset, length, position) {
    return promisifyMulti(fsAsync.read.bind(null, this.fd,
      buffer, offset, length, position))().then(([bytesRead]) => ({
      bytesRead, buffer,
    }));
  }
  write(buffer, offset, length, position) {
    return promisifyMulti(fsAsync.write.bind(null, this.fd,
      buffer, offset, length, position))().then(([bytesWritten]) => ({
      bytesWritten, buffer,
    }));
  }
  stat() { return fsPromise(() => fsSync.fstatSync(this.fd))(); }
  truncate(len) {
    return fsPromise(() => fsSync.ftruncateSync(this.fd, len))();
  }
  sync() { return fsPromise(() => fsSync.fsyncSync(this.fd))(); }
  datasync() { return this.sync(); }
  close() {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try { fsSync.closeSync(this.fd); resolve(); } catch (e) { reject(e); }
      });
    });
  }
  [Symbol.asyncDispose]() { return this.close(); }
}

const fsp = {
  readFile: fsPromise(readFileSync),
  writeFile: fsPromise(writeFileSync),
  appendFile: fsPromise(appendFileSync),
  stat: fsPromise(statSync),
  lstat: fsPromise(lstatSync),
  readdir: fsPromise(readdirSync),
  mkdir: fsPromise(mkdirSync),
  rmdir: fsPromise(rmdirSync),
  rm: fsPromise(rmSync),
  unlink: fsPromise((p) => fsSync.unlinkSync(p)),
  rename: fsPromise((a, b) => fsSync.renameSync(a, b)),
  realpath: fsPromise(realpathSync),
  readlink: fsPromise((p) => fsSync.readlinkSync(p)),
  symlink: fsPromise((t, p) => fsSync.symlinkSync(t, p)),
  chmod: fsPromise((p, m) => fsSync.chmodSync(p, m)),
  chown: fsPromise((p, u, g) => fsSync.chownSync(p, u, g)),
  utimes: fsPromise((p, a, m) => fsSync.utimesSync(p, a, m)),
  truncate: fsPromise((p, l) => fsSync.truncateSync(p, l)),
  copyFile: fsPromise((s, d, m) => copyFileSync(s, d, m)),
  access: fsPromise((p, m) => fsSync.accessSync(p, m)),
  open: async (p, flags, mode) => new FileHandle(fsSync.openSync(p, flags, mode)),
  constants: fsConstants,
};

function createReadStream(path, options) {
  options = options || {};
  const fd = fsSync.openSync(path, "r");
  if (options.start)
    fsSync.readSync(fd, Buffer.allocUnsafe(options.start), 0, options.start);
  const stream = new Readable({
    highWaterMark: options.highWaterMark || 65536,
    read() {
      const size = options.end !== undefined
        ? Math.min(this._readableState.highWaterMark,
                   options.end - (options.start || 0) + 1)
        : this._readableState.highWaterMark;
      if (size <= 0) {
        fsSync.closeSync(fd);
        this.push(null);
        return;
      }
      try {
        const data = Buffer.allocUnsafe(size);
        const n = fsSync.readSync(fd, data, 0, size);
        if (!n) {
          fsSync.closeSync(fd);
          this.push(null);
        } else {
          this.push(n === size ? data : data.subarray(0, n));
        }
      } catch (e) {
        fsSync.closeSync(fd);
        this.destroy(e);
      }
    },
  });
  stream.path = String(path);
  stream.fd = fd;
  if (options.encoding)
    stream.setEncoding(options.encoding);
  return stream;
}

function createWriteStream(path, options) {
  options = options || {};
  const flags = options.flags || "w";
  const fd = fsSync.openSync(path, flags, options.mode);
  if (options.start) {
    fsSync.writeSync(fd, Buffer.allocUnsafe(options.start), 0, options.start);
  }
  const stream = new Writable({
    highWaterMark: options.highWaterMark,
    write(chunk, encoding, cb) {
      try {
        const b = toChunk(chunk, encoding);
        let off = 0;
        while (off < b.length) {
          const n = fsError(native.write(fd, b.subarray(off)), "write");
          if (!n) break;
          off += n;
        }
        cb();
      } catch (e) { cb(e); }
    },
    final(cb) {
      try { fsSync.closeSync(fd); cb(); } catch (e) { cb(e); }
    },
  });
  stream.path = String(path);
  stream.fd = fd;
  return stream;
}

const fs = Object.assign({
  constants: fsConstants,
  Stats,
  promises: fsp,
  createReadStream,
  createWriteStream,
}, fsSync, fsAsync);

/* ------------------------------------------------------------------ */
/* process / os                                                       */
/* ------------------------------------------------------------------ */

const START_TIME = Date.now();
const argv = Array.isArray(globalThis.__qnode_argv)
  ? globalThis.__qnode_argv.slice() : [];
const qjsArgv = Array.isArray(globalThis.scriptArgs) ? globalThis.scriptArgs : [];

function envObject() {
  const o = native.environ();
  const env = {};
  for (const k of Object.keys(o))
    env[k] = o[k];
  return env;
}

function envPairs(env) {
  const out = [];
  for (const k of Object.keys(env || {}))
    if (env[k] !== undefined)
      out.push(k + "=" + env[k]);
  return out;
}

const unameInfo = (() => {
  const r = native.uname();
  return r[1] ? { sysname: "Linux", machine: "unknown" } : r[0];
})();

const ARCH = (() => {
  const m = unameInfo.machine || "";
  if (m === "x86_64" || m === "amd64") return "x64";
  if (m === "aarch64" || m === "arm64") return "arm64";
  if (m.startsWith("arm")) return "arm";
  if (m.startsWith("i") && m.endsWith("86")) return "ia32";
  if (m.startsWith("riscv")) return "riscv64";
  return m || "x64";
})();

function writeFdSync(fd, chunk, encoding) {
  const b = typeof chunk === "string" ? Buffer.from(chunk, encoding)
    : Buffer.from(chunk);
  if (fd === 1)
    native.stdoutWrite(b);
  else if (fd === 2)
    native.stderrWrite(b);
  else
    fsSync.writeSync(fd, b, 0, b.length);
}

class StdioStream extends EventEmitter {
  constructor(fd, name) {
    super();
    this.fd = fd;
    this._name = name;
    this.isTTY = !!native.isatty(fd);
    this.columns = 80;
    this.rows = 24;
    this.readable = fd === 0;
    this.writable = fd !== 0;
    this.destroyed = false;
    this._reading = false;
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    try {
      writeFdSync(this.fd, chunk, encoding);
      if (cb) queueMicrotask(cb);
      return true;
    } catch (e) {
      if (cb) queueMicrotask(() => cb(e));
      else this.emit("error", e);
      return false;
    }
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (chunk !== undefined)
      this.write(chunk, encoding);
    if (cb) queueMicrotask(cb);
  }
  setEncoding(enc) { this._encoding = enc; return this; }
  pause() {
    if (this._reading) {
      qjsos.setReadHandler(this.fd, null);
      this._reading = false;
    }
    return this;
  }
  resume() {
    if (this._reading)
      return this;
    this._reading = true;
    qjsos.setReadHandler(this.fd, () => {
      const tmp = Buffer.allocUnsafe(65536);
      const n = fsError(native.read(this.fd, tmp.length), "read");
      const buf = Buffer.from(n);
      if (buf.length === 0) {
        this._reading = false;
        qjsos.setReadHandler(this.fd, null);
        this.emit("end");
        this.emit("close");
        return;
      }
      this.emit("data", this._encoding
        ? buf.toString(this._encoding) : buf);
    });
    return this;
  }
  on(name, fn) {
    super.on(name, fn);
    if (this.readable && (name === "data" || name === "readable"))
      this.resume();
    return this;
  }
  destroy() {
    this.pause();
    this.destroyed = true;
    this.emit("close");
    return this;
  }
  ref() { return this; }
  unref() { return this; }
}

const stdout = new StdioStream(1, "stdout");
const stderr = new StdioStream(2, "stderr");
const stdin = new StdioStream(0, "stdin");

/* Reject already-emitted unhandled rejections, like Node does. */
const unhandledRejections = [];

let processExitHandlers = [];

const process = new EventEmitter();
Object.assign(process, {
  argv,
  execArgv: [],
  env: envObject(),
  pid: native.getpid(),
  ppid: native.getppid(),
  platform: "linux",
  arch: ARCH,
  title: "qnode",
  version: "v20.11.0",
  versions: {
    node: "20.11.0",
    qnode: "0.1.0",
    quickjs: "0.17.0",
    v8: undefined,
  },
  release: { name: "node", sourceUrl: "" },
  exitCode: undefined,
  stdout,
  stderr,
  stdin,
  config: { variables: {} },
  features: {},
});
delete process.versions.v8;

process.cwd = function() {
  const r = native.cwd();
  if (r[1])
    throw sysError(r[1], "getcwd");
  return r[0];
};
process.chdir = function(dir) {
  const err = native.chdir(String(dir));
  if (err)
    throw sysError(err, "chdir", dir);
};
process.umask = function(mask) {
  if (mask === undefined)
    return native.umask();
  return native.umask(mask);
};
process.kill = function(pid, sig) {
  const err = native.kill(pid, sig === undefined ? 15 : Number(sig));
  if (err)
    throw sysError(err, "kill", String(pid));
  return true;
};
process.getuid = () => native.getuid();
process.getgid = () => native.getgid();
process.geteuid = () => native.getuid();
process.getegid = () => native.getgid();
process.hrtime = function(prev) {
  const now = native.hrtime();
  let sec = now[0], nsec = now[1];
  if (prev) {
    sec -= prev[0];
    nsec -= prev[1];
    if (nsec < 0) { nsec += 1e9; sec--; }
  }
  return [sec, nsec];
};
process.hrtime.bigint = function() {
  const t = native.hrtime();
  return BigInt(t[0]) * 1000000000n + BigInt(t[1]);
};
process.uptime = () => (Date.now() - START_TIME) / 1000;
process.memoryUsage = function() {
  const r = native.meminfo();
  const total = r[0], free = r[1];
  const used = total - free;
  return {
    rss: used,
    heapTotal: used,
    heapUsed: used,
    external: 0,
    arrayBuffers: 0,
  };
};
process.memoryUsage.rss = () => process.memoryUsage().rss;
process.cpuUsage = function(prev) {
  const r = qjsos.gettimeofday ? null : null;
  const t = native.hrtime();
  const us = t[0] * 1e6 + t[1] / 1000;
  let user = us, system = 0;
  if (prev) {
    user = us - prev._us;
  }
  const out = { user, system };
  Object.defineProperty(out, "_us", { value: us, enumerable: false });
  return out;
};
process.resourceUsage = function() {
  return {
    userCPUTime: 0, systemCPUTime: 0, maxRSS: 0, sharedMemorySize: 0,
    unsharedDataSize: 0, unsharedStackSize: 0, minorPageFault: 0,
    majorPageFault: 0, swappedOut: 0, fsRead: 0, fsWrite: 0,
    ipcSent: 0, ipcReceived: 0, signalsCount: 0, voluntaryContextSwitches: 0,
    involuntaryContextSwitches: 0,
  };
};
process.nextTick = function(fn, ...args) {
  if (typeof fn !== "function")
    throw new TypeError("The callback argument must be of type function");
  queueMicrotask(() => fn(...args));
};
process.setUncaughtExceptionCaptureCallback = () => {};
process.hasUncaughtExceptionCaptureCallback = () => false;
process.emitWarning = function(warning, type, code, ctor) {
  let w = warning;
  if (!(warning instanceof Error)) {
    w = new Error(String(warning));
    w.name = type || "Warning";
    if (code) w.code = code;
  }
  if (process.listenerCount("warning"))
    process.emit("warning", w);
  else
    stderr.write("(node:" + process.pid + ") " + (w.stack || String(w)) + "\n");
};
process.binding = function(name) {
  throw new Error("No such module: " + name);
};
process.dlopen = function() {
  throw new Error("Native addons are not supported");
};
process._linkedBinding = process.binding;
process.reallyExit = function(code) { qjsstd.exit(code || 0); };
process.abort = function() { native.abort(); };
process.exit = function(code) {
  if (code !== undefined)
    process.exitCode = code;
  const c = process.exitCode === undefined ? 0 : process.exitCode;
  for (const fn of process.listeners("exit")) {
    try { fn(c); } catch (e) { /* ignore */ }
  }
  qjsstd.exit(typeof c === "number" ? c : 0);
};
process.cwd = process.cwd.bind(process);

const os = {
  EOL: "\n",
  devNull: "/dev/null",
  platform: () => "linux",
  arch: () => ARCH,
  type: () => "Linux",
  release: () => unameInfo.release || "",
  version: () => unameInfo.version || "",
  machine: () => unameInfo.machine || ARCH,
  hostname: () => native.hostname(),
  tmpdir: () => process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp",
  homedir: () => process.env.HOME || "/",
  endianness: () => "LE",
  availableParallelism: () => native.cpuCount(),
  cpus: () => {
    const n = native.cpuCount();
    const speed = 2400;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        model: unameInfo.machine || "unknown",
        speed, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      });
    }
    return out;
  },
  totalmem: () => native.meminfo()[0],
  freemem: () => native.meminfo()[1],
  uptime: () => process.uptime(),
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  userInfo: () => ({
    uid: native.getuid(), gid: native.getgid(),
    username: process.env.USER || "unknown",
    homedir: os.homedir(), shell: process.env.SHELL || "/bin/sh",
  }),
  constants: {},
};

/* ------------------------------------------------------------------ */
/* timers                                                             */
/* ------------------------------------------------------------------ */

class Timeout {
  constructor(fn, delay, args, repeat) {
    this._fn = fn;
    this._args = args;
    this._delay = delay;
    this._repeat = !!repeat;
    this._cleared = false;
    this._ref = true;
    this._schedule();
  }
  _schedule() {
    const cb = () => {
      if (this._cleared)
        return;
      if (!this._repeat)
        this._cleared = true;
      try { this._fn(...this._args); }
      catch (e) { reportError(e); }
    };
    this._id = this._repeat
      ? qjsos.setInterval(cb, this._delay)
      : qjsos.setTimeout(cb, this._delay);
  }
  ref() { this._ref = true; return this; }
  unref() { this._ref = false; return this; }
  hasRef() { return this._ref; }
  refresh() {
    this.close();
    this._cleared = false;
    this._schedule();
    return this;
  }
  close() {
    if (!this._cleared) {
      this._cleared = true;
      qjsos.clearTimeout(this._id);
    }
    return this;
  }
  [Symbol.toPrimitive]() { return this._id; }
  [Symbol.dispose]() { this.close(); }
}

function validateDelay(delay) {
  delay = Number(delay);
  if (!(delay >= 1 && delay <= 2147483647))
    delay = 1;
  return delay | 0;
}

function setTimeout(fn, delay, ...args) {
  if (typeof fn !== "function")
    throw new TypeError("The callback argument must be of type function");
  return new Timeout(fn, validateDelay(delay), args, false);
}

function setInterval(fn, delay, ...args) {
  if (typeof fn !== "function")
    throw new TypeError("The callback argument must be of type function");
  return new Timeout(fn, validateDelay(delay), args, true);
}

function clearTimeout(timer) {
  if (timer === undefined || timer === null)
    return;
  if (timer instanceof Timeout) {
    timer.close();
    return;
  }
  qjsos.clearTimeout(timer);
}

const clearInterval = clearTimeout;

function setImmediate(fn, ...args) {
  return setTimeout(fn, 1, ...args);
}

function clearImmediate(timer) {
  clearTimeout(timer);
}

/* ------------------------------------------------------------------ */
/* console                                                            */
/* ------------------------------------------------------------------ */

const consoleTimes = new Map();
let consoleGroupIndent = "";

function consoleWrite(fd, args) {
  const s = format(...args) + "\n";
  writeFdSync(fd, consoleGroupIndent + s);
}

const console = {
  log(...args) { consoleWrite(1, args); },
  info(...args) { consoleWrite(1, args); },
  debug(...args) { consoleWrite(1, args); },
  warn(...args) { consoleWrite(2, args); },
  error(...args) { consoleWrite(2, args); },
  trace(...args) {
    const err = new Error(format(...args));
    err.name = "Trace";
    consoleWrite(2, [err.stack]);
  },
  dir(obj, options) {
    consoleWrite(1, [inspect(obj, options)]);
  },
  dirxml(...args) { consoleWrite(1, args); },
  table(data) { consoleWrite(1, [data]); },
  assert(cond, ...args) {
    if (!cond)
      consoleWrite(2, ["Assertion failed" + (args.length ? ": " + format(...args) : "")]);
  },
  time(label) { consoleTimes.set(label === undefined ? "default" : label, Date.now()); },
  timeEnd(label) {
    label = label === undefined ? "default" : label;
    const t = consoleTimes.get(label);
    if (t === undefined)
      return;
    consoleTimes.delete(label);
    consoleWrite(1, [label + ": " + (Date.now() - t) + "ms"]);
  },
  timeLog(label, ...args) {
    const t = consoleTimes.get(label);
    if (t === undefined)
      return;
    consoleWrite(1, [label + ": " + (Date.now() - t) + "ms", ...args]);
  },
  group(...args) {
    if (args.length)
      consoleWrite(1, args);
    consoleGroupIndent += "  ";
  },
  groupCollapsed(...args) { console.group(...args); },
  groupEnd() {
    consoleGroupIndent = consoleGroupIndent.slice(0, -2);
  },
  count(label) {
    label = label === undefined ? "default" : label;
    const n = (console._counts.get(label) || 0) + 1;
    console._counts.set(label, n);
    consoleWrite(1, [label + ": " + n]);
  },
  countReset(label) {
    label = label === undefined ? "default" : label;
    console._counts.delete(label);
  },
  clear() { writeFdSync(1, "\x1b[2J\x1b[0;0H"); },
  _counts: new Map(),
};

/* ------------------------------------------------------------------ */
/* AbortController / EventTarget                                      */
/* ------------------------------------------------------------------ */

class Event {
  constructor(type, init) {
    this.type = String(type);
    this.bubbles = !!(init && init.bubbles);
    this.cancelable = !!(init && init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.timeStamp = Date.now();
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() { this._stop = true; }
}

class EventTarget {
  constructor() { this._listeners = Object.create(null); }
  addEventListener(type, fn, options) {
    if (typeof fn !== "function" && !(fn && typeof fn.handleEvent === "function"))
      return;
    let list = this._listeners[type];
    if (!list)
      list = this._listeners[type] = [];
    if (options && options.once)
      list = this._listeners[type] = list.filter((e) => e.fn !== fn);
    list.push({ fn, once: !!(options && options.once) });
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (!list)
      return;
    this._listeners[type] = list.filter((e) => e.fn !== fn);
  }
  dispatchEvent(event) {
    event.target = this;
    event.currentTarget = this;
    const list = this._listeners[event.type];
    if (list) {
      for (const entry of list.slice()) {
        if (entry.once)
          this.removeEventListener(event.type, entry.fn);
        if (typeof entry.fn === "function")
          entry.fn.call(this, event);
        else
          entry.fn.handleEvent(event);
        if (event._stop)
          break;
      }
    }
    const on = this["on" + event.type];
    if (typeof on === "function")
      on.call(this, event);
    return !event.defaultPrevented;
  }
}

class AbortSignal extends EventTarget {
  constructor() {
    super();
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
  }
  throwIfAborted() {
    if (this.aborted)
      throw this.reason;
  }
  static abort(reason) {
    const s = new AbortSignal();
    s.aborted = true;
    s.reason = reason === undefined
      ? new Error("This operation was aborted") : reason;
    return s;
  }
  static timeout(ms) {
    const s = new AbortSignal();
    const t = setTimeout(() => {
      s.aborted = true;
      s.reason = new Error("The operation was aborted due to timeout");
      s.reason.name = "TimeoutError";
      s.dispatchEvent(new Event("abort"));
    }, ms);
    if (t.unref) t.unref();
    return s;
  }
  static any(signals) {
    const s = new AbortSignal();
    for (const sig of signals) {
      if (sig.aborted) {
        s.aborted = true;
        s.reason = sig.reason;
        return s;
      }
      sig.addEventListener("abort", () => {
        s.aborted = true;
        s.reason = sig.reason;
        s.dispatchEvent(new Event("abort"));
      }, { once: true });
    }
    return s;
  }
}

class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) {
    if (this.signal.aborted)
      return;
    this.signal.aborted = true;
    this.signal.reason = reason === undefined
      ? new Error("The operation was aborted") : reason;
    this.signal.reason.name = this.signal.reason.name || "AbortError";
    this.signal.dispatchEvent(new Event("abort"));
  }
}

/* ------------------------------------------------------------------ */
/* URL / querystring                                                  */
/* ------------------------------------------------------------------ */

function qsEscape(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, "+")
    .replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function qsUnescape(str) {
  return decodeURIComponent(str.replace(/\+/g, " "));
}

class URLSearchParams {
  constructor(init) {
    this._list = [];
    if (init === undefined || init === null)
      return;
    if (typeof init === "string") {
      let s = init;
      if (s.startsWith("?"))
        s = s.slice(1);
      if (!s)
        return;
      for (const part of s.split("&")) {
        if (!part)
          continue;
        const idx = part.indexOf("=");
        const k = idx < 0 ? part : part.slice(0, idx);
        const v = idx < 0 ? "" : part.slice(idx + 1);
        this._list.push([qsUnescape(k), qsUnescape(v)]);
      }
      return;
    }
    if (typeof init === "object" && typeof init[Symbol.iterator] === "function") {
      for (const pair of init) {
        const p = Array.from(pair);
        this._list.push([String(p[0]), String(p[1])]);
      }
      return;
    }
    if (typeof init === "object") {
      for (const k of Object.keys(init))
        this._list.push([k, String(init[k])]);
    }
  }
  get size() { return this._list.length; }
  append(k, v) { this._list.push([String(k), String(v)]); }
  delete(k) {
    k = String(k);
    this._list = this._list.filter((p) => p[0] !== k);
  }
  get(k) {
    k = String(k);
    for (const p of this._list)
      if (p[0] === k)
        return p[1];
    return null;
  }
  getAll(k) {
    k = String(k);
    return this._list.filter((p) => p[0] === k).map((p) => p[1]);
  }
  has(k) {
    k = String(k);
    return this._list.some((p) => p[0] === k);
  }
  set(k, v) {
    k = String(k); v = String(v);
    let found = false;
    const out = [];
    for (const p of this._list) {
      if (p[0] !== k)
        out.push(p);
      else if (!found) { out.push([k, v]); found = true; }
    }
    if (!found)
      out.push([k, v]);
    this._list = out;
  }
  sort() {
    this._list.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  }
  toString() {
    return this._list.map((p) => qsEscape(p[0]) + "=" + qsEscape(p[1]))
      .join("&");
  }
  forEach(fn, thisArg) {
    for (const p of this._list)
      fn.call(thisArg, p[1], p[0], this);
  }
  *entries() { for (const p of this._list) yield [p[0], p[1]]; }
  *keys() { for (const p of this._list) yield p[0]; }
  *values() { for (const p of this._list) yield p[1]; }
  [Symbol.iterator]() { return this.entries(); }
}

function parseAuthority(rest) {
  let userinfo = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let hostname = rest, port = "";
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end >= 0) {
      hostname = rest.slice(0, end + 1);
      if (rest[end + 1] === ":")
        port = rest.slice(end + 2);
    }
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon >= 0 && /^\d*$/.test(rest.slice(colon + 1))) {
      hostname = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
  }
  let username = "", password = "";
  if (userinfo) {
    const c = userinfo.indexOf(":");
    if (c < 0) {
      username = decodeURIComponent(userinfo);
    } else {
      username = decodeURIComponent(userinfo.slice(0, c));
      password = decodeURIComponent(userinfo.slice(c + 1));
    }
  }
  return { username, password, hostname: hostname.toLowerCase(), port };
}

const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/;

class URL {
  constructor(input, base) {
    if (arguments.length === 0)
      throw new TypeError("URL constructor requires an argument");
    let str = String(input);
    const b = base === undefined ? null
      : (base instanceof URL ? base.href : String(base));
    if (b !== null) {
      const bm = URL_RE.exec(b);
      if (!bm)
        throw new TypeError("Invalid base URL");
      if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(str)) {
        if (str.startsWith("//")) {
          str = bm[1] + str;
        } else if (str.startsWith("/")) {
          str = bm[1] + (bm[2] || "") + str;
        } else if (str.startsWith("#")) {
          str = bm[1] + (bm[2] || "") + (bm[3] || "") + (bm[4] || "") + str;
        } else if (str.startsWith("?")) {
          str = bm[1] + (bm[2] || "") + (bm[3] || "") + str;
        } else {
          const dir = (bm[3] || "/");
          str = bm[1] + (bm[2] || "") +
            dir.slice(0, dir.lastIndexOf("/") + 1) + str;
        }
      }
    }
    const m = URL_RE.exec(str);
    if (!m)
      throw new TypeError("Invalid URL: " + str);
    this._protocol = m[1].toLowerCase();
    this._username = "";
    this._password = "";
    this._hostname = "";
    this._port = "";
    if (m[2]) {
      const a = parseAuthority(m[2].slice(2));
      this._username = a.username;
      this._password = a.password;
      this._hostname = a.hostname;
      this._port = a.port;
    }
    let pathname = m[3] || "/";
    if (!pathname.startsWith("/"))
      pathname = "/" + pathname;
    if (pathname.length > 1 && pathname.endsWith("/"))
      pathname = pathname.slice(0, -1);
    this._pathname = pathname;
    this._search = (m[4] || "").replace(/#.*$/, "");
    this._hash = m[5] || "";
    this._searchParams = null;
  }
  static canParse(input, base) {
    try { new URL(input, base); return true; } catch (e) { return false; }
  }
  static parse(input, base) {
    try { return new URL(input, base); } catch (e) { return null; }
  }
  get protocol() { return this._protocol; }
  set protocol(v) { this._protocol = String(v).replace(/:?$/, ":") .toLowerCase(); }
  get username() { return this._username; }
  set username(v) { this._username = String(v); }
  get password() { return this._password; }
  set password(v) { this._password = String(v); }
  get hostname() { return this._hostname; }
  set hostname(v) { this._hostname = String(v).toLowerCase(); }
  get port() { return this._port; }
  set port(v) { this._port = String(v); }
  get host() { return this._hostname + (this._port ? ":" + this._port : ""); }
  set host(v) {
    const a = parseAuthority(String(v));
    this._hostname = a.hostname;
    this._port = a.port;
  }
  get pathname() { return this._pathname; }
  set pathname(v) {
    this._pathname = String(v).startsWith("/") ? String(v) : "/" + v;
  }
  get search() {
    if (!this._search)
      return "";
    return this._search.startsWith("?") ? this._search : "?" + this._search;
  }
  set search(v) {
    v = String(v);
    this._search = v && !v.startsWith("?") ? "?" + v : v;
    this._searchParams = null;
  }
  get searchParams() {
    if (!this._searchParams)
      this._searchParams = new URLSearchParams(this.search);
    return this._searchParams;
  }
  get hash() {
    if (!this._hash)
      return "";
    return this._hash.startsWith("#") ? this._hash : "#" + this._hash;
  }
  set hash(v) {
    v = String(v);
    this._hash = v && !v.startsWith("#") ? "#" + v : v;
  }
  get origin() {
    if (this._protocol === "file:")
      return "null";
    return this._protocol + "//" + this.host;
  }
  get href() {
    let auth = "";
    if (this._hostname) {
      if (this._username || this._password) {
        auth = encodeURIComponent(this._username);
        if (this._password)
          auth += ":" + encodeURIComponent(this._password);
        auth += "@";
      }
      auth += this.host;
    }
    const sp = this._searchParams ? this._searchParams.toString()
      : this.search.replace(/^\?/, "");
    return this._protocol + (this._hostname ? "//" + auth : "") +
      this._pathname + (sp ? "?" + sp : "") + this.hash;
  }
  set href(v) { this._assign(new URL(v).href); }
  _assign(str) {
    const u = new URL(str);
    this._protocol = u._protocol;
    this._username = u._username;
    this._password = u._password;
    this._hostname = u._hostname;
    this._port = u._port;
    this._pathname = u._pathname;
    this._search = u._search;
    this._hash = u._hash;
    this._searchParams = null;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
}

const querystring = {
  escape: qsEscape,
  unescape: qsUnescape,
  stringify(obj, sep, eq) {
    sep = sep || "&"; eq = eq || "=";
    const parts = [];
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v === undefined)
        continue;
      if (Array.isArray(v)) {
        for (const item of v)
          parts.push(qsEscape(k) + eq + qsEscape(item));
      } else {
        parts.push(qsEscape(k) + eq + qsEscape(v));
      }
    }
    return parts.join(sep);
  },
  parse(str, sep, eq) {
    sep = sep || "&"; eq = eq || "=";
    const out = Object.create(null);
    if (typeof str !== "string" || !str)
      return out;
    for (const part of str.split(sep)) {
      if (!part)
        continue;
      const idx = part.indexOf(eq);
      const k = qsUnescape(idx < 0 ? part : part.slice(0, idx));
      const v = idx < 0 ? "" : qsUnescape(part.slice(idx + eq.length));
      if (out[k] === undefined)
        out[k] = v;
      else if (Array.isArray(out[k]))
        out[k].push(v);
      else
        out[k] = [out[k], v];
    }
    return out;
  },
};

function fileURLToPath(u) {
  u = u instanceof URL ? u : new URL(u);
  if (u.protocol !== "file:")
    throw new TypeError("The URL must be of scheme file");
  let p = decodeURIComponent(u.pathname);
  return p;
}

function pathToFileURL(p) {
  const abs = pathResolve(String(p));
  return new URL("file://" + abs.split("/").map((s) => encodeURIComponent(s))
    .join("/"));
}

const urlModule = {
  URL,
  URLSearchParams,
  parse: (u, parseQuery) => {
    const r = new URL(u, "file:///");
    return {
      protocol: r.protocol,
      host: r.host,
      hostname: r.hostname,
      port: r.port,
      pathname: r.pathname,
      search: r.search,
      query: parseQuery === false ? r.search.slice(1)
        : querystring.parse(r.search.slice(1)),
      hash: r.hash,
      href: r.href,
    };
  },
  format: (o) => {
    if (typeof o === "string")
      return o;
    let out = o.protocol || "";
    if (o.host || o.hostname)
      out += "//" + (o.host || o.hostname) + (o.port ? ":" + o.port : "");
    out += o.pathname || "";
    if (o.query && typeof o.query === "object")
      out += "?" + querystring.stringify(o.query);
    else if (o.search)
      out += o.search;
    if (o.hash)
      out += o.hash;
    return out;
  },
  resolve: (from, to) => new URL(to, from).href,
  fileURLToPath,
  pathToFileURL,
};

/* ------------------------------------------------------------------ */
/* node_modules resolution                                            */
/* ------------------------------------------------------------------ */

const builtins = Object.create(null);
const cjsCache = Object.create(null);
let mainModule = null;

function stripNodePrefix(name) {
  return name.startsWith("node:") ? name.slice(5) : name;
}

function isBuiltin(name) {
  if (name.startsWith("qjs:") || name.startsWith("qnode:"))
    return true;
  return Object.prototype.hasOwnProperty.call(builtins, stripNodePrefix(name));
}

function statOrNull(p) {
  try { return new Stats(fsError(native.stat(p, true), "stat", p)); }
  catch (e) { return null; }
}

function isFile(p) {
  const s = statOrNull(p);
  return !!s && s.isFile();
}

function isDir(p) {
  const s = statOrNull(p);
  return !!s && s.isDirectory();
}

function readJSONFile(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return null;
  }
}

const pkgCache = Object.create(null);

function readPackage(dir) {
  if (dir in pkgCache)
    return pkgCache[dir];
  const p = pathJoin(dir, "package.json");
  let pkg = null;
  if (isFile(p)) {
    pkg = readJSONFile(p);
    if (pkg)
      pkg.__dir = dir;
  }
  pkgCache[dir] = pkg;
  return pkg;
}

function findPackage(fromDir) {
  let dir = fromDir;
  for (;;) {
    const pkg = readPackage(dir);
    if (pkg)
      return pkg;
    const parent = pathDirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}

const kindCache = Object.create(null);

function moduleKind(p) {
  const ext = pathExtname(p).toLowerCase();
  if (ext === ".mjs") return "esm";
  if (ext === ".cjs") return "cjs";
  if (ext === ".json") return "json";
  if (ext === ".node") return "native";
  if (ext === ".wasm") return "wasm";
  const dir = pathDirname(p);
  if (dir in kindCache)
    return kindCache[dir];
  const pkg = findPackage(dir);
  const kind = pkg && pkg.type === "module" ? "esm" : "cjs";
  kindCache[dir] = kind;
  return kind;
}

function resolveConditional(value, kind) {
  if (typeof value === "string")
    return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = resolveConditional(v, kind);
      if (r !== null)
        return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const order = kind === "require"
      ? ["node", "require", "default"]
      : ["node", "import", "default"];
    for (const key of order) {
      if (value[key] !== undefined) {
        const r = resolveConditional(value[key], kind);
        if (r !== null)
          return r;
      }
    }
  }
  return null;
}

function resolvePackageExports(pkg, subpath, kind) {
  const ex = pkg.exports;
  if (ex === undefined || ex === null)
    return null;
  const key = subpath ? "./" + subpath.replace(/^\.\//, "") : ".";
  if (typeof ex === "string" || Array.isArray(ex)) {
    return key === "." ? resolveConditional(ex, kind) : null;
  }
  if (typeof ex !== "object")
    return null;
  const keys = Object.keys(ex);
  const subpathMap = keys.some((k) => k.startsWith("."));
  if (!subpathMap)
    return key === "." ? resolveConditional(ex, kind) : null;
  if (Object.prototype.hasOwnProperty.call(ex, key))
    return resolveConditional(ex[key], kind);
  for (const pattern of keys) {
    const star = pattern.indexOf("*");
    if (star < 0)
      continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) &&
        key.length >= prefix.length + suffix.length) {
      const matched = key.slice(prefix.length, key.length - suffix.length);
      const target = resolveConditional(ex[pattern], kind);
      if (target !== null)
        return target.replace(/\*/g, matched);
    }
  }
  return undefined;
}

function resolvePackageImports(pkg, spec, kind) {
  const map = pkg.imports;
  if (!map || typeof map !== "object")
    return undefined;
  if (Object.prototype.hasOwnProperty.call(map, spec))
    return resolveConditional(map[spec], kind);
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf("*");
    if (star < 0)
      continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.startsWith(prefix) && spec.endsWith(suffix) &&
        spec.length >= prefix.length + suffix.length) {
      const matched = spec.slice(prefix.length, spec.length - suffix.length);
      const target = resolveConditional(map[pattern], kind);
      if (target !== null)
        return target.replace(/\*/g, matched);
    }
  }
  return undefined;
}

function resolveFile(p) {
  if (isFile(p))
    return realpathSafe(p);
  for (const ext of [".js", ".json", ".mjs", ".cjs"]) {
    if (isFile(p + ext))
      return realpathSafe(p + ext);
  }
  return null;
}

function realpathSafe(p) {
  try { return realpathSync(p); } catch (e) { return p; }
}

function resolveFileOrDir(p, kind) {
  const file = resolveFile(p);
  if (file)
    return file;
  if (!isDir(p))
    return null;
  const pkg = readPackage(p);
  if (pkg) {
    const ex = resolvePackageExports(pkg, "", kind);
    if (ex) {
      const r = resolveFileOrDir(pathJoin(p, ex), kind);
      if (r)
        return r;
    }
    if (pkg.main) {
      const r = resolveFileOrDir(pathJoin(p, pkg.main), kind);
      if (r)
        return r;
    }
  }
  for (const index of ["index.js", "index.json", "index.mjs", "index.cjs"]) {
    const q = pathJoin(p, index);
    if (isFile(q))
      return realpathSafe(q);
  }
  return null;
}

function splitPackageSpecifier(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    const name = parts.slice(0, 2).join("/");
    return { name, subpath: parts.slice(2).join("/") };
  }
  const slash = spec.indexOf("/");
  if (slash < 0)
    return { name: spec, subpath: "" };
  return { name: spec.slice(0, slash), subpath: spec.slice(slash + 1) };
}

function moduleNotFound(request, base) {
  const e = new Error("Cannot find module '" + request + "'" +
    (base ? "\nRequire stack:\n- " + base : ""));
  e.code = "MODULE_NOT_FOUND";
  return e;
}

function findInNodeModules(request, baseDir, kind) {
  const { name, subpath } = splitPackageSpecifier(request);
  let dir = baseDir;
  for (;;) {
    const pkgDir = pathJoin(dir, "node_modules", name);
    if (isDir(pkgDir)) {
      const pkg = readPackage(pkgDir);
      if (pkg && pkg.exports !== undefined) {
        const target = resolvePackageExports(pkg, subpath, kind);
        if (target === undefined) {
          const e = new Error("Package subpath '" + (subpath || ".") +
            "' is not defined by \"exports\" in " + pkgDir +
            "/package.json");
          e.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
          throw e;
        }
        if (target !== null) {
          const r = resolveFileOrDir(pathJoin(pkgDir, target), kind);
          if (r)
            return r;
        }
      } else {
        const target = subpath ? pathJoin(pkgDir, subpath) : pkgDir;
        const r = resolveFileOrDir(target, kind);
        if (r)
          return r;
      }
    }
    const parent = pathDirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  for (const p of String(process.env.NODE_PATH || "").split(":")) {
    if (!p)
      continue;
    const r = resolveFileOrDir(pathJoin(p, request), kind);
    if (r)
      return r;
  }
  throw moduleNotFound(request, baseDir);
}

function baseDirectory(base) {
  if (!base)
    return process.cwd();
  if (base.startsWith("qnode:") || base.startsWith("qjs:") ||
      base.startsWith("node:"))
    return process.cwd();
  if (isDir(base))
    return base;
  return pathDirname(pathResolve(base));
}

/* Resolve a specifier the way Node does. `kind` is "require" or "import". */
function resolveRequest(request, base, kind) {
  kind = kind || "require";
  request = String(request);
  if (request.startsWith("qnode:"))
    return request;
  if (request.startsWith("qjs:"))
    return request;
  if (request.startsWith("node:"))
    return "qnode:" + request.slice(5);
  if (isBuiltin(request))
    return "qnode:" + stripNodePrefix(request);

  const baseDir = baseDirectory(base);
  if (request.startsWith("#")) {
    const pkg = findPackage(baseDir);
    const target = pkg ? resolvePackageImports(pkg, request, kind) : undefined;
    if (target === undefined) {
      const e = new Error("Package import specifier \"" + request +
        "\" is not defined" + (pkg ? " in " + pkg.__dir : ""));
      e.code = "ERR_PACKAGE_IMPORT_NOT_DEFINED";
      throw e;
    }
    if (target === null)
      throw moduleNotFound(request, base);
    if (target.startsWith("./")) {
      const r = resolveFileOrDir(pathJoin(pkg.__dir, target), kind);
      if (r)
        return r;
      throw moduleNotFound(request, base);
    }
    return resolveRequest(target, pathJoin(pkg.__dir, "index.js"), kind);
  }
  if (request.startsWith("./") || request.startsWith("../") ||
      request === "." || request === ".." || request.startsWith("/")) {
    const target = request.startsWith("/") ? request
      : pathJoin(baseDir, request);
    const r = resolveFileOrDir(target, kind);
    if (r)
      return r;
    throw moduleNotFound(request, base);
  }
  return findInNodeModules(request, baseDir, kind);
}

function resolveRequestWithPaths(request, base, kind) {
  return resolveRequest(request, base, kind);
}

/* ------------------------------------------------------------------ */
/* CommonJS loader                                                    */
/* ------------------------------------------------------------------ */

function makeRequire(parentFilename) {
  const require = function require(spec) {
    const resolved = resolveRequest(spec, parentFilename, "require");
    if (resolved.startsWith("qnode:") || resolved.startsWith("qjs:")) {
      if (resolved.startsWith("qjs:"))
        return qjsBuiltin(resolved.slice(4));
      const name = resolved.slice(6);
      const b = builtins[name];
      if (!b)
        throw moduleNotFound(spec, parentFilename);
      return b;
    }
    return loadCJS(resolved, parentFilename);
  };
  require.resolve = function(spec) {
    return resolveRequest(spec, parentFilename, "require");
  };
  require.resolve.paths = function() {
    const out = [];
    let dir = baseDirectory(parentFilename);
    for (;;) {
      out.push(pathJoin(dir, "node_modules"));
      const parent = pathDirname(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
    return out;
  };
  require.cache = cjsCache;
  require.main = mainModule;
  return require;
}

function qjsBuiltin(name) {
  if (name === "std") return qjsstd;
  if (name === "os") return qjsos;
  return null;
}

function loadCJSFile(filename, parent) {
  if (cjsCache[filename])
    return cjsCache[filename].exports;

  const kind = moduleKind(filename);
  if (kind === "esm") {
    /* require() of an ES module: evaluate synchronously when possible. */
    const ns = native.requireEsm(filename);
    return ns;
  }
  if (kind === "json") {
    const mod = new Module(filename, asModule(parent));
    cjsCache[filename] = mod;
    try {
      mod.exports = JSON.parse(readFileSync(filename, "utf8")
        .replace(/^\uFEFF/, ""));
    } catch (e) {
      delete cjsCache[filename];
      throw e;
    }
    mod.loaded = true;
    return mod.exports;
  }
  if (kind === "native")
    throw new Error("Native addons are not supported: " + filename);

  let source = readFileSync(filename, "utf8");
  if (source.charCodeAt(0) === 0xfeff)
    source = source.slice(1);
  if (source.startsWith("#!"))
    source = "//" + source.slice(2);
  loadCJSSource(filename, source, parent);
  return cjsCache[filename].exports;
}

function loadCJSSource(filename, source, parent) {
  const mod = new Module(filename, asModule(parent));
  cjsCache[filename] = mod;
  const dirname = pathDirname(filename);
  const req = makeRequire(filename);
  try {
    const fn = new Function("exports", "require", "module", "__filename",
                            "__dirname", source + "\n//# sourceURL=" + filename);
    fn.call(mod.exports, mod.exports, req, mod, filename, dirname);
    mod.loaded = true;
  } catch (e) {
    delete cjsCache[filename];
    throw e;
  }
  return mod;
}

function asModule(parent) {
  if (!parent)
    return null;
  if (typeof parent === "string")
    return cjsCache[parent] || null;
  return Array.isArray(parent.children) ? parent : null;
}

class Module {
  constructor(id, parent) {
    this.id = id || ".";
    this.filename = id || null;
    this.path = id ? pathDirname(id) : process.cwd();
    this.exports = {};
    this.parent = asModule(parent);
    this.children = [];
    this.paths = [];
    this.loaded = false;
    if (this.parent)
      this.parent.children.push(this);
  }
  require(spec) {
    return makeRequire(this.filename)(spec);
  }
  load(id) {
    return loadCJSFile(id, this);
  }
  static createRequire(filename) {
    if (filename instanceof URL)
      filename = fileURLToPath(filename);
    return makeRequire(pathResolve(String(filename)));
  }
  static isBuiltin(name) {
    return isBuiltin(String(name));
  }
  static _resolveFilename(request, parent) {
    return resolveRequest(request, parent && parent.filename, "require");
  }
  static _load(request, parent, isMain) {
    return loadCJSFile(resolveRequest(request, parent && parent.filename,
                                     "require"), parent);
  }
  static _cache = cjsCache;
  static builtinModules = [
    "assert", "buffer", "child_process", "console", "constants", "crypto",
    "dns", "events", "fs", "http", "https", "module", "net", "os", "path",
    "process", "punycode", "querystring", "readline", "stream", "string_decoder",
    "timers", "tls", "tty", "url", "util", "vm", "worker_threads", "zlib",
  ];
  static wrap(source) {
    return "(function (exports, require, module, __filename, __dirname) {" +
      source + "\n})";
  }
}

function loadCJS(filename, parent) {
  return loadCJSFile(filename, parent);
}

/* ------------------------------------------------------------------ */
/* net                                                                */
/* ------------------------------------------------------------------ */

const kSocketFd = Symbol("fd");

function normalizeConnectArgs(args) {
  let options = {};
  let cb;
  if (typeof args[args.length - 1] === "function")
    cb = args[args.length - 1];
  if (typeof args[0] === "object" && args[0] !== null) {
    options = args[0];
  } else if (typeof args[0] === "string" && !isNaN(Number(args[1]))) {
    options = { port: Number(args[1]), host: args[0] };
  } else {
    options = { port: Number(args[0]), host: args[1] };
  }
  return { options, cb };
}

class Socket extends Duplex {
  constructor(options) {
    super({ objectMode: false });
    if (options && typeof options === "object") {
      this._initFromOptions(options);
    } else if (typeof options === "number") {
      this._fd = options;
    }
    this.connecting = false;
    this.destroyed = false;
    this.pending = false;
    this.readable = true;
    this.writable = true;
    this.server = null;
    this.timeout = 0;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._pendingWrite = null;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
  }

  _initFromOptions(o) {
    this.allowHalfOpen = !!o.allowHalfOpen;
    this.readable = true;
    this.writable = true;
  }

  _read() {}

  setNoDelay(noDelay) {
    if (this._fd !== undefined)
      native.setsockopt(this._fd, C.IPPROTO_TCP, C.TCP_NODELAY,
                        noDelay === false ? 0 : 1);
    return this;
  }

  setKeepAlive(enable, initialDelay) {
    if (this._fd !== undefined)
      native.setsockopt(this._fd, C.SOL_SOCKET, C.SO_KEEPALIVE,
                        enable ? 1 : 0);
    return this;
  }

  setTimeout(ms, cb) {
    this.timeout = ms;
    if (cb)
      this.once("timeout", cb);
    return this;
  }

  setEncoding(enc) {
    super.setEncoding(enc);
    return this;
  }

  address() {
    return {
      address: this.localAddress,
      family: this.localFamily || "IPv4",
      port: this.localPort,
    };
  }

  connect(...args) {
    const { options, cb } = normalizeConnectArgs(args);
    const self = this;
    this.connecting = true;
    if (cb)
      this.once("connect", cb);
    queueMicrotask(() => {
      /* Resolve host names ourselves so repeated connects reuse the DNS
         cache instead of paying for getaddrinfo on every socket. */
      let host = options.host || "127.0.0.1";
      let family = options.family === 6 ? 6 : 4;
      if (!/^[0-9.]+$/.test(host) && host.indexOf(":") < 0) {
        const r = dnsCached(host);
        const list = (r && !r[1] && r[0]) || [];
        const addr = list.find((a) => (family === 6
          ? a.family === C.AF_INET6 : a.family === C.AF_INET)) || list[0];
        if (!addr) {
          self.destroy(sysError(C.EADDRNOTAVAIL, "connect", host));
          return;
        }
        host = addr.address;
        family = addr.family === C.AF_INET6 ? 6 : 4;
      }
      const r = native.socket(family === 6 ? C.AF_INET6 : C.AF_INET,
                              C.SOCK_STREAM, 0);
      if (r[1]) {
        self.destroy(sysError(r[1], "socket"));
        return;
      }
      self._fd = r[0];
      if (options.noDelay !== false)
        self.setNoDelay(true);
      const err = native.connect(self._fd, host, options.port);
      if (err === 0) {
        self._afterConnect();
      } else if (err === C.EINPROGRESS || err === C.EAGAIN ||
                 err === C.EWOULDBLOCK) {
        qjsos.setWriteHandler(self._fd, () => {
          qjsos.setWriteHandler(self._fd, null);
          const so = native.getsockopt(self._fd, C.SOL_SOCKET, C.SO_ERROR);
          const e = so[1] ? so[1] : so[0];
          if (e) {
            self.destroy(sysError(e, "connect", options.host));
            return;
          }
          self._afterConnect();
        });
      } else {
        self.destroy(sysError(err, "connect", options.host));
      }
    });
    return this;
  }

  _afterConnect() {
    this.connecting = false;
    const local = native.getsockname(this._fd);
    if (!local[1]) {
      this.localAddress = local[0][0];
      this.localPort = local[0][2];
      this.localFamily = local[0][1] === C.AF_INET6 ? "IPv6" : "IPv4";
    }
    const peer = native.getpeername(this._fd);
    if (!peer[1]) {
      this.remoteAddress = peer[0][0];
      this.remotePort = peer[0][2];
    }
    this._attach();
    this.emit("connect");
    this.emit("ready");
  }

  _attach() {
    if (this._attached)
      return;
    this._attached = true;
    const fd = this._fd;
    qjsos.setReadHandler(fd, () => this._onReadable());
    this.resume();
  }

  _onReadable() {
    if (this.destroyed || this._fd === undefined)
      return;
    const r = native.read(this._fd, 65536);
    if (r[1]) {
      if (r[1] === C.EAGAIN || r[1] === C.EWOULDBLOCK || r[1] === C.EINTR)
        return;
      this.destroy(sysError(r[1], "read"));
      return;
    }
    const buf = Buffer.from(r[0]);
    if (buf.length === 0) {
      this.readable = false;
      qjsos.setReadHandler(this._fd, null);
      this.push(null);
      if (!this.allowHalfOpen)
        this.end();
      return;
    }
    this.bytesRead += buf.length;
    this.push(buf);
  }

  _write(chunk, encoding, cb) {
    const buf = toChunk(chunk, encoding);
    this._flushWrite(buf, cb);
  }

  _flushWrite(buf, cb) {
    if (this.destroyed) {
      cb(new Error("Socket is closed"));
      return;
    }
    if (this._fd === undefined) {
      this.once("connect", () => this._flushWrite(buf, cb));
      return;
    }
    let off = 0;
    const attempt = () => {
      while (off < buf.length) {
        const r = native.write(this._fd, buf.subarray(off));
        if (r[1]) {
          if (r[1] === C.EAGAIN || r[1] === C.EWOULDBLOCK) {
            this._pendingWrite = { buf, off, cb };
            qjsos.setWriteHandler(this._fd, () => {
              qjsos.setWriteHandler(this._fd, null);
              const p = this._pendingWrite;
              this._pendingWrite = null;
              if (p) {
                off = p.off;
                buf = p.buf;
                cb = p.cb;
                attempt();
              }
            });
            return;
          }
          cb(sysError(r[1], "write"));
          return;
        }
        if (r[0] === 0)
          break;
        off += r[0];
        this.bytesWritten += r[0];
      }
      cb();
    };
    attempt();
  }

  end(data, encoding, cb) {
    if (typeof data === "function") { cb = data; data = undefined; }
    const self = this;
    if (data !== undefined && data !== null)
      this.write(data, encoding);
    this._ending = true;
    const finish = () => {
      if (self._fd !== undefined) {
        native.shutdown(self._fd, C.SHUT_WR);
        self.writable = false;
      }
      if (cb)
        self.once("finish", cb);
      self.emit("finish");
      if (self.allowHalfOpen)
        self._maybeClose();
      else
        self.destroySoon();
    };
    if (this._pendingWrite)
      this.once("drain", finish);
    else
      finish();
    return this;
  }

  _maybeClose() {
    if (this.destroyed)
      return;
    if (!this.readable && !this.writable)
      this.destroy();
  }

  destroySoon() {
    queueMicrotask(() => this.destroy());
  }

  destroy(err) {
    if (this.destroyed)
      return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    const fd = this._fd;
    this._fd = undefined;
    if (fd !== undefined) {
      qjsos.setReadHandler(fd, null);
      qjsos.setWriteHandler(fd, null);
      native.close(fd);
    }
    if (this._destroyTimer)
      clearTimeout(this._destroyTimer);
    this.emit("close", !!err);
    if (err && this.listenerCount("error"))
      this.emit("error", err);
    else if (err && !this.listenerCount("error"))
      reportError(err);
    return this;
  }

  ref() { return this; }
  unref() { return this; }

  pause() { super.pause(); return this; }
  resume() { super.resume(); return this; }
}

function createConnection(...args) {
  const s = new Socket();
  s.connect(...args);
  return s;
}

class Server extends EventEmitter {
  constructor(options, connectionListener) {
    super();
    if (typeof options === "function") {
      connectionListener = options;
      options = {};
    }
    this._options = options || {};
    if (connectionListener)
      this.on("connection", connectionListener);
    this.listening = false;
    this.maxConnections = undefined;
    this._connections = 0;
    this._fd = undefined;
  }

  listen(...args) {
    let options = {};
    let cb;
    if (typeof args[args.length - 1] === "function")
      cb = args[args.length - 1];
    if (typeof args[0] === "object" && args[0] !== null)
      options = args[0];
    else if (typeof args[0] === "number")
      options = { port: args[0], host: args[1] };
    else if (typeof args[0] === "string" && !isNaN(Number(args[1])))
      options = { port: Number(args[1]), host: args[0] };
    else
      options = { path: args[0] };

    if (cb)
      this.once("listening", cb);

    const r = native.socket(options.family === 6 ? C.AF_INET6 : C.AF_INET,
                            C.SOCK_STREAM, 0);
    if (r[1])
      throw sysError(r[1], "socket");
    const fd = this._fd = r[0];
    native.setsockopt(fd, C.SOL_SOCKET, C.SO_REUSEADDR, 1);
    if (options.port !== undefined) {
      const err = native.bind(fd, options.host || "0.0.0.0",
                              Number(options.port));
      if (err) {
        native.close(fd);
        this._fd = undefined;
        const e = sysError(err, "bind", options.host);
        queueMicrotask(() => this.emit("error", e));
        return this;
      }
    }
    if (native.listen(fd, options.backlog || 511)) {
      const err = native.listen(fd, 0);
      native.close(fd);
      this._fd = undefined;
      queueMicrotask(() => this.emit("error", sysError(err, "listen")));
      return this;
    }
    const name = native.getsockname(fd);
    if (!name[1]) {
      this._address = name[0][0];
      this._port = name[0][2];
      this._family = name[0][1] === C.AF_INET6 ? "IPv6" : "IPv4";
    }
    this.listening = true;
    this._attached = true;
    qjsos.setReadHandler(fd, () => this._onConnection());
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  _onConnection() {
    for (;;) {
      const r = native.accept(this._fd);
      if (r[1]) {
        if (r[1] === C.EAGAIN || r[1] === C.EWOULDBLOCK ||
            r[1] === C.EINTR)
          return;
        this.emit("error", sysError(r[1], "accept"));
        return;
      }
      const sock = new Socket();
      sock._fd = r[0];
      sock.server = this;
      this._connections++;
      const peer = native.getpeername(sock._fd);
      if (!peer[1]) {
        sock.remoteAddress = peer[0][0];
        sock.remotePort = peer[0][2];
      }
      const local = native.getsockname(sock._fd);
      if (!local[1]) {
        sock.localAddress = local[0][0];
        sock.localPort = local[0][2];
      }
      sock._attach();
      sock.on("close", () => { this._connections--; });
      this.emit("connection", sock);
    }
  }

  address() {
    if (!this._fd)
      return null;
    return { address: this._address, family: this._family, port: this._port };
  }

  getConnections(cb) {
    queueMicrotask(() => cb(null, this._connections));
  }

  close(cb) {
    if (this._fd !== undefined) {
      qjsos.setReadHandler(this._fd, null);
      native.close(this._fd);
      this._fd = undefined;
    }
    this.listening = false;
    if (cb)
      queueMicrotask(cb);
    this.emit("close");
    return this;
  }

  ref() { return this; }
  unref() { return this; }
}

const net = {
  Socket,
  Server,
  Stream: Socket,
  createServer: (options, listener) => new Server(options, listener),
  createConnection,
  connect: createConnection,
  isIP(input) {
    const s = String(input);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) &&
        s.split(".").every((n) => Number(n) <= 255))
      return 4;
    if (/^[0-9a-fA-F:]+$/.test(s) && s.indexOf(":") >= 0 &&
        s.split(":").length <= 8)
      return 6;
    return 0;
  },
  isIPv4: (s) => net.isIP(s) === 4,
  isIPv6: (s) => net.isIP(s) === 6,
};

/* ------------------------------------------------------------------ */
/* http                                                               */
/* ------------------------------------------------------------------ */

const STATUS_CODES = {
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created",
  202: "Accepted", 204: "No Content", 206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other",
  304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
  409: "Conflict", 410: "Gone", 413: "Payload Too Large",
  414: "URI Too Long", 415: "Unsupported Media Type",
  418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity",
  426: "Upgrade Required", 429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout",
};

function parseHeaderBlock(text) {
  const lines = text.split("\r\n");
  const headers = Object.create(null);
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line)
      continue;
    const idx = line.indexOf(":");
    if (idx < 0)
      continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    raw.push(line);
    if (headers[key] === undefined)
      headers[key] = value;
    else if (key === "set-cookie")
      headers[key] = [].concat(headers[key], value);
    else
      headers[key] += ", " + value;
  }
  return { headers, rawHeaders: raw };
}

function headersToObject(headers) {
  const out = {};
  if (!headers)
    return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2)
      out[String(headers[i]).toLowerCase()] = headers[i + 1];
    return out;
  }
  for (const k of Object.keys(headers)) {
    if (headers[k] !== undefined)
      out[k.toLowerCase()] = headers[k];
  }
  return out;
}

class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = socket;
    this.connection = socket;
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.headers = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.complete = false;
    this.aborted = false;
    this.url = "";
    this.method = "";
    this.statusCode = undefined;
    this.statusMessage = undefined;
    this.readable = true;
  }
  setTimeout(ms, cb) {
    if (cb) this.once("timeout", cb);
    return this;
  }
}

class ServerResponse extends Writable {
  constructor(req, socket) {
    super();
    this.req = req;
    this.socket = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this.sendDate = true;
    this.finished = false;
    this._headers = Object.create(null);
    this._body = [];
  }

  setHeader(name, value) {
    this._headers[String(name).toLowerCase()] = value;
    return this;
  }
  getHeader(name) { return this._headers[String(name).toLowerCase()]; }
  getHeaders() { return Object.assign({}, this._headers); }
  hasHeader(name) {
    return this._headers[String(name).toLowerCase()] !== undefined;
  }
  removeHeader(name) { delete this._headers[String(name).toLowerCase()]; }
  flushHeaders() { this._writeHead(); }
  addTrailers() {}
  writeHead(code, message, headers) {
    if (typeof message === "object" && message !== null) {
      headers = message;
      message = undefined;
    }
    this.statusCode = code;
    if (message !== undefined)
      this.statusMessage = message;
    if (headers)
      for (const k of Object.keys(headers))
        this.setHeader(k, headers[k]);
    this._writeHead();
    return this;
  }

  _writeHead() {
    if (this.headersSent)
      return;
    this.headersSent = true;
    const msg = this.statusMessage || STATUS_CODES[this.statusCode] || "Unknown";
    let head = "HTTP/1.1 " + this.statusCode + " " + msg + "\r\n";
    if (this.sendDate && this._headers.date === undefined)
      this._headers.date = new Date().toUTCString();
    const keepAlive = this.req && this.req._keepAlive;
    if (this._headers.connection === undefined)
      this._headers.connection = keepAlive ? "keep-alive" : "close";
    let hasLength = false;
    for (const k of Object.keys(this._headers)) {
      const v = this._headers[k];
      if (k === "content-length")
        hasLength = true;
      if (Array.isArray(v))
        for (const item of v)
          head += k + ": " + item + "\r\n";
      else
        head += k + ": " + v + "\r\n";
    }
    this._headText = head;
    this._hasLength = hasLength;
  }

  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null)
      this._body.push(toChunk(chunk, encoding));
    if (cb) queueMicrotask(cb);
    return true;
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null)
      this._body.push(toChunk(chunk, encoding));
    this._writeHead();
    const body = Buffer.concat(this._body);
    if (!this._hasLength)
      this._headText = this._headText.replace(/\r\n$/,
        "\r\ncontent-length: " + body.length + "\r\n");
    const out = Buffer.concat([Buffer.from(this._headText + "\r\n"), body]);
    this.finished = true;
    const socket = this.socket;
    if (socket && !socket.destroyed)
      socket.write(out);
    this.emit("finish");
    if (this.req && this.req._keepAlive && socket && !socket.destroyed) {
      if (this.req._onResponseDone)
        this.req._onResponseDone();
    } else if (socket && !socket.destroyed) {
      socket.end();
    }
    if (cb) queueMicrotask(cb);
    return this;
  }
}

function bufferIndexOf(hay, needle, start) {
  outer:
  for (let i = start || 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j])
        continue outer;
    return i;
  }
  return -1;
}

class HttpServer extends EventEmitter {
  constructor(options, listener) {
    super();
    if (typeof options === "function") { listener = options; options = {}; }
    this._options = options || {};
    this._server = this._createServer(this._options);
    this._server.on("error", (e) => this.emit("error", e));
    this._server.on("listening", () => this.emit("listening"));
    this._server.on("close", () => this.emit("close"));
    if (listener)
      this.on("request", listener);
    this.timeout = 0;
    this.keepAliveTimeout = 5000;
    this.headersTimeout = 60000;
  }
  _createServer(options) {
    return net.createServer((socket) => this._onSocket(socket));
  }

  listen(...args) { this._server.listen(...args); return this; }
  close(cb) { this._server.close(cb); return this; }
  address() { return this._server.address(); }
  getConnections(cb) { this._server.getConnections(cb); }
  setTimeout(ms, cb) { this.timeout = ms; if (cb) this.once("timeout", cb); return this; }
  ref() { return this; }
  unref() { return this; }

  _onSocket(socket) {
    let buf = Buffer.alloc(0);
    let current = null;
    let expectBody = 0;
    let bodyChunks = [];
    let chunked = false;
    let chunkState = null;

    const reset = () => {
      buf = Buffer.alloc(0);
      current = null;
      expectBody = 0;
      bodyChunks = [];
      chunked = false;
      chunkState = null;
    };

    const finishRequest = () => {
      if (!current)
        return;
      const req = current;
      req._bodyData = Buffer.concat(bodyChunks);
      req.complete = true;
      const res = new ServerResponse(req, socket);
      current = null;
      req.res = res;
      this.emit("request", req, res);
      if (req._bodyData && req._bodyData.length)
        req.push(req._bodyData);
      req.push(null);
      req._bodyData = Buffer.alloc(0);
      bodyChunks = [];
    };

    const processBuffer = () => {
      for (;;) {
        if (!current) {
          const idx = bufferIndexOf(buf, Buffer.from("\r\n\r\n"));
          if (idx < 0)
            return;
          const head = utf8Decode(buf, 0, idx);
          const rest = buf.subarray(idx + 4);
          const lines = head.split("\r\n");
          const first = (lines.shift() || "").split(" ");
          const req = new IncomingMessage(socket);
          req.method = first[0] || "GET";
          req.url = first[1] || "/";
          req.httpVersion = (first[2] || "HTTP/1.1").slice(5);
          const parsed = parseHeaderBlock(lines.join("\r\n"));
          req.headers = parsed.headers;
          req.rawHeaders = parsed.rawHeaders;
          req._keepAlive = (req.headers.connection || "").toLowerCase() !== "close";
          buf = rest;
          current = req;
          const te = (req.headers["transfer-encoding"] || "").toLowerCase();
          if (te === "chunked") {
            chunked = true;
            chunkState = { pos: 0, chunks: [], remaining: 0, done: false };
          } else if (req.headers["content-length"] !== undefined) {
            expectBody = parseInt(req.headers["content-length"], 10) || 0;
          } else {
            expectBody = 0;
          }
          req._onResponseDone = () => {
            if (buf.length)
              processBuffer();
          };
          if (expectBody === 0 && !chunked) {
            finishRequest();
            continue;
          }
        }
        if (current && chunked) {
          /* decode chunked transfer-encoding */
          const decoded = decodeChunked(buf);
          if (decoded === null)
            return;
          buf = decoded.rest;
          bodyChunks.push(decoded.body);
          chunked = false;
          expectBody = 0;
          finishRequest();
          continue;
        }
        if (current && expectBody > 0) {
          if (buf.length < expectBody)
            return;
          bodyChunks.push(Buffer.from(buf.subarray(0, expectBody)));
          buf = buf.subarray(expectBody);
          expectBody = 0;
          finishRequest();
          continue;
        }
        return;
      }
    };

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        processBuffer();
      } catch (e) {
        this.emit("clientError", e, socket);
        socket.destroy();
      }
    });
    socket.on("end", () => {
      if (current)
        current.emit("aborted");
    });
    socket.on("error", (e) => this.emit("clientError", e, socket));
  }
}

function decodeChunked(buf) {
  const chunks = [];
  let pos = 0;
  for (;;) {
    const lineEnd = bufferIndexOf(buf, Buffer.from("\r\n"), pos);
    if (lineEnd < 0)
      return null;
    const sizeLine = utf8Decode(buf, pos, lineEnd).split(";")[0].trim();
    const size = parseInt(sizeLine, 16);
    if (isNaN(size))
      return null;
    pos = lineEnd + 2;
    if (size === 0) {
      const end = bufferIndexOf(buf, Buffer.from("\r\n"), pos);
      if (end < 0)
        return null;
      return { body: Buffer.concat(chunks), rest: buf.subarray(end + 2) };
    }
    if (buf.length < pos + size + 2)
      return null;
    chunks.push(Buffer.from(buf.subarray(pos, pos + size)));
    pos += size + 2;
  }
}

class ClientRequest extends Writable {
  constructor(options, cb) {
    super();
    if (typeof options === "string" || options instanceof URL) {
      const u = options instanceof URL ? options : new URL(options);
      options = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        auth: u.username ? u.username + ":" + u.password : undefined,
      };
    } else {
      options = Object.assign({}, options);
    }
    this._options = options;
    this.method = (options.method || "GET").toUpperCase();
    this.path = options.path || "/";
    this._headers = headersToObject(options.headers);
    this._chunks = [];
    this._sent = false;
    this.reusedSocket = false;
    this.aborted = false;
    if (cb)
      this.once("response", cb);
    this._connect();
  }

  setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; }
  getHeader(k) { return this._headers[k.toLowerCase()]; }
  removeHeader(k) { delete this._headers[k.toLowerCase()]; }
  flushHeaders() { this._sendHead(); }

  _connect() {
    const o = this._options;
    const port = Number(o.port) || (o.protocol === "https:" ? 443 : 80);
    const host = o.hostname || o.host || "localhost";
    if (typeof o.createConnection === "function") {
      this.socket = o.createConnection(Object.assign({}, o, { port, host }));
    } else {
      this.socket = new Socket();
      this.socket.connect({ port, host });
    }
    this.socket.on("connect", () => this.emit("socket", this.socket));
    this.socket.on("error", (e) => this.emit("error", e));
    this.socket.on("data", (chunk) => this._onData(chunk));
    this.socket.on("end", () => {
      if (!this.res)
        this._fail(new Error("socket hang up"));
      else if (!this.res.complete)
        this.res.push(null);
    });
  }

  _sendHead() {
    if (this._sent)
      return;
    this._sent = true;
    const o = this._options;
    const path = this.path;
    let head = this.method + " " + path + " HTTP/1.1\r\n";
    const headers = Object.assign({}, this._headers);
    if (headers.host === undefined)
      headers.host = o.hostname || o.host || "localhost";
    if (headers.connection === undefined)
      headers.connection = "close";
    if (headers["user-agent"] === undefined)
      headers["user-agent"] = "qnode/0.1";
    if (this._chunks.length && headers["content-length"] === undefined &&
        headers["transfer-encoding"] === undefined)
      headers["content-length"] = Buffer.concat(this._chunks).length;
    for (const k of Object.keys(headers)) {
      const v = headers[k];
      if (v === undefined)
        continue;
      if (Array.isArray(v))
        for (const item of v)
          head += k + ": " + item + "\r\n";
      else
        head += k + ": " + v + "\r\n";
    }
    this._rawHead = head + "\r\n";
    if (this.socket && !this.socket.destroyed)
      this.socket.write(Buffer.from(this._rawHead));
  }

  _write(chunk, encoding, cb) {
    if (!this._sent) {
      this._chunks.push(toChunk(chunk, encoding));
      this._sendHead();
      const body = Buffer.concat(this._chunks);
      this._chunks = [];
      this.socket.write(body);
    } else {
      this.socket.write(toChunk(chunk, encoding));
    }
    cb();
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null)
      this._chunks.push(toChunk(chunk, encoding));
    this._sendHead();
    if (this._chunks.length) {
      this.socket.write(Buffer.concat(this._chunks));
      this._chunks = [];
    }
    this.emit("finish");
    if (cb) queueMicrotask(cb);
    return this;
  }

  abort() {
    this.aborted = true;
    if (this.socket)
      this.socket.destroy();
    this.emit("abort");
  }

  setTimeout(ms, cb) {
    if (cb) this.once("timeout", cb);
    return this;
  }

  _onData(chunk) {
    this._respBuf = this._respBuf ? Buffer.concat([this._respBuf, chunk]) : chunk;
    if (!this.res) {
      const idx = bufferIndexOf(this._respBuf, Buffer.from("\r\n\r\n"));
      if (idx < 0)
        return;
      const head = utf8Decode(this._respBuf, 0, idx);
      const rest = this._respBuf.subarray(idx + 4);
      const lines = head.split("\r\n");
      const status = (lines.shift() || "").split(" ");
      const res = new IncomingMessage(this.socket);
      res.statusCode = parseInt(status[1], 10) || 0;
      res.statusMessage = status.slice(2).join(" ");
      const parsed = parseHeaderBlock(lines.join("\r\n"));
      res.headers = parsed.headers;
      res.rawHeaders = parsed.rawHeaders;
      this.res = res;
      this._respBuf = rest;
      this._body = [];
      const te = (res.headers["transfer-encoding"] || "").toLowerCase();
      this._chunked = te === "chunked";
      this._remaining = res.headers["content-length"] !== undefined
        ? parseInt(res.headers["content-length"], 10) : -1;
      this.emit("response", res);
      if (this._remaining === 0 || (this._remaining < 0 && !this._chunked &&
                                    this._respBuf.length === 0 &&
                                    res.headers.connection === "close")) {
        /* handled below */
      }
    }
    this._feedResponse();
  }

  _feedResponse() {
    const res = this.res;
    if (!res || res.complete)
      return;
    if (this._chunked) {
      const d = decodeChunked(this._respBuf);
      if (d === null)
        return;
      this._respBuf = d.rest;
      if (d.body.length)
        res.push(d.body);
      res.complete = true;
      this._chunked = false;
      res.push(null);
      return;
    }
    if (this._remaining >= 0) {
      const take = Math.min(this._remaining, this._respBuf.length);
      if (take > 0) {
        res.push(this._respBuf.subarray(0, take));
        this._respBuf = this._respBuf.subarray(take);
        this._remaining -= take;
      }
      if (this._remaining === 0) {
        res.complete = true;
        res.push(null);
      }
      return;
    }
    if (this._respBuf.length) {
      res.push(this._respBuf);
      this._respBuf = Buffer.alloc(0);
    }
  }

  _fail(err) {
    if (!this.listenerCount("error")) {
      reportError(err);
      return;
    }
    this.emit("error", err);
  }
}

function request(options, cb) {
  return new ClientRequest(options, cb);
}

function get(options, cb) {
  const req = new ClientRequest(options, cb);
  req.end();
  return req;
}

const http = {
  STATUS_CODES,
  METHODS: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  Server: HttpServer,
  ServerResponse,
  IncomingMessage,
  ClientRequest,
  Agent: class Agent { constructor(opts) { this.options = opts || {}; } destroy() {} },
  createServer: (options, listener) => new HttpServer(options, listener),
  request,
  get,
  globalAgent: { destroy() {} },
};
http.globalAgent = new http.Agent();

function httpsNormalize(options) {
  if (typeof options === "string" || options instanceof URL) {
    const u = options instanceof URL ? options : new URL(options);
    return {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      auth: u.username
        ? decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)
        : undefined,
    };
  }
  return Object.assign({}, options);
}

const TLS_REQUEST_OPTIONS = [
  "servername", "rejectUnauthorized", "ca", "cert", "key", "pfx",
  "passphrase", "ALPNProtocols", "checkServerIdentity", "minVersion",
  "maxVersion", "ciphers", "secureProtocol", "session",
];

function httpsRequest(options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  options = httpsNormalize(options || {});
  if (!options.protocol)
    options.protocol = "https:";
  if (options.servername === undefined)
    options.servername = options.hostname || options.host;
  if (typeof options.createConnection !== "function") {
    const tlsOpts = {};
    for (const k of TLS_REQUEST_OPTIONS)
      if (options[k] !== undefined)
        tlsOpts[k] = options[k];
    options.createConnection = (o) => tls.connect(Object.assign({}, tlsOpts, {
      port: o.port,
      host: o.host,
      servername: tlsOpts.servername || o.host,
    }));
  }
  return new ClientRequest(options, cb);
}

class HttpsServer extends HttpServer {
  _createServer(options) {
    return tls.createServer(options || {}, (socket) => this._onSocket(socket));
  }
}

const https = Object.assign({}, http, {
  Server: HttpsServer,
  request: httpsRequest,
  get(options, cb) {
    const req = httpsRequest(options, cb);
    req.end();
    return req;
  },
  createServer(options, listener) {
    if (typeof options === "function") { listener = options; options = {}; }
    return new HttpsServer(options, listener);
  },
});
https.globalAgent = new http.Agent();

/* ------------------------------------------------------------------ */
/* child_process                                                      */
/* ------------------------------------------------------------------ */

function decodeWaitStatus(status) {
  const sig = status & 0x7f;
  if (sig === 0)
    return { code: (status >> 8) & 0xff, signal: null };
  if (sig === 0x7f)
    return { code: (status >> 8) & 0xff, signal: null };
  return { code: null, signal: sig };
}

function signalName(num) {
  const names = {
    1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL",
    11: "SIGSEGV", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
    17: "SIGCHLD", 18: "SIGCONT", 19: "SIGSTOP",
  };
  return names[num] || "SIG" + num;
}

function stdioMode(value) {
  if (value === "pipe") return 1;
  if (value === "ignore") return 2;
  if (value === "inherit") return 0;
  if (typeof value === "number") return 0;
  return 0;
}

class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.spawnargs = [];
    this.stdout = null;
    this.stderr = null;
    this.stdin = null;
    this.connected = false;
    this._closed = false;
  }

  kill(signal) {
    if (this.pid === undefined)
      return false;
    this.killed = true;
    const sig = typeof signal === "string"
      ? ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }[signal] || 15)
      : (signal === undefined ? 15 : signal);
    native.kill(this.pid, sig);
    return true;
  }

  ref() { return this; }
  unref() { return this; }
  disconnect() {}
  send() { return false; }
}

function pipeReader(fd, stream) {
  if (fd < 0)
    return;
  qjsos.setReadHandler(fd, () => {
    const r = native.read(fd, 65536);
    if (r[1]) {
      if (r[1] === C.EAGAIN || r[1] === C.EWOULDBLOCK || r[1] === C.EINTR)
        return;
      qjsos.setReadHandler(fd, null);
      native.close(fd);
      stream.push(null);
      return;
    }
    const buf = Buffer.from(r[0]);
    if (buf.length === 0) {
      qjsos.setReadHandler(fd, null);
      native.close(fd);
      stream.push(null);
      return;
    }
    stream.push(buf);
  });
  stream.resume();
}

function spawn(command, args, options) {
  if (Array.isArray(args) === false && args && typeof args === "object") {
    options = args;
    args = [];
  }
  args = args || [];
  options = options || {};
  let file = String(command);
  let argv = [file, ...args.map(String)];
  if (options.shell) {
    const cmd = [file, ...args.map(String)].join(" ");
    const shell = typeof options.shell === "string" ? options.shell : "/bin/sh";
    file = shell;
    argv = [shell, "-c", cmd];
  }
  const stdio = options.stdio || ["pipe", "pipe", "pipe"];
  const modes = [
    stdioMode(stdio[0]), stdioMode(stdio[1]), stdioMode(stdio[2]),
  ];
  const envArr = options.env ? envPairs(options.env) : null;
  const r = native.spawn(argv, options.cwd || null, envArr,
                         modes[0], modes[1], modes[2]);
  const child = new ChildProcess();
  child.spawnargs = argv;
  if (r[1]) {
    const err = sysError(r[1], "spawn", file);
    queueMicrotask(() => child.emit("error", err));
    return child;
  }
  const [pid, stdinFd, stdoutFd, stderrFd] = r[0];
  child.pid = pid;
  if (stdoutFd >= 0) {
    child.stdout = new Readable({ read() {} });
    pipeReader(stdoutFd, child.stdout);
  }
  if (stderrFd >= 0) {
    child.stderr = new Readable({ read() {} });
    pipeReader(stderrFd, child.stderr);
  }
  if (stdinFd >= 0) {
    child.stdin = new Writable({
      write(chunk, encoding, cb) {
        try {
          const b = toChunk(chunk, encoding);
          let off = 0;
          while (off < b.length) {
            const n = fsError(native.write(stdinFd, b.subarray(off)), "write");
            if (!n) break;
            off += n;
          }
          cb();
        } catch (e) { cb(e); }
      },
      final(cb) {
        native.close(stdinFd);
        cb();
      },
    });
  }
  child.emit("spawn");

  const timer = setInterval(() => {
    const w = native.waitpid(pid, C.WNOHANG);
    if (w[1])
      return;
    if (w[0] === 0)
      return;
    clearInterval(timer);
    const { code, signal } = decodeWaitStatus(w[0][1]);
    child.exitCode = code;
    child.signalCode = signal ? signalName(signal) : null;
    child.emit("exit", code, child.signalCode);
    const closeWhenDone = () => {
      if (child._closed)
        return;
      child._closed = true;
      child.emit("close", code, child.signalCode);
    };
    let pending = 0;
    if (child.stdout) {
      pending++;
      child.stdout.once("end", () => { if (--pending === 0) closeWhenDone(); });
    }
    if (child.stderr) {
      pending++;
      child.stderr.once("end", () => { if (--pending === 0) closeWhenDone(); });
    }
    if (pending === 0)
      closeWhenDone();
    else
      setTimeout(closeWhenDone, 1000);
  }, 15);
  if (timer.unref)
    timer.unref();
  return child;
}

function execFile(file, args, options, cb) {
  if (typeof args === "function") { cb = args; args = []; options = {}; }
  else if (typeof options === "function") { cb = options; options = {}; }
  args = args || [];
  options = options || {};
  const child = spawn(file, args, Object.assign({}, options, {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let out = [], errOut = [];
  if (child.stdout)
    child.stdout.on("data", (c) => out.push(c));
  if (child.stderr)
    child.stderr.on("data", (c) => errOut.push(c));
  child.on("error", (e) => cb(e, Buffer.concat(out), Buffer.concat(errOut)));
  child.on("close", (code, signal) => {
    let stdout = Buffer.concat(out), stderr = Buffer.concat(errOut);
    const enc = options.encoding;
    if (enc) { stdout = stdout.toString(enc); stderr = stderr.toString(enc); }
    if (code !== 0) {
      const e = new Error("Command failed: " + file + " " + args.join(" "));
      e.code = code;
      e.killed = child.killed;
      e.signal = signal;
      e.cmd = file + " " + args.join(" ");
      e.stdout = stdout;
      e.stderr = stderr;
      cb(e, stdout, stderr);
    } else {
      cb(null, stdout, stderr);
    }
  });
  return child;
}

function exec(command, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  return execFile("/bin/sh", ["-c", String(command)], options, cb);
}

function spawnSync(command, args, options) {
  options = options || {};
  const argv = [String(command), ...(args || []).map(String)];
  const envArr = options.env ? envPairs(options.env) : null;
  const r = native.spawn(argv, options.cwd || null, envArr, 2, 1, 1);
  const result = {
    pid: undefined, output: [null, null, null], stdout: null, stderr: null,
    status: null, signal: null, error: null,
  };
  if (r[1]) {
    result.error = sysError(r[1], "spawn", command);
    return result;
  }
  const [pid, , outFd, errFd] = r[0];
  result.pid = pid;
  const out = [], errOut = [];
  const buffers = { [outFd]: out, [errFd]: errOut };
  for (const fd of [outFd, errFd])
    if (fd >= 0)
      native.setNonblock(fd);
  let exited = false, status = 0;
  for (;;) {
    for (const fd of [outFd, errFd]) {
      if (fd < 0 || buffers[fd] === null)
        continue;
      for (;;) {
        const x = native.read(fd, 65536);
        if (x[1]) {
          if (x[1] === C.EAGAIN || x[1] === C.EWOULDBLOCK)
            break;
          buffers[fd] = null;
          break;
        }
        const b = Buffer.from(x[0]);
        if (b.length === 0) {
          buffers[fd] = null;
          break;
        }
        buffers[fd].push(b);
      }
    }
    if (!exited) {
      const w = native.waitpid(pid, C.WNOHANG);
      /* w is [[pid, status], errno]; a zero pid means "still running". */
      if (!w[1] && w[0] !== null && w[0][0] !== 0) {
        exited = true;
        status = w[0][1];
      }
    }
    const done = exited && (outFd < 0 || buffers[outFd] === null) &&
      (errFd < 0 || buffers[errFd] === null);
    if (done)
      break;
    qjsos.sleep(1);
  }
  for (const fd of [outFd, errFd])
    if (fd >= 0)
      native.close(fd);
  const decoded = decodeWaitStatus(status);
  result.status = decoded.code;
  result.signal = decoded.signal ? signalName(decoded.signal) : null;
  result.stdout = Buffer.concat(out);
  result.stderr = Buffer.concat(errOut);
  result.output = [null, result.stdout, result.stderr];
  if (options.encoding && options.encoding !== "buffer") {
    result.stdout = result.stdout.toString(options.encoding);
    result.stderr = result.stderr.toString(options.encoding);
  }
  if (result.status !== 0) {
    const e = new Error("Command failed: " + command);
    e.status = result.status;
    e.signal = result.signal;
    e.stdout = result.stdout;
    e.stderr = result.stderr;
    result.error = e;
  }
  return result;
}

function execFileSync(file, args, options) {
  const r = spawnSync(file, args, options);
  if (r.error)
    throw r.error;
  return r.stdout;
}

function execSync(command, options) {
  try {
    return execFileSync("/bin/sh", ["-c", String(command)], options);
  } catch (e) {
    e.message = "Command failed: " + command +
      (e.stderr ? "\n" + String(e.stderr) : "");
    throw e;
  }
}

const child_process = {
  ChildProcess,
  spawn,
  exec,
  execFile,
  spawnSync,
  execSync,
  execFileSync,
  fork(modulePath, args, options) {
    args = args || [];
    options = options || {};
    return spawn(process.execPath, [modulePath, ...args], options);
  },
};

/* ------------------------------------------------------------------ */
/* crypto (hashes in JS, randomness from the OS)                      */
/* ------------------------------------------------------------------ */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++)
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

function padMessage(bytes, bigEndian) {
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const hi = Math.floor(bits / 4294967296) >>> 0;
  const lo = bits >>> 0;
  if (bigEndian) {
    m[total - 8] = hi >>> 24; m[total - 7] = (hi >>> 16) & 255;
    m[total - 6] = (hi >>> 8) & 255; m[total - 5] = hi & 255;
    m[total - 4] = lo >>> 24; m[total - 3] = (lo >>> 16) & 255;
    m[total - 2] = (lo >>> 8) & 255; m[total - 1] = lo & 255;
  } else {
    m[total - 8] = lo & 255; m[total - 7] = (lo >>> 8) & 255;
    m[total - 6] = (lo >>> 16) & 255; m[total - 5] = lo >>> 24;
    m[total - 4] = hi & 255; m[total - 3] = (hi >>> 8) & 255;
    m[total - 2] = (hi >>> 16) & 255; m[total - 1] = hi >>> 24;
  }
  return m;
}

function md5(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = padMessage(bytes, false);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = m[j] | (m[j + 1] << 8) | (m[j + 2] << 16) | (m[j + 3] << 24);
    }
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + MD5_K[i] + M[g]) | 0;
      B = (B + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Uint8Array(16);
  const words = [a, b, c, d];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      out[i * 4 + j] = (words[i] >>> (j * 8)) & 255;
  return out;
}

function sha1(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = padMessage(bytes, true);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe,
      h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const words = [h0, h1, h2, h3, h4];
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 4; j++)
      out[i * 4 + j] = (words[i] >>> (24 - j * 8)) & 255;
  return out;
}

const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const m = padMessage(bytes, true);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Int32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
                 ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
                 (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
                 ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
                 (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^
                 ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^
                 ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 4; j++)
      out[i * 4 + j] = (words[i] >>> (24 - j * 8)) & 255;
  return out;
}

function toBytes(data, encoding) {
  if (typeof data === "string")
    return Buffer.isBuffer(data) ? data : Buffer.from(data, encoding || "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer)
    return new Uint8Array(data);
  throw new TypeError("The data must be a string, Buffer or TypedArray");
}

class Hash {
  constructor(algorithm, key) {
    this._alg = algorithm;
    this._key = key;
    this._parts = [];
    this._finished = false;
  }
  update(data, encoding) {
    if (this._finished)
      throw new Error("Digest already called");
    this._parts.push(Buffer.from(toBytes(data, encoding)));
    return this;
  }
  digest(encoding) {
    this._finished = true;
    const input = Buffer.concat(this._parts);
    let out;
    if (this._alg === "md5")
      out = Buffer.from(md5(input));
    else if (this._alg === "sha1")
      out = Buffer.from(sha1(input));
    else if (this._alg === "sha256")
      out = Buffer.from(sha256(input));
    else if ((this._alg === "sha384" || this._alg === "sha512") &&
             typeof native.digest === "function")
      out = Buffer.from(native.digest(this._alg, input));
    else
      throw new Error("Digest method not supported: " + this._alg);
    return encoding ? out.toString(encoding) : out;
  }
  copy() {
    const h = new Hash(this._alg, this._key);
    h._parts = this._parts.slice();
    return h;
  }
}

const HASH_ALIASES = {
  md5: "md5", sha1: "sha1", "sha-1": "sha1", sha256: "sha256",
  "sha-256": "sha256", sha384: "sha384", "sha-384": "sha384",
  sha512: "sha512", "sha-512": "sha512",
};

function createHash(algorithm) {
  const alg = HASH_ALIASES[String(algorithm).toLowerCase()];
  if (!alg)
    throw new Error("Digest method not supported: " + algorithm);
  return new Hash(alg);
}

function hmac(alg, key, data) {
  const blockSize = 64;
  let k = Buffer.from(key);
  if (k.length > blockSize)
    k = Buffer.from(alg === "md5" ? md5(k) : alg === "sha1" ? sha1(k)
                                                             : sha256(k));
  const pad = Buffer.alloc(blockSize);
  k.copy(pad);
  const ipad = Buffer.alloc(blockSize), opad = Buffer.alloc(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = pad[i] ^ 0x36;
    opad[i] = pad[i] ^ 0x5c;
  }
  const inner = Buffer.concat([ipad, Buffer.from(data)]);
  const innerDigest = alg === "md5" ? md5(inner) : alg === "sha1"
    ? sha1(inner) : sha256(inner);
  const outer = Buffer.concat([opad, Buffer.from(innerDigest)]);
  return alg === "md5" ? md5(outer) : alg === "sha1" ? sha1(outer)
                                                     : sha256(outer);
}

function createHmac(algorithm, key) {
  const alg = HASH_ALIASES[String(algorithm).toLowerCase()];
  if (!alg)
    throw new Error("Digest method not supported: " + algorithm);
  return new Hash(alg, Buffer.from(key));
}

const crypto = {
  createHash,
  createHmac(algorithm, key) {
    const alg = HASH_ALIASES[String(algorithm).toLowerCase()];
    const keyBuf = Buffer.from(key);
    const self = {
      _parts: [],
      update(data, enc) { this._parts.push(Buffer.from(toBytes(data, enc))); return this; },
      digest(enc) {
        const out = Buffer.from(hmac(alg, keyBuf, Buffer.concat(this._parts)));
        return enc ? out.toString(enc) : out;
      },
    };
    return self;
  },
  randomBytes(size, cb) {
    const b = Buffer.from(native.randomBytes(size));
    if (cb) { queueMicrotask(() => cb(null, b)); return undefined; }
    return b;
  },
  randomFillSync(buf, offset, size) {
    offset = offset || 0;
    size = size === undefined ? buf.length - offset : size;
    const b = Buffer.from(native.randomBytes(size));
    b.copy(buf, offset);
    return buf;
  },
  randomFill(buf, offset, size, cb) {
    if (typeof offset === "function") { cb = offset; offset = 0; size = buf.length; }
    queueMicrotask(() => {
      try { crypto.randomFillSync(buf, offset, size); cb(null, buf); }
      catch (e) { cb(e); }
    });
  },
  randomUUID() {
    const b = Buffer.from(native.randomBytes(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = hexEncode(b, 0, 16);
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) +
      "-" + h.slice(16, 20) + "-" + h.slice(20);
  },
  randomInt(min, max, cb) {
    if (max === undefined) { max = min; min = 0; }
    const range = max - min;
    const b = native.randomBytes(6);
    let v = 0;
    for (const x of b) v = v * 256 + x;
    const n = min + (v % range);
    if (cb) { queueMicrotask(() => cb(null, n)); return undefined; }
    return n;
  },
  timingSafeEqual(a, b) {
    a = Buffer.from(a); b = Buffer.from(b);
    if (a.length !== b.length)
      throw new RangeError("Input buffers must have the same byte length");
    let r = 0;
    for (let i = 0; i < a.length; i++)
      r |= a[i] ^ b[i];
    return r === 0;
  },
  getRandomValues(arr) {
    const bytes = native.randomBytes(arr.byteLength);
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
      .set(Buffer.from(bytes));
    return arr;
  },
  webcrypto: {},
  subtle: {},
};
crypto.webcrypto.getRandomValues = crypto.getRandomValues;
crypto.webcrypto.randomUUID = crypto.randomUUID;
crypto.webcrypto.subtle = crypto.subtle;

/* ------------------------------------------------------------------ */
/* assert                                                             */
/* ------------------------------------------------------------------ */

class AssertionError extends Error {
  constructor(options) {
    const msg = options && options.message !== undefined
      ? String(options.message) : "Assertion failed";
    super(msg);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.generatedMessage = !(options && options.message !== undefined);
    if (options) {
      if ("actual" in options) this.actual = options.actual;
      if ("expected" in options) this.expected = options.expected;
      if (options.operator !== undefined) this.operator = options.operator;
    }
  }
}

function assert(value, message) {
  if (!value)
    throw new AssertionError({ message, actual: value, expected: true,
                               operator: "==" });
}

assert.ok = assert;
assert.AssertionError = AssertionError;
assert.fail = function(message) {
  throw new AssertionError({
    message: message === undefined ? "Failed" : message,
    operator: "fail",
  });
};
assert.equal = function(actual, expected, message) {
  if (actual != expected)
    throw new AssertionError({ message, actual, expected, operator: "==" });
};
assert.notEqual = function(actual, expected, message) {
  if (actual == expected)
    throw new AssertionError({ message, actual, expected, operator: "!=" });
};
assert.strictEqual = function(actual, expected, message) {
  if (!Object.is(actual, expected))
    throw new AssertionError({ message, actual, expected, operator: "strictEqual" });
};
assert.notStrictEqual = function(actual, expected, message) {
  if (Object.is(actual, expected))
    throw new AssertionError({ message, actual, expected, operator: "notStrictEqual" });
};
assert.deepEqual = function(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected))
    throw new AssertionError({ message, actual, expected, operator: "deepEqual" });
};
assert.deepStrictEqual = function(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected))
    throw new AssertionError({ message, actual, expected,
                               operator: "deepStrictEqual" });
};
assert.notDeepEqual = function(actual, expected, message) {
  if (isDeepStrictEqual(actual, expected))
    throw new AssertionError({ message, actual, expected, operator: "notDeepEqual" });
};
assert.notDeepStrictEqual = assert.notDeepEqual;
assert.throws = function(fn, error, message) {
  if (typeof error === "string") { message = error; error = undefined; }
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) {
    throw new AssertionError({
      message: message || "Missing expected exception",
      operator: "throws",
    });
  }
  if (error instanceof RegExp && !error.test(String(thrown)))
    throw new AssertionError({ message: message || "Missing expected exception",
                               actual: String(thrown), expected: String(error),
                               operator: "throws" });
  if (typeof error === "function" && !(thrown instanceof error))
    throw new AssertionError({ message: message || "Missing expected exception",
                               actual: thrown, expected: error,
                               operator: "throws" });
  return thrown;
};
assert.doesNotThrow = function(fn, error, message) {
  if (typeof error === "string") { message = error; error = undefined; }
  try { fn(); } catch (e) {
    throw new AssertionError({
      message: message || ("Got unwanted exception: " + (e && e.message)),
      actual: e, operator: "doesNotThrow",
    });
  }
};
assert.rejects = async function(fn, error, message) {
  let promise;
  try {
    promise = typeof fn === "function" ? fn() : fn;
  } catch (e) {
    throw new AssertionError({ message: "Missing expected rejection",
                               actual: e, operator: "rejects" });
  }
  try { await promise; }
  catch (e) {
    if (error instanceof RegExp && !error.test(String(e)))
      throw new AssertionError({ message: "Rejection did not match",
                                 actual: String(e), expected: String(error),
                                 operator: "rejects" });
    if (typeof error === "function" && !(e instanceof error))
      throw new AssertionError({ message: "Rejection did not match",
                                 actual: e, expected: error,
                                 operator: "rejects" });
    return e;
  }
  throw new AssertionError({ message: message || "Missing expected rejection",
                             operator: "rejects" });
};
assert.doesNotReject = async function(fn, error, message) {
  try { await (typeof fn === "function" ? fn() : fn); }
  catch (e) {
    throw new AssertionError({
      message: message || ("Got unwanted rejection: " + (e && e.message)),
      actual: e, operator: "doesNotReject",
    });
  }
};
assert.ifError = function(err) {
  if (err !== null && err !== undefined)
    throw err instanceof Error ? err
      : new AssertionError({ message: "ifError got unwanted exception: " + err,
                             actual: err, operator: "ifError" });
};
assert.match = function(str, re, message) {
  if (!re.test(str))
    throw new AssertionError({ message, actual: str, expected: re,
                               operator: "match" });
};
assert.doesNotMatch = function(str, re, message) {
  if (re.test(str))
    throw new AssertionError({ message, actual: str, expected: re,
                               operator: "doesNotMatch" });
};
assert.strict = assert;
assert.strict.strict = assert.strict;
assert.partialDeepStrictEqual = assert.deepStrictEqual;

/* ------------------------------------------------------------------ */
/* string_decoder                                                     */
/* ------------------------------------------------------------------ */

class StringDecoder {
  constructor(encoding) {
    this.encoding = normalizeEncoding(encoding || "utf8") || "utf8";
    this._leftover = Buffer.alloc(0);
  }
  write(buf) {
    if (typeof buf === "string")
      return buf;
    buf = Buffer.from(buf.buffer ? buf : buf);
    let data = this._leftover.length
      ? Buffer.concat([this._leftover, buf]) : buf;
    this._leftover = Buffer.alloc(0);
    if (this.encoding !== "utf8")
      return data.toString(this.encoding);
    let end = data.length;
    /* hold back an incomplete trailing UTF-8 sequence */
    for (let back = 1; back <= 3 && back <= data.length; back++) {
      const b = data[data.length - back];
      if ((b & 0xc0) === 0x80)
        continue;
      if (b >= 0xc0) {
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
        if (back < need)
          end = data.length - back;
        break;
      }
      break;
    }
    if (end < data.length)
      this._leftover = data.subarray(end);
    return utf8Decode(data, 0, end);
  }
  end(buf) {
    let out = "";
    if (buf)
      out += this.write(buf);
    if (this._leftover.length) {
      out += utf8Decode(this._leftover, 0, this._leftover.length);
      this._leftover = Buffer.alloc(0);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* small core modules                                                 */
/* ------------------------------------------------------------------ */

/* Node exposes Buffer's statics as enumerable properties; polyfills such as
   safer-buffer copy them with for..in / hasOwnProperty. */
for (const key of Object.getOwnPropertyNames(Buffer)) {
  if (key === "length" || key === "name" || key === "prototype" ||
      key === "caller" || key === "arguments")
    continue;
  const desc = Object.getOwnPropertyDescriptor(Buffer, key);
  if (desc && !desc.enumerable) {
    desc.enumerable = true;
    Object.defineProperty(Buffer, key, desc);
  }
}

const bufferModule = {
  Buffer,
  SlowBuffer: Buffer,
  INSPECT_MAX_BYTES: 50,
  kMaxLength: 0x7fffffff,
  constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffe8 },
  atob: (s) => Buffer.from(s, "base64").toString("latin1"),
  btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
};

const punycode = {
  toASCII: (s) => String(s),
  toUnicode: (s) => String(s),
  encode: (s) => String(s),
  decode: (s) => String(s),
  version: "2.1.0",
  ucs2: {
    decode: (s) => Array.from(String(s)).map((c) => c.charCodeAt(0)),
    encode: (a) => String.fromCharCode(...a),
  },
};

function zlibUnsupported(name) {
  return function() {
    const e = new Error("zlib." + name + " is not supported");
    e.code = "ERR_ZLIB_UNSUPPORTED";
    throw e;
  };
}

const ZLIB_CONSTANTS = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
  Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
  Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1,
  Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFLATED: 8,
  Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64, Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
};

function hasZlib() { return typeof native.zlibCompress === "function"; }

function zlibOptions(options, kind) {
  options = options || {};
  let windowBits = options.windowBits;
  if (windowBits === undefined || windowBits === null) {
    if (kind === "raw")
      windowBits = -15;
    else if (kind === "gzip")
      windowBits = 31;
    else
      windowBits = 15;
  } else if (kind === "gzip" && windowBits >= 8 && windowBits < 16) {
    windowBits += 16;
  } else if (kind === "raw" && windowBits > 0) {
    windowBits = -windowBits;
  }
  return {
    windowBits,
    level: options.level === undefined ? -1 : options.level,
    memLevel: options.memLevel === undefined ? 8 : options.memLevel,
    strategy: options.strategy === undefined ? 0 : options.strategy,
  };
}

function zlibCompressSync(data, options, kind) {
  if (!hasZlib())
    throw new Error("zlib is not available in this build");
  const o = zlibOptions(options, kind);
  const out = native.zlibCompress(Buffer.from(data), o.windowBits, o.level,
                                  o.memLevel, o.strategy);
  return Buffer.from(out);
}

function zlibDecompressSync(data, options, kind) {
  if (!hasZlib())
    throw new Error("zlib is not available in this build");
  let windowBits = options && options.windowBits;
  if (windowBits === undefined || windowBits === null)
    windowBits = kind === "raw" ? -15 : kind === "auto" ? 47 : 15;
  else if (kind === "raw" && windowBits > 0)
    windowBits = -windowBits;
  else if (kind === "auto")
    windowBits = Math.abs(windowBits) + 32;
  try {
    return Buffer.from(native.zlibDecompress(Buffer.from(data), windowBits));
  } catch (e) {
    if (kind === "auto") {
      /* gzip and zlib share the auto-detecting window; nothing else to try */
    }
    e.code = e.code || "Z_DATA_ERROR";
    throw e;
  }
}

function zlibCallback(fn) {
  return function(data, options, cb) {
    if (typeof options === "function") { cb = options; options = undefined; }
    queueMicrotask(() => {
      try { cb(null, fn(data, options)); } catch (e) { cb(e); }
    });
  };
}

class ZlibTransform extends Transform {
  constructor(opts, kind, compress) {
    super(opts);
    this._chunks = [];
    this._kind = kind;
    this._compress = compress;
    this._opts = opts;
  }
  _transform(chunk, enc, cb) {
    this._chunks.push(Buffer.from(chunk));
    cb();
  }
  _flush(cb) {
    try {
      const input = Buffer.concat(this._chunks);
      const out = this._compress
        ? zlibCompressSync(input, this._opts, this._kind)
        : zlibDecompressSync(input, this._opts, this._kind);
      if (out.length)
        this.push(out);
      cb();
    } catch (e) {
      cb(e);
    }
  }
}

const zlib = {
  constants: ZLIB_CONSTANTS,
  codes: {},
  createGzip: (o) => new ZlibTransform(o, "gzip", true),
  createGunzip: (o) => new ZlibTransform(o, "auto", false),
  createDeflate: (o) => new ZlibTransform(o, "zlib", true),
  createInflate: (o) => new ZlibTransform(o, "zlib", false),
  createDeflateRaw: (o) => new ZlibTransform(o, "raw", true),
  createInflateRaw: (o) => new ZlibTransform(o, "raw", false),
  createUnzip: (o) => new ZlibTransform(o, "auto", false),
  createBrotliCompress: zlibUnsupported("createBrotliCompress"),
  createBrotliDecompress: zlibUnsupported("createBrotliDecompress"),
  gzipSync: (d, o) => zlibCompressSync(d, o, "gzip"),
  gunzipSync: (d, o) => zlibDecompressSync(d, o, "auto"),
  deflateSync: (d, o) => zlibCompressSync(d, o, "zlib"),
  inflateSync: (d, o) => zlibDecompressSync(d, o, "zlib"),
  deflateRawSync: (d, o) => zlibCompressSync(d, o, "raw"),
  inflateRawSync: (d, o) => zlibDecompressSync(d, o, "raw"),
  unzipSync: (d, o) => zlibDecompressSync(d, o, "auto"),
  gzip: zlibCallback((d, o) => zlibCompressSync(d, o, "gzip")),
  gunzip: zlibCallback((d, o) => zlibDecompressSync(d, o, "auto")),
  deflate: zlibCallback((d, o) => zlibCompressSync(d, o, "zlib")),
  inflate: zlibCallback((d, o) => zlibDecompressSync(d, o, "zlib")),
  deflateRaw: zlibCallback((d, o) => zlibCompressSync(d, o, "raw")),
  inflateRaw: zlibCallback((d, o) => zlibDecompressSync(d, o, "raw")),
  unzip: zlibCallback((d, o) => zlibDecompressSync(d, o, "auto")),
  crc32: (data, value) => {
    if (!hasZlib())
      throw new Error("zlib is not available in this build");
    return native.crc32(Buffer.from(data), value || 0) >>> 0;
  },
  brotliCompressSync: zlibUnsupported("brotliCompressSync"),
  brotliDecompressSync: zlibUnsupported("brotliDecompressSync"),
};

const DNS_CACHE = new Map();
const DNS_TTL = 300000;

function dnsCached(hostname) {
  const key = String(hostname);
  const now = Date.now();
  const hit = DNS_CACHE.get(key);
  if (hit && hit.expires > now)
    return hit.result;
  const result = native.dns(key);
  if (!result[1]) {
    if (DNS_CACHE.size >= 500)
      DNS_CACHE.clear();
    DNS_CACHE.set(key, { result, expires: now + DNS_TTL });
  }
  return result;
}

const dns = {
  lookup(hostname, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    options = options || {};
    queueMicrotask(() => {
      const r = dnsCached(hostname);
      if (r[1]) { cb(sysError(r[1], "getaddrinfo", hostname)); return; }
      const list = r[0];
      if (!list.length) {
        cb(sysError(2, "getaddrinfo", hostname));
        return;
      }
      if (options.all)
        cb(null, list.map((a) => ({ address: a.address,
          family: a.family === C.AF_INET6 ? 6 : 4 })));
      else
        cb(null, list[0].address,
           list[0].family === C.AF_INET6 ? 6 : 4);
    });
  },
  resolve(hostname, rrtype, cb) {
    if (typeof rrtype === "function") { cb = rrtype; rrtype = "A"; }
    this.lookup(hostname, { all: true }, (err, list) => {
      if (err) { cb(err); return; }
      const addrs = list.map((a) => a.address);
      if (rrtype === "A")
        cb(null, addrs.filter((a) => a.indexOf(":") < 0));
      else if (rrtype === "AAAA")
        cb(null, addrs.filter((a) => a.indexOf(":") >= 0));
      else
        cb(null, addrs);
    });
  },
  resolve4(h, cb) { this.resolve(h, "A", cb); },
  resolve6(h, cb) { this.resolve(h, "AAAA", cb); },
  promises: {
    lookup(hostname, options) {
      return new Promise((resolve, reject) => {
        dns.lookup(hostname, options || {}, (err, addr, family) => {
          if (err) reject(err);
          else if (options && options.all) resolve(addr);
          else resolve({ address: addr, family });
        });
      });
    },
    resolve(hostname, rrtype) {
      return new Promise((resolve, reject) => {
        dns.resolve(hostname, rrtype || "A", (err, list) => {
          if (err) reject(err); else resolve(list);
        });
      });
    },
  },
};

const tty = {
  isatty: (fd) => !!native.isatty(fd),
  WriteStream: class WriteStream {
    constructor(fd) { this.fd = fd; this.isTTY = native.isatty(fd); }
    write(s) { writeFdSync(this.fd, s); return true; }
    end() {}
  },
  ReadStream: class ReadStream {
    constructor(fd) { this.fd = fd; this.isTTY = native.isatty(fd); }
    on() { return this; }
  },
};

const vm = {
  Script: class Script {
    constructor(code, options) {
      this.code = String(code);
      this.filename = (options && options.filename) || "evalmachine.<anonymous>";
    }
    runInThisContext() {
      return new Function(this.code + "\n//# sourceURL=" + this.filename)();
    }
    runInNewContext(sandbox) {
      return runInSandbox(this.code, sandbox || {}, this.filename);
    }
    runInContext(context) {
      return runInSandbox(this.code, context || {}, this.filename);
    }
    static runInThisContext(code, options) {
      return new vm.Script(code, options).runInThisContext();
    }
    static runInNewContext(code, sandbox, options) {
      return new vm.Script(code, options).runInNewContext(sandbox);
    }
  },
  runInThisContext(code, options) {
    return new vm.Script(code, options).runInThisContext();
  },
  runInNewContext(code, sandbox, options) {
    return new vm.Script(code, options).runInNewContext(sandbox);
  },
  createContext(sandbox) { return sandbox || {}; },
  isContext: () => false,
};

function runInSandbox(code, sandbox, filename) {
  const keys = Object.keys(sandbox);
  const values = keys.map((k) => sandbox[k]);
  const fn = new Function(...keys, code + "\n//# sourceURL=" + filename);
  return fn(...values);
}

const worker_threads = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  Worker: class Worker extends EventEmitter {
    constructor() {
      super();
      throw new Error("worker_threads are not supported yet");
    }
  },
  MessageChannel: class MessageChannel {
    constructor() {
      this.port1 = { postMessage() {}, on() {}, close() {} };
      this.port2 = { postMessage() {}, on() {}, close() {} };
    }
  },
  receiveMessageOnPort: () => undefined,
};

const timersPromises = {
  setTimeout(ms, value, options) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(value), ms);
      if (options && options.signal) {
        if (options.signal.aborted) {
          t.close();
          reject(options.signal.reason);
        } else {
          options.signal.addEventListener("abort", () => {
            t.close();
            reject(options.signal.reason);
          }, { once: true });
        }
      }
    });
  },
  setImmediate(value) {
    return new Promise((resolve) => setImmediate(() => resolve(value)));
  },
  setInterval(ms, value) {
    const queue = [];
    let wake = null;
    const t = setInterval(() => {
      queue.push(value);
      if (wake) { const w = wake; wake = null; w(); }
    }, ms);
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length)
            yield queue.shift();
          await new Promise((r) => { wake = r; });
        }
      },
    };
  },
};

const perf_hooks = {
  performance: {
    timeOrigin: START_TIME,
    now: () => Date.now() - START_TIME,
    mark() {},
    measure() { return { duration: 0 }; },
    getEntriesByName: () => [],
    getEntriesByType: () => [],
    clearMarks() {},
    clearMeasures() {},
  },
  PerformanceObserver: class PerformanceObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  },
  monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {},
                                  percentile: () => 0 }),
};

class AsyncLocalStorage {
  constructor() { this._store = undefined; }
  getStore() { return this._store; }
  run(store, fn, ...args) {
    const prev = this._store;
    this._store = store;
    try { return fn(...args); } finally { this._store = prev; }
  }
  enterWith(store) { this._store = store; }
  exit(fn, ...args) {
    const prev = this._store;
    this._store = undefined;
    try { return fn(...args); } finally { this._store = prev; }
  }
  disable() { this._store = undefined; }
}

const async_hooks = {
  AsyncLocalStorage,
  AsyncResource: class AsyncResource {
    constructor(type) { this.type = type; }
    runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
    emitDestroy() {}
  },
  createHook: () => ({ enable() {}, disable() {} }),
  executionAsyncId: () => 0,
  triggerAsyncId: () => 0,
};

const diagnosticsChannel = {
  channel(name) {
    const ch = {
      name,
      _subs: [],
      subscribe(fn) { this._subs.push(fn); },
      unsubscribe(fn) {
        this._subs = this._subs.filter((f) => f !== fn);
      },
      publish(data) {
        for (const fn of this._subs) fn(data, name);
      },
      hasSubscribers: false,
    };
    Object.defineProperty(ch, "hasSubscribers", {
      get() { return ch._subs.length > 0; },
    });
    return ch;
  },
};
diagnosticsChannel.channel = ((orig) => {
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) cache.set(name, orig(name));
    return cache.get(name);
  };
})(diagnosticsChannel.channel);

/* ------------------------------------------------------------------ */
/* readline                                                           */
/* ------------------------------------------------------------------ */

class ReadlineInterface extends EventEmitter {
  constructor(input, output, options) {
    super();
    this.input = input;
    this.output = output;
    this.terminal = options ? !!options.terminal : false;
    this.historySize = (options && options.historySize) || 30;
    this.crlfDelay = 100;
    this.line = "";
    this._buffer = "";
    this._paused = false;
    this._closed = false;
    this._decoder = new StringDecoder("utf8");
    if (this.terminal && this.output && this.output.isTTY)
      this._setRawMode = true;
    this._onData = (chunk) => {
      const s = typeof chunk === "string" ? chunk : this._decoder.write(chunk);
      this._buffer += s;
      for (;;) {
        const idx = this._buffer.indexOf("\n");
        if (idx < 0)
          break;
        let line = this._buffer.slice(0, idx);
        this._buffer = this._buffer.slice(idx + 1);
        if (line.endsWith("\r"))
          line = line.slice(0, -1);
        this._lineDone(line);
      }
    };
    this._onEnd = () => {
      if (this._buffer.length)
        this._lineDone(this._buffer.replace(/\r$/, ""));
      this._buffer = "";
      this.close();
    };
    this.input.on("data", this._onData);
    this.input.once("end", this._onEnd);
  }

  _lineDone(line) {
    if (this._closed)
      return;
    this.emit("line", line);
  }

  setPrompt(prompt) { this._prompt = String(prompt); }
  getPrompt() { return this._prompt || "> "; }

  prompt(preserveCursor) {
    if (this._closed)
      return;
    if (this.output && this.output.write)
      this.output.write(this.getPrompt());
  }

  question(query, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    if (this.output && this.output.write)
      this.output.write(query);
    const onLine = (line) => {
      this.removeListener("line", onLine);
      cb(line);
    };
    this.once("line", onLine);
    if (this.input && this.input.resume)
      this.input.resume();
  }

  pause() {
    if (this.input && this.input.pause)
      this.input.pause();
    this._paused = true;
    return this;
  }

  resume() {
    if (this.input && this.input.resume)
      this.input.resume();
    this._paused = false;
    return this;
  }

  close() {
    if (this._closed)
      return;
    this._closed = true;
    this.input.removeListener("data", this._onData);
    this.input.removeListener("end", this._onEnd);
    if (this.input && this.input.pause)
      this.input.pause();
    this.emit("close");
  }

  write(data, key) {
    if (this.output && this.output.write)
      this.output.write(data);
  }

  getCursorPos() { return { rows: 0, cols: 0 }; }
  setRawMode() { return this; }
  [Symbol.asyncIterator]() {
    const queue = [];
    let done = false, wake = null;
    const onLine = (line) => {
      queue.push(line);
      if (wake) { const w = wake; wake = null; w(); }
    };
    const onClose = () => { done = true; if (wake) { const w = wake; wake = null; w(); } };
    this.on("line", onLine);
    this.once("close", onClose);
    return {
      async next() {
        for (;;) {
          if (queue.length)
            return { value: queue.shift(), done: false };
          if (done)
            return { value: undefined, done: true };
          await new Promise((r) => { wake = r; });
        }
      },
      async return() {
        this.removeListener("line", onLine);
        this.removeListener("close", onClose);
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

const readline = {
  Interface: ReadlineInterface,
  createInterface(options, output) {
    if (typeof options === "object" && options !== null) {
      const input = options.input || stdin;
      const out = options.output || (options.terminal ? stdout : undefined);
      return new ReadlineInterface(input, out, options);
    }
    return new ReadlineInterface(stdin, stdout, { terminal: false });
  },
  clearLine(stream) { if (stream && stream.write) stream.write("\r\x1b[K"); },
  clearScreenDown(stream) { if (stream && stream.write) stream.write("\x1b[0J"); },
  cursorTo(stream, x) { if (stream && stream.write) stream.write("\x1b[" + (x | 0) + "G"); },
  moveCursor(stream, dx, dy) {
    if (stream && stream.write)
      stream.write("\x1b[" + Math.abs(dy | 0) + (dy < 0 ? "A" : "B"));
  },
  emitKeypressEvents() {},
};

class ReadlinePromisesInterface extends ReadlineInterface {
  question(query, options) {
    return new Promise((resolve) => {
      super.question(query, options, resolve);
    });
  }
}

const readlinePromises = {
  Interface: ReadlinePromisesInterface,
  createInterface(options, output) {
    if (typeof options === "object" && options !== null) {
      const input = options.input || stdin;
      const out = options.output || (options.terminal ? stdout : undefined);
      return new ReadlinePromisesInterface(input, out, options);
    }
    return new ReadlinePromisesInterface(stdin, stdout, { terminal: false });
  },
};

/* ------------------------------------------------------------------ */
/* tls                                                                */
/* ------------------------------------------------------------------ */

function tlsUnsupported() {
  const e = new Error("TLS is not supported in this build");
  e.code = "ERR_TLS_NOT_SUPPORTED";
  throw e;
}

function hasTLS() { return typeof native.tlsClientInit === "function"; }

function pemString(v) {
  if (v === undefined || v === null)
    return null;
  if (Array.isArray(v))
    return v.map((x) => String(x)).join("\n");
  return String(v);
}

function alpnWire(protocols) {
  if (!protocols)
    return null;
  if (typeof protocols === "string")
    protocols = [protocols];
  const parts = [];
  for (const p of protocols) {
    const b = Buffer.from(String(p), "latin1");
    if (b.length > 255)
      continue;
    parts.push(Buffer.from([b.length]), b);
  }
  return parts.length ? Buffer.concat(parts) : null;
}

class TLSSocket extends Socket {
  constructor(options) {
    super();
    options = options || {};
    this._tlsOptions = options;
    this._isServer = !!options.isServer;
    this._secureEstablished = false;
    this._tlsHandle = undefined;
    this.authorized = false;
    this.authorizationError = null;
    this.alpnProtocol = false;
    this.encrypted = true;
    if (this._isServer) {
      this._fd = options.fd !== undefined
        ? options.fd : (options.socket ? options.socket._fd : undefined);
      this._serverContextId = options.secureContext;
      this.server = options.server || null;
      queueMicrotask(() => this._startServerTLS());
    }
  }

  /* TCP is connected: start the TLS handshake instead of reading
     plaintext. */
  _afterConnect() {
    this.connecting = false;
    const local = native.getsockname(this._fd);
    if (!local[1]) {
      this.localAddress = local[0][0];
      this.localPort = local[0][2];
      this.localFamily = local[0][1] === C.AF_INET6 ? "IPv6" : "IPv4";
    }
    const peer = native.getpeername(this._fd);
    if (!peer[1]) {
      this.remoteAddress = peer[0][0];
      this.remotePort = peer[0][2];
    }
    const o = this._tlsOptions;
    const ca = pemString(o.ca);
    const alpn = alpnWire(o.ALPNProtocols);
    let r;
    try {
      r = native.tlsClientInit(this._fd, o.servername || o.host || "localhost",
                               o.rejectUnauthorized !== false, ca || null, alpn);
    } catch (e) {
      this.destroy(tlsError(e));
      return;
    }
    if (r[1]) {
      this.destroy(sysError(r[1], "tls"));
      return;
    }
    this._tlsHandle = r[0];
    this._driveHandshake();
  }

  _startServerTLS() {
    if (this.destroyed)
      return;
    let r;
    try {
      r = native.tlsAccept(this._serverContextId, this._fd);
    } catch (e) {
      this.destroy(tlsError(e));
      return;
    }
    if (r[1]) {
      this.destroy(sysError(r[1], "tls"));
      return;
    }
    this._tlsHandle = r[0];
    this._driveHandshake();
  }

  _driveHandshake() {
    let st;
    try {
      st = native.tlsHandshake(this._tlsHandle);
    } catch (e) {
      this.destroy(tlsError(e));
      return;
    }
    if (st[1]) {
      this.destroy(sysError(st[1], "tls"));
      return;
    }
    const code = st[0];
    if (code === 0) {
      this._onSecure();
      return;
    }
    this._waitTLSEvent(code, () => this._driveHandshake());
  }

  _waitTLSEvent(code, fn) {
    const fd = this._fd;
    const onEvent = () => {
      qjsos.setReadHandler(fd, null);
      qjsos.setWriteHandler(fd, null);
      if (!this.destroyed)
        fn();
    };
    if (code === 1)
      qjsos.setReadHandler(fd, onEvent);
    else
      qjsos.setWriteHandler(fd, onEvent);
  }

  _onSecure() {
    const info = native.tlsInfo(this._tlsHandle);
    this._secureEstablished = true;
    this.alpnProtocol = info.alpnProtocol;
    this.protocol = info.protocol;
    this.cipher = { name: info.cipher, version: info.protocol };
    this.authorized = this._isServer ||
      this._tlsOptions.rejectUnauthorized !== false;
    if (!this._isServer && this.authorized &&
        typeof this._tlsOptions.checkServerIdentity === "function") {
      const cert = native.tlsPeerCert(this._tlsHandle);
      const err = this._tlsOptions.checkServerIdentity(
        this._tlsOptions.servername || this._tlsOptions.host, cert);
      if (err) {
        this.authorized = false;
        this.authorizationError = err;
        this.destroy(err);
        return;
      }
    }
    this._attachTLS();
    if (this._isServer) {
      this.emit("secureConnect");
    } else {
      this.emit("secure");
      this.emit("secureConnect");
      this.emit("connect");
      this.emit("ready");
    }
  }

  _attachTLS() {
    if (this._attached)
      return;
    this._attached = true;
    qjsos.setReadHandler(this._fd, () => this._onTLSReadable());
    this.resume();
  }

  _onTLSReadable() {
    if (this.destroyed || this._fd === undefined)
      return;
    let r;
    try {
      r = native.tlsRead(this._tlsHandle, 65536);
    } catch (e) {
      this.destroy(tlsError(e));
      return;
    }
    if (r[1]) {
      if (r[1] === C.TLS_WANT_WRITE)
        this._waitTLSEvent(2, () => this._onTLSReadable());
      return;
    }
    const buf = Buffer.from(r[0]);
    if (buf.length === 0) {
      this.readable = false;
      qjsos.setReadHandler(this._fd, null);
      this.push(null);
      if (!this.allowHalfOpen)
        this.end();
      return;
    }
    this.bytesRead += buf.length;
    this.push(buf);
  }

  _flushWrite(buf, cb) {
    if (this.destroyed) {
      cb(new Error("Socket is closed"));
      return;
    }
    if (this._tlsHandle === undefined) {
      this.once("secureConnect", () => this._flushWrite(buf, cb));
      return;
    }
    let off = 0;
    const attempt = () => {
      while (off < buf.length) {
        let r;
        try {
          r = native.tlsWrite(this._tlsHandle, buf.subarray(off));
        } catch (e) {
          cb(tlsError(e));
          return;
        }
        if (r[1] === C.TLS_WANT_READ || r[1] === C.TLS_WANT_WRITE) {
          const code = r[1];
          this._pendingWrite = { buf, off, cb };
          const onEvent = () => {
            qjsos.setReadHandler(this._fd, null);
            qjsos.setWriteHandler(this._fd, null);
            const p = this._pendingWrite;
            this._pendingWrite = null;
            if (p && !this.destroyed) {
              off = p.off; buf = p.buf; cb = p.cb;
              attempt();
            }
          };
          if (code === C.TLS_WANT_READ)
            qjsos.setReadHandler(this._fd, onEvent);
          else
            qjsos.setWriteHandler(this._fd, onEvent);
          return;
        }
        if (r[1]) {
          cb(sysError(r[1], "write"));
          return;
        }
        const n = r[0];
        if (!n)
          break;
        off += n;
        this.bytesWritten += n;
      }
      cb();
    };
    attempt();
  }

  end(data, encoding, cb) {
    if (typeof data === "function") { cb = data; data = undefined; }
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const self = this;
    if (data !== undefined && data !== null)
      this.write(data, encoding);
    this._ending = true;
    const finish = () => {
      if (self._tlsHandle !== undefined) {
        try { native.tlsShutdown(self._tlsHandle); } catch (e) { /* ignore */ }
      }
      if (self._fd !== undefined) {
        native.shutdown(self._fd, C.SHUT_WR);
        self.writable = false;
      }
      if (cb)
        self.once("finish", cb);
      self.emit("finish");
      if (self.allowHalfOpen)
        self._maybeClose();
      else
        self.destroySoon();
    };
    if (this._pendingWrite)
      this.once("drain", finish);
    else
      finish();
    return this;
  }

  destroy(err) {
    if (this._tlsHandle !== undefined) {
      try {
        native.tlsShutdown(this._tlsHandle);
        native.tlsFree(this._tlsHandle);
      } catch (e) { /* ignore */ }
      this._tlsHandle = undefined;
    }
    return super.destroy(err);
  }

  getPeerCertificate() {
    if (this._tlsHandle === undefined)
      return {};
    return native.tlsPeerCert(this._tlsHandle) || {};
  }
  getCertificate() { return this.getPeerCertificate(); }
  getProtocol() { return this.protocol || null; }
  getCipher() { return this.cipher || { name: null, version: null }; }
  getEphemeralKeyInfo() { return {}; }
  getSession() { return null; }
  isSessionReused() { return false; }
  setServername(name) { return this; }
  setMaxSendFragment(size) { return true; }
  disableRenegotiation() {}
  exportKeyingMaterial() { return Buffer.alloc(0); }
}

function tlsError(e) {
  if (e && !e.code) {
    const msg = String(e.message || e);
    if (/self.signed/i.test(msg))
      e.code = "DEPTH_ZERO_SELF_SIGNED_CERT";
    else if (/unable to get local issuer|unable to verify the first/i.test(msg))
      e.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    else if (/expired/i.test(msg))
      e.code = "CERT_HAS_EXPIRED";
    else if (/hostname|altname|IP address mismatch|does not match/i.test(msg))
      e.code = "ERR_TLS_CERT_ALTNAME_INVALID";
    else if (/certificate|verify/i.test(msg))
      e.code = "ERR_TLS_CERT_ALTNAME_INVALID";
    else
      e.code = "ERR_SSL_SSL/TLS_ALERT";
    if (e.name === "InternalError")
      e.name = "Error";
  }
  return e;
}

class SecureContext {
  constructor(options) {
    options = options || {};
    this.context = undefined;
    if (!hasTLS())
      tlsUnsupported();
    const cert = pemString(options.cert);
    const key = pemString(options.key);
    if (cert && key) {
      const r = native.tlsServerContext(cert, key, pemString(options.ca));
      if (r[1])
        throw sysError(r[1], "tls");
      this.context = r[0];
      this._ctxId = r[0];
    }
  }
}

class TLSServer extends EventEmitter {
  constructor(options, listener) {
    super();
    options = options || {};
    if (!hasTLS())
      tlsUnsupported();
    this._options = options;
    this._context = tls.createSecureContext(options);
    this._server = net.createServer((raw) => this._onConnection(raw));
    this._server.on("error", (e) => this.emit("error", e));
    this._server.on("listening", () => this.emit("listening"));
    this._server.on("close", () => this.emit("close"));
    if (listener)
      this.on("secureConnection", listener);
  }

  _onConnection(raw) {
    const fd = raw._fd;
    raw._fd = undefined;
    qjsos.setReadHandler(fd, null);
    raw.removeAllListeners();
    const sock = new TLSSocket({
      isServer: true, fd, secureContext: this._context._ctxId, server: this,
    });
    sock.on("secureConnect", () => this.emit("secureConnection", sock));
    sock.on("error", (e) => this.emit("clientError", e, sock));
    const peer = native.getpeername(fd);
    if (!peer[1]) {
      sock.remoteAddress = peer[0][0];
      sock.remotePort = peer[0][2];
    }
    const local = native.getsockname(fd);
    if (!local[1]) {
      sock.localAddress = local[0][0];
      sock.localPort = local[0][2];
    }
  }

  listen(...args) { this._server.listen(...args); return this; }
  close(cb) { this._server.close(cb); return this; }
  address() { return this._server.address(); }
  getConnections(cb) { this._server.getConnections(cb); }
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
  ref() { return this; }
  unref() { return this; }
}

function normalizeTLSOptions(args) {
  let options = {}, cb;
  if (typeof args[0] === "object" && args[0] !== null) {
    options = Object.assign({}, args[0]);
    cb = args[1];
  } else {
    options.port = Number(args[0]);
    let i = 1;
    if (typeof args[i] === "string")
      options.host = options.servername = args[i++];
    if (typeof args[i] === "object" && args[i] !== null) {
      Object.assign(options, args[i]);
      i++;
    }
    cb = args[i];
  }
  if (options.servername === undefined)
    options.servername = options.hostname || options.host;
  return { options, cb };
}

const tls = {
  TLSSocket,
  SecureContext,
  Server: TLSServer,
  connect(...args) {
    const { options, cb } = normalizeTLSOptions(args);
    const s = new TLSSocket(options);
    if (cb)
      s.once("secureConnect", cb);
    s.connect(options);
    return s;
  },
  createServer(options, listener) {
    if (typeof options === "function") { listener = options; options = {}; }
    return new TLSServer(options, listener);
  },
  createSecureContext(options) { return new SecureContext(options); },
  getCiphers() { return ["TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"]; },
  DEFAULT_MIN_VERSION: "TLSv1.2",
  DEFAULT_MAX_VERSION: "TLSv1.3",
};

/* ------------------------------------------------------------------ */
/* builtin module registry                                            */
/* ------------------------------------------------------------------ */

function registerBuiltins() {
  builtins.assert = assert;
  builtins["assert/strict"] = assert;
  builtins.async_hooks = async_hooks;
  builtins.buffer = bufferModule;
  builtins.child_process = child_process;
  builtins.console = console;
  builtins.constants = fsConstants;
  builtins.crypto = crypto;
  builtins.diagnostics_channel = diagnosticsChannel;
  builtins.dns = dns;
  builtins["dns/promises"] = dns.promises;
  builtins.events = EventEmitter;
  builtins.fs = fs;
  builtins["fs/promises"] = fsp;
  builtins.http = http;
  builtins.https = https;
  builtins.module = Module;
  builtins.net = net;
  builtins.os = os;
  builtins.path = path;
  builtins["path/posix"] = path;
  builtins["path/win32"] = win32Path;
  builtins.perf_hooks = perf_hooks;
  builtins.process = process;
  builtins.punycode = punycode;
  builtins.querystring = querystring;
  builtins.readline = readline;
  builtins["readline/promises"] = readlinePromises;
  builtins.stream = stream;
  builtins["stream/promises"] = {
    pipeline: (streams, options) => new Promise((resolve, reject) => {
      pipeline(streams, options, (err) => err ? reject(err) : resolve());
    }),
    finished: (s, options) => new Promise((resolve, reject) => {
      finished(s, options, (err) => err ? reject(err) : resolve());
    }),
  };
  builtins["stream/web"] = {
    ReadableStream: class ReadableStream {},
    WritableStream: class WritableStream {},
    TransformStream: class TransformStream {},
  };
  builtins.string_decoder = { StringDecoder };
  builtins.sys = util;
  builtins.timers = { setTimeout, clearTimeout, setInterval, clearInterval,
                      setImmediate, clearImmediate };
  builtins["timers/promises"] = timersPromises;
  builtins.tls = tls;
  builtins.trace_events = { createTracing: () => ({ enable() {}, disable() {} }),
                            getEnabledCategories: () => undefined };
  builtins.tty = tty;
  builtins.url = urlModule;
  builtins.util = util;
  builtins["util/types"] = util.types;
  builtins.v8 = {
    getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0,
                                heap_size_limit: 0 }),
    getHeapSpaceStatistics: () => [],
    serialize: (v) => Buffer.from(JSON.stringify(v)),
    deserialize: (b) => JSON.parse(Buffer.from(b).toString()),
    setFlagsFromString() {},
    cachedDataVersionTag: () => 0,
    promiseHooks: { onInit() {}, onBefore() {}, onAfter() {}, onSettled() {} },
  };
  builtins.vm = vm;
  builtins.worker_threads = worker_threads;
  builtins.zlib = zlib;
  builtins._http_agent = http.Agent;
  builtins._http_common = { parsedMethods: {} };
  builtins._stream_readable = Readable;
  builtins._stream_writable = Writable;
  builtins._stream_duplex = Duplex;
  builtins._stream_transform = Transform;
  builtins._stream_passthrough = PassThrough;
  Module.builtinModules = Object.keys(builtins).filter((n) => !n.startsWith("_"));
}

registerBuiltins();

/* ------------------------------------------------------------------ */
/* structuredClone                                                    */
/* ------------------------------------------------------------------ */

function structuredClone(value) {
  const seen = new Map();
  const clone = (v) => {
    if (v === null || typeof v !== "object")
      return v;
    if (seen.has(v))
      return seen.get(v);
    if (v instanceof Date)
      return new Date(v.getTime());
    if (v instanceof RegExp)
      return new RegExp(v.source, v.flags);
    if (v instanceof ArrayBuffer) {
      const out = new ArrayBuffer(v.byteLength);
      new Uint8Array(out).set(new Uint8Array(v));
      return out;
    }
    if (ArrayBuffer.isView(v)) {
      const buf = clone(v.buffer);
      if (v instanceof DataView)
        return new DataView(buf, v.byteOffset, v.byteLength);
      const Ctor = v.constructor === Buffer ? Buffer : v.constructor;
      return new Ctor(buf, v.byteOffset, v.length);
    }
    if (Array.isArray(v)) {
      const out = [];
      seen.set(v, out);
      for (const item of v)
        out.push(clone(item));
      return out;
    }
    if (v instanceof Map) {
      const out = new Map();
      seen.set(v, out);
      for (const [k, val] of v)
        out.set(clone(k), clone(val));
      return out;
    }
    if (v instanceof Set) {
      const out = new Set();
      seen.set(v, out);
      for (const item of v)
        out.add(clone(item));
      return out;
    }
    if (v instanceof Error) {
      const out = new Error(v.message);
      out.name = v.name;
      if (v.stack) out.stack = v.stack;
      return out;
    }
    const out = Object.create(Object.getPrototypeOf(v));
    seen.set(v, out);
    for (const k of Object.keys(v))
      out[k] = clone(v[k]);
    return out;
  };
  return clone(value);
}

/* ------------------------------------------------------------------ */
/* fetch (http only, buffered)                                        */
/* ------------------------------------------------------------------ */

class Headers {
  constructor(init) {
    this._map = new Map();
    if (init instanceof Headers) {
      for (const [k, v] of init._map)
        this._map.set(k, v.slice());
      return;
    }
    if (Array.isArray(init)) {
      for (const [k, v] of init)
        this.append(k, v);
      return;
    }
    if (init && typeof init === "object") {
      for (const k of Object.keys(init))
        this.append(k, init[k]);
    }
  }
  append(k, v) {
    k = String(k).toLowerCase();
    const list = this._map.get(k);
    if (list) list.push(String(v));
    else this._map.set(k, [String(v)]);
  }
  set(k, v) { this._map.set(String(k).toLowerCase(), [String(v)]); }
  get(k) {
    const list = this._map.get(String(k).toLowerCase());
    return list ? list.join(", ") : null;
  }
  has(k) { return this._map.has(String(k).toLowerCase()); }
  delete(k) { this._map.delete(String(k).toLowerCase()); }
  forEach(fn, thisArg) {
    for (const [k, list] of this._map)
      fn.call(thisArg, list.join(", "), k, this);
  }
  *entries() {
    for (const [k, list] of this._map)
      yield [k, list.join(", ")];
  }
  *keys() { for (const [k] of this._map) yield k; }
  *values() { for (const [, list] of this._map) yield list.join(", "); }
  [Symbol.iterator]() { return this.entries(); }
}

class Response {
  constructor(body, init) {
    init = init || {};
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText === undefined ? "" : init.statusText;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers);
    this.url = init.url || "";
    this.redirected = false;
    this.type = "basic";
    this.bodyUsed = false;
    this._body = body ? Buffer.from(body) : Buffer.alloc(0);
  }
  _consume() {
    if (this.bodyUsed)
      throw new TypeError("Body is unusable: Body has already been read");
    this.bodyUsed = true;
    return this._body;
  }
  async text() { return this._consume().toString("utf8"); }
  async json() { return JSON.parse(this._consume().toString("utf8")); }
  async arrayBuffer() {
    const b = this._consume();
    const out = new ArrayBuffer(b.length);
    new Uint8Array(out).set(b);
    return out;
  }
  async blob() { return { size: this._body.length, type: this.headers.get("content-type") || "" }; }
  clone() {
    const r = new Response(this._body, { status: this.status,
      statusText: this.statusText, headers: this.headers, url: this.url });
    return r;
  }
}

class Request {
  constructor(input, init) {
    init = init || {};
    if (input instanceof Request) {
      this.url = input.url;
      this.method = init.method || input.method;
      this.headers = new Headers(init.headers || input.headers);
      this.body = init.body === undefined ? input.body : init.body;
    } else {
      this.url = input instanceof URL ? input.href : String(input);
      this.method = (init.method || "GET").toUpperCase();
      this.headers = new Headers(init.headers);
      this.body = init.body;
    }
    this.signal = init.signal || null;
  }
  clone() { return new Request(this); }
}

const FETCH_REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function fetchDecodeBody(buf, encoding) {
  const enc = String(encoding || "").toLowerCase().trim();
  if (enc === "gzip" || enc === "x-gzip")
    return zlib.gunzipSync(buf);
  if (enc === "deflate")
    return zlib.inflateSync(buf);
  if (enc === "br" && typeof zlib.brotliDecompressSync === "function")
    return zlib.brotliDecompressSync(buf);
  return buf;
}

function fetchOnce(url, init, redirects) {
  return new Promise((resolve, reject) => {
    const req0 = init.request instanceof Request ? init.request : null;
    let u;
    try { u = new URL(url); }
    catch (e) { reject(new TypeError("Failed to parse URL from " + url)); return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new TypeError("fetch: unsupported protocol " + u.protocol));
      return;
    }
    if (init.signal && init.signal.aborted) {
      reject(init.signal.reason);
      return;
    }
    const secure = u.protocol === "https:";
    const headers = {};
    init.headers.forEach((v, k) => { headers[k] = v; });
    if (headers["accept-encoding"] === undefined &&
        init.acceptEncoding !== false)
      headers["accept-encoding"] = "gzip, deflate";
    const opts = {
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method,
      headers,
    };
    if (secure) {
      if (init.rejectUnauthorized !== undefined)
        opts.rejectUnauthorized = init.rejectUnauthorized;
      if (init.ca !== undefined)
        opts.ca = init.ca;
    }
    else if (init.rejectUnauthorized !== undefined)
      opts.rejectUnauthorized = init.rejectUnauthorized;
    const mod = secure ? https : http;
    const r = mod.request(opts, (res) => {
      const location = res.headers.location;
      if (FETCH_REDIRECT_CODES.has(res.statusCode) && location &&
          init.redirect !== "manual" && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(location, url).href; }
        catch (e) { reject(new TypeError("fetch: invalid redirect URL")); return; }
        let method = init.method;
        let body = init.bodyText;
        if (res.statusCode === 303 ||
            ((res.statusCode === 301 || res.statusCode === 302) &&
             method === "POST")) {
          method = "GET";
          body = undefined;
        }
        const nextInit = Object.assign({}, init, {
          request: null, method, bodyText: body,
        });
        if (nextInit.headers && nextInit.headers.delete) {
          if (method === "GET")
            nextInit.headers.delete("content-length");
          nextInit.headers.delete("host");
        }
        resolve(fetchOnce(next, nextInit, redirects - 1));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const outHeaders = {};
        for (const k of Object.keys(res.headers))
          outHeaders[k] = res.headers[k];
        let body = Buffer.concat(chunks);
        try {
          body = fetchDecodeBody(body, res.headers["content-encoding"]);
        } catch (e) {
          reject(e);
          return;
        }
        const out = new Response(
          init.method === "HEAD" ? null : body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: outHeaders,
            url,
          });
        out.redirected = redirects !== init.maxRedirects;
        resolve(out);
      });
      res.on("error", reject);
    });
    r.on("error", reject);
    if (init.signal && init.signal.addEventListener) {
      init.signal.addEventListener("abort", () => {
        r.destroy();
        reject(init.signal.reason);
      }, { once: true });
    }
    if (init.bodyText !== undefined && init.bodyText !== null &&
        init.method !== "GET" && init.method !== "HEAD")
      r.end(init.bodyText);
    else
      r.end();
  });
}

function fetch(input, init) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = input instanceof Request ? input : new Request(input, init); }
    catch (e) { reject(e); return; }
    const headers = new Headers();
    req.headers.forEach((v, k) => headers.set(k, v));
    fetchOnce(req.url, {
      request: req,
      method: req.method,
      headers,
      signal: req.signal,
      redirect: req.redirect,
      maxRedirects: 20,
      bodyText: req.body === undefined || req.body === null
        ? undefined : req.body,
    }, 20).then(resolve, reject);
  });
}

/* ------------------------------------------------------------------ */
/* npm installer                                                      */
/* ------------------------------------------------------------------ */

const NPM_REGISTRY = (process.env.npm_config_registry ||
  process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org")
  .replace(/\/+$/, "");

function npmParseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(String(v).trim());
  if (!m)
    return null;
  return {
    major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || "",
    raw: String(v).trim(),
  };
}

function npmCompareVersion(a, b) {
  if (typeof a === "string") a = npmParseVersion(a);
  if (typeof b === "string") b = npmParseVersion(b);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k])
      return a[k] < b[k] ? -1 : 1;
  }
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre === b.pre) return 0;
  const ap = a.pre.split("."), bp = b.pre.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]) ? +ap[i] : ap[i];
    const bn = /^\d+$/.test(bp[i]) ? +bp[i] : bp[i];
    if (typeof an === "number" && typeof bn === "number") {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (String(an) !== String(bn)) {
      return String(an) < String(bn) ? -1 : 1;
    }
  }
  return 0;
}

function npmNextAfter(parts) {
  /* smallest version greater than the prefix described by parts */
  const major = parts[0];
  const minor = parts[1] === null ? 0 : parts[1];
  const patch = parts[2] === null ? 0 : parts[2];
  if (parts[2] === null)
    return { major, minor: minor + 1, patch: 0, pre: "", raw: "" };
  return { major, minor, patch: patch + 1, pre: "", raw: "" };
}

function npmParseRangeAtom(token) {
  token = token.trim();
  if (!token || token === "*" || token === "x" || token === "X" ||
      token === "latest")
    return null;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(token);
  if (!m)
    return null;
  const wild = (x) => x === undefined || x === "x" || x === "X" || x === "*";
  if (wild(m[2]))
    return null;
  return {
    op: m[1] || "=",
    parts: [Number(m[2]), wild(m[3]) ? null : Number(m[3]),
            wild(m[4]) ? null : Number(m[4])],
    pre: m[5] || "",
  };
}

function npmAtomMatches(vs, atom) {
  const { op, parts, pre } = atom;
  const target = {
    major: parts[0],
    minor: parts[1] === null ? 0 : parts[1],
    patch: parts[2] === null ? 0 : parts[2],
    pre,
  };
  if (op === "=") {
    if (parts[1] === null)
      return vs.major === parts[0];
    if (parts[2] === null)
      return vs.major === parts[0] && vs.minor === parts[1];
    return npmCompareVersion(vs, target) === 0;
  }
  if (op === ">") {
    if (parts[2] === null)
      return npmCompareVersion(vs, target) > 0;
    return npmCompareVersion(vs, target) > 0;
  }
  if (op === ">=")
    return npmCompareVersion(vs, target) >= 0;
  if (op === "<")
    return npmCompareVersion(vs, target) < 0;
  if (op === "<=") {
    if (parts[2] === null && parts[1] !== null) {
      const next = npmNextAfter(parts);
      return npmCompareVersion(vs, next) < 0;
    }
    return npmCompareVersion(vs, target) <= 0;
  }
  if (op === "~") {
    if (npmCompareVersion(vs, target) < 0)
      return false;
    if (parts[1] === null)
      return vs.major === parts[0];
    return vs.major === parts[0] && vs.minor === parts[1];
  }
  /* caret */
  if (npmCompareVersion(vs, target) < 0)
    return false;
  if (parts[0] > 0)
    return vs.major === parts[0];
  if (parts[1] === null)
    return vs.major === 0;
  if (parts[1] > 0)
    return vs.major === 0 && vs.minor === parts[1];
  if (parts[2] === null)
    return vs.major === 0 && vs.minor === 0;
  return vs.major === 0 && vs.minor === 0 && vs.patch === parts[2];
}

function npmRangeAtoms(range) {
  const atoms = [];
  let text = String(range).trim();
  /* hyphen ranges: "1.2.3 - 2.3.4" */
  const hy = /^([0-9xX*.]+)\s+-\s+([0-9xX*.]+)$/.exec(text);
  if (hy) {
    const lo = npmParseRangeAtom(hy[1]);
    const hi = npmParseRangeAtom(hy[2]);
    if (lo)
      atoms.push({ op: ">=", parts: lo.parts, pre: lo.pre });
    if (hi) {
      if (hi.parts[1] === null)
        atoms.push({ op: "<", parts: [hi.parts[0] + 1, null, null], pre: "" });
      else if (hi.parts[2] === null)
        atoms.push({ op: "<", parts: [hi.parts[0], hi.parts[1] + 1, null],
                     pre: "" });
      else
        atoms.push({ op: "<=", parts: hi.parts, pre: hi.pre });
    }
    return atoms;
  }
  /* allow whitespace between an operator and its version */
  text = text.replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1");
  for (const token of text.split(/\s+/)) {
    if (!token)
      continue;
    const atom = npmParseRangeAtom(token);
    if (atom)
      atoms.push(atom);
    else
      return null;
  }
  return atoms;
}

function npmIsAnyRange(range) {
  const text = String(range === undefined || range === null ? "" : range)
    .trim();
  return text === "" || text === "*" || text === "x" || text === "X" ||
    text === "latest";
}

function npmSatisfies(version, range) {
  if (npmIsAnyRange(range))
    return true;
  const v = typeof version === "string" ? npmParseVersion(version) : version;
  if (!v)
    return false;
  for (const alt of String(range).split("||")) {
    if (npmIsAnyRange(alt))
      return true;
    const atoms = npmRangeAtoms(alt);
    if (atoms === null)
      continue;
    if (atoms.every((a) => npmAtomMatches(v, a)))
      return true;
  }
  return false;
}

const npmPackuments = new Map();
const NPM_NET_LIMIT = 8;

function npmLimit(ctx, fn) {
  const run = () => {
    if (ctx.active < NPM_NET_LIMIT)
      return fn();
    return ctx.queue.push(fn).then((f) => f());
  };
  return new Promise((resolve, reject) => {
    const task = () => {
      ctx.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          ctx.active--;
          const next = ctx.queue.shift();
          if (next)
            next();
        });
    };
    if (ctx.active < NPM_NET_LIMIT)
      task();
    else
      ctx.queue.push(task);
  });
}

async function npmFetchPackument(ctx, name) {
  let cached = npmPackuments.get(name);
  if (cached)
    return cached;
  const p = (async () => {
    const url = NPM_REGISTRY + "/" + name.replace("/", "%2f");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await npmLimit(ctx, () => fetch(url, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
        }));
        if (res.status === 404) {
          const e = new Error("404 Not Found - " + name);
          e.code = "E404";
          throw e;
        }
        if (!res.ok)
          throw new Error("failed to fetch " + name + ": HTTP " + res.status);
        const doc = await res.json();
        return doc;
      } catch (e) {
        lastErr = e;
        if (e && e.code === "E404")
          throw e;
      }
    }
    throw lastErr;
  })();
  npmPackuments.set(name, p);
  p.catch(() => npmPackuments.delete(name));
  return p;
}

function npmLatestVersion(doc, range) {
  const versions = Object.keys(doc.versions || {});
  let best = null;
  for (const v of versions) {
    if (v === "0.0.0" || v.indexOf("npm:") >= 0)
      continue;
    if (!npmSatisfies(v, range))
      continue;
    if (!best || npmCompareVersion(v, best) > 0)
      best = v;
  }
  if (!best && (range === "*" || range === "" || range === "latest")) {
    for (const v of versions)
      if (!best || npmCompareVersion(v, best) > 0)
        best = v;
  }
  return best;
}

function npmTarField(header, off, len) {
  let end = off;
  const stop = off + len;
  while (end < stop && header[end] !== 0)
    end++;
  return header.toString("utf8", off, end);
}

function npmExtractTarball(buf, dest) {
  let tar = buf;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)
    tar = zlib.gunzipSync(buf);
  fsSync.mkdirSync(dest, { recursive: true });
  let off = 0;
  let override = null;
  let count = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let empty = true;
    for (let i = 0; i < 512; i++)
      if (header[i]) { empty = false; break; }
    if (empty)
      break;
    let name = npmTarField(header, 0, 100);
    const prefix = npmTarField(header, 345, 155);
    const modeStr = npmTarField(header, 100, 8);
    const sizeStr = npmTarField(header, 124, 12);
    const type = header[156] ? String.fromCharCode(header[156]) : "0";
    const size = parseInt(sizeStr.trim() || "0", 8) || 0;
    const mode = parseInt(modeStr.trim() || "644", 8) || 0o644;
    const dataOff = off + 512;
    off = dataOff + Math.ceil(size / 512) * 512;
    if (prefix)
      name = prefix + "/" + name;
    if (type === "L" || type === "x") {
      const text = tar.toString("utf8", dataOff, dataOff + size);
      if (type === "L") {
        override = text.replace(/\0+$/, "");
      } else {
        /* pax extended header: "len key=value\n" records */
        let pos = 0;
        while (pos < text.length) {
          const sp = text.indexOf(" ", pos);
          if (sp < 0)
            break;
          const len = parseInt(text.slice(pos, sp), 10);
          if (!len || len <= 0)
            break;
          const rec = text.slice(sp + 1, pos + len - 1);
          const eq = rec.indexOf("=");
          if (eq > 0 && rec.slice(0, eq) === "path")
            override = rec.slice(eq + 1);
          pos += len;
        }
      }
      continue;
    }
    if (type === "g" || type === "K")
      continue;
    if (override) {
      name = override;
      override = null;
    }
    let rel = name.replace(/\\/g, "/").replace(/^\.?\//, "");
    const slash = rel.indexOf("/");
    if (slash >= 0)
      rel = rel.slice(slash + 1);
    if (!rel)
      continue;
    const out = pathJoin(dest, rel);
    const base = pathResolve(dest);
    if (pathResolve(out) !== base && !pathResolve(out).startsWith(base + "/"))
      continue;
    if (type === "5") {
      fsSync.mkdirSync(out, { recursive: true });
      continue;
    }
    if (type === "2") {
      const link = npmTarField(header, 157, 100);
      fsSync.mkdirSync(pathDirname(out), { recursive: true });
      try { fsSync.unlinkSync(out); } catch (e) { /* ignore */ }
      try { fsSync.symlinkSync(link, out); } catch (e) { /* ignore */ }
      continue;
    }
    if (type !== "0" && type !== "\0")
      continue;
    fsSync.mkdirSync(pathDirname(out), { recursive: true });
    fsSync.writeFileSync(out, tar.subarray(dataOff, dataOff + size));
    try { fsSync.chmodSync(out, mode & 0o777); } catch (e) { /* ignore */ }
    count++;
  }
  return count;
}

function npmIntegrityCheck(buf, dist) {
  const integrity = dist && dist.integrity;
  if (!integrity)
    return;
  for (const item of String(integrity).split(/\s+/)) {
    const dash = item.indexOf("-");
    if (dash < 0)
      continue;
    const alg = item.slice(0, dash);
    const expected = item.slice(dash + 1);
    let actual;
    try {
      actual = createHash(alg).update(buf).digest("base64");
    } catch (e) {
      continue;
    }
    if (actual !== expected)
      throw new Error("integrity checksum failed (wanted " + expected +
                      " got " + actual + ")");
    return;
  }
}

function npmParseSpec(spec) {
  spec = String(spec);
  let at = spec.lastIndexOf("@");
  if (at > 0)
    return { name: spec.slice(0, at), range: spec.slice(at + 1) || "*" };
  return { name: spec, range: "*" };
}

function npmPackageDir(root, name) {
  return pathJoin(root, "node_modules", ...name.split("/"));
}

function npmReadPackageJson(dir) {
  try {
    return JSON.parse(fsSync.readFileSync(pathJoin(dir, "package.json"), "utf8"));
  } catch (e) {
    return null;
  }
}

function npmFindExisting(fromDir, projectRoot, name, range) {
  let dir = fromDir;
  for (;;) {
    const candidate = npmPackageDir(dir, name);
    const pkg = npmReadPackageJson(candidate);
    if (pkg && pkg.version && npmSatisfies(pkg.version, range))
      return { dir: candidate, pkg };
    if (dir === projectRoot)
      break;
    const parent = pathDirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}

async function npmWithLock(ctx, key, fn) {
  const prev = ctx.locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  ctx.locks.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function npmDownloadTarball(ctx, url) {
  let cached = ctx.tarballs.get(url);
  if (cached)
    return cached;
  const p = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await npmLimit(ctx, () => fetch(url, { acceptEncoding: true }));
        if (!res.ok)
          throw new Error("HTTP " + res.status + " for " + url);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  })();
  ctx.tarballs.set(url, p);
  p.catch(() => ctx.tarballs.delete(url));
  return p;
}

async function npmProcessDeps(projectRoot, dir, ctx, chain) {
  if (ctx.done.has(dir))
    return;
  if (ctx.processing.has(dir))
    return ctx.processing.get(dir);
  const pkg = npmReadPackageJson(dir);
  if (!pkg) {
    ctx.done.add(dir);
    return;
  }
  const promise = (async () => {
    await npmInstallDeps(projectRoot, dir, pkg, ctx, chain);
  })();
  ctx.processing.set(dir, promise);
  try {
    await promise;
    ctx.done.add(dir);
  } finally {
    ctx.processing.delete(dir);
  }
}

async function npmInstallOne(projectRoot, fromDir, name, range, ctx, chain) {
  const existing = npmFindExisting(fromDir, projectRoot, name, range);
  if (existing) {
    if (chain.has(existing.dir))
      return { name, version: existing.pkg.version, installed: false };
    if (!ctx.done.has(existing.dir)) {
      const nextChain = new Set(chain);
      nextChain.add(existing.dir);
      await npmProcessDeps(projectRoot, existing.dir, ctx, nextChain);
    }
    return { name, version: existing.pkg.version, installed: false };
  }

  const doc = await npmFetchPackument(ctx, name);
  const version = npmLatestVersion(doc, range);
  if (!version)
    throw new Error("No matching version found for " + name + "@" + range);
  const info = (doc.versions || {})[version];
  if (!info || !info.dist || !info.dist.tarball)
    throw new Error("No tarball for " + name + "@" + version);

  const rootTarget = npmPackageDir(projectRoot, name);
  const rootPkg = npmReadPackageJson(rootTarget);

  /* Install a package into `target` unless a compatible copy is already
     there. When `replace` is false an existing incompatible copy is left
     alone and the caller nests the package instead. */
  const place = (target, replace) => npmWithLock(ctx, target, async () => {
    const now = npmReadPackageJson(target);
    if (now && npmSatisfies(now.version, range))
      return false;
    if (now && !replace)
      return null;
    const tgz = await npmDownloadTarball(ctx, info.dist.tarball);
    npmIntegrityCheck(tgz, info.dist);
    fsSync.rmSync(target, { recursive: true, force: true });
    npmExtractTarball(tgz, target);
    ctx.added++;
    process.stderr.write("qnode install: " + name + "@" + version + "\n");
    return true;
  });

  let target = (fromDir === projectRoot || !rootPkg) ? rootTarget
    : npmPackageDir(fromDir, name);
  if (chain.has(target))
    return { name, version, installed: false };

  let placed = await place(target, fromDir === projectRoot);
  if (placed === null) {
    /* A concurrent install populated the hoisted slot with a different
       version: keep ours next to the package that asked for it. */
    target = npmPackageDir(fromDir, name);
    if (chain.has(target))
      return { name, version, installed: false };
    placed = await place(target, true);
  }

  const nextChain = new Set(chain);
  nextChain.add(target);
  await npmProcessDeps(projectRoot, target, ctx, nextChain);
  return { name, version, installed: placed !== false };
}

async function npmInstallDeps(projectRoot, dir, pkg, ctx, chain) {
  const deps = Object.assign({}, pkg.dependencies || {},
                             pkg.optionalDependencies || {});
  const optional = pkg.optionalDependencies || {};
  const tasks = Object.keys(deps).map((dep) => (async () => {
    try {
      await npmInstallOne(projectRoot, dir, dep, deps[dep], ctx, chain);
    } catch (e) {
      if (dep in optional)
        return;
      throw e;
    }
  })());
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === "rejected");
  if (failed)
    throw failed.reason;
}

async function npmInstall(args) {
  const started = Date.now();
  const cwd = process.cwd();
  const pkgPath = pathJoin(cwd, "package.json");
  let pkg = npmReadPackageJson(cwd);
  if (!pkg) {
    if (!args.length)
      throw new Error("no package.json found in " + cwd);
    pkg = { name: pathBasename(cwd), version: "1.0.0" };
  }
  const specs = [];
  if (args.length) {
    for (const a of args) {
      if (a.startsWith("-"))
        continue;
      specs.push(npmParseSpec(a));
    }
  } else {
    for (const k of Object.keys(pkg.dependencies || {}))
      specs.push({ name: k, range: pkg.dependencies[k] });
    for (const k of Object.keys(pkg.devDependencies || {}))
      specs.push({ name: k, range: pkg.devDependencies[k] });
    for (const k of Object.keys(pkg.optionalDependencies || {}))
      specs.push({ name: k, range: pkg.optionalDependencies[k] });
  }
  if (!specs.length) {
    process.stderr.write("qnode install: nothing to install\n");
    return 0;
  }

  const ctx = {
    added: 0, seen: new Set(), done: new Set(), processing: new Map(),
    locks: new Map(), tarballs: new Map(), active: 0, queue: [],
  };
  const resolved = [];
  const chain = new Set();
  await Promise.all(specs.map(async (spec) => {
    const r = await npmInstallOne(cwd, cwd, spec.name, spec.range, ctx, chain);
    resolved.push({ name: spec.name, range: spec.range, version: r.version });
  }));

  if (args.length) {
    pkg.dependencies = pkg.dependencies || {};
    for (const r of resolved)
      pkg.dependencies[r.name] = "^" + r.version;
    fsSync.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  const secs = ((Date.now() - started) / 1000).toFixed(2);
  process.stderr.write("added " + ctx.added + " package" +
                       (ctx.added === 1 ? "" : "s") + " in " + secs + "s\n");
  return 0;
}

globalThis.__qnode_npm_install = npmInstall;

/* ------------------------------------------------------------------ */
/* globals                                                            */
/* ------------------------------------------------------------------ */

/* V8-style call site introspection. Some npm packages (depd, debug) walk
   Error.prepareStackTrace output, so expose structured frames. */
function makeCallSite(file, line, column, fn, isNative) {
  return {
    getFileName: () => file || null,
    getScriptNameOrSourceURL: () => file || null,
    getLineNumber: () => line,
    getColumnNumber: () => column,
    getFunctionName: () => fn || null,
    getMethodName: () => null,
    getTypeName: () => null,
    isEval: () => !!(file && file === "<eval>"),
    getEvalOrigin: () => (!file ? undefined
      : { toString: () => file }),
    isNative: () => !!isNative,
    isConstructor: () => false,
    isToplevel: () => !fn,
    isAsync: () => false,
    isPromiseAll: () => false,
    getThis: () => undefined,
    toString() {
      if (isNative)
        return (fn ? fn + " (native)" : "native");
      const loc = file + (line === null ? "" : ":" + line + ":" + column);
      return fn ? fn + " (" + loc + ")" : loc;
    },
  };
}

function parseStackFrames(raw) {
  const frames = [];
  for (const lineText of String(raw || "").split("\n")) {
    const m = /^\s*at (.*)$/.exec(lineText);
    if (!m)
      continue;
    let rest = m[1].trim();
    let fn = null;
    let loc = rest;
    if (rest.endsWith(")") && rest.lastIndexOf(" (") >= 0) {
      const idx = rest.lastIndexOf(" (");
      fn = rest.slice(0, idx);
      loc = rest.slice(idx + 2, -1);
    }
    let file = loc;
    let line = null;
    let column = null;
    let native = loc === "native";
    if (!native) {
      const lm = /^(.*):(\d+):(\d+)$/.exec(loc);
      if (lm) {
        file = lm[1];
        line = Number(lm[2]);
        column = Number(lm[3]);
      } else if (loc.startsWith("(") && loc.endsWith(")")) {
        file = loc.slice(1, -1);
      }
    }
    frames.push(makeCallSite(file, line, column, fn, native));
  }
  return frames;
}

if (typeof Error.captureStackTrace !== "function") {
  if (typeof Error.stackTraceLimit !== "number")
    Error.stackTraceLimit = 10;
  Error.captureStackTrace = function captureStackTrace(obj, ctor) {
    const raw = new Error().stack;
    let frames = parseStackFrames(raw);
    /* Drop our own frame, matching V8 (captureStackTrace does not appear). */
    if (frames.length && frames[0].getFunctionName() === "captureStackTrace")
      frames.shift();
    if (typeof ctor === "function" && ctor.name) {
      const idx = frames.findIndex((f) => f.getFunctionName() === ctor.name);
      if (idx >= 0)
        frames = frames.slice(idx + 1);
    }
    const limit = Number(Error.stackTraceLimit);
    if (Number.isFinite(limit) && limit >= 0 && frames.length > limit)
      frames = frames.slice(0, limit);
    Object.defineProperty(obj, "stack", {
      configurable: true,
      enumerable: false,
      get() {
        const prep = Error.prepareStackTrace;
        if (typeof prep === "function")
          return prep(obj, frames);
        return frames.map((f) => "    at " + f.toString()).join("\n");
      },
      set(value) {
        Object.defineProperty(obj, "stack", {
          configurable: true, enumerable: false, writable: true, value,
        });
      },
    });
  };
}

/* quickjs-ng's native CallSite objects lack a few V8 methods that call-site
   walking packages rely on. Fill them in on the shared prototype. */
(function patchCallSites() {
  try {
    const saved = Error.prepareStackTrace;
    Error.prepareStackTrace = (err, stack) => stack;
    const probe = {};
    Error.captureStackTrace(probe);
    const frames = probe.stack;
    Error.prepareStackTrace = saved;
    if (!Array.isArray(frames) || !frames.length)
      return;
    const proto = Object.getPrototypeOf(frames[0]);
    if (!proto || typeof proto !== "object")
      return;
    if (typeof proto.isEval !== "function")
      proto.isEval = function() {
        const f = this.getFileName && this.getFileName();
        return f === "<eval>" || f === "<input>";
      };
    if (typeof proto.getEvalOrigin !== "function")
      proto.getEvalOrigin = function() {
        const f = this.getFileName && this.getFileName();
        return f ? String(f) : undefined;
      };
    if (typeof proto.getMethodName !== "function")
      proto.getMethodName = () => null;
    if (typeof proto.getTypeName !== "function")
      proto.getTypeName = () => null;
    if (typeof proto.getThis !== "function")
      proto.getThis = () => undefined;
    if (typeof proto.isToplevel !== "function")
      proto.isToplevel = function() { return !this.getFunctionName(); };
    if (typeof proto.isAsync !== "function")
      proto.isAsync = () => false;
    if (typeof proto.isPromiseAll !== "function")
      proto.isPromiseAll = () => false;
  } catch (e) { /* ignore */ }
})();

function formatError(err) {
  if (err && typeof err === "object" && err.stack) {
    const name = err.name || "Error";
    const head = err.message ? name + ": " + err.message : name;
    const stack = String(err.stack).replace(/^\n+/, "");
    return stack ? head + "\n" + stack : head;
  }
  return String(err);
}

function reportError(err) {
  if (process.listenerCount("uncaughtException")) {
    process.emit("uncaughtException", err);
    return;
  }
  try {
    writeFdSync(2, "Uncaught " + formatError(err) + "\n");
  } catch (e) { /* ignore */ }
  qjsstd.exit(1);
}

const performance = perf_hooks.performance;

process.execPath = qjsos.exePath();
process.mainModule = null;
process.argv0 = argv.length ? argv[0] : process.execPath;
process.report = {
  getReport: () => ({ header: { event: "JavaScript API", version: 3 } }),
  writeReport: () => "",
  directory: process.cwd(),
  filename: "report.json",
  compact: false,
};
process.allowedNodeEnvironmentFlags = { has: () => false };
process.features.typescript = false;
process.features.inspector = false;
process.features.tls = hasTLS();
process.features.cached_builtins = false;
process.features.require_module = true;

const globalScope = globalThis;
globalScope.global = globalScope;
globalScope.Buffer = Buffer;
globalScope.process = process;
globalScope.console = console;
globalScope.setTimeout = setTimeout;
globalScope.clearTimeout = clearTimeout;
globalScope.setInterval = setInterval;
globalScope.clearInterval = clearInterval;
globalScope.setImmediate = setImmediate;
globalScope.clearImmediate = clearImmediate;
globalScope.queueMicrotask = globalScope.queueMicrotask ||
  ((fn) => Promise.resolve().then(fn));
globalScope.URL = URL;
globalScope.URLSearchParams = URLSearchParams;
globalScope.TextEncoder = TextEncoder;
globalScope.TextDecoder = TextDecoder;
globalScope.AbortController = AbortController;
globalScope.AbortSignal = AbortSignal;
globalScope.Event = Event;
globalScope.EventTarget = EventTarget;
globalScope.structuredClone = structuredClone;
globalScope.reportError = reportError;
globalScope.performance = performance;
globalScope.fetch = fetch;
globalScope.Headers = Headers;
globalScope.Request = Request;
globalScope.Response = Response;
globalScope.crypto = crypto.webcrypto;
globalScope.atob = (s) => Buffer.from(s, "base64").toString("latin1");
globalScope.btoa = (s) => Buffer.from(s, "latin1").toString("base64");
globalScope.navigator = {
  userAgent: "qnode/0.1 (quickjs-ng)",
  platform: "Linux " + ARCH,
  hardwareConcurrency: native.cpuCount(),
  language: "en-US",
};
globalScope.self = globalScope;

/* ------------------------------------------------------------------ */
/* C-facing module loader API                                         */
/* ------------------------------------------------------------------ */

function __qnode_resolve(spec, base, kind) {
  return resolveRequest(String(spec), base ? String(base) : "", kind || "import");
}

function __qnode_module_kind(path) {
  return moduleKind(String(path));
}

function __qnode_import_cjs(path) {
  const exports = loadCJSFile(String(path), null);
  if (exports === null || exports === undefined)
    return {};
  if (typeof exports !== "object" && typeof exports !== "function")
    return {};
  return exports;
}

function runMainCJS(filename) {
  filename = pathResolve(String(filename));
  if (cjsCache[filename]) {
    mainModule = cjsCache[filename];
    return mainModule.exports;
  }
  let source = readFileSync(filename, "utf8");
  if (source.charCodeAt(0) === 0xfeff)
    source = source.slice(1);
  if (source.startsWith("#!"))
    source = "//" + source.slice(2);
  if (pathExtname(filename).toLowerCase() === ".json") {
    const mod = new Module(filename, null);
    mod.id = ".";
    cjsCache[filename] = mod;
    mod.exports = JSON.parse(source.replace(/^\uFEFF/, ""));
    mod.loaded = true;
    mainModule = mod;
    process.mainModule = mod;
    return mod.exports;
  }
  const mod = new Module(filename, null);
  mod.id = ".";
  cjsCache[filename] = mod;
  mainModule = mod;
  process.mainModule = mod;
  const req = makeRequire(filename);
  req.main = mod;
  const dirname = pathDirname(filename);
  try {
    const fn = new Function("exports", "require", "module", "__filename",
                            "__dirname",
                            source + "\n//# sourceURL=" + filename);
    fn.call(mod.exports, mod.exports, req, mod, filename, dirname);
    mod.loaded = true;
  } catch (e) {
    delete cjsCache[filename];
    throw e;
  }
  return mod.exports;
}

function __qnode_run_cjs(path) {
  return runMainCJS(String(path));
}

function __qnode_esm_builtin(name) {
  name = String(name);
  const key = name.startsWith("qnode:") ? name.slice(6) : name;
  const mod = builtins[key];
  if (mod === undefined)
    throw new Error("No such builtin module: " + name);
  return mod;
}

globalScope.__qnode_resolve = __qnode_resolve;
globalScope.__qnode_module_kind = __qnode_module_kind;
globalScope.__qnode_import_cjs = __qnode_import_cjs;
globalScope.__qnode_run_cjs = __qnode_run_cjs;
globalScope.__qnode_esm_builtin = __qnode_esm_builtin;
globalScope.__qnode_inspect = (v) => inspect(v);
globalScope.__qnode_require = (spec) =>
  makeRequire(pathJoin(process.cwd(), "index.js"))(spec);
/* `qnode -e` evaluates in the global scope; Node exposes require there. */
globalScope.require = globalScope.__qnode_require;

/* Report unhandled promise rejections like Node does. */
globalThis.__qnode_on_unhandled = function(reason) {
  if (process.listenerCount("unhandledRejection")) {
    process.emit("unhandledRejection", reason, Promise.resolve());
    return;
  }
  const err = reason instanceof Error ? reason
    : new Error("Unhandled promise rejection: " + inspect(reason));
  reportError(err);
};


