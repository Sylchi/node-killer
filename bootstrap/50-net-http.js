/* ------------------------------------------------------------------ */
/* net                                                                */
/* ------------------------------------------------------------------ */

const kSocketFd = Symbol("fd");

/* Address of slot 0 on a shard. The low 64 bits of the subnet are reserved
   for the shard byte and the per-connection slot. */
function shardAddress(subnet, shard) {
  const n = shard === undefined ? 0 : Number(shard);
  if (!Number.isInteger(n))
    throw new RangeError("shard must be an integer");
  return native.shardAddress(String(subnet), n);
}

/* Byte 8 of an IPv6 address, or -1 when the address is not IPv6. */
function shardIndex(address) {
  return native.shardIndex(String(address));
}

/* Numeric address predicates. Kept here so net.isIP() and the connect path
   agree on what counts as a literal; DNS is only consulted for non-literals. */
function isIPv4String(s) {
  const parts = s.split(".");
  if (parts.length !== 4)
    return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p))
      return false;
    if (p.length > 1 && p[0] === "0")
      return false;
    if (Number(p) > 255)
      return false;
  }
  return true;
}

function isIPv6String(s) {
  const pct = s.indexOf("%");
  if (pct >= 0)
    s = s.slice(0, pct);            /* zone id: allowed, not validated */
  if (s.indexOf(":") < 0 || !/^[0-9a-fA-F:.]+$/.test(s))
    return false;
  const halves = s.split("::");
  if (halves.length > 2)
    return false;
  const compressed = halves.length === 2;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = compressed && halves[1] ? halves[1].split(":") : [];
  const groups = left.concat(right);
  const n = groups.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const g = groups[i];
    if (g === "")
      return false;                 /* ":::" and friends */
    if (g.indexOf(".") >= 0) {
      /* An embedded dotted quad must be the final group and must not be
         followed by a compressed run ("1.2.3.4::" is invalid). */
      if (i !== n - 1 || (compressed && right.length === 0))
        return false;
      if (!isIPv4String(g))
        return false;
      count += 2;
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g))
        return false;
      count += 1;
    }
  }
  return compressed ? count <= 7 : count === 8;
}

/* True when `host` is a numeric address and needs no name lookup. */
function isIpLiteral(host) {
  return net.isIP(host) !== 0;
}

/* Native socket mode: 1 forces the owned TCP stack, -1 forces the kernel,
   0 lets node_netstack pick by address. */
function netstackMode(options) {
  if (options && options.netstack === true)
    return 1;
  if (options && options.netstack === false)
    return -1;
  return 0;
}

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

/* Poll-loop counters for diagnostics (see qjsos.pollStats). */
globalThis.__qps = () => qjsos.pollStats();

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
    this._wq = [];
    this._wqActive = false;
    this._endFinish = null;
    this._ref = true;
    this._emitCloseOnEnd = false;
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
      if (options.shard !== undefined || options.subnet !== undefined) {
        try {
          const subnet = options.subnet !== undefined
            ? options.subnet : options.host;
          host = shardAddress(subnet, options.shard);
          family = 6;
        } catch (e) {
          self.destroy(e);
          return;
        }
      }
      if (options.localAddress !== undefined &&
          String(options.localAddress).indexOf(":") >= 0)
        family = 6;
      if (!isIpLiteral(host)) {
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
      if (options.family !== 4 && host.indexOf(":") >= 0)
        family = 6;
      if (family === 6 && /^[0-9.]+$/.test(host))
        host = "::ffff:" + host;
      const r = native.socket(family === 6 ? C.AF_INET6 : C.AF_INET,
                              C.SOCK_STREAM, 0,
                              options.shard !== undefined ||
                              options.subnet !== undefined
                                ? -1 : netstackMode(options));
      if (r[1]) {
        self.destroy(sysError(r[1], "socket"));
        return;
      }
      self._fd = r[0];
      if (options.localAddress !== undefined) {
        const local = String(options.localAddress);
        const localFamily = local.indexOf(":") >= 0 ? 6 : 4;
        if (localFamily !== family) {
          self.destroy(sysError(C.EINVAL, "bind", local));
          return;
        }
        if (family === 6 && options.freeBind &&
            C.IPV6_FREEBIND !== undefined)
          native.setsockopt(self._fd, C.IPPROTO_IPV6, C.IPV6_FREEBIND, 1);
        const berr = native.bind(self._fd, local,
                                 Number(options.localPort) || 0);
        if (berr) {
          self.destroy(sysError(berr, "bind", local));
          return;
        }
      }
      if (options.noDelay !== false)
        self.setNoDelay(true);
      const err = native.connect(self._fd, host, options.port);
      if (err === 0) {
        self._afterConnect();
      } else if (err === C.EINPROGRESS || err === C.EAGAIN ||
                 err === C.EWOULDBLOCK) {
        const onReady = () => {
          qjsos.setReadHandler(self._fd, null);
          qjsos.setWriteHandler(self._fd, null);
          const so = native.getsockopt(self._fd, C.SOL_SOCKET, C.SO_ERROR);
          const e = so[1] ? so[1] : so[0];
          if (e) {
            self.destroy(sysError(e, "connect", options.host));
            return;
          }
          self._afterConnect();
        };
        if (native.isVirtualFd(self._fd))
          qjsos.setReadHandler(self._fd, onReady);
        else
          qjsos.setWriteHandler(self._fd, onReady);
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
    this._applyRef();
    this.resume();
  }

  _applyRef() {
    if (this._fd !== undefined)
      qjsos.setHandlerRef(this._fd, this._ref);
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
      if (!this.allowHalfOpen && !this._ending)
        this.end();
      else
        this._maybeClose();
      return;
    }
    this.bytesRead += buf.length;
    this.push(buf);
  }

  /* Only one native write may be in flight: a write that returns EAGAIN is
     parked in _pendingWrite, and starting a second one would overwrite it.
     Writes are therefore queued and drained in order. */
  _write(chunk, encoding, cb) {
    this._wq.push({ buf: toChunk(chunk, encoding), cb });
    this._pumpWrites();
  }

  _pumpWrites() {
    if (this._wqActive)
      return;
    const item = this._wq.shift();
    if (!item) {
      this._maybeFinishEnd();
      return;
    }
    this._wqActive = true;
    this._flushWrite(item.buf, (err) => {
      this._wqActive = false;
      item.cb(err);
      this._pumpWrites();
    });
  }

  _maybeFinishEnd() {
    if (!this._endFinish || this._wqActive || this._wq.length)
      return;
    const finish = this._endFinish;
    this._endFinish = null;
    finish();
  }

  _flushWrite(buf, cb) {
    if (this.destroyed) {
      cb(new Error("Socket is closed"));
      return;
    }
    /* Connect readiness is detected with a write handler on the same fd.
       Writing while the connection is still in progress can return EAGAIN,
       and parking that write would install a second write handler that
       overwrites the connect probe; the connect event would then never fire
       and no read handler would ever be attached. Queue the write behind the
       connect event instead. */
    if (this._fd === undefined || this.connecting) {
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
      if (self._fd !== undefined) {
        native.shutdown(self._fd, C.SHUT_WR);
        self.writable = false;
      }
      if (cb)
        self.once("finish", cb);
      self.emit("finish");
      /* Sending FIN only closes the write side. Keep the socket readable
         until the peer's FIN arrives, unless it already has. */
      self._maybeClose();
    };
    this._endFinish = finish;
    this._maybeFinishEnd();
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
    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit("close", !!err);
    }
    if (err && this.listenerCount("error"))
      this.emit("error", err);
    else if (err && !this.listenerCount("error"))
      reportError(err);
    return this;
  }

  ref() {
    this._ref = true;
    this._applyRef();
    return this;
  }
  unref() {
    this._ref = false;
    this._applyRef();
    return this;
  }

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
    this._sockets = new Set();
    this._fd = undefined;
    this._listeners = [];
    this.sharded = false;
    this.shardCount = 0;
    this.fallbackReason = null;
  }

  listen(...args) {
    let options = {};
    let cb;
    const last = args[args.length - 1];
    if (typeof last === "function")
      cb = last;
    const a = args.slice(0, cb ? args.length - 1 : args.length);

    if (typeof a[0] === "object" && a[0] !== null) {
      options = Object.assign({}, a[0]);
    } else if (typeof a[0] === "number" ||
               (typeof a[0] === "string" && a[0] !== "" &&
                !isNaN(Number(a[0])))) {
      /* listen(port[, host][, backlog]) */
      options = { port: Number(a[0]) };
      let i = 1;
      if (typeof a[i] === "string")
        options.host = a[i++];
      if (typeof a[i] === "number")
        options.backlog = a[i++];
    } else if (typeof a[0] === "string") {
      options = { path: a[0] };
    }

    if (cb)
      this.once("listening", cb);

    const shards = options.shards === undefined ? 1 : Number(options.shards);
    if (!Number.isInteger(shards) || shards < 1)
      return this._fail(new RangeError("shards must be a positive integer"));
    /* A subnet implies shard addressing even when only one listener is
       requested; otherwise the option would be silently ignored. */
    if (shards > 1 || options.subnet !== undefined)
      return this._listenSharded(options, shards);
    return this._listenSingle(options);
  }

  _fail(err) {
    queueMicrotask(() => this.emit("error", err));
    return this;
  }

  _configureListener(fd, options, sharded) {
    native.setsockopt(fd, C.SOL_SOCKET, C.SO_REUSEADDR, 1);
    if (sharded) {
      /* A shard address is specific, but V6ONLY keeps a wildcard fallback
         from shadowing it and FREEBIND lets a routed /64 be used without
         assigning every address to the interface first. */
      if (C.IPV6_V6ONLY !== undefined)
        native.setsockopt(fd, C.IPPROTO_IPV6, C.IPV6_V6ONLY, 1);
      if (options.freeBind && C.IPV6_FREEBIND !== undefined)
        native.setsockopt(fd, C.IPPROTO_IPV6, C.IPV6_FREEBIND, 1);
    }
    /* reusePort lets several processes share one listening port; the kernel
       spreads incoming connections between them. */
    if (options.reusePort)
      native.setsockopt(fd, C.SOL_SOCKET, C.SO_REUSEPORT, 1);
  }

  _bindAndListen(fd, host, port, options) {
    if (port !== undefined && port !== null) {
      const err = native.bind(fd, host, Number(port));
      if (err)
        return { err, syscall: "bind" };
    }
    const err = native.listen(fd, options.backlog || 511);
    if (err)
      return { err, syscall: "listen" };
    return null;
  }

  _registerListeners(listeners, sharded, count, fallbackReason) {
    this._listeners = listeners;
    this._fd = listeners[0].fd;
    this._address = listeners[0].address;
    this._port = listeners[0].port;
    this._family = listeners[0].family;
    this.sharded = sharded;
    this.shardCount = sharded ? count : 0;
    this.fallbackReason = fallbackReason || null;
    this.listening = true;
    this._attached = true;
    for (const l of listeners)
      qjsos.setReadHandler(l.fd, () => this._onConnection(l));
    queueMicrotask(() => {
      this.emit("listening");
      if (fallbackReason)
        this.emit("shardedFallback", fallbackReason);
    });
  }

  _listenSingle(options, fallbackReason) {
    /* Choose the socket family from the requested host. In particular,
       netstack: true with an IPv4 host (or family: 4) must create an
       AF_INET virtual socket rather than an IPv6 one with an IPv4 bind. */
    const hostText = typeof options.host === "string" ? options.host : "";
    const want6 = options.family === 6 ||
      (options.family !== 4 && hostText.indexOf(":") >= 0);
    const bindHost = options.host || (want6 ? "::" : "0.0.0.0");
    const r = native.socket(want6 ? C.AF_INET6 : C.AF_INET,
                            C.SOCK_STREAM, 0,
                            netstackMode(options));
    if (r[1])
      throw sysError(r[1], "socket");
    const fd = r[0];
    this._configureListener(fd, options, false);
    const err = this._bindAndListen(fd, bindHost, options.port, options);
    if (err) {
      native.close(fd);
      this._fd = undefined;
      return this._fail(sysError(err.err, err.syscall, options.host));
    }
    const name = native.getsockname(fd);
    const listener = { fd, shard: undefined, address: undefined, port: 0,
                       family: "IPv4" };
    if (!name[1]) {
      listener.address = name[0][0];
      listener.port = name[0][2];
      listener.family = name[0][1] === C.AF_INET6 ? "IPv6" : "IPv4";
    }
    this._registerListeners([listener], false, 0, fallbackReason);
    return this;
  }

  _isShardFallbackError(err) {
    const code = err && err.code;
    return code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" ||
           code === "EPROTONOSUPPORT" || code === "EINVAL" ||
           code === "ENODEV";
  }

  _listenFallback(options, reason) {
    let host = options.fallbackHost;
    if (host === undefined)
      host = reason && reason.code === "EAFNOSUPPORT" ? "0.0.0.0" : "::";
    const o = Object.assign({}, options, {
      host, subnet: undefined, shards: undefined, fallback: false,
    });
    if (typeof host !== "string" || host.indexOf(":") < 0) {
      o.family = 4;
      if (o.host === undefined || o.host === "::")
        o.host = "0.0.0.0";
    }
    return this._listenSingle(o, reason);
  }

  _listenSharded(options, count) {
    if (count > 256)
      return this._fail(new RangeError("shards must be at most 256"));
    const subnet = options.subnet !== undefined ? options.subnet : options.host;
    if (typeof subnet !== "string" || subnet.indexOf(":") < 0)
      return this._fail(new TypeError(
        "sharded listen requires an IPv6 subnet or host"));
    let addresses;
    try {
      addresses = [];
      for (let i = 0; i < count; i++)
        addresses.push(shardAddress(subnet, i));
    } catch (e) {
      return this._fail(e);
    }

    let port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      return this._fail(new RangeError("invalid port"));

    const listeners = [];
    let failure = null;
    for (let i = 0; i < count; i++) {
      const r = native.socket(C.AF_INET6, C.SOCK_STREAM, 0,
                              options.netstack === true ? 1 : -1);
      if (r[1]) {
        failure = sysError(r[1], "socket");
        break;
      }
      const fd = r[0];
      this._configureListener(fd, options, true);
      const err = this._bindAndListen(fd, addresses[i], port, options);
      if (err) {
        native.close(fd);
        failure = sysError(err.err, err.syscall, addresses[i]);
        break;
      }
      const name = native.getsockname(fd);
      let address = addresses[i];
      let actualPort = port;
      if (!name[1]) {
        address = name[0][0];
        actualPort = name[0][2];
        if (port === 0)
          port = actualPort;
      }
      listeners.push({ fd, shard: i, address, port: actualPort,
                       family: "IPv6" });
    }

    if (failure) {
      for (const l of listeners) {
        qjsos.setReadHandler(l.fd, null);
        native.close(l.fd);
      }
      if (options.fallback !== false && this._isShardFallbackError(failure))
        return this._listenFallback(options, failure);
      return this._fail(failure);
    }
    this._registerListeners(listeners, true, count);
    return this;
  }

  _onConnection(listener) {
    const fd = listener ? listener.fd : this._fd;
    /* Draining one listener without a budget lets a busy shard starve the
       others. A small budget keeps the accept path interleaved. */
    const budget = listener && listener.shard !== undefined ? 64 : Infinity;
    for (let accepted = 0; accepted < budget; accepted++) {
      const r = native.accept(fd);
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
      if (listener && listener.shard !== undefined)
        sock.shard = listener.shard;
      sock.setNoDelay(true);
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
        sock.localFamily = local[0][1] === C.AF_INET6 ? "IPv6" : "IPv4";
      }
      sock._attach();
      this._sockets.add(sock);
      sock.on("close", () => {
        this._connections--;
        this._sockets.delete(sock);
      });
      this.emit("connection", sock);
      if (!this.listening)
        return;
    }
  }

  address() {
    if (!this._fd)
      return null;
    return { address: this._address, family: this._family, port: this._port };
  }

  /* All bound listener addresses. A sharded server returns one entry per
     shard; an unsharded server returns a single entry without `shard`. */
  addresses() {
    const out = [];
    if (!this.listening)
      return out;
    for (const l of this._listeners) {
      const e = { address: l.address, family: l.family, port: l.port };
      if (l.shard !== undefined)
        e.shard = l.shard;
      out.push(e);
    }
    return out;
  }

  getConnections(cb) {
    queueMicrotask(() => cb(null, this._connections));
  }

  close(cb) {
    if (this._listeners.length) {
      for (const l of this._listeners) {
        qjsos.setReadHandler(l.fd, null);
        native.close(l.fd);
      }
      this._listeners = [];
    } else if (this._fd !== undefined) {
      qjsos.setReadHandler(this._fd, null);
      native.close(this._fd);
    }
    this._fd = undefined;
    this.listening = false;
    for (const sock of this._sockets) {
      if (sock._idle && !sock.destroyed)
        sock.destroy();
    }
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
  shardAddress,
  shardIndex,
  /* Diagnostics for the owned TCP engine. `address` and `address4` are the
     stable local IPv6 and IPv4 addresses to listen on / connect to when
     using netstack: true. */
  netstackInfo() {
    try {
      const info = native.netstackInfo();
      return { enabled: !!info[0], address: info[1] || null,
               address4: info[4] || null, link: info[2] || null, fd: info[3] };
    } catch (e) {
      return { enabled: false, address: null, address4: null,
               link: null, fd: -1 };
    }
  },
  netstackAddress(family) {
    const info = this.netstackInfo();
    if (!info.enabled)
      return null;
    return family === 4 || family === "IPv4" ? info.address4 : info.address;
  },
  isIP(input) {
    const s = String(input);
    if (isIPv4String(s))
      return 4;
    if (isIPv6String(s))
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
    let idleTimer = null;
    let upgraded = false;

    /* Idle keep-alive connections are closed after keepAliveTimeout, like
       Node does. Without this a finished exchange leaves a ref'd socket
       behind and the process can never exit. */
    const clearIdle = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      socket._idle = false;
    };
    const armIdle = () => {
      clearIdle();
      if (socket.destroyed)
        return;
      socket._idle = true;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        socket._idle = false;
        if (!socket.destroyed)
          socket.destroy();
      }, this.keepAliveTimeout || 5000);
      if (idleTimer && idleTimer.unref)
        idleTimer.unref();
    };

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
      if (upgraded)
        return;
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

          /* An Upgrade request (WebSocket, etc.) or CONNECT takes over the
             socket: hand the remaining bytes to the listener and never run
             the HTTP parser on this connection again. */
          const connection = req.headers.connection || "";
          const wantsUpgrade = req.headers.upgrade !== undefined &&
            /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(connection);
          if (wantsUpgrade || req.method === "CONNECT") {
            const event = req.method === "CONNECT" ? "connect" : "upgrade";
            req.complete = true;
            req._keepAlive = false;
            buf = Buffer.alloc(0);
            current = null;
            upgraded = true;
            clearIdle();
            socket._idle = false;
            if (this.listenerCount(event))
              this.emit(event, req, socket, rest);
            else
              socket.destroy();
            return;
          }

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
            if (buf.length) {
              processBuffer();
              return;
            }
            armIdle();
          };
          if (expectBody === 0 && !chunked) {
            finishRequest();
            continue;
          }
        }
        if (current && chunked) {
          /* decode chunked transfer-encoding */
          const decoded = decodeChunked(buf);
          if (!decoded.done) {
            if (decoded.body.length)
              bodyChunks.push(decoded.body);
            buf = decoded.rest;
            return;
          }
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
      if (upgraded)
        return;
      clearIdle();
      buf = Buffer.concat([buf, chunk]);
      try {
        processBuffer();
      } catch (e) {
        this.emit("clientError", e, socket);
        socket.destroy();
      }
    });
    socket.on("end", () => {
      clearIdle();
      if (current)
        current.emit("aborted");
    });
    socket.on("close", clearIdle);
    socket.on("error", (e) => this.emit("clientError", e, socket));
  }
}

function decodeChunked(buf) {
  const chunks = [];
  let pos = 0;
  let done = false;
  for (;;) {
    const lineEnd = bufferIndexOf(buf, Buffer.from("\r\n"), pos);
    if (lineEnd < 0)
      break;
    const sizeLine = utf8Decode(buf, pos, lineEnd).split(";")[0].trim();
    const size = parseInt(sizeLine, 16);
    if (isNaN(size))
      break;
    if (size === 0) {
      const end = bufferIndexOf(buf, Buffer.from("\r\n"), pos + 2);
      if (end < 0)
        break;
      pos = end + 2;
      done = true;
      break;
    }
    const bodyStart = lineEnd + 2;
    if (buf.length < bodyStart + size + 2)
      break;
    chunks.push(Buffer.from(buf.subarray(bodyStart, bodyStart + size)));
    pos = bodyStart + size + 2;
  }
  return { body: Buffer.concat(chunks), rest: buf.subarray(pos), done };
}

function tlsOptionId(value) {
  if (value !== null && typeof value === "object") {
    let id = tlsOptionIds.get(value);
    if (!id) {
      id = tlsOptionIdNext++;
      tlsOptionIds.set(value, id);
    }
    return id;
  }
  const str = String(value);
  if (str.length <= 24)
    return str;
  let h = 0;
  for (let i = 0; i < str.length; i++)
    h = (h * 31 + str.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(36);
}
const tlsOptionIds = new WeakMap();
let tlsOptionIdNext = 1;

function agentKey(options) {
  const protocol = options.protocol || "http:";
  const host = options.hostname || options.host || "localhost";
  const port = Number(options.port) || (protocol === "https:" ? 443 : 80);
  let key = protocol + "//" + host + ":" + port;
  if (options.family !== undefined)
    key += "|family" + options.family;
  if (options.shard !== undefined)
    key += "|shard" + options.shard + "@" + (options.subnet || host);
  if (options.localAddress !== undefined)
    key += "|local" + options.localAddress + ":" + (options.localPort || 0);
  if (protocol === "https:") {
    key += "|" + (options.servername || host);
    if (options.rejectUnauthorized === false)
      key += "|insecure";
    if (options.ca !== undefined)
      key += "|ca" + tlsOptionId(options.ca);
  }
  return key;
}

/* Create one connected (or connecting) socket for a request, honouring an
   explicit createConnection option. Used both directly and by Agent. */
function createSocketForRequest(o) {
  const protocol = o.protocol || "http:";
  const port = Number(o.port) || (protocol === "https:" ? 443 : 80);
  const host = o.hostname || o.host || "localhost";
  if (typeof o.createConnection === "function")
    return o.createConnection(Object.assign({}, o, { port, host }));
  const connectOpts = { port, host };
  for (const k of ["family", "localAddress", "localPort", "shard", "subnet",
                   "freeBind", "noDelay"]) {
    if (o[k] !== undefined)
      connectOpts[k] = o[k];
  }
  if (protocol === "https:") {
    const tlsOpts = {};
    for (const k of TLS_REQUEST_OPTIONS)
      if (o[k] !== undefined)
        tlsOpts[k] = o[k];
    if (tlsOpts.servername === undefined)
      tlsOpts.servername = host;
    return tls.connect(Object.assign({}, tlsOpts, connectOpts));
  }
  const s = new Socket();
  s.connect(connectOpts);
  return s;
}

/* Minimal but functional connection pool. Idle sockets are unref'd so they
   do not keep the process alive; a socket is handed to a queued request
   before a new TCP connection is opened. */
class Agent {
  constructor(opts) {
    opts = opts || {};
    this.options = opts;
    this.keepAlive = opts.keepAlive !== undefined ? !!opts.keepAlive : false;
    this.keepAliveMsecs = opts.keepAliveMsecs || 1000;
    this.maxSockets = opts.maxSockets || Infinity;
    this.maxFreeSockets = opts.maxFreeSockets || 256;
    this.freeSockets = new Map();
    this.sockets = new Set();
    this.requests = new Map();
    this._counts = new Map();
    this.destroyed = false;
  }

  getName(options) { return agentKey(options || {}); }
  createConnection(options) { return createSocketForRequest(options || {}); }

  addRequest(req, options, forceNew) {
    options = options || req._options || {};
    if (this.destroyed) {
      const sock = this.createConnection(options);
      req._bindSocket(sock, false);
      return;
    }
    const key = this.getName(options);
    req._agent = this;
    req._agentKey = key;

    if (!forceNew) {
      const free = this.freeSockets.get(key);
      while (free && free.length) {
        const sock = free.pop();
        if (sock && !sock.destroyed && sock._fd !== undefined &&
            sock.readable !== false) {
          this._assign(req, sock, true);
          return;
        }
        this._forget(key, sock);
        if (sock)
          sock.destroy();
      }
    }

    if ((this._counts.get(key) || 0) < this.maxSockets) {
      this._counts.set(key, (this._counts.get(key) || 0) + 1);
      let sock;
      try {
        sock = this.createConnection(options);
      } catch (e) {
        this._decrement(key);
        queueMicrotask(() => req._fail(e));
        return;
      }
      sock._agentKey = key;
      this.sockets.add(sock);
      sock.once("close", () => this._forget(key, sock));
      this._assign(req, sock, false);
      return;
    }

    let q = this.requests.get(key);
    if (!q) {
      q = [];
      this.requests.set(key, q);
    }
    q.push(req);
  }

  _assign(req, sock, reused) {
    req._bindSocket(sock, reused);
  }

  release(req, sock, reusable) {
    const key = req._agentKey;
    req._detachSocket();
    if (!sock || sock.destroyed || !reusable || this.destroyed) {
      if (sock && !sock.destroyed)
        sock.destroy();
      return;
    }

    const q = this.requests.get(key);
    if (q && q.length) {
      const next = q.shift();
      if (!q.length)
        this.requests.delete(key);
      this._assign(next, sock, true);
      return;
    }

    sock.unref();
    const free = this.freeSockets.get(key) || [];
    if (free.length >= this.maxFreeSockets) {
      this._forget(key, sock);
      sock.destroy();
      return;
    }
    if (free.indexOf(sock) < 0)
      free.push(sock);
    this.freeSockets.set(key, free);
  }

  _forget(key, sock) {
    if (!key)
      return;
    const free = this.freeSockets.get(key);
    if (free) {
      const i = free.indexOf(sock);
      if (i >= 0)
        free.splice(i, 1);
      if (!free.length)
        this.freeSockets.delete(key);
    }
    if (this.sockets.delete(sock)) {
      this._decrement(key);
      this._drain(key);
    }
  }

  _decrement(key) {
    const n = (this._counts.get(key) || 1) - 1;
    if (n <= 0)
      this._counts.delete(key);
    else
      this._counts.set(key, n);
  }

  _drain(key) {
    if (this.destroyed)
      return;
    const q = this.requests.get(key);
    while (q && q.length && (this._counts.get(key) || 0) < this.maxSockets) {
      const req = q.shift();
      this.addRequest(req, req._options, false);
    }
    if (q && !q.length)
      this.requests.delete(key);
  }

  destroy() {
    this.destroyed = true;
    for (const sock of this.sockets) {
      try { sock.destroy(); } catch (e) { /* ignore */ }
    }
    this.sockets.clear();
    this.freeSockets.clear();
    this.requests.clear();
    this._counts.clear();
  }
}

function socketHangUp() {
  const e = new Error("socket hang up");
  e.code = "ECONNRESET";
  return e;
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
    this._pendingBody = [];
    this._sent = false;
    this._headWritten = false;
    this._retried = false;
    this._failed = false;
    this._responded = false;
    this._detached = true;
    this.reusedSocket = false;
    this.aborted = false;
    this.agent = null;
    this.socket = null;
    this._sockListeners = null;
    if (cb)
      this.once("response", cb);
    this._start(false);
  }

  setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; }
  getHeader(k) { return this._headers[k.toLowerCase()]; }
  removeHeader(k) { delete this._headers[k.toLowerCase()]; }
  flushHeaders() { this._sendHead(); }

  _start(forceNew) {
    const o = this._options;
    const agent = o.agent === undefined
      ? defaultAgentFor(o.protocol || "http:") : o.agent;
    if (agent && typeof agent.addRequest === "function") {
      this.agent = agent;
      agent.addRequest(this, o, !!forceNew);
    } else {
      this.agent = null;
      this._bindSocket(createSocketForRequest(o), false);
    }
  }

  _bindSocket(sock, reused) {
    this.socket = sock;
    this.reusedSocket = !!reused;
    this._detached = false;
    const onData = (chunk) => this._onData(chunk);
    const onEnd = () => this._onSocketEnd();
    const onError = (err) => this._onSocketError(err);
    const onClose = () => this._onSocketClose();
    this._sockListeners = { onData, onEnd, onError, onClose };
    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("error", onError);
    sock.on("close", onClose);
    sock.ref();
    sock.resume();
    const self = this;
    queueMicrotask(() => {
      if (!self._failed && !self.aborted && self.socket === sock)
        self.emit("socket", sock);
    });
    this._flushHead();
    this._flushBody();
  }

  _detachSocket() {
    if (this._detached)
      return;
    this._detached = true;
    const sock = this.socket;
    const l = this._sockListeners;
    if (sock && l) {
      sock.removeListener("data", l.onData);
      sock.removeListener("end", l.onEnd);
      sock.removeListener("error", l.onError);
      sock.removeListener("close", l.onClose);
    }
    this._sockListeners = null;
    if (sock && !sock.destroyed)
      sock.pause();
  }

  _sendHead() {
    if (this._sent)
      return;
    this._sent = true;
    this._headWritten = false;
    const o = this._options;
    const path = this.path;
    let head = this.method + " " + path + " HTTP/1.1\r\n";
    const headers = Object.assign({}, this._headers);
    if (headers.host === undefined)
      headers.host = o.hostname || o.host || "localhost";
    if (headers.connection === undefined)
      headers.connection = this.agent && this.agent.keepAlive
        ? "keep-alive" : "close";
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
    this._flushHead();
  }

  _flushHead() {
    if (!this._sent || this._headWritten)
      return;
    if (!this.socket || this.socket.destroyed)
      return;
    this._headWritten = true;
    this.socket.write(Buffer.from(this._rawHead));
  }

  _flushBody() {
    if (!this.socket || this.socket.destroyed)
      return;
    while (this._pendingBody.length)
      this.socket.write(this._pendingBody.shift());
  }

  _isChunked() {
    const te = this._headers["transfer-encoding"];
    const text = Array.isArray(te) ? te.join(",") : String(te || "");
    return text.toLowerCase().indexOf("chunked") >= 0;
  }

  _frameChunk(b) {
    if (!this._isChunked() || !b.length)
      return b;
    return Buffer.concat([
      Buffer.from(b.length.toString(16) + "\r\n"),
      b,
      Buffer.from("\r\n"),
    ]);
  }

  _write(chunk, encoding, cb) {
    const b = this._frameChunk(toChunk(chunk, encoding));
    if (!this._sent) {
      this._chunks.push(b);
      this._sendHead();
      const body = this._chunks;
      this._chunks = [];
      for (const part of body)
        this._pendingBody.push(part);
      this._flushBody();
    } else {
      this._pendingBody.push(b);
      this._flushBody();
    }
    cb();
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null)
      this._chunks.push(this._frameChunk(toChunk(chunk, encoding)));
    this._sendHead();
    if (this._chunks.length) {
      for (const part of this._chunks)
        this._pendingBody.push(part);
      this._chunks = [];
    }
    if (this._isChunked())
      this._pendingBody.push(Buffer.from("0\r\n\r\n"));
    this._flushBody();
    this.emit("finish");
    if (cb) queueMicrotask(cb);
    return this;
  }

  abort() {
    if (this.aborted)
      return this;
    this.aborted = true;
    this._failed = true;
    this._detachSocket();
    if (this.socket && !this.socket.destroyed)
      this.socket.destroy();
    this.emit("abort");
    return this;
  }

  destroy(err) {
    if (!this.aborted && !this._failed)
      this.abort();
    return super.destroy(err);
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
      this._responded = true;
      this._respBuf = rest;
      const te = (res.headers["transfer-encoding"] || "").toLowerCase();
      this._chunked = te === "chunked";
      const noBody = this.method === "HEAD" || res.statusCode === 204 ||
        res.statusCode === 304;
      this._remaining = noBody ? 0
        : (res.headers["content-length"] !== undefined
          ? parseInt(res.headers["content-length"], 10) : -1);
      this.emit("response", res);
    }
    this._feedResponse();
  }

  _feedResponse() {
    const res = this.res;
    if (!res || res.complete)
      return;
    if (this._chunked) {
      const d = decodeChunked(this._respBuf);
      this._respBuf = d.rest;
      if (d.body.length)
        res.push(d.body);
      if (d.done)
        this._finishResponse(this._respBuf.length === 0);
      return;
    }
    if (this._remaining >= 0) {
      const take = Math.min(this._remaining, this._respBuf.length);
      if (take > 0) {
        res.push(this._respBuf.subarray(0, take));
        this._respBuf = this._respBuf.subarray(take);
        this._remaining -= take;
      }
      if (this._remaining === 0)
        this._finishResponse(this._respBuf.length === 0);
      return;
    }
    if (this._respBuf.length) {
      res.push(this._respBuf);
      this._respBuf = Buffer.alloc(0);
    }
  }

  _finishResponse(reusable) {
    const res = this.res;
    if (!res || res.complete)
      return;
    res.complete = true;
    const conn = String(res.headers.connection || "").toLowerCase();
    const canReuse = reusable && conn !== "close";
    res.push(null);
    this._releaseSocket(canReuse);
  }

  _releaseSocket(reusable) {
    const sock = this.socket;
    if (!sock)
      return;
    this._detachSocket();
    if (this.agent)
      this.agent.release(this, sock, reusable);
    else if (!sock.destroyed)
      sock.destroy();
  }

  _onSocketEnd() {
    if (this._failed)
      return;
    if (!this.res) {
      this._fail(socketHangUp());
      return;
    }
    if (!this.res.complete)
      this._finishResponse(false);
  }

  _onSocketError(err) {
    this._fail(err);
  }

  _onSocketClose() {
    if (this._failed)
      return;
    if (!this.res || !this.res.complete)
      this._fail(socketHangUp());
  }

  _retryAllowed(err) {
    if (!this.agent || !this.reusedSocket || this._retried)
      return false;
    if (this._responded || this._failed || this.aborted)
      return false;
    if (this.method !== "GET" && this.method !== "HEAD")
      return false;
    if (this._pendingBody.length)
      return false;
    const code = err && err.code;
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT")
      return true;
    const msg = String((err && err.message) || err || "");
    return /socket hang up|other side closed|connection reset/i.test(msg);
  }

  _retry(err) {
    this._retried = true;
    const old = this.socket;
    this._detachSocket();
    if (old && !old.destroyed)
      old.destroy();
    this._sent = false;
    this._headWritten = false;
    this._respBuf = undefined;
    this._remaining = -1;
    this._chunked = false;
    this.res = undefined;
    this._responded = false;
    this.reusedSocket = false;
    this._start(true);
    this._sendHead();
  }

  _fail(err) {
    if (this._failed)
      return;
    if (this._retryAllowed(err)) {
      this._retry(err);
      return;
    }
    this._failed = true;
    this._detachSocket();
    const sock = this.socket;
    if (sock && !sock.destroyed)
      sock.destroy();
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
  Agent,
  createServer: (options, listener) => new HttpServer(options, listener),
  request,
  get,
};
http.globalAgent = new Agent({ keepAlive: true });

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
https.Agent = class HttpsAgent extends Agent {};
https.globalAgent = new https.Agent({ keepAlive: true });

/* ------------------------------------------------------------------ */
/* http2 (HTTP/2 protocol)                                            */
/* ------------------------------------------------------------------ */

const http2 = {
  constants: {
    NGHTTP2_SESSION_SERVER: 0,
    NGHTTP2_SESSION_CLIENT: 1,
    NGHTTP2_STREAM_STATE_IDLE: 1,
    NGHTTP2_STREAM_STATE_OPEN: 2,
    NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
    NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
    NGHTTP2_STREAM_STATE_CLOSED: 7,
    NGHTTP2_ERROR_NO_ERROR: 0,
    NGHTTP2_ERROR_PROTOCOL_ERROR: 1,
    NGHTTP2_ERROR_INTERNAL_ERROR: 2,
    NGHTTP2_ERROR_FLOW_CONTROL_ERROR: 3,
    NGHTTP2_ERROR_SETTINGS_TIMEOUT: 4,
    NGHTTP2_ERROR_STREAM_CLOSED: 5,
    NGHTTP2_ERROR_FRAME_SIZE_ERROR: 6,
    NGHTTP2_ERROR_REFUSED_STREAM: 7,
    NGHTTP2_ERROR_CANCEL: 8,
    NGHTTP2_ERROR_COMPRESSION_ERROR: 9,
    NGHTTP2_ERROR_CONNECT_ERROR: 10,
    NGHTTP2_ERROR_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_ERROR_INADEQUATE_SECURITY: 12,
    NGHTTP2_ERROR_HTTP_1_1_REQUIRED: 13,
    HTTP2_HEADER_STATUS: ":status",
    HTTP2_HEADER_METHOD: ":method",
    HTTP2_HEADER_AUTHORITY: ":authority",
    HTTP2_HEADER_SCHEME: ":scheme",
    HTTP2_HEADER_PATH: ":path",
    HTTP2_HEADER_CONTENT_TYPE: "content-type",
    HTTP2_HEADER_CONTENT_LENGTH: "content-length",
    HTTP2_METHOD_GET: "GET",
    HTTP2_METHOD_POST: "POST",
    HTTP2_METHOD_PUT: "PUT",
    HTTP2_METHOD_DELETE: "DELETE",
    HTTP2_METHOD_PATCH: "PATCH",
    HTTP2_METHOD_HEAD: "HEAD",
    HTTP2_METHOD_OPTIONS: "OPTIONS",
  },
  getDefaultSettings() {
    return {};
  },
  getPackedSettings() {
    throw new Error("http2 is not supported in qnode");
  },
  getUnpackedSettings() {
    throw new Error("http2 is not supported in qnode");
  },
  createServer() {
    throw new Error("http2 is not supported in qnode");
  },
  createSecureServer() {
    throw new Error("http2 is not supported in qnode");
  },
  connect() {
    throw new Error("http2 is not supported in qnode");
  },
  Http2Session: class Http2Session {},
  Http2ServerRequest: class Http2ServerRequest {},
  Http2ServerResponse: class Http2ServerResponse {},
  Http2Stream: class Http2Stream {},
  Http2SecureServer: class Http2SecureServer {},
};

function defaultAgentFor(protocol) {
  return protocol === "https:" ? https.globalAgent : http.globalAgent;
}

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

