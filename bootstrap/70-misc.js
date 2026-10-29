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
  if (typeof error === "function") {
    let ok = false;
    const isErrorClass = error === Error ||
      (error.prototype !== undefined && error.prototype instanceof Error);
    if (isErrorClass) {
      ok = thrown instanceof error;
    } else {
      try { ok = !!error(thrown); } catch (e) { ok = false; }
    }
    if (!ok)
      throw new AssertionError({ message: message || "Missing expected exception",
                                 actual: thrown, expected: error,
                                 operator: "throws" });
  }
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
    if (typeof error === "function") {
      let ok = false;
      const isErrorClass = error === Error ||
        (error.prototype !== undefined && error.prototype instanceof Error);
      if (isErrorClass) {
        ok = e instanceof error;
      } else {
        try { ok = !!error(e); } catch (e2) { ok = false; }
      }
      if (!ok)
        throw new AssertionError({ message: "Rejection did not match",
                                   actual: e, expected: error,
                                   operator: "rejects" });
    }
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

/* Worker threads run the qnode bootstrap in a fresh qjs runtime. The C side
 * passes a startup value through os.Worker; the bootstrap then imports the
 * user script once the worker globals are in place. */
const __qnode_worker_mode = !!globalThis.__qnode_worker_mode;
const __qnode_worker_startup = __qnode_worker_mode
  ? (globalThis.__qnode_worker_startup || null) : null;
const __qnode_is_main_thread = !__qnode_worker_mode;
const __qnode_raw_parent = (!__qnode_is_main_thread && qjsos.Worker)
  ? qjsos.Worker.parent : null;
let __qnode_next_thread_id = 1;
const __qnode_environment_data = new Map();

function getEnvironmentData(key) {
  return __qnode_environment_data.get(key);
}
function setEnvironmentData(key, value) {
  if (value === undefined)
    __qnode_environment_data.delete(key);
  else
    __qnode_environment_data.set(key, value);
}

function __qnode_worker_send_control(type, fields) {
  if (__qnode_is_main_thread || !__qnode_raw_parent)
    return;
  const msg = Object.assign({ __qnodeWorkerControl: type }, fields || {});
  try { __qnode_raw_parent.postMessage(msg); } catch (e) { /* ignore */ }
}

function __qnode_worker_error_fields(err) {
  if (err && typeof err === "object") {
    return {
      name: err.name || "Error",
      message: err.message === undefined ? String(err) : String(err.message),
      stack: err.stack ? String(err.stack) : undefined,
    };
  }
  return { name: "Error", message: String(err) };
}

class WorkerParentPort extends EventEmitter {
  constructor(raw) {
    super();
    this._raw = raw;
    this._closed = false;
    this._bound = (event) => {
      const data = event.data;
      if (data && typeof data === "object" &&
          data.__qnodeWorkerControl === "terminate") {
        process.exit(0);
        return;
      }
      this.emit("message", data);
    };
  }
  /* Only listen while somebody is interested in messages. A worker that
     never touches parentPort must be able to drain and exit. Messages sent
     before the first listener stay queued in the parent pipe. */
  _update() {
    if (this._closed)
      this._raw.onmessage = null;
    else
      this._raw.onmessage =
        this.listenerCount("message") > 0 ? this._bound : null;
  }
  on(type, fn) {
    super.on(type, fn);
    if (type === "message")
      this._update();
    return this;
  }
  removeListener(type, fn) {
    super.removeListener(type, fn);
    if (type === "message")
      this._update();
    return this;
  }
  removeAllListeners(type) {
    super.removeAllListeners(type);
    if (type === undefined || type === "message")
      this._update();
    return this;
  }
  postMessage(value, transferList) {
    if (!this._closed)
      this._raw.postMessage(value);
  }
  start() { this._update(); }
  close() {
    if (this._closed)
      return;
    this._closed = true;
    this._raw.onmessage = null;
    this.emit("close");
  }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
Object.defineProperty(WorkerParentPort.prototype, "onmessage", {
  configurable: true,
  enumerable: true,
  get() { return this._onmessage || null; },
  set(fn) {
    if (this._onmessage)
      this.removeListener("message", this._onmessage);
    this._onmessage = typeof fn === "function" ? fn : null;
    if (this._onmessage)
      this.on("message", this._onmessage);
  },
});
WorkerParentPort.prototype[Symbol.toStringTag] = "MessagePort";

function __qnode_worker_filename(filename) {
  if (filename && typeof filename === "object" && filename.href)
    filename = filename.href;
  const value = String(filename);
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch (e) { /* fall through */ }
  }
  return pathResolve(value);
}

class Worker extends EventEmitter {
  constructor(filename, options) {
    super();
    if (!__qnode_is_main_thread)
      throw new Error("Worker cannot be created inside a worker thread");
    options = options || {};
    const id = __qnode_next_thread_id++;
    this.threadId = id;
    this.resourceLimits = {};
    this.stdin = options.stdin || null;
    this.stdout = options.stdout || null;
    this.stderr = options.stderr || null;
    this._exited = false;
    this._exitCode = undefined;
    this._terminateResolve = null;

    const evalMode = !!options.eval;
    const sourceName = evalMode
      ? "<worker-eval>" : __qnode_worker_filename(filename);
    const startData = {
      threadId: id,
      filename: sourceName,
      eval: evalMode,
      evalSource: evalMode ? String(filename) : null,
      workerData: options.workerData,
      argv: Array.isArray(options.argv) ? options.argv.slice() : [],
      environmentData: Array.from(__qnode_environment_data.entries()),
    };

    const raw = new qjsos.Worker(startData.filename, startData);
    this._raw = raw;
    raw.onmessage = (event) => {
      const data = event.data;
      if (data && typeof data === "object" &&
          Object.prototype.hasOwnProperty.call(data, "__qnodeWorkerControl")) {
        const type = data.__qnodeWorkerControl;
        if (type === "exit") {
          this._finish(data.code === undefined ? 0 : data.code | 0);
        } else if (type === "error") {
          const err = new Error(data.message || "Worker error");
          err.name = data.name || "Error";
          if (data.stack)
            err.stack = data.stack;
          if (!this._exited)
            this.emit("error", err);
        }
        return;
      }
      this.emit("message", data);
    };

    process.nextTick(() => {
      if (!this._exited)
        this.emit("online");
    });
  }
  postMessage(value, transferList) {
    if (!this._exited)
      this._raw.postMessage(value);
  }
  terminate() {
    if (this._exited)
      return Promise.resolve(this._exitCode);
    this._raw.postMessage({ __qnodeWorkerControl: "terminate" });
    return new Promise((resolve) => {
      this._terminateResolve = resolve;
      if (this._exited)
        resolve(this._exitCode);
    });
  }
  _finish(code) {
    if (this._exited)
      return;
    this._exited = true;
    this._exitCode = code;
    this._raw.onmessage = null;
    this.emit("exit", code);
    if (this._terminateResolve) {
      const resolve = this._terminateResolve;
      this._terminateResolve = null;
      resolve(code);
    }
  }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
Worker.prototype[Symbol.toStringTag] = "Worker";

const worker_threads = {
  isMainThread: __qnode_is_main_thread,
  parentPort: (!__qnode_is_main_thread && __qnode_raw_parent)
    ? new WorkerParentPort(__qnode_raw_parent) : null,
  workerData: __qnode_worker_startup
    ? __qnode_worker_startup.workerData : undefined,
  threadId: __qnode_worker_startup ? __qnode_worker_startup.threadId : 0,
  Worker,
  SHARE_ENV: Symbol("worker_threads.SHARE_ENV"),
  getEnvironmentData,
  setEnvironmentData,
  markAsUntransferable() {},
  isMarkedAsUntransferable() { return false; },
  moveMessagePortToContext(port) { return port; },
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

