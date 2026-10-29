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
  89: "EDESTADDRREQ", 90: "EMSGSIZE", 91: "EPROTOTYPE", 92: "ENOPROTOOPT",
  93: "EPROTONOSUPPORT", 95: "EOPNOTSUPP", 97: "EAFNOSUPPORT",
  98: "EADDRINUSE",
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
  EDESTADDRREQ: "destination address required",
  EMSGSIZE: "message too long",
  EPROTONOSUPPORT: "protocol not supported",
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

/* ------------------------------------------------------------------ */
/* encodings                                                          */
/* ------------------------------------------------------------------ */

/* Encode a JS string to UTF-8 bytes, replacing lone surrogates. The native
   encoder works on the engine's UTF-8 form, which keeps lone surrogates as
   WTF-8; Node replaces them with U+FFFD, so fall back to the JS encoder for
   the (rare) strings that contain any surrogate code unit. */
function utf8Encode(str) {
  if (typeof str === "string" &&
      !/[\uD800-\uDFFF]/.test(str))
    return native.utf8Encode(str);
  return utf8EncodeJS(str);
}

function utf8EncodeJS(str) {
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

/* Decode UTF-8 bytes, replacing malformed sequences with U+FFFD. The native
   decoder is used for buffers; the JS path only handles plain arrays. */
function utf8Decode(buf, start, end) {
  if (start === undefined)
    start = 0;
  if (end === undefined)
    end = buf.length;
  if (buf instanceof Uint8Array)
    return native.utf8Decode(start === 0 && end === buf.length
      ? buf : buf.subarray(start, end));
  return utf8DecodeJS(buf, start, end);
}

function utf8DecodeJS(buf, start, end) {
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
      push(String.fromCharCode(b0));
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
      b.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
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

