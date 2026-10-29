/* ------------------------------------------------------------------ */
/* fs                                                                 */
/* ------------------------------------------------------------------ */

const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000, S_IFLNK = 0o120000, S_IFREG = 0o100000;
const S_IFBLK = 0o060000, S_IFDIR = 0o040000, S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;

class Stats {
  constructor(raw) { Object.assign(this, raw); }
  isFile() { return (this.mode & S_IFMT) === S_IFREG; }
  isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
  isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
  isFIFO() { return (this.mode & S_IFMT) === S_IFIFO; }
  isSocket() { return (this.mode & S_IFMT) === S_IFSOCK; }
  isBlockDevice() { return (this.mode & S_IFMT) === S_IFBLK; }
  isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
}

function makeStats(raw) {
  const s = new Stats(raw);
  s.atime = new Date(raw.atimeMs);
  s.mtime = new Date(raw.mtimeMs);
  s.ctime = new Date(raw.ctimeMs);
  s.birthtime = new Date(raw.birthtimeMs);
  return s;
}

function fsError(res, syscall, path) {
  const err = res[1];
  if (err)
    throw sysError(err, syscall, path);
  return res[0];
}

function fsCallback(fn, syscall, pathOf) {
  return function(...args) {
    const cb = args.pop();
    if (typeof cb !== "function")
      throw new TypeError("The callback argument must be of type function");
    let path = pathOf ? pathOf(args) : args[0];
    queueMicrotask(() => {
      try {
        const v = fn.apply(this, args);
        cb(null, v);
      } catch (e) {
        if (!e.syscall && syscall) {
          e.syscall = syscall;
          if (path !== undefined)
            e.path = String(path);
        }
        cb(e);
      }
    });
  };
}

function readFileSync(path, options) {
  const buf = fsError(native.readFile(String(path)), "open", path);
  const enc = typeof options === "string" ? options
    : options && options.encoding;
  const b = Buffer.from(buf);
  return enc ? b.toString(enc) : b;
}

function writeFileSync(path, data, options) {
  const flag = typeof options === "string" ? undefined
    : options && options.flag;
  const mode = (options && typeof options === "object")
    ? options.mode : undefined;
  const b = typeof data === "string" ? Buffer.from(data)
    : Buffer.from(data);
  return fsError(native.writeFile(String(path), b, flag, mode),
                 "open", path);
}

function appendFileSync(path, data, options) {
  const flag = typeof options === "string" ? options : "a";
  const mode = (options && typeof options === "object")
    ? options.mode : undefined;
  const b = Buffer.from(data);
  return fsError(native.writeFile(String(path), b, flag || "a", mode),
                 "open", path);
}

function statSync(path, options) {
  const follow = !(options && options.throwIfNoEntry === false) &&
    !(options === false);
  return makeStats(fsError(native.stat(String(path), follow !== false),
                           "stat", path));
}

function lstatSync(path) {
  return makeStats(fsError(native.stat(String(path), false), "lstat", path));
}

function readdirSync(path, options) {
  const list = fsError(native.readdir(String(path)), "opendir", path);
  if (options && typeof options === "object" &&
      (options.withFileTypes || options.encoding === "buffer")) {
    return list.map((name) => {
      const full = pathJoin(String(path), name);
      let st;
      try { st = lstatSync(full); } catch (e) { st = null; }
      return {
        name,
        parentPath: String(path),
        path: String(path),
        isFile: () => st ? st.isFile() : false,
        isDirectory: () => st ? st.isDirectory() : false,
        isSymbolicLink: () => st ? st.isSymbolicLink() : false,
        isFIFO: () => st ? st.isFIFO() : false,
        isSocket: () => st ? st.isSocket() : false,
        isBlockDevice: () => st ? st.isBlockDevice() : false,
        isCharacterDevice: () => st ? st.isCharacterDevice() : false,
      };
    });
  }
  return list;
}

function mkdirSync(path, options) {
  if (typeof options === "number")
    options = { mode: options };
  const recursive = options && options.recursive;
  const mode = (options && options.mode) || 0o777;
  const p = String(path);
  if (!recursive) {
    const err = native.mkdir(p, mode);
    if (err)
      throw sysError(err, "mkdir", p);
    return undefined;
  }
  let created;
  const abs = pathResolve(p);
  const parts = abs.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    try {
      const st = new Stats(fsError(native.stat(cur, true), "stat", cur));
      if (!st.isDirectory()) {
        const e = sysError(20, "mkdir", cur);
        throw e;
      }
    } catch (e) {
      if (e.code !== "ENOENT")
        throw e;
      const err = native.mkdir(cur, mode);
      if (err && err !== 17)
        throw sysError(err, "mkdir", cur);
      if (created === undefined)
        created = cur;
    }
  }
  return created;
}

function rmSync(path, options) {
  options = options || {};
  const p = String(path);
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (options.force && e.code === "ENOENT")
      return;
    throw e;
  }
  if (st.isDirectory()) {
    if (!options.recursive)
      throw sysError(21, "rm", p);
    for (const name of readdirSync(p)) {
      if (name === "." || name === "..")
        continue;
      rmSync(pathJoin(p, name), { recursive: true, force: true });
    }
    const err = native.rmdir(p);
    if (err && !(options.force && err === 2))
      throw sysError(err, "rmdir", p);
    return;
  }
  const err = native.unlink(p);
  if (err && !(options.force && err === 2))
    throw sysError(err, "unlink", p);
}

function rmdirSync(path, options) {
  if (options && options.recursive)
    return rmSync(path, { recursive: true });
  const err = native.rmdir(String(path));
  if (err)
    throw sysError(err, "rmdir", path);
}

const fsConstants = {
  F_OK: C.F_OK, R_OK: C.R_OK, W_OK: C.W_OK, X_OK: C.X_OK,
  O_RDONLY: C.O_RDONLY, O_WRONLY: C.O_WRONLY, O_RDWR: C.O_RDWR,
  O_CREAT: C.O_CREAT, O_TRUNC: C.O_TRUNC, O_APPEND: C.O_APPEND,
  O_EXCL: C.O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFSOCK, S_IFBLK, S_IFCHR,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};

function copyFileSync(src, dst, mode) {
  const err = native.copyFile(String(src), String(dst));
  if (err)
    throw sysError(err, "copyfile", src);
}

function realpathSync(path, options) {
  return fsError(native.realpath(String(path)), "realpath", path);
}

const fsSync = {
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  copyFileSync,
  realpathSync,
  readlinkSync: (p) => fsError(native.readlink(String(p)), "readlink", p),
  symlinkSync: (t, p) => {
    const err = native.symlink(String(t), String(p));
    if (err) throw sysError(err, "symlink", p);
  },
  unlinkSync: (p) => {
    const err = native.unlink(String(p));
    if (err) throw sysError(err, "unlink", p);
  },
  renameSync: (a, b) => {
    const err = native.rename(String(a), String(b));
    if (err) throw sysError(err, "rename", a);
  },
  chmodSync: (p, mode) => {
    const err = native.chmod(String(p), mode);
    if (err) throw sysError(err, "chmod", p);
  },
  chownSync: (p, uid, gid) => {
    const err = native.chown(String(p), uid, gid);
    if (err) throw sysError(err, "chown", p);
  },
  utimesSync: (p, atime, mtime) => {
    const a = atime instanceof Date ? atime.getTime() : atime * 1000;
    const m = mtime instanceof Date ? mtime.getTime() : mtime * 1000;
    const err = native.utimes(String(p), a, m);
    if (err) throw sysError(err, "utime", p);
  },
  truncateSync: (p, len) => {
    const err = native.truncate(String(p), len || 0);
    if (err) throw sysError(err, "truncate", p);
  },
  accessSync: (p, mode) => {
    const err = native.access(String(p), mode === undefined ? C.F_OK : mode);
    if (err) throw sysError(err, "access", p);
  },
  existsSync: (p) => native.access(String(p), C.F_OK) === 0,
  opendirSync: (p) => {
    const list = readdirSync(String(p));
    let i = 0;
    return {
      path: String(p),
      readSync() {
        return i < list.length ? { name: list[i++], parentPath: String(p) } : null;
      },
      closeSync() {},
      [Symbol.iterator]() { return this; },
      next() {
        if (i < list.length)
          return { value: { name: list[i++], parentPath: String(p) }, done: false };
        return { value: undefined, done: true };
      },
    };
  },
  openSync: (p, flags, mode) => {
    const fd = fsError(native.open(String(p), String(flags), mode),
                       "open", p);
    if (fd < 0)
      throw sysError(-fd, "open", p);
    return fd;
  },
  closeSync: (fd) => { native.close(fd); },
  readSync: (fd, buffer, offset, length, position) => {
    const tmp = fsError(native.read(fd, length, position), "read", undefined);
    const b = Buffer.from(tmp);
    b.copy(buffer, offset, 0, b.length);
    return b.length;
  },
  writeSync: (fd, buffer, offset, length, position) => {
    if (typeof buffer === "string") {
      const b = Buffer.from(buffer, offset);
      let off = 0;
      while (off < b.length) {
        const n = fsError(native.write(fd, b.subarray(off)), "write");
        if (!n) break;
        off += n;
      }
      return b.length;
    }
    offset = offset || 0;
    length = length === undefined ? buffer.length - offset : length;
    let off = 0;
    while (off < length) {
      const n = fsError(
        native.write(fd, buffer.subarray(offset + off, offset + length)),
        "write");
      if (!n) break;
      off += n;
    }
    return off;
  },
  fstatSync: (fd) => makeStats(fsError(native.fstat(fd), "fstat")),
  fsyncSync: (fd) => { native.fsync(fd); },
  ftruncateSync: (fd, len) => { native.ftruncate(fd, len); },
};

/* Async fs wrappers (callbacks run on the microtask queue). */

const fsAsync = {
  readFile: fsCallback(readFileSync, "open"),
  writeFile: fsCallback(writeFileSync, "open"),
  appendFile: fsCallback(appendFileSync, "open"),
  stat: fsCallback(statSync, "stat"),
  lstat: fsCallback(lstatSync, "lstat"),
  readdir: fsCallback(readdirSync, "opendir"),
  mkdir: fsCallback(mkdirSync, "mkdir"),
  rmdir: fsCallback(rmdirSync, "rmdir"),
  rm: fsCallback(rmSync, "rm"),
  unlink: fsCallback((p) => fsSync.unlinkSync(p), "unlink"),
  rename: fsCallback((a, b) => fsSync.renameSync(a, b), "rename"),
  realpath: fsCallback(realpathSync, "realpath"),
  readlink: fsCallback((p) => fsSync.readlinkSync(p), "readlink"),
  symlink: fsCallback((t, p) => fsSync.symlinkSync(t, p), "symlink"),
  chmod: fsCallback((p, m) => fsSync.chmodSync(p, m), "chmod"),
  chown: fsCallback((p, u, g) => fsSync.chownSync(p, u, g), "chown"),
  utimes: fsCallback((p, a, m) => fsSync.utimesSync(p, a, m), "utime"),
  truncate: fsCallback((p, l) => fsSync.truncateSync(p, l), "truncate"),
  copyFile: fsCallback((s, d, m) => copyFileSync(s, d, m), "copyfile"),
  access: fsCallback((p, m) => fsSync.accessSync(p, m), "access"),
  exists: (p, cb) => queueMicrotask(() => cb(fsSync.existsSync(p))),
  open: (path, flags, mode, cb) => {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    queueMicrotask(() => {
      try { cb(null, fsSync.openSync(path, flags, mode)); }
      catch (e) { cb(e); }
    });
  },
  close: (fd, cb) => queueMicrotask(() => {
    try { fsSync.closeSync(fd); cb(null); } catch (e) { cb(e); }
  }),
  read: (fd, buffer, offset, length, position, cb) => {
    if (typeof position === "function") { cb = position; position = null; }
    queueMicrotask(() => {
      try {
        const n = fsSync.readSync(fd, buffer, offset, length, position);
        cb(null, n, buffer);
      } catch (e) { cb(e); }
    });
  },
  write: (fd, buffer, offset, length, position, cb) => {
    if (typeof buffer === "string") {
      if (typeof offset === "function") { cb = offset; offset = 0; }
      else if (typeof position === "function") { cb = position; position = null; }
      queueMicrotask(() => {
        try {
          const n = fsSync.writeSync(fd, buffer, offset || 0);
          cb(null, n, buffer);
        } catch (e) { cb(e); }
      });
      return;
    }
    if (typeof offset === "function") { cb = offset; offset = 0; length = buffer.length; }
    else if (typeof length === "function") { cb = length; length = buffer.length - (offset || 0); }
    else if (typeof position === "function") { cb = position; position = null; }
    queueMicrotask(() => {
      try {
        const n = fsSync.writeSync(fd, buffer, offset || 0, length, position);
        cb(null, n, buffer);
      } catch (e) { cb(e); }
    });
  },
  fsync: (fd, cb) => queueMicrotask(() => {
    try { fsSync.fsyncSync(fd); cb(null); } catch (e) { cb(e); }
  }),
  ftruncate: (fd, len, cb) => queueMicrotask(() => {
    try { fsSync.ftruncateSync(fd, len); cb(null); } catch (e) { cb(e); }
  }),
  fstat: fsCallback((fd) => fsSync.fstatSync(fd), "fstat", (a) => undefined),
};

function fsPromise(fn, pathOf) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try { resolve(fn.apply(this, args)); }
        catch (e) { reject(e); }
      });
    });
  };
}

function promisifyMulti(fn) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, ...rest) => {
        if (err) reject(err);
        else resolve(rest.length > 1 ? rest : rest[0]);
      });
    });
  };
}

class FileHandle {
  constructor(fd) { this.fd = fd; }
  readFile(options) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          let data = Buffer.allocUnsafe(65536);
          let out = [];
          for (;;) {
            const n = fsSync.readSync(this.fd, data, 0, data.length);
            if (!n) break;
            out.push(data.subarray(0, n));
            if (n < data.length) break;
          }
          const buf = Buffer.concat(out);
          const enc = typeof options === "string" ? options
            : options && options.encoding;
          resolve(enc ? buf.toString(enc) : buf);
        } catch (e) { reject(e); }
      });
    });
  }
  writeFile(data, options) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          const b = Buffer.from(data);
          let off = 0;
          while (off < b.length) {
            const n = fsError(native.write(this.fd, b.subarray(off)), "write");
            if (!n) break;
            off += n;
          }
          resolve();
        } catch (e) { reject(e); }
      });
    });
  }
  read(buffer, offset, length, position) {
    return promisifyMulti(fsAsync.read.bind(null, this.fd,
      buffer, offset, length, position))().then(([bytesRead]) => ({
      bytesRead, buffer,
    }));
  }
  write(buffer, offset, length, position) {
    return promisifyMulti(fsAsync.write.bind(null, this.fd,
      buffer, offset, length, position))().then(([bytesWritten]) => ({
      bytesWritten, buffer,
    }));
  }
  stat() { return fsPromise(() => fsSync.fstatSync(this.fd))(); }
  truncate(len) {
    return fsPromise(() => fsSync.ftruncateSync(this.fd, len))();
  }
  sync() { return fsPromise(() => fsSync.fsyncSync(this.fd))(); }
  datasync() { return this.sync(); }
  close() {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try { fsSync.closeSync(this.fd); resolve(); } catch (e) { reject(e); }
      });
    });
  }
  [Symbol.asyncDispose]() { return this.close(); }
}

const fsp = {
  readFile: fsPromise(readFileSync),
  writeFile: fsPromise(writeFileSync),
  appendFile: fsPromise(appendFileSync),
  stat: fsPromise(statSync),
  lstat: fsPromise(lstatSync),
  readdir: fsPromise(readdirSync),
  mkdir: fsPromise(mkdirSync),
  rmdir: fsPromise(rmdirSync),
  rm: fsPromise(rmSync),
  unlink: fsPromise((p) => fsSync.unlinkSync(p)),
  rename: fsPromise((a, b) => fsSync.renameSync(a, b)),
  realpath: fsPromise(realpathSync),
  readlink: fsPromise((p) => fsSync.readlinkSync(p)),
  symlink: fsPromise((t, p) => fsSync.symlinkSync(t, p)),
  chmod: fsPromise((p, m) => fsSync.chmodSync(p, m)),
  chown: fsPromise((p, u, g) => fsSync.chownSync(p, u, g)),
  utimes: fsPromise((p, a, m) => fsSync.utimesSync(p, a, m)),
  truncate: fsPromise((p, l) => fsSync.truncateSync(p, l)),
  copyFile: fsPromise((s, d, m) => copyFileSync(s, d, m)),
  access: fsPromise((p, m) => fsSync.accessSync(p, m)),
  open: async (p, flags, mode) => new FileHandle(fsSync.openSync(p, flags, mode)),
  constants: fsConstants,
};

function createReadStream(path, options) {
  options = options || {};
  const fd = fsSync.openSync(path, "r");
  if (options.start)
    fsSync.readSync(fd, Buffer.allocUnsafe(options.start), 0, options.start);
  const stream = new Readable({
    highWaterMark: options.highWaterMark || 65536,
    read() {
      const size = options.end !== undefined
        ? Math.min(this._readableState.highWaterMark,
                   options.end - (options.start || 0) + 1)
        : this._readableState.highWaterMark;
      if (size <= 0) {
        fsSync.closeSync(fd);
        this.push(null);
        return;
      }
      try {
        const data = Buffer.allocUnsafe(size);
        const n = fsSync.readSync(fd, data, 0, size);
        if (!n) {
          fsSync.closeSync(fd);
          this.push(null);
        } else {
          this.push(n === size ? data : data.subarray(0, n));
        }
      } catch (e) {
        fsSync.closeSync(fd);
        this.destroy(e);
      }
    },
  });
  stream.path = String(path);
  stream.fd = fd;
  if (options.encoding)
    stream.setEncoding(options.encoding);
  return stream;
}

function createWriteStream(path, options) {
  options = options || {};
  const flags = options.flags || "w";
  const fd = fsSync.openSync(path, flags, options.mode);
  if (options.start) {
    fsSync.writeSync(fd, Buffer.allocUnsafe(options.start), 0, options.start);
  }
  const stream = new Writable({
    highWaterMark: options.highWaterMark,
    write(chunk, encoding, cb) {
      try {
        const b = toChunk(chunk, encoding);
        let off = 0;
        while (off < b.length) {
          const n = fsError(native.write(fd, b.subarray(off)), "write");
          if (!n) break;
          off += n;
        }
        cb();
      } catch (e) { cb(e); }
    },
    final(cb) {
      try { fsSync.closeSync(fd); cb(); } catch (e) { cb(e); }
    },
  });
  stream.path = String(path);
  stream.fd = fd;
  return stream;
}

const fs = Object.assign({
  constants: fsConstants,
  Stats,
  promises: fsp,
  createReadStream,
  createWriteStream,
}, fsSync, fsAsync);

/* ------------------------------------------------------------------ */
/* process / os                                                       */
/* ------------------------------------------------------------------ */

const START_TIME = Date.now();
const argv = Array.isArray(globalThis.__qnode_argv)
  ? globalThis.__qnode_argv.slice() : [];
const qjsArgv = Array.isArray(globalThis.scriptArgs) ? globalThis.scriptArgs : [];

function envObject() {
  const o = native.environ();
  const env = {};
  for (const k of Object.keys(o))
    env[k] = o[k];
  return env;
}

function envPairs(env) {
  const out = [];
  for (const k of Object.keys(env || {}))
    if (env[k] !== undefined)
      out.push(k + "=" + env[k]);
  return out;
}

const unameInfo = (() => {
  const r = native.uname();
  return r[1] ? { sysname: "Linux", machine: "unknown" } : r[0];
})();

const ARCH = (() => {
  const m = unameInfo.machine || "";
  if (m === "x86_64" || m === "amd64") return "x64";
  if (m === "aarch64" || m === "arm64") return "arm64";
  if (m.startsWith("arm")) return "arm";
  if (m.startsWith("i") && m.endsWith("86")) return "ia32";
  if (m.startsWith("riscv")) return "riscv64";
  return m || "x64";
})();

function writeFdSync(fd, chunk, encoding) {
  const b = typeof chunk === "string" ? Buffer.from(chunk, encoding)
    : Buffer.from(chunk);
  if (fd === 1)
    native.stdoutWrite(b);
  else if (fd === 2)
    native.stderrWrite(b);
  else
    fsSync.writeSync(fd, b, 0, b.length);
}

class StdioStream extends EventEmitter {
  constructor(fd, name) {
    super();
    this.fd = fd;
    this._name = name;
    this.isTTY = !!native.isatty(fd);
    this.columns = 80;
    this.rows = 24;
    this.readable = fd === 0;
    this.writable = fd !== 0;
    this.destroyed = false;
    this._reading = false;
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    try {
      writeFdSync(this.fd, chunk, encoding);
      if (cb) queueMicrotask(cb);
      return true;
    } catch (e) {
      if (cb) queueMicrotask(() => cb(e));
      else this.emit("error", e);
      return false;
    }
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    if (chunk !== undefined)
      this.write(chunk, encoding);
    if (cb) queueMicrotask(cb);
  }
  setEncoding(enc) { this._encoding = enc; return this; }
  pause() {
    if (this._reading) {
      qjsos.setReadHandler(this.fd, null);
      this._reading = false;
    }
    return this;
  }
  resume() {
    if (this._reading)
      return this;
    this._reading = true;
    qjsos.setReadHandler(this.fd, () => {
      const tmp = Buffer.allocUnsafe(65536);
      const n = fsError(native.read(this.fd, tmp.length), "read");
      const buf = Buffer.from(n);
      if (buf.length === 0) {
        this._reading = false;
        qjsos.setReadHandler(this.fd, null);
        this.emit("end");
        this.emit("close");
        return;
      }
      this.emit("data", this._encoding
        ? buf.toString(this._encoding) : buf);
    });
    return this;
  }
  on(name, fn) {
    super.on(name, fn);
    if (this.readable && (name === "data" || name === "readable"))
      this.resume();
    return this;
  }
  destroy() {
    this.pause();
    this.destroyed = true;
    this.emit("close");
    return this;
  }
  ref() { return this; }
  unref() { return this; }
}

const stdout = new StdioStream(1, "stdout");
const stderr = new StdioStream(2, "stderr");
const stdin = new StdioStream(0, "stdin");

/* Reject already-emitted unhandled rejections, like Node does. */
const unhandledRejections = [];

let processExitHandlers = [];

const process = new EventEmitter();
Object.assign(process, {
  argv,
  execArgv: [],
  env: envObject(),
  pid: native.getpid(),
  ppid: native.getppid(),
  platform: "linux",
  arch: ARCH,
  title: "qnode",
  version: "v20.11.0",
  versions: {
    node: "20.11.0",
    qnode: "0.1.0",
    quickjs: "0.17.0",
    v8: undefined,
  },
  release: { name: "node", sourceUrl: "" },
  exitCode: undefined,
  stdout,
  stderr,
  stdin,
  config: { variables: {} },
  features: {},
});
delete process.versions.v8;

process.cwd = function() {
  const r = native.cwd();
  if (r[1])
    throw sysError(r[1], "getcwd");
  return r[0];
};
process.chdir = function(dir) {
  const err = native.chdir(String(dir));
  if (err)
    throw sysError(err, "chdir", dir);
};
process.umask = function(mask) {
  if (mask === undefined)
    return native.umask();
  return native.umask(mask);
};
process.kill = function(pid, sig) {
  const err = native.kill(pid, sig === undefined ? 15 : Number(sig));
  if (err)
    throw sysError(err, "kill", String(pid));
  return true;
};
process.getuid = () => native.getuid();
process.getgid = () => native.getgid();
process.geteuid = () => native.getuid();
process.getegid = () => native.getgid();
process.hrtime = function(prev) {
  const now = native.hrtime();
  let sec = now[0], nsec = now[1];
  if (prev) {
    sec -= prev[0];
    nsec -= prev[1];
    if (nsec < 0) { nsec += 1e9; sec--; }
  }
  return [sec, nsec];
};
process.hrtime.bigint = function() {
  const t = native.hrtime();
  return BigInt(t[0]) * 1000000000n + BigInt(t[1]);
};
process.uptime = () => (Date.now() - START_TIME) / 1000;
process.memoryUsage = function() {
  const r = native.memoryUsage();
  return {
    rss: r[0],
    heapTotal: r[1],
    heapUsed: r[2],
    external: r[3],
    arrayBuffers: r[4],
  };
};
process.memoryUsage.rss = () => process.memoryUsage().rss;
process.cpuUsage = function(prev) {
  const r = native.rusage();
  if (!r || typeof r[0] !== "number")
    return { user: 0, system: 0 };
  let user = r[0], system = r[1];
  if (prev) {
    user -= prev.user;
    system -= prev.system;
  }
  return { user, system };
};

process.resourceUsage = function() {
  const r = native.rusage();
  if (!r || typeof r[0] !== "number")
    return null;
  return {
    userCPUTime: r[0], systemCPUTime: r[1], maxRSS: r[2],
    sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0,
    minorPageFault: r[3], majorPageFault: r[4],
    swappedOut: 0, fsRead: r[7], fsWrite: r[8],
    ipcSent: 0, ipcReceived: 0, signalsCount: 0, swapCount: 0,
    voluntaryContextSwitches: r[5], involuntaryContextSwitches: r[6],
  };
};
process.nextTick = function(fn, ...args) {
  if (typeof fn !== "function")
    throw new TypeError("The callback argument must be of type function");
  queueMicrotask(() => fn(...args));
};
process.setUncaughtExceptionCaptureCallback = () => {};
process.hasUncaughtExceptionCaptureCallback = () => false;
process.emitWarning = function(warning, type, code, ctor) {
  let w = warning;
  if (!(warning instanceof Error)) {
    w = new Error(String(warning));
    w.name = type || "Warning";
    if (code) w.code = code;
  }
  if (process.listenerCount("warning"))
    process.emit("warning", w);
  else
    stderr.write("(node:" + process.pid + ") " + (w.stack || String(w)) + "\n");
};
process.binding = function(name) {
  throw new Error("No such module: " + name);
};
process.dlopen = function() {
  throw new Error("Native addons are not supported");
};
process._linkedBinding = process.binding;
process.reallyExit = function(code) {
  if (__qnode_worker_mode) {
    native.workerExit(code || 0);
    return;
  }
  qjsstd.exit(code || 0);
};
process.abort = function() { native.abort(); };
process.exit = function(code) {
  if (code !== undefined)
    process.exitCode = code;
  const c = process.exitCode === undefined ? 0 : process.exitCode;
  for (const fn of process.listeners("exit")) {
    try { fn(c); } catch (e) { /* ignore */ }
  }
  if (__qnode_worker_mode) {
    native.workerExit(typeof c === "number" ? c : 0);
    return;
  }
  qjsstd.exit(typeof c === "number" ? c : 0);
};
process.cwd = process.cwd.bind(process);

const os = {
  EOL: "\n",
  devNull: "/dev/null",
  platform: () => "linux",
  arch: () => ARCH,
  type: () => "Linux",
  release: () => unameInfo.release || "",
  version: () => unameInfo.version || "",
  machine: () => unameInfo.machine || ARCH,
  hostname: () => native.hostname(),
  tmpdir: () => process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp",
  homedir: () => process.env.HOME || "/",
  endianness: () => "LE",
  availableParallelism: () => native.cpuCount(),
  cpus: () => {
    const n = native.cpuCount();
    const speed = 2400;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        model: unameInfo.machine || "unknown",
        speed, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      });
    }
    return out;
  },
  totalmem: () => native.meminfo()[0],
  freemem: () => native.meminfo()[1],
  uptime: () => process.uptime(),
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  userInfo: () => ({
    uid: native.getuid(), gid: native.getgid(),
    username: process.env.USER || "unknown",
    homedir: os.homedir(), shell: process.env.SHELL || "/bin/sh",
  }),
  constants: {},
};

/* ------------------------------------------------------------------ */
/* timers                                                             */
/* ------------------------------------------------------------------ */

class Timeout {
  constructor(fn, delay, args, repeat) {
    this._fn = fn;
    this._args = args;
    this._delay = delay;
    this._repeat = !!repeat;
    this._cleared = false;
    this._ref = true;
    this._schedule();
  }
  _schedule() {
    const cb = () => {
      if (this._cleared)
        return;
      if (!this._repeat)
        this._cleared = true;
      try { this._fn(...this._args); }
      catch (e) { reportError(e); }
    };
    this._id = this._repeat
      ? qjsos.setInterval(cb, this._delay)
      : qjsos.setTimeout(cb, this._delay);
  }
  ref() { this._ref = true; return this; }
  unref() { this._ref = false; return this; }
  hasRef() { return this._ref; }
  refresh() {
    this.close();
    this._cleared = false;
    this._schedule();
    return this;
  }
  close() {
    if (!this._cleared) {
      this._cleared = true;
      qjsos.clearTimeout(this._id);
    }
    return this;
  }
  [Symbol.toPrimitive]() { return this._id; }
  [Symbol.dispose]() { this.close(); }
}

function validateDelay(delay) {
  delay = Number(delay);
  if (!(delay >= 1 && delay <= 2147483647))
    delay = 1;
  return delay | 0;
}

function setTimeout(fn, delay, ...args) {
  if (typeof fn !== "function")
    throw new TypeError("The callback argument must be of type function");
  return new Timeout(fn, validateDelay(delay), args, false);
}

function setInterval(fn, delay, ...args) {
  if (typeof fn !== "function")
    throw new TypeError("The callback argument must be of type function");
  return new Timeout(fn, validateDelay(delay), args, true);
}

function clearTimeout(timer) {
  if (timer === undefined || timer === null)
    return;
  if (timer instanceof Timeout) {
    timer.close();
    return;
  }
  qjsos.clearTimeout(timer);
}

const clearInterval = clearTimeout;

function setImmediate(fn, ...args) {
  return setTimeout(fn, 1, ...args);
}

function clearImmediate(timer) {
  clearTimeout(timer);
}

/* ------------------------------------------------------------------ */
/* console                                                            */
/* ------------------------------------------------------------------ */

const consoleTimes = new Map();
let consoleGroupIndent = "";

function consoleWrite(fd, args) {
  const s = format(...args) + "\n";
  writeFdSync(fd, consoleGroupIndent + s);
}

const console = {
  log(...args) { consoleWrite(1, args); },
  info(...args) { consoleWrite(1, args); },
  debug(...args) { consoleWrite(1, args); },
  warn(...args) { consoleWrite(2, args); },
  error(...args) { consoleWrite(2, args); },
  trace(...args) {
    const err = new Error(format(...args));
    err.name = "Trace";
    consoleWrite(2, [err.stack]);
  },
  dir(obj, options) {
    consoleWrite(1, [inspect(obj, options)]);
  },
  dirxml(...args) { consoleWrite(1, args); },
  table(data) { consoleWrite(1, [data]); },
  assert(cond, ...args) {
    if (!cond)
      consoleWrite(2, ["Assertion failed" + (args.length ? ": " + format(...args) : "")]);
  },
  time(label) { consoleTimes.set(label === undefined ? "default" : label, Date.now()); },
  timeEnd(label) {
    label = label === undefined ? "default" : label;
    const t = consoleTimes.get(label);
    if (t === undefined)
      return;
    consoleTimes.delete(label);
    consoleWrite(1, [label + ": " + (Date.now() - t) + "ms"]);
  },
  timeLog(label, ...args) {
    const t = consoleTimes.get(label);
    if (t === undefined)
      return;
    consoleWrite(1, [label + ": " + (Date.now() - t) + "ms", ...args]);
  },
  group(...args) {
    if (args.length)
      consoleWrite(1, args);
    consoleGroupIndent += "  ";
  },
  groupCollapsed(...args) { console.group(...args); },
  groupEnd() {
    consoleGroupIndent = consoleGroupIndent.slice(0, -2);
  },
  count(label) {
    label = label === undefined ? "default" : label;
    const n = (console._counts.get(label) || 0) + 1;
    console._counts.set(label, n);
    consoleWrite(1, [label + ": " + n]);
  },
  countReset(label) {
    label = label === undefined ? "default" : label;
    console._counts.delete(label);
  },
  clear() { writeFdSync(1, "\x1b[2J\x1b[0;0H"); },
  _counts: new Map(),
};

