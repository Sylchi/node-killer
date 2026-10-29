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
      /* Sockets close when their descriptor is released, not when the
         readable side ends: allowHalfOpen and pending writes still have work
         to do. */
      if (this._emitCloseOnEnd !== false && !this._closeEmitted) {
        this._closeEmitted = true;
        this.emit("close");
      }
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

