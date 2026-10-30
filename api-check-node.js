// Check Node.js built-in modules and other APIs

console.log("=== Node.js Built-in Modules Check ===\n");

const builtinModules = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
];

console.log("Checking require() for built-in modules...");
const have = [];
const missing = [];

for (const mod of builtinModules) {
  try {
    require(mod);
    have.push(mod);
  } catch (e) {
    missing.push(mod);
  }
}

console.log("✅ Have (" + have.length + "): " + have.join(', '));
console.log("\n❌ Missing (" + missing.length + "): " + (missing.length ? missing.join(', ') : 'none'));

// Check for other common APIs
console.log("\n=== Other Common APIs ===\n");

const otherApis = {
  'util.types': () => require('util').types,
  'util.promisify': () => typeof require('util').promisify === 'function',
  'util.callbackify': () => typeof require('util').callbackify === 'function',
  'util.inspect': () => typeof require('util').inspect === 'function',
  'stream.promises.pipeline': () => typeof require('stream/promises').pipeline === 'function',
  'stream.promises.finished': () => typeof require('stream/promises').finished === 'function',
  'stream.consumers': () => typeof require('stream/consumers') === 'object',
  'timers.promises.setTimeout': () => typeof require('timers/promises').setTimeout === 'function',
  'timers.promises.setInterval': () => typeof require('timers/promises').setInterval === 'function',
  'timers.promises.setImmediate': () => typeof require('timers/promises').setImmediate === 'function',
  'fs.promises': () => typeof require('fs').promises === 'object',
  'dns.promises': () => typeof require('dns').promises === 'object',
};

const otherHave = [];
const otherMissing = [];

for (const [name, check] of Object.entries(otherApis)) {
  try {
    if (check()) {
      otherHave.push(name);
    } else {
      otherMissing.push(name);
    }
  } catch (e) {
    otherMissing.push(name);
  }
}

console.log("✅ Have (" + otherHave.length + "): " + otherHave.join(', '));
console.log("\n❌ Missing (" + otherMissing.length + "): " + (otherMissing.length ? otherMissing.join(', ') : 'none'));

// Check for Web Crypto API completeness
console.log("\n=== Web Crypto API Check ===\n");

const cryptoChecks = {
  'crypto.getRandomValues': () => typeof crypto.getRandomValues === 'function',
  'crypto.randomUUID': () => typeof crypto.randomUUID === 'function',
  'crypto.subtle.digest': () => typeof crypto.subtle.digest === 'function',
  'crypto.subtle.encrypt': () => typeof crypto.subtle.encrypt === 'function',
  'crypto.subtle.decrypt': () => typeof crypto.subtle.decrypt === 'function',
  'crypto.subtle.sign': () => typeof crypto.subtle.sign === 'function',
  'crypto.subtle.verify': () => typeof crypto.subtle.verify === 'function',
  'crypto.subtle.generateKey': () => typeof crypto.subtle.generateKey === 'function',
  'crypto.subtle.deriveKey': () => typeof crypto.subtle.deriveKey === 'function',
  'crypto.subtle.deriveBits': () => typeof crypto.subtle.deriveBits === 'function',
  'crypto.subtle.importKey': () => typeof crypto.subtle.importKey === 'function',
  'crypto.subtle.exportKey': () => typeof crypto.subtle.exportKey === 'function',
  'crypto.subtle.wrapKey': () => typeof crypto.subtle.wrapKey === 'function',
  'crypto.subtle.unwrapKey': () => typeof crypto.subtle.unwrapKey === 'function',
};

const cryptoHave = [];
const cryptoMissing = [];

for (const [name, check] of Object.entries(cryptoChecks)) {
  try {
    if (check()) {
      cryptoHave.push(name);
    } else {
      cryptoMissing.push(name);
    }
  } catch (e) {
    cryptoMissing.push(name);
  }
}

console.log("✅ Have (" + cryptoHave.length + "): " + cryptoHave.join(', '));
console.log("\n❌ Missing (" + cryptoMissing.length + "): " + (cryptoMissing.length ? cryptoMissing.join(', ') : 'none'));
