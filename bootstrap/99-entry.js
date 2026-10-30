/* ------------------------------------------------------------------ */
/* globals                                                            */
/* ------------------------------------------------------------------ */

/* V8-style call site introspection. Some npm packages (depd, debug) walk
   Error.prepareStackTrace output, so expose structured frames. */
function makeCallSite(file, line, column, fn, isNative) {
  return {
    getFileName: () => file || null,
    getScriptNameOrSourceURL: () => file || null,
    getLineNumber: () => line,
    getColumnNumber: () => column,
    getFunctionName: () => fn || null,
    getMethodName: () => null,
    getTypeName: () => null,
    isEval: () => !!(file && file === "<eval>"),
    getEvalOrigin: () => (!file ? undefined
      : { toString: () => file }),
    isNative: () => !!isNative,
    isConstructor: () => false,
    isToplevel: () => !fn,
    isAsync: () => false,
    isPromiseAll: () => false,
    getThis: () => undefined,
    toString() {
      if (isNative)
        return (fn ? fn + " (native)" : "native");
      const loc = file + (line === null ? "" : ":" + line + ":" + column);
      return fn ? fn + " (" + loc + ")" : loc;
    },
  };
}

function parseStackFrames(raw) {
  const frames = [];
  for (const lineText of String(raw || "").split("\n")) {
    const m = /^\s*at (.*)$/.exec(lineText);
    if (!m)
      continue;
    let rest = m[1].trim();
    let fn = null;
    let loc = rest;
    if (rest.endsWith(")") && rest.lastIndexOf(" (") >= 0) {
      const idx = rest.lastIndexOf(" (");
      fn = rest.slice(0, idx);
      loc = rest.slice(idx + 2, -1);
    }
    let file = loc;
    let line = null;
    let column = null;
    let native = loc === "native";
    if (!native) {
      const lm = /^(.*):(\d+):(\d+)$/.exec(loc);
      if (lm) {
        file = lm[1];
        line = Number(lm[2]);
        column = Number(lm[3]);
      } else if (loc.startsWith("(") && loc.endsWith(")")) {
        file = loc.slice(1, -1);
      }
    }
    frames.push(makeCallSite(file, line, column, fn, native));
  }
  return frames;
}

if (typeof Error.captureStackTrace !== "function") {
  if (typeof Error.stackTraceLimit !== "number")
    Error.stackTraceLimit = 10;
  Error.captureStackTrace = function captureStackTrace(obj, ctor) {
    const raw = new Error().stack;
    let frames = parseStackFrames(raw);
    /* Drop our own frame, matching V8 (captureStackTrace does not appear). */
    if (frames.length && frames[0].getFunctionName() === "captureStackTrace")
      frames.shift();
    if (typeof ctor === "function" && ctor.name) {
      const idx = frames.findIndex((f) => f.getFunctionName() === ctor.name);
      if (idx >= 0)
        frames = frames.slice(idx + 1);
    }
    const limit = Number(Error.stackTraceLimit);
    if (Number.isFinite(limit) && limit >= 0 && frames.length > limit)
      frames = frames.slice(0, limit);
    Object.defineProperty(obj, "stack", {
      configurable: true,
      enumerable: false,
      get() {
        const prep = Error.prepareStackTrace;
        if (typeof prep === "function")
          return prep(obj, frames);
        return frames.map((f) => "    at " + f.toString()).join("\n");
      },
      set(value) {
        Object.defineProperty(obj, "stack", {
          configurable: true, enumerable: false, writable: true, value,
        });
      },
    });
  };
}

/* quickjs-ng's native CallSite objects lack a few V8 methods that call-site
   walking packages rely on. Fill them in on the shared prototype. */
(function patchCallSites() {
  try {
    const saved = Error.prepareStackTrace;
    Error.prepareStackTrace = (err, stack) => stack;
    const probe = {};
    Error.captureStackTrace(probe);
    const frames = probe.stack;
    Error.prepareStackTrace = saved;
    if (!Array.isArray(frames) || !frames.length)
      return;
    const proto = Object.getPrototypeOf(frames[0]);
    if (!proto || typeof proto !== "object")
      return;
    if (typeof proto.isEval !== "function")
      proto.isEval = function() {
        const f = this.getFileName && this.getFileName();
        return f === "<eval>" || f === "<input>";
      };
    if (typeof proto.getEvalOrigin !== "function")
      proto.getEvalOrigin = function() {
        const f = this.getFileName && this.getFileName();
        return f ? String(f) : undefined;
      };
    if (typeof proto.getMethodName !== "function")
      proto.getMethodName = () => null;
    if (typeof proto.getTypeName !== "function")
      proto.getTypeName = () => null;
    if (typeof proto.getThis !== "function")
      proto.getThis = () => undefined;
    if (typeof proto.isToplevel !== "function")
      proto.isToplevel = function() { return !this.getFunctionName(); };
    if (typeof proto.isAsync !== "function")
      proto.isAsync = () => false;
    if (typeof proto.isPromiseAll !== "function")
      proto.isPromiseAll = () => false;
  } catch (e) { /* ignore */ }
})();

function formatError(err) {
  if (err && typeof err === "object" && err.stack) {
    const name = err.name || "Error";
    const head = err.message ? name + ": " + err.message : name;
    const stack = String(err.stack).replace(/^\n+/, "");
    return stack ? head + "\n" + stack : head;
  }
  return String(err);
}

function reportError(err) {
  if (__qnode_worker_mode) {
    if (process.listenerCount("uncaughtException"))
      process.emit("uncaughtException", err);
    __qnode_worker_send_control("error", __qnode_worker_error_fields(err));
    process.exit(1);
    return;
  }
  if (process.listenerCount("uncaughtException")) {
    process.emit("uncaughtException", err);
    return;
  }
  try {
    writeFdSync(2, "Uncaught " + formatError(err) + "\n");
  } catch (e) { /* ignore */ }
  qjsstd.exit(1);
}

const performance = perf_hooks.performance;

process.execPath = qjsos.exePath();
process.mainModule = null;
process.argv0 = argv.length ? argv[0] : process.execPath;
process.report = {
  getReport: () => ({ header: { event: "JavaScript API", version: 3 } }),
  writeReport: () => "",
  directory: process.cwd(),
  filename: "report.json",
  compact: false,
};
process.allowedNodeEnvironmentFlags = { has: () => false };
process.features.typescript = false;
process.features.inspector = false;
process.features.tls = hasTLS();
process.features.cached_builtins = false;
process.features.require_module = true;

const globalScope = globalThis;
globalScope.global = globalScope;
globalScope.Buffer = Buffer;
globalScope.process = process;
globalScope.console = console;
globalScope.setTimeout = setTimeout;
globalScope.clearTimeout = clearTimeout;
globalScope.setInterval = setInterval;
globalScope.clearInterval = clearInterval;
globalScope.setImmediate = setImmediate;
globalScope.clearImmediate = clearImmediate;
globalScope.queueMicrotask = globalScope.queueMicrotask ||
  ((fn) => Promise.resolve().then(fn));
globalScope.URL = URL;
globalScope.URLSearchParams = URLSearchParams;
globalScope.TextEncoder = TextEncoder;
globalScope.TextDecoder = TextDecoder;
globalScope.AbortController = AbortController;
globalScope.AbortSignal = AbortSignal;
globalScope.Event = Event;
globalScope.EventTarget = EventTarget;
globalScope.MessageEvent = MessageEvent;
globalScope.CustomEvent = CustomEvent;
globalScope.ProgressEvent = ProgressEvent;
globalScope.CloseEvent = CloseEvent;
globalScope.WebSocket = WebSocket;
globalScope.MessageChannel = MessageChannel;
globalScope.MessagePort = MessagePort;
globalScope.BroadcastChannel = BroadcastChannel;
globalScope.ReadableStream = ReadableStream;
globalScope.WritableStream = WritableStream;
globalScope.TransformStream = TransformStream;
globalScope.CompressionStream = CompressionStream;
globalScope.DecompressionStream = DecompressionStream;
globalScope.ReadableByteStreamController = ReadableByteStreamController;
globalScope.ReadableStreamBYOBRequest = ReadableStreamBYOBRequest;
globalScope.CountQueuingStrategy = CountQueuingStrategy;
globalScope.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
globalScope.TextEncoderStream = TextEncoderStream;
globalScope.TextDecoderStream = TextDecoderStream;
globalScope.PerformanceObserver = PerformanceObserver;
globalScope.structuredClone = structuredClone;
globalScope.reportError = reportError;
globalScope.performance = performance;
globalScope.fetch = fetch;
globalScope.Headers = Headers;
globalScope.Request = Request;
globalScope.Response = Response;
globalScope.Blob = Blob;
globalScope.File = File;
globalScope.FormData = FormData;
globalScope.DOMException = DOMException;
globalScope.crypto = crypto.webcrypto;
globalScope.CryptoKey = CryptoKey;
globalScope.SubtleCrypto = SubtleCrypto;
globalScope.atob = (s) => Buffer.from(s, "base64").toString("latin1");
globalScope.btoa = (s) => Buffer.from(s, "latin1").toString("base64");
globalScope.navigator = {
  userAgent: "qnode/0.1 (quickjs-ng)",
  platform: "Linux " + ARCH,
  hardwareConcurrency: native.cpuCount(),
  language: "en-US",
};
globalScope.self = globalScope;

/* ------------------------------------------------------------------ */
/* owned TCP stack                                                    */
/* ------------------------------------------------------------------ */

/* The owned stack needs a heartbeat for retransmission timers and TUN input.
   It is unref'd, so it only runs while sockets or other work keep the loop
   alive; a bare `qnode -e` still exits. */
if (typeof native !== "undefined" && typeof native.netstackInfo === "function") {
  try {
    const info = native.netstackInfo();
    if (info[0]) {
      const tun = info[3];
      if (tun >= 0 && typeof qjsos !== "undefined") {
        qjsos.setReadHandler(tun, () => native.netstackPump());
        qjsos.setHandlerRef(tun, false);
      }
      setInterval(() => native.netstackTick(), 20).unref();
    }
  } catch (e) {
    /* The kernel socket path remains available. */
  }
}

/* ------------------------------------------------------------------ */
/* C-facing module loader API                                         */
/* ------------------------------------------------------------------ */

function __qnode_resolve(spec, base, kind) {
  return resolveRequest(String(spec), base ? String(base) : "", kind || "import");
}

function __qnode_module_kind(path) {
  return moduleKind(String(path));
}

function __qnode_import_cjs(path) {
  const exports = loadCJSFile(String(path), null);
  if (exports === null || exports === undefined)
    return {};
  if (typeof exports !== "object" && typeof exports !== "function")
    return {};
  return exports;
}

function runMainCJS(filename) {
  filename = pathResolve(String(filename));
  if (cjsCache[filename]) {
    mainModule = cjsCache[filename];
    return mainModule.exports;
  }
  let source = readFileSync(filename, "utf8");
  if (source.charCodeAt(0) === 0xfeff)
    source = source.slice(1);
  if (source.startsWith("#!"))
    source = "//" + source.slice(2);
  if (pathExtname(filename).toLowerCase() === ".json") {
    const mod = new Module(filename, null);
    mod.id = ".";
    cjsCache[filename] = mod;
    mod.exports = JSON.parse(source.replace(/^\uFEFF/, ""));
    mod.loaded = true;
    mainModule = mod;
    process.mainModule = mod;
    return mod.exports;
  }
  const mod = new Module(filename, null);
  mod.id = ".";
  cjsCache[filename] = mod;
  mainModule = mod;
  process.mainModule = mod;
  const req = makeRequire(filename);
  req.main = mod;
  const dirname = pathDirname(filename);
  try {
    const fn = new Function("exports", "require", "module", "__filename",
                            "__dirname",
                            source + "\n//# sourceURL=" + filename);
    fn.call(mod.exports, mod.exports, req, mod, filename, dirname);
    mod.loaded = true;
  } catch (e) {
    delete cjsCache[filename];
    throw e;
  }
  return mod.exports;
}

function __qnode_run_cjs(path) {
  return runMainCJS(String(path));
}

function __qnode_esm_builtin(name) {
  name = String(name);
  const key = name.startsWith("qnode:") ? name.slice(6) : name;
  const mod = builtins[key];
  if (mod === undefined)
    throw new Error("No such builtin module: " + name);
  return mod;
}

globalScope.__qnode_resolve = __qnode_resolve;
globalScope.__qnode_module_kind = __qnode_module_kind;
globalScope.__qnode_import_cjs = __qnode_import_cjs;
globalScope.__qnode_run_cjs = __qnode_run_cjs;
globalScope.__qnode_esm_builtin = __qnode_esm_builtin;
globalScope.__qnode_inspect = (v) => inspect(v);
globalScope.__qnode_require = (spec) =>
  makeRequire(pathJoin(process.cwd(), "index.js"))(spec);
/* `qnode -e` evaluates in the global scope; Node exposes require there. */
globalScope.require = globalScope.__qnode_require;

/* Report unhandled promise rejections like Node does. */
globalThis.__qnode_on_unhandled = function(reason) {
  if (process.listenerCount("unhandledRejection")) {
    process.emit("unhandledRejection", reason, Promise.resolve());
    return;
  }
  const err = reason instanceof Error ? reason
    : new Error("Unhandled promise rejection: " + inspect(reason));
  reportError(err);
};

/* The C tracker fires the moment a promise is rejected.  Defer reporting to
   the end of the current turn so a handler attached later in the same turn
   still counts.  A single microtask is not enough: an async function that
   returns a rejected promise only adopts it from a queued job, so reporting
   there would race with the adoption. */
const __qnode_pending_rejections = new Map();
let __qnode_rejection_scheduled = false;
globalThis.__qnode_track_rejection = function(promise, reason, handled) {
  if (handled) {
    __qnode_pending_rejections.delete(promise);
    return;
  }
  __qnode_pending_rejections.set(promise, reason);
  if (__qnode_rejection_scheduled) return;
  __qnode_rejection_scheduled = true;
  setTimeout(() => {
    __qnode_rejection_scheduled = false;
    const pending = Array.from(__qnode_pending_rejections.values());
    __qnode_pending_rejections.clear();
    for (const reason of pending) globalThis.__qnode_on_unhandled(reason);
  }, 0);
};

/* ------------------------------------------------------------------ */
/* worker entry                                                       */
/* ------------------------------------------------------------------ */

async function __qnode_worker_run() {
  const startup = __qnode_worker_startup || {};
  const filename = String(globalThis.__qnode_worker_filename ||
                          startup.filename || "<worker>");
  for (const entry of startup.environmentData || [])
    __qnode_environment_data.set(entry[0], entry[1]);
  process.argv = [process.execPath, filename].concat(startup.argv || []);
  process.argv0 = process.execPath;

  try {
    if (startup.eval) {
      const dirname = process.cwd();
      const req = makeRequire(pathJoin(dirname, "index.js"));
      const mod = { exports: {}, id: filename, filename, loaded: false };
      const fn = new Function("exports", "require", "module",
                              "__filename", "__dirname",
                              String(startup.evalSource || "") +
                              "\n//# sourceURL=" + filename);
      fn.call(mod.exports, mod.exports, req, mod, filename, dirname);
      mod.loaded = true;
    } else {
      const kind = moduleKind(filename);
      if (kind === "cjs" || kind === "json")
        runMainCJS(filename);
      else
        await import(filename);
    }
  } catch (e) {
    reportError(e);
  }
}

if (__qnode_worker_mode)
  __qnode_worker_run();
