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
    this._applyRef();
    this.resume();
  }

  _onTLSReadable() {
    if (this.destroyed || this._fd === undefined)
      return;
    /* tlsRead can leave later records buffered inside the TLS stack even when
       the socket has no more bytes to report. Drain everything that is already
       available and push it as one chunk, otherwise the tail of a response
       can be stranded waiting for a new fd event. */
    const parts = [];
    let total = 0;
    let eof = false;
    let want = 0;
    while (total < 4 * 1024 * 1024) {
      let r;
      try {
        r = native.tlsRead(this._tlsHandle, 65536);
      } catch (e) {
        this.destroy(tlsError(e));
        return;
      }
      if (r[1]) {
        want = r[1];
        break;
      }
      const buf = Buffer.from(r[0]);
      if (buf.length === 0) {
        eof = true;
        break;
      }
      parts.push(buf);
      total += buf.length;
    }
    if (total > 0) {
      this.bytesRead += total;
      this.push(parts.length === 1 ? parts[0] : Buffer.concat(parts, total));
    }
    if (eof) {
      this.readable = false;
      qjsos.setReadHandler(this._fd, null);
      this.push(null);
      if (!this.allowHalfOpen && !this._ending)
        this.end();
      else
        this._maybeClose();
      return;
    }
    if (want === C.TLS_WANT_WRITE) {
      this._waitTLSEvent(2, () => this._onTLSReadable());
      return;
    }
    if (total >= 4 * 1024 * 1024) {
      queueMicrotask(() => {
        if (!this.destroyed && this._fd !== undefined)
          this._onTLSReadable();
      });
    }
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
    if (this.destroyed)
      return this;
    if (this._ending) {
      if (data !== undefined && data !== null)
        this.write(data, encoding);
      if (cb)
        this.once("finish", cb);
      return this;
    }
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
      self._maybeClose();
    };
    this._endFinish = finish;
    this._maybeFinishEnd();
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
    if (raw.shard !== undefined)
      sock.shard = raw.shard;
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
      sock.localFamily = local[0][1] === C.AF_INET6 ? "IPv6" : "IPv4";
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

