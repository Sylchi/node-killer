/* ------------------------------------------------------------------ */
/* fetch, Request/Response and web body types                         */
/* ------------------------------------------------------------------ */

const DOM_EXCEPTION_CODES = {
  IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4,
  InvalidCharacterError: 5, NoModificationAllowedError: 7,
  NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
  InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
  NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17,
  SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
  QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24,
  DataCloneError: 25,
};

class DOMException extends Error {
  constructor(message, name) {
    super(message === undefined ? "" : String(message));
    this.name = name === undefined ? "Error" : String(name);
  }
  get code() { return DOM_EXCEPTION_CODES[this.name] || 0; }
}
for (const name of Object.keys(DOM_EXCEPTION_CODES)) {
  const constName = name.replace(/Error$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase() + "_ERR";
  DOMException[constName] = DOM_EXCEPTION_CODES[name];
}
DOMException.prototype[Symbol.toStringTag] = "DOMException";

function normalizeBlobType(type) {
  if (type === undefined || type === null)
    return "";
  const s = String(type);
  if (!s || !/^[\x20-\x7e]*$/.test(s))
    return "";
  return s.toLowerCase();
}

function blobPartBytes(part, endings) {
  if (part instanceof Blob)
    return part._parts;
  if (typeof part === "string") {
    let s = String(part);
    if (endings === "native")
      s = s.replace(/\r\n|\r|\n/g, "\r\n");
    return [Buffer.from(s, "utf8")];
  }
  if (part instanceof ArrayBuffer)
    return [Buffer.from(new Uint8Array(part))];
  if (ArrayBuffer.isView(part))
    return [Buffer.from(part.buffer, part.byteOffset, part.byteLength)];
  return [Buffer.from(String(part), "utf8")];
}

function clampBlobIndex(value, size, fallback) {
  if (value === undefined)
    return fallback;
  let n = Number(value);
  if (Number.isNaN(n))
    n = 0;
  n = Math.trunc(n);
  if (n < 0)
    n = Math.max(size + n, 0);
  return Math.min(n, size);
}

class Blob {
  constructor(parts, options) {
    parts = parts === undefined ? [] : parts;
    options = options || {};
    if (typeof parts === "string" || !parts || typeof parts[Symbol.iterator] !== "function")
      throw new TypeError("Blob parts must be an iterable");
    this._parts = [];
    for (const part of parts)
      for (const bytes of blobPartBytes(part, options.endings))
        this._parts.push(bytes);
    this.type = normalizeBlobType(options.type);
    this._size = 0;
    for (const p of this._parts)
      this._size += p.length;
    this._buffer = null;
  }
  get size() { return this._size; }
  _bytes() {
    if (!this._buffer)
      this._buffer = Buffer.concat(this._parts, this._size);
    return this._buffer;
  }
  slice(start, end, type) {
    const s = clampBlobIndex(start, this._size, 0);
    const e = clampBlobIndex(end, this._size, this._size);
    const part = this._bytes().subarray(Math.min(s, e), Math.max(s, e));
    return new Blob([part], { type: type === undefined ? "" : type });
  }
  text() { return Promise.resolve(this._bytes().toString("utf8")); }
  arrayBuffer() {
    const b = this._bytes();
    const ab = new ArrayBuffer(b.length);
    new Uint8Array(ab).set(b);
    return Promise.resolve(ab);
  }
  bytes() { return Promise.resolve(new Uint8Array(this._bytes())); }
  stream() { return bufferToStream(this._bytes()); }
}
Blob.prototype[Symbol.toStringTag] = "Blob";

class File extends Blob {
  constructor(parts, name, options) {
    super(parts, options);
    options = options || {};
    this.name = String(name);
    this.lastModified = options.lastModified === undefined
      ? Date.now() : Number(options.lastModified);
    this.webkitRelativePath = "";
  }
}
File.prototype[Symbol.toStringTag] = "File";
/* `buffer` exposes the same Blob/File classes as the globals. Assigned here
   because bufferModule is created before these classes are initialized. */
bufferModule.Blob = Blob;
bufferModule.File = File;

function normalizeFormValue(value, filename) {
  if (value instanceof Blob) {
    if (filename !== undefined)
      return new File([value], filename, { type: value.type });
    return value;
  }
  return String(value);
}

class FormData {
  constructor() { this._entries = []; }
  append(name, value, filename) {
    this._entries.push([String(name), normalizeFormValue(value, filename)]);
  }
  set(name, value, filename) {
    name = String(name);
    const entry = [name, normalizeFormValue(value, filename)];
    this._entries = this._entries.filter((e) => e[0] !== name);
    this._entries.push(entry);
  }
  get(name) {
    name = String(name);
    const entry = this._entries.find((e) => e[0] === name);
    return entry ? entry[1] : null;
  }
  getAll(name) {
    name = String(name);
    return this._entries.filter((e) => e[0] === name).map((e) => e[1]);
  }
  has(name) {
    name = String(name);
    return this._entries.some((e) => e[0] === name);
  }
  delete(name) {
    name = String(name);
    this._entries = this._entries.filter((e) => e[0] !== name);
  }
  forEach(fn, thisArg) {
    for (const [name, value] of this._entries)
      fn.call(thisArg, value, name, this);
  }
  *entries() { for (const entry of this._entries) yield [entry[0], entry[1]]; }
  *keys() { for (const entry of this._entries) yield entry[0]; }
  *values() { for (const entry of this._entries) yield entry[1]; }
  [Symbol.iterator]() { return this.entries(); }
}
FormData.prototype[Symbol.toStringTag] = "FormData";

function escapeMultipartName(s) {
  return String(s).replace(/[\r\n"]/g, (c) =>
    c === '"' ? "%22" : c === "\r" ? "%0D" : "%0A");
}

function unescapeMultipartName(s) {
  return String(s).replace(/%0D/gi, "\r").replace(/%0A/gi, "\n")
    .replace(/%22/gi, '"').replace(/\\(.)/g, "$1");
}

function formDataToBuffer(fd) {
  const boundary = "----qnodeFormBoundary" +
    Buffer.from(native.randomBytes(16)).toString("hex");
  const parts = [];
  for (const [name, value] of fd._entries) {
    const isBlob = value instanceof Blob;
    let head = "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="' + escapeMultipartName(name) + '"';
    if (isBlob) {
      head += '; filename="' +
        escapeMultipartName(value.name === undefined ? "blob" : value.name) + '"';
      head += "\r\nContent-Type: " +
        (value.type || "application/octet-stream");
    }
    head += "\r\n\r\n";
    parts.push(Buffer.from(head, "utf8"));
    parts.push(isBlob ? value._bytes() : Buffer.from(String(value), "utf8"));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from("--" + boundary + "--\r\n"));
  return { buffer: Buffer.concat(parts), boundary };
}

function parseMultipartFormData(buf, boundary) {
  const fd = new FormData();
  const delim = Buffer.from("--" + boundary);
  let pos = bufferIndexOf(buf, delim);
  if (pos < 0)
    return fd;
  for (;;) {
    let start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d)
      break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a)
      start += 2;
    const headEnd = bufferIndexOf(buf, Buffer.from("\r\n\r\n"), start);
    if (headEnd < 0)
      break;
    const nextPos = bufferIndexOf(buf, delim, headEnd + 4);
    if (nextPos < 0)
      break;
    let bodyEnd = nextPos;
    if (bodyEnd >= 2 && buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a)
      bodyEnd -= 2;
    const head = utf8Decode(buf, start, headEnd);
    const body = buf.subarray(headEnd + 4, bodyEnd);
    let name = "", filename = null, ctype = "";
    for (const line of head.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0)
        continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === "content-disposition") {
        const n = /name="((?:[^"\\]|\\.)*)"/i.exec(value);
        if (n)
          name = unescapeMultipartName(n[1]);
        const f = /filename="((?:[^"\\]|\\.)*)"/i.exec(value);
        if (f)
          filename = unescapeMultipartName(f[1]);
      } else if (key === "content-type") {
        ctype = value;
      }
    }
    if (name) {
      if (filename === null)
        fd.append(name, utf8Decode(body, 0, body.length));
      else
        fd.append(name, new File([body], filename, { type: ctype }));
    }
    pos = nextPos;
  }
  return fd;
}

function parseBodyFormData(buf, contentType) {
  const raw = String(contentType || "");
  const ct = raw.toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(raw);
    const boundary = m ? (m[1] || m[2]).trim() : "";
    if (!boundary)
      throw new TypeError("Could not parse content as FormData.");
    return parseMultipartFormData(buf, boundary);
  }
  if (ct.startsWith("application/x-www-form-urlencoded")) {
    const fd = new FormData();
    for (const [k, v] of new URLSearchParams(buf.toString("utf8")))
      fd.append(k, v);
    return fd;
  }
  throw new TypeError("Could not parse content as FormData.");
}

function copyBodyBytes(value) {
  if (value instanceof ArrayBuffer)
    return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function bufferToStream(buf) {
  return new ReadableStream({
    start(controller) {
      if (buf.length)
        controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

function normalizeRequestBody(body, headers, duplex) {
  if (body === undefined || body === null)
    return { kind: "none" };
  if (typeof body === "string")
    return { kind: "buffer", buffer: Buffer.from(body, "utf8"),
             contentType: "text/plain;charset=UTF-8" };
  if (body instanceof URLSearchParams)
    return { kind: "buffer", buffer: Buffer.from(body.toString(), "utf8"),
             contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
  if (body instanceof Blob)
    return { kind: "buffer", buffer: body._bytes(),
             contentType: body.type || null };
  if (body instanceof FormData) {
    const m = formDataToBuffer(body);
    return { kind: "buffer", buffer: m.buffer,
             contentType: "multipart/form-data; boundary=" + m.boundary };
  }
  const bytes = copyBodyBytes(body);
  if (bytes)
    return { kind: "buffer", buffer: bytes };
  if (body instanceof ReadableStream) {
    if (duplex !== "half")
      throw new TypeError(
        "RequestInit: duplex option is required when sending a body.");
    return { kind: "stream", stream: body };
  }
  const isAsync = typeof body[Symbol.asyncIterator] === "function";
  const isSync = typeof body[Symbol.iterator] === "function";
  if (isAsync || isSync) {
    if (duplex !== "half")
      throw new TypeError(
        "RequestInit: duplex option is required when sending a body.");
    return { kind: "stream", stream: ReadableStream.from(body) };
  }
  throw new TypeError("Request body: unsupported body type");
}

async function readStreamFully(stream, target) {
  if (stream.locked)
    throw new TypeError("Body is unusable: Body has already been read");
  const reader = stream.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done)
        break;
      const chunk = Buffer.from(r.value);
      chunks.push(chunk);
      loaded += chunk.length;
      if (target && typeof target.dispatchEvent === "function") {
        target._loadedBytes = loaded;
        target.dispatchEvent(new ProgressEvent("progress", {
          lengthComputable: target._totalBytes > 0,
          loaded: loaded,
          total: target._totalBytes
        }));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  return Buffer.concat(chunks);
}

/* Shared worker for `stream/consumers`: accept the same inputs Node does
   (Blob, Response, ReadableStream, async iterable or stream.Readable) and
   return a Buffer. */
function readConsumerSource(source) {
  if (source instanceof Blob)
    return Promise.resolve(source._bytes());
  if (source instanceof Response)
    return source._consume();
  if (source instanceof ReadableStream)
    return readStreamFully(source);
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    return (async () => {
      const chunks = [];
      for await (const chunk of source)
        chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    })();
  }
  if (source && typeof source[Symbol.iterator] === "function" &&
      typeof source !== "string") {
    const chunks = [];
    for (const chunk of source)
      chunks.push(Buffer.from(chunk));
    return Promise.resolve(Buffer.concat(chunks));
  }
  if (source && typeof source.on === "function") {
    return new Promise((resolve, reject) => {
      const chunks = [];
      source.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      source.on("end", () => resolve(Buffer.concat(chunks)));
      source.on("error", reject);
    });
  }
  return Promise.reject(
    new TypeError("Expected a Blob, ReadableStream, or stream.Readable"));
}

const streamConsumers = {
  buffer: (source) => readConsumerSource(source),
  text: async (source) => (await readConsumerSource(source)).toString("utf8"),
  json: async (source) =>
    JSON.parse((await readConsumerSource(source)).toString("utf8")),
  arrayBuffer: async (source) => {
    const buf = await readConsumerSource(source);
    const out = new ArrayBuffer(buf.length);
    new Uint8Array(out).set(buf);
    return out;
  },
  blob: async (source) => {
    const buf = await readConsumerSource(source);
    let type = "";
    if (source instanceof Response)
      type = source.headers.get("content-type") || "";
    else if (source instanceof Blob)
      type = source.type;
    return new Blob([buf], { type });
  },
};

function bodyConsume(target) {
  if (target._bodyUsed ||
      (target._bodyStream && target._bodyStream._disturbed))
    return Promise.reject(
      new TypeError("Body is unusable: Body has already been read"));
  target._bodyUsed = true;
  if (target._bodyStream) {
    if (target._bodyStream.locked)
      return Promise.reject(
        new TypeError("Body is unusable: Body has already been read"));
    return readStreamFully(target._bodyStream, target).then((buf) => {
      if (typeof target.dispatchEvent === "function") {
        target.dispatchEvent(new ProgressEvent("load", {
          lengthComputable: true,
          loaded: buf.length,
          total: buf.length
        }));
      }
      return buf;
    });
  }
  const buf = target._bodyBuffer || Buffer.alloc(0);
  if (typeof target.dispatchEvent === "function") {
    target.dispatchEvent(new ProgressEvent("progress", {
      lengthComputable: true,
      loaded: buf.length,
      total: buf.length
    }));
    target.dispatchEvent(new ProgressEvent("load", {
      lengthComputable: true,
      loaded: buf.length,
      total: buf.length
    }));
  }
  return Promise.resolve(buf);
}

function bodyCloneInto(source, target) {
  if (source._bodyUsed)
    throw new TypeError("Body is unusable: Body has already been read");
  if (!source._bodyStream && source._bodyBuffer === null)
    return;
  const stream = source.body;
  if (!stream)
    return;
  const [a, b] = stream.tee();
  source._bodyStream = a;
  source._bodyBuffer = null;
  target._bodyStream = b;
  target._bodyBuffer = null;
}

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

class Response extends EventTarget {
  constructor(body, init) {
    super();
    init = init || {};
    this.status = init.status === undefined ? 200 : Number(init.status);
    this.statusText = init.statusText === undefined ? "" : String(init.statusText);
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers);
    this.url = init.url === undefined ? "" : String(init.url);
    this.redirected = !!init.redirected;
    this.type = init.type || "default";
    this._bodyUsed = false;
    this._bodyBuffer = null;
    this._bodyStream = null;
    this._totalBytes = 0;
    this._loadedBytes = 0;
    if (body === null || body === undefined) {
      /* null body: HEAD, 204 and 304 responses have no readable stream */
    } else if (body instanceof ReadableStream) {
      this._bodyStream = body;
      const contentLength = this.headers.get("content-length");
      if (contentLength) {
        this._totalBytes = parseInt(contentLength, 10) || 0;
      }
    } else if (body instanceof Blob) {
      this._bodyBuffer = body._bytes();
      this._totalBytes = this._bodyBuffer.length;
      if (body.type && !this.headers.has("content-type"))
        this.headers.set("content-type", body.type);
    } else if (body instanceof FormData) {
      const m = formDataToBuffer(body);
      this._bodyBuffer = m.buffer;
      this._totalBytes = this._bodyBuffer.length;
      this.headers.set("content-type",
                       "multipart/form-data; boundary=" + m.boundary);
    } else {
      const bytes = copyBodyBytes(body);
      this._bodyBuffer = bytes || Buffer.from(String(body), "utf8");
      this._totalBytes = this._bodyBuffer.length;
    }
  }
  get body() {
    if (!this._bodyStream && this._bodyBuffer !== null)
      this._bodyStream = bufferToStream(this._bodyBuffer);
    return this._bodyStream;
  }
  get bodyUsed() {
    return this._bodyUsed || !!(this._bodyStream && this._bodyStream._disturbed);
  }
  _consume() { return bodyConsume(this); }
  async text() { return (await this._consume()).toString("utf8"); }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() {
    const b = await this._consume();
    const out = new ArrayBuffer(b.length);
    new Uint8Array(out).set(b);
    return out;
  }
  async bytes() { return new Uint8Array(await this._consume()); }
  async blob() {
    const b = await this._consume();
    return new Blob([b], { type: this.headers.get("content-type") || "" });
  }
  async formData() {
    const b = await this._consume();
    return parseBodyFormData(b, this.headers.get("content-type"));
  }
  clone() {
    const r = new Response(null, {
      status: this.status,
      statusText: this.statusText,
      headers: new Headers(this.headers),
      url: this.url,
      redirected: this.redirected,
      type: this.type,
    });
    bodyCloneInto(this, r);
    return r;
  }
  static error() {
    const r = new Response(null, { status: 0, statusText: "" });
    r.type = "error";
    return r;
  }
  static redirect(url, status) {
    status = status === undefined ? 302 : Number(status);
    if (status !== 301 && status !== 302 && status !== 303 &&
        status !== 307 && status !== 308)
      throw new RangeError("Invalid status code");
    return new Response(null, {
      status, headers: { location: String(url) },
    });
  }
  static json(data, init) {
    init = Object.assign({}, init);
    const headers = new Headers(init.headers);
    if (!headers.has("content-type"))
      headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), Object.assign({}, init, { headers }));
  }
}
Response.prototype[Symbol.toStringTag] = "Response";

class Request {
  constructor(input, init) {
    init = init || {};
    const isRequest = input instanceof Request;
    this.url = isRequest ? input.url
      : (input instanceof URL ? input.href : String(input));
    this.method = (init.method || (isRequest ? input.method : "GET"))
      .toUpperCase();
    this.headers = new Headers(init.headers !== undefined
      ? init.headers : (isRequest ? input.headers : undefined));
    this.redirect = init.redirect || (isRequest ? input.redirect : "follow");
    this.signal = init.signal || (isRequest ? input.signal : null) || null;
    if (isRequest && input._bodyUsed)
      throw new TypeError(
        "Cannot construct a Request with a Request object that has already been used.");
    this._bodyUsed = isRequest ? input._bodyUsed : false;

    let source;
    if (init.body !== undefined) {
      source = normalizeRequestBody(init.body, this.headers, init.duplex);
    } else if (isRequest) {
      const src = input._bodySource;
      if (src.kind === "buffer") {
        source = { kind: "buffer", buffer: src.buffer,
                   contentType: src.contentType };
      } else if (src.kind === "stream") {
        const [a, b] = input.body.tee();
        input._bodyStream = a;
        input._bodyBuffer = null;
        source = { kind: "stream", stream: b };
      } else {
        source = { kind: "none" };
      }
    } else {
      source = { kind: "none" };
    }
    this._bodySource = source;
    this._bodyBuffer = source.kind === "buffer" ? source.buffer : null;
    this._bodyStream = source.kind === "stream" ? source.stream : null;
    if (source.contentType && !this.headers.has("content-type"))
      this.headers.set("content-type", source.contentType);
    if ((this.method === "GET" || this.method === "HEAD") &&
        source.kind !== "none")
      throw new TypeError(
        "Request with GET/HEAD method cannot have body.");
  }
  get body() {
    if (!this._bodyStream && this._bodyBuffer !== null)
      this._bodyStream = bufferToStream(this._bodyBuffer);
    return this._bodyStream;
  }
  get bodyUsed() {
    return this._bodyUsed || !!(this._bodyStream && this._bodyStream._disturbed);
  }
  _consume() { return bodyConsume(this); }
  async text() { return (await this._consume()).toString("utf8"); }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() {
    const b = await this._consume();
    const out = new ArrayBuffer(b.length);
    new Uint8Array(out).set(b);
    return out;
  }
  async bytes() { return new Uint8Array(await this._consume()); }
  async blob() {
    const b = await this._consume();
    return new Blob([b], { type: this.headers.get("content-type") || "" });
  }
  async formData() {
    const b = await this._consume();
    return parseBodyFormData(b, this.headers.get("content-type"));
  }
  clone() {
    const r = new Request(this);
    return r;
  }
}
Request.prototype[Symbol.toStringTag] = "Request";

const FETCH_REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/* Stream an HTTP response body into a ReadableStream. Data is pulled from
   the socket on demand (highWaterMark 0) so an unread body does not buffer
   the whole response in memory. gzip/deflate is inflated incrementally. */
function responseBodyStream(res, method, statusCode, headers) {
  if (method === "HEAD" || statusCode === 204 || statusCode === 304) {
    res.resume();
    return null;
  }

  let windowBits = 0;
  const enc = String(headers["content-encoding"] || "").toLowerCase().trim();
  if (enc === "gzip" || enc === "x-gzip")
    windowBits = 31;
  else if (enc === "deflate")
    windowBits = 15;

  const socket = res.socket;
  let inflateId = windowBits ? native.zlibInflateStart(windowBits) : -1;
  let closed = false;
  let paused = true;
  let pullResolve = null;

  const finishInflate = () => {
    if (inflateId < 0)
      return null;
    const tail = native.zlibInflateEnd(inflateId);
    inflateId = -1;
    return tail;
  };
  const wakePull = () => {
    const resolve = pullResolve;
    pullResolve = null;
    if (resolve)
      resolve();
  };
  const fail = (controller, err) => {
    if (closed)
      return;
    closed = true;
    try { controller.error(err); } catch (e) {}
    wakePull();
    if (socket && !socket.destroyed) {
      try { socket.destroy(); } catch (e) {}
    }
  };

  return new ReadableStream({
    start(controller) {
      /* Pause before attaching the data listener: Readable.on("data")
         resumes a stream unless it has explicitly been paused. */
      res.pause();
      if (socket && typeof socket.unref === "function")
        socket.unref();
      res.on("data", (chunk) => {
        if (closed)
          return;
        let data = chunk;
        if (inflateId >= 0) {
          try {
            data = native.zlibInflateWrite(inflateId, chunk);
          } catch (e) {
            fail(controller, e);
            return;
          }
        }
        if (data && data.length) {
          try {
            controller.enqueue(data);
          } catch (e) {
            closed = true;
            return;
          }
          wakePull();
          /* Stop pulling more input until the reader has consumed this
             chunk. Only pause when something was actually enqueued: an
             inflate call can legitimately produce no output for a while,
             and pausing on that would never wake the pending pull. */
          if (controller.desiredSize !== null &&
              controller.desiredSize <= 0) {
            paused = true;
            res.pause();
          }
        }
      });
      res.on("end", () => {
        if (closed)
          return;
        try {
          const tail = finishInflate();
          if (tail && tail.length)
            controller.enqueue(tail);
        } catch (e) {
          fail(controller, e);
          return;
        }
        closed = true;
        try { controller.close(); } catch (e) {}
        wakePull();
      });
      res.on("error", (err) => fail(controller, err));
    },
    pull(controller) {
      if (closed)
        return;
      if (res.readableEnded &&
          (!res._readableState || res._readableState.buffer.length === 0)) {
        closed = true;
        try { controller.close(); } catch (e) {}
        return;
      }
      /* Resolve once a chunk has been enqueued (or the stream ended) so the
         ReadableStream does not spin calling pull synchronously. The slot is
         armed before resuming: a paused stream flushes synchronously, and the
         data listener would otherwise wake a pull that does not exist yet. */
      return new Promise((resolve) => {
        pullResolve = resolve;
        if (socket && typeof socket.ref === "function")
          socket.ref();
        if (paused) {
          paused = false;
          res.resume();
        }
      });
    },
    cancel(reason) {
      if (closed)
        return;
      closed = true;
      try { finishInflate(); } catch (e) {}
      wakePull();
      try { res.destroy(reason); } catch (e) {}
      if (socket && !socket.destroyed) {
        try { socket.destroy(); } catch (e) {}
      }
    },
  }, { highWaterMark: 0 });
}

async function pumpRequestBody(req, body, state) {
  if (!body || body.kind === "none") {
    req.end();
    return;
  }
  if (body.kind === "buffer") {
    req.end(body.buffer);
    return;
  }

  const reader = body.stream.getReader();
  try {
    for (;;) {
      if (state.cancelled) {
        try { await reader.cancel(); } catch (e) {}
        return;
      }
      const r = await reader.read();
      if (r.done)
        break;
      if (state.cancelled) {
        try { await reader.cancel(); } catch (e) {}
        return;
      }
      if (req.destroyed || req.aborted)
        return;
      req.write(r.value);
    }
    if (!state.cancelled && !req.destroyed && !req.aborted)
      req.end();
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
}

function fetchOnce(url, init, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); }
    catch (e) { reject(new TypeError("Failed to parse URL from " + url)); return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new TypeError("fetch: unsupported protocol " + u.protocol));
      return;
    }
    if (init.signal && init.signal.aborted) {
      reject(init.signal.reason ||
        new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const secure = u.protocol === "https:";
    const headers = {};
    init.headers.forEach((v, k) => { headers[k] = v; });
    if (headers["accept-encoding"] === undefined && init.acceptEncoding !== false)
      headers["accept-encoding"] = "gzip, deflate";
    const body = init.body || { kind: "none" };
    if (body.kind === "buffer" && headers["content-length"] === undefined)
      headers["content-length"] = body.buffer.length;
    if (body.kind === "stream" &&
        headers["content-length"] === undefined &&
        headers["transfer-encoding"] === undefined)
      headers["transfer-encoding"] = "chunked";

    const opts = {
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method,
      headers,
    };
    if (init.netstack !== undefined)
      opts.netstack = init.netstack;
    if (secure) {
      if (init.rejectUnauthorized !== undefined)
        opts.rejectUnauthorized = init.rejectUnauthorized;
      if (init.ca !== undefined)
        opts.ca = init.ca;
    } else if (init.rejectUnauthorized !== undefined) {
      opts.rejectUnauthorized = init.rejectUnauthorized;
    }

    const state = { settled: false, cancelled: false };
    const settle = (fn, value) => {
      if (state.settled)
        return;
      state.settled = true;
      fn(value);
    };

    let req;
    try {
      req = (secure ? https : http).request(opts, (res) => {
        const location = res.headers.location;
        if (FETCH_REDIRECT_CODES.has(res.statusCode) && location &&
            init.redirect !== "manual" && redirects > 0) {
          state.cancelled = true;
          res.resume();
          let next;
          try { next = new URL(location, url).href; }
          catch (e) {
            settle(reject, new TypeError("fetch: invalid redirect URL"));
            return;
          }
          let method = init.method;
          let nextBody = body;
          if (res.statusCode === 303 ||
              ((res.statusCode === 301 || res.statusCode === 302) &&
               method === "POST")) {
            method = "GET";
            nextBody = { kind: "none" };
          } else if (body.kind === "stream") {
            settle(reject, new TypeError(
              "fetch: cannot follow redirect with a streaming body"));
            try { req.destroy(); } catch (e) {}
            return;
          }
          const nextHeaders = new Headers(init.headers);
          nextHeaders.delete("host");
          if (method === "GET") {
            nextHeaders.delete("content-length");
            nextHeaders.delete("transfer-encoding");
          } else if (nextBody.kind === "buffer" &&
                     !nextHeaders.has("content-length")) {
            nextHeaders.set("content-length", nextBody.buffer.length);
          }
          settle(resolve, fetchOnce(next, Object.assign({}, init, {
            method, headers: nextHeaders, body: nextBody,
          }), redirects - 1));
          return;
        }

        state.res = res;
        const outHeaders = {};
        for (const k of Object.keys(res.headers))
          outHeaders[k] = res.headers[k];
        const stream = responseBodyStream(res, init.method,
                                          res.statusCode, outHeaders);
        const out = new Response(null, {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: outHeaders,
          url,
          type: "basic",
        });
        out._bodyStream = stream;
        out._bodyBuffer = null;
        out.redirected = init.maxRedirects !== redirects;
        settle(resolve, out);
      });
    } catch (e) {
      settle(reject, e);
      return;
    }

    req.on("error", (err) => {
      if (!state.settled)
        settle(reject, err);
    });

    if (init.signal && typeof init.signal.addEventListener === "function") {
      init.signal.addEventListener("abort", () => {
        state.cancelled = true;
        const reason = init.signal.reason ||
          new DOMException("The operation was aborted.", "AbortError");
        if (state.res) {
          try { state.res.destroy(reason); } catch (e) {}
        }
        try { req.destroy(); } catch (e) {}
        settle(reject, reason);
      }, { once: true });
    }

    pumpRequestBody(req, body, state).catch((err) => {
      if (!state.settled) {
        settle(reject, err);
        try { req.destroy(err); } catch (e) {}
      }
    });
  });
}

async function fetch(input, init) {
  const req = new Request(input, init);
  if (input instanceof Request && input._bodySource.kind !== "none")
    input._bodyUsed = true;
  if (req._bodyUsed)
    throw new TypeError("Body is unusable: Body has already been read");
  req._bodyUsed = true;
  return fetchOnce(req.url, {
    method: req.method,
    headers: req.headers,
    body: req._bodySource,
    signal: req.signal,
    redirect: req.redirect,
    maxRedirects: 20,
    netstack: init && init.netstack,
  }, 20);
}

