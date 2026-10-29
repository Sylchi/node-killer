/* ------------------------------------------------------------------ */
/* npm installer                                                      */
/* ------------------------------------------------------------------ */

const NPM_REGISTRY = (process.env.npm_config_registry ||
  process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org")
  .replace(/\/+$/, "");

function npmParseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(String(v).trim());
  if (!m)
    return null;
  return {
    major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || "",
    raw: String(v).trim(),
  };
}

function npmCompareVersion(a, b) {
  if (typeof a === "string") a = npmParseVersion(a);
  if (typeof b === "string") b = npmParseVersion(b);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k])
      return a[k] < b[k] ? -1 : 1;
  }
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre === b.pre) return 0;
  const ap = a.pre.split("."), bp = b.pre.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]) ? +ap[i] : ap[i];
    const bn = /^\d+$/.test(bp[i]) ? +bp[i] : bp[i];
    if (typeof an === "number" && typeof bn === "number") {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (String(an) !== String(bn)) {
      return String(an) < String(bn) ? -1 : 1;
    }
  }
  return 0;
}

function npmNextAfter(parts) {
  /* smallest version greater than the prefix described by parts */
  const major = parts[0];
  const minor = parts[1] === null ? 0 : parts[1];
  const patch = parts[2] === null ? 0 : parts[2];
  if (parts[2] === null)
    return { major, minor: minor + 1, patch: 0, pre: "", raw: "" };
  return { major, minor, patch: patch + 1, pre: "", raw: "" };
}

function npmParseRangeAtom(token) {
  token = token.trim();
  if (!token || token === "*" || token === "x" || token === "X" ||
      token === "latest")
    return null;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(token);
  if (!m)
    return null;
  const wild = (x) => x === undefined || x === "x" || x === "X" || x === "*";
  if (wild(m[2]))
    return null;
  return {
    op: m[1] || "=",
    parts: [Number(m[2]), wild(m[3]) ? null : Number(m[3]),
            wild(m[4]) ? null : Number(m[4])],
    pre: m[5] || "",
  };
}

function npmAtomMatches(vs, atom) {
  const { op, parts, pre } = atom;
  const target = {
    major: parts[0],
    minor: parts[1] === null ? 0 : parts[1],
    patch: parts[2] === null ? 0 : parts[2],
    pre,
  };
  if (op === "=") {
    if (parts[1] === null)
      return vs.major === parts[0];
    if (parts[2] === null)
      return vs.major === parts[0] && vs.minor === parts[1];
    return npmCompareVersion(vs, target) === 0;
  }
  if (op === ">") {
    if (parts[2] === null)
      return npmCompareVersion(vs, target) > 0;
    return npmCompareVersion(vs, target) > 0;
  }
  if (op === ">=")
    return npmCompareVersion(vs, target) >= 0;
  if (op === "<")
    return npmCompareVersion(vs, target) < 0;
  if (op === "<=") {
    if (parts[2] === null && parts[1] !== null) {
      const next = npmNextAfter(parts);
      return npmCompareVersion(vs, next) < 0;
    }
    return npmCompareVersion(vs, target) <= 0;
  }
  if (op === "~") {
    if (npmCompareVersion(vs, target) < 0)
      return false;
    if (parts[1] === null)
      return vs.major === parts[0];
    return vs.major === parts[0] && vs.minor === parts[1];
  }
  /* caret */
  if (npmCompareVersion(vs, target) < 0)
    return false;
  if (parts[0] > 0)
    return vs.major === parts[0];
  if (parts[1] === null)
    return vs.major === 0;
  if (parts[1] > 0)
    return vs.major === 0 && vs.minor === parts[1];
  if (parts[2] === null)
    return vs.major === 0 && vs.minor === 0;
  return vs.major === 0 && vs.minor === 0 && vs.patch === parts[2];
}

function npmRangeAtoms(range) {
  const atoms = [];
  let text = String(range).trim();
  /* hyphen ranges: "1.2.3 - 2.3.4" */
  const hy = /^([0-9xX*.]+)\s+-\s+([0-9xX*.]+)$/.exec(text);
  if (hy) {
    const lo = npmParseRangeAtom(hy[1]);
    const hi = npmParseRangeAtom(hy[2]);
    if (lo)
      atoms.push({ op: ">=", parts: lo.parts, pre: lo.pre });
    if (hi) {
      if (hi.parts[1] === null)
        atoms.push({ op: "<", parts: [hi.parts[0] + 1, null, null], pre: "" });
      else if (hi.parts[2] === null)
        atoms.push({ op: "<", parts: [hi.parts[0], hi.parts[1] + 1, null],
                     pre: "" });
      else
        atoms.push({ op: "<=", parts: hi.parts, pre: hi.pre });
    }
    return atoms;
  }
  /* allow whitespace between an operator and its version */
  text = text.replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1");
  for (const token of text.split(/\s+/)) {
    if (!token)
      continue;
    const atom = npmParseRangeAtom(token);
    if (atom)
      atoms.push(atom);
    else
      return null;
  }
  return atoms;
}

function npmIsAnyRange(range) {
  const text = String(range === undefined || range === null ? "" : range)
    .trim();
  return text === "" || text === "*" || text === "x" || text === "X" ||
    text === "latest";
}

function npmSatisfies(version, range) {
  if (npmIsAnyRange(range))
    return true;
  const v = typeof version === "string" ? npmParseVersion(version) : version;
  if (!v)
    return false;
  for (const alt of String(range).split("||")) {
    if (npmIsAnyRange(alt))
      return true;
    const atoms = npmRangeAtoms(alt);
    if (atoms === null)
      continue;
    if (atoms.every((a) => npmAtomMatches(v, a)))
      return true;
  }
  return false;
}

const npmPackuments = new Map();
/* Network concurrency; override with NPM_NET_LIMIT for tuning. */
const NPM_NET_LIMIT = Math.max(1, Number(process.env.NPM_NET_LIMIT) || 8);

/* Set QNODE_NPM_PROFILE=1 to print a network/install breakdown. */
const NPM_PROFILE = !!process.env.QNODE_NPM_PROFILE;
const npmProfile = { packs: 0, packMs: 0, tarballs: 0, tarMs: 0,
                     bytes: 0, extractMs: 0, attempts: 0, waitMs: 0,
                     netMs: 0, netMax: 0, netCount: 0 };

/* Wrap a network task with queue-wait and service-time accounting. */
function npmProfileFetch(ctx, fn) {
  if (!NPM_PROFILE)
    return npmLimit(ctx, fn);
  const queued = Date.now();
  return npmLimit(ctx, () => {
    const started = Date.now();
    npmProfile.waitMs += started - queued;
    npmProfile.attempts++;
    const p = Promise.resolve().then(fn);
    const done = () => {
      const dt = Date.now() - started;
      npmProfile.netMs += dt;
      npmProfile.netCount++;
      if (dt > npmProfile.netMax)
        npmProfile.netMax = dt;
    };
    p.then(done, done);
    return p;
  });
}

function npmLimit(ctx, fn) {
  const run = () => {
    if (ctx.active < NPM_NET_LIMIT)
      return fn();
    return ctx.queue.push(fn).then((f) => f());
  };
  return new Promise((resolve, reject) => {
    const task = () => {
      ctx.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          ctx.active--;
          const next = ctx.queue.shift();
          if (next)
            next();
        });
    };
    if (ctx.active < NPM_NET_LIMIT)
      task();
    else
      ctx.queue.push(task);
  });
}

async function npmFetchPackument(ctx, name) {
  let cached = npmPackuments.get(name);
  if (cached)
    return cached;
  const p = (async () => {
    const url = NPM_REGISTRY + "/" + name.replace("/", "%2f");
    const started = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await npmProfileFetch(ctx, () => fetch(url, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
        }));
        if (res.status === 404) {
          const e = new Error("404 Not Found - " + name);
          e.code = "E404";
          throw e;
        }
        if (!res.ok)
          throw new Error("failed to fetch " + name + ": HTTP " + res.status);
        const doc = await res.json();
        npmProfile.packs++;
        npmProfile.packMs += Date.now() - started;
        return doc;
      } catch (e) {
        lastErr = e;
        if (e && e.code === "E404")
          throw e;
      }
    }
    throw lastErr;
  })();
  npmPackuments.set(name, p);
  p.catch(() => npmPackuments.delete(name));
  return p;
}

function npmLatestVersion(doc, range) {
  const versions = Object.keys(doc.versions || {});
  let best = null;
  for (const v of versions) {
    if (v === "0.0.0" || v.indexOf("npm:") >= 0)
      continue;
    if (!npmSatisfies(v, range))
      continue;
    if (!best || npmCompareVersion(v, best) > 0)
      best = v;
  }
  if (!best && (range === "*" || range === "" || range === "latest")) {
    for (const v of versions)
      if (!best || npmCompareVersion(v, best) > 0)
        best = v;
  }
  return best;
}

function npmTarField(header, off, len) {
  let end = off;
  const stop = off + len;
  while (end < stop && header[end] !== 0)
    end++;
  return header.toString("utf8", off, end);
}

function npmExtractTarball(buf, dest) {
  let tar = buf;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)
    tar = zlib.gunzipSync(buf);
  npmPkgCache.delete(dest);
  fsSync.mkdirSync(dest, { recursive: true });
  const destBase = pathResolve(dest);
  const destPrefix = destBase + "/";
  const madeDirs = new Set([destBase]);
  /* One mkdir per directory instead of one per extracted file. */
  const ensureDir = (dir) => {
    if (madeDirs.has(dir))
      return;
    fsSync.mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  };
  let off = 0;
  let override = null;
  let count = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let empty = true;
    for (let i = 0; i < 512; i++)
      if (header[i]) { empty = false; break; }
    if (empty)
      break;
    let name = npmTarField(header, 0, 100);
    const prefix = npmTarField(header, 345, 155);
    const modeStr = npmTarField(header, 100, 8);
    const sizeStr = npmTarField(header, 124, 12);
    const type = header[156] ? String.fromCharCode(header[156]) : "0";
    const size = parseInt(sizeStr.trim() || "0", 8) || 0;
    const mode = parseInt(modeStr.trim() || "644", 8) || 0o644;
    const dataOff = off + 512;
    off = dataOff + Math.ceil(size / 512) * 512;
    if (prefix)
      name = prefix + "/" + name;
    if (type === "L" || type === "x") {
      const text = tar.toString("utf8", dataOff, dataOff + size);
      if (type === "L") {
        override = text.replace(/\0+$/, "");
      } else {
        /* pax extended header: "len key=value\n" records */
        let pos = 0;
        while (pos < text.length) {
          const sp = text.indexOf(" ", pos);
          if (sp < 0)
            break;
          const len = parseInt(text.slice(pos, sp), 10);
          if (!len || len <= 0)
            break;
          const rec = text.slice(sp + 1, pos + len - 1);
          const eq = rec.indexOf("=");
          if (eq > 0 && rec.slice(0, eq) === "path")
            override = rec.slice(eq + 1);
          pos += len;
        }
      }
      continue;
    }
    if (type === "g" || type === "K")
      continue;
    if (override) {
      name = override;
      override = null;
    }
    let rel = name.replace(/\\/g, "/").replace(/^\.?\//, "");
    const slash = rel.indexOf("/");
    if (slash >= 0)
      rel = rel.slice(slash + 1);
    if (!rel)
      continue;
    const out = pathJoin(dest, rel);
    const outResolved = pathResolve(out);
    if (outResolved !== destBase && !outResolved.startsWith(destPrefix))
      continue;
    if (type === "5") {
      ensureDir(outResolved);
      continue;
    }
    if (type === "2") {
      const link = npmTarField(header, 157, 100);
      ensureDir(pathResolve(pathDirname(out)));
      try { fsSync.unlinkSync(out); } catch (e) { /* ignore */ }
      try { fsSync.symlinkSync(link, out); } catch (e) { /* ignore */ }
      continue;
    }
    if (type !== "0" && type !== "\0")
      continue;
    ensureDir(pathResolve(pathDirname(out)));
    fsSync.writeFileSync(out, tar.subarray(dataOff, dataOff + size));
    /* 0644 is what writeFileSync already produces; only chmod the rest. */
    const perm = mode & 0o777;
    if (perm !== 0o644) {
      try { fsSync.chmodSync(out, perm); } catch (e) { /* ignore */ }
    }
    count++;
  }
  return count;
}

function npmIntegrityCheck(buf, dist) {
  const integrity = dist && dist.integrity;
  if (!integrity)
    return;
  for (const item of String(integrity).split(/\s+/)) {
    const dash = item.indexOf("-");
    if (dash < 0)
      continue;
    const alg = item.slice(0, dash);
    const expected = item.slice(dash + 1);
    let actual;
    try {
      actual = createHash(alg).update(buf).digest("base64");
    } catch (e) {
      continue;
    }
    if (actual !== expected)
      throw new Error("integrity checksum failed (wanted " + expected +
                      " got " + actual + ")");
    return;
  }
}

function npmParseSpec(spec) {
  spec = String(spec);
  let at = spec.lastIndexOf("@");
  if (at > 0)
    return { name: spec.slice(0, at), range: spec.slice(at + 1) || "*" };
  return { name: spec, range: "*" };
}

function npmPackageDir(root, name) {
  return pathJoin(root, "node_modules", ...name.split("/"));
}

/* Memoised: dependency resolution probes node_modules for every ancestor of
   every dependency edge, which used to cost tens of thousands of stat/open
   calls per install. Entries are dropped when a package directory is
   (re)written. */
const npmPkgCache = new Map();

function npmReadPackageJson(dir) {
  const cached = npmPkgCache.get(dir);
  if (cached !== undefined)
    return cached;
  let pkg = null;
  try {
    pkg = JSON.parse(fsSync.readFileSync(pathJoin(dir, "package.json"), "utf8"));
  } catch (e) {
    pkg = null;
  }
  npmPkgCache.set(dir, pkg);
  return pkg;
}

function npmFindExisting(fromDir, projectRoot, name, range) {
  let dir = fromDir;
  for (;;) {
    const candidate = npmPackageDir(dir, name);
    const pkg = npmReadPackageJson(candidate);
    if (pkg && pkg.version && npmSatisfies(pkg.version, range))
      return { dir: candidate, pkg };
    if (dir === projectRoot)
      break;
    const parent = pathDirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}

async function npmWithLock(ctx, key, fn) {
  const prev = ctx.locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  ctx.locks.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function npmDownloadTarball(ctx, url) {
  let cached = ctx.tarballs.get(url);
  if (cached)
    return cached;
  const p = (async () => {
    const started = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await npmProfileFetch(ctx, () => fetch(url, { acceptEncoding: true }));
        if (!res.ok)
          throw new Error("HTTP " + res.status + " for " + url);
        const arr = await res.arrayBuffer();
        const buf = Buffer.from(arr);
        npmProfile.tarballs++;
        npmProfile.tarMs += Date.now() - started;
        npmProfile.bytes += buf.length;
        return buf;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  })();
  ctx.tarballs.set(url, p);
  p.catch(() => ctx.tarballs.delete(url));
  return p;
}

async function npmProcessDeps(projectRoot, dir, ctx, chain) {
  if (ctx.done.has(dir))
    return;
  if (ctx.processing.has(dir))
    return ctx.processing.get(dir);
  const pkg = npmReadPackageJson(dir);
  if (!pkg) {
    ctx.done.add(dir);
    return;
  }
  const promise = (async () => {
    await npmInstallDeps(projectRoot, dir, pkg, ctx, chain);
  })();
  ctx.processing.set(dir, promise);
  try {
    await promise;
    ctx.done.add(dir);
  } finally {
    ctx.processing.delete(dir);
  }
}

async function npmInstallOne(projectRoot, fromDir, name, range, ctx, chain) {
  /* npm aliases: "dep": "npm:real-name@^1.2.3" installs real-name into the
     directory for dep. */
  let sourceName = name;
  if (typeof range === "string" && range.lastIndexOf("npm:", 0) === 0) {
    const spec = range.slice(4);
    const at = spec.lastIndexOf("@");
    if (at > 0) {
      sourceName = spec.slice(0, at);
      range = spec.slice(at + 1);
    } else {
      sourceName = spec;
      range = "*";
    }
  }
  const existing = npmFindExisting(fromDir, projectRoot, name, range);
  if (existing) {
    if (chain.has(existing.dir))
      return { name, version: existing.pkg.version, installed: false };
    if (!ctx.done.has(existing.dir)) {
      const nextChain = new Set(chain);
      nextChain.add(existing.dir);
      await npmProcessDeps(projectRoot, existing.dir, ctx, nextChain);
    }
    return { name, version: existing.pkg.version, installed: false };
  }

  const doc = await npmFetchPackument(ctx, sourceName);
  const version = npmLatestVersion(doc, range);
  if (!version)
    throw new Error("No matching version found for " + sourceName + "@" + range);
  const info = (doc.versions || {})[version];
  if (!info || !info.dist || !info.dist.tarball)
    throw new Error("No tarball for " + name + "@" + version);

  const rootTarget = npmPackageDir(projectRoot, name);
  const rootPkg = npmReadPackageJson(rootTarget);

  /* Install a package into `target` unless a compatible copy is already
     there. When `replace` is false an existing incompatible copy is left
     alone and the caller nests the package instead. */
  const place = (target, replace) => npmWithLock(ctx, target, async () => {
    const now = npmReadPackageJson(target);
    if (now && npmSatisfies(now.version, range))
      return false;
    if (now && !replace)
      return null;
    const tgz = await npmDownloadTarball(ctx, info.dist.tarball);
    npmIntegrityCheck(tgz, info.dist);
    fsSync.rmSync(target, { recursive: true, force: true });
    const extractStarted = Date.now();
    npmExtractTarball(tgz, target);
    npmProfile.extractMs += Date.now() - extractStarted;
    ctx.added++;
    process.stderr.write("qnode install: " + name + "@" + version + "\n");
    return true;
  });

  let target = (fromDir === projectRoot || !rootPkg) ? rootTarget
    : npmPackageDir(fromDir, name);
  if (chain.has(target))
    return { name, version, installed: false };

  let placed = await place(target, fromDir === projectRoot);
  if (placed === null) {
    /* A concurrent install populated the hoisted slot with a different
       version: keep ours next to the package that asked for it. */
    target = npmPackageDir(fromDir, name);
    if (chain.has(target))
      return { name, version, installed: false };
    placed = await place(target, true);
  }

  const nextChain = new Set(chain);
  nextChain.add(target);
  await npmProcessDeps(projectRoot, target, ctx, nextChain);
  return { name, version, installed: placed !== false };
}

async function npmInstallDeps(projectRoot, dir, pkg, ctx, chain) {
  const deps = Object.assign({}, pkg.dependencies || {},
                             pkg.optionalDependencies || {});
  const optional = pkg.optionalDependencies || {};
  const tasks = Object.keys(deps).map((dep) => (async () => {
    try {
      await npmInstallOne(projectRoot, dir, dep, deps[dep], ctx, chain);
    } catch (e) {
      if (dep in optional)
        return;
      throw e;
    }
  })());
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === "rejected");
  if (failed)
    throw failed.reason;
}

async function npmInstall(args) {
  const started = Date.now();
  const cwd = process.cwd();
  const pkgPath = pathJoin(cwd, "package.json");
  let pkg = npmReadPackageJson(cwd);
  if (!pkg) {
    if (!args.length)
      throw new Error("no package.json found in " + cwd);
    pkg = { name: pathBasename(cwd), version: "1.0.0" };
  }
  const specs = [];
  if (args.length) {
    for (const a of args) {
      if (a.startsWith("-"))
        continue;
      specs.push(npmParseSpec(a));
    }
  } else {
    for (const k of Object.keys(pkg.dependencies || {}))
      specs.push({ name: k, range: pkg.dependencies[k] });
    for (const k of Object.keys(pkg.devDependencies || {}))
      specs.push({ name: k, range: pkg.devDependencies[k] });
    for (const k of Object.keys(pkg.optionalDependencies || {}))
      specs.push({ name: k, range: pkg.optionalDependencies[k] });
  }
  if (!specs.length) {
    process.stderr.write("qnode install: nothing to install\n");
    return 0;
  }

  const ctx = {
    added: 0, seen: new Set(), done: new Set(), processing: new Map(),
    locks: new Map(), tarballs: new Map(), active: 0, queue: [],
  };
  const resolved = [];
  const chain = new Set();
  await Promise.all(specs.map(async (spec) => {
    const r = await npmInstallOne(cwd, cwd, spec.name, spec.range, ctx, chain);
    resolved.push({ name: spec.name, range: spec.range, version: r.version });
  }));

  if (args.length) {
    pkg.dependencies = pkg.dependencies || {};
    for (const r of resolved)
      pkg.dependencies[r.name] = "^" + r.version;
    fsSync.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    npmPkgCache.delete(cwd);
  }

  if (NPM_PROFILE) {
    process.stderr.write("qnode profile: packs=" + npmProfile.packs +
      " pack=" + npmProfile.packMs + "ms tarballs=" + npmProfile.tarballs +
      " tar=" + npmProfile.tarMs + "ms bytes=" + npmProfile.bytes +
      " extract=" + npmProfile.extractMs + "ms netlimit=" + NPM_NET_LIMIT +
      " attempts=" + npmProfile.attempts + " wait=" + npmProfile.waitMs +
      "ms service=" + npmProfile.netMs + "ms avg=" +
      (npmProfile.netCount ? (npmProfile.netMs / npmProfile.netCount).toFixed(1) : 0) +
      "ms max=" + npmProfile.netMax + "ms\n");
  }

  const secs = ((Date.now() - started) / 1000).toFixed(2);
  process.stderr.write("added " + ctx.added + " package" +
                       (ctx.added === 1 ? "" : "s") + " in " + secs + "s\n");
  return 0;
}

globalThis.__qnode_npm_install = npmInstall;

