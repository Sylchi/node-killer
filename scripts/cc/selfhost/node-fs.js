/**
 * Minimal `fs` module for the self-hosted C compiler.
 * Backed by native helpers installed by the C host as `__cc_native`.
 *
 * @module cc/selfhost/node-fs
 */

const native = globalThis.__cc_native;

function readFileSync(file, encoding) {
  const ab = native.readFile(String(file));
  if (ab === null) {
    const err = new Error(`ENOENT: no such file or directory, open '${file}'`);
    err.code = 'ENOENT';
    throw err;
  }
  const buf = Buffer.from(ab);
  if (typeof encoding === 'string') return buf.toString(encoding);
  return buf;
}

function writeFileSync(file, data) {
  if (!native.writeFile(String(file), data)) {
    throw new Error(`EACCES: permission denied, open '${file}'`);
  }
}

function existsSync(file) {
  return native.exists(String(file));
}

function statSync(file) {
  const st = native.stat(String(file));
  if (!st) {
    const err = new Error(`ENOENT: no such file or directory, stat '${file}'`);
    err.code = 'ENOENT';
    throw err;
  }
  return {
    mode: st.mode,
    size: st.size,
    isFile: () => st.isFile,
    isDirectory: () => st.isDirectory,
    isSymbolicLink: () => st.isSymbolicLink,
  };
}

function readdirSync(dir) {
  const list = native.readdir(String(dir));
  if (list === null) {
    throw new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
  }
  return list;
}

function mkdirSync(dir, options) {
  const recursive = !!(options && options.recursive);
  if (!native.mkdir(String(dir), recursive)) {
    throw new Error(`EEXIST: file already exists, mkdir '${dir}'`);
  }
}

function chmodSync(file, mode) {
  if (!native.chmod(String(file), mode)) {
    throw new Error(`EPERM: operation not permitted, chmod '${file}'`);
  }
}

export { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, chmodSync };
export default {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  chmodSync,
};
