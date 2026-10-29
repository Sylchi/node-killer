/* ------------------------------------------------------------------ */
/* WHATWG streams                                                     */
/* ------------------------------------------------------------------ */

function qnodeHighWaterMark(strategy, fallback) {
  if (!strategy || strategy.highWaterMark === undefined)
    return fallback;
  const hwm = Number(strategy.highWaterMark);
  if (!(hwm >= 0) || !Number.isFinite(hwm))
    throw new RangeError("Invalid highWaterMark");
  return hwm;
}

class CountQueuingStrategy {
  constructor(init) {
    if (!init || init.highWaterMark === undefined)
      throw new TypeError("highWaterMark is required");
    this.highWaterMark = qnodeHighWaterMark(init, 0);
  }
  size() { return 1; }
}

class ByteLengthQueuingStrategy {
  constructor(init) {
    if (!init || init.highWaterMark === undefined)
      throw new TypeError("highWaterMark is required");
    this.highWaterMark = qnodeHighWaterMark(init, 0);
  }
  size(chunk) { return chunk.byteLength; }
}

class ReadableStreamDefaultController {
  constructor(stream) { this._stream = stream; }
  get desiredSize() { return this._stream._desiredSize(); }
  enqueue(chunk) { this._stream._enqueue(chunk); }
  close() { this._stream._close(); }
  error(e) { this._stream._error(e); }
}

class ReadableStreamDefaultReader {
  constructor(stream) {
    if (stream._reader)
      throw new TypeError("ReadableStream is already locked to another reader");
    this._stream = stream;
    stream._reader = this;
    this._closedSettled = false;
    this._closedPromise = new Promise((resolve, reject) => {
      this._closedResolve = resolve;
      this._closedReject = reject;
    });
    this._closedPromise.catch(() => {});
    if (stream._state === "closed" && stream._queue.length === 0)
      this._settleClosed();
    else if (stream._state === "errored")
      this._settleClosed(stream._errorValue);
  }
  get closed() { return this._closedPromise; }
  _settleClosed(err) {
    if (this._closedSettled)
      return;
    this._closedSettled = true;
    if (err === undefined)
      this._closedResolve();
    else
      this._closedReject(err);
  }
  _check() {
    if (this._stream._reader !== this)
      throw new TypeError("Reader has been released");
  }
  read() {
    this._check();
    return this._stream._read();
  }
  cancel(reason) {
    this._check();
    return this._stream._cancel(reason);
  }
  releaseLock() {
    if (!this._stream)
      return;
    const stream = this._stream;
    if (stream._reader === this)
      stream._reader = null;
    stream._rejectPendingReads(new TypeError("Reader was released"));
    this._settleClosed(new TypeError("Reader was released"));
    this._stream = null;
  }
}
ReadableStreamDefaultReader.prototype[Symbol.toStringTag] =
  "ReadableStreamDefaultReader";

class ReadableStreamBYOBReader extends ReadableStreamDefaultReader {
  constructor(stream) {
    super(stream);
    this._view = null;
  }
  read(view) {
    this._check();
    if (!ArrayBuffer.isView(view))
      return Promise.reject(new TypeError("A TypedArray view is required"));
    return this._stream._read().then((result) => {
      if (result.done)
        return { value: undefined, done: true };
      const chunk = result.value;
      if (chunk instanceof ArrayBuffer) {
        const n = Math.min(view.byteLength, chunk.byteLength);
        new Uint8Array(view.buffer, view.byteOffset, n)
          .set(new Uint8Array(chunk, 0, n));
        return { value: new view.constructor(view.buffer, view.byteOffset, n),
                 done: false };
      }
      return { value: chunk, done: false };
    });
  }
}
ReadableStreamBYOBReader.prototype[Symbol.toStringTag] =
  "ReadableStreamBYOBReader";

class ReadableStream {
  constructor(source, strategy) {
    source = source || {};
    strategy = strategy || {};
    this._source = source;
    this._queue = [];
    this._queueSize = 0;
    this._pending = [];
    this._state = "readable";
    this._errorValue = undefined;
    this._reader = null;
    this._pulling = false;
    this._started = false;
    this._disturbed = false;
    this._hwm = qnodeHighWaterMark(strategy, source.type === "bytes" ? 0 : 1);
    this._sizeFn = typeof strategy.size === "function" ? strategy.size : null;
    this._controller = new ReadableStreamDefaultController(this);
    if (typeof source.start === "function") {
      try {
        const r = source.start(this._controller);
        if (r && typeof r.then === "function")
          r.catch((e) => this._error(e));
      } catch (e) {
        this._error(e);
      }
    }
    this._started = true;
    this._pullIfNeeded();
  }
  get locked() { return this._reader !== null; }
  _desiredSize() {
    if (this._state === "errored")
      return null;
    if (this._state === "closed" && this._queue.length === 0)
      return 0;
    return this._hwm - this._queueSize;
  }
  _sizeOf(chunk) {
    if (!this._sizeFn)
      return 1;
    const size = Number(this._sizeFn(chunk));
    if (!(size >= 0))
      throw new RangeError("Invalid chunk size");
    return size;
  }
  _enqueue(chunk) {
    if (this._state === "errored")
      throw this._errorValue;
    if (this._state !== "readable")
      throw new TypeError("Cannot enqueue into a closed stream");
    let size;
    try {
      size = this._sizeOf(chunk);
    } catch (e) {
      this._error(e);
      throw e;
    }
    this._queue.push({ chunk, size });
    this._queueSize += size;
    this._flush();
    this._pullIfNeeded();
  }
  _close() {
    if (this._state !== "readable")
      return;
    this._state = "closed";
    this._flush();
    this._pullIfNeeded();
  }
  _error(e) {
    if (this._state === "errored" || this._state === "closed")
      return;
    this._state = "errored";
    this._errorValue = e;
    this._queue = [];
    this._queueSize = 0;
    this._rejectPendingReads(e);
    if (this._reader)
      this._reader._settleClosed(e);
  }
  _rejectPendingReads(e) {
    const pending = this._pending;
    this._pending = [];
    for (const p of pending)
      p.reject(e);
  }
  _flush() {
    while (this._pending.length && this._queue.length) {
      const p = this._pending.shift();
      const entry = this._queue.shift();
      this._queueSize -= entry.size;
      p.resolve({ value: entry.chunk, done: false });
    }
    if (this._state === "closed" && this._queue.length === 0) {
      const pending = this._pending;
      this._pending = [];
      for (const p of pending)
        p.resolve({ value: undefined, done: true });
      if (this._reader)
        this._reader._settleClosed();
    }
    if (this._state === "errored" && this._pending.length) {
      const e = this._errorValue;
      this._rejectPendingReads(e);
    }
  }
  _read() {
    this._disturbed = true;
    if (this._state === "errored")
      return Promise.reject(this._errorValue);
    if (this._queue.length) {
      const entry = this._queue.shift();
      this._queueSize -= entry.size;
      if (this._state === "closed" && this._queue.length === 0 && this._reader)
        this._reader._settleClosed();
      this._pullIfNeeded();
      return Promise.resolve({ value: entry.chunk, done: false });
    }
    if (this._state === "closed") {
      if (this._reader)
        this._reader._settleClosed();
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this._pending.push({ resolve, reject });
      this._pullIfNeeded();
    });
  }
  _pullIfNeeded() {
    if (!this._started || this._pulling || this._state !== "readable")
      return;
    if (typeof this._source.pull !== "function")
      return;
    if (this._pending.length === 0 && this._desiredSize() <= 0)
      return;
    this._pulling = true;
    Promise.resolve()
      .then(() => this._source.pull(this._controller))
      .then(() => {
        this._pulling = false;
        this._pullIfNeeded();
      }, (e) => {
        this._pulling = false;
        this._error(e);
      });
  }
  getReader(options) {
    if (options && options.mode === "byob")
      return new ReadableStreamBYOBReader(this);
    return new ReadableStreamDefaultReader(this);
  }
  cancel(reason) {
    if (this._reader)
      return Promise.reject(new TypeError("Cannot cancel a locked stream"));
    return this._cancel(reason);
  }
  _cancel(reason) {
    this._disturbed = true;
    if (this._state === "closed" || this._state === "errored")
      return Promise.resolve();
    this._state = "closed";
    this._queue = [];
    this._queueSize = 0;
    this._flush();
    if (typeof this._source.cancel === "function") {
      try {
        return Promise.resolve(this._source.cancel(reason)).then(() => undefined);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve();
  }
  values(options) {
    const stream = this;
    const preventCancel = !!(options && options.preventCancel);
    let reader = null;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (!reader)
          reader = stream.getReader();
        return reader.read().then((r) => {
          if (r.done && reader) {
            reader.releaseLock();
            reader = null;
          }
          return r;
        });
      },
      async return() {
        const r = reader;
        reader = null;
        if (r) {
          if (!preventCancel) {
            try { await r.cancel(); } catch (e) {}
          }
          r.releaseLock();
        }
        return { value: undefined, done: true };
      },
    };
  }
  [Symbol.asyncIterator](options) { return this.values(options); }
  async pipeTo(dest, options) {
    options = options || {};
    const reader = this.getReader();
    const isWritable = dest instanceof WritableStream;
    const writer = isWritable ? dest.getWriter() : dest;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          if (!options.preventClose)
            await writer.close();
          break;
        }
        await writer.write(r.value);
      }
    } catch (e) {
      if (!options.preventAbort && typeof writer.abort === "function") {
        try { await writer.abort(e); } catch (_) {}
      }
      throw e;
    } finally {
      if (reader._stream)
        reader.releaseLock();
      if (isWritable && writer._stream)
        writer.releaseLock();
    }
  }
  pipeThrough(transform, options) {
    const p = this.pipeTo(transform.writable, options);
    p.catch(() => {});
    return transform.readable;
  }
  tee() {
    const reader = this.getReader();
    const branches = [];
    const cancelled = [false, false];
    let cancelCount = 0;
    const makeBranch = (index) => new ReadableStream({
      start(controller) { branches[index] = { controller }; },
      cancel() {
        cancelled[index] = true;
        if (++cancelCount === 2) {
          reader.cancel();
          reader.releaseLock();
        }
      },
    });
    const b1 = makeBranch(0);
    const b2 = makeBranch(1);
    (async () => {
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) {
            if (!cancelled[0]) branches[0].controller.close();
            if (!cancelled[1]) branches[1].controller.close();
            break;
          }
          if (!cancelled[0]) branches[0].controller.enqueue(r.value);
          if (!cancelled[1]) branches[1].controller.enqueue(r.value);
        }
      } catch (e) {
        if (!cancelled[0]) branches[0].controller.error(e);
        if (!cancelled[1]) branches[1].controller.error(e);
      } finally {
        if (reader._stream)
          reader.releaseLock();
      }
    })();
    return [b1, b2];
  }
  static from(iterable) {
    if (iterable === null || iterable === undefined)
      throw new TypeError("ReadableStream.from requires an iterable");
    const asyncIter = typeof iterable[Symbol.asyncIterator] === "function";
    const syncIter = typeof iterable[Symbol.iterator] === "function";
    if (!asyncIter && !syncIter && typeof iterable.next !== "function")
      throw new TypeError("ReadableStream.from requires an iterable");
    return new ReadableStream({
      async start(controller) {
        try {
          if (asyncIter) {
            for await (const value of iterable)
              controller.enqueue(value);
          } else if (syncIter) {
            for (const value of iterable)
              controller.enqueue(value);
          } else {
            for (;;) {
              const r = await iterable.next();
              if (r.done)
                break;
              controller.enqueue(r.value);
            }
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
  }
}
ReadableStream.prototype[Symbol.toStringTag] = "ReadableStream";

class WritableStreamDefaultController {
  constructor(stream) {
    this._stream = stream;
    this.signal = new AbortSignal();
  }
  error(e) { this._stream._error(e); }
}

class WritableStreamDefaultWriter {
  constructor(stream) {
    if (stream._writer)
      throw new TypeError("WritableStream is already locked to another writer");
    this._stream = stream;
    stream._writer = this;
    this._ready = Promise.resolve();
    this._ready.catch(() => {});
    this._closedSettled = false;
    this._closedPromise = new Promise((resolve, reject) => {
      this._closedResolve = resolve;
      this._closedReject = reject;
    });
    this._closedPromise.catch(() => {});
    if (stream._state === "closed")
      this._settleClosed();
    else if (stream._state === "errored")
      this._settleClosed(stream._errorValue);
  }
  get closed() { return this._closedPromise; }
  get ready() { return this._ready; }
  get desiredSize() {
    if (this._stream._state === "errored")
      return null;
    if (this._stream._state === "closed")
      return 0;
    return 1;
  }
  _check() {
    if (!this._stream || this._stream._writer !== this)
      throw new TypeError("Writer has been released");
  }
  write(chunk) {
    this._check();
    return this._stream._write(chunk);
  }
  close() {
    this._check();
    return this._stream._finish();
  }
  abort(reason) {
    this._check();
    return this._stream._abort(reason);
  }
  releaseLock() {
    if (!this._stream)
      return;
    const stream = this._stream;
    if (stream._writer === this)
      stream._writer = null;
    this._settleClosed(new TypeError("Writer was released"));
    this._stream = null;
  }
  _settleClosed(err) {
    if (this._closedSettled)
      return;
    this._closedSettled = true;
    if (err === undefined)
      this._closedResolve();
    else
      this._closedReject(err);
  }
  _settleReady(err) {
    if (err !== undefined) {
      this._ready = Promise.reject(err);
      this._ready.catch(() => {});
    }
  }
}
WritableStreamDefaultWriter.prototype[Symbol.toStringTag] =
  "WritableStreamDefaultWriter";

class WritableStream {
  constructor(sink, strategy) {
    sink = sink || {};
    strategy = strategy || {};
    this._sink = sink;
    this._state = "writable";
    this._errorValue = undefined;
    this._writer = null;
    this._controller = new WritableStreamDefaultController(this);
    this._chain = Promise.resolve();
    this._closedPromise = new Promise((resolve, reject) => {
      this._closedResolve = resolve;
      this._closedReject = reject;
    });
    this._closedPromise.catch(() => {});
    if (typeof sink.start === "function") {
      try {
        const r = sink.start(this._controller);
        if (r && typeof r.then === "function")
          this._chain = Promise.resolve(r);
      } catch (e) {
        this._error(e);
      }
    }
  }
  get locked() { return this._writer !== null; }
  _settleClosed(err) {
    if (this._closedSettled)
      return;
    this._closedSettled = true;
    if (err === undefined)
      this._closedResolve();
    else
      this._closedReject(err);
    if (this._writer)
      this._writer._settleClosed(err);
  }
  _error(e) {
    if (this._state === "errored" || this._state === "closed")
      return;
    this._state = "errored";
    this._errorValue = e;
    this._settleClosed(e);
    if (this._writer)
      this._writer._settleReady(e);
  }
  _write(chunk) {
    if (this._state === "errored")
      return Promise.reject(this._errorValue);
    if (this._state === "closed")
      return Promise.reject(new TypeError("Cannot write to a closed stream"));
    const run = this._chain.then(() => {
      if (this._state === "errored")
        throw this._errorValue;
      if (this._state === "closed")
        throw new TypeError("Cannot write to a closed stream");
      if (typeof this._sink.write === "function") {
        const r = this._sink.write(chunk, this._controller);
        return Promise.resolve(r).then((value) => {
          if (this._state === "errored")
            throw this._errorValue;
          return value;
        });
      }
    });
    this._chain = run.catch(() => {});
    run.catch((e) => this._error(e));
    return run;
  }
  _finish() {
    if (this._state === "errored")
      return Promise.reject(this._errorValue);
    const run = this._chain.then(() => {
      if (this._state === "errored")
        throw this._errorValue;
      if (this._state === "closed")
        return;
      this._state = "closing";
      const r = typeof this._sink.close === "function"
        ? this._sink.close(this._controller) : undefined;
      return Promise.resolve(r).then(() => {
        if (this._state === "errored")
          throw this._errorValue;
        this._state = "closed";
        this._settleClosed();
      });
    });
    this._chain = run.catch(() => {});
    run.catch((e) => this._error(e));
    return run;
  }
  _abort(reason) {
    if (this._state === "errored")
      return Promise.reject(this._errorValue);
    this._state = "errored";
    this._errorValue = reason;
    this._settleClosed(reason);
    if (this._writer)
      this._writer._settleReady(reason);
    const r = typeof this._sink.abort === "function"
      ? this._sink.abort(reason) : undefined;
    return Promise.resolve(r).then(() => undefined, (e) => {
      this._errorValue = e;
      throw e;
    });
  }
  getWriter() { return new WritableStreamDefaultWriter(this); }
  abort(reason) {
    if (this._writer)
      return Promise.reject(new TypeError("Cannot abort a locked stream"));
    return this._abort(reason);
  }
  close() {
    if (this._writer)
      return Promise.reject(new TypeError("Cannot close a locked stream"));
    return this._finish();
  }
}
WritableStream.prototype[Symbol.toStringTag] = "WritableStream";

class TransformStreamDefaultController {
  constructor(stream) { this._stream = stream; }
  get desiredSize() { return this._stream._readable._desiredSize(); }
  enqueue(chunk) { this._stream._readable._enqueue(chunk); }
  error(e) {
    this._stream._readable._error(e);
    if (this._stream._writable)
      this._stream._writable._error(e);
  }
  terminate() { this._stream._readable._close(); }
}
TransformStreamDefaultController.prototype[Symbol.toStringTag] =
  "TransformStreamDefaultController";

class TransformStream {
  constructor(transformer, writableStrategy, readableStrategy) {
    transformer = transformer || {};
    this._readable = new ReadableStream({
      start(controller) { this._readableController = controller; },
      cancel: (reason) => {
        if (this._writable)
          this._writable.abort(reason).catch(() => {});
      },
    }, readableStrategy);
    this.readable = this._readable;
    const controller = new TransformStreamDefaultController(this);
    const fail = (e) => {
      controller.error(e);
      throw e;
    };
    const run = (fn, value) => {
      try {
        const r = fn(value);
        if (r && typeof r.then === "function")
          return r.catch(fail);
        return r;
      } catch (e) {
        return fail(e);
      }
    };
    this._controller = controller;
    this._writable = new WritableStream({
      start: () => {
        if (typeof transformer.start === "function")
          return run(() => transformer.start(controller));
      },
      write: (chunk) => {
        if (typeof transformer.transform === "function")
          return run((c) => transformer.transform(c, controller), chunk);
        controller.enqueue(chunk);
      },
      close: () => {
        if (typeof transformer.flush === "function")
          return Promise.resolve(run(() => transformer.flush(controller)))
            .then(() => controller.terminate());
        controller.terminate();
      },
      abort: (reason) => {
        controller.error(reason);
        if (typeof transformer.cancel === "function")
          return run((r) => transformer.cancel(r), reason);
      },
    }, writableStrategy);
    this.writable = this._writable;
  }
}
TransformStream.prototype[Symbol.toStringTag] = "TransformStream";

class TextEncoderStream {
  constructor() {
    this.encoding = "utf-8";
    const encoder = new TextEncoder();
    this._transform = new TransformStream({
      transform(chunk, controller) { controller.enqueue(encoder.encode(chunk)); },
      flush() {},
    });
    this.readable = this._transform.readable;
    this.writable = this._transform.writable;
  }
}
TextEncoderStream.prototype[Symbol.toStringTag] = "TextEncoderStream";

class TextDecoderStream {
  constructor(label, options) {
    const decoder = new TextDecoder(label, options);
    this.encoding = decoder.encoding;
    this.fatal = decoder.fatal;
    this.ignoreBOM = decoder.ignoreBOM;
    this._transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(decoder.decode(chunk, { stream: true }));
      },
      flush(controller) { controller.enqueue(decoder.decode()); },
    });
    this.readable = this._transform.readable;
    this.writable = this._transform.writable;
  }
}
TextDecoderStream.prototype[Symbol.toStringTag] = "TextDecoderStream";

/* ------------------------------------------------------------------ */
/* MessageChannel / MessagePort / BroadcastChannel                    */
/* ------------------------------------------------------------------ */

class MessageEvent extends Event {
  constructor(type, init) {
    init = init || {};
    super(type, init);
    this.data = Object.prototype.hasOwnProperty.call(init, "data")
      ? init.data : null;
    this.origin = init.origin === undefined ? "" : String(init.origin);
    this.lastEventId = init.lastEventId === undefined ? "" : String(init.lastEventId);
    this.source = init.source === undefined ? null : init.source;
    this.ports = init.ports || [];
  }
}

class MessagePort extends EventTarget {
  constructor() {
    super();
    this._entangled = null;
    this._queue = [];
    this._started = false;
    this._closed = false;
    this._delivering = false;
    this._onmessage = null;
    this.onmessageerror = null;
    this.onclose = null;
    Object.defineProperty(this, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => this._onmessage,
      set: (fn) => {
        this._onmessage = typeof fn === "function" ? fn : null;
        if (this._onmessage)
          this.start();
      },
    });
  }
  postMessage(value, transferList) {
    if (this._closed)
      return;
    const target = this._entangled;
    if (!target || target._closed)
      return;
    const data = structuredClone(value);
    target._queue.push({ data });
    if (target._started)
      queueMicrotask(() => target._deliver());
  }
  _deliver() {
    if (this._closed || !this._started)
      return;
    while (this._queue.length && !this._closed) {
      const msg = this._queue.shift();
      this.dispatchEvent(new MessageEvent("message", { data: msg.data }));
    }
  }
  start() {
    if (this._started || this._closed)
      return;
    this._started = true;
    if (this._queue.length)
      queueMicrotask(() => this._deliver());
  }
  addEventListener(type, fn, options) {
    super.addEventListener(type, fn, options);
    if (type === "message")
      this.start();
  }
  on(type, fn) {
    this.addEventListener(type, fn);
    return this;
  }
  addListener(type, fn) { return this.on(type, fn); }
  once(type, fn) {
    const port = this;
    const wrapped = function (event) {
      port.removeEventListener(type, wrapped);
      fn.call(port, event);
    };
    this.addEventListener(type, wrapped);
    return this;
  }
  off(type, fn) {
    this.removeEventListener(type, fn);
    return this;
  }
  removeListener(type, fn) { return this.off(type, fn); }
  removeAllListeners(type) {
    if (type === undefined)
      this._listeners = Object.create(null);
    else
      this._listeners[type] = [];
    return this;
  }
  emit(type, ...args) {
    let event;
    if (type === "message")
      event = new MessageEvent("message", { data: args[0] });
    else if (args[0] instanceof Event)
      event = args[0];
    else
      event = new Event(type);
    this.dispatchEvent(event);
    return true;
  }
  listenerCount(type) {
    return (this._listeners[type] || []).length;
  }
  listeners(type) {
    return (this._listeners[type] || []).map((entry) => entry.fn);
  }
  close() {
    if (this._closed)
      return;
    this._closed = true;
    this._queue = [];
    const peer = this._entangled;
    this._entangled = null;
    if (peer && !peer._closed) {
      peer._closed = true;
      peer._entangled = null;
      peer._queue = [];
      peer.dispatchEvent(new Event("close"));
    }
    this.dispatchEvent(new Event("close"));
  }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
MessagePort.prototype[Symbol.toStringTag] = "MessagePort";

class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._entangled = this.port2;
    this.port2._entangled = this.port1;
  }
}
MessageChannel.prototype[Symbol.toStringTag] = "MessageChannel";

function receiveMessageOnPort(port) {
  if (!port || !Array.isArray(port._queue))
    throw new TypeError("port must be a MessagePort");
  if (port._queue.length === 0)
    return undefined;
  return { message: port._queue.shift().data };
}

const broadcastChannels = new Map();

class BroadcastChannel extends EventTarget {
  constructor(name) {
    super();
    if (arguments.length === 0)
      throw new TypeError("BroadcastChannel requires a name");
    this.name = String(name);
    this._closed = false;
    this.onmessage = null;
    this.onmessageerror = null;
    let set = broadcastChannels.get(this.name);
    if (!set)
      broadcastChannels.set(this.name, set = new Set());
    set.add(this);
  }
  postMessage(value) {
    if (this._closed) {
      const err = new Error("BroadcastChannel is closed");
      err.name = "InvalidStateError";
      throw err;
    }
    const data = structuredClone(value);
    const set = broadcastChannels.get(this.name);
    if (!set)
      return;
    for (const channel of set) {
      if (channel === this || channel._closed)
        continue;
      queueMicrotask(() => {
        if (!channel._closed)
          channel.dispatchEvent(
            new MessageEvent("message", { data: structuredClone(data) }));
      });
    }
  }
  close() {
    if (this._closed)
      return;
    this._closed = true;
    const set = broadcastChannels.get(this.name);
    if (set) {
      set.delete(this);
      if (set.size === 0)
        broadcastChannels.delete(this.name);
    }
    this.dispatchEvent(new Event("close"));
  }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
BroadcastChannel.prototype[Symbol.toStringTag] = "BroadcastChannel";

worker_threads.MessageChannel = MessageChannel;
worker_threads.MessagePort = MessagePort;
worker_threads.BroadcastChannel = BroadcastChannel;
worker_threads.receiveMessageOnPort = receiveMessageOnPort;

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
  builtins.dgram = dgram;
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
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamDefaultController,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    CountQueuingStrategy,
    ByteLengthQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
  };
  /* streamConsumers is declared after this function runs, so expose it via a
     getter; requiring it happens long after bootstrap initialization. */
  Object.defineProperty(builtins, "stream/consumers", {
    enumerable: true,
    configurable: true,
    get() { return streamConsumers; },
  });
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
  builtins.websocket = websocketModule;
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
    if (v === null)
      return v;
    const type = typeof v;
    if (type === "function" || type === "symbol") {
      const err = new Error(String(v) + " could not be cloned");
      err.name = "DataCloneError";
      throw err;
    }
    if (type !== "object")
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

