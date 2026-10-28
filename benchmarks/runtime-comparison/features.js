'use strict';
// Feature probe. Prints one JSON object; run under each runtime and diff.
const out = { versions: { ...process.versions }, globals: {}, modules: {}, syntax: {} };

for (const g of [
  'fetch', 'WebSocket', 'EventSource', 'AbortController', 'structuredClone',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'ReadableStream',
  'WritableStream', 'TransformStream', 'BroadcastChannel', 'MessageChannel',
  'EventTarget', 'Event', 'navigator', 'atob', 'btoa', 'performance', 'crypto',
  'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'CompressionStream', 'DecompressionStream', 'WebAssembly', 'Intl', 'Temporal',
  'Iterator', 'DisposableStack', 'AsyncDisposableStack', 'Float16Array',
  'FinalizationRegistry', 'WeakRef',
]) out.globals[g] = typeof globalThis[g] !== 'undefined';

try { out.globals['crypto.subtle'] = typeof crypto.subtle.digest === 'function'; } catch (e) { out.globals['crypto.subtle'] = false; }
try { out.globals['crypto.randomUUID'] = typeof crypto.randomUUID === 'function'; } catch (e) { out.globals['crypto.randomUUID'] = false; }

for (const m of [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'test', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite', 'sea',
]) {
  let plain = false;
  let prefixed = false;
  try { require(m); plain = true; } catch (e) {}
  try { require('node:' + m); prefixed = true; } catch (e) {}
  out.modules[m] = plain ? 'both' : prefixed ? 'node:' : '-';
}

const syntax = {
  optionalChaining: 'a?.b',
  nullish: 'a ?? b',
  numericSeparators: '1_000_000',
  classFields: 'class A { x = 1; static y = 2 }',
  privateFields: 'class A { #x = 1; get() { return this.#x } }',
  logicalAssignment: 'a ||= 1',
  topLevelAwaitInFn: 'async function f(){ await 1 }',
  regexpV: '/(?:)/v',
  regexpD: '/(?:)/d',
  arrayFindLast: '[].findLast',
  objectGroupBy: 'Object.groupBy',
  promiseWithResolvers: 'Promise.withResolvers',
  arrayFromAsync: 'Array.fromAsync',
  setMethods: 'Set.prototype.union',
  iteratorHelpers: 'Iterator.prototype.map',
  changeArrayByCopy: 'Array.prototype.toSorted',
  usingDecl: 'using x = null',
  decorators: 'class A { @dec m() {} }',
};
for (const [k, src] of Object.entries(syntax)) {
  try { new Function(src); out.syntax[k] = true; } catch (e) { out.syntax[k] = false; }
}

console.log(JSON.stringify(out));
