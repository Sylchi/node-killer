/* ------------------------------------------------------------------ */
/* dgram                                                              */
/* ------------------------------------------------------------------ */

function dgramFamilyName(family) {
  return family === C.AF_INET6 ? "IPv6" : "IPv4";
}

function dgramDefaultAddress(type) {
  return type === "udp6" ? "::" : "0.0.0.0";
}

function dgramNotRunning() {
  const e = new Error("Not running");
  e.code = "ERR_SOCKET_DGRAM_NOT_RUNNING";
  return e;
}

function dgramNotConnected() {
  const e = new Error("Not connected");
  e.code = "ERR_SOCKET_DGRAM_NOT_CONNECTED";
  return e;
}

function dgramAlreadyBound() {
  const e = new Error("Socket is already bound");
  e.code = "ERR_SOCKET_ALREADY_BOUND";
  return e;
}

/* Parse the send() argument forms:
     send(msg[, callback])
     send(msg, port[, address][, callback])
     send(msg, offset, length, port[, address][, callback]) */
function dgramSendArgs(args) {
  let offset = 0;
  let length;
  let port;
  let address;
  let cb;
  let i = 0;

  if (typeof args[i] === "number" && typeof args[i + 1] === "number") {
    offset = args[i++];
    length = args[i++];
  }
  if (typeof args[i] === "number")
    port = args[i++];
  if (typeof args[i] === "string")
    address = args[i++];
  if (typeof args[i] === "function")
    cb = args[i++];
  return { offset, length, port, address, cb };
}

class DgramSocket extends EventEmitter {
  constructor(type, callback) {
    super();
    let options = {};
    if (typeof type === "object" && type !== null) {
      options = Object.assign({}, type);
      type = options.type;
    }
    if (type !== "udp4" && type !== "udp6")
      throw new TypeError('Bad socket type. Must be one of: udp4, udp6');
    this.type = type;
    this._options = options;
    this._fd = undefined;
    this._bound = false;
    this._connected = false;
    this._closed = false;
    this._attached = false;
    this._ref = true;
    this._localAddress = undefined;
    this._localPort = undefined;
    this._localFamily = undefined;
    this._remoteAddress = undefined;
    this._remotePort = undefined;
    this._recvBufferSize = 65536;
    this._broadcast = false;
    if (typeof callback === "function")
      this.on("message", callback);
  }

  _ensureFd() {
    if (this._fd !== undefined)
      return this._fd;
    const domain = this.type === "udp6" ? C.AF_INET6 : C.AF_INET;
    let mode = 0;
    if (this._options && this._options.netstack === true) mode = 1;
    if (this._options && this._options.netstack === false) mode = -1;
    const r = native.socket(domain, C.SOCK_DGRAM, 0, mode);
    if (r[1])
      throw sysError(r[1], "socket");
    this._fd = r[0];
    if (this._options.reuseAddr)
      native.setsockopt(this._fd, C.SOL_SOCKET, C.SO_REUSEADDR, 1);
    if (this._broadcast)
      native.setsockopt(this._fd, C.SOL_SOCKET, C.SO_BROADCAST, 1);
    return this._fd;
  }

  _applyRef() {
    if (this._fd !== undefined)
      qjsos.setHandlerRef(this._fd, this._ref);
  }

  _attach() {
    if (this._attached || this._fd === undefined)
      return;
    this._attached = true;
    const fd = this._fd;
    qjsos.setReadHandler(fd, () => this._onReadable());
    this._applyRef();
  }

  _refreshLocal() {
    if (this._fd === undefined)
      return;
    const r = native.getsockname(this._fd);
    if (!r[1]) {
      this._localAddress = r[0][0];
      this._localFamily = dgramFamilyName(r[0][1]);
      this._localPort = r[0][2];
    }
  }

  _refreshRemote() {
    if (this._fd === undefined)
      return;
    const r = native.getpeername(this._fd);
    if (!r[1]) {
      this._remoteAddress = r[0][0];
      this._remoteFamily = dgramFamilyName(r[0][1]);
      this._remotePort = r[0][2];
    }
  }

  _emitError(err) {
    if (this._closed)
      return;
    if (this.listenerCount("error"))
      this.emit("error", err);
    else
      reportError(err);
  }

  _fail(err, cb) {
    if (cb)
      queueMicrotask(() => cb(err));
    else
      queueMicrotask(() => this._emitError(err));
  }

  _onReadable() {
    if (this._closed || this._fd === undefined)
      return;
    for (;;) {
      const r = native.recvfrom(this._fd, this._recvBufferSize);
      if (r[1]) {
        if (r[1] === C.EAGAIN || r[1] === C.EWOULDBLOCK ||
            r[1] === C.EINTR)
          return;
        this._emitError(sysError(r[1], "recvfrom"));
        return;
      }
      const data = Buffer.from(r[0][0]);
      const info = r[0][1];
      const rinfo = {
        address: info[0],
        family: dgramFamilyName(info[1]),
        port: info[2],
        size: data.length,
      };
      this.emit("message", data, rinfo);
      if (this._closed || this._fd === undefined)
        return;
    }
  }

  bind(...args) {
    let options = {};
    let port;
    let address;
    let callback;

    if (typeof args[0] === "object" && args[0] !== null) {
      options = args[0];
      port = options.port;
      address = options.address;
      callback = args[1];
    } else {
      port = args[0];
      address = args[1];
      callback = args[2];
      if (typeof address === "function") {
        callback = address;
        address = undefined;
      }
    }
    if (typeof callback === "function")
      this.once("listening", callback);
    if (this._bound) {
      this._fail(dgramAlreadyBound());
      return this;
    }

    let fd;
    try {
      fd = this._ensureFd();
    } catch (e) {
      this._fail(e);
      return this;
    }
    const host = address === undefined || address === null
      ? dgramDefaultAddress(this.type) : String(address);
    const err = native.bind(fd, host, Number(port) || 0);
    if (err) {
      this._fail(sysError(err, "bind", host));
      return this;
    }
    this._bound = true;
    this._refreshLocal();
    this._attach();
    queueMicrotask(() => {
      if (!this._closed)
        this.emit("listening");
    });
    return this;
  }

  connect(...args) {
    let options = {};
    let port;
    let address;
    let callback;

    if (typeof args[0] === "object" && args[0] !== null) {
      options = args[0];
      port = options.port;
      address = options.address;
      callback = args[1];
    } else {
      port = args[0];
      address = args[1];
      callback = args[2];
      if (typeof address === "function") {
        callback = address;
        address = undefined;
      }
    }
    if (typeof callback === "function")
      this.once("connect", callback);

    let fd;
    try {
      fd = this._ensureFd();
    } catch (e) {
      this._fail(e);
      return this;
    }
    const host = address === undefined || address === null
      ? (this.type === "udp6" ? "::1" : "127.0.0.1") : String(address);
    const err = native.connect(fd, host, Number(port));
    if (err && err !== C.EINPROGRESS) {
      this._fail(sysError(err, "connect", host));
      return this;
    }
    this._bound = true;
    this._connected = true;
    this._remoteAddress = host;
    this._remotePort = Number(port);
    this._refreshLocal();
    this._refreshRemote();
    this._attach();
    queueMicrotask(() => {
      if (!this._closed)
        this.emit("connect");
    });
    return this;
  }

  disconnect() {
    if (!this._connected)
      return this;
    if (this._fd !== undefined) {
      const err = native.disconnect(this._fd);
      if (err)
        throw sysError(err, "disconnect");
    }
    this._connected = false;
    this._remoteAddress = undefined;
    this._remotePort = undefined;
    return this;
  }

  send(msg, ...args) {
    const a = dgramSendArgs(args);
    let data;
    if (typeof msg === "string")
      data = Buffer.from(msg);
    else
      data = msg;
    if (a.offset || a.length !== undefined) {
      if (!data || typeof data.subarray !== "function") {
        this._fail(new TypeError("offset/length require a Buffer"));
        return this;
      }
      data = data.subarray(a.offset,
        a.length === undefined ? data.length : a.offset + a.length);
    }

    let fd;
    try {
      fd = this._ensureFd();
    } catch (e) {
      this._fail(e, a.cb);
      return this;
    }

    let port = a.port;
    let address = a.address;
    if (port === undefined) {
      if (!this._connected) {
        this._fail(dgramNotConnected(), a.cb);
        return this;
      }
      port = this._remotePort;
      address = this._remoteAddress;
    }

    const r = native.sendto(fd, address, Number(port), data);
    if (r[1]) {
      this._fail(sysError(r[1], "sendto"), a.cb);
      return this;
    }
    if (!this._bound) {
      this._bound = true;
      this._refreshLocal();
    }
    this._attach();
    if (a.cb)
      queueMicrotask(() => a.cb(null));
    return this;
  }

  close(callback) {
    if (typeof callback === "function")
      this.once("close", callback);
    if (this._closed)
      return this;
    this._closed = true;
    const fd = this._fd;
    this._fd = undefined;
    this._attached = false;
    if (fd !== undefined) {
      qjsos.setReadHandler(fd, null);
      qjsos.setWriteHandler(fd, null);
      native.close(fd);
    }
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  address() {
    if (this._fd === undefined)
      throw dgramNotRunning();
    const r = native.getsockname(this._fd);
    if (r[1])
      throw sysError(r[1], "getsockname");
    return {
      address: r[0][0],
      family: dgramFamilyName(r[0][1]),
      port: r[0][2],
    };
  }

  remoteAddress() {
    if (!this._connected)
      throw dgramNotConnected();
    const r = native.getpeername(this._fd);
    if (r[1])
      throw sysError(r[1], "getpeername");
    return {
      address: r[0][0],
      family: dgramFamilyName(r[0][1]),
      port: r[0][2],
    };
  }

  setBroadcast(flag) {
    this._broadcast = !!flag;
    if (this._fd !== undefined)
      native.setsockopt(this._fd, C.SOL_SOCKET, C.SO_BROADCAST,
                        this._broadcast ? 1 : 0);
    return this;
  }

  setTTL(ttl) {
    return this;
  }

  setMulticastTTL(ttl) {
    return this;
  }

  setMulticastLoopback(flag) {
    return this;
  }

  setMulticastInterface(addr) {
    return this;
  }

  addMembership(group, iface) {
    return this;
  }

  dropMembership(group, iface) {
    return this;
  }

  addSourceSpecificMembership(source, group, iface) {
    return this;
  }

  dropSourceSpecificMembership(source, group, iface) {
    return this;
  }

  setRecvBufferSize(size) {
    this._recvBufferSize = Number(size) || 65536;
    return this;
  }

  setSendBufferSize(size) {
    return this;
  }

  getRecvBufferSize() {
    return this._recvBufferSize;
  }

  getSendBufferSize() {
    return 65536;
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
}

function createSocket(type, callback) {
  return new DgramSocket(type, callback);
}

const dgram = { createSocket, Socket: DgramSocket };
