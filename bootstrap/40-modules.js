/* ------------------------------------------------------------------ */
/* node_modules resolution                                            */
/* ------------------------------------------------------------------ */

const builtins = Object.create(null);
const cjsCache = Object.create(null);
let mainModule = null;

function stripNodePrefix(name) {
  return name.startsWith("node:") ? name.slice(5) : name;
}

function isBuiltin(name) {
  if (name.startsWith("qjs:") || name.startsWith("qnode:"))
    return true;
  return Object.prototype.hasOwnProperty.call(builtins, stripNodePrefix(name));
}

function statOrNull(p) {
  try { return new Stats(fsError(native.stat(p, true), "stat", p)); }
  catch (e) { return null; }
}

function isFile(p) {
  const s = statOrNull(p);
  return !!s && s.isFile();
}

function isDir(p) {
  const s = statOrNull(p);
  return !!s && s.isDirectory();
}

function readJSONFile(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return null;
  }
}

const pkgCache = Object.create(null);

function readPackage(dir) {
  if (dir in pkgCache)
    return pkgCache[dir];
  const p = pathJoin(dir, "package.json");
  let pkg = null;
  if (isFile(p)) {
    pkg = readJSONFile(p);
    if (pkg)
      pkg.__dir = dir;
  }
  pkgCache[dir] = pkg;
  return pkg;
}

function findPackage(fromDir) {
  let dir = fromDir;
  for (;;) {
    const pkg = readPackage(dir);
    if (pkg)
      return pkg;
    const parent = pathDirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}

const kindCache = Object.create(null);

function moduleKind(p) {
  const ext = pathExtname(p).toLowerCase();
  if (ext === ".mjs") return "esm";
  if (ext === ".cjs") return "cjs";
  if (ext === ".json") return "json";
  if (ext === ".node") return "native";
  if (ext === ".wasm") return "wasm";
  const dir = pathDirname(p);
  if (dir in kindCache)
    return kindCache[dir];
  const pkg = findPackage(dir);
  const kind = pkg && pkg.type === "module" ? "esm" : "cjs";
  kindCache[dir] = kind;
  return kind;
}

function resolveConditional(value, kind) {
  if (typeof value === "string")
    return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = resolveConditional(v, kind);
      if (r !== null)
        return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const order = kind === "require"
      ? ["node", "require", "default"]
      : ["node", "import", "default"];
    for (const key of order) {
      if (value[key] !== undefined) {
        const r = resolveConditional(value[key], kind);
        if (r !== null)
          return r;
      }
    }
  }
  return null;
}

function resolvePackageExports(pkg, subpath, kind) {
  const ex = pkg.exports;
  if (ex === undefined || ex === null)
    return null;
  const key = subpath ? "./" + subpath.replace(/^\.\//, "") : ".";
  if (typeof ex === "string" || Array.isArray(ex)) {
    return key === "." ? resolveConditional(ex, kind) : null;
  }
  if (typeof ex !== "object")
    return null;
  const keys = Object.keys(ex);
  const subpathMap = keys.some((k) => k.startsWith("."));
  if (!subpathMap)
    return key === "." ? resolveConditional(ex, kind) : null;
  if (Object.prototype.hasOwnProperty.call(ex, key))
    return resolveConditional(ex[key], kind);
  for (const pattern of keys) {
    const star = pattern.indexOf("*");
    if (star < 0)
      continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) &&
        key.length >= prefix.length + suffix.length) {
      const matched = key.slice(prefix.length, key.length - suffix.length);
      const target = resolveConditional(ex[pattern], kind);
      if (target !== null)
        return target.replace(/\*/g, matched);
    }
  }
  return undefined;
}

function resolvePackageImports(pkg, spec, kind) {
  const map = pkg.imports;
  if (!map || typeof map !== "object")
    return undefined;
  if (Object.prototype.hasOwnProperty.call(map, spec))
    return resolveConditional(map[spec], kind);
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf("*");
    if (star < 0)
      continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.startsWith(prefix) && spec.endsWith(suffix) &&
        spec.length >= prefix.length + suffix.length) {
      const matched = spec.slice(prefix.length, spec.length - suffix.length);
      const target = resolveConditional(map[pattern], kind);
      if (target !== null)
        return target.replace(/\*/g, matched);
    }
  }
  return undefined;
}

function resolveFile(p) {
  if (isFile(p))
    return realpathSafe(p);
  for (const ext of [".js", ".json", ".mjs", ".cjs"]) {
    if (isFile(p + ext))
      return realpathSafe(p + ext);
  }
  return null;
}

function realpathSafe(p) {
  try { return realpathSync(p); } catch (e) { return p; }
}

function resolveFileOrDir(p, kind) {
  const file = resolveFile(p);
  if (file)
    return file;
  if (!isDir(p))
    return null;
  const pkg = readPackage(p);
  if (pkg) {
    const ex = resolvePackageExports(pkg, "", kind);
    if (ex) {
      const r = resolveFileOrDir(pathJoin(p, ex), kind);
      if (r)
        return r;
    }
    if (pkg.main) {
      const r = resolveFileOrDir(pathJoin(p, pkg.main), kind);
      if (r)
        return r;
    }
  }
  for (const index of ["index.js", "index.json", "index.mjs", "index.cjs"]) {
    const q = pathJoin(p, index);
    if (isFile(q))
      return realpathSafe(q);
  }
  return null;
}

function splitPackageSpecifier(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    const name = parts.slice(0, 2).join("/");
    return { name, subpath: parts.slice(2).join("/") };
  }
  const slash = spec.indexOf("/");
  if (slash < 0)
    return { name: spec, subpath: "" };
  return { name: spec.slice(0, slash), subpath: spec.slice(slash + 1) };
}

function moduleNotFound(request, base) {
  const e = new Error("Cannot find module '" + request + "'" +
    (base ? "\nRequire stack:\n- " + base : ""));
  e.code = "MODULE_NOT_FOUND";
  return e;
}

function findInNodeModules(request, baseDir, kind) {
  const { name, subpath } = splitPackageSpecifier(request);
  let dir = baseDir;
  for (;;) {
    const pkgDir = pathJoin(dir, "node_modules", name);
    if (isDir(pkgDir)) {
      const pkg = readPackage(pkgDir);
      if (pkg && pkg.exports !== undefined) {
        const target = resolvePackageExports(pkg, subpath, kind);
        if (target === undefined) {
          const e = new Error("Package subpath '" + (subpath || ".") +
            "' is not defined by \"exports\" in " + pkgDir +
            "/package.json");
          e.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
          throw e;
        }
        if (target !== null) {
          const r = resolveFileOrDir(pathJoin(pkgDir, target), kind);
          if (r)
            return r;
        }
      } else {
        const target = subpath ? pathJoin(pkgDir, subpath) : pkgDir;
        const r = resolveFileOrDir(target, kind);
        if (r)
          return r;
      }
    }
    const parent = pathDirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  for (const p of String(process.env.NODE_PATH || "").split(":")) {
    if (!p)
      continue;
    const r = resolveFileOrDir(pathJoin(p, request), kind);
    if (r)
      return r;
  }
  throw moduleNotFound(request, baseDir);
}

function baseDirectory(base) {
  if (!base)
    return process.cwd();
  if (base.startsWith("qnode:") || base.startsWith("qjs:") ||
      base.startsWith("node:"))
    return process.cwd();
  if (isDir(base))
    return base;
  return pathDirname(pathResolve(base));
}

/* Resolve a specifier the way Node does. `kind` is "require" or "import". */
function resolveRequest(request, base, kind) {
  kind = kind || "require";
  request = String(request);
  if (request.startsWith("qnode:"))
    return request;
  if (request.startsWith("qjs:"))
    return request;
  if (request.startsWith("node:"))
    return "qnode:" + request.slice(5);
  if (isBuiltin(request))
    return "qnode:" + stripNodePrefix(request);

  const baseDir = baseDirectory(base);
  if (request.startsWith("#")) {
    const pkg = findPackage(baseDir);
    const target = pkg ? resolvePackageImports(pkg, request, kind) : undefined;
    if (target === undefined) {
      const e = new Error("Package import specifier \"" + request +
        "\" is not defined" + (pkg ? " in " + pkg.__dir : ""));
      e.code = "ERR_PACKAGE_IMPORT_NOT_DEFINED";
      throw e;
    }
    if (target === null)
      throw moduleNotFound(request, base);
    if (target.startsWith("./")) {
      const r = resolveFileOrDir(pathJoin(pkg.__dir, target), kind);
      if (r)
        return r;
      throw moduleNotFound(request, base);
    }
    return resolveRequest(target, pathJoin(pkg.__dir, "index.js"), kind);
  }
  if (request.startsWith("./") || request.startsWith("../") ||
      request === "." || request === ".." || request.startsWith("/")) {
    const target = request.startsWith("/") ? request
      : pathJoin(baseDir, request);
    const r = resolveFileOrDir(target, kind);
    if (r)
      return r;
    throw moduleNotFound(request, base);
  }
  return findInNodeModules(request, baseDir, kind);
}

/* ------------------------------------------------------------------ */
/* CommonJS loader                                                    */
/* ------------------------------------------------------------------ */

function makeRequire(parentFilename) {
  const require = function require(spec) {
    const resolved = resolveRequest(spec, parentFilename, "require");
    if (resolved.startsWith("qnode:") || resolved.startsWith("qjs:")) {
      if (resolved.startsWith("qjs:"))
        return qjsBuiltin(resolved.slice(4));
      const name = resolved.slice(6);
      const b = builtins[name];
      if (!b)
        throw moduleNotFound(spec, parentFilename);
      return b;
    }
    return loadCJS(resolved, parentFilename);
  };
  require.resolve = function(spec) {
    return resolveRequest(spec, parentFilename, "require");
  };
  require.resolve.paths = function() {
    const out = [];
    let dir = baseDirectory(parentFilename);
    for (;;) {
      out.push(pathJoin(dir, "node_modules"));
      const parent = pathDirname(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
    return out;
  };
  require.cache = cjsCache;
  require.main = mainModule;
  return require;
}

function qjsBuiltin(name) {
  if (name === "std") return qjsstd;
  if (name === "os") return qjsos;
  return null;
}

function loadCJSFile(filename, parent) {
  if (cjsCache[filename])
    return cjsCache[filename].exports;

  const kind = moduleKind(filename);
  if (kind === "esm") {
    /* require() of an ES module: evaluate synchronously when possible. */
    const ns = native.requireEsm(filename);
    return ns;
  }
  if (kind === "json") {
    const mod = new Module(filename, asModule(parent));
    cjsCache[filename] = mod;
    try {
      mod.exports = JSON.parse(readFileSync(filename, "utf8")
        .replace(/^\uFEFF/, ""));
    } catch (e) {
      delete cjsCache[filename];
      throw e;
    }
    mod.loaded = true;
    return mod.exports;
  }
  if (kind === "native")
    throw new Error("Native addons are not supported: " + filename);

  let source = readFileSync(filename, "utf8");
  if (source.charCodeAt(0) === 0xfeff)
    source = source.slice(1);
  if (source.startsWith("#!"))
    source = "//" + source.slice(2);
  loadCJSSource(filename, source, parent);
  return cjsCache[filename].exports;
}

function loadCJSSource(filename, source, parent) {
  const mod = new Module(filename, asModule(parent));
  cjsCache[filename] = mod;
  const dirname = pathDirname(filename);
  const req = makeRequire(filename);
  try {
    const fn = new Function("exports", "require", "module", "__filename",
                            "__dirname", source + "\n//# sourceURL=" + filename);
    fn.call(mod.exports, mod.exports, req, mod, filename, dirname);
    mod.loaded = true;
  } catch (e) {
    delete cjsCache[filename];
    throw e;
  }
  return mod;
}

function asModule(parent) {
  if (!parent)
    return null;
  if (typeof parent === "string")
    return cjsCache[parent] || null;
  return Array.isArray(parent.children) ? parent : null;
}

class Module {
  constructor(id, parent) {
    this.id = id || ".";
    this.filename = id || null;
    this.path = id ? pathDirname(id) : process.cwd();
    this.exports = {};
    this.parent = asModule(parent);
    this.children = [];
    this.paths = [];
    this.loaded = false;
    if (this.parent)
      this.parent.children.push(this);
  }
  require(spec) {
    return makeRequire(this.filename)(spec);
  }
  load(id) {
    return loadCJSFile(id, this);
  }
  static createRequire(filename) {
    if (filename instanceof URL)
      filename = fileURLToPath(filename);
    return makeRequire(pathResolve(String(filename)));
  }
  static isBuiltin(name) {
    return isBuiltin(String(name));
  }
  static _resolveFilename(request, parent) {
    return resolveRequest(request, parent && parent.filename, "require");
  }
  static _load(request, parent, isMain) {
    return loadCJSFile(resolveRequest(request, parent && parent.filename,
                                     "require"), parent);
  }
  static _cache = cjsCache;
  static builtinModules = [
    "assert", "buffer", "child_process", "console", "constants", "crypto",
    "dgram", "dns", "events", "fs", "http", "https", "module", "net", "os",
    "path", "process", "punycode", "querystring", "readline", "stream",
    "string_decoder", "timers", "tls", "tty", "url", "util", "vm",
    "worker_threads", "zlib",
  ];
  static wrap(source) {
    return "(function (exports, require, module, __filename, __dirname) {" +
      source + "\n})";
  }
}

function loadCJS(filename, parent) {
  return loadCJSFile(filename, parent);
}

