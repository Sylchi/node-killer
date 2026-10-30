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

class CustomEvent extends Event {
  constructor(type, init) {
    super(type, init);
    this.detail = init && init.detail !== undefined ? init.detail : null;
  }
}

class ProgressEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.lengthComputable = !!init.lengthComputable;
    this.loaded = typeof init.loaded === "number" ? init.loaded : 0;
    this.total = typeof init.total === "number" ? init.total : 0;
  }
}

class CloseEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.wasClean = !!init.wasClean;
    this.code = typeof init.code === "number" ? init.code : 0;
    this.reason = typeof init.reason === "string" ? init.reason : "";
  }
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
      ? new DOMException("This operation was aborted", "AbortError") : reason;
    return s;
  }
  static timeout(ms) {
    const s = new AbortSignal();
    const t = setTimeout(() => {
      s.aborted = true;
      s.reason = new DOMException(
        "The operation was aborted due to timeout", "TimeoutError");
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
      ? new DOMException("This operation was aborted", "AbortError") : reason;
    if (this.signal.reason.name === undefined)
      this.signal.reason.name = "AbortError";
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

