/* ------------------------------------------------------------------ */
/* WebSocket (RFC 6455)                                               */
/* ------------------------------------------------------------------ */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAcceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function wsHasToken(value, token) {
  if (Array.isArray(value))
    value = value.join(",");
  return String(value || "").split(",").some((part) =>
    part.trim().toLowerCase() === token);
}

function wsValidToken(value) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function wsEncodeFrame(opcode, payload, mask, fin) {
  if (typeof payload === "string")
    payload = Buffer.from(payload, "utf8");
  else if (!Buffer.isBuffer(payload))
    payload = Buffer.from(payload);
  const len = payload.length;
  const extra = len < 126 ? 0 : len <= 0xffff ? 2 : 8;
  const maskLen = mask ? 4 : 0;
  const out = Buffer.allocUnsafe(2 + extra + maskLen + len);
  out[0] = (fin === false ? 0 : 0x80) | (opcode & 0x0f);
  let pos = 2;
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len <= 0xffff) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, pos);
    pos += 2;
  } else {
    out[1] = maskBit | 127;
    out.writeUInt32BE(Math.floor(len / 4294967296), pos);
    out.writeUInt32BE(len >>> 0, pos + 4);
    pos += 8;
  }
  if (mask) {
    const key = crypto.randomBytes(4);
    out[pos++] = key[0];
    out[pos++] = key[1];
    out[pos++] = key[2];
    out[pos++] = key[3];
    for (let i = 0; i < len; i++)
      out[pos + i] = payload[i] ^ key[i & 3];
  } else {
    out.set(payload, pos);
  }
  return out;
}

function wsUnmask(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++)
    out[i] = payload[i] ^ key[i & 3];
  return out;
}

function wsValidCloseCode(code) {
  if (code === 1005 || code === 1006 || code === 1015 || code === 1004)
    return false;
  return (code >= 1000 && code <= 1014) || (code >= 3000 && code <= 4999);
}

class WebSocket extends EventTarget {
  constructor(url, protocols, internal) {
    super();
    this._nodeListeners = Object.create(null);
    this._socket = null;
    this._req = null;
    this._isServer = false;
    this._handshakeDone = false;
    this._handshakeBuf = Buffer.alloc(0);
    this._buffer = Buffer.alloc(0);
    this._fragments = null;
    this._fragOpcode = 0;
    this._closeSent = false;
    this._closeReceived = false;
    this._closeEmitted = false;
    this._closeCode = 1006;
    this._closeReason = "";
    this._errorEmitted = false;
    this._closeTimer = null;
    this._requestedProtocols = [];
    this.readyState = 0;
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.extensions = "";
    this.protocol = "";
    this.url = "";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    if (internal)
      this._initServer(internal);
    else
      this._initClient(url, protocols);
  }

  _initClient(url, protocols) {
    let u;
    try {
      u = url instanceof URL ? url : new URL(String(url));
    } catch (e) {
      const err = new Error("Invalid WebSocket URL: " + String(url));
      err.name = "SyntaxError";
      throw err;
    }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") {
      const err = new Error("The URL's scheme must be either 'ws' or 'wss'");
      err.name = "SyntaxError";
      throw err;
    }

    let list = [];
    if (typeof protocols === "string") {
      list = [protocols];
    } else if (protocols !== undefined && protocols !== null) {
      try {
        list = Array.from(protocols);
      } catch (e) {
        throw new TypeError("protocols must be a string or an array");
      }
    }
    const seen = Object.create(null);
    for (const raw of list) {
      const p = String(raw);
      if (!wsValidToken(p) || seen[p]) {
        const err = new Error("Invalid Sec-WebSocket-Protocol value: " + p);
        err.name = "SyntaxError";
        throw err;
      }
      seen[p] = true;
    }
    this._requestedProtocols = list;
    this.url = u.href;
    this.readyState = 0;

    const secure = u.protocol === "wss:";
    let hostname = u.hostname;
    if (hostname.startsWith("[") && hostname.endsWith("]"))
      hostname = hostname.slice(1, -1);
    const port = Number(u.port) || (secure ? 443 : 80);
    const pathname = u.pathname || "/";
    const target = pathname + u.search;
    const key = crypto.randomBytes(16).toString("base64");
    this._acceptKey = wsAcceptKey(key);

    let request = "GET " + target + " HTTP/1.1\r\n" +
      "Host: " + u.host + "\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: " + key + "\r\n" +
      "Sec-WebSocket-Version: 13\r\n";
    if (list.length)
      request += "Sec-WebSocket-Protocol: " + list.join(", ") + "\r\n";
    request += "\r\n";

    if (secure) {
      this._socket = tls.connect({
        host: hostname,
        port,
        servername: hostname,
      });
    } else {
      this._socket = net.connect({ host: hostname, port });
    }
    this._attachSocket();
    this._socket.on("connect", () => {
      if (this.readyState !== 0 || !this._socket || this._socket.destroyed)
        return;
      this._socket.write(Buffer.from(request, "latin1"));
    });
  }

  _initServer(internal) {
    this._isServer = true;
    this._socket = internal.socket;
    this._req = internal.req || null;
    this._handshakeDone = true;
    this.readyState = 1;
    this.protocol = internal.protocol || "";
    this.url = internal.req ? String(internal.req.url || "") : "";
    this._attachSocket();
    const head = internal.head;
    queueMicrotask(() => {
      if (this._closeEmitted)
        return;
      this._emitOpen();
      if (head && head.length)
        this._receive(Buffer.from(head));
    });
  }

  _attachSocket() {
    const socket = this._socket;
    if (!socket)
      return;
    if (socket.setNoDelay)
      socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => this._onSocketError(err));
    socket.on("close", () => queueMicrotask(() => this._onSocketClose()));
  }

  _onData(chunk) {
    if (this._closeEmitted || !chunk)
      return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this._handshakeDone) {
      this._handshakeBuf = this._handshakeBuf.length
        ? Buffer.concat([this._handshakeBuf, buf])
        : buf;
      const idx = bufferIndexOf(this._handshakeBuf, Buffer.from("\r\n\r\n"));
      if (idx < 0)
        return;
      const text = utf8Decode(this._handshakeBuf, 0, idx);
      const rest = this._handshakeBuf.subarray(idx + 4);
      this._handshakeBuf = Buffer.alloc(0);
      if (!this._processHandshake(text))
        return;
      if (rest.length)
        this._receive(rest);
      return;
    }
    this._receive(buf);
  }

  _processHandshake(text) {
    const lines = text.split("\r\n");
    const status = (lines.shift() || "").split(" ");
    if (Number(status[1]) !== 101) {
      this._failConnection(new Error(
        "Unexpected server response: " + status.slice(1).join(" ")), 0);
      return false;
    }
    const parsed = parseHeaderBlock(lines.join("\r\n"));
    const headers = parsed.headers;
    if (!wsHasToken(headers.upgrade, "websocket") ||
        !wsHasToken(headers.connection, "upgrade") ||
        headers["sec-websocket-accept"] !== this._acceptKey) {
      this._failConnection(new Error("Invalid WebSocket handshake response"), 0);
      return false;
    }
    const proto = headers["sec-websocket-protocol"];
    if (proto) {
      if (this._requestedProtocols.indexOf(proto) < 0) {
        this._failConnection(new Error(
          "Server selected an unrequested protocol: " + proto), 0);
        return false;
      }
      this.protocol = proto;
    }
    this.extensions = headers["sec-websocket-extensions"] || "";
    this._handshakeDone = true;
    this.readyState = 1;
    this._emitOpen();
    return true;
  }

  _receive(buf) {
    if (this._closeEmitted || !buf.length)
      return;
    this._buffer = this._buffer.length
      ? Buffer.concat([this._buffer, buf])
      : Buffer.from(buf);
    this._processFrames();
  }

  _processFrames() {
    for (;;) {
      if (this._closeEmitted)
        return;
      if (this._buffer.length < 2)
        return;
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let pos = 2;
      if (b0 & 0x70) {
        this._protocolError("RSV bits must be zero");
        return;
      }
      if (len === 126) {
        if (this._buffer.length < 4)
          return;
        len = this._buffer.readUInt16BE(2);
        pos = 4;
      } else if (len === 127) {
        if (this._buffer.length < 10)
          return;
        const hi = this._buffer.readUInt32BE(2);
        const lo = this._buffer.readUInt32BE(6);
        if (hi > 0x1fffff) {
          this._protocolError("Frame is too large");
          return;
        }
        len = hi * 4294967296 + lo;
        pos = 10;
      }
      if (this._isServer && !masked) {
        this._protocolError("Client frames must be masked");
        return;
      }
      if (!this._isServer && masked) {
        this._protocolError("Server frames must not be masked");
        return;
      }
      let maskKey = null;
      if (masked) {
        if (this._buffer.length < pos + 4)
          return;
        maskKey = this._buffer.subarray(pos, pos + 4);
        pos += 4;
      }
      if (opcode >= 8 && (!fin || len > 125)) {
        this._protocolError("Invalid control frame");
        return;
      }
      if (this._buffer.length < pos + len)
        return;
      let payload = this._buffer.subarray(pos, pos + len);
      payload = masked ? wsUnmask(payload, maskKey) : Buffer.from(payload);
      this._buffer = this._buffer.subarray(pos + len);
      if (!this._handleFrame(fin, opcode, payload))
        return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0) {
      if (!this._fragments) {
        this._protocolError("Unexpected continuation frame");
        return false;
      }
      this._fragments.push(payload);
      if (!fin)
        return true;
      const data = Buffer.concat(this._fragments);
      const frameOpcode = this._fragOpcode;
      this._fragments = null;
      this._fragOpcode = 0;
      return this._deliverMessage(frameOpcode, data);
    }
    if (opcode === 1 || opcode === 2) {
      if (this._fragments) {
        this._protocolError("Expected a continuation frame");
        return false;
      }
      if (!fin) {
        this._fragments = [payload];
        this._fragOpcode = opcode;
        return true;
      }
      return this._deliverMessage(opcode, payload);
    }
    if (opcode === 8) {
      this._handleCloseFrame(payload);
      return false;
    }
    if (opcode === 9) {
      if (!this._closeSent)
        this._sendFrame(10, payload);
      this._dispatchControl("ping", payload);
      return true;
    }
    if (opcode === 10) {
      this._dispatchControl("pong", payload);
      return true;
    }
    this._protocolError("Unknown frame opcode: " + opcode);
    return false;
  }

  _deliverMessage(opcode, payload) {
    const isBinary = opcode === 2;
    let data;
    if (isBinary) {
      if (this.binaryType === "arraybuffer") {
        const ab = new ArrayBuffer(payload.length);
        new Uint8Array(ab).set(payload);
        data = ab;
      } else if (this.binaryType === "nodebuffer") {
        data = Buffer.from(payload);
      } else {
        data = new Blob([payload]);
      }
    } else {
      data = utf8Decode(payload, 0, payload.length);
    }
    this._emitMessage(data, isBinary);
    return true;
  }

  _handleCloseFrame(payload) {
    let code = 1005;
    let reason = "";
    if (payload.length === 1) {
      this._protocolError("Invalid close frame");
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      reason = utf8Decode(payload, 2, payload.length);
      if (!wsValidCloseCode(code)) {
        this._protocolError("Invalid close code: " + code);
        return;
      }
    }
    this._closeReceived = true;
    this._closeCode = code;
    this._closeReason = reason;
    if (!this._closeSent) {
      this._sendFrame(8, payload);
      this._closeSent = true;
    }
    this._finalizeClose(code, reason, true);
  }

  _protocolError(message) {
    const err = new Error(message);
    err.code = "WS_ERR_PROTOCOL";
    this._failConnection(err, 1002);
  }

  _failConnection(err, sendCode) {
    if (this._closeEmitted)
      return;
    if (!this._errorEmitted) {
      this._errorEmitted = true;
      this._emitError(err);
    }
    if (sendCode && this.readyState === 1 && !this._closeSent) {
      this._sendFrame(8, wsEncodeClosePayload(sendCode, ""));
      this._closeSent = true;
    }
    this._finalizeClose(1006, "", false);
  }

  _onSocketError(err) {
    if (this._closeEmitted)
      return;
    this._failConnection(err, 0);
  }

  _onSocketClose() {
    if (this._closeEmitted)
      return;
    if (this.readyState === 0 && !this._errorEmitted) {
      this._errorEmitted = true;
      this._emitError(new Error(
        "WebSocket connection closed before the handshake completed"));
    }
    const clean = this._closeReceived && this._closeSent && !this._errorEmitted;
    this._finalizeClose(this._closeReceived ? this._closeCode : 1006,
                        this._closeReceived ? this._closeReason : "", clean);
  }

  _finalizeClose(code, reason, wasClean) {
    if (this._closeEmitted)
      return;
    this._closeEmitted = true;
    this.readyState = 3;
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    const socket = this._socket;
    if (socket && !socket.destroyed) {
      if (wasClean)
        socket.end();
      else
        socket.destroy();
    }
    this._emitClose(code, reason, wasClean);
  }

  _emitNode(type, ...args) {
    const list = this._nodeListeners[type];
    if (!list)
      return;
    for (const fn of list.slice())
      fn.apply(this, args);
  }

  _emitOpen() {
    if (this._closeEmitted)
      return;
    super.dispatchEvent(new Event("open"));
    this._emitNode("open");
  }

  _emitMessage(data, isBinary) {
    super.dispatchEvent(new MessageEvent("message", { data }));
    this._emitNode("message", data, isBinary);
  }

  _emitError(err) {
    const event = new Event("error");
    event.error = err;
    event.message = err && err.message;
    super.dispatchEvent(event);
    this._emitNode("error", err);
  }

  _emitClose(code, reason, wasClean) {
    const event = new CloseEvent("close", { code, reason, wasClean });
    super.dispatchEvent(event);
    this._emitNode("close", code, reason, event);
  }

  _dispatchControl(type, payload) {
    const event = new Event(type);
    event.data = Buffer.from(payload);
    super.dispatchEvent(event);
    this._emitNode(type, event.data);
  }

  _sendFrame(opcode, payload, fin) {
    if (!this._socket || this._socket.destroyed)
      return;
    const bytes = typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.from(payload);
    const frame = wsEncodeFrame(opcode, bytes, !this._isServer,
                                fin === false ? false : true);
    this.bufferedAmount += bytes.length;
    this._socket.write(frame, (err) => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes.length);
      if (err)
        this._onSocketError(err);
    });
  }

  _sendCloseFrame(code, reason) {
    this._sendFrame(8, wsEncodeClosePayload(code, reason));
  }

  _armCloseTimer() {
    if (this._closeTimer)
      clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      if (!this._closeEmitted)
        this._finalizeClose(1006, "", false);
    }, 2000);
    if (this._closeTimer.unref)
      this._closeTimer.unref();
  }

  send(data) {
    if (this.readyState === 0) {
      const err = new Error("WebSocket is still connecting");
      err.name = "InvalidStateError";
      throw err;
    }
    if (this.readyState !== 1)
      return;
    let opcode = 1;
    let payload;
    if (typeof data === "string") {
      payload = Buffer.from(data, "utf8");
    } else if (Buffer.isBuffer(data)) {
      opcode = 2;
      payload = data;
    } else if (data instanceof ArrayBuffer) {
      opcode = 2;
      payload = Buffer.from(data);
    } else if (ArrayBuffer.isView(data)) {
      opcode = 2;
      payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then((ab) => {
        if (this.readyState === 1)
          this.send(ab);
      });
      return;
    } else {
      payload = Buffer.from(String(data), "utf8");
    }
    this._sendFrame(opcode, payload);
  }

  ping(data) {
    if (this.readyState !== 1)
      return;
    const payload = data === undefined ? Buffer.alloc(0) : Buffer.from(data);
    if (payload.length > 125)
      throw new RangeError("Ping payload must be 125 bytes or less");
    this._sendFrame(9, payload);
  }

  pong(data) {
    if (this.readyState !== 1)
      return;
    const payload = data === undefined ? Buffer.alloc(0) : Buffer.from(data);
    if (payload.length > 125)
      throw new RangeError("Pong payload must be 125 bytes or less");
    this._sendFrame(10, payload);
  }

  close(code, reason) {
    if (this.readyState === 3)
      return;
    reason = reason === undefined ? "" : String(reason);
    if (code !== undefined && !wsValidCloseCode(Number(code)))
      throw new RangeError("Invalid WebSocket close code: " + code);
    if (Buffer.byteLength(reason, "utf8") > 123)
      throw new RangeError("Close reason must be 123 bytes or less");
    if (this.readyState === 0) {
      this.readyState = 2;
      if (this._socket && !this._socket.destroyed)
        this._socket.destroy();
      this._finalizeClose(1006, "", false);
      return;
    }
    if (this._closeSent)
      return;
    this._sendCloseFrame(code === undefined ? undefined : Number(code), reason);
    this._closeSent = true;
    this.readyState = 2;
    this._armCloseTimer();
  }

  terminate() {
    this._finalizeClose(1006, "", false);
  }

  on(type, fn) {
    if (typeof fn !== "function")
      throw new TypeError("The listener must be a function");
    let list = this._nodeListeners[type];
    if (!list)
      list = this._nodeListeners[type] = [];
    list.push(fn);
    return this;
  }

  once(type, fn) {
    const self = this;
    function wrapper(...args) {
      self.removeListener(type, wrapper);
      return fn.apply(this, args);
    }
    wrapper.listener = fn;
    return this.on(type, wrapper);
  }

  removeListener(type, fn) {
    const list = this._nodeListeners[type];
    if (!list)
      return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i].listener === fn) {
        list.splice(i, 1);
        break;
      }
    }
    return this;
  }

  off(type, fn) { return this.removeListener(type, fn); }
}

function wsEncodeClosePayload(code, reason) {
  if (code === undefined)
    return Buffer.alloc(0);
  const text = Buffer.from(reason === undefined ? "" : String(reason), "utf8");
  const out = Buffer.allocUnsafe(2 + text.length);
  out.writeUInt16BE(Number(code), 0);
  text.copy(out, 2);
  return out;
}

WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;
for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"])
  WebSocket.prototype[name] = WebSocket[name];

class WebSocketServer extends EventEmitter {
  constructor(options, callback) {
    super();
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    this.options = options || {};
    this.clients = new Set();
    this._server = null;
    this._ownServer = false;
    this._closed = false;
    if (callback)
      this.on("connection", callback);

    if (this.options.noServer) {
      /* handleUpgrade() is called by the application. */
    } else if (this.options.server) {
      this.attach(this.options.server);
    } else if (this.options.port !== undefined ||
               this.options.host !== undefined) {
      this._listen();
    } else {
      throw new TypeError(
        "One of the \"port\", \"server\", or \"noServer\" options is required");
    }
  }

  _listen() {
    const server = net.createServer((socket) =>
      this._handleRawConnection(socket));
    this._server = server;
    this._ownServer = true;
    server.on("error", (err) => this.emit("error", err));
    server.on("listening", () => this.emit("listening"));
    server.on("close", () => this.emit("close"));
    server.listen(this.options.port === undefined ? 0 : this.options.port,
                  this.options.host);
    return this;
  }

  attach(server) {
    this._server = server;
    if (server instanceof HttpServer) {
      this._upgradeHandler = (req, socket, head) => {
        this.handleUpgrade(req, socket, head,
          (ws) => this.emit("connection", ws, req));
      };
      server.on("upgrade", this._upgradeHandler);
    } else {
      this._connectionHandler = (socket) => this._handleRawConnection(socket);
      server.on("connection", this._connectionHandler);
    }
    return this;
  }

  _handleRawConnection(socket) {
    let buf = Buffer.alloc(0);
    const onError = () => {};
    socket.on("error", onError);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = bufferIndexOf(buf, Buffer.from("\r\n\r\n"));
      if (idx < 0)
        return;
      socket.removeListener("data", onData);
      const headText = utf8Decode(buf, 0, idx);
      const head = buf.subarray(idx + 4);
      const lines = headText.split("\r\n");
      const first = (lines.shift() || "").split(" ");
      const req = new IncomingMessage(socket);
      req.method = first[0] || "GET";
      req.url = first[1] || "/";
      req.httpVersion = (first[2] || "HTTP/1.1").slice(5);
      const parsed = parseHeaderBlock(lines.join("\r\n"));
      req.headers = parsed.headers;
      req.rawHeaders = parsed.rawHeaders;
      req.complete = true;
      this.handleUpgrade(req, socket, head,
        (ws) => this.emit("connection", ws, req));
    };
    socket.on("data", onData);
  }

  _abortHandshake(socket, status, message) {
    const body = message + "\n";
    let head = "HTTP/1.1 " + status + " " +
      (STATUS_CODES[status] || "Error") + "\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      "Content-Length: " + Buffer.byteLength(body) + "\r\n";
    if (status === 426)
      head += "Sec-WebSocket-Version: 13\r\n";
    head += "\r\n";
    try {
      socket.write(head + body);
      socket.end();
    } catch (e) {
      socket.destroy();
    }
  }

  handleUpgrade(req, socket, head, cb) {
    cb = cb || ((ws) => this.emit("connection", ws, req));
    const headers = req.headers || {};
    const key = headers["sec-websocket-key"];
    const version = headers["sec-websocket-version"];
    const upgrade = String(headers.upgrade || "").toLowerCase();
    if (req.method !== "GET" || upgrade !== "websocket" ||
        !wsHasToken(headers.connection, "upgrade") || !key) {
      this._abortHandshake(socket, 400, "Bad Request");
      return;
    }
    if (String(version) !== "13") {
      this._abortHandshake(socket, 426, "Upgrade Required");
      return;
    }

    const offered = String(headers["sec-websocket-protocol"] || "")
      .split(",").map((p) => p.trim()).filter(Boolean);
    let selected = "";
    if (typeof this.options.handleProtocols === "function") {
      const result = this.options.handleProtocols(new Set(offered), req);
      if (result)
        selected = String(result);
    } else if (this.options.protocols) {
      const allowed = typeof this.options.protocols === "string"
        ? [this.options.protocols] : Array.from(this.options.protocols);
      for (const p of offered) {
        if (allowed.indexOf(p) >= 0) {
          selected = p;
          break;
        }
      }
    }

    let response = "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n";
    if (selected)
      response += "Sec-WebSocket-Protocol: " + selected + "\r\n";
    response += "\r\n";
    socket.write(Buffer.from(response, "latin1"));

    const ws = new WebSocket(null, null, {
      socket,
      req,
      head: head || Buffer.alloc(0),
      protocol: selected,
    });
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    cb(ws, req);
    return ws;
  }

  address() {
    return this._server ? this._server.address() : null;
  }

  close(cb) {
    if (this._server) {
      if (this._upgradeHandler)
        this._server.removeListener("upgrade", this._upgradeHandler);
      if (this._connectionHandler)
        this._server.removeListener("connection", this._connectionHandler);
    }
    const done = () => {
      if (cb)
        queueMicrotask(cb);
      this.emit("close");
    };
    for (const ws of Array.from(this.clients))
      ws.terminate();
    if (this._closed) {
      if (cb)
        queueMicrotask(cb);
      return;
    }
    this._closed = true;
    if (this._ownServer && this._server && this._server.listening) {
      this._server.close(done);
    } else {
      done();
    }
  }
}

const websocketModule = {
  WebSocket,
  WebSocketServer,
};
