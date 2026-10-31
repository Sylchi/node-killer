/**
 * Minimal POSIX `path` module for the self-hosted C compiler.
 * Only the subset used by scripts/cc is implemented.
 *
 * @module cc/selfhost/node-path
 */

function cwd() {
  return globalThis.__cc_native.cwd();
}

function normalize(input) {
  const abs = input.startsWith('/');
  const out = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else {
      out.push(part);
    }
  }
  const body = out.join('/');
  if (abs) return '/' + body;
  return body || '.';
}

function join(...parts) {
  const list = parts.map(String).filter((part) => part.length > 0);
  if (list.length === 0) return '.';
  return normalize(list.join('/'));
}

function resolve(...parts) {
  let resolved = '';
  for (let i = parts.length - 1; i >= -1; i -= 1) {
    const part = i >= 0 ? String(parts[i]) : cwd();
    if (!part) continue;
    resolved = resolved ? part + '/' + resolved : part;
    if (part.startsWith('/')) break;
  }
  return normalize(resolved);
}

function dirname(input) {
  const p = String(input);
  let end = -1;
  for (let i = p.length - 1; i >= 0; i -= 1) {
    if (p[i] === '/') {
      end = i;
      break;
    }
  }
  if (end < 0) return '.';
  if (end === 0) return '/';
  const out = p.slice(0, end).replace(/\/+$/, '');
  return out || '/';
}

function basename(input, ext) {
  let p = String(input);
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const idx = p.lastIndexOf('/');
  let name = idx < 0 ? p : p.slice(idx + 1);
  if (ext && name !== ext && name.endsWith(ext)) {
    name = name.slice(0, -ext.length);
  }
  return name;
}

function extname(input) {
  const name = basename(input);
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx);
}

function isAbsolute(input) {
  return String(input).startsWith('/');
}

export { join, resolve, dirname, basename, extname, isAbsolute, normalize };
export const sep = '/';
export default { join, resolve, dirname, basename, extname, isAbsolute, normalize, sep };
